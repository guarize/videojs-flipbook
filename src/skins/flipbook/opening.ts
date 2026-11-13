import { UIElement } from '@videojs/html';
import { I18nController, i18nContext } from '@videojs/html/i18n';
import { type Book, chapterAt, loadBook, reducedMotion, videoIn } from './book';
import { attach } from './companion';
import { say } from './i18n';
import { voiceFor } from './pages';

/** The chapter's number and name stand this long, then go (ms). */
const TITLE = 700;
/** After a turn asked for by a tab or a key (turn.ts, 480 to 620 ms), the title comes as its page lands. */
const AFTER_TURN = 380;
/** No second opening this soon after one: a film flipped fast across three chapters opens the one it lands in. */
const APART = 1500;
/** Playing into a chapter: the film is within this of the chapter's first moment (a timeupdate comes every 250 ms). */
const JUST_IN = 0.7;

type Turner = HTMLElement & { leaf?: (direction?: 1 | -1) => boolean; skip?: () => void };

/**
 * A chapter opens, on a phone. When the film comes into a new chapter the page goes over across the whole picture
 * (turn.ts, the film playing on under it), the phone ticks once, and the chapter's number and name are set large on
 * the picture for a beat, as a chapter's opening page is: "3 · The Herd". Then the film is simply playing.
 *
 * It opens at the six boundaries and nowhere else:
 * - the film plays across one;
 * - a hand flips the film across one or several and lets go (one opening, for where it lands);
 * - a chapter is chosen (a tab, the sheet, the lock screen's keys): turn.ts turns to it as it always has, and this
 *   adds the title as the page lands.
 * A seek by key, by double tap or by a tap on the edge opens nothing, wherever it lands. Never two within a second
 * and a half. Any touch puts it away at once. Nothing waits on it: the film is never paused, held or delayed.
 *
 * Only where the player is a phone's: under 480 px wide, or filling the screen of a touch device. A wide player with
 * a mouse is as it was. Under reduced motion no page goes over: the title appears and leaves by opacity alone.
 * The chapter is said once, politely ("Chapter 3: The Herd"), unless the turn has already said it (turn.ts says every
 * turn it makes) or the film is paused under a hand (flip.ts says the page it rested on, chapter included).
 */
export class FbOpeningElement extends UIElement {
  #i18n = new I18nController(this, i18nContext);
  #abort: AbortController | null = null;
  #container: HTMLElement | null = null;
  #book: Book | null = null;
  #chapter = -1;
  #from = -1;
  #at = -Infinity;
  #timer = 0;
  #pending = 0;
  /** A seek in flight was asked for (a key, a double tap, the edge): where it lands opens nothing. */
  #sought = false;

  connectedCallback() {
    super.connectedCallback();
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    this.hidden = false;
    this.setAttribute('aria-hidden', 'true');
    this.classList.add('fb-opening');
    this.innerHTML = '<p class="fb-opening-title"><span class="fb-opening-number"></span><span class="fb-opening-name"></span></p>';
    const container = this.closest<HTMLElement>('media-container');
    this.#container = container;
    if (!container) return;

    queueMicrotask(async () => {
      this.#book = await loadBook(container, signal).catch(() => null);
      const video = videoIn(container);
      if (signal.aborted || !this.#book || !video) return;
      this.#chapter = chapterAt(this.#book, video.currentTime);
      video.addEventListener('seeking', () => {
        this.#sought = true;
      }, { signal });
      video.addEventListener('seeked', () => {
        // Where a seek lands is where the film is now: the next boundary is counted from here.
        if (this.#book) this.#chapter = chapterAt(this.#book, video.currentTime);
        window.setTimeout(() => {
          this.#sought = video.seeking;
        }, 0);
      }, { signal });
      video.addEventListener('timeupdate', () => this.#played(video), { signal });

      // The hand on the film (flip.ts, which may arrive after this): which chapter it took the film in, and which it
      // left it in.
      let mode = 'idle';
      const watch = new MutationObserver((records) => {
        const flip = records.find((record) => (record.target as Element).localName === 'fb-flip')?.target as Element | undefined;
        if (!flip) return;
        const now = flip.getAttribute('data-mode') ?? 'idle';
        if (now === mode) return;
        if (mode === 'idle') this.#from = this.#book ? chapterAt(this.#book, video.currentTime) : -1;
        mode = now;
        if (now !== 'idle') return;
        const book = this.#book;
        const landed = book ? chapterAt(book, video.currentTime) : -1;
        const from = this.#from;
        this.#from = -1;
        this.#chapter = landed;
        if (landed >= 0 && from >= 0 && landed !== from) this.#open(landed, { leaf: true, direction: landed > from ? 1 : -1, say: !video.paused });
      });
      watch.observe(container, { subtree: true, attributes: true, attributeFilter: ['data-mode'] });
      signal.addEventListener('abort', () => watch.disconnect());
    });

    // A chapter chosen: turn.ts turns to it and says it; the title comes as its page lands.
    container.addEventListener('fb-turn', (event) => {
      const time = (event as CustomEvent<{ time: number }>).detail?.time;
      const book = this.#book;
      if (!book || !Number.isFinite(time)) return;
      const index = book.chapters.findIndex((c) => Math.abs(c.startTime - time) < 0.05);
      if (index < 0) return;
      clearTimeout(this.#pending);
      this.#pending = window.setTimeout(() => this.#open(index, { leaf: false, direction: 1, say: false, turned: true }), reducedMotion.matches ? 0 : AFTER_TURN);
    }, { signal });

    // Any touch, click or key puts it away at once.
    for (const type of ['pointerdown', 'keydown']) container.addEventListener(type, () => this.#close(true), { capture: true, signal });
    signal.addEventListener('abort', () => this.#close(true));
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort?.abort();
    clearTimeout(this.#timer);
    clearTimeout(this.#pending);
  }

  /** A phone's player: narrow, or filling the screen of a touch device. */
  #phone(): boolean {
    const container = this.#container;
    if (!container) return false;
    return container.hasAttribute('data-fb-phone') || (container.hasAttribute('data-fb-screen') && matchMedia('(pointer: coarse)').matches);
  }

  /** The film playing by itself has come into the next chapter. */
  #played(video: HTMLVideoElement) {
    const book = this.#book;
    const container = this.#container;
    if (!book || !container) return;
    const now = chapterAt(book, video.currentTime);
    const was = this.#chapter;
    if (now === was) return;
    this.#chapter = now;
    // Under a hand, or arriving by a seek: not the film's own crossing.
    if (video.paused || video.seeking || this.#sought || this.#from >= 0 || container.getAttribute('data-fb-deck') === 'flip') return;
    if (now !== was + 1 || was < 0) return;
    if (video.currentTime - book.chapters[now].startTime > JUST_IN) return;
    this.#open(now, { leaf: true, direction: 1, say: true });
  }

  #open(index: number, how: { leaf: boolean; direction: 1 | -1; say: boolean; turned?: boolean }) {
    const container = this.#container;
    const chapter = this.#book?.chapters[index];
    if (!container || !chapter || !this.#phone()) return;
    const now = performance.now();
    // (A title that follows a turn the viewer asked for is part of that turn, whatever opened before it.)
    if (!how.turned && now - this.#at < APART) return;
    // A cover, the contents or a panel has the picture: no opening over it.
    if (container.matches('[data-fb-cover], [data-fb-jacket], [data-fb-contents], [data-fb-sheet], [data-fb-pip], [data-fb-plate]')) return;
    this.#at = now;
    const number = this.querySelector<HTMLElement>('.fb-opening-number');
    const name = this.querySelector<HTMLElement>('.fb-opening-name');
    if (number) number.textContent = String(index + 1);
    if (name) name.textContent = chapter.text;
    let leafed = false;
    if (how.leaf && !reducedMotion.matches) {
      leafed = container.querySelector<Turner>('fb-turn')?.leaf?.(how.direction) ?? false;
      try {
        navigator.vibrate?.(10);
      } catch {
        // Not allowed here: the page still turns.
      }
    }
    this.toggleAttribute('data-leafed', leafed);
    this.toggleAttribute('data-open', true);
    container.toggleAttribute('data-fb-opening-chapter', true);
    container.dispatchEvent(new CustomEvent('fb-opening', { detail: { index, title: chapter.text, leaf: leafed } }));
    if (how.say) voiceFor(container)(say(this.#i18n, 'flipbook.chapter', { number: index + 1, title: chapter.text }));
    clearTimeout(this.#timer);
    this.#timer = window.setTimeout(() => this.#close(false), TITLE + (leafed ? 300 : 0));
  }

  #close(now: boolean) {
    clearTimeout(this.#timer);
    clearTimeout(this.#pending);
    if (!this.hasAttribute('data-open')) return;
    this.toggleAttribute('data-skipped', now);
    this.toggleAttribute('data-open', false);
    this.#container?.toggleAttribute('data-fb-opening-chapter', false);
    if (now) this.#container?.querySelector<Turner>('fb-turn')?.skip?.();
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('fb-opening')) customElements.define('fb-opening', FbOpeningElement);
attach('fb-opening', 'turns');
