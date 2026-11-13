import {
  type PropertyValues,
  PlayerController,
  playerContext,
  selectTime,
  UIElement,
} from '@videojs/html';
import { I18nController, i18nContext } from '@videojs/html/i18n';
import { tileAt } from '@/shared/storyboard';
import { onFontsLoaded } from '@/shared/tasks';
import { type Book, clock, hushed, hushedSince, loadBook, reducedMotion, videoIn } from './book';
import { frameUrls } from './frames';
import { say } from './i18n';
import { tapToName } from './touch';

/** Pages a thumb lifts at once: eight either side of it. */
const LIFTED = 16;
/** How far the thumb's influence reaches, in pages (a Gaussian's sigma). */
const REACH = 2.4;
/** A seek by key or button flicks this many pages over at the ribbon, in this long, a few ms apart. */
const FLICKED = 5;
const FLICK = 150;
const FLICK_STAGGER = 12;
/** Seeks the same way whose keys were pressed within this of each other add up on the chip: +5 s, +10 s. */
const GATHER = 1000;
const CHIP_HOLD = 900;
/** A seek heard this soon after a double tap is its own; any other seek has its own show. (A key's and a seek
 *  button's are known as they are taken, by no clock: `answered`.) */
const INTENT = 400;
const SEEK_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'j', 'l', 'J', 'L']);
/** Inputs inside these move the film with their own show (or none), never the chip. */
const OWN_SHOW = '.fb-tabs, fb-plate, fb-contents, fb-deck, fb-curl, input, textarea, [role="menu"], [role="listbox"]';
/** The first play from the cover riffles the first pages under the ribbon once: this long in all. */
const RIFFLE = 400;
/** Neighbouring chapter tabs stand at least a target (and a pixel, for rounding) apart: hit boxes never overlap. */
const TAB_PITCH = 45;
/** The painting's height when the edge is fanned open, in CSS px; it's drawn at this size so it stays crisp. */
const PAINT_HEIGHT = 30;
/** The first sight of the player: the edge fans once by itself, holds, and closes. */
const BREATH = 900;
/** Each page's slice of its frame is drawn from a copy this size: enough for the strip, cheap to keep. */
const SOURCE_W = 256;
const SOURCE_H = 144;

/** The bigger shows a paused print stands down for: the plate, the deck, a turn, a cover, the contents, the window. */
/** Let go, the hand's page stands on the page count this long at most, waiting for the film's clock to reach it. */
const HAND_HELD = 1500;
const SHOW_ATTRIBUTES = ['data-fb-plate', 'data-fb-plate-leaving', 'data-fb-deck', 'data-fb-turning', 'data-fb-jacket', 'data-fb-cover', 'data-fb-riffle', 'data-fb-contents', 'data-fb-pip'];
const SHOWS = SHOW_ATTRIBUTES.map((name) => `[${name}]`).join(', ');

/** Pages cropped from the storyboard per task: eight keep each task a few milliseconds. */
const CROPS_PER_TASK = 8;
/** Gives the main thread back: the rest runs in a later task. */
const breathe = () => new Promise<void>((resolve) => setTimeout(resolve));

/** Once per page load, the first time any player comes into view. */
let breathed = false;
/** Once per page load: the first play from the cover, the still turning into film. */
let riffled = false;

/**
 * The timeline as the flipbook's fore-edge: one thin page per storyboard frame, the read pages sprayed red, the rest
 * cream. A mouse on the edge thumbs it: the pages under the pointer lift and spread, as a thumb lifts a flipbook's
 * corner. It draws inside Video.js's `media-time-slider`, which keeps the semantics, the keys, and the drag.
 */
export class FbEdgeElement extends UIElement {
  #abort: AbortController | null = null;
  #slider: HTMLElement | null = null;
  #pages: HTMLElement[] = [];
  #count = 0;
  #width = 0;
  #x = -1;
  #frame = 0;
  #fill = 0;
  #time = new PlayerController(this, playerContext, selectTime);
  #i18n = new I18nController(this, i18nContext);
  #flicks: HTMLElement[] = [];
  #chip: HTMLElement | null = null;
  #last = 0;
  #total = 0;
  #direction = 0;
  #gatheredAt = 0;
  #chipTimer = 0;
  /** A seek key, skip key or double tap just taken: when, the press's own time, and where the film was. */
  #asked: { takenAt: number; pressedAt: number; from: number } | null = null;
  /** Seeks counted as their key was taken, whose `seeking` is still to be heard. */
  #counted = 0;
  #read: HTMLCanvasElement | null = null;
  #ahead: HTMLCanvasElement | null = null;
  #sources: (ImageBitmap | null)[] = [];
  #painted = 0;
  #paintTimer = 0;
  #breathTimer = 0;

  connectedCallback() {
    super.connectedCallback();
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    this.setAttribute('aria-hidden', 'true');
    this.#slider = this.closest('media-time-slider');
    const container = this.closest('media-container');
    if (!container || !this.#slider) return;

    const block = document.createElement('span');
    block.className = 'fb-edge-block';
    block.innerHTML = '<span class="fb-edge-buffer"></span><span class="fb-edge-read"></span><span class="fb-edge-gloss"></span>';
    const lift = document.createElement('span');
    lift.className = 'fb-edge-lift';
    this.#pages = Array.from({ length: LIFTED }, () => {
      const page = document.createElement('span');
      page.className = 'fb-edge-page';
      lift.append(page);
      return page;
    });
    // The pages a seek flicks over at the ribbon, and the chip that counts the seek.
    const flick = document.createElement('span');
    flick.className = 'fb-edge-flick';
    this.#flicks = Array.from({ length: FLICKED }, () => {
      const page = document.createElement('span');
      page.className = 'fb-edge-flick-page';
      flick.append(page);
      return page;
    });
    this.#chip = document.createElement('span');
    this.#chip.className = 'fb-edge-chip';
    // The fore-edge painting: the film itself, in a strip only the fanned pages show. Pages ahead are printed in
    // sepia, pages read in full colour; the gilt edge covers both at rest.
    const paint = document.createElement('span');
    paint.className = 'fb-edge-paint';
    this.#ahead = document.createElement('canvas');
    this.#ahead.className = 'fb-edge-paint-ahead';
    this.#read = document.createElement('canvas');
    this.#read.className = 'fb-edge-paint-read';
    paint.append(this.#ahead, this.#read);
    this.replaceChildren(paint, block, lift, flick, this.#chip);

    queueMicrotask(async () => {
      const book = await loadBook(container, signal);
      if (signal.aborted || !book) return;
      // On the player, so every part that prints pages (the edge, and the deck, turns and corner when they're on)
      // reads the same sprite.
      container.style.setProperty('--fb-sprite', `url("${book.sprite}")`);
      container.style.setProperty('--fb-sprite-size', `${book.cols * 100}% ${book.rows * 100}%`);
      this.#count = book.tiles.length;
      this.style.setProperty('--fb-pages', String(this.#count));
      this.toggleAttribute('data-ready', true);
      this.#measure();
      void this.#gather(container, book, signal);
      this.#watch(container, signal);
      const video = videoIn(container);
      if (!video) return;
      this.#last = video.currentTime;
      video.addEventListener('timeupdate', () => {
        if (!video.seeking) this.#last = video.currentTime;
      }, { signal });
      video.addEventListener('seeked', () => {
        // Not while a newer seek is already under way (keys pressed quickly): currentTime is that seek's target by
        // now, and taking it would make that seek read as going nowhere, its seconds dropped from the chip's count.
        if (video.seeking) return;
        this.#last = video.currentTime;
        this.#counted = 0;
      }, { signal });
      video.addEventListener('seeking', () => this.#seeking(container, video), { signal });
      video.addEventListener('play', () => this.#firstPlay(), { signal });
    });

    // Only a seek someone asked for by key, skip key or double tap counts on the chip: a click or drag on the edge, a
    // chapter, a plate frame or a typed time jumps with its own show, and a seek from script never adds to the count.
    const intend = (event: Event) => {
      const target = event.target as Element | null;
      if (target?.closest?.(OWN_SHOW)) return;
      if (event instanceof KeyboardEvent) {
        if (!SEEK_KEYS.has(event.key) || event.metaKey || event.ctrlKey || event.altKey) return;
      } else if (event instanceof PointerEvent) {
        // A double tap on the picture (its gesture regions), not a press on the slab or the edge.
        if (event.pointerType === 'mouse' || target?.closest?.('.fb-bar, media-time-slider')) return;
      } else if (!target?.closest?.('media-seek-button')) {
        return;
      }
      this.#asked = { takenAt: performance.now(), pressedAt: event.timeStamp, from: videoIn(container)?.currentTime ?? 0 };
    };
    // A key or a seek button sets the film's clock in the turn it is taken (Video.js hears it on the player or the
    // document; this hears it last, on the window). So its seek is known for the key's own here and counted at once,
    // by the press's own time: never by when the film's `seeking` is heard, which says only how busy the page is.
    // (Heard more than 400 ms after its key, a key's seek was taken for a stranger's: three quick arrows on a loaded
    // machine moved the film 15 s and the chip said nothing.) A double tap seeks a moment later: `#seeking`.
    const answered = () => {
      const asked = this.#asked;
      const video = videoIn(container);
      if (!asked || !video?.seeking || Math.abs(video.currentTime - asked.from) < 0.5) return;
      this.#asked = null;
      this.#counted++;
      // Unless the book answered this very key itself, with its own show (N cuts to the next chapter): it hushes as
      // it does. A hush from before the press was for an earlier seek of the book's, not for this key: arrows pressed
      // within 700 ms of a paused picture being put right (goto.ts) moved the film and went uncounted.
      if (!hushedSince(container, asked.pressedAt)) this.#tally(container, asked.from, video.currentTime, asked.pressedAt);
    };
    for (const type of ['keydown', 'click']) window.addEventListener(type, answered, { signal });
    container.addEventListener('keydown', intend, { capture: true, signal });
    container.addEventListener('pointerup', intend, { capture: true, passive: true, signal });
    container.addEventListener('click', intend, { capture: true, passive: true, signal });

    new ResizeObserver(() => this.#measure()).observe(this);
    const slider = this.#slider;
    slider.addEventListener('pointermove', (event) => {
      if (event.pointerType !== 'mouse' && !event.buttons) return;
      this.#x = event.clientX - this.getBoundingClientRect().left;
      this.#kick();
    }, { passive: true, signal });
    slider.addEventListener('pointerleave', () => this.#rest(), { passive: true, signal });
    slider.addEventListener('pointerup', (event) => {
      if (event.pointerType !== 'mouse') this.#rest();
    }, { passive: true, signal });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort?.abort();
    cancelAnimationFrame(this.#frame);
    clearTimeout(this.#chipTimer);
    clearTimeout(this.#paintTimer);
    clearTimeout(this.#breathTimer);
    for (const source of this.#sources) source?.close();
    this.#sources = [];
  }

  // ─── The painting ─────────────────────────────────────────────────────────

  /**
   * The pages' pictures: the storyboard's tiles at once, then each sharp frame as it decodes (a few at a time),
   * each kept only as a small copy. The strip is repainted when a batch lands, never every frame.
   */
  async #gather(container: Element, book: Book, signal: AbortSignal) {
    const count = book.tiles.length;
    this.#sources = Array.from({ length: count }, () => null);
    const small = (image: CanvasImageSource, sx = 0, sy = 0, sw?: number, sh?: number) =>
      sw && sh
        ? createImageBitmap(image as ImageBitmapSource, sx, sy, sw, sh, { resizeWidth: SOURCE_W, resizeHeight: SOURCE_H, resizeQuality: 'medium' })
        : createImageBitmap(image as ImageBitmapSource, { resizeWidth: SOURCE_W, resizeHeight: SOURCE_H, resizeQuality: 'medium' });

    try {
      const sprite = new Image();
      sprite.crossOrigin = 'anonymous';
      sprite.src = book.sprite;
      await sprite.decode();
      // Decoded once, to a bitmap, and every page cropped from that: a crop asked of the <img> itself decodes the
      // whole sprite again each time, and fifty-two of them in one tick held the main thread for about 300 ms just
      // after the player mounted. A few crops per task, the thread given back between them.
      const whole = await createImageBitmap(sprite);
      try {
        for (let from = 0; from < count && !signal.aborted; from += CROPS_PER_TASK) {
          await Promise.all(book.tiles.slice(from, from + CROPS_PER_TASK).map(async (tile, j) => {
            this.#sources[from + j] = await small(whole, tile.x, tile.y, tile.w, tile.h);
          }));
          await breathe();
        }
      } finally {
        whole.close();
      }
      if (signal.aborted) return;
      this.#paint();
    } catch {
      // No storyboard image: the edge stays gilt.
    }

    // The sharp frames wait until they're first wanted: the storyboard's tiles stand in until then, and the page
    // loads, settles and becomes interactive without fifty-odd frames on the wire.
    await this.#firstNeed(container, signal);
    if (signal.aborted) return;
    const urls = await frameUrls(container, book);
    let next = 0;
    const worker = async () => {
      while (next < count && !signal.aborted) {
        const i = next++;
        const url = urls[i];
        if (!url) continue;
        try {
          const image = new Image();
          image.crossOrigin = 'anonymous';
          image.src = url;
          await image.decode();
          const bitmap = await small(image);
          this.#sources[i]?.close();
          this.#sources[i] = bitmap;
          this.#schedulePaint();
        } catch {
          // This page keeps its storyboard tile.
        }
        await breathe();
      }
    };
    // One frame at a time, the thread given back after each: three decoding at once stacked into one long block.
    await worker();
  }

  /**
   * When the fore-edge's sharp frames are first wanted: the first hover, press or focus on the edge, the first riffle
   * or deck, or an idle moment once the film has started playing. Whichever comes first.
   */
  #firstNeed(container: Element, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const local = new AbortController();
      const done = () => {
        local.abort();
        resolve();
      };
      signal.addEventListener('abort', done, { once: true });
      const options = { once: true, passive: true, signal: local.signal };
      const slider = this.#slider;
      for (const type of ['pointerenter', 'pointerdown', 'focusin']) slider?.addEventListener(type, done, options);
      const busy = () => container.hasAttribute('data-fb-riffle') || container.hasAttribute('data-fb-deck');
      const watch = new MutationObserver(() => busy() && done());
      watch.observe(container, { attributes: true, attributeFilter: ['data-fb-riffle', 'data-fb-deck'] });
      local.signal.addEventListener('abort', () => watch.disconnect());
      const video = videoIn(container);
      video?.addEventListener('playing', () => {
        if (local.signal.aborted) return;
        if ('requestIdleCallback' in window) requestIdleCallback(done, { timeout: 4000 });
        else setTimeout(done, 1500);
      }, options);
      if (busy()) done();
    });
  }

  #schedulePaint() {
    clearTimeout(this.#paintTimer);
    this.#paintTimer = window.setTimeout(() => this.#paint(), 120);
  }

  /**
   * Draws the strip once: each page shows its own frame's slice at that page's place along the film, so the whole
   * edge reads as one long picture of the film, sky over ground, scene after scene. Then a sepia copy for the pages
   * still ahead.
   */
  #paint() {
    const read = this.#read;
    const ahead = this.#ahead;
    const count = this.#sources.length;
    const width = this.offsetWidth;
    if (!read || !ahead || !count || width < 20) return;
    const scale = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(width * scale);
    const h = Math.round(PAINT_HEIGHT * scale);
    for (const canvas of [read, ahead]) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = read.getContext('2d');
    const sepia = ahead.getContext('2d');
    if (!ctx || !sepia) return;
    ctx.imageSmoothingQuality = 'high';
    for (let i = 0; i < count; i++) {
      const source = this.#sources[i];
      if (!source) continue;
      const x0 = Math.round((i / count) * w);
      const x1 = Math.round(((i + 1) / count) * w);
      // The slice of this frame that sits at this page's place in the picture, a little wider for continuity.
      const centre = ((i + 0.5) / count) * SOURCE_W;
      const sliceW = Math.max(6, (SOURCE_W / count) * 2.2);
      const sx = Math.max(0, Math.min(SOURCE_W - sliceW, centre - sliceW / 2));
      ctx.drawImage(source, sx, 0, sliceW, SOURCE_H, x0, 0, x1 - x0, h);
    }
    // The page edges: a hairline between pages, and light along the top as on a fanned edge.
    ctx.fillStyle = 'rgba(20, 14, 6, 0.32)';
    for (let i = 1; i < count; i++) ctx.fillRect(Math.round((i / count) * w), 0, Math.max(1, Math.round(scale / 2)), h);
    const light = ctx.createLinearGradient(0, 0, 0, h);
    light.addColorStop(0, 'rgba(255, 250, 235, 0.28)');
    light.addColorStop(0.3, 'rgba(255, 250, 235, 0)');
    light.addColorStop(0.75, 'rgba(0, 0, 0, 0)');
    light.addColorStop(1, 'rgba(20, 12, 4, 0.35)');
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, w, h);

    // Pages ahead: the same picture, drained to sepia and lightened, as unread paper.
    sepia.drawImage(read, 0, 0);
    sepia.globalCompositeOperation = 'saturation';
    sepia.fillStyle = 'rgb(128, 128, 128)';
    sepia.fillRect(0, 0, w, h);
    sepia.globalCompositeOperation = 'multiply';
    sepia.fillStyle = 'rgb(226, 206, 168)';
    sepia.fillRect(0, 0, w, h);
    sepia.globalCompositeOperation = 'screen';
    sepia.fillStyle = 'rgba(120, 100, 70, 0.45)';
    sepia.fillRect(0, 0, w, h);
    sepia.globalCompositeOperation = 'source-over';
    this.#painted = width;
    this.toggleAttribute('data-painted', true);
  }

  /** The first time the player comes into view, the edge fans by itself, once, so it's clear it holds the film. */
  #watch(container: Element, signal: AbortSignal) {
    if (breathed || reducedMotion.matches) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting) || breathed) return;
      observer.disconnect();
      breathed = true;
      const wait = () => {
        if (!this.hasAttribute('data-painted')) {
          this.#breathTimer = window.setTimeout(wait, 120);
          return;
        }
        this.toggleAttribute('data-fanned', true);
        this.#breathTimer = window.setTimeout(() => this.toggleAttribute('data-fanned', false), BREATH);
      };
      // After the cover has painted and settled: the edge is the one thing that moves.
      this.#breathTimer = window.setTimeout(wait, 650);
    }, { threshold: 0.6 });
    observer.observe(container);
    signal.addEventListener('abort', () => observer.disconnect());
    const stop = () => {
      clearTimeout(this.#breathTimer);
      this.toggleAttribute('data-fanned', false);
    };
    container.addEventListener('pointerdown', stop, { capture: true, once: true, signal });
    container.addEventListener('keydown', stop, { capture: true, once: true, signal });
  }

  /**
   * A seek by key, button or double tap: a few pages flick over at the ribbon in the seek's direction, a thumb's
   * quick flick, and a chip over the ribbon counts it. Nothing crosses the picture. Scrubs, riffles and chapter turns
   * have their own show and are left alone.
   */
  #seeking(container: Element, video: HTMLVideoElement) {
    const from = this.#last;
    const to = video.currentTime;
    // Where this seek lands is where the next one starts, whether or not this one has finished by then.
    this.#last = to;
    // A key's own seek, counted when the key was taken.
    if (this.#counted > 0) return void this.#counted--;
    const asked = this.#asked;
    this.#asked = null;
    if (!asked || performance.now() - asked.takenAt > INTENT) {
      // Someone else's seek: it starts no count, and the next key starts afresh from where it landed.
      this.#direction = 0;
      return;
    }
    if (!hushed(container)) this.#tally(container, from, to, asked.pressedAt);
  }

  /** One seek of a key's, a seek button's or a double tap's, pressed at `pressed`: on the chip, and at the ribbon. */
  #tally(container: Element, from: number, to: number, pressed: number) {
    if (
      container.hasAttribute('data-fb-deck') ||
      container.hasAttribute('data-fb-riffle') ||
      container.hasAttribute('data-fb-turning') ||
      Math.abs(to - from) < 0.5
    ) {
      return;
    }
    const direction = to > from ? 1 : -1;
    // (The presses add up by their own times, not by when each seek was heard.)
    if (direction === this.#direction && pressed - this.#gatheredAt < GATHER) this.#total += to - from;
    else this.#total = to - from;
    this.#direction = direction;
    this.#gatheredAt = pressed;

    const chip = this.#chip;
    if (chip) {
      const seconds = Math.round(Math.abs(this.#total));
      chip.toggleAttribute('data-rate', false);
      chip.textContent = say(this.#i18n, this.#total >= 0 ? 'flipbook.forward' : 'flipbook.backward', { seconds });
      // Over the ribbon, held inside the edge by its own width (skin.css).
      chip.style.setProperty('--fb-chip-w', `${chip.offsetWidth}px`);
      chip.toggleAttribute('data-open', true);
      clearTimeout(this.#chipTimer);
      this.#chipTimer = window.setTimeout(() => chip.toggleAttribute('data-open', false), CHIP_HOLD);
    }
    if (reducedMotion.matches) return;
    // Each page lifts off the stack on one side of the ribbon, arcs over it, and lands on the other.
    const arc = direction * 9;
    this.#flicks.forEach((page, i) => {
      page.animate(
        [
          { transform: `translate3d(${-arc}px, 0, 0) rotate(${-direction * 8}deg)`, opacity: 0 },
          { transform: `translate3d(0, -11px, 0) rotate(0deg)`, opacity: 1, offset: 0.5 },
          { transform: `translate3d(${arc}px, 0, 0) rotate(${direction * 8}deg)`, opacity: 0 },
        ],
        { duration: FLICK, delay: i * FLICK_STAGGER, easing: 'cubic-bezier(0.3, 0, 0.2, 1)', fill: 'backwards' },
      );
    });
  }

  /**
   * Play turns the still into motion: the first play from the cover riffles the first pages of the edge under the
   * ribbon, once, as the film starts (about 400 ms), the same pages a seek flicks. Once per page load, never on a
   * later play (a first play that resumes mid-film uses it up), and not at all under reduced motion.
   */
  #firstPlay() {
    if (riffled) return;
    riffled = true;
    // Where the film stood before this play, not where it is now: the play event can land half a second into the
    // film on a busy main thread (the cover's turn is being set up), and the riffle would be skipped.
    if (this.#last > 0.5 || reducedMotion.matches) return;
    const pages = this.#flicks;
    const stagger = 35;
    const duration = RIFFLE - stagger * (pages.length - 1);
    pages.forEach((page, i) => {
      page.animate(
        [
          { transform: 'translate3d(-2px, 0, 0) rotate(-10deg)', opacity: 0 },
          { transform: 'translate3d(4px, -12px, 0) rotate(0deg)', opacity: 1, offset: 0.45 },
          { transform: 'translate3d(12px, 0, 0) rotate(10deg)', opacity: 0 },
        ],
        { duration, delay: i * stagger, easing: 'cubic-bezier(0.3, 0, 0.2, 1)', fill: 'backwards' },
      );
    });
  }

  update(changed: PropertyValues) {
    super.update(changed);
    const time = this.#time.value;
    if (!time?.duration) return;
    const fill = time.currentTime / time.duration;
    if (Math.abs(fill - this.#fill) > 0.0005) {
      this.#fill = fill;
      if (this.#x >= 0) this.#kick();
    }
  }

  #measure() {
    this.#width = this.offsetWidth;
    // Repainted only when the width has really changed, so the strip stays crisp at every size.
    if (this.#sources.some(Boolean) && Math.abs(this.#width - this.#painted) > 4) this.#schedulePaint();
  }

  #kick() {
    if (this.#frame) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      this.#render();
    });
  }

  /**
   * For flip.ts (the hand on the edge): the chip over the ribbon carries the hand's speed while it drives the film
   * ("3.2×"), in the chip's own place and type, and folds away as it does after a seek. `null` lets it go.
   */
  readout(text: string | null) {
    const chip = this.#chip;
    if (!chip) return;
    clearTimeout(this.#chipTimer);
    if (text == null) {
      // It keeps its width while it fades; the next seek count takes the chip back (#seeking).
      chip.toggleAttribute('data-open', false);
      return;
    }
    if (chip.textContent !== text) chip.textContent = text;
    if (!chip.hasAttribute('data-rate')) {
      // A fixed width (flip.css): measured once, never again as the digits change.
      chip.toggleAttribute('data-rate', true);
      chip.style.setProperty('--fb-chip-w', `${chip.offsetWidth}px`);
    }
    chip.toggleAttribute('data-open', true);
    // The next seek by key starts its own count.
    this.#direction = 0;
  }

  /**
   * For flip.ts: the pages lift at a place along the edge (0–1 of its length) when no pointer is there to lift them,
   * a riffle by key, by wheel or after a flick. `null` lets them settle.
   */
  thumb(share: number | null) {
    if (share == null) {
      this.#rest();
      return;
    }
    this.#x = Math.min(1, Math.max(0, share)) * this.#width;
    this.#kick();
  }

  /** The thumb leaves: the pages settle back into the block. */
  #rest() {
    this.#x = -1;
    this.toggleAttribute('data-thumbing', false);
    for (const page of this.#pages) page.style.opacity = '0';
  }

  #render() {
    if (!this.#count || !this.#width || this.#x < 0) return;
    const still = reducedMotion.matches;
    const pitch = this.#width / this.#count;
    const at = this.#x / pitch;
    const first = Math.round(at) - LIFTED / 2;
    const read = this.#fill * this.#count;
    const height = this.clientHeight || 18;
    this.toggleAttribute('data-thumbing', true);
    this.style.setProperty('--fb-pitch', `${pitch.toFixed(3)}px`);

    for (let j = 0; j < LIFTED; j++) {
      const page = this.#pages[j];
      const i = first + j;
      if (i < 0 || i >= this.#count) {
        page.style.opacity = '0';
        continue;
      }
      const d = i + 0.5 - at;
      const weight = Math.exp(-(d * d) / (2 * REACH * REACH));
      if (weight < 0.04) {
        page.style.opacity = '0';
        continue;
      }
      // Lifted and spread apart around the thumb, each page tipping away from it; flat under reduced motion.
      const lift = still ? 0 : weight * height * 0.95;
      const spread = still ? 0 : Math.sign(d) * Math.min(Math.abs(d), 3) * pitch * 0.18 * weight;
      const tip = still ? 0 : Math.max(-14, Math.min(14, -d * 4 * weight));
      page.style.transform = `translate3d(${(i * pitch + spread).toFixed(2)}px, ${(-lift).toFixed(2)}px, 0) rotate(${tip.toFixed(2)}deg)`;
      page.style.opacity = Math.min(1, weight * 1.6).toFixed(3);
      page.toggleAttribute('data-read', i < read);
    }
  }
}

/**
 * Chapters as thumb-index tabs standing up from the fore-edge, as a dictionary's are. One Tab stop: the arrow keys
 * move between tabs, Enter or Space opens that chapter.
 *
 * A tab prints its chapter's whole name beside its number where the name fits before the next tab, and its number
 * alone where it does not: never part of a name. Either way it names its chapter on a slip on hover and focus (and,
 * for a finger, on a first tap), and always in its accessible name.
 *
 * Where each tab stands is the layout's own arithmetic (#place writes it once, as a CSS length), so the tabs are in
 * place in the first layout the player ever gets, however a page mounts it: hidden and shown later, with no box, or
 * resized. Only what is printed on them is measured here, in the same frame the room changes.
 */
export class FbTabsElement extends UIElement {
  #time = new PlayerController(this, playerContext, selectTime);
  #i18n = new I18nController(this, i18nContext);
  #abort: AbortController | null = null;
  #book: Book | null = null;
  #tabs: HTMLButtonElement[] = [];
  #duration = 0;
  #current = -1;
  #resize: ResizeObserver | null = null;
  #lefts: string[] = [];

  connectedCallback() {
    super.connectedCallback();
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    this.setAttribute('role', 'group');
    const container = this.closest('media-container');
    if (!container) return;
    queueMicrotask(async () => {
      this.#book = await loadBook(container, signal);
      if (signal.aborted) return;
      this.#build();
    });
    // What is printed on each tab depends on its room and on the type's own width: again whenever the fore-edge
    // changes width, a name does (respaced by the page, say: see #build's rule), or the page's fonts load.
    this.#resize = new ResizeObserver(() => this.#name());
    signal.addEventListener('abort', () => this.#resize?.disconnect());
    onFontsLoaded(() => this.#name(), signal);
    this.addEventListener('keydown', (event) => this.#key(event), { signal });
    container.addEventListener('fb-chapter-settle', (event) => {
      const { index, title } = (event as CustomEvent<{ index: number; title: string }>).detail;
      const voice = this.querySelector<HTMLElement>('.fb-tabs-voice');
      if (voice) voice.textContent = say(this.#i18n, 'flipbook.chapter', { number: index + 1, title });
      const tab = this.#tabs[index];
      if (!tab) return;
      tab.toggleAttribute('data-lit', true);
      window.setTimeout(() => tab.toggleAttribute('data-lit', false), 700);
    }, { signal });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort?.abort();
  }

  update(changed: PropertyValues) {
    super.update(changed);
    this.setAttribute('aria-label', say(this.#i18n, 'flipbook.chapters'));
    const time = this.#time.value;
    if (!time) return;
    if (time.duration && time.duration !== this.#duration) {
      this.#duration = time.duration;
      if (this.#place()) this.#name();
    }
    const chapters = this.#book?.chapters ?? [];
    const current = chapters.findIndex((c) => time.currentTime >= c.startTime && time.currentTime < c.endTime);
    if (current !== this.#current) {
      this.#current = current;
      this.#tabs.forEach((tab, i) => tab.toggleAttribute('data-current', i === current));
      // The roving stop follows the chapter that's playing, unless a tab already has focus.
      if (!this.contains(document.activeElement)) this.#rove(Math.max(0, current));
    }
  }

  #build() {
    const chapters = this.#book?.chapters ?? [];
    this.#tabs = chapters.map((chapter, i) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'fb-tab';
      tab.tabIndex = -1;
      tab.style.setProperty('--i', String(i));
      // (A space before the name, so the two read as words; the face's gap ignores it.)
      tab.innerHTML = `<span class="fb-tab-face" aria-hidden="true">${i + 1} <span class="fb-tab-short" hidden></span></span><span class="fb-tab-name" aria-hidden="true"></span>`;
      for (const part of tab.querySelectorAll<HTMLElement>('.fb-tab-short, .fb-tab-name')) part.textContent = chapter.text;
      // Named as it's printed, then what it is and where it starts: "3 The Herd, chapter, 0:36" (WCAG 2.5.3, the
      // visible "3 The Herd" or "3" starts the name).
      tab.setAttribute('aria-label', say(this.#i18n, 'flipbook.chapterTab', { number: i + 1, title: chapter.text, time: clock(chapter.startTime) }));
      // A tab opens its chapter as a page turn (or a cut, without the book's turns), forward or back from where you
      // are. On a touch screen the first tap shows the chapter's name on the tab's slip, and the second goes.
      tapToName(tab, () => {
        this.dispatchEvent(new CustomEvent('fb-turn', { bubbles: true, detail: { time: chapter.startTime } }));
        this.#rove(i);
      }, this.#abort?.signal);
      return tab;
    });
    // A polite voice for the detents: the chapter the ribbon settled in.
    const voice = document.createElement('span');
    voice.className = 'fb-sr-only fb-tabs-voice';
    voice.setAttribute('role', 'status');
    // Every name once more, set in the tabs' own type but never shown: a rule to watch for the type changing width.
    // (The tabs themselves can't be watched for it: lettering them changes their size.)
    const rule = document.createElement('span');
    rule.className = 'fb-tabs-rule';
    rule.setAttribute('aria-hidden', 'true');
    rule.append(
      ...chapters.map((chapter) => {
        const name = document.createElement('span');
        name.className = 'fb-tab-short';
        name.textContent = chapter.text;
        return name;
      }),
    );
    this.replaceChildren(...this.#tabs, voice, rule);
    this.#rove(Math.max(0, this.#current));
    this.#lefts = [];
    this.#place();
    // Lettered tabs are laid out as their faces need (labels.css).
    this.toggleAttribute('data-fb-named', true);
    this.#resize?.disconnect();
    for (const part of [this, ...rule.children]) this.#resize?.observe(part);
    this.#name();
    this.toggleAttribute('data-ready', this.#tabs.length > 0);
  }

  /**
   * Each tab at its chapter's start. Until the film's length is known, the last chapter's end stands in for it (the
   * chapters run to the end), so the tabs are where they belong from the first frame and don't jump when it arrives.
   *
   * Chapters closer than a target are nudged apart, at most by what's missing, so no two hit boxes overlap. That
   * depends on the edge's width, and it is the layout that works it out: a tab stands at its chapter's share of the
   * edge or a pitch past the tab before it, whichever is further (so: the furthest of every earlier tab's share
   * plus the pitches between), and never nearer the edge's end than the tabs after it need. Written as one CSS
   * length, it holds at any width with nothing measured here, so there is no frame in which it is not yet true.
   * (A term for every earlier tab: thirty chapters are four hundred and sixty-five terms, written once.)
   */
  #place(): boolean {
    const chapters = this.#book?.chapters ?? [];
    const length = this.#duration || (chapters.at(-1)?.endTime ?? 0);
    if (!length || !chapters.length) return false;
    const shares = chapters.map((c) => `${(Math.max(0, Math.min(1, c.startTime / length)) * 100).toFixed(3)}%`);
    // The pitch: a target and a pixel, or an even share of an edge too short for that many (six tabs on 264 px).
    const pitch = `min(${TAB_PITCH}px, ${(100 / chapters.length).toFixed(3)}%)`;
    let moved = false;
    this.#tabs.forEach((tab, i) => {
      const reach = shares.slice(0, i + 1).map((share, j) => (j === i ? share : `${share} + ${i - j} * ${pitch}`));
      const left = `max(0px, min(max(${reach.join(', ')}), 100% - ${chapters.length - i} * ${pitch}))`;
      if (this.#lefts[i] === left) return;
      this.#lefts[i] = left;
      tab.style.left = left;
      moved = true;
    });
    return moved;
  }

  /**
   * What each tab prints: its whole name where the tab, so lettered, ends before the next one begins (the last, before
   * the edge does), else its number alone; and numbers alone on every tab where only a few names would fit (on a
   * phone's pad, where not all of them would). Every name is set first and the tabs measured as laid out, so the answer
   * is the layout's own, in whatever face, size and spacing the page gives the type; then the names that don't fit
   * are taken off again, all before anything is painted.
   *
   * Also which way a tab's slip hangs: past the middle of the edge, back from the face's right end (skin.css), so
   * the last chapters' names stay inside the player.
   */
  #name() {
    const tabs = this.#tabs;
    if (!tabs.length || !this.offsetWidth) return;
    const names = tabs.map((tab) => tab.querySelector<HTMLElement>('.fb-tab-short'));
    for (const name of names) if (name?.hidden) name.hidden = false;
    // (Boxes are only held against each other, so a player drawn at a scale, docked, answers the same.)
    const boxes = tabs.map((tab) => tab.getBoundingClientRect());
    const edge = this.getBoundingClientRect();
    const fits = tabs.map((_, i) => boxes[i].right <= (boxes[i + 1]?.left ?? edge.right) + 0.01);
    // On a phone's pad the tabs are a row of keys under the picture, and the running foot beside them names the
    // chapter: one name among five numbers reads as a mistake there. All of them, or none.
    const together = !!this.closest('media-container')?.hasAttribute('data-fb-pad');
    const all = fits.every(Boolean);
    // Elsewhere the names that fit are printed, where most of them do: one name or two among numbers read as a
    // mistake too, and then every tab prints its number.
    const most = fits.filter(Boolean).length > tabs.length / 2;
    tabs.forEach((tab, i) => {
      const whole = together ? all : most && fits[i];
      const name = names[i];
      if (name && name.hidden === whole) name.hidden = !whole;
      // (The slip would only repeat a name printed whole, and a first tap has nothing to show: labels.css, touch.ts.)
      if (tab.hasAttribute('data-fb-full') !== whole) tab.toggleAttribute('data-fb-full', whole);
      const past = boxes[i].left - edge.left > edge.width / 2;
      if (tab.hasAttribute('data-fb-end') !== past) tab.toggleAttribute('data-fb-end', past);
    });
  }

  #rove(index: number) {
    this.#tabs.forEach((tab, i) => {
      tab.tabIndex = i === index ? 0 : -1;
    });
  }

  #key(event: KeyboardEvent) {
    const index = this.#tabs.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    const last = this.#tabs.length - 1;
    const rtl = getComputedStyle(this).direction === 'rtl';
    let next = -1;
    if (event.key === (rtl ? 'ArrowLeft' : 'ArrowRight') || event.key === 'ArrowDown') next = index === last ? 0 : index + 1;
    else if (event.key === (rtl ? 'ArrowRight' : 'ArrowLeft') || event.key === 'ArrowUp') next = index === 0 ? last : index - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    if (next < 0) return;
    // These keys belong to the tabs here, not to the player's shortcuts.
    event.preventDefault();
    event.stopPropagation();
    this.#rove(next);
    this.#tabs[next].focus();
  }
}

/**
 * The page counter: "p. 35 / 52", the storyboard page the playhead is on, set beside the time. It also prints the
 * stamp a paused film carries on its print ("p. 35", skin.css, "Pause freezes a photograph").
 */
export class FbFolioElement extends UIElement {
  #time = new PlayerController(this, playerContext, selectTime);
  #i18n = new I18nController(this, i18nContext);
  #book: Book | null = null;
  #abort: AbortController | null = null;
  #stamp: HTMLElement | null = null;
  /** Where a hand has the film (flip.ts), while it has it and until the film's own clock is on that page. */
  #hand: number | null = null;
  #held = false;
  #letting = 0;

  connectedCallback() {
    super.connectedCallback();
    this.#abort?.abort();
    this.#abort = new AbortController();
    this.setAttribute('aria-hidden', 'true');
    const container = this.closest('media-container');
    if (!container) return;
    const { signal } = this.#abort;
    // A hand flipping the film is ahead of the film's clock (the film is told a few times a second, and a stream
    // lands later still), and what the hand reads over the edge, "p. 34", is where the hand is. The page count reads
    // the same moment: the hand's while it has the film, then the film's once the film is there (or has had a moment).
    container.addEventListener('fb-hand', (event) => {
      const time = (event as CustomEvent<{ time?: number | null }>).detail?.time;
      clearTimeout(this.#letting);
      this.#held = typeof time === 'number';
      if (typeof time === 'number') this.#hand = time;
      else if (this.#hand != null) this.#letting = window.setTimeout(() => this.#let(), HAND_HELD);
      this.requestUpdate();
    }, { signal });
    signal.addEventListener('abort', () => clearTimeout(this.#letting));
    let stamp = container.querySelector<HTMLElement>(':scope > .fb-stamp');
    if (!stamp) {
      stamp = document.createElement('span');
      stamp.className = 'fb-stamp';
      stamp.setAttribute('aria-hidden', 'true');
      container.append(stamp);
    }
    this.#stamp = stamp;
    // The print a paused film carries (skin.css, "Pause freezes a photograph"): on a pause mid-film, while no bigger
    // show is up. Set here, as the core's own data-fb-print, so the core's styles never name the extras' states.
    const shows = new MutationObserver(() => this.#print(container));
    shows.observe(container, { attributes: true, attributeFilter: SHOW_ATTRIBUTES });
    signal.addEventListener('abort', () => {
      shows.disconnect();
      container.toggleAttribute('data-fb-print', false);
    });
    // The play key is in the same template; it's there once this tick's parsing is done.
    queueMicrotask(() => {
      const play = container.querySelector<HTMLElement>('.fb-play');
      if (!play || signal.aborted) return;
      shows.observe(play, { attributes: true, attributeFilter: ['data-started', 'data-paused', 'data-ended'] });
      this.#print(container);
    });
    queueMicrotask(async () => {
      this.#book = await loadBook(container, signal);
      if (!signal.aborted) this.requestUpdate();
    });
    // The count is printed whole or not at all: the row squeezes it last, and what it has no room for is not shown
    // in part (skin.css).
    const fit = new ResizeObserver(() => this.#fit());
    fit.observe(this);
    signal.addEventListener('abort', () => fit.disconnect());
    // On a narrow slab the time beside this counter shows the elapsed clock alone (skin.css clips it to this many
    // characters), so the fore-edge keeps its width. Its length changes at 10:00 and 1:00:00.
    const display = container.querySelector<HTMLElement>('.fb-time-display');
    if (display) {
      const measure = () => {
        const elapsed = (display.textContent ?? '').split('/')[0].trim().length || 4;
        if (container.style.getPropertyValue('--fb-elapsed-ch') !== String(elapsed)) container.style.setProperty('--fb-elapsed-ch', String(elapsed));
      };
      const watch = new MutationObserver(measure);
      watch.observe(display, { childList: true, characterData: true, subtree: true });
      signal.addEventListener('abort', () => watch.disconnect());
      measure();
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort?.abort();
  }

  /** Marks a count the row has no room to print whole. */
  #fit() {
    const cut = this.scrollWidth > this.clientWidth + 0.5;
    if (this.hasAttribute('data-fb-cut') !== cut) this.toggleAttribute('data-fb-cut', cut);
  }

  #print(container: HTMLElement) {
    // Whether it is paused is the film's own word: the play key learns of a play a moment after it was asked, and a
    // film a hand has just let go of (flip.ts) is already playing when the hand's mark comes off the player.
    const video = videoIn(container);
    const paused = !!container.querySelector('.fb-play[data-started][data-paused]:not([data-ended])') && (video?.paused ?? true);
    const on = paused && !container.matches(SHOWS);
    if (container.hasAttribute('data-fb-print') !== on) container.toggleAttribute('data-fb-print', on);
  }

  /** The hand's moment is let go of: the count reads the film's clock again. */
  #let() {
    this.#hand = null;
    this.requestUpdate();
  }

  update(changed: PropertyValues) {
    super.update(changed);
    const book = this.#book;
    const time = this.#time.value;
    if (!book || !time) return;
    // (Let go, the hand's page stands until the film's clock is on it too: never back a page and on again.)
    if (this.#hand != null && !this.#held && tileAt(book.tiles, time.currentTime) === tileAt(book.tiles, this.#hand)) {
      clearTimeout(this.#letting);
      this.#hand = null;
    }
    const at = this.#hand ?? time.currentTime;
    const page = tileAt(book.tiles, at) + 1;
    const text = say(this.#i18n, 'flipbook.page', { page, total: book.tiles.length });
    if (this.textContent !== text) {
      this.textContent = text;
      this.#fit();
    }
    // The running foot of a phone's pad (phone.css) sets the chapter beside the page.
    const chapter = book.chapters.find((c) => at >= c.startTime && at < c.endTime)?.text ?? '';
    if (this.getAttribute('data-fb-chapter') !== chapter) this.setAttribute('data-fb-chapter', chapter);
    const stamp = this.#stamp;
    const short = say(this.#i18n, 'flipbook.pageShort', { page });
    if (stamp && stamp.textContent !== short) stamp.textContent = short;
  }
}

customElements.define('fb-edge', FbEdgeElement);
customElements.define('fb-tabs', FbTabsElement);
customElements.define('fb-folio', FbFolioElement);
