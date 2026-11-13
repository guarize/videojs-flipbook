import { UIElement } from '@videojs/html';
import { I18nController, i18nContext } from '@videojs/html/i18n';
import { tileAt } from '@/shared/storyboard';
import { type Book, loadBook, spritePosition, videoIn } from './book';
import { attach } from './companion';
import { frameUrls, sharpFrame, wanted } from './frames';
import { say } from './i18n';

/** The pointer rests on a page this long before its sharp frame is fetched: a pass along the edge fetches nothing. */
const REST = 90;

/**
 * The core's preview on the fore-edge, the stand-in for the book's deck: a photographic print above the pointer, the
 * frame on its paper with its page and chapter set under it as a print's caption, and the pages before and after it
 * to either side, softer, as still pictures on their way to being film. Video.js's slider preview draws the print's
 * storyboard tile, the time and the chapter; this lays the sharp frame over the tile once the pointer rests on a page
 * and the frame has decoded (so the print sharpens in place and never flashes), prints the page number, and shows the
 * neighbours from the same storyboard sprite (no request per move). With the deck on (and room for it), the deck
 * takes over.
 */
export class FbPeekElement extends UIElement {
  #abort: AbortController | null = null;
  #sharp: HTMLImageElement | null = null;
  #book: Book | null = null;
  #urls: (string | null)[] = [];
  #page = -1;
  #timer = 0;
  #i18n = new I18nController(this, i18nContext);
  #folio: HTMLElement | null = null;
  #before: HTMLElement | null = null;
  #after: HTMLElement | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    this.hidden = true;
    const container = this.closest<HTMLElement>('media-container');
    const slider = container?.querySelector<HTMLElement>('media-time-slider');
    const thumbnail = slider?.querySelector<HTMLElement>('media-slider-thumbnail');
    if (!container || !slider || !thumbnail) return;
    let sharp = thumbnail.querySelector<HTMLImageElement>('.fb-peek-sharp');
    if (!sharp) {
      sharp = document.createElement('img');
      sharp.className = 'fb-peek-sharp';
      sharp.alt = '';
      sharp.decoding = 'async';
      sharp.setAttribute('aria-hidden', 'true');
      thumbnail.append(sharp);
    }
    this.#sharp = sharp;
    this.#folio = slider.querySelector<HTMLElement>('.fb-peek-page');
    this.#before = slider.querySelector<HTMLElement>('.fb-peek-side[data-side="before"]');
    this.#after = slider.querySelector<HTMLElement>('.fb-peek-side[data-side="after"]');

    queueMicrotask(async () => {
      const book = await loadBook(container, signal);
      if (signal.aborted || !book) return;
      this.#book = book;
      // The prints keep the film's proportions (skin.css sizes them from the page's width).
      slider.style.setProperty('--fb-print-ratio', String(book.ratio));
      await wanted(container);
      if (signal.aborted) return;
      this.#urls = await frameUrls(container, book);
    });

    slider.addEventListener('pointermove', (event) => this.#point(container, slider, event.clientX), { passive: true, signal });
    slider.addEventListener('pointerleave', () => this.#reset(), { passive: true, signal });
    signal.addEventListener('abort', () => this.#reset());
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort?.abort();
  }

  #point(container: HTMLElement, slider: HTMLElement, x: number) {
    const book = this.#book;
    const video = videoIn(container);
    // The deck is up (or about to be): its cards are the preview.
    if (!book || !video || !video.duration || container.hasAttribute('data-fb-ready')) return;
    const box = slider.getBoundingClientRect();
    if (!box.width) return;
    const share = Math.min(1, Math.max(0, (x - box.left) / box.width));
    const page = tileAt(book.tiles, share * video.duration);
    if (page === this.#page) return;
    this.#page = page;
    clearTimeout(this.#timer);
    this.#neighbours(book, page);
    // A new page: its storyboard tile shows at once (Video.js draws it); the sharp frame follows once it has decoded.
    this.#sharp?.removeAttribute('data-shown');
    const url = this.#urls[page];
    if (!url) return;
    this.#timer = window.setTimeout(async () => {
      const sharp = this.#sharp;
      // Decoded once (and cached) by frames.ts, then decoded into the card itself before it shows.
      const image = await sharpFrame(url);
      if (!image || !sharp || this.#page !== page) return;
      if (sharp.src !== url) sharp.src = url;
      const ready = await sharp.decode().then(() => true, () => false);
      if (ready && this.#page === page && sharp.src === url) sharp.setAttribute('data-shown', '');
    }, REST);
  }

  /** The page number under the print, and the pages either side of it, cut from the storyboard sprite. */
  #neighbours(book: Book, page: number) {
    const folio = this.#folio;
    if (folio) {
      const text = say(this.#i18n, 'flipbook.pageShort', { page: page + 1 });
      if (folio.textContent !== text) folio.textContent = text;
    }
    for (const [side, index] of [[this.#before, page - 1], [this.#after, page + 1]] as const) {
      if (!side) continue;
      const has = index >= 0 && index < book.tiles.length;
      // The first and last pages have no neighbour on one side: that side stays empty, holding its place.
      side.toggleAttribute('data-empty', !has);
      if (has) side.style.backgroundPosition = spritePosition(book, index);
    }
  }

  #reset() {
    clearTimeout(this.#timer);
    this.#page = -1;
    this.#sharp?.removeAttribute('data-shown');
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('fb-peek')) customElements.define('fb-peek', FbPeekElement);
attach('fb-peek');
