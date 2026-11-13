import { PlayerController, playerContext, type PropertyValues, selectMetadata, UIElement } from '@videojs/html';
import { I18nController, i18nContext } from '@videojs/html/i18n';
import { tileAt } from '@/shared/storyboard';
import { type Book, chapterAt, clock, loadBook, pictureIn, reducedMotion, videoIn, whenTheFilmShows } from './book';
import { sharpFrame } from './frames';
import { say } from './i18n';
import { frameFor, isPlainKey, voiceFor } from './pages';

/** A mouse press that travels this far on the paused page is a pull, not a click. */
const SLOP = 10;
/** A finger held this long, still, has taken hold of the page; sooner, or moving, it's a tap or a scroll. */
const HOLD_MS = 350;
const HOLD_SLOP = 8;
/** Until the page tears it follows at this share of the pull: the spine holding on. */
const RESIST = 0.3;
/** The kept sheet's margins, as shares of the picture's width: around it, and the foot that carries the folio. */
const MARGIN = 0.05;
const FOOT = 0.1;
/** A picture wider than this is set smaller on the sheet; a narrower stand-in (a storyboard tile) larger. */
const WIDEST = 1920;
const NARROWEST = 640;
/** How long the slip stays up untouched. */
const SLIP_MS = 8000;

const SKIN = 'media-container[data-theme="flipbook"]';
const HOVERS = matchMedia('(hover: hover)');
/** A press that starts on any of these is theirs, never a pull. */
const NOT_THE_PAGE =
  'button, a, input, select, textarea, [role="slider"], [role="dialog"], media-time-slider, .fb-bar, .video-controls-top, [data-fb-overlay], fb-curl, fb-ear, fb-plate, fb-contents, .fb-resume, .media-menu-popup';

interface Picture {
  source: CanvasImageSource;
  /** The part of the source that is the picture, in its own pixels. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

interface Folio {
  page: number;
  time: number;
  title: string;
  chapter: string;
}

/** The pull's threshold for a player this wide: about a sixth of it, never a twitch, never a reach. */
export const tearAt = (width: number) => Math.max(72, Math.min(160, width * 0.16));

/** The size of the kept sheet for a picture of this size (tests read it too). */
export function sheetSize(width: number, height: number): { width: number; height: number; picture: { x: number; y: number; width: number; height: number } } {
  const w = Math.round(Math.max(NARROWEST, Math.min(WIDEST, width)));
  const h = Math.round((w * height) / width);
  const margin = Math.round(w * MARGIN);
  return { width: w + margin * 2, height: h + margin + Math.round(w * FOOT), picture: { x: margin, y: margin, width: w, height: h } };
}

/**
 * Tear out the page. Paused, the picture is a printed page: press it and pull, and past a short resistance it tears
 * free along the spine, tilts, and leaves as a sheet, a PNG of that frame set as a page (paper margin, folio, chapter,
 * the film's title, a colophon). It is downloaded, or handed to the system's share sheet on a touch device that can
 * share files. A slip then offers "Copy link to this page": the address with `#p=31&t=13.2`, which opens the film on
 * that page (read here, on load and when the hash changes).
 *
 * The same without a pull: "Keep this page" on the paused page and in Settings, and S anywhere in the player.
 *
 * The pull never takes an ordinary input. It starts only on the paused page (never while playing, so a click still
 * plays and pauses), only on the picture itself (never on a key, the edge or a panel), with a mouse only past 10 px
 * of travel, and with a finger only after a still hold of 350 ms, so a tap, a double tap and a scroll that starts on
 * the player stay what they were. Let go short of the tear and the page springs back; catch it on the way and it
 * follows the hand again. Under reduced motion nothing lifts: a pull past the threshold simply keeps the page.
 *
 * A film from another origin without CORS taints a canvas, and the browser refuses to export it. So the sheet is
 * tried from the video's own frame, then from the page's sharp still, then from its storyboard tile, each caught;
 * with none, the slip says so and offers the link alone. Nothing here throws.
 */
export class FbTearElement extends UIElement {
  #metadata = new PlayerController(this, playerContext, selectMetadata);
  #i18n = new I18nController(this, i18nContext);
  #abort: AbortController | null = null;
  #container: HTMLElement | null = null;
  #book: Book | null = null;
  #key: HTMLButtonElement | null = null;
  #slip: HTMLElement | null = null;
  #slipTimer = 0;
  #thumbUrl = '';
  #busy = false;
  // The pull.
  #sheet: HTMLElement | null = null;
  #well: HTMLElement | null = null;
  #frame = 0;
  #last = 0;
  #pos = { x: 0, y: 0, r: 0 };
  #target = { x: 0, y: 0, r: 0 };
  #mode: 'idle' | 'held' | 'torn' | 'back' | 'gone' = 'idle';
  #dragging = false;

  connectedCallback() {
    super.connectedCallback();
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    const container = this.closest<HTMLElement>('media-container');
    this.#container = container;
    if (!container) return;
    this.innerHTML = [
      '<div class="fb-tear-well" aria-hidden="true"></div>',
      '<div class="fb-tear-stub" aria-hidden="true"></div>',
      '<button type="button" class="fb-keep" data-fb-action="keep" aria-keyshortcuts="S"><span class="fb-keep-name"></span><kbd class="fb-keycap" aria-hidden="true">S</kbd></button>',
      '<div class="fb-tear-slip" role="group" hidden>',
      '<img class="fb-tear-thumb" alt="" hidden>',
      '<p class="fb-tear-said"></p>',
      '<button type="button" class="fb-tear-copy"></button>',
      '<input class="fb-tear-link" readonly hidden>',
      '<button type="button" class="fb-tear-close"><media-icon family="flipbook" name="close"></media-icon></button>',
      '</div>',
    ].join('');
    this.#well = this.querySelector('.fb-tear-well');
    this.#key = this.querySelector('.fb-keep');
    this.#slip = this.querySelector('.fb-tear-slip');
    this.#name();

    queueMicrotask(async () => {
      this.#book = await loadBook(container, signal).catch(() => null);
      if (signal.aborted) return;
      void this.#openLink();
      // The slip is about the page that was kept: once the film plays on, that page has gone by.
      videoIn(container)?.addEventListener('play', () => this.#closeSlip(false), { signal });
    });
    window.addEventListener('hashchange', () => void this.#openLink(), { signal });

    // Every "Keep this page" in the player, wherever its layout puts one, by the name it carries.
    container.addEventListener('click', (event) => {
      const trigger = (event.target as Element | null)?.closest<HTMLElement>('[data-fb-action="keep"]');
      if (trigger && container.contains(trigger)) void this.keep(trigger);
    }, { signal });
    container.addEventListener('fb-keep', () => void this.keep(), { signal });
    container.addEventListener('select', (event) => {
      // The menu closes and hands focus back to its key first (as menu.ts waits for its own items).
      if ((event.target as Element | null)?.closest('[data-fb-menu="keep"]')) requestAnimationFrame(() => void this.keep());
    }, { signal });
    container.addEventListener('keydown', (event) => {
      if ((event.key !== 's' && event.key !== 'S') || event.shiftKey || event.repeat || !isPlainKey(event)) return;
      if ((event.target as Element | null)?.closest('[aria-modal="true"]')) return;
      event.preventDefault();
      void this.keep();
    }, { signal });

    container.addEventListener('pointerdown', (event) => this.#press(event), { signal });
    // A finger that has taken hold of the page moves the page, not the document under it.
    container.addEventListener('touchmove', (event) => {
      if (this.#dragging && event.cancelable) event.preventDefault();
    }, { passive: false, signal });

    const slip = this.#slip;
    slip?.querySelector('.fb-tear-copy')?.addEventListener('click', () => void this.#copy(), { signal });
    slip?.querySelector('.fb-tear-close')?.addEventListener('click', () => this.#closeSlip(true), { signal });
    slip?.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.#closeSlip(true);
      }
      // The slip's keys are its own: Space on its button doesn't play the film.
      event.stopPropagation();
    }, { signal });
    for (const type of ['pointerdown', 'pointerup', 'click', 'dblclick']) slip?.addEventListener(type, (event) => event.stopPropagation(), { signal });
    for (const type of ['pointerenter', 'focusin']) slip?.addEventListener(type, () => clearTimeout(this.#slipTimer), { signal });
    for (const type of ['pointerleave', 'focusout']) slip?.addEventListener(type, () => this.#armSlip(), { signal });

    signal.addEventListener('abort', () => {
      cancelAnimationFrame(this.#frame);
      clearTimeout(this.#slipTimer);
      this.#sheet?.remove();
      this.#sheet = null;
      this.#mode = 'idle';
      this.#dragging = false;
      container.removeAttribute('data-fb-tearing');
      if (this.#thumbUrl) URL.revokeObjectURL(this.#thumbUrl);
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort?.abort();
  }

  update(changed: PropertyValues) {
    super.update(changed);
    this.#name();
  }

  #t(key: Parameters<typeof say>[1], values: Record<string, string | number> = {}) {
    return say(this.#i18n, key, values);
  }

  #name() {
    const text = this.#t('flipbook.keep');
    const name = this.#key?.querySelector('.fb-keep-name');
    if (name && name.textContent !== text) name.textContent = text;
    for (const label of this.#container?.querySelectorAll<HTMLElement>('[data-fb-menu="keep"] [data-part="label"]') ?? []) {
      if (label.textContent !== text) label.textContent = text;
    }
    this.#slip?.querySelector('.fb-tear-close')?.setAttribute('aria-label', this.#t('flipbook.keepClose'));
  }

  /* ─── Where the film is ───────────────────────────────────────────────── */

  #folio(): Folio | null {
    const container = this.#container;
    const video = container ? videoIn(container) : null;
    if (!container || !video) return null;
    const time = video.currentTime || 0;
    const book = this.#book;
    const page = book ? tileAt(book.tiles, time) + 1 : 1;
    const index = book ? chapterAt(book, time) : -1;
    const chapter = book && index >= 0 ? this.#t('flipbook.sheetChapter', { number: index + 1, title: book.chapters[index].text }) : '';
    return { page, time, title: this.#metadata.value?.title ?? '', chapter };
  }

  /** The address that opens this film on a page. */
  #link(folio: Folio): string {
    const url = new URL(location.href);
    url.hash = `p=${folio.page}&t=${folio.time.toFixed(1)}`;
    return url.href;
  }

  /** `#p=31` (a page) or `#t=13.2` (a moment; it wins when both are there): the first player on the page opens on it. */
  async #openLink() {
    const container = this.#container;
    if (!container || document.querySelector(SKIN) !== container) return;
    const page = /[#&]p=(\d+)/.exec(location.hash);
    const moment = /[#&]t=(\d+(?:\.\d+)?)/.exec(location.hash);
    if (!page && !moment) return;
    const video = videoIn(container);
    if (!video) return;
    if (video.readyState < 1) {
      await new Promise<void>((resolve) => video.addEventListener('loadedmetadata', () => resolve(), { once: true }));
    }
    const book = this.#book;
    const tile = page && book ? book.tiles[Math.max(0, Math.min(book.tiles.length - 1, Number(page[1]) - 1))] : null;
    // A page's link lands just inside the page, so the folio reads the page that was asked for.
    const wanted = moment ? Number(moment[1]) : tile ? tile.start + 0.02 : Number.NaN;
    if (!Number.isFinite(wanted)) return;
    const end = Number.isFinite(video.duration) && video.duration > 0 ? video.duration - 0.05 : wanted;
    const time = Math.max(0, Math.min(wanted, end));
    if (Math.abs(video.currentTime - time) > 0.05) video.currentTime = time;
    const at = book ? tileAt(book.tiles, time) + 1 : Number(page?.[1] ?? 1);
    voiceFor(container)(this.#t('flipbook.keepOpened', { page: at }));
  }

  /* ─── Keeping the page ────────────────────────────────────────────────── */

  /** Keeps the page the film is on: the sheet saved or shared, then the slip with its link. */
  async keep(opener: HTMLElement | null = null): Promise<void> {
    const container = this.#container;
    const folio = this.#folio();
    if (!container || !folio || this.#busy) return;
    this.#busy = true;
    try {
      const blob = await this.#print(folio);
      let said = this.#t('flipbook.keepLinkOnly');
      if (blob) said = this.#t((await this.#hand(blob, folio)) === 'shared' ? 'flipbook.keepShared' : 'flipbook.keepSaved', { page: folio.page });
      this.#openSlip(folio, blob, said, opener);
      voiceFor(container)(said);
    } catch {
      // Whatever went wrong, the link is still there to take.
      const said = this.#t('flipbook.keepLinkOnly');
      this.#openSlip(folio, null, said, opener);
      voiceFor(container)(said);
    } finally {
      this.#busy = false;
    }
  }

  /** The sheet as a PNG, from the best picture that can be exported; null when none can. */
  async #print(folio: Folio): Promise<Blob | null> {
    const container = this.#container;
    if (!container) return null;
    // The frame on screen is the page that is kept: where a page's still stands in for a streamed film (stand.ts),
    // the film's own frame is waited for; where a copy of the film shows the frame, the copy is the picture.
    await whenTheFilmShows(container);
    const video = pictureIn(container);
    const book = this.#book;
    const sources: (() => Promise<Picture | null>)[] = [
      // The frame on screen, at the picture's own size.
      async () => (video && video.readyState >= 2 && video.videoWidth > 0 ? { source: video, sx: 0, sy: 0, sw: video.videoWidth, sh: video.videoHeight } : null),
      // The page's sharp still (asked for with CORS, frames.ts).
      async () => {
        const url = book ? await frameFor(container, book, folio.time) : null;
        const image = url ? await sharpFrame(url) : null;
        return image ? { source: image, sx: 0, sy: 0, sw: image.naturalWidth, sh: image.naturalHeight } : null;
      },
      // The page's storyboard tile: small, but the page.
      async () => {
        const tile = book?.tiles[folio.page - 1];
        if (!tile) return null;
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.src = tile.src;
        await image.decode();
        return { source: image, sx: tile.x, sy: tile.y, sw: tile.w, sh: tile.h };
      },
    ];
    for (const from of sources) {
      try {
        const picture = await from();
        const blob = picture ? await this.#compose(picture, folio) : null;
        if (blob) return blob;
      } catch {
        // A tainted canvas (a film from another origin without CORS) or a picture that won't load: the next one.
      }
    }
    return null;
  }

  /** Sets the picture on a sheet of paper with its folio line. Throws a SecurityError if the picture taints it. */
  async #compose(picture: Picture, folio: Folio): Promise<Blob | null> {
    const container = this.#container;
    if (!container) return null;
    const size = sheetSize(picture.sw, picture.sh);
    const { x, y, width, height } = size.picture;
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const style = getComputedStyle(container);
    const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    const paper = token('--fb-paper', '#f6f1e7');
    const ink = token('--fb-ink', '#14110e');
    const soft = token('--fb-ink-soft', '#5b5249');
    const accent = token('--fb-accent', '#e2492b');
    const sans = token('--fb-font', 'system-ui, sans-serif');
    const mono = token('--fb-mono', 'ui-monospace, monospace');
    const large = Math.round(width * 0.024);
    const small = Math.round(width * 0.0155);
    await Promise.all([document.fonts.load(`600 ${large}px ${sans}`), document.fonts.load(`500 ${small}px ${sans}`)]).catch(() => undefined);

    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(picture.source, picture.sx, picture.sy, picture.sw, picture.sh, x, y, width, height);
    // A hairline holds a pale frame against the paper.
    ctx.strokeStyle = 'rgb(20 17 14 / 0.16)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);

    const foot = canvas.height - (y + height);
    const first = y + height + Math.round(foot * 0.47);
    const second = y + height + Math.round(foot * 0.76);
    const right = x + width;
    ctx.textBaseline = 'alphabetic';
    // The folio, where a page carries it: outer foot.
    ctx.fillStyle = ink;
    ctx.textAlign = 'left';
    ctx.font = `600 ${large}px ${mono}`;
    ctx.fillText(this.#t('flipbook.pageShort', { page: folio.page }), x, first);
    ctx.textAlign = 'right';
    ctx.font = `600 ${large}px ${sans}`;
    ctx.fillText(fit(ctx, folio.title, width * 0.62), right, first);
    ctx.fillStyle = soft;
    ctx.textAlign = 'left';
    ctx.font = `500 ${small}px ${sans}`;
    ctx.fillText(fit(ctx, [folio.chapter, clock(folio.time)].filter(Boolean).join('  ·  '), width * 0.6), x, second);
    // The colophon: the mark, and the name in spaced capitals.
    ctx.textAlign = 'right';
    ctx.font = `600 ${small}px ${mono}`;
    const spaced = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
    if ('letterSpacing' in spaced) spaced.letterSpacing = `${(small * 0.16).toFixed(1)}px`;
    const colophon = this.#t('flipbook.colophon').toUpperCase();
    ctx.fillText(colophon, right, second);
    const mark = Math.round(small * 0.56);
    ctx.fillStyle = accent;
    ctx.fillRect(Math.round(right - ctx.measureText(colophon).width - mark * 2), second - mark, mark, mark);

    // toBlob throws, there and then, on a canvas a cross-origin picture has tainted.
    return new Promise<Blob | null>((resolve, reject) => {
      try {
        canvas.toBlob((blob) => resolve(blob), 'image/png');
      } catch (error) {
        reject(error);
      }
    });
  }

  /** The sheet leaves: to the share sheet on a touch device that shares files, else as a download. */
  async #hand(blob: Blob, folio: Folio): Promise<'shared' | 'saved'> {
    const slug = (folio.title || 'film').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'film';
    const name = `${slug}-p${folio.page}.png`;
    try {
      const file = new File([blob], name, { type: 'image/png' });
      const data: ShareData = { files: [file], title: folio.title };
      if (matchMedia('(hover: none) and (pointer: coarse)').matches && navigator.canShare?.(data)) {
        await navigator.share(data);
        return 'shared';
      }
    } catch (error) {
      // Closed by the viewer: they've seen the sheet and chose not to send it. Anything else falls to a download.
      if ((error as DOMException | null)?.name === 'AbortError') return 'saved';
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return 'saved';
  }

  /* ─── The slip ────────────────────────────────────────────────────────── */

  #openSlip(folio: Folio, blob: Blob | null, said: string, opener: HTMLElement | null) {
    const slip = this.#slip;
    const container = this.#container;
    if (!slip || !container) return;
    const thumb = slip.querySelector<HTMLImageElement>('.fb-tear-thumb');
    if (this.#thumbUrl) URL.revokeObjectURL(this.#thumbUrl);
    this.#thumbUrl = blob ? URL.createObjectURL(blob) : '';
    if (thumb) {
      thumb.hidden = !blob;
      if (blob) thumb.src = this.#thumbUrl;
      else thumb.removeAttribute('src');
    }
    const line = slip.querySelector('.fb-tear-said');
    if (line) line.textContent = said;
    slip.setAttribute('aria-label', said);
    const copy = slip.querySelector<HTMLButtonElement>('.fb-tear-copy');
    const field = slip.querySelector<HTMLInputElement>('.fb-tear-link');
    if (copy) {
      copy.hidden = false;
      copy.textContent = this.#t('flipbook.keepCopy');
      copy.removeAttribute('data-done');
    }
    if (field) {
      field.hidden = true;
      field.value = this.#link(folio);
      field.setAttribute('aria-label', this.#t('flipbook.keepLink', { page: folio.page }));
    }
    slip.dataset.page = String(folio.page);
    slip.toggleAttribute('data-link-only', !blob);
    // The key that was pressed is under the slip now: focus goes to what the slip offers, and back when it closes.
    const onKey = !!opener && opener === document.activeElement && opener.matches('.fb-keep');
    slip.hidden = false;
    slip.toggleAttribute('data-fb-overlay', true);
    container.toggleAttribute('data-fb-slip', true);
    if (onKey) copy?.focus({ preventScroll: true });
    this.#armSlip();
  }

  #armSlip() {
    clearTimeout(this.#slipTimer);
    const slip = this.#slip;
    if (!slip || slip.hidden) return;
    this.#slipTimer = window.setTimeout(() => {
      // Never out from under a pointer or a keyboard's focus. (A touch screen keeps `:hover`, and focus, on the last
      // thing tapped: a slip that was tapped would never leave.)
      if ((HOVERS.matches && slip.matches(':hover')) || slip.querySelector(':focus-visible')) return;
      this.#closeSlip(false);
    }, SLIP_MS);
  }

  #closeSlip(refocus: boolean) {
    const slip = this.#slip;
    const container = this.#container;
    if (!slip || slip.hidden || !container) return;
    clearTimeout(this.#slipTimer);
    const inside = slip.contains(document.activeElement);
    slip.hidden = true;
    slip.removeAttribute('data-fb-overlay');
    container.toggleAttribute('data-fb-slip', false);
    if (inside || refocus) {
      const key = this.#key;
      (key && key.getClientRects().length ? key : container).focus({ preventScroll: true });
    }
  }

  async #copy() {
    const slip = this.#slip;
    const container = this.#container;
    const copy = slip?.querySelector<HTMLButtonElement>('.fb-tear-copy');
    const field = slip?.querySelector<HTMLInputElement>('.fb-tear-link');
    if (!slip || !container || !copy || !field) return;
    const page = Number(slip.dataset.page) || 1;
    try {
      await navigator.clipboard.writeText(field.value);
      const said = this.#t('flipbook.keepCopied', { page });
      copy.textContent = said;
      copy.toggleAttribute('data-done', true);
      voiceFor(container)(said);
    } catch {
      // No clipboard here (an insecure page, or permission refused): the address itself, selected, to copy by hand.
      const focused = copy === document.activeElement;
      copy.hidden = true;
      field.hidden = false;
      if (focused) field.focus({ preventScroll: true });
      field.select();
    }
    this.#armSlip();
  }

  /* ─── The pull ────────────────────────────────────────────────────────── */

  #press(event: PointerEvent) {
    const container = this.#container;
    if (!container || event.button !== 0 || !event.isPrimary || this.#dragging) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    // The page on its way back is caught where it is.
    const catching = this.#mode === 'back' && !!this.#sheet && !this.#sheet.hasAttribute('data-torn');
    // Only the paused page tears, and only from the picture (or from its own key, which is also a grip).
    if (!catching) {
      if (!container.hasAttribute('data-fb-print')) return;
      if (target.closest(NOT_THE_PAGE) && !target.closest('.fb-keep')) return;
    } else if (target.closest(NOT_THE_PAGE) && !target.closest('.fb-keep')) return;

    const touch = event.pointerType === 'touch';
    const id = event.pointerId;
    const box = container.getBoundingClientRect();
    const limit = tearAt(box.width);
    // Caught mid-return: the hand starts from where the page is, so it doesn't jump.
    const origin = catching ? { x: event.clientX - this.#pos.x / RESIST, y: event.clientY - this.#pos.y / RESIST } : { x: event.clientX, y: event.clientY };
    let begun = false;
    let torn = false;
    let hold = 0;
    let last = { x: event.clientX, y: event.clientY, t: event.timeStamp };
    let velocity = { x: 0, y: 0 };
    const local = new AbortController();

    const begin = () => {
      begun = true;
      this.#dragging = true;
      clearTimeout(hold);
      // A slip still up from the last page kept would lie on this one as it lifts.
      this.#closeSlip(false);
      if (touch) navigator.vibrate?.(6);
      if (!reducedMotion.matches) this.#lift(catching);
      container.toggleAttribute('data-fb-tearing', true);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      // Once the page is held, the hand is the pull's: a swipe to turn the page (flip.ts) never sees it.
      if (begun) e.stopPropagation();
      const dx = e.clientX - origin.x;
      const dy = e.clientY - origin.y;
      const far = Math.hypot(dx, dy);
      if (!begun) {
        // A finger that moves before the hold is scrolling or swiping; a mouse that travels is pulling.
        if (touch) {
          if (far > HOLD_SLOP) end(false);
          return;
        }
        if (far < SLOP) return;
        begin();
      }
      const dt = Math.max(1, e.timeStamp - last.t);
      velocity = { x: ((e.clientX - last.x) / dt) * 1000, y: ((e.clientY - last.y) / dt) * 1000 };
      last = { x: e.clientX, y: e.clientY, t: e.timeStamp };
      if (!torn && far >= limit) {
        torn = true;
        this.#mode = 'torn';
        this.#sheet?.toggleAttribute('data-torn', true);
        this.toggleAttribute('data-torn', true);
        navigator.vibrate?.(10);
      }
      const share = torn ? 1 : RESIST;
      this.#target = { x: dx * share, y: dy * share, r: Math.max(-5, Math.min(5, (dx / box.width) * (torn ? 12 : 4))) };
    };
    const end = (released: boolean) => {
      clearTimeout(hold);
      local.abort();
      if (!begun) return;
      this.#dragging = false;
      // The click the browser makes of this press is the pull's own: it never reaches play. (Only the browser's: the
      // kept page's download is a click made from script, and when the sheet was ready within these 50 ms it was
      // swallowed here, with "Page 18 saved" on the slip and no file.)
      const swallow = (click: Event) => {
        if (!click.isTrusted) return;
        window.removeEventListener('click', swallow, { capture: true });
        click.stopPropagation();
        click.preventDefault();
      };
      window.addEventListener('click', swallow, { capture: true });
      window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 50);
      if (torn && released) {
        this.#leave(velocity);
        void this.keep();
      } else if (torn) {
        // Torn, then the pointer was taken away (a call, a second finger): the page isn't kept behind the viewer's back.
        this.#back();
      } else this.#back();
    };

    if (catching) begin();
    else if (touch) {
      hold = window.setTimeout(begin, HOLD_MS);
    }
    // Heard on the way down, before the player's own listeners: the release below is kept from them.
    const options = { capture: true, signal: local.signal };
    window.addEventListener('pointermove', move, options);
    const release = (released: boolean) => (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      // The release of a held page is the pull's own: the player's gestures (tap to play, double tap) never see it,
      // however short the pull was.
      if (begun) e.stopPropagation();
      end(released);
    };
    window.addEventListener('pointerup', release(true), options);
    window.addEventListener('pointercancel', release(false), options);
  }

  /** The page comes up off the book: a copy of the frame on a sheet that follows the hand. */
  #lift(catching: boolean) {
    const container = this.#container;
    if (!container) return;
    if (!catching || !this.#sheet) {
      this.#sheet?.remove();
      const box = container.getBoundingClientRect();
      const sheet = document.createElement('div');
      sheet.className = 'fb-tear-sheet';
      sheet.setAttribute('aria-hidden', 'true');
      const canvas = document.createElement('canvas');
      const scale = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(box.width * scale);
      canvas.height = Math.round(box.height * scale);
      const video = pictureIn(container);
      const ctx = canvas.getContext('2d');
      try {
        // The printed page as it stands: its paper, and the picture where the print has it (inside its margin, less
        // any letterbox). Drawing a cross-origin frame is allowed; only exporting it is not, and this is only looked at.
        if (ctx) {
          ctx.fillStyle = getComputedStyle(container).getPropertyValue('--fb-paper').trim() || '#f6f1e7';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        if (ctx && video && video.readyState >= 2 && video.videoWidth > 0) {
          const at = video.getBoundingClientRect();
          const fitted = Math.min(at.width / video.videoWidth, at.height / video.videoHeight);
          const w = video.videoWidth * fitted;
          const h = video.videoHeight * fitted;
          const x = at.left - box.left + (at.width - w) / 2;
          const y = at.top - box.top + (at.height - h) / 2;
          ctx.drawImage(video, x * scale, y * scale, w * scale, h * scale);
        }
      } catch {
        // No picture to copy: the sheet is plain paper.
      }
      sheet.append(canvas);
      this.append(sheet);
      this.#sheet = sheet;
      this.#pos = { x: 0, y: 0, r: 0 };
      this.#target = { x: 0, y: 0, r: 0 };
    }
    this.toggleAttribute('data-torn', false);
    this.#mode = 'held';
    this.#run();
  }

  #run() {
    cancelAnimationFrame(this.#frame);
    this.#last = performance.now();
    const step = (now: number) => {
      const sheet = this.#sheet;
      if (!sheet || this.#mode === 'idle' || this.#mode === 'gone') return;
      const dt = Math.min(48, now - this.#last);
      this.#last = now;
      // Held, it keeps close to the hand; torn, it catches up with it; let go short, it settles back unhurried.
      const pace = this.#mode === 'back' ? 90 : this.#mode === 'torn' ? 55 : 24;
      const k = 1 - Math.exp(-dt / pace);
      const pos = this.#pos;
      const to = this.#target;
      pos.x += (to.x - pos.x) * k;
      pos.y += (to.y - pos.y) * k;
      pos.r += (to.r - pos.r) * k;
      this.#draw();
      if (this.#mode === 'back' && Math.hypot(pos.x, pos.y) < 0.4) {
        this.#settle();
        return;
      }
      this.#frame = requestAnimationFrame(step);
    };
    this.#frame = requestAnimationFrame(step);
  }

  #draw() {
    const sheet = this.#sheet;
    if (!sheet) return;
    const { x, y, r } = this.#pos;
    sheet.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) rotate(${r.toFixed(3)}deg)`;
    const up = Math.min(1, Math.hypot(x, y) / 28);
    sheet.style.setProperty('--fb-tear-up', up.toFixed(3));
    if (this.#well) this.#well.style.opacity = up.toFixed(3);
  }

  /** Let go short of the tear: back flat, from where it is. */
  #back() {
    if (!this.#sheet) return this.#settle();
    this.#mode = 'back';
    this.#target = { x: 0, y: 0, r: 0 };
    this.#run();
  }

  /** Let go torn: the sheet carries on the way it was going, and is gone. */
  #leave(velocity: { x: number; y: number }) {
    const sheet = this.#sheet;
    if (!sheet) return this.#settle();
    this.#mode = 'gone';
    cancelAnimationFrame(this.#frame);
    const { x, y, r } = this.#pos;
    const far = Math.hypot(x, y) || 1;
    // Where the throw would carry it, and at least a little further along the pull.
    const carry = (v: number) => Math.max(-260, Math.min(260, v * 0.18));
    const tx = x + carry(velocity.x) + (x / far) * 90;
    const ty = y + carry(velocity.y) + (y / far) * 90;
    const done = () => this.#settle();
    sheet
      .animate(
        [
          { transform: `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) rotate(${r.toFixed(2)}deg)`, opacity: 1 },
          { transform: `translate3d(${tx.toFixed(1)}px, ${ty.toFixed(1)}px, 0) rotate(${(r * 1.5).toFixed(2)}deg)`, opacity: 0 },
        ],
        { duration: 240, easing: 'cubic-bezier(0.23, 1, 0.32, 1)', fill: 'forwards' },
      )
      .finished.then(done, done);
  }

  #settle() {
    cancelAnimationFrame(this.#frame);
    this.#sheet?.remove();
    this.#sheet = null;
    this.#mode = 'idle';
    this.#pos = { x: 0, y: 0, r: 0 };
    if (this.#well) this.#well.style.opacity = '';
    this.toggleAttribute('data-torn', false);
    this.#container?.removeAttribute('data-fb-tearing');
  }
}

/** A line cut to a width, with an ellipsis, in the context's current font. */
function fit(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > width) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

if (typeof customElements !== 'undefined' && !customElements.get('fb-tear')) customElements.define('fb-tear', FbTearElement);
