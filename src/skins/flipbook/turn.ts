import { UIElement } from '@videojs/html';
import { I18nController, i18nContext } from '@videojs/html/i18n';
import { type Book, clock, hush, loadBook, pageFrom, videoIn } from './book';
import { sharpAt } from './frames';
import type { TurnRequest } from './goto';
import { say } from './i18n';
import { voiceFor } from './pages';
import { canCurl, fromTop, PAGE, Paper, pose, turnCurve } from './paper';

/** A chapter turn: long enough to read as a page going over, short enough not to wait on. */
const TURN = 620;
/** By key the same turn is quicker: it was asked for at once, and may be asked for again. */
const TURN_KEY = 480;
/** A page going over the playing film at a chapter's opening: a scene's beat, not a control's. */
const LEAF = 460;
/** How long to wait for the sharp destination frame before turning onto the storyboard's own. */
const WAIT_SHARP = 180;

const sprites = new Map<string, Promise<HTMLImageElement | null>>();
function spriteImage(src: string) {
  let pending = sprites.get(src);
  if (!pending) {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.src = src;
    pending = image.decode().then(() => image, () => null);
    sprites.set(src, pending);
  }
  return pending;
}

/**
 * Chapter jumps as a real page turn. The picture you're on is captured from the video and curls away, bent around a
 * moving cylinder, its paper back showing as it goes; under it lies the first frame of the chapter you're going to,
 * sharp, shaded by the curl. When the video has that frame, the paper gives way to it.
 *
 * Anything can ask for a turn: dispatch a bubbling `fb-turn` event with `{ time, direction? }` from inside the player
 * (the corner curl, the chapter tabs, and the Contents and bookmarks do). goto.ts answers it, and calls `turnTo` here
 * while the book's turns are on. Under reduced motion, or without WebGL, it simply goes there.
 *
 * Wherever it came from, the turn is said once, politely, when it lands: "Chapter 3: The Herd, 0:36" (WCAG 4.1.3). This
 * is the only place a turn is announced; a turn cut short by another says nothing. The player's status announcer would
 * also say "Seeked to 17 seconds" for the same move, so it is kept quiet (aria-live off) from the turn's start until
 * just after it lands.
 */
export class FbTurnElement extends UIElement {
  #i18n = new I18nController(this, i18nContext);
  #abort: AbortController | null = null;
  #container: HTMLElement | null = null;
  #book: Book | null = null;
  #paper: Paper | null = null;
  #frame = 0;
  #run = 0;
  #timer = 0;
  #quietTimer = 0;

  connectedCallback() {
    super.connectedCallback();
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    this.setAttribute('aria-hidden', 'true');
    this.replaceChildren();
    this.#container = this.closest('media-container');
    const container = this.#container;
    if (!container) return;
    queueMicrotask(async () => {
      this.#book = await loadBook(container, signal);
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort?.abort();
    this.#end();
    clearTimeout(this.#quietTimer);
    this.#announcer()?.removeAttribute('aria-live');
  }

  /** Turns the page to a time. A turn already running is cut short; the new one starts from what's on screen. */
  async turnTo(time: number, direction?: 1 | -1, options: Omit<TurnRequest, 'time' | 'direction'> = {}): Promise<void> {
    const container = this.#container;
    const video = container ? videoIn(container) : null;
    const book = this.#book;
    if (!container || !video) return;
    const to = Math.max(0, Math.min(time, video.duration || time));
    const dir = direction ?? (to >= video.currentTime ? 1 : -1);
    hush(container, 1400);
    this.#end();
    const run = ++this.#run;
    clearTimeout(this.#quietTimer);
    this.#announcer()?.setAttribute('aria-live', 'off');
    // Should the turn never land (the source changes under it), the announcer still speaks again.
    this.#quietTimer = window.setTimeout(() => this.#announcer()?.removeAttribute('aria-live'), 3000);
    if (!canCurl() || !book || !video.videoWidth) {
      video.currentTime = to;
      this.#announce(run, video, to);
      return;
    }
    const paper = Paper.create(this);
    if (!paper) {
      video.currentTime = to;
      this.#announce(run, video, to);
      return;
    }
    this.#paper = paper;
    // The page you're on, exactly as it's showing, before the seek replaces it.
    const front = paper.texture(video);
    // The first page of where you're going: a chapter's own first frame, not the end of the one before.
    const page = pageFrom(book, to);
    const sharp = await Promise.race([sharpAt(container, book, to, page), new Promise<null>((resolve) => setTimeout(() => resolve(null), WAIT_SHARP))]);
    if (run !== this.#run) return;
    const under = sharp ? paper.texture(sharp) : await this.#tile(paper, book, page);
    if (run !== this.#run) return;
    video.currentTime = to;
    if (!front) {
      this.#end();
      this.#announce(run, video, to);
      return;
    }

    this.toggleAttribute('data-turning', true);
    container.toggleAttribute('data-fb-turning', true);
    const shape = options.corner === 'top' ? fromTop(PAGE) : PAGE;
    // A corner already pulled by hand: the turn picks up where the fold is, and takes only the time left.
    const from = options.reach ? paper.progressForReach(options.reach, shape) : 0;
    const length = (options.quick ? TURN_KEY : TURN) * (1 - 0.6 * from);
    // The first frame drawn compiles the shaders and uploads the pictures: do it now, with the page still flat, so
    // that cost lands before the turn's clock starts rather than as a jump in the middle of it.
    paper.draw(under, [pose(front, from, dir, shape)]);
    let start = performance.now();
    let began = false;
    let last = start;
    let gaps = 0;
    let worstGap = 0;
    const tick = (now: number) => {
      if (run !== this.#run) return;
      if (!began) {
        began = true;
        start = now;
        last = now;
      }
      const gap = now - last;
      last = now;
      if (now > start) {
        gaps += 1;
        worstGap = Math.max(worstGap, gap);
      }
      const t = Math.min(1, (now - start) / length);
      // The corner leads, the page rolls over high in the middle, and the curl straightens as it goes.
      paper.draw(under, [pose(front, from + (1 - from) * turnCurve(t), dir, shape)]);
      if (t < 1) {
        this.#frame = requestAnimationFrame(tick);
        return;
      }
      const stats = { ...paper.stats, duration: Math.round(now - start), intervals: gaps, worstInterval: Math.round(worstGap) };
      container.dispatchEvent(new CustomEvent('fb-paper-stats', { detail: stats }));
      this.#land(run, video);
      this.#announce(run, video, to);
    };
    this.#frame = requestAnimationFrame(tick);
  }

  /**
   * The page on screen goes over with the film playing on under it: nothing is sought, paused or waited for. For a
   * chapter's opening on a phone (opening.ts). The frame showing now is taken as the page; it curls away over the
   * live picture, its shadow on it. False where a page can't be curled (reduced motion, no WebGL, no frame yet), or
   * while another turn is in the air.
   */
  leaf(direction: 1 | -1 = 1, length = LEAF): boolean {
    const container = this.#container;
    const video = container ? videoIn(container) : null;
    if (!container || !video || !video.videoWidth || !canCurl() || this.hasAttribute('data-turning')) return false;
    this.#end();
    const run = ++this.#run;
    const paper = Paper.create(this);
    if (!paper) return false;
    this.#paper = paper;
    const front = paper.texture(video);
    if (!front) {
      this.#end();
      return false;
    }
    this.toggleAttribute('data-turning', true);
    this.toggleAttribute('data-leaf', true);
    paper.draw('shadow', [pose(front, 0, direction, PAGE)]);
    let start = 0;
    const tick = (now: number) => {
      if (run !== this.#run) return;
      if (!start) start = now;
      const t = Math.min(1, (now - start) / length);
      paper.draw('shadow', [pose(front, turnCurve(t), direction, PAGE)]);
      if (t < 1) this.#frame = requestAnimationFrame(tick);
      else this.#end();
    };
    this.#frame = requestAnimationFrame(tick);
    return true;
  }

  /** Whatever is in the air is put down at once (a tap during a chapter's opening). */
  skip() {
    if (this.hasAttribute('data-leaf')) this.#end();
  }

  /** The turned-to frame stays on the canvas until the video shows it too, then the paper gives way. */
  #land(run: number, video: HTMLVideoElement) {
    const done = () => {
      if (run !== this.#run) return;
      this.toggleAttribute('data-landing', true);
      this.#timer = window.setTimeout(() => {
        if (run === this.#run) this.#end();
      }, 160);
    };
    if (video.seeking) video.addEventListener('seeked', () => requestAnimationFrame(done), { once: true });
    else requestAnimationFrame(done);
  }

  #announcer() {
    return this.#container?.querySelector<HTMLElement>('media-status-announcer') ?? null;
  }

  /** Says where the turn landed, once the video is there, unless another turn has started since. */
  #announce(run: number, video: HTMLVideoElement, to: number) {
    const container = this.#container;
    if (!container) return;
    const speak = () => {
      if (run !== this.#run) return;
      const chapters = this.#book?.chapters ?? [];
      const index = chapters.findIndex((c) => to >= c.startTime - 0.05 && to < c.endTime);
      const time = clock(to);
      const message =
        index < 0
          ? time
          : say(this.#i18n, 'flipbook.turnedTo', { number: index + 1, title: chapters[index].text, time });
      voiceFor(container)(message);
      clearTimeout(this.#quietTimer);
      // The status announcer's own word on the seek comes 200 ms after it completes: past that, it speaks again.
      this.#quietTimer = window.setTimeout(() => this.#announcer()?.removeAttribute('aria-live'), 500);
    };
    if (video.seeking) video.addEventListener('seeked', speak, { once: true });
    else speak();
  }

  /** The storyboard's own frame, when the sharp one isn't ready: drawn from the sprite into a small canvas. */
  async #tile(paper: Paper, book: Book, index: number) {
    const image = await spriteImage(book.sprite);
    const tile = book.tiles[index];
    if (!image || !tile) return null;
    const canvas = document.createElement('canvas');
    canvas.width = tile.w;
    canvas.height = tile.h;
    canvas.getContext('2d')?.drawImage(image, tile.x, tile.y, tile.w, tile.h, 0, 0, tile.w, tile.h);
    return paper.texture(canvas);
  }

  #end() {
    cancelAnimationFrame(this.#frame);
    clearTimeout(this.#timer);
    this.#frame = 0;
    this.#paper?.dispose();
    this.#paper = null;
    this.toggleAttribute('data-turning', false);
    this.toggleAttribute('data-leaf', false);
    this.toggleAttribute('data-landing', false);
    this.#container?.toggleAttribute('data-fb-turning', false);
  }
}

customElements.define('fb-turn', FbTurnElement);
