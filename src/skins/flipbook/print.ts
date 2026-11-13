import { reducedMotion } from './book';

/**
 * Pausing prints. A paused film is a printed page: the picture steps in a little inside its own box and a paper
 * margin shows around it, with the folio and the chapter printed up the margin's side as a frame number is on a
 * contact sheet. Turning a page (flip.ts: ← and →, or a swipe) lifts the page that was showing and turns it over,
 * quick and light, with the next one already under it. On play the margin goes and the page is film again.
 *
 * The margin, as a rule (tests/e2e/flip.spec.ts measures it): 2.4 % of the picture's width, never under 10 px or over
 * 28 px, a whole, even number of pixels (so the type set in it sits on whole pixels); the picture is scaled by
 * `1 - 2 × margin / width`, so its sides stand exactly one margin in. Nothing outside the player moves: it is a transform on the picture and an overlay on top of it.
 */

/** The margin's share of the picture's width, and its limits in px. */
const SHARE = 0.024;
const MIN = 10;
const MAX = 28;
/** From this much margin the folio and chapter are printed in it; with less they stay on the stamp's own chip. */
const TEXT_FROM = 20;
/** The picture's transform origin down its box (skin.css sets `50% 46%` on the video). */
const ORIGIN_Y = 0.46;
/** A page turning over: inside the 150–250 ms band, and short enough that a second press never waits for it. */
const TURN = 220;
/** Pages in the air at once: a third press while two are still turning reuses the oldest. */
const SHEETS = 3;

export function printMargin(pictureWidth: number): number {
  return 2 * Math.round(Math.min(MAX, Math.max(MIN, pictureWidth * SHARE)) / 2);
}

interface Fit {
  /** The player's box. */
  w: number;
  h: number;
  /** The picture inside it, fitted as `object-fit: contain`. */
  x: number;
  y: number;
  pw: number;
  ph: number;
}

export class Print {
  #container: HTMLElement;
  #video: () => HTMLVideoElement | null;
  #frame: HTMLElement;
  #sheets: HTMLCanvasElement[] = [];
  #next = 0;
  #fit: Fit | null = null;
  #resize: ResizeObserver;

  constructor(host: HTMLElement, container: HTMLElement, video: () => HTMLVideoElement | null) {
    this.#container = container;
    this.#video = video;
    this.#frame = document.createElement('span');
    this.#frame.className = 'fb-print-frame';
    host.append(this.#frame);
    for (let i = 0; i < SHEETS; i++) {
      const sheet = document.createElement('canvas');
      sheet.className = 'fb-print-sheet';
      host.append(sheet);
      this.#sheets.push(sheet);
    }
    this.#resize = new ResizeObserver(() => this.measure());
    this.#resize.observe(container);
  }

  /** The margin for the player's size and the film's shape: read on resize and when the film's size is known. */
  measure() {
    const container = this.#container;
    const video = this.#video();
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;
    const ratio = video?.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : w / h;
    const pw = w / h > ratio ? h * ratio : w;
    const ph = pw / ratio;
    const x = (w - pw) / 2;
    const y = (h - ph) / 2;
    this.#fit = { w, h, x, y, pw, ph };
    const margin = printMargin(pw);
    const scale = 1 - (2 * margin) / pw;
    // Where the picture stands once it has stepped in (scaled about the video's origin).
    const left = w / 2 + (x - w / 2) * scale;
    const top = h * ORIGIN_Y + (y - h * ORIGIN_Y) * scale;
    // The paper: the picture's own box, with a border that reaches the stepped-in picture on each side (rounded up to
    // a whole pixel, so the print's edge is a crisp line and never a gap).
    const box = { left: Math.round(x), top: Math.round(y), width: Math.round(pw), height: Math.round(ph) };
    const frame = this.#frame.style;
    frame.left = `${box.left}px`;
    frame.top = `${box.top}px`;
    frame.width = `${box.width}px`;
    frame.height = `${box.height}px`;
    frame.borderLeftWidth = `${Math.ceil(left - box.left)}px`;
    frame.borderRightWidth = `${Math.ceil(box.left + box.width - (left + pw * scale))}px`;
    frame.borderTopWidth = `${Math.ceil(top - box.top)}px`;
    frame.borderBottomWidth = `${Math.ceil(box.top + box.height - (top + ph * scale))}px`;
    const set = (name: string, value: string) => {
      if (container.style.getPropertyValue(name) !== value) container.style.setProperty(name, value);
    };
    set('--fb-print-scale', scale.toFixed(5));
    set('--fb-print-margin', `${margin}px`);
    set('--fb-print-left', `${box.left}px`);
    set('--fb-print-top', `${box.top}px`);
    const room = margin >= TEXT_FROM ? 'wide' : 'thin';
    if (container.getAttribute('data-fb-print-margin') !== room) container.setAttribute('data-fb-print-margin', room);
  }

  /** The chapter printed after the folio in the margin ("p. 19 · One Gallop"); the folio itself is the core's stamp. */
  chapter(title: string) {
    const stamp = this.#container.querySelector<HTMLElement>(':scope > .fb-stamp');
    if (stamp && stamp.getAttribute('data-fb-chapter') !== title) stamp.setAttribute('data-fb-chapter', title);
  }

  /**
   * The page that is showing lifts and turns over, forwards (hinged on the left, as a page turned on) or back (hinged
   * on the right). Call it before the seek: it copies the picture as it stands, and the film's next page arrives
   * underneath. Each turn is its own sheet, so a second press starts its page at once while the first finishes.
   * Nothing under reduced motion: the page simply changes.
   */
  turn(direction: 1 | -1) {
    const fit = this.#fit;
    const video = this.#video();
    if (reducedMotion.matches || !fit || !video || !video.videoWidth) return;
    const sheet = this.#sheets[this.#next];
    this.#next = (this.#next + 1) % SHEETS;
    for (const animation of sheet.getAnimations()) animation.cancel();
    // Where the picture is right now, whatever its transform is doing: the video's box, less its letterbox.
    const box = video.getBoundingClientRect();
    const frame = this.#container.getBoundingClientRect();
    const scale = box.width / fit.w;
    const width = fit.pw * scale;
    const height = fit.ph * scale;
    sheet.style.left = `${(box.left - frame.left + fit.x * scale).toFixed(2)}px`;
    sheet.style.top = `${(box.top - frame.top + fit.y * scale).toFixed(2)}px`;
    sheet.style.width = `${width.toFixed(2)}px`;
    sheet.style.height = `${height.toFixed(2)}px`;
    const pixels = Math.min(1280, Math.round(width * Math.min(2, window.devicePixelRatio || 1)));
    sheet.width = pixels;
    sheet.height = Math.round((pixels * height) / width);
    try {
      sheet.getContext('2d')?.drawImage(video, 0, 0, sheet.width, sheet.height);
    } catch {
      return;
    }
    sheet.style.transformOrigin = direction > 0 ? '0 50%' : '100% 50%';
    const away = direction > 0 ? -62 : 62;
    sheet.animate(
      [
        { transform: 'perspective(1400px) rotateY(0deg)', opacity: 1 },
        { transform: `perspective(1400px) rotateY(${away * 0.7}deg)`, opacity: 0.85, offset: 0.6 },
        { transform: `perspective(1400px) rotateY(${away}deg)`, opacity: 0 },
      ],
      { duration: TURN, easing: 'cubic-bezier(0.3, 0, 0.2, 1)' },
    );
  }

  destroy() {
    this.#resize.disconnect();
    for (const sheet of this.#sheets) for (const animation of sheet.getAnimations()) animation.cancel();
    const container = this.#container;
    for (const name of ['--fb-print-scale', '--fb-print-margin', '--fb-print-left', '--fb-print-top']) container.style.removeProperty(name);
    container.removeAttribute('data-fb-print-margin');
    container.querySelector(':scope > .fb-stamp')?.removeAttribute('data-fb-chapter');
  }
}
