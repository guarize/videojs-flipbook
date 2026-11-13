import { UIElement } from '@videojs/html';
import { hush, reducedMotion } from './book';
import { isOn } from './features';
import { openingOf } from './jacket';
import { canCurl, PAGE, Paper, pose, turnCurve } from './paper';

/** The cover turning over: one page, a little slower than a chapter turn, because it opens the book. */
const TURN = 760;

/** Once per page load, however many players or remounts. */
let opened = false;

/**
 * The opening, on first play: the cover turns over like the first page of a book, and the film is already playing
 * underneath it. The page is the cover exactly as it was showing (the poster, the printed frame and the title plate,
 * copied from the screen), curling away corner-first in real paper (WebGL) and casting its shadow on the picture as
 * it goes. Nothing waits: the film starts on the click, and the turn plays over it. Any input lands it at once.
 * Under reduced motion, without WebGL, or with the scanimation opening, the cover simply goes.
 */
export class FbRiffleElement extends UIElement {
  #abort: AbortController | null = null;
  #paper: Paper | null = null;
  #frame = 0;
  /** The cover as it was on screen, copied by the input that starts the film. */
  #cover: HTMLCanvasElement | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    this.setAttribute('aria-hidden', 'true');
    const container = this.closest<HTMLElement>('media-container');
    if (!container || opened || reducedMotion.matches || !canCurl() || !isOn(container, 'turns')) return;
    // The cover is copied the moment play is pressed, before the jacket steps aside: capture comes first.
    container.addEventListener('pointerdown', () => this.#prepare(container), { capture: true, signal });
    container.addEventListener('keydown', () => this.#prepare(container), { capture: true, signal });
    // The turn starts the moment the cover steps aside (play pressed, or the film moved off its start), in the same
    // frame, so there's no instant with neither the cover nor the page on screen.
    const watch = new MutationObserver(() => {
      if (!container.hasAttribute('data-fb-jacket') && this.#cover) this.#open(container);
    });
    watch.observe(container, { attributes: true, attributeFilter: ['data-fb-jacket'] });
    signal.addEventListener('abort', () => watch.disconnect());
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort?.abort();
    this.#finish();
  }

  /** Copies the cover while it's still on screen: the input that starts the film hides it in the same moment. */
  #prepare(container: HTMLElement) {
    if (opened || !container.hasAttribute('data-fb-jacket')) return;
    this.#cover = copyCover(container);
  }

  #open(container: HTMLElement) {
    const cover = this.#cover;
    this.#cover = null;
    if (opened || !cover || reducedMotion.matches || openingOf(container) !== 'riffle') return;
    opened = true;
    const paper = Paper.create(this);
    const page = paper?.texture(cover);
    if (!paper || !page) {
      paper?.dispose();
      return;
    }
    this.#paper = paper;
    hush(container, TURN + 200);
    container.toggleAttribute('data-fb-riffle', true);
    this.toggleAttribute('data-active', true);
    // Drawn flat at once, so the cover is still there in the frame the jacket leaves, and the shaders are paid for
    // before the turn's clock starts.
    paper.draw('shadow', [pose(page, 0, 1, PAGE)]);

    const land = () => this.#finish();
    for (const type of ['pointerdown', 'keydown', 'wheel']) {
      container.addEventListener(type, land, { capture: true, once: true, passive: true });
    }
    let start = -1;
    const tick = (now: number) => {
      if (this.#paper !== paper) return;
      if (start < 0) start = now;
      const t = Math.min(1, (now - start) / TURN);
      paper.draw('shadow', [pose(page, turnCurve(t), 1, PAGE)]);
      if (t < 1) this.#frame = requestAnimationFrame(tick);
      else this.#finish();
    };
    this.#frame = requestAnimationFrame(tick);
  }

  #finish() {
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    this.#paper?.dispose();
    this.#paper = null;
    this.toggleAttribute('data-active', false);
    this.closest('media-container')?.toggleAttribute('data-fb-riffle', false);
  }
}

/**
 * The cover as a picture: the poster, the jacket's vignette, its printed frame and its title plate, drawn from where
 * they are on screen with their own colours and type, so the page that turns is the page you were looking at.
 */
function copyCover(container: HTMLElement): HTMLCanvasElement | null {
  const box = container.getBoundingClientRect();
  const poster = container.querySelector<HTMLImageElement>('.media-poster-image');
  if (!box.width || !poster?.complete || !poster.naturalWidth) return null;
  const scale = Math.min(2, window.devicePixelRatio || 1);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(box.width * scale);
  canvas.height = Math.round(box.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(scale, scale);
  const at = (r: DOMRect) => ({ x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height });

  ctx.fillStyle = getComputedStyle(container).backgroundColor || '#0d0b09';
  ctx.fillRect(0, 0, box.width, box.height);
  // The poster, covering the picture as it does on screen.
  const p = at(poster.getBoundingClientRect());
  const ratio = poster.naturalWidth / poster.naturalHeight;
  const w = p.w / p.h > ratio ? p.w : p.h * ratio;
  const h = w / ratio;
  ctx.save();
  ctx.beginPath();
  ctx.rect(p.x, p.y, p.w, p.h);
  ctx.clip();
  ctx.drawImage(poster, p.x + (p.w - w) / 2, p.y + (p.h - h) / 2, w, h);
  ctx.restore();

  const jacket = container.querySelector<HTMLElement>('fb-jacket');
  if (!jacket) return canvas;
  // The vignette (fb-jacket::before): a soft darkening toward the edges.
  ctx.save();
  ctx.translate(box.width / 2, box.height * 0.38);
  ctx.scale(1.3, 1.1 * (box.height / box.width));
  const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, box.width * 0.5);
  glow.addColorStop(0.48 * 1.3, 'rgba(13, 11, 9, 0)');
  glow.addColorStop(1, 'rgba(13, 11, 9, 0.5)');
  ctx.fillStyle = glow;
  ctx.fillRect(-box.width, -box.height, box.width * 2, box.height * 4);
  ctx.restore();

  const frame = jacket.querySelector<HTMLElement>('.fb-jacket-frame');
  if (frame && frame.getClientRects().length) {
    const f = at(frame.getBoundingClientRect());
    const style = getComputedStyle(frame);
    ctx.lineWidth = Number.parseFloat(style.borderTopWidth) || 1.5;
    ctx.strokeStyle = style.borderTopColor;
    ctx.beginPath();
    ctx.roundRect(f.x + ctx.lineWidth / 2, f.y + ctx.lineWidth / 2, f.w - ctx.lineWidth, f.h - ctx.lineWidth, Number.parseFloat(style.borderTopLeftRadius) || 8);
    ctx.stroke();
  }

  const plate = jacket.querySelector<HTMLElement>('.fb-jacket-plate');
  if (plate && plate.getClientRects().length && getComputedStyle(plate).visibility !== 'hidden') {
    const r = at(plate.getBoundingClientRect());
    const style = getComputedStyle(plate);
    const radius = Number.parseFloat(style.borderTopLeftRadius) || 4;
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = 28;
    ctx.shadowOffsetY = 12;
    ctx.fillStyle = style.backgroundColor;
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.w, r.h, radius);
    ctx.fill();
    ctx.restore();
    // The double rule, 5 px in.
    ctx.strokeStyle = 'rgba(20, 17, 14, 0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(r.x + 5.5, r.y + 5.5, r.w - 11, r.h - 11, Math.max(0, radius - 2));
    ctx.stroke();
    for (const rule of plate.querySelectorAll<HTMLElement>('.fb-jacket-rule')) {
      if (!rule.getClientRects().length) continue;
      const q = at(rule.getBoundingClientRect());
      ctx.fillStyle = getComputedStyle(rule).backgroundColor;
      ctx.fillRect(q.x, q.y, q.w, q.h);
    }
    for (const text of plate.querySelectorAll<HTMLElement>('.fb-jacket-title, .fb-jacket-meta')) words(ctx, text, box);
  }
  return canvas;
}

/** Draws an element's text word by word, each at the place the browser laid it out. */
function words(ctx: CanvasRenderingContext2D, el: HTMLElement, box: DOMRect) {
  const node = el.firstChild;
  if (!(node instanceof Text) || !node.data.trim()) return;
  const style = getComputedStyle(el);
  ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  ctx.fillStyle = style.color;
  ctx.textBaseline = 'alphabetic';
  if ('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = style.letterSpacing === 'normal' ? '0px' : style.letterSpacing;
  const metrics = ctx.measureText('Hg');
  const ascent = metrics.fontBoundingBoxAscent;
  const descent = metrics.fontBoundingBoxDescent;
  const range = document.createRange();
  const pattern = /\S+/g;
  for (let match = pattern.exec(node.data); match; match = pattern.exec(node.data)) {
    range.setStart(node, match.index);
    range.setEnd(node, match.index + match[0].length);
    const r = range.getBoundingClientRect();
    if (!r.width) continue;
    const y = r.top - box.top + (r.height - (ascent + descent)) / 2 + ascent;
    ctx.fillText(match[0], r.left - box.left, y);
  }
}

customElements.define('fb-riffle', FbRiffleElement);
