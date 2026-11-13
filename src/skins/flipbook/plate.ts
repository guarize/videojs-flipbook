import { type PropertyValues, PlayerController, playerContext, selectPlayback, selectTime, UIElement } from '@videojs/html';
import { I18nController, i18nContext } from '@videojs/html/i18n';
import { tileAt } from '@/shared/storyboard';
import { type Book, hush, loadBook, reducedMotion, videoIn } from './book';
import { frameUrls, sharpFrame } from './frames';
import { say } from './i18n';
import { scrubOf } from './stand';
import { atMost } from './renditions';
import { isStream } from './standing';

/** Twelve frames, as Muybridge's twelve cameras: four across, three down, this far apart in the film. */
const CELLS = 12;
const COLUMNS = 4;
const STEP = 1 / 6;
/** The frame you're on is the seventh: six before it and five after, as far as the film's ends allow. */
const BEFORE = 6;
/** How long the helper video gets to fetch the frames before the storyboard's own are used instead. */
const DECODE_LIMIT = 3000;
/** After a move while paused (a click on the edge, a scrub, a turn), this long before the plate lays out again. */
const RELAY = 420;
/** A frame is a target: never less than this tall (it crops to fit rather than shrink below it). */
const TARGET = 44;
/** Laid out over the picture (clear of the bar and the tabs) only while its frames get at least this tall there;
 *  on a shorter picture, a phone on its side, it takes the whole picture instead. */
const WINDOWED_MIN = 48;
/** The strip: a frame's place in the row (a 16:9 thumb and 4 px between), on a player with room and without. */
const PITCH_WIDE = 68;
const PITCH = 52;
/** The picture keeps at least this share of its height in sight over the foot, or there is no strip. */
const PICTURE_KEEPS = 0.56;
/** Fewer whole frames in sight than this and there is no strip: the Plate key alone stands on the page. */
const STRIP_MIN = 5;
/** The strip's row re-centring on a chosen frame, and how long a seek of the helper may take. */
const SLIDE = 220;
const SEEK_LIMIT = 1200;
/** How long the helper's first picture may take to come by itself, after its metadata, before it is asked to play. */
const PRIME_AFTER = 250;
/** A frame the helper shows is the sought one within this of its time (a frame and a half at 24 fps), and how long
 *  after `seeked` it is waited for. */
const FRAME_NEAR = 0.06;
const FRAME_LIMIT = 200;
/** How far past a moment the helper is sent, to come back to it from above (seconds). */
const OVER = 0.5;
/** Read from a stream that takes limits, the frames come from a rendition no taller than this. */
const HELPER_HEIGHT = 720;
/** A frame not yet read this long after the last one came has its page's storyboard still in its place meanwhile. */
const STILL_AFTER = 300;
/** Where the strip has no place: a bigger show, a window too small for it, or the caption's own page (its band is the cue's). */
const NO_STRIP = '[data-fb-intertitle], [data-fb-pip], [data-fb-dock]';

/** The part of a picture a cell is printed from (the whole of it from the corner, unless said), and whether it is a still. */
interface Crop {
  x?: number;
  y?: number;
  w: number;
  h: number;
  still?: boolean;
}

/** A cell with no picture. */
const unprint = (cell: Element) => {
  cell.removeAttribute('data-ready');
  cell.removeAttribute('data-still');
};
/** A cell that holds its own frame, not a still standing in for it. */
const exact = (cell: Element | undefined) => !!cell?.hasAttribute('data-ready') && !cell.hasAttribute('data-still');

const fraction = (seconds: number) => {
  const whole = Math.floor(seconds);
  const m = Math.floor(whole / 60);
  const s = String(whole % 60).padStart(2, '0');
  return `${m}:${s}.${Math.floor((seconds % 1) * 10)}`;
};

/**
 * The Muybridge plate, and its strip.
 *
 * Paused, the page shows the frame it was paused on, and nothing lies over it. The twelve frames around the moment
 * (six before, the one you're on, five after, a sixth of a second apart) are printed as one thin row in the page's
 * foot margin, as Muybridge printed a sequence: the strip. Each frame is a button that goes there (the page turns,
 * and the row comes round to it). The strip is one Tab stop: the arrow keys move along it, Home and End go to its
 * ends, Enter goes to the frame. It arrives with the print's margin and goes on play.
 *
 * P, or the Plate key at the head of the strip, lays the same twelve frames out large, four by three, each numbered
 * and timed: the plate. It never opens by itself. Its grid is one Tab stop too; Escape, its close key or P put it
 * away and give focus back. Under reduced motion both simply appear.
 *
 * The plate leaves as it came, backwards (plate.css: it fades and steps back towards the page's foot, 200 ms). From
 * the moment it is put away it is closed to everything that asks: `isOpen` is false, `data-open` and the player's
 * `data-fb-plate` are off, focus is back with its opener, the print and the Plate key are on the page again. Only
 * the sheet itself stays for the exit, taking no pointer and no focus. The strip, which faded out under the plate as
 * it came, fades in under it as it goes: the opening, backwards. On a small player, where the plate takes the whole
 * picture from above the bar (`data-full`), it keeps that place until it is gone, and the strip comes back then (its
 * paper foot runs under the slab, and would lie over it from up there). Opened again on its way out, the plate comes
 * back from where it is. Under reduced motion it is hidden at once.
 */
export class FbPlateElement extends UIElement {
  #time = new PlayerController(this, playerContext, selectTime);
  #playback = new PlayerController(this, playerContext, selectPlayback);
  #i18n = new I18nController(this, i18nContext);
  #abort: AbortController | null = null;
  #container: HTMLElement | null = null;
  #book: Book | null = null;
  #sheet: HTMLElement | null = null;
  #grid: HTMLElement | null = null;
  #title: HTMLElement | null = null;
  #toggle: HTMLButtonElement | null = null;
  #cells: HTMLButtonElement[] = [];
  #times: number[] = [];
  #paused = false;
  #at = -1;
  #run = 0;
  #returnFocus: HTMLElement | null = null;
  #going = false;
  /** Counts the sheet's exits and returns: an exit finishes only if nothing has opened or closed the plate since. */
  #exit = 0;
  /** The strip: its band, the row that slides in its window, its frames, and the one tip that names a frame's time. */
  #strip: HTMLElement | null = null;
  #window: HTMLElement | null = null;
  #row: HTMLElement | null = null;
  #tip: HTMLElement | null = null;
  #frames: HTMLButtonElement[] = [];
  #stripTimes: number[] = [];
  #stripCurrent = -1;
  #stripAt = -1;
  #stripRun = 0;
  #stripFor = '';
  /** One muted copy of the film, kept while the page is paused: every frame of the strip and the plate comes from it. */
  #helper: { video: HTMLVideoElement; src: string; ready: Promise<boolean>; warm?: boolean } | null = null;
  #queue: Promise<void> = Promise.resolve();
  /** The plate is wanted for this pause: it was laid out and not put away. Moving elsewhere lays it out again there. */
  #wanted = false;
  #relayTimer = 0;

  connectedCallback() {
    super.connectedCallback();
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    this.#container = this.closest('media-container');
    const container = this.#container;
    if (!container) return;

    this.innerHTML = [
      // The page's foot: the Plate key at its head, and (where the page is printed and has room) the strip of frames.
      '<div class="fb-strip">',
      '<button type="button" class="fb-plate-toggle" aria-keyshortcuts="P" aria-haspopup="dialog"><span class="fb-plate-toggle-label"></span><kbd class="fb-plate-key" aria-hidden="true">P</kbd></button>',
      // (The track holds the window's scroll range still while the row inside it travels: a row moved by a transform
      // would take its range with it, and the window would be scrolled back to its start.)
      '<div class="fb-strip-window"><div class="fb-strip-track"><div class="fb-strip-row" role="group"></div></div></div><span class="fb-strip-tip" aria-hidden="true"></span>',
      '</div>',
      '<div class="fb-plate-sheet" role="dialog" aria-modal="false" data-fb-overlay hidden>',
      '<div class="fb-plate-head"><span class="fb-plate-title"></span><button type="button" class="fb-plate-close"><span class="fb-plate-close-mark" aria-hidden="true"></span></button></div>',
      '<div class="fb-plate-grid" role="group"></div>',
      '</div>',
    ].join('');
    this.#sheet = this.querySelector('.fb-plate-sheet');
    this.#grid = this.querySelector('.fb-plate-grid');
    this.#title = this.querySelector('.fb-plate-title');
    this.#toggle = this.querySelector('.fb-plate-toggle');
    this.#cells = Array.from({ length: CELLS }, (_, i) => {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'fb-plate-cell';
      cell.tabIndex = -1;
      cell.innerHTML = `<canvas aria-hidden="true"></canvas><span class="fb-plate-number" aria-hidden="true">${i + 1}</span> <span class="fb-plate-time" aria-hidden="true"></span>`;
      cell.addEventListener('click', () => this.#go(i));
      return cell;
    });
    this.#grid?.replaceChildren(...this.#cells);
    this.#strip = this.querySelector('.fb-strip');
    this.#window = this.querySelector('.fb-strip-window');
    this.#row = this.querySelector('.fb-strip-row');
    this.#tip = this.querySelector('.fb-strip-tip');
    this.#frames = Array.from({ length: CELLS }, (_, i) => {
      const frame = document.createElement('button');
      frame.type = 'button';
      frame.className = 'fb-strip-cell';
      frame.tabIndex = -1;
      frame.innerHTML = `<span class="fb-strip-thumb"><canvas aria-hidden="true"></canvas><span class="fb-strip-number" aria-hidden="true">${i + 1}</span></span>`;
      frame.addEventListener('click', () => this.#step(i));
      frame.addEventListener('pointerenter', (event) => {
        if (event.pointerType === 'mouse') this.#name(i);
      });
      frame.addEventListener('pointerleave', () => this.#name(-1));
      frame.addEventListener('focus', () => {
        if (frame.matches(':focus-visible')) this.#name(i);
      });
      frame.addEventListener('blur', () => this.#name(-1));
      return frame;
    });
    this.#row?.replaceChildren(...this.#frames);
    this.#row?.addEventListener('keydown', (event) => this.#stripKey(event), { signal });

    this.#toggle?.addEventListener('click', () => this.toggle(true, this.#toggle), { signal });
    // Settings' "Plate" on a phone, where the key is off the picture (a menu item says `select`): the menu closes and
    // hands focus back to its key first, and the plate gives it back there when it is put away.
    const fromSheet = () => this.toggle(true, container.querySelector<HTMLElement>('#flipbook-settings-trigger'));
    container.addEventListener('select', (event) => {
      if ((event.target as Element | null)?.closest('[data-fb-menu="plate"]')) requestAnimationFrame(fromSheet);
    }, { signal });
    container.addEventListener('fb-plate-ask', fromSheet, { signal });
    this.querySelector('.fb-plate-close')?.addEventListener('click', () => this.#putAway(true), { signal });
    this.#grid?.addEventListener('keydown', (event) => this.#key(event), { signal });
    this.#sheet?.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      this.#putAway(true);
    }, { signal });
    // Escape from anywhere in the player puts an open plate away.
    container.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !this.isOpen) return;
      event.preventDefault();
      event.stopPropagation();
      this.#putAway(this.contains(document.activeElement));
    }, { signal });
    // Turning a page of the paused print (flip.ts) is reading page by page: an open plate is put away, as by its close
    // key, and P still lays it out.
    container.addEventListener('fb-leaf', () => this.#putAway(false), { signal });
    // So is anything else done to the page itself: a pull at it, the page kept (its slip), the corner unfolded (its
    // Undo). An open plate would lie over each of them.
    const page = new MutationObserver(() => {
      if (!container.matches('[data-fb-tearing], [data-fb-slip], [data-fb-ear-undo]')) return;
      this.#putAway(false);
    });
    page.observe(container, { attributes: true, attributeFilter: ['data-fb-tearing', 'data-fb-slip', 'data-fb-ear-undo'] });
    signal.addEventListener('abort', () => page.disconnect());
    // P lays the plate out (or puts it away), from anywhere in the player, except while typing.
    container.addEventListener('keydown', (event) => {
      if (event.key !== 'p' && event.key !== 'P') return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if ((event.target as Element | null)?.closest('input, textarea, [contenteditable]')) return;
      event.preventDefault();
      this.toggle(true);
    }, { signal });

    // One thing holds the picture at a time. The deck (the fore-edge's pages) borrows it: the plate stands aside while
    // the deck is up and comes back when it goes, re-laid around the new moment if you landed somewhere else. Contents,
    // the panels, the cover and page turns take it outright, and the plate is put away.
    const states = new MutationObserver(() => this.#yieldTo(container));
    states.observe(container, { attributes: true, attributeFilter: ['data-fb-deck', 'data-fb-contents', 'data-fb-sheet', 'data-fb-cover', 'data-fb-turning', 'data-fb-riffle'] });
    signal.addEventListener('abort', () => states.disconnect());
    // The strip is the print's: there while the page is printed (edge.ts's data-fb-print), and where it has a place.
    const printed = new MutationObserver(() => this.#strips());
    printed.observe(container, { attributes: true, attributeFilter: ['data-fb-print', 'data-fb-intertitle', 'data-fb-pip', 'data-fb-dock', 'data-fb-pad'] });
    signal.addEventListener('abort', () => printed.disconnect());
    queueMicrotask(async () => {
      this.#book = await loadBook(container, signal);
      this.requestUpdate();
      this.#strips();
    });
    // Turned or resized while open (a phone rotating, a window resized): laid out again for the new picture.
    let frame = 0;
    const resize = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        this.#relayout();
        this.#strips();
      });
    });
    resize.observe(container);
    signal.addEventListener('abort', () => {
      resize.disconnect();
      cancelAnimationFrame(frame);
    });
  }

  #laidFor = '';

  /** The same frames, re-laid for a new size, and drawn again (a canvas that changes size is cleared). */
  #relayout() {
    const container = this.#container;
    const video = container ? videoIn(container) : null;
    if (!this.isOpen || !container || !video) return;
    const box = container.getBoundingClientRect();
    const size = `${Math.round(box.width)}x${Math.round(box.height)}`;
    if (size === this.#laidFor) return;
    const run = ++this.#run;
    this.#layout();
    this.#fit();
    for (const cell of this.#cells) unprint(cell);
    void this.#develop(video, run);
  }

  #yieldTo(container: HTMLElement) {
    // Put away for a turn or a scrub: once that's over, laid out again where it landed.
    if (!this.isOpen) {
      if (this.#wanted) this.#relay();
      return;
    }
    if (container.matches('[data-fb-contents], [data-fb-sheet], [data-fb-cover], [data-fb-turning], [data-fb-riffle]')) {
      this.close(false);
      return;
    }
    const deck = container.hasAttribute('data-fb-deck');
    if (deck === this.hasAttribute('data-yield')) return;
    this.toggleAttribute('data-yield', deck);
    if (deck) return;
    // The deck has gone: back where it was, or laid out again around where you are now.
    const time = this.#time.value;
    if (time && Math.abs(time.currentTime - this.#at) > 0.3) {
      this.close(false);
      this.#relay();
    }
  }

  /** Lays the plate out again around where you are, once the move has settled and nothing else holds the picture. */
  #relay() {
    clearTimeout(this.#relayTimer);
    this.#relayTimer = window.setTimeout(() => {
      const playback = this.#playback.value;
      if (!this.#wanted || !playback?.paused || playback.ended || this.#busy()) return;
      if (this.isOpen && Math.abs((this.#time.value?.currentTime ?? -1) - this.#at) <= 0.3) return;
      void this.open(false);
    }, RELAY);
  }

  /** Put away by the viewer (the close key, Escape, P): it stays away for this pause. */
  #putAway(returnFocus: boolean) {
    this.#wanted = false;
    clearTimeout(this.#relayTimer);
    this.close(returnFocus);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort?.abort();
    clearTimeout(this.#relayTimer);
    this.#container?.toggleAttribute('data-fb-strip', false);
    this.#container?.toggleAttribute('data-fb-plate-leaving', false);
    this.#release();
  }

  update(changed: PropertyValues) {
    super.update(changed);
    const playback = this.#playback.value;
    const time = this.#time.value;
    this.querySelector('.fb-plate-close')?.setAttribute('aria-label', say(this.#i18n, 'flipbook.plateClose'));
    this.#letter();
    if (!playback || !time) return;
    const paused = playback.started && playback.paused && !playback.ended;
    this.toggleAttribute('data-paused', paused);
    if (!paused && this.#paused) {
      clearTimeout(this.#relayTimer);
      this.#wanted = false;
      this.close(false);
      this.#strips();
      this.#release();
    }
    this.#paused = paused;
    // Moved somewhere else while open: the plate is for the moment it was laid out from.
    // (While it stands aside for the deck, it waits for the deck to go: see #yieldTo.)
    if (paused && this.#wanted && !this.hasAttribute('data-yield') && Math.abs(time.currentTime - this.#at) > 0.3 && !this.#going) {
      this.close(false);
      this.#relay();
    } else if (this.isOpen && !paused && !this.#going) {
      this.close(false);
    }
    // The strip follows the page: a page or a frame turned, a place chosen on the edge.
    if (paused && this.#stripShown && Math.abs(time.currentTime - this.#stripAt) > 0.02 && !this.#going) this.#follow(time.currentTime);
  }

  /** The Plate key's lettering: at the head of a strip with room, the strip's own title ("Plate · 0:19.2 – 0:21.0"). */
  #letter(times = this.#stripTimes) {
    const toggle = this.#toggle;
    if (!toggle) return;
    const titled = this.getAttribute('data-strip') === 'titled' && times.length === CELLS;
    const label = titled
      ? say(this.#i18n, 'flipbook.plateTitle', { from: fraction(times[0]), to: fraction(times[CELLS - 1]) })
      : say(this.#i18n, 'flipbook.plate');
    const text = toggle.querySelector('.fb-plate-toggle-label');
    if (text && text.textContent !== label) text.textContent = label;
  }

  /** Laid out and not on its way out. */
  get isOpen() {
    return !!this.#sheet && !this.#sheet.hidden && !this.#leaving;
  }

  /** The sheet is in its exit: put away, still fading. */
  get #leaving() {
    return !!this.#sheet?.hasAttribute('data-away');
  }

  #busy() {
    const c = this.#container;
    // Not in a picture-in-picture window or the docked mini player either: too small a picture to lay a plate on.
    return !c || c.matches('[data-fb-deck], [data-fb-turning], [data-fb-riffle], [data-fb-jacket], [data-fb-contents], [data-fb-cover], [data-fb-scan], [data-fb-pip], [data-fb-dock]');
  }

  toggle(byKey: boolean, opener: HTMLElement | null = null) {
    if (this.isOpen) this.#putAway(true);
    else void this.open(byKey, opener);
  }

  /** Lays the plate out around the paused moment; with `focus`, the frame you're on takes the focus. */
  async open(focus: boolean, opener: HTMLElement | null = null) {
    const container = this.#container;
    const video = container ? videoIn(container) : null;
    const sheet = this.#sheet;
    if (!container || !video || !sheet || !this.#book || !video.duration) return;
    const playback = this.#playback.value;
    if (playback && !playback.paused) playback.pause();
    const at = video.currentTime;
    const run = ++this.#run;
    // Asked for again on its way out, for the same moment: it comes back as it is, its frames still printed.
    const back = this.#leaving && Math.abs(at - this.#at) < 0.001;
    this.#exit++;
    sheet.removeAttribute('data-away');
    container.toggleAttribute('data-fb-plate-leaving', false);
    sheet.inert = false;
    this.#at = at;
    this.#wanted = true;
    const { times, current } = this.#around(at, video.duration);
    this.#times = times;

    this.#layout();
    if (this.#title) this.#title.textContent = say(this.#i18n, 'flipbook.plateTitle', { from: fraction(this.#times[0]), to: fraction(this.#times[CELLS - 1]) });
    sheet.setAttribute('aria-label', say(this.#i18n, 'flipbook.plateLabel', { time: fraction(at) }));
    this.#cells.forEach((cell, i) => {
      cell.querySelector('.fb-plate-time')!.textContent = fraction(this.#times[i]);
      cell.setAttribute('aria-label', say(this.#i18n, 'flipbook.plateFrame', { number: i + 1, total: CELLS, time: fraction(this.#times[i]) }));
      cell.toggleAttribute('data-current', i === current);
      cell.tabIndex = i === current ? 0 : -1;
      if (!back) unprint(cell);
    });
    if (sheet.hidden) {
      // It comes from where it goes to (plate.css, `data-away`): stood there first, and seen there by the style, so
      // the way in is the sheet's own transition in every browser. (Safari runs no `@starting-style` here.)
      sheet.toggleAttribute('data-away', true);
      sheet.hidden = false;
      void getComputedStyle(sheet).opacity;
      sheet.removeAttribute('data-away');
    }
    this.#fit();
    container.toggleAttribute('data-fb-plate', true);
    this.toggleAttribute('data-open', true);
    this.#strips();
    if (focus) {
      // Back to the key that opened it (Safari does not focus a clicked button, so focus is not asked where it was),
      // or, opened by P, to wherever focus was.
      const from = document.activeElement as HTMLElement | null;
      this.#returnFocus = opener ?? (from && from !== document.body ? from : this.#toggle);
      this.#cells[current].focus();
    }
    await this.#develop(video, run);
  }

  /**
   * Puts the plate away. It is closed from here on (see the class's note); the sheet takes its exit and is hidden
   * when that has run, at once where nothing moves (reduced motion, or a sheet not in sight).
   */
  close(returnFocus: boolean) {
    const sheet = this.#sheet;
    const container = this.#container;
    if (!sheet || sheet.hidden || this.#leaving) return;
    this.#run++;
    const exit = ++this.#exit;
    const unseen = this.hasAttribute('data-yield');
    // What the exit runs as: the sheet's own transitions, read once the new style has been taken (asking for them
    // takes it). None under reduced motion.
    sheet.toggleAttribute('data-away', true);
    const running = reducedMotion.matches || unseen ? [] : sheet.getAnimations();
    this.toggleAttribute('data-open', false);
    this.toggleAttribute('data-yield', false);
    // The page's own furniture (its stamp, its keys, the strip) comes back when the plate has gone, never over it:
    // the print (edge.ts) stands down for a plate that is leaving as it does for one that is out.
    container?.toggleAttribute('data-fb-plate-leaving', running.length > 0);
    container?.toggleAttribute('data-fb-plate', false);
    this.#strips();
    // Focus goes back where it came from. A home that is not there yet (a frame of the strip, on a small player, where
    // the strip waits for the sheet) gets it when it is; the player holds it until then, so its keys stay its own.
    const home = returnFocus ? (this.#returnFocus?.isConnected ? this.#returnFocus : this.#toggle) : null;
    this.#returnFocus = null;
    home?.focus();
    const waits = !!home && document.activeElement !== home && sheet.contains(document.activeElement);
    if (waits) container?.focus({ preventScroll: true });
    // Nothing on a sheet that is leaving can be focused or read.
    sheet.inert = true;
    const gone = () => {
      if (exit !== this.#exit) return;
      sheet.hidden = true;
      sheet.inert = false;
      sheet.removeAttribute('data-away');
      container?.toggleAttribute('data-fb-plate-leaving', false);
      // (Above the bar only while the plate has the picture: left there, the strip's paper would lie over the tabs and
      // the slab once the plate had been out on a small player.)
      this.toggleAttribute('data-full', false);
      this.#strips();
      if (waits && home?.isConnected && document.activeElement === container) home.focus();
    };
    if (!running.length) gone();
    else void Promise.allSettled(running.map((animation) => animation.finished)).then(gone);
  }

  /**
   * Each cell sized so the plate fits the picture above the bar, clear of the corner curl on wide players. On a small
   * or short picture (where the frames would come out under a target's height there) it takes the whole picture,
   * over the bar, with its own close key; if even that is too short for three rows, the frames scroll.
   */
  #layout() {
    const container = this.#container;
    const grid = this.#grid;
    if (!container || !grid) return;
    const box = container.getBoundingClientRect();
    this.#laidFor = `${Math.round(box.width)}x${Math.round(box.height)}`;
    const bar = container.querySelector('.fb-bar')?.getBoundingClientRect();
    // Clear of the chapter tabs that stand above the bar (measured: named tabs stand taller), with air between.
    const tabs = [...container.querySelectorAll('.fb-tab')].map((t) => t.getBoundingClientRect()).filter((r) => r.height > 0);
    const floor = Math.min(bar?.top ?? box.bottom - 120, ...tabs.map((r) => r.top));
    // Below the top keys (they're drawn above the plate), with air between.
    const keys = [...container.querySelectorAll('.video-controls-top > .media-button')].map((k) => k.getBoundingClientRect()).filter((r) => r.height > 0);
    const ceiling = Math.max(box.top + 44, ...keys.map((r) => r.bottom)) - box.top + 6;
    const rows = CELLS / COLUMNS;
    const plan = (full: boolean) => {
      const wide = box.width >= 720;
      const small = box.width < 480;
      // The corner curl folds away while the plate is out, so the plate sits centred with even margins.
      const side = full ? 4 : wide ? 16 : 12;
      const top = full ? 4 : Math.round(ceiling);
      const bottom = full ? 4 : box.bottom - floor + 16;
      const gap = small ? 4 : 8;
      const pad = small || full ? 8 : 14;
      // The head is a target tall (its close key), from the sheet's top edge: what it adds beyond the padding, and
      // the grid's own 6 px above the frames (room for the focus ring, skin.css).
      const head = TARGET - pad + 6;
      const maxW = box.width - side * 2 - pad * 2;
      const maxH = box.height - top - bottom - pad * 2 - head;
      const cellW = Math.min((maxW - gap * (COLUMNS - 1)) / COLUMNS, ((maxH - gap * (rows - 1)) / rows) * (16 / 9));
      return { side, top, bottom, gap, pad, cellW, room: box.height - top - bottom };
    };
    let full = box.width < 480;
    let p = plan(full);
    if (!full && (p.cellW * 9) / 16 < WINDOWED_MIN) {
      full = true;
      p = plan(true);
    }
    this.toggleAttribute('data-full', full);
    this.style.setProperty('--fb-plate-top', `${p.top}px`);
    this.style.setProperty('--fb-plate-gap', `${p.gap}px`);
    this.style.setProperty('--fb-plate-pad', `${p.pad}px`);
    // The sheet never runs past its room: what doesn't fit scrolls inside it.
    this.style.setProperty('--fb-plate-room', `${Math.floor(p.room)}px`);
    this.#limit = box.top + p.top + p.room;
    this.#size(Math.max(TARGET, p.cellW));
  }

  #limit = 0;
  #cellW = 0;

  #size(cellW: number) {
    this.#cellW = cellW;
    // Too small a frame to carry its time over the picture: the number stays, the time is in its name and the head.
    this.toggleAttribute('data-compact', cellW < 128);
    this.style.setProperty('--fb-plate-cell', `${cellW.toFixed(1)}px`);
    // 16:9, but never under a target's height: a narrower frame is cropped, never squeezed.
    const cellH = Math.max(TARGET, (cellW * 9) / 16);
    this.style.setProperty('--fb-plate-cell-h', `${cellH.toFixed(1)}px`);
    const scale = Math.min(2, window.devicePixelRatio || 1);
    for (const cell of this.#cells) {
      const canvas = cell.querySelector('canvas');
      if (!canvas) continue;
      canvas.width = Math.round(cellW * scale);
      canvas.height = Math.round(cellH * scale);
    }
  }

  /**
   * Once shown, the plate measures itself: the cells' borders, labels and the heading add height the arithmetic above
   * can't know, so if the sheet reaches past its limit the cells shrink by exactly what's needed.
   */
  #fit() {
    const sheet = this.#sheet;
    const grid = this.#grid;
    if (!sheet || !grid || sheet.hidden) return;
    // The whole plate as laid out, scrolled part included.
    const r = sheet.getBoundingClientRect();
    const over = r.bottom + (grid.scrollHeight - grid.clientHeight) - this.#limit;
    if (over <= 0.5) return;
    const rows = CELLS / COLUMNS;
    // Shorter frames by what's over, keeping 16:9, down to a target's height; past that, narrowing them gains no
    // height (they crop), so they keep their width and the frames scroll.
    const height = Math.max(TARGET, (this.#cellW * 9) / 16) - over / rows;
    const width = height >= TARGET ? (height * 16) / 9 : Math.min(this.#cellW, (TARGET * 16) / 9);
    if (width < this.#cellW - 0.5) this.#size(width);
  }

  /**
   * The frames themselves, exact: a muted helper copy of the video seeks to each moment and each is drawn into its
   * cell as it arrives. If that can't be done in time, the nearest sharp storyboard frames stand in.
   */
  async #develop(video: HTMLVideoElement, run: number) {
    await this.#expose(video, this.#times, this.#times.map((_, i) => i), () => run === this.#run, (i, source, crop) => this.#print(this.#cells[i], source, crop));
  }

  /** A picture into a cell's canvas, covering it, centred; `still` marks a storyboard still standing in for the frame. */
  #print(cell: HTMLElement | undefined, source: CanvasImageSource, { x = 0, y = 0, w: sw, h: sh, still = false }: Crop) {
    const canvas = cell?.querySelector('canvas');
    const ctx = canvas?.getContext('2d');
    if (!cell || !canvas || !ctx) return;
    const shape = canvas.width / canvas.height;
    const w = sw / sh > shape ? sh * shape : sw;
    const h = sw / sh > shape ? sh : sw / shape;
    ctx.drawImage(source, x + (sw - w) / 2, y + (sh - h) / 2, w, h, 0, 0, canvas.width, canvas.height);
    cell.toggleAttribute('data-still', still);
    cell.toggleAttribute('data-ready', true);
  }

  /** The twelve moments around one: six before it and five after, a sixth of a second apart, held inside the film. */
  #around(at: number, duration: number) {
    const first = Math.max(0, Math.min(duration - STEP * (CELLS - 1), at - STEP * BEFORE));
    const times = Array.from({ length: CELLS }, (_, i) => first + i * STEP);
    const current = times.reduce((best, t, i) => (Math.abs(t - at) < Math.abs(times[best] - at) ? i : best), 0);
    return { times, current };
  }

  // ─── The frames' source ───────────────────────────────────────────────────

  /** The muted copy of the film the frames are read from, loaded once per pause. Null where there is none to read. */
  async #source(video: HTMLVideoElement): Promise<HTMLVideoElement | null> {
    // A page that gave the film a scrub copy (stand.ts: a film that plays from a stream seeks slowly, and a stream's
    // address may be one a second element cannot read at all) has its frames read from that copy.
    // Read from the stream itself, the frames are asked no taller than these small pictures need, whatever height the
    // viewer watches at (renditions.ts).
    const declared = !!this.#container?.closest('video-player')?.hasAttribute('mux-limits');
    const src = (this.#container ? scrubOf(this.#container) : '') || atMost(video.currentSrc || video.src, HELPER_HEIGHT, declared);
    if (!src || src.startsWith('blob:')) return null;
    if (this.#helper?.src !== src) {
      this.#release();
      const helper = document.createElement('video');
      helper.muted = true;
      helper.playsInline = true;
      helper.preload = 'auto';
      helper.crossOrigin = video.crossOrigin;
      helper.src = src;
      // An iPhone decodes no picture for a film that has never played (it stops at the metadata, and the strip showed
      // the storyboard's stills, one per page, so neighbours repeated): a muted play, stopped at once, brings the
      // frames. Only where the data has not come by itself a moment after the metadata; and the helper is ready only
      // once that play has been stopped, or a frame read meanwhile would be one it had played on to.
      let primed: Promise<void> = Promise.resolve();
      const ready = new Promise<boolean>((resolve) => {
        helper.addEventListener('loadeddata', () => void primed.then(() => resolve(true)), { once: true });
        helper.addEventListener('error', () => resolve(false), { once: true });
        setTimeout(() => resolve(false), DECODE_LIMIT);
      });
      helper.addEventListener('loadedmetadata', () => {
        window.setTimeout(() => {
          if (this.#helper?.video !== helper || helper.readyState >= 2) return;
          primed = helper.play().then(() => helper.pause(), () => undefined);
        }, PRIME_AFTER);
      }, { once: true });
      this.#helper = { video: helper, src, ready };
    }
    const mine = this.#helper;
    return (await mine.ready) && this.#helper === mine ? mine.video : null;
  }

  /**
   * The helper on a moment, with that moment's picture in it. `seeked` can come before the frame does (a fresh
   * helper's first seek in Safari is drawn as the frame it had; now and then elsewhere a frame late), so where the
   * browser says when a frame is shown, the one for this moment is waited for too, a moment at most.
   *
   * And where the browser says it shows another moment's frame, it is believed. Safari, reading a stream, has two
   * ways with a paused helper, settled when the helper is made. In one it names no frames and a canvas drawn from it
   * is right. In the other it names them, and after a seek forwards it names, and goes on showing, the frame of
   * where it was: the moment sought only appears with the next seek, in that seek's place (measured, 13 Nov 2026:
   * six cells of the strip's twelve were their neighbours' pictures, in four loads of ten). A seek backwards shows
   * its own frame in both. So a moment whose seek ends on another moment's frame is sought again from above: a
   * little past it, and back. Of a stream only: read from a file, Safari names every seek's own frame but a fresh
   * helper's first, which the row reads again at its end (below), and a second seek on its heels there is not shown
   * at all.
   */
  #seek(helper: HTMLVideoElement, time: number, again = false): Promise<boolean> {
    return new Promise((resolve) => {
      let sought = false;
      let shown = typeof helper.requestVideoFrameCallback !== 'function';
      let other = false;
      let over = false;
      let patience = 0;
      const limit = window.setTimeout(() => finish(false), SEEK_LIMIT);
      const finish = (ok: boolean) => {
        clearTimeout(limit);
        clearTimeout(patience);
        resolve(ok);
      };
      const settle = () => {
        if (sought && shown && !over) finish(true);
      };
      const look: VideoFrameRequestCallback = (_now, frame) => {
        if (shown || over) return;
        if (Math.abs(frame.mediaTime - time) > FRAME_NEAR) {
          other = true;
          return void helper.requestVideoFrameCallback(look);
        }
        shown = true;
        settle();
      };
      if (!shown) helper.requestVideoFrameCallback(look);
      helper.addEventListener('seeked', () => {
        sought = true;
        if (!shown) {
          patience = window.setTimeout(() => {
            const past = Math.min(time + OVER, helper.duration || time);
            if (other && !again && past > time && isStream(helper.currentSrc || helper.src)) {
              over = true;
              clearTimeout(limit);
              helper.addEventListener('seeked', () => void this.#seek(helper, time, true).then(resolve), { once: true });
              helper.currentTime = past;
              return;
            }
            // No frame said shown a moment after the seek: the helper is drawn as it is.
            shown = true;
            settle();
          }, FRAME_LIMIT);
        }
        settle();
      }, { once: true });
      helper.currentTime = time;
    });
  }

  /** The copy is let go on play: its decoder and its buffer are the film's again. */
  #release() {
    const helper = this.#helper?.video;
    this.#helper = null;
    if (!helper) return;
    helper.removeAttribute('src');
    helper.load();
  }

  /**
   * The frames themselves, exact: the helper seeks to each moment in turn (one at a time, the strip's and the plate's
   * in one line) and each is handed to `draw` as it arrives. Decoding is the helper's, off the main thread; here only
   * a small canvas is drawn.
   *
   * A cell is never left empty while its frame is on its way. Where the frames are read from the film's own stream
   * (no copy to read, stand.ts: seconds for the row), every cell has its page's storyboard still at once; elsewhere,
   * as soon as a frame is `STILL_AFTER` late (a slow file, a cold copy). Each still gives way to its frame as it
   * comes, and stays where the frame cannot be had.
   */
  #expose(video: HTMLVideoElement, times: number[], order: number[], live: () => boolean, draw: (i: number, source: CanvasImageSource, crop: Crop) => void): Promise<void> {
    const read = new Set<number>();
    let stilled = false;
    let late = 0;
    const stills = () => {
      if (stilled || !live()) return;
      stilled = true;
      void this.#stills(times, order, (i) => live() && !read.has(i), draw);
    };
    const wait = (ms: number) => {
      clearTimeout(late);
      if (!stilled) late = window.setTimeout(stills, ms);
    };
    const streamed = !(this.#container && scrubOf(this.#container)) && isStream(video.currentSrc || video.src);
    if (streamed) stills();
    else wait(STILL_AFTER);
    const job = async () => {
      if (!live()) return;
      const helper = await this.#source(video);
      if (helper) {
        const print = (i: number) => {
          read.add(i);
          draw(i, helper, { w: helper.videoWidth, h: helper.videoHeight });
          wait(STILL_AFTER);
        };
        let whole = true;
        for (const i of order) {
          if (!live()) return;
          const time = times[i];
          const ok = (Math.abs(helper.currentTime - time) < 0.001 && !helper.seeking && helper.readyState >= 2) || (await this.#seek(helper, time));
          if (!live()) return;
          if (!ok) {
            whole = false;
            break;
          }
          print(i);
        }
        // A fresh helper's first read can still be the picture it had before (Safari, on a cold load, shows the sought
        // frame later than it says): once the helper has been through the row, that first frame is read again.
        const fresh = this.#helper?.video === helper && !this.#helper.warm;
        if (this.#helper?.video === helper) this.#helper.warm = true;
        const first = order[0];
        if (whole && fresh && order.length > 1 && first != null && (await this.#seek(helper, times[first])) && live()) print(first);
        if (whole) return;
      }
      // What could not be read keeps its still.
      stills();
    };
    const done = () => clearTimeout(late);
    const next = this.#queue.then(job, job).finally(done);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /**
   * The storyboard's stills for these cells: each page's tile from the sheet at once (it is on the page already, the
   * edge and the deck are drawn from it), and the page's sharp still over it when that has loaded.
   */
  async #stills(times: number[], order: number[], wanted: (i: number) => boolean, draw: (i: number, source: CanvasImageSource, crop: Crop) => void) {
    const container = this.#container;
    const book = this.#book;
    if (!container || !book) return;
    const pages = order.map((i) => tileAt(book.tiles, times[i]));
    const sheet = await sharpFrame(book.sprite);
    order.forEach((i, n) => {
      const tile = book.tiles[pages[n]];
      if (sheet && tile && wanted(i)) draw(i, sheet, { x: tile.x, y: tile.y, w: tile.w, h: tile.h, still: true });
    });
    const urls = await frameUrls(container, book);
    await Promise.all(order.map(async (i, n) => {
      const url = urls[pages[n]];
      const image = url ? await sharpFrame(url) : null;
      if (image && wanted(i)) draw(i, image, { w: image.naturalWidth, h: image.naturalHeight, still: true });
    }));
  }

  // ─── The strip ────────────────────────────────────────────────────────────

  get #stripShown() {
    return this.hasAttribute('data-strip');
  }

  /**
   * Shows the strip where the page is printed and has a foot for it, and puts it away where not. Called whenever
   * that may have changed: the print coming or going, the plate opening or closing, the player's size.
   */
  #strips() {
    const container = this.#container;
    const video = container ? videoIn(container) : null;
    if (!container || !this.#strip) return;
    const printed = container.hasAttribute('data-fb-print');
    // The Plate key stands on the foot's line whether or not the strip does.
    const foot = printed || this.#paused ? this.#place() : false;
    // (Not under a plate, nor under one that is leaving from above the bar: the strip's paper would lie on the slab.)
    const over = this.isOpen || (this.#leaving && this.hasAttribute('data-full'));
    const want = printed && foot && !!video?.duration && !!this.#book && !over && !container.matches(NO_STRIP) && this.#fits();
    if (!want) {
      if (!this.#stripShown) {
        if (printed || this.#paused) this.#place(false);
        return;
      }
      // Focus never stays in what has gone: the player takes it, so its keys are still its own.
      const held = !!this.#window?.contains(document.activeElement);
      this.removeAttribute('data-strip');
      container.toggleAttribute('data-fb-strip', false);
      this.#stripRun++;
      this.#stripTimes = [];
      this.#name(-1);
      this.#letter();
      if (held && !this.isOpen) container.focus({ preventScroll: true });
      if (printed || this.#paused) this.#place(false);
      return;
    }
    container.toggleAttribute('data-fb-strip', true);
    const size = `${this.style.getPropertyValue('--fb-strip-pitch')}/${Math.min(2, window.devicePixelRatio || 1)}`;
    const fresh = size !== this.#stripFor || !this.#stripTimes.length;
    this.#stripFor = size;
    if (fresh) this.#thumbs();
    if (fresh || Math.abs(video.currentTime - this.#stripAt) > 0.02) this.#lay(video.currentTime, false, fresh);
    else this.#centre();
  }

  /**
   * Where the foot margin stands: across the picture, from just over whatever stands on the picture's foot (the
   * chapter tabs and the slab; nothing on a phone, whose controls are under the picture) down to its bottom edge.
   * True when the picture keeps enough of its height in sight over it (PICTURE_KEEPS).
   */
  #place(printing = true): boolean {
    const container = this.#container;
    const strip = this.#strip;
    if (!container || !strip) return false;
    const box = container.getBoundingClientRect();
    const frame = container.querySelector('.fb-print-frame')?.getBoundingClientRect();
    const picture = frame && frame.width > 0 && frame.height > 0 ? frame : box;
    let floor = picture.bottom;
    for (const part of container.querySelectorAll('.fb-bar, .fb-tab')) {
      const r = part.getBoundingClientRect();
      if (r.height > 0 && r.top < picture.bottom && r.bottom > picture.top) floor = Math.min(floor, r.top - 8);
    }
    // The Plate key alone, with nothing under it but the picture's edge (a phone too narrow for a strip), keeps its air.
    if (!printing && floor === picture.bottom) floor -= 8;
    const top = Math.round(floor - TARGET - box.top);
    const set = (name: 'left' | 'top' | 'width' | 'height', value: number) => {
      const text = `${value}px`;
      if (strip.style[name] !== text) strip.style[name] = text;
    };
    set('left', Math.round(picture.left - box.left));
    set('width', Math.round(picture.width));
    set('top', top);
    set('height', Math.max(TARGET, Math.round(picture.bottom - box.top) - top));
    return top - (picture.top - box.top) >= picture.height * PICTURE_KEEPS;
  }

  /**
   * How the row is set for the room the foot has, widest first: larger frames with the strip's title at its head, the
   * usual frames with the title, the usual frames with the key's plain name. With all twelve in sight the row stands
   * centred on the picture; with fewer it scrolls, the frame you're on in the middle. Under four, no strip.
   */
  #fits(): boolean {
    const window = this.#window;
    if (!window) return false;
    const was = this.getAttribute('data-strip');
    const pitchWas = this.style.getPropertyValue('--fb-strip-pitch');
    const tries: [string, number][] = [['titled', PITCH_WIDE], ['titled', PITCH], ['plain', PITCH]];
    // Measured with the title it will carry (the mono's digits are all one width).
    const video = this.#container ? videoIn(this.#container) : null;
    const times = this.#stripTimes.length || !video ? this.#stripTimes : this.#around(video.currentTime, video.duration).times;
    let room = 0;
    for (const [mode, pitch] of tries) {
      if (this.getAttribute('data-strip') !== mode) this.setAttribute('data-strip', mode);
      this.style.setProperty('--fb-strip-pitch', `${pitch}px`);
      this.#letter(times);
      room = window.clientWidth;
      if (room >= pitch * CELLS - 0.5) return true;
    }
    if (room >= PITCH * STRIP_MIN) return true;
    if (was) this.setAttribute('data-strip', was);
    else this.removeAttribute('data-strip');
    this.style.setProperty('--fb-strip-pitch', pitchWas);
    return false;
  }

  /** Each frame's canvas at the row's size (a canvas that changes size is cleared, so every frame is drawn again). */
  #thumbs() {
    const pitch = Number.parseFloat(this.style.getPropertyValue('--fb-strip-pitch')) || PITCH;
    const scale = Math.min(2, window.devicePixelRatio || 1);
    const width = pitch - 4;
    for (const frame of this.#frames) {
      const canvas = frame.querySelector('canvas');
      if (!canvas) continue;
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(((width * 9) / 16) * scale);
      unprint(frame);
    }
  }

  /**
   * Sets the strip around a moment. Come round by whole frames (a neighbour chosen), the pictures it already has
   * move along with it and only the new ones at the end are read; anywhere else, all twelve are. With `slide`, the
   * row travels to its new place as one thing.
   */
  #lay(at: number, slide: boolean, blank = false) {
    const container = this.#container;
    const video = container ? videoIn(container) : null;
    const row = this.#row;
    if (!container || !video || !row || !video.duration) return;
    const { times, current } = this.#around(at, video.duration);
    const old = this.#stripTimes;
    const run = ++this.#stripRun;
    const moved = old.length && !blank ? (times[0] - old[0]) / STEP : Number.NaN;
    const whole = Math.abs(moved - Math.round(moved)) < 0.01 ? Math.round(moved) : Number.NaN;
    const frames = this.#frames;
    if (Number.isFinite(whole) && Math.abs(whole) < CELLS) {
      // Each picture to its new place, taken in the order that never overwrites one still to be moved.
      const order = frames.map((_, i) => i);
      if (whole < 0) order.reverse();
      for (const i of whole ? order : []) {
        const from = frames[i + whole];
        const canvas = frames[i].querySelector('canvas');
        const ready = !!from?.hasAttribute('data-ready');
        if (ready && canvas) {
          const ctx = canvas.getContext('2d');
          ctx?.clearRect(0, 0, canvas.width, canvas.height);
          ctx?.drawImage(from.querySelector('canvas') as HTMLCanvasElement, 0, 0);
        }
        frames[i].toggleAttribute('data-ready', ready);
        frames[i].toggleAttribute('data-still', ready && !!from?.hasAttribute('data-still'));
      }
    } else if (!(Math.abs(moved) < 1)) {
      // Somewhere else altogether. (Under one frame's step, a frame key's, the pictures stay until theirs arrive.)
      for (const frame of frames) unprint(frame);
    }
    // (A still that came along is not the frame: it is read like an empty cell.)
    let stale = frames.map((frame, i) => (Number.isFinite(whole) && exact(frame) ? -1 : i)).filter((i) => i >= 0);
    // The plate, just put away, printed these very moments large: the strip comes back with them drawn, from the
    // plate's own frames, and reads none of them again.
    stale = stale.filter((i) => !this.#fromPlate(i, times[i]));
    this.#stripTimes = times;
    this.#stripCurrent = current;
    this.#stripAt = at;
    const held = frames.indexOf(document.activeElement as HTMLButtonElement);
    frames.forEach((frame, i) => {
      frame.setAttribute('aria-label', say(this.#i18n, 'flipbook.frame', { number: i + 1, total: CELLS, time: fraction(times[i]) }));
      frame.toggleAttribute('data-current', i === current);
      frame.tabIndex = i === (held >= 0 ? held : current) ? 0 : -1;
    });
    row.setAttribute('aria-label', say(this.#i18n, 'flipbook.plateLabel', { time: fraction(at) }));
    this.#letter();
    this.#name(-1);
    this.#centre();
    for (const animation of row.getAnimations()) animation.cancel();
    // (Only a move inside the row travels: from further away the strip is simply set there.)
    if (slide && whole && Math.abs(whole) < CELLS && !reducedMotion.matches) {
      const pitch = frames[0].getBoundingClientRect().width;
      const rtl = getComputedStyle(row).direction === 'rtl';
      row.animate([{ transform: `translateX(${(rtl ? -1 : 1) * whole * pitch}px)` }, { transform: 'translateX(0)' }], { duration: SLIDE, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
    }
    if (!stale.length) return;
    // From the frame you're on, outwards.
    stale.sort((a, b) => Math.abs(a - current) - Math.abs(b - current));
    void this.#expose(video, times, stale, () => run === this.#stripRun, (i, source, crop) => this.#print(frames[i], source, crop));
  }

  /** Draws a frame of the strip from the plate's frame for the same moment, if the plate has it printed. */
  #fromPlate(index: number, time: number): boolean {
    const cell = this.#cells[index];
    const frame = this.#frames[index];
    const from = cell?.querySelector('canvas');
    const canvas = frame?.querySelector('canvas');
    if (!exact(cell) || !from || !canvas || !from.width || Math.abs((this.#times[index] ?? -1) - time) > 0.001) return false;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    // Cover the strip's frame, centred, as its own pictures do.
    const shape = canvas.width / canvas.height;
    const w = from.width / from.height > shape ? from.height * shape : from.width;
    const h = from.width / from.height > shape ? from.height : from.width / shape;
    ctx.drawImage(from, (from.width - w) / 2, (from.height - h) / 2, w, h, 0, 0, canvas.width, canvas.height);
    frame.removeAttribute('data-still');
    frame.toggleAttribute('data-ready', true);
    return true;
  }

  /** With fewer than twelve in sight, the frame you're on stands in the middle of the row's window. */
  #centre() {
    const window = this.#window;
    const frame = this.#frames[this.#stripCurrent];
    if (!window || !frame) return;
    const left = frame.offsetLeft - (window.clientWidth - frame.offsetWidth) / 2;
    if (Math.abs(window.scrollLeft - left) > 0.5) window.scrollLeft = left;
  }

  /** The film moved while the strip is up (a page or a frame turned, a place chosen on the edge): the strip goes with it. */
  #follow(time: number) {
    const held = this.#frames.includes(document.activeElement as HTMLButtonElement);
    this.#lay(time, true);
    // Focus stays on the frame you're on, not on a place in the row.
    if (held) this.#frames[this.#stripCurrent]?.focus({ preventScroll: true });
  }

  /**
   * A neighbour chosen: the page turns to it (flip.ts turns the sheet and seeks; without the book's deck the film is
   * simply sought), and the strip comes round so that frame is the one you're on.
   */
  #step(index: number) {
    const container = this.#container;
    const time = this.#stripTimes[index];
    if (!container || time == null || index === this.#stripCurrent) return;
    const turn = new CustomEvent('fb-turn-to', { cancelable: true, detail: { time, direction: index > this.#stripCurrent ? 1 : -1 } });
    if (container.dispatchEvent(turn)) {
      hush(container, 400);
      void this.#time.value?.seek(time);
    }
    this.#follow(time);
  }

  /** The strip is one Tab stop: the arrows move along it, Home and End go to its ends; Enter or Space is the frame's own click. */
  #stripKey(event: KeyboardEvent) {
    const frames = this.#frames;
    const index = frames.indexOf(event.target as HTMLButtonElement);
    if (index < 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const rtl = getComputedStyle(this).direction === 'rtl';
    let next = -1;
    if (event.key === (rtl ? 'ArrowLeft' : 'ArrowRight')) next = Math.min(CELLS - 1, index + 1);
    else if (event.key === (rtl ? 'ArrowRight' : 'ArrowLeft')) next = Math.max(0, index - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = CELLS - 1;
    if (next < 0) return;
    event.preventDefault();
    event.stopPropagation();
    frames.forEach((frame, i) => {
      frame.tabIndex = i === next ? 0 : -1;
    });
    frames[next].focus();
  }

  /** A frame's number and time on the one tip, over the frame under the pointer or the keyboard's focus; -1 puts it away. */
  #name(index: number) {
    const tip = this.#tip;
    const strip = this.#strip;
    const frame = this.#frames[index];
    if (!tip || !strip) return;
    if (!frame || this.#stripTimes[index] == null) {
      tip.toggleAttribute('data-open', false);
      return;
    }
    tip.textContent = `${index + 1} · ${fraction(this.#stripTimes[index])}`;
    const box = strip.getBoundingClientRect();
    const r = frame.getBoundingClientRect();
    const half = tip.offsetWidth / 2;
    const x = Math.min(box.width - half - 4, Math.max(half + 4, r.left + r.width / 2 - box.left));
    tip.style.setProperty('--fb-strip-tip-x', `${Math.round(x)}px`);
    tip.toggleAttribute('data-open', true);
  }

  /** A frame chosen: the film goes there, and the plate closes onto it. */
  #go(index: number) {
    const time = this.#times[index];
    if (time == null || !this.#container) return;
    this.#going = true;
    hush(this.#container, 400);
    void this.#time.value?.seek(time);
    this.#at = time;
    window.setTimeout(() => {
      this.#going = false;
    }, 300);
    this.close(true);
  }

  #key(event: KeyboardEvent) {
    const index = this.#cells.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    const rtl = getComputedStyle(this).direction === 'rtl';
    let next = -1;
    if (event.key === (rtl ? 'ArrowLeft' : 'ArrowRight')) next = Math.min(CELLS - 1, index + 1);
    else if (event.key === (rtl ? 'ArrowRight' : 'ArrowLeft')) next = Math.max(0, index - 1);
    else if (event.key === 'ArrowDown') next = Math.min(CELLS - 1, index + COLUMNS);
    else if (event.key === 'ArrowUp') next = Math.max(0, index - COLUMNS);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = CELLS - 1;
    if (next < 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.#cells.forEach((cell, i) => {
      cell.tabIndex = i === next ? 0 : -1;
    });
    this.#cells[next].focus();
  }
}

customElements.define('fb-plate', FbPlateElement);
