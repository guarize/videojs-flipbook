import {
  type PropertyValues,
  PlayerController,
  playerContext,
  selectPlayback,
  selectTime,
  UIElement,
} from '@videojs/html';
import { I18nController, i18nContext } from '@videojs/html/i18n';
import { type Cue, findMedia, type Tile, tileAt, videoOf } from '@/shared/storyboard';
import { clock, hush, loadBook, reducedMotion } from './book';
import { frameUrls, sharpFrame, wanted } from './frames';
import { type FlipbookKey, say } from './i18n';

/** The cards: a ring of twelve. The deck draws eleven of them (five either side of the target), the grid all twelve. */
const POOL = 12;
const REACH = 5.5;
/** Fine scrubbing: distance above the bar (CSS px) sets how far a sideways move travels, as on iOS. */
export const LANES = [
  { from: 0, rate: 1, spacing: 1, key: '' },
  { from: 48, rate: 0.5, spacing: 0.8, key: 'flipbook.scrubHalf' },
  { from: 96, rate: 0.25, spacing: 0.66, key: 'flipbook.scrubQuarter' },
  { from: 144, rate: 0.1, spacing: 0.54, key: 'flipbook.scrubFine' },
] as const;
type LaneKey = Exclude<(typeof LANES)[number]['key'], ''> & FlipbookKey;
/** Seeks while dragging are throttled: the deck follows the pointer every frame, the picture catches up. */
const SEEK_EVERY = 60;
/** A drag faster than this (frames per second) lays the deck out flat as a grid; slower than OUT for HOLD folds it back. */
const GRID_IN = 22;
const GRID_OUT = 8;
const GRID_HOLD = 220;
/** Keyboard stepping shows the deck until this long after the last key. */
const KEYS_HOLD = 800;
/** The fold back into the picture, and the deck's change between fan and grid. */
const FOLD = 300;
/** The front card starts to give way to the sharp picture before it has quite landed, and is gone as it does. */
const LAND_AT = 170;
const LAND = 140;
const MORPH = 260;
/** The page turn: a critically damped spring, so a card settles at the front with no bounce. */
const OMEGA = 24;
/** Hover intent: the deck opens once the pointer rests or slows on the bar this long; a fast pass leaves it shut. */
const INTENT = 150;
const INTENT_FAST = 0.6;
/** A throw: let go faster than this (seconds of film per second) and the cards fly on, slowing with this time constant. */
const FLICK_MIN = 14;
const FLICK_DECAY = 0.32;
const FLICK_REST = 2.5;
/** Swiping the picture: film per pixel of horizontal swipe, and how long after the last move the deck lands. */
const SWIPE_PAGES_PER_PX = 1 / 34;
const SWIPE_IDLE = 220;
/** Cards this close to the front get their sharp frame; the rest keep the storyboard tile. */
const SHARP_REACH = 2.5;
/** Chapter detents: let go this close to a chapter's start (CSS px along the edge) and the ribbon settles on it. */
const DETENT = 9;
/** A throw slowing below this (film seconds per second) near a chapter is caught by its detent. */
const DETENT_CATCH = 14;

type Mode = 'idle' | 'hover' | 'drag' | 'keys' | 'fold' | 'swipe' | 'coast';
type Layout = 'deck' | 'grid' | 'strip';

const SEEK_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']);

export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const mod = (n: number, m: number) => ((n % m) + m) % m;
const smooth = (t: number) => t * t * (3 - 2 * t);

interface Card {
  root: HTMLElement;
  image: HTMLElement;
  sheen: HTMLElement;
  shade: HTMLElement;
  sharp: HTMLElement;
  tile: number;
  /** The page whose sharp frame this card has asked for. */
  asked: number;
}

/**
 * Flipbook's signature: time has depth. Point at the seek bar and the picture steps back while the storyboard fans
 * out in perspective around that moment: the frame front and centre, the past to the left, the future to the right.
 * Moving flips through it like a flipbook, a page turn as each card passes the front. A fast drag lays it out flat
 * as a grid, to spot a scene; moving up away from the bar slows the scrub. Letting go folds the deck back into the
 * picture, the front card landing exactly on the frame, and playback carries on from there.
 *
 * It is drawn for sighted pointer users and is hidden from assistive technology: the seek slider underneath keeps
 * Video.js's semantics, its keyboard steps, and its announcements. Keyboard steps show the deck still, at once.
 */
export class FbDeckElement extends UIElement {
  #time = new PlayerController(this, playerContext, selectTime);
  #playback = new PlayerController(this, playerContext, selectPlayback);
  #i18n = new I18nController(this, i18nContext);

  #abort: AbortController | null = null;
  #container: HTMLElement | null = null;
  #slider: HTMLElement | null = null;
  #stage: HTMLElement | null = null;
  #captionTime: HTMLElement | null = null;
  #captionChapter: HTMLElement | null = null;
  #captionRate: HTMLElement | null = null;
  #caption: HTMLElement | null = null;
  #shadow: HTMLElement | null = null;
  #cards: Card[] = [];
  #tiles: Tile[] = [];
  #chapters: Cue[] = [];
  #cols = 1;
  #rows = 1;
  #urls: (string | null)[] = [];
  #intent = 0;
  #intentX = 0;
  #intentAt = 0;
  #intentClientX = 0;
  #over = false;
  /** Put away with Escape: stays shut until the pointer leaves the bar (WCAG 1.4.13). */
  #escaped = false;
  #streak = 0;
  #coastFrame = 0;
  #swipeTimer = 0;

  // Geometry, read from layout on resize only.
  #w = 0;
  #h = 0;
  #cw = 0;
  #ch = 0;
  #cx = 0;
  #cy = 0;
  #top = 0;
  #bottom = 0;

  // State.
  #mode: Mode = 'idle';
  #layout: Layout = 'deck';
  #targetTime = 0;
  #target = 0;
  #pos = 0;
  #vel = 0;
  #spread = 0;
  #spreadTarget = 0;
  #spacing = 1;
  #spacingTarget = 1;
  #frame = 0;
  #last = 0;
  #speed = 0;
  #slowSince = 0;
  #timers: number[] = [];
  #keysTimer = 0;
  #gridTimer = 0;
  #morphTimer = 0;
  #resume = false;
  /** Where a drag was let go: hovering stays folded until the pointer has really moved on from there. */
  #release: { x: number; y: number } | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;

    this.setAttribute('aria-hidden', 'true');
    this.#container = this.closest('media-container');
    this.#stage = this.querySelector('[data-part="stage"]');
    this.#caption = this.querySelector('[data-part="caption"]');
    this.#captionTime = this.querySelector('[data-part="time"]');
    this.#captionChapter = this.querySelector('[data-part="chapter"]');
    this.#captionRate = this.querySelector('[data-part="rate"]');
    this.#shadow = this.querySelector('[data-part="shadow"]');
    const container = this.#container;
    if (!container || !this.#stage) return;

    this.#build();

    // The media mounts after the template is parsed: wait a tick, then read its storyboard and chapters.
    queueMicrotask(async () => {
      const book = await loadBook(container, signal);
      if (signal.aborted || !book) return;
      this.#tiles = book.tiles;
      this.#chapters = book.chapters;
      void wanted(container).then(() => frameUrls(container, book)).then((urls) => {
        this.#urls = urls;
      });
      this.#cols = book.cols;
      this.#rows = book.rows;
      this.#listen(signal);
      this.#measure();
    });

    new ResizeObserver(() => this.#measure()).observe(container);
    reducedMotion.addEventListener('change', () => this.#measure(), { signal });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort?.abort();
    this.#abort = null;
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    this.#clearTimers();
  }

  update(changed: PropertyValues) {
    super.update(changed);
    // Keyboard steps: the slider has moved the playhead; show where it is, still.
    if (this.#mode === 'keys') {
      const time = this.#time.value;
      if (time) this.#setTarget(time.currentTime, true);
    }
  }

  #t(key: LaneKey): string {
    return say(this.#i18n, key);
  }

  /** The ring of cards, each a printed frame: the picture, its paper edge and shadow (CSS), and a sheen for the turn. */
  #build() {
    const stage = this.#stage;
    if (!stage) return;
    const fragment = document.createDocumentFragment();
    this.#cards = Array.from({ length: POOL }, () => {
      const root = document.createElement('span');
      root.className = 'fb-card';
      const image = document.createElement('span');
      image.className = 'fb-card-image';
      const sheen = document.createElement('span');
      sheen.className = 'fb-card-sheen';
      const shade = document.createElement('span');
      shade.className = 'fb-card-shade';
      // The sharp frame, laid over the storyboard tile once it has decoded.
      const sharp = document.createElement('span');
      sharp.className = 'fb-card-sharp';
      image.append(sharp, shade, sheen);
      // The card's thickness: its two side edges, standing back from the face in 3D.
      const start = document.createElement('span');
      start.className = 'fb-card-edge';
      start.dataset.side = 'start';
      const end = document.createElement('span');
      end.className = 'fb-card-edge';
      end.dataset.side = 'end';
      root.append(start, end, image);
      fragment.append(root);
      return { root, image, sheen, shade, sharp, tile: -1, asked: -1 };
    });
    stage.replaceChildren(fragment);
  }

  #listen(signal: AbortSignal) {
    const slider = this.#container?.querySelector<HTMLElement>('media-time-slider');
    if (!slider) return;
    this.#slider = slider;

    // A drag on the bar is the deck's: it replaces the slider's own, so it can flip, lay out a grid and slow down.
    slider.addEventListener('pointerdown', (event) => this.#press(event), { capture: true, signal });
    slider.addEventListener('pointermove', (event) => this.#hover(event), { passive: true, signal });
    slider.addEventListener('pointerenter', () => {
      this.#over = true;
    }, { passive: true, signal });
    slider.addEventListener('pointerleave', (event) => {
      this.#over = false;
      this.#escaped = false;
      clearTimeout(this.#intent);
      this.#intent = 0;
      this.#release = null;
      // The cards opened by hover can be hovered too (WCAG 1.4.13): moving up onto them keeps the deck open.
      if (this.#mode === 'hover' && event.pointerType === 'mouse' && !this.#onCards(event)) this.#dismiss();
    }, { passive: true, signal });
    this.#container?.addEventListener('pointermove', (event) => {
      if (this.#mode !== 'hover' || this.#over || event.pointerType !== 'mouse') return;
      if (!this.#onCards(event)) this.#dismiss();
    }, { passive: true, signal });
    this.#container?.addEventListener('pointerleave', () => {
      if (this.#mode === 'hover' && !this.#over) this.#dismiss();
    }, { passive: true, signal });
    // Escape puts the deck away without moving the pointer or focus, whichever opened it.
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || (this.#mode !== 'hover' && this.#mode !== 'keys')) return;
      this.#escaped = this.#mode === 'hover';
      clearTimeout(this.#intent);
      this.#intent = 0;
      this.#dismiss();
    }, { capture: true, signal });
    // The film has been taken (flip.ts, which says by what): the deck stands down. A press on the edge, a click or the
    // start of a drag, shuts it at once, with no closing to watch: the viewer has chosen, and is back in the film. It
    // then stays shut until the pointer has moved on from where it pressed or let go (`fb-flip-end`), or has left
    // the edge and come back. A held key or the wheel closes it up calmly, shut until the pointer has left the edge.
    this.#container?.addEventListener('fb-flip', (event) => {
      const { by, x, y } = (event as CustomEvent<{ by?: string; x?: number; y?: number }>).detail ?? {};
      const pointer = by === 'press' || by === 'hand';
      clearTimeout(this.#intent);
      this.#intent = 0;
      if (pointer) {
        if (x != null && y != null) this.#release = { x, y };
      } else {
        this.#escaped = this.#over;
      }
      this.#stopCoast();
      this.#resume = false;
      if (this.#mode === 'fold') this.#cancelFold();
      if (pointer || this.#mode === 'fold') this.#shut();
      else this.#dismiss();
    }, { signal });
    this.#container?.addEventListener('fb-flip-end', (event) => {
      const { x, y } = (event as CustomEvent<{ x: number; y: number }>).detail;
      clearTimeout(this.#intent);
      this.#intent = 0;
      if (this.#over) this.#release = { x, y };
    }, { signal });
    // Page Up and Page Down go from detent to detent (goto.ts, the core's keys): the deck shows where they landed, still.
    this.#container?.addEventListener('fb-detent', (event) => {
      const { time } = (event as CustomEvent<{ time: number }>).detail;
      this.#keys();
      this.#setTarget(time, true);
    }, { signal });
    slider.addEventListener('keydown', (event) => {
      if (!SEEK_KEYS.has(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
      this.#keys();
    }, { signal });
    slider.addEventListener('focusout', () => {
      if (this.#mode === 'keys') this.#dismiss();
    }, { signal });

    // Swiping the picture flips pages too: two fingers sideways on a trackpad, or a finger across a touch screen.
    const container = this.#container;
    if (!container) return;
    container.addEventListener('wheel', (event) => this.#wheel(event), { passive: false, signal });
    container.addEventListener('pointerdown', (event) => this.#touch(event), { signal });
  }

  /** Geometry, read once per resize: the player, the bar's top edge, and the front card's size and place. */
  #measure() {
    const container = this.#container;
    const stage = this.#stage;
    if (!container || !stage || !this.#tiles.length) return;
    const box = container.getBoundingClientRect();
    const bar = container.querySelector<HTMLElement>('.fb-bar');
    const barTop = bar ? bar.getBoundingClientRect().top - box.top : box.height * 0.8;
    const first = this.#tiles[0];
    const ratio = first.w / first.h;

    this.#w = box.width;
    this.#h = box.height;
    this.#top = Math.max(12, box.height * 0.06);
    // Room for the chapter tabs that stand up from the bar's fore-edge.
    this.#bottom = Math.max(this.#top, barTop - (box.width < 480 ? 10 : 26));
    const caption = box.width < 480 ? 10 : 18;
    const room = this.#bottom - this.#top - caption;
    this.#cw = Math.min(box.width * 0.46, room * 0.8 * ratio);
    this.#ch = this.#cw / ratio;
    this.#cx = box.width / 2;
    this.#cy = this.#top + room / 2;
    const shadow = this.querySelector<HTMLElement>('[data-part="shadow"]');
    if (shadow) {
      shadow.style.width = `${(this.#cw * 1.7).toFixed(1)}px`;
      shadow.style.height = `${(this.#ch * 0.36).toFixed(1)}px`;
      shadow.style.transform = `translate3d(${(this.#cx - this.#cw * 0.85).toFixed(1)}px, ${(this.#cy + this.#ch * 0.38).toFixed(1)}px, 0)`;
    }

    const ready = room > 48 && this.#cw > 64;
    container.toggleAttribute('data-fb-ready', ready);
    stage.style.setProperty('--fb-cw', `${this.#cw.toFixed(2)}px`);
    stage.style.setProperty('--fb-ch', `${this.#ch.toFixed(2)}px`);
    stage.style.setProperty('--fb-cx', `${this.#cx.toFixed(2)}px`);
    stage.style.setProperty('--fb-cy', `${this.#cy.toFixed(2)}px`);
    stage.style.perspective = `${(this.#cw * 2.6).toFixed(0)}px`;
    stage.style.perspectiveOrigin = `${this.#cx.toFixed(1)}px ${this.#cy.toFixed(1)}px`;

    if (this.#mode !== 'idle' && this.#mode !== 'fold') {
      this.#layout = this.#still() ? 'strip' : this.#layout === 'strip' ? 'deck' : this.#layout;
      this.#render();
    }
  }

  #still() {
    return reducedMotion.matches;
  }

  /** A hand is moving the film itself (flip.ts marks it as a scrub, `data-fb-deck="flip"`): the deck stays shut. */
  #flipping() {
    return this.#container?.getAttribute('data-fb-deck') === 'flip';
  }

  #ready() {
    return this.#tiles.length > 0 && !!this.#container?.hasAttribute('data-fb-ready');
  }

  #duration() {
    const duration = this.#time.value?.duration ?? 0;
    return Number.isFinite(duration) ? duration : 0;
  }

  #timeAt(clientX: number) {
    const slider = this.#slider;
    if (!slider) return 0;
    const box = slider.getBoundingClientRect();
    return clamp((clientX - box.left) / box.width, 0, 1) * this.#duration();
  }

  // ─── Input ────────────────────────────────────────────────────────────────

  /** A mouse pointing at the bar: the deck opens on that moment and follows it. */
  #hover(event: PointerEvent) {
    if (event.pointerType !== 'mouse' || event.buttons || this.#mode === 'drag' || this.#escaped || !this.#ready()) return;
    if (!this.#duration() || this.#flipping()) return;
    if (this.#release) {
      if (Math.hypot(event.clientX - this.#release.x, event.clientY - this.#release.y) < 12) return;
      this.#release = null;
    }
    if (this.#mode === 'swipe' || this.#mode === 'coast') return;
    // Already open: follow the pointer at once. Not yet: open only once it rests or slows here.
    if (this.#mode === 'hover') {
      this.#setTarget(this.#timeAt(event.clientX));
      return;
    }
    const now = performance.now();
    const speed = this.#intentAt ? Math.abs(event.clientX - this.#intentX) / Math.max(1, now - this.#intentAt) : 0;
    this.#intentX = event.clientX;
    this.#intentAt = now;
    this.#intentClientX = event.clientX;
    if (speed > INTENT_FAST || !this.#intent) {
      clearTimeout(this.#intent);
      this.#intent = window.setTimeout(() => {
        this.#intent = 0;
        if (!this.#over || this.#mode === 'drag' || this.#release || this.#flipping()) return;
        this.#activate('hover');
        this.#setTarget(this.#timeAt(this.#intentClientX));
      }, INTENT);
    }
  }

  /** Press on the bar: jump there, then drag to flip. Up and away slows the scrub; a fast drag lays out the grid. */
  #press(event: PointerEvent) {
    const slider = this.#slider;
    const duration = this.#duration();
    if (!slider || event.button !== 0 || !event.isPrimary || !duration || !this.#ready()) return;
    // With flip.ts here, a press on the edge moves the film itself: the drag is its, not the deck's.
    if (this.#container?.hasAttribute('data-fb-flip')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    clearTimeout(this.#intent);
    this.#intent = 0;
    this.#stopCoast();
    slider.setPointerCapture(event.pointerId);

    const playback = this.#playback.value;
    this.#resume = !!playback && !playback.paused;
    if (this.#resume) playback?.pause();

    const box = slider.getBoundingClientRect();
    let anchorX = event.clientX;
    let anchorTime = this.#timeAt(event.clientX);
    let lane: (typeof LANES)[number] = LANES[0];
    let lastX = event.clientX;
    let lastY = event.clientY;
    let lastSeek = 0;
    let pending = 0;
    let prevTime = anchorTime;
    let prevAt = performance.now();
    // The film's own velocity under the pointer (seconds per second), for a throw on release.
    let velocity = 0;
    this.#speed = 0;
    this.#slowSince = 0;

    const seek = (time: number, force = false) => {
      const now = performance.now();
      if (!force && now - lastSeek < SEEK_EVERY) return;
      lastSeek = now;
      const video = videoOf(findMedia(this.#container ?? this));
      if (this.#container) hush(this.#container);
      if (video) video.currentTime = time;
    };

    this.#activate('drag');
    this.#setTarget(anchorTime);
    this.#setLane(lane);
    seek(anchorTime, true);

    const frame = () => {
      pending = 0;
      const lift = box.top - lastY;
      const next = [...LANES].reverse().find((l) => lift >= l.from) ?? LANES[0];
      if (next !== lane) {
        // Re-anchor where the rate changes, so the playhead never jumps.
        anchorX = lastX;
        anchorTime = this.#targetTime;
        lane = next;
        this.#setLane(lane);
      }
      const time = clamp(anchorTime + ((lastX - anchorX) / box.width) * duration * lane.rate, 0, duration);
      const now = performance.now();
      const span = this.#tiles[0].end - this.#tiles[0].start || 1;
      const rate = Math.abs(time - prevTime) / span / Math.max(0.008, (now - prevAt) / 1000);
      this.#speed = this.#speed * 0.6 + rate * 0.4;
      velocity = velocity * 0.5 + ((time - prevTime) / Math.max(0.008, (now - prevAt) / 1000)) * 0.5;
      prevTime = time;
      prevAt = now;
      this.#setTarget(time);
      this.#pace(now);
      seek(time);
    };

    const move = (e: PointerEvent) => {
      lastX = e.clientX;
      lastY = e.clientY;
      if (!pending) pending = requestAnimationFrame(frame);
    };

    const end = (e: PointerEvent) => {
      cancelAnimationFrame(pending);
      slider.removeEventListener('pointermove', move);
      slider.removeEventListener('pointerup', end);
      slider.removeEventListener('pointercancel', end);
      clearTimeout(this.#gridTimer);
      if (slider.hasPointerCapture(e.pointerId)) slider.releasePointerCapture(e.pointerId);
      this.#setLane(LANES[0]);
      this.#release = { x: e.clientX, y: e.clientY };
      // A throw: let go while moving fast and the cards fly on, slowing to rest on a frame, then fold.
      const fresh = performance.now() - prevAt < 90;
      if (fresh && Math.abs(velocity) > FLICK_MIN && !this.#still()) {
        if (this.#layout !== 'deck') this.#setLayout('deck');
        this.#coast(velocity);
        return;
      }
      // A detent: released close to a chapter's start, the ribbon settles on it.
      const detent = this.#detent(this.#targetTime, DETENT);
      if (detent != null) {
        this.#setTarget(detent);
        this.#settle(detent);
      }
      seek(this.#targetTime, true);
      this.#fold();
    };

    slider.addEventListener('pointermove', move);
    slider.addEventListener('pointerup', end);
    slider.addEventListener('pointercancel', end);
  }

  /** Fast drags lay the deck out flat; slowing down, or stopping, folds it back into the fan. */
  #pace(now: number) {
    if (this.#still()) return;
    clearTimeout(this.#gridTimer);
    if (this.#layout === 'deck' && this.#speed > GRID_IN) {
      this.#slowSince = 0;
      this.#setLayout('grid');
    } else if (this.#layout === 'grid') {
      if (this.#speed < GRID_OUT) {
        this.#slowSince ||= now;
        if (now - this.#slowSince > GRID_HOLD) this.#setLayout('deck');
      } else {
        this.#slowSince = 0;
      }
    }
    // The pointer stopped altogether: no more moves will come to slow it, so fold back after the hold.
    if (this.#layout === 'grid') {
      this.#gridTimer = window.setTimeout(() => {
        if (this.#mode === 'drag') this.#setLayout('deck');
      }, GRID_HOLD + 80);
    }
  }

  #setLane(lane: (typeof LANES)[number]) {
    this.#spacingTarget = lane.spacing;
    if (this.#still()) this.#spacing = lane.spacing;
    this.toggleAttribute('data-fine', lane.rate < 1);
    if (this.#slider) {
      if (lane.rate < 1) this.#slider.dataset.fbRate = String(lane.rate);
      else delete this.#slider.dataset.fbRate;
    }
    const rate = this.#captionRate;
    if (rate) {
      const label = lane.key ? this.#t(lane.key) : '';
      if (rate.textContent !== label) rate.textContent = label;
    }
    this.#kick();
  }

  /** Arrow keys on the seek slider: the deck appears at once, still, and clears shortly after the last key. */
  #keys() {
    if (!this.#ready()) return;
    if (this.#mode !== 'keys') this.#activate('keys');
    clearTimeout(this.#keysTimer);
    this.#keysTimer = window.setTimeout(() => {
      if (this.#mode === 'keys') this.#dismiss();
    }, KEYS_HOLD);
  }

  // ─── State ────────────────────────────────────────────────────────────────

  // ─── Throws and swipes ───────────────────────────────────────────────────

  /**
   * The cards fly on after a throw, slowing as they go (with a light streak across them while they're fast), come
   * to rest on a frame, and fold into the picture there.
   */
  #coast(velocity: number) {
    const duration = this.#duration();
    this.#stopCoast();
    this.#mode = 'coast';
    this.dataset.mode = 'coast';
    this.toggleAttribute('data-streak', true);
    let v = velocity;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      v *= Math.exp(-dt / FLICK_DECAY);
      const time = clamp(this.#targetTime + v * dt, 0, duration);
      this.#streak = Math.min(1, Math.abs(v) / 40);
      this.#setTarget(time);
      // Slowing past a chapter, the throw is caught in its detent.
      const caught = Math.abs(v) < DETENT_CATCH ? this.#detent(time, DETENT * 2) : null;
      if (caught != null) {
        this.#coastFrame = 0;
        this.#land(caught);
        return;
      }
      if (Math.abs(v) > FLICK_REST && time > 0 && time < duration) {
        this.#coastFrame = requestAnimationFrame(step);
        return;
      }
      this.#coastFrame = 0;
      this.#land();
    };
    this.#coastFrame = requestAnimationFrame(step);
  }

  /** At rest: the video goes to the front card's own frame, the card settles, and the deck folds onto it. */
  #land(chapterStart?: number) {
    this.#streak = 0;
    this.toggleAttribute('data-streak', false);
    const tile = this.#tiles[this.#target];
    const time = chapterStart ?? (tile ? Math.min(this.#duration(), tile.start + 0.04) : this.#targetTime);
    this.#setTarget(time);
    if (chapterStart != null) this.#settle(chapterStart);
    const video = videoOf(findMedia(this.#container ?? this));
    if (this.#container) hush(this.#container);
    if (video) video.currentTime = time;
    this.#timers.push(window.setTimeout(() => {
      if (this.#mode === 'coast' || this.#mode === 'swipe') this.#fold();
    }, this.#still() ? 0 : 160));
  }

  /** The chapter start within `px` of a time along the edge, if there is one. */
  #detent(time: number, px: number): number | null {
    const width = this.#slider?.getBoundingClientRect().width ?? 0;
    const duration = this.#duration();
    if (!width || !duration) return null;
    const reach = (px / width) * duration;
    let best: number | null = null;
    for (const chapter of this.#chapters) {
      const gap = Math.abs(chapter.startTime - time);
      if (gap <= reach && (best == null || gap < Math.abs(best - time))) best = chapter.startTime;
    }
    return best;
  }

  /** Settled in a detent: the ribbon gives a small nod, and the chapter is announced. */
  #settle(time: number) {
    const thumb = this.#slider?.querySelector<HTMLElement>('.media-time-slider-thumb');
    if (thumb && !this.#still()) {
      thumb.animate([{ transform: 'translateY(-4px)' }, { transform: 'translateY(0)' }], { duration: 180, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
    }
    const index = this.#chapters.findIndex((c) => Math.abs(c.startTime - time) < 0.05);
    if (index >= 0) {
      this.#container?.dispatchEvent(new CustomEvent('fb-chapter-settle', { detail: { index, title: this.#chapters[index].text } }));
    }
  }

  #stopCoast() {
    cancelAnimationFrame(this.#coastFrame);
    this.#coastFrame = 0;
    clearTimeout(this.#swipeTimer);
    this.#streak = 0;
    this.toggleAttribute('data-streak', false);
  }

  /** Whether an event belongs to the picture itself, not to a control or panel over it. */
  #onPicture(event: Event) {
    const target = event.target as Element | null;
    return !target?.closest('.fb-bar, .video-controls-top, .media-popup, fb-curl, .fb-resume, .fb-cover-play, media-error-dialog, [data-fb-overlay]');
  }

  /** Begins a swipe: the deck opens on the playhead, and playback holds while the pages move. */
  #beginSwipe() {
    if (this.#mode === 'swipe') return;
    this.#stopCoast();
    const playback = this.#playback.value;
    if (this.#mode === 'idle' || this.#mode === 'hover' || this.#mode === 'fold') {
      this.#resume = !!playback && !playback.paused;
      if (this.#resume) playback?.pause();
      this.#targetTime = this.#time.value?.currentTime ?? 0;
    }
    this.#activate('swipe');
    this.#setTarget(this.#targetTime);
  }

  /** Two fingers sideways on a trackpad. Vertical scrolling is never taken: only a clearly sideways wheel flips. */
  #wheel(event: WheelEvent) {
    if (!this.#ready() || !this.#duration() || !this.#onPicture(event)) return;
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
    const dx = event.deltaX * scale;
    const dy = event.deltaY * scale;
    const sideways = Math.abs(dx) > Math.abs(dy) * 1.2 && Math.abs(dx) > 1;
    if (!sideways) return;
    event.preventDefault();
    this.#beginSwipe();
    const span = this.#tiles[0].end - this.#tiles[0].start || 1;
    const time = clamp(this.#targetTime + dx * SWIPE_PAGES_PER_PX * span, 0, this.#duration());
    this.#setTarget(time);
    // The trackpad carries its own momentum; when its events stop, the deck lands.
    clearTimeout(this.#swipeTimer);
    this.#swipeTimer = window.setTimeout(() => this.#land(), this.#still() ? 0 : SWIPE_IDLE);
  }

  /** A finger across the picture on a touch screen: the pages follow it, and a flick throws them. */
  #touch(event: PointerEvent) {
    if (event.pointerType !== 'touch' || !event.isPrimary || !this.#ready() || !this.#duration() || !this.#onPicture(event)) return;
    const container = this.#container;
    // With the hand on the film (flip.ts) a finger across the picture moves the film itself, not the deck.
    if (container?.hasAttribute('data-fb-flip')) return;
    if (!container) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let lastX = startX;
    let lastAt = performance.now();
    let velocity = 0;
    let swiping = false;
    const span = this.#tiles[0].end - this.#tiles[0].start || 1;
    const perPx = SWIPE_PAGES_PER_PX * span * 1.4;

    const move = (e: PointerEvent) => {
      if (e.pointerId !== event.pointerId) return;
      if (!swiping) {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(dy) * 1.3) return;
        swiping = true;
        container.setPointerCapture(e.pointerId);
        this.#beginSwipe();
      }
      const now = performance.now();
      // Finger to the left turns forward, as a page is pushed over.
      const delta = -(e.clientX - lastX) * perPx;
      velocity = velocity * 0.5 + (delta / Math.max(0.008, (now - lastAt) / 1000)) * 0.5;
      lastX = e.clientX;
      lastAt = now;
      this.#setTarget(clamp(this.#targetTime + delta, 0, this.#duration()));
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== event.pointerId) return;
      container.removeEventListener('pointermove', move);
      container.removeEventListener('pointerup', end);
      container.removeEventListener('pointercancel', end);
      if (!swiping) return;
      if (performance.now() - lastAt < 90 && Math.abs(velocity) > FLICK_MIN && !this.#still()) this.#coast(velocity);
      else this.#land();
    };
    container.addEventListener('pointermove', move, { passive: true });
    container.addEventListener('pointerup', end);
    container.addEventListener('pointercancel', end);
  }

  #activate(mode: Mode) {
    if (this.#mode === 'fold') this.#cancelFold();
    const wasIdle = this.#mode === 'idle';
    this.#mode = mode;
    const instant = mode === 'keys' || this.#still();
    if (wasIdle) {
      this.#layout = this.#still() ? 'strip' : 'deck';
      this.#spread = instant ? 1 : 0;
      this.#spacing = this.#spacingTarget = 1;
      // A fresh deck starts on its frame: the first flip is a page turn, not a riffle from wherever it last was.
      const time = mode === 'keys' ? (this.#time.value?.currentTime ?? 0) : this.#targetTime;
      this.#target = this.#pos = tileAt(this.#tiles, time);
      this.#vel = 0;
    }
    this.#spreadTarget = 1;
    this.dataset.mode = mode;
    this.dataset.layout = this.#layout;
    this.toggleAttribute('data-active', true);
    this.#container?.setAttribute('data-fb-deck', mode === 'keys' ? 'keys' : 'open');
    this.#kick();
  }

  #setTarget(time: number, instant = false) {
    if (!this.#tiles.length) return;
    this.#targetTime = time;
    this.#target = tileAt(this.#tiles, time);
    if (instant || this.#still()) {
      this.#pos = this.#target;
      this.#vel = 0;
    }
    const label = clock(time);
    if (this.#captionTime && this.#captionTime.textContent !== label) this.#captionTime.textContent = label;
    const chapter = this.#chapters.find((c) => time >= c.startTime && time < c.endTime)?.text ?? '';
    if (this.#captionChapter && this.#captionChapter.textContent !== chapter) this.#captionChapter.textContent = chapter;
    this.#kick();
  }

  #setLayout(layout: Layout) {
    if (layout === this.#layout) return;
    this.#layout = layout;
    this.dataset.layout = layout;
    // The change between fan and grid is a scene change: the cards travel, then the frame loop takes over again.
    this.toggleAttribute('data-morph', true);
    clearTimeout(this.#morphTimer);
    this.#morphTimer = window.setTimeout(() => this.toggleAttribute('data-morph', false), MORPH);
    this.#render();
    this.#kick();
  }

  /**
   * Whether the pointer is over the fanned cards, or on its way up to them: within the player, between the deck's top
   * and the bar (the chapter tabs' strip in between counts, so crossing it doesn't shut the deck).
   */
  #onCards(event: PointerEvent): boolean {
    const box = this.#container?.getBoundingClientRect();
    const bar = this.#slider?.getBoundingClientRect();
    if (!box || !bar) return false;
    const x = event.clientX - box.left;
    return x >= 0 && x <= box.width && event.clientY >= box.top + this.#top && event.clientY <= bar.bottom;
  }

  /** Shut at once, from whatever it was doing: nothing closes to be watched, and the picture is the film's again. */
  #shut() {
    clearTimeout(this.#keysTimer);
    this.#mode = 'idle';
    this.dataset.mode = 'idle';
    this.#spreadTarget = 0;
    this.#container?.removeAttribute('data-fb-deck');
    this.#hide();
  }

  /** Pointer left without choosing: the deck closes up and the picture steps forward again. Nothing seeks. */
  #dismiss() {
    if (this.#mode === 'idle' || this.#mode === 'fold') return;
    clearTimeout(this.#keysTimer);
    const instant = this.#mode === 'keys' || this.#still();
    this.#mode = 'idle';
    this.dataset.mode = 'idle';
    this.#spreadTarget = 0;
    this.#container?.removeAttribute('data-fb-deck');
    this.toggleAttribute('data-closing', true);
    if (instant) {
      this.#spread = 0;
      this.#hide();
      return;
    }
    this.#kick();
  }

  /**
   * Let go: the deck folds back into the picture. The front card travels to exactly where the frame is shown and
   * lands on it (FLIP from the card's box to the picture's), the others close up behind it, and the picture steps
   * forward to meet it. Playback carries on from there.
   */
  #fold() {
    const resume = () => {
      if (!this.#resume) return;
      this.#resume = false;
      const video = videoOf(findMedia(this.#container ?? this));
      if (video?.seeking) video.addEventListener('seeked', () => void video.play(), { once: true });
      else void this.#playback.value?.play();
    };
    this.#container?.removeAttribute('data-fb-deck');

    if (this.#still() || !this.#cards.length) {
      this.#mode = 'idle';
      this.dataset.mode = 'idle';
      this.#hide();
      resume();
      return;
    }

    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    this.#mode = 'fold';
    this.dataset.mode = 'fold';

    // Where the picture will be once it has stepped forward: the media's box, fitted as `object-fit: contain`.
    const video = videoOf(findMedia(this.#container ?? this));
    const ratio = video?.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : this.#cw / this.#ch;
    const fitW = this.#w / this.#h > ratio ? this.#h * ratio : this.#w;
    const fitH = fitW / ratio;
    const target = this.#target;
    const front = this.#cards[mod(target, POOL)];

    this.toggleAttribute('data-folding', true);
    for (const card of this.#cards) {
      if (card === front) {
        card.root.toggleAttribute('data-landing', true);
        card.root.style.zIndex = '100';
        card.root.style.opacity = '1';
        card.root.style.transform = this.#transform(this.#w / 2 - this.#cx, this.#h / 2 - this.#cy, 0, 0, fitW / this.#cw, fitH / this.#ch);
        card.sheen.style.opacity = '0';
        card.shade.style.opacity = '0';
      } else if (card.tile >= 0) {
        // The rest close up behind the front card as it leaves.
        const k = clamp(card.tile - target, -2, 2);
        card.root.style.transform = this.#transform(k * this.#cw * 0.12, 0, -this.#cw * 0.4, k * 20, 0.9, 0.9);
        card.root.style.opacity = '0';
      }
    }
    resume();

    this.#timers.push(
      window.setTimeout(() => {
        front.root.style.opacity = '0';
      }, LAND_AT),
      window.setTimeout(() => {
        this.#mode = 'idle';
        this.dataset.mode = 'idle';
        this.#hide();
      }, Math.max(FOLD, LAND_AT + LAND) + 20),
    );
  }

  #cancelFold() {
    this.#clearTimers();
    this.toggleAttribute('data-folding', false);
    for (const card of this.#cards) card.root.toggleAttribute('data-landing', false);
  }

  #clearTimers() {
    for (const id of this.#timers) clearTimeout(id);
    this.#timers = [];
    clearTimeout(this.#keysTimer);
    clearTimeout(this.#gridTimer);
    clearTimeout(this.#morphTimer);
  }

  #hide() {
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    this.toggleAttribute('data-active', false);
    this.toggleAttribute('data-closing', false);
    this.toggleAttribute('data-folding', false);
    this.toggleAttribute('data-morph', false);
    this.toggleAttribute('data-fine', false);
    for (const card of this.#cards) {
      card.root.toggleAttribute('data-landing', false);
      card.root.toggleAttribute('data-current', false);
      card.root.style.opacity = '0';
    }
    this.#spread = 0;
  }

  // ─── Frame loop ───────────────────────────────────────────────────────────

  /** One frame request at a time, however many pointer moves arrive; the loop stops once everything has settled. */
  #kick() {
    if (this.#frame || this.#mode === 'fold') return;
    this.#last = performance.now();
    this.#frame = requestAnimationFrame((now) => this.#tick(now));
  }

  #tick(now: number) {
    this.#frame = 0;
    if (this.#mode === 'fold') return;
    // Real time, even when frames come slowly: the spring is stepped in small fixed steps up to a tenth of a second.
    const dt = Math.min(0.1, Math.max(0.001, (now - this.#last) / 1000));
    this.#last = now;

    if (this.#still()) {
      this.#pos = this.#target;
      this.#vel = 0;
      this.#spread = this.#spreadTarget;
      this.#spacing = this.#spacingTarget;
    } else {
      const steps = Math.ceil(dt / (1 / 240));
      const h = dt / steps;
      for (let n = 0; n < steps; n++) {
        const accel = -OMEGA * OMEGA * (this.#pos - this.#target) - 2 * OMEGA * this.#vel;
        this.#vel += accel * h;
        this.#pos += this.#vel * h;
      }
      // The fan opens with an ease-out (about 250 ms) and closes a little quicker.
      const tau = this.#spreadTarget > this.#spread ? 0.075 : 0.05;
      this.#spread += (this.#spreadTarget - this.#spread) * (1 - Math.exp(-dt / tau));
      this.#spacing += (this.#spacingTarget - this.#spacing) * (1 - Math.exp(-dt / 0.08));
    }

    // Closing, the deck is put away once it has closed (the last hundredth is not seen), inside a quarter of a second:
    // it does not wait for cards nobody can see to finish travelling.
    const closed = this.#spreadTarget === 0 && this.#mode === 'idle' && this.#spread < 0.01;
    const settled =
      closed ||
      (Math.abs(this.#pos - this.#target) < 0.002 &&
        Math.abs(this.#vel) < 0.01 &&
        Math.abs(this.#spread - this.#spreadTarget) < 0.004 &&
        Math.abs(this.#spacing - this.#spacingTarget) < 0.004);
    if (settled) {
      this.#pos = this.#target;
      this.#vel = 0;
      this.#spread = this.#spreadTarget;
      this.#spacing = this.#spacingTarget;
    }

    this.#render();

    if (settled) {
      if (this.#spreadTarget === 0 && this.#mode === 'idle') this.#hide();
      return;
    }
    this.#frame = requestAnimationFrame((t) => this.#tick(t));
  }

  #transform(x: number, y: number, z: number, rotate: number, sx: number, sy = sx) {
    return `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, ${z.toFixed(2)}px) rotateY(${rotate.toFixed(2)}deg) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
  }

  /** Points a card at a frame of the sprite. Only when its frame changes: the deck reuses twelve cards as a ring. */
  #assign(card: Card, index: number) {
    if (card.tile === index) return;
    card.tile = index;
    const tile = this.#tiles[index];
    if (!tile) return;
    const col = Math.round(tile.x / tile.w);
    const row = Math.round(tile.y / tile.h);
    const x = this.#cols > 1 ? (col / (this.#cols - 1)) * 100 : 0;
    const y = this.#rows > 1 ? (row / (this.#rows - 1)) * 100 : 0;
    card.image.style.backgroundPosition = `${x.toFixed(4)}% ${y.toFixed(4)}%`;
    // A new page on this card: its old sharp frame goes at once (never a flash of the wrong picture).
    card.sharp.toggleAttribute('data-ready', false);
    card.sharp.style.backgroundImage = '';
    card.asked = -1;
  }

  /** Swaps the storyboard tile for the sharp frame once it has decoded, if the card still shows that page. */
  #sharpen(card: Card) {
    const index = card.tile;
    if (index < 0 || card.asked === index) return;
    const url = this.#urls[index];
    if (!url) return;
    card.asked = index;
    void sharpFrame(url).then((image) => {
      if (!image || card.tile !== index) return;
      card.sharp.style.backgroundImage = `url("${url}")`;
      card.sharp.toggleAttribute('data-ready', true);
    });
  }

  #render() {
    if (!this.#cards.length || !this.#tiles.length) return;
    if (this.#layout === 'grid') this.#renderGrid();
    else if (this.#layout === 'strip') this.#renderStrip();
    else this.#renderDeck();
    this.#placeCaption();
  }

  /** The fan: the front card faces you; the rest turn away to either side, receding and fading with distance. */
  #renderDeck() {
    const cw = this.#cw;
    const ch = this.#ch;
    const spread = this.#spread;
    const spacing = this.#spacing;
    const center = Math.round(this.#pos);
    const stage = this.#stage;
    if (stage) stage.style.opacity = String(Math.min(1, spread * 1.5).toFixed(3));
    if (this.#shadow) this.#shadow.style.opacity = (spread * 0.9).toFixed(3);

    for (let i = center - 5; i <= center + 6; i++) {
      const card = this.#cards[mod(i, POOL)];
      const k = i - this.#pos;
      const a = Math.abs(k);
      if (i < 0 || i >= this.#tiles.length || a > REACH) {
        card.root.style.opacity = '0';
        card.root.toggleAttribute('data-current', false);
        continue;
      }
      this.#assign(card, i);
      const s = Math.sign(k);
      const turn = smooth(Math.min(a, 1));
      const far = Math.max(0, a - 1);
      const x = s * (turn * cw * 0.58 + far * cw * 0.17) * spacing * spread;
      const z = -(turn * cw * 0.34 + far * cw * 0.14) * spread;
      // Lifted slightly as it turns over, as a page is.
      const y = -Math.sin(Math.PI * Math.min(a, 1)) * ch * 0.035 * spread;
      const rotate = s * turn * 56 * spread;
      const scale = 0.94 + 0.06 * spread;
      card.root.style.transform = this.#transform(x, y, z, rotate, scale);
      card.root.style.opacity = (a <= 1 ? 1 : Math.max(0, 1 - far * 0.21)).toFixed(3);
      // Pages further from the front fall into the desk's shadow.
      card.shade.style.opacity = Math.min(0.62, turn * 0.26 + far * 0.08).toFixed(3);
      card.root.style.zIndex = String(60 - Math.round(a * 6));
      card.root.toggleAttribute('data-current', i === this.#target && a < 0.5);
      // The light catches the page as it passes the front; thrown, the whole deck streaks with it.
      const glint = Math.sin(Math.PI * Math.min(a, 1)) * 0.6;
      card.sheen.style.opacity = Math.max(glint, this.#streak * 0.5 * (1 - Math.min(1, a / 4))).toFixed(3);
      card.sheen.style.transform = `translate3d(${(clamp(k, -1, 1) * 70).toFixed(1)}%, 0, 0)`;
      if (a <= SHARP_REACH) this.#sharpen(card);
    }
  }

  /** The grid: twelve frames around the target, flat, in reading order, so a scene can be spotted at a glance. */
  #renderGrid() {
    const stage = this.#stage;
    if (stage) stage.style.opacity = '1';
    const count = this.#tiles.length;
    const cols = 4;
    const rows = 3;
    const gap = this.#w < 600 ? 6 : 10;
    const availW = this.#w * 0.9;
    const availH = (this.#bottom - this.#top) * 0.86 - 28;
    const cell = Math.min((availW - gap * (cols - 1)) / cols, ((availH - gap * (rows - 1)) / rows) * (this.#cw / this.#ch));
    const cellH = cell * (this.#ch / this.#cw);
    const gridW = cell * cols + gap * (cols - 1);
    const gridH = cellH * rows + gap * (rows - 1);
    const left = this.#w / 2 - gridW / 2;
    const top = this.#top + (this.#bottom - this.#top - 28) / 2 - gridH / 2;
    const start = clamp(this.#target - 5, 0, Math.max(0, count - POOL));

    for (let n = 0; n < POOL; n++) {
      const i = start + n;
      const card = this.#cards[mod(i, POOL)];
      if (i >= count) {
        card.root.style.opacity = '0';
        card.tile = -1;
        continue;
      }
      this.#assign(card, i);
      const col = n % cols;
      const row = Math.floor(n / cols);
      const x = left + col * (cell + gap) + cell / 2 - this.#cx;
      const y = top + row * (cellH + gap) + cellH / 2 - this.#cy;
      card.root.style.transform = this.#transform(x, y, 0, 0, cell / this.#cw);
      card.root.style.opacity = '1';
      card.root.style.zIndex = i === this.#target ? '61' : '50';
      card.root.toggleAttribute('data-current', i === this.#target);
      card.sheen.style.opacity = '0';
      card.shade.style.opacity = '0';
    }
    this.#gridBottom = top + gridH;
  }

  /** Reduced motion: a flat strip of frames around the target, which swaps in place. Nothing travels or turns. */
  #renderStrip() {
    const stage = this.#stage;
    if (stage) stage.style.opacity = '1';
    const slots = this.#w < 520 ? 5 : 7;
    const half = (slots - 1) / 2;
    const gap = this.#w < 600 ? 6 : 10;
    // The frame you're on is printed larger, in the middle; its neighbours sit either side, smaller.
    const grow = 1.7;
    const cell = Math.min((this.#w * 0.94 - gap * (slots - 1)) / (slots - 1 + grow), this.#cw / grow);
    const big = cell * grow;
    const center = this.#target;

    for (let n = 0; n < POOL; n++) this.#cards[n].root.style.opacity = '0';
    for (let k = -half; k <= half; k++) {
      const i = center + k;
      if (i < 0 || i >= this.#tiles.length) continue;
      const card = this.#cards[mod(i, POOL)];
      this.#assign(card, i);
      const x = k === 0 ? 0 : Math.sign(k) * (big / 2 + gap + cell / 2 + (Math.abs(k) - 1) * (cell + gap));
      card.root.style.transform = this.#transform(x, 0, 0, 0, (k === 0 ? big : cell) / this.#cw);
      card.root.style.opacity = '1';
      card.root.style.zIndex = k === 0 ? '61' : '50';
      card.root.toggleAttribute('data-current', k === 0);
      card.sheen.style.opacity = '0';
      card.shade.style.opacity = k === 0 ? '0' : '0.3';
      if (k === 0) this.#sharpen(card);
    }
    this.#stripBottom = this.#cy + (big * (this.#ch / this.#cw)) / 2;
  }

  #gridBottom = 0;
  #stripBottom = 0;

  /** The caption sits under whatever is showing: the front card, the grid, or the strip. */
  #placeCaption() {
    const caption = this.#caption;
    if (!caption) return;
    const bottom =
      this.#layout === 'grid'
        ? this.#gridBottom
        : this.#layout === 'strip'
          ? this.#stripBottom
          : this.#cy + this.#ch / 2;
    // On the deck the caption is printed across the front card's foot, as a label; under the grid and strip it sits below.
    const offset = this.#layout === 'deck' ? -18 : 10;
    const y = `translate3d(0, ${(bottom + offset).toFixed(1)}px, 0)`;
    if (caption.style.transform !== y) caption.style.transform = y;
  }
}

customElements.define('fb-deck', FbDeckElement);
