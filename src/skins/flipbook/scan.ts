import { UIElement } from '@videojs/html';
import { hush, reducedMotion, videoIn } from './book';
import { openingOf } from './jacket';

/** Frames interlaced into the cover, and how far apart in the film (s): a moment of the first shot. */
const FRAMES = 4;
const STEP = 0.4;
/** The slit, in CSS px: each frame owns every fourth slit; the barrier shows one in four. */
const SLIT = 3;
/** Opening by itself (on play), the barrier crosses the picture in this long. */
const SWEEP = 1300;
/** Let go past this much of the way, and it opens the rest by itself; less, and it closes again. */
const COMMIT = 0.35;

/** Once per page load. */
let opened = false;

/**
 * The scanimation cover, after Rufus Butler Seder's barrier-grid books: the cover's picture is printed interlaced
 * from a few frames of the film's first moment, and opening the cover slides a striped barrier across it, so the
 * picture comes alive under the stripes, moving as the barrier moves. Drag across the picture to open it with your
 * own hand (it follows you exactly), or press play and it opens by itself. Then the video takes over at frame 0.
 *
 * Only with `?opening=scan` (or `data-fb-opening="scan"`). Under reduced motion the cover simply gives way to the
 * film.
 */
export class FbScanElement extends UIElement {
  #abort: AbortController | null = null;
  #container: HTMLElement | null = null;
  #canvas: HTMLCanvasElement | null = null;
  #barrier: HTMLElement | null = null;
  #window: HTMLElement | null = null;
  #ready = false;
  #progress = 0;
  #frame = 0;

  connectedCallback() {
    super.connectedCallback();
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    this.setAttribute('aria-hidden', 'true');
    this.#container = this.closest('media-container');
    const container = this.#container;
    if (!container) return;
    // The print is seen only where the barrier covers it: a window that slides with the barrier (two opposing
    // transforms, so the sweep never repaints).
    this.innerHTML = '<div class="fb-scan-window"><canvas class="fb-scan-print"></canvas></div><div class="fb-scan-barrier"></div>';
    this.#canvas = this.querySelector('canvas');
    this.#window = this.querySelector('.fb-scan-window');
    this.#barrier = this.querySelector('.fb-scan-barrier');

    queueMicrotask(() => {
      if (openingOf(container) !== 'scan' || opened || reducedMotion.matches) return;
      const video = videoIn(container);
      if (!video) return;
      void this.#print(video, signal);
      // Pressing play opens the cover by itself.
      video.addEventListener('play', () => {
        if (opened || !this.#ready || video.currentTime > 0.1) return;
        video.pause();
        this.#sweep(this.#progress, 1, SWEEP * (1 - this.#progress));
      }, { signal });
      // Dragging across the picture opens it by hand.
      container.addEventListener('pointerdown', (event) => this.#drag(event), { capture: true, signal });
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort?.abort();
    cancelAnimationFrame(this.#frame);
  }

  /**
   * Prints the interlaced cover: a muted helper copy of the video fetches each frame, and each is drawn only into
   * its own slits, on whole device pixels so the stripes stay clean.
   */
  async #print(video: HTMLVideoElement, signal: AbortSignal) {
    const canvas = this.#canvas;
    const container = this.#container;
    if (!canvas || !container) return;
    if (document.readyState !== 'complete') {
      await new Promise((resolve) => window.addEventListener('load', resolve, { once: true, signal }));
    }
    const box = container.getBoundingClientRect();
    const scale = Math.max(1, Math.round(window.devicePixelRatio || 1));
    canvas.width = Math.round(box.width * scale);
    canvas.height = Math.round(box.height * scale);
    this.style.setProperty('--fb-slit', `${SLIT}px`);
    this.style.setProperty('--fb-period', `${SLIT * FRAMES}px`);
    const ctx = canvas.getContext('2d');
    const src = video.currentSrc || video.src;
    if (!ctx || !src) return;

    const helper = document.createElement('video');
    helper.muted = true;
    helper.preload = 'auto';
    helper.crossOrigin = video.crossOrigin;
    helper.src = src;
    const loaded = await new Promise<boolean>((resolve) => {
      helper.addEventListener('loadeddata', () => resolve(true), { once: true });
      helper.addEventListener('error', () => resolve(false), { once: true });
      setTimeout(() => resolve(false), 4000);
    });
    if (!loaded || signal.aborted) return;
    const slit = SLIT * scale;
    const ratio = helper.videoWidth / helper.videoHeight;
    const fitW = canvas.width / canvas.height > ratio ? canvas.height * ratio : canvas.width;
    const fitH = fitW / ratio;
    const x0 = (canvas.width - fitW) / 2;
    const y0 = (canvas.height - fitH) / 2;
    for (let k = 0; k < FRAMES; k++) {
      const ok = await new Promise<boolean>((resolve) => {
        helper.addEventListener('seeked', () => resolve(true), { once: true });
        setTimeout(() => resolve(false), 1500);
        helper.currentTime = k * STEP;
      });
      if (!ok || signal.aborted) return;
      ctx.save();
      ctx.beginPath();
      for (let x = k * slit; x < canvas.width; x += slit * FRAMES) ctx.rect(x, 0, slit, canvas.height);
      ctx.clip();
      ctx.drawImage(helper, x0, y0, fitW, fitH);
      ctx.restore();
    }
    helper.removeAttribute('src');
    helper.load();
    this.#ready = true;
    this.toggleAttribute('data-ready', true);
  }

  /**
   * Places the barrier: it has slid in from the right across `progress` of the picture. The printed picture shows
   * only where the barrier covers it, and the barrier's position (on whole pixels) picks which frame shows.
   */
  #place(progress: number) {
    const barrier = this.#barrier;
    const canvas = this.#canvas;
    const container = this.#container;
    if (!barrier || !canvas || !container) return;
    this.#progress = progress;
    const width = container.getBoundingClientRect().width;
    const left = Math.round(width * (1 - progress));
    barrier.style.transform = `translate3d(${left}px, 0, 0)`;
    if (this.#window) this.#window.style.transform = `translate3d(${left}px, 0, 0)`;
    canvas.style.transform = `translate3d(${-left}px, 0, 0)`;
  }

  #open() {
    const container = this.#container;
    if (!container || opened) return false;
    container.toggleAttribute('data-fb-scan', true);
    this.toggleAttribute('data-active', true);
    return true;
  }

  /** Opening by hand: the barrier follows the pointer exactly, from wherever it's pressed. */
  #drag(event: PointerEvent) {
    const container = this.#container;
    if (!container || opened || !this.#ready || !container.hasAttribute('data-fb-jacket') || event.button !== 0) return;
    if ((event.target as Element | null)?.closest('.fb-bar, .video-controls-top, .media-popup, button, [data-fb-overlay]')) return;
    // The poster is an image: without this the browser would start dragging the picture itself.
    event.preventDefault();
    const startX = event.clientX;
    const width = container.getBoundingClientRect().width;
    const from = this.#progress;
    let moved = false;
    const move = (e: PointerEvent) => {
      const progress = Math.max(0, Math.min(1, from + (startX - e.clientX) / (width * 0.9)));
      if (!moved && Math.abs(e.clientX - startX) < 6) return;
      if (!moved) {
        moved = true;
        container.setPointerCapture(e.pointerId);
        this.#open();
      }
      e.preventDefault();
      this.#place(progress);
    };
    const up = () => {
      container.removeEventListener('pointermove', move);
      container.removeEventListener('pointerup', up);
      container.removeEventListener('pointercancel', up);
      if (!moved) return;
      if (this.#progress >= COMMIT) this.#sweep(this.#progress, 1, 420);
      else this.#sweep(this.#progress, 0, 240);
    };
    container.addEventListener('pointermove', move);
    container.addEventListener('pointerup', up);
    container.addEventListener('pointercancel', up);
  }

  /** The barrier carries on by itself, from one place to another; fully across, the film takes over. */
  #sweep(from: number, to: number, duration: number) {
    if (!this.#open() && !this.hasAttribute('data-active')) return;
    cancelAnimationFrame(this.#frame);
    const start = performance.now();
    const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / Math.max(1, duration));
      this.#place(from + (to - from) * ease(t));
      if (t < 1) {
        this.#frame = requestAnimationFrame(tick);
        return;
      }
      if (to >= 1) this.#handOff();
      else this.#close();
    };
    this.#frame = requestAnimationFrame(tick);
  }

  /** The cover is open: the video plays from frame 0, and the print fades into it. */
  #handOff() {
    const container = this.#container;
    if (!container) return;
    opened = true;
    const video = videoIn(container);
    hush(container, 1500);
    if (video) {
      video.currentTime = 0;
      void video.play();
    }
    this.toggleAttribute('data-leaving', true);
    window.setTimeout(() => this.#close(), 320);
  }

  #close() {
    this.toggleAttribute('data-active', false);
    this.toggleAttribute('data-leaving', false);
    this.#container?.toggleAttribute('data-fb-scan', false);
    if (!opened) this.#place(0);
  }
}

customElements.define('fb-scan', FbScanElement);
