import { type PropertyValues, PlayerController, playerContext, selectPlayback, selectTime, UIElement } from '@videojs/html';
import { I18nController, i18nContext } from '@videojs/html/i18n';
import { type Book, chapterAt, loadBook } from './book';
import { turnTo } from './goto';
import { tell } from './pages';

/** How long before a chapter ends the offer to turn to the next one appears. */
const LEAD = 8;
/** Chapters shorter than this are over before skipping would save anything: no offer, the film just goes on. */
const WORTH = 30;

/**
 * "Next: Desert ›", in the last seconds of each chapter, as Netflix offers Skip Intro: one key, one purpose, there
 * only when it's useful and gone when it isn't. Pressing it turns the page to the next chapter (N does too, at any time: that key is the core's, goto.ts).
 * It never takes focus, never covers the captions (they step round it) and isn't there on the last chapter, on a
 * chapter too short to be worth skipping, while paused (the corner curl offers the same turn then) or while the deck
 * or a page is open.
 */
export class FbNextElement extends UIElement {
  #time = new PlayerController(this, playerContext, selectTime);
  #playback = new PlayerController(this, playerContext, selectPlayback);
  #i18n = new I18nController(this, i18nContext);
  #abort: AbortController | null = null;
  #container: HTMLElement | null = null;
  #book: Book | null = null;
  #button: HTMLButtonElement | null = null;
  #next = -1;

  connectedCallback() {
    super.connectedCallback();
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    this.setAttribute('data-fb-overlay', '');
    this.innerHTML =
      '<button type="button" class="fb-next-button" aria-keyshortcuts="N"><span class="fb-next-title"></span><media-icon family="flipbook" name="chevron" class="fb-next-chevron"></media-icon><kbd class="fb-keycap" aria-hidden="true">N</kbd></button>';
    this.#button = this.querySelector('button');
    this.inert = true;
    const container = this.closest<HTMLElement>('media-container');
    this.#container = container;
    if (!container) return;
    queueMicrotask(async () => {
      this.#book = await loadBook(container, signal);
      if (!signal.aborted) this.requestUpdate();
    });
    this.#button?.addEventListener('click', () => this.#go(), { signal });
    for (const type of ['pointerdown', 'pointerup', 'click', 'dblclick']) {
      this.addEventListener(type, (event) => event.stopPropagation(), { signal });
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort?.abort();
  }

  update(changed: PropertyValues) {
    super.update(changed);
    const book = this.#book;
    const time = this.#time.value;
    const playback = this.#playback.value;
    const container = this.#container;
    const button = this.#button;
    if (!book || !time || !playback || !container || !button) return;
    const at = chapterAt(book, time.currentTime);
    const chapter = book.chapters[at];
    const next = at >= 0 && at < book.chapters.length - 1 ? at + 1 : -1;
    const busy = container.hasAttribute('data-fb-deck') || container.hasAttribute('data-fb-sheet') || container.hasAttribute('data-fb-contents');
    const long = !!chapter && chapter.endTime - chapter.startTime >= WORTH;
    const open = next >= 0 && long && !playback.paused && !busy && chapter.endTime - time.currentTime <= LEAD;
    if (next !== this.#next) {
      this.#next = next;
      const title = next >= 0 ? book.chapters[next].text : '';
      const label = this.querySelector<HTMLElement>('.fb-next-title');
      if (label) label.textContent = tell(this.#i18n, 'fbPages.next', { title });
    }
    if (open !== this.hasAttribute('data-open')) {
      this.toggleAttribute('data-open', open);
      // Reachable while it's there (after the slab in Tab order), and out of the way once it's gone.
      if (!open && this.contains(document.activeElement)) container.focus({ preventScroll: true });
      this.inert = !open;
    }
  }

  #go() {
    const book = this.#book;
    const container = this.#container;
    if (!book || !container || this.#next < 0) return;
    const hadFocus = this.contains(document.activeElement);
    turnTo(container.querySelector('fb-turn') ?? container, book.chapters[this.#next].startTime);
    this.toggleAttribute('data-open', false);
    if (hadFocus) container.focus({ preventScroll: true });
  }
}

customElements.define('fb-next', FbNextElement);
