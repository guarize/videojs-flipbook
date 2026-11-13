import { UIElement } from '@videojs/html';
import { I18nController, i18nContext } from '@videojs/html/i18n';
import { videoIn } from './book';
import { type Feature, isOn } from './features';
import { ribbonsOf } from './marks';
import { type PagesKey, tell, voiceFor } from './pages';

type Hint = 'fine' | 'flick' | 'bookmark' | 'contents' | 'swipe';

/** Each hint teaches one of the book's extras: with it off there's nothing to teach. */
const TEACHES: Record<Hint, Feature> = { fine: 'deck', flick: 'deck', bookmark: 'ribbons', contents: 'contents', swipe: 'deck' };
const STORE = 'fb-hints';
const SHOW = 4500;

function seen(): Set<Hint> {
  try {
    return new Set(JSON.parse(localStorage.getItem(STORE) ?? '[]') as Hint[]);
  } catch {
    return new Set();
  }
}

function remember(hint: Hint) {
  const all = seen();
  all.add(hint);
  try {
    localStorage.setItem(STORE, JSON.stringify([...all]));
  } catch {
    // Storage blocked: a hint may show again next visit, which does no harm.
  }
}

/**
 * Hints that arrive with the gesture, once each per browser, never in the way. Four things nothing on screen
 * announces, each told at the moment it would help: lift while scrubbing for finer control (during a drag, until you
 * have); flick to throw the pages (after a long slow drag); B bookmarks (the first time you go back to see something
 * again); T opens the contents (after you first jump by a chapter tab); and, to a finger, that a swipe across the
 * picture flips the pages (a moment after the film is first started by touch, until a swipe has been made). A paper
 * slip at the top of the picture, said politely to screen readers too; it fades (opacity only) and never takes
 * focus. A touch on the slip puts it away at once, and is no tap on the film.
 */
export class FbHintsElement extends UIElement {
  #i18n = new I18nController(this, i18nContext);
  #abort: AbortController | null = null;
  #container: HTMLElement | null = null;
  #say: ((message: string) => void) | null = null;
  #text: HTMLElement | null = null;
  #showing: Hint | null = null;
  #timer = 0;
  #touch = false;
  #dragAt = 0;
  #dragTimer = 0;

  connectedCallback() {
    super.connectedCallback();
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    this.setAttribute('aria-hidden', 'true');
    this.innerHTML = '<p class="fb-hint" data-fb-overlay><span class="fb-hint-text"></span></p>';
    this.#text = this.querySelector('.fb-hint-text');
    const container = this.closest<HTMLElement>('media-container');
    this.#container = container;
    if (!container) return;
    this.#say = voiceFor(container);

    // Which way the viewer reaches the player, so a hint names a key only to someone with keys.
    container.addEventListener('pointerdown', (e) => {
      this.#touch = e.pointerType === 'touch';
    }, { capture: true, signal });
    container.addEventListener('keydown', () => {
      this.#touch = false;
    }, { capture: true, signal });

    // The deck, and the hand on the film itself (flip.ts, which speaks the same way), say what the pointer is doing on
    // the fore-edge: dragging, finer, or thrown.
    for (const deck of container.querySelectorAll('fb-deck, fb-flip')) {
      let mode = deck.getAttribute('data-mode');
      const watch = new MutationObserver(() => {
        const now = deck.getAttribute('data-mode');
        if (deck.hasAttribute('data-fine')) {
          remember('fine');
          if (this.#showing === 'fine') this.#hide();
        }
        if (now === mode) return;
        if (now === 'drag' && deck.hasAttribute('data-picture')) {
          // They've done it: the lesson is never needed.
          remember('swipe');
          if (this.#showing === 'swipe') this.#hide();
        }
        if (now === 'coast') remember('flick');
        // (A finger across the picture has no finer gear to lift to: that lesson is the edge's.)
        if (now === 'drag' && !deck.hasAttribute('data-picture')) this.#dragStart();
        if (mode === 'drag' && now !== 'drag') this.#dragEnd(now === 'coast');
        mode = now;
      });
      watch.observe(deck, { attributes: true, attributeFilter: ['data-mode', 'data-fine'] });
      signal.addEventListener('abort', () => watch.disconnect());
    }

    // Opening the contents is the lesson the contents hint teaches: once done, it's never needed.
    const pages = new MutationObserver(() => {
      if (container.hasAttribute('data-fb-contents')) {
        remember('contents');
        if (this.#showing === 'contents') this.#hide();
      }
    });
    pages.observe(container, { attributes: true, attributeFilter: ['data-fb-contents'] });
    signal.addEventListener('abort', () => pages.disconnect());

    container.addEventListener('click', (event) => {
      if ((event.target as Element | null)?.closest('.fb-tab')) {
        window.setTimeout(() => this.#show('contents', this.#touch ? 'fbPages.hintContentsTouch' : 'fbPages.hintContentsKey', 'T'), 900);
      }
    }, { signal });

    // A touch on a slip puts it away (the slip carries data-fb-overlay: no tap on the film comes of it).
    this.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
      this.#hide();
    }, { signal });

    queueMicrotask(() => {
      const video = videoIn(container);
      if (!video || signal.aborted) return;
      // Started by a finger, with the hand on the film (flip.ts): once, a moment in, that a swipe flips the pages.
      // (hand.ts marks the player while the last input was a touch. This module arrives with the first touch, which
      // may be the very tap that started the film: a film already playing is taken as just started.)
      const offer = () => {
        if (seen().has('swipe')) return;
        window.setTimeout(() => {
          if (!video.paused && container.hasAttribute('data-fb-touch') && container.hasAttribute('data-fb-flip')) this.#show('swipe', 'fbPages.hintSwipe', '');
        }, 1400);
      };
      video.addEventListener('play', offer, { signal });
      if (!video.paused) offer();
      let last = video.currentTime;
      video.addEventListener('timeupdate', () => {
        if (!video.seeking) last = video.currentTime;
      }, { signal });
      // Going back a little to see something again: the moment a bookmark would have helped.
      video.addEventListener('seeking', () => {
        const back = last - video.currentTime;
        const scrubbing = container.hasAttribute('data-fb-deck');
        if (!scrubbing && back >= 3 && back <= 45 && !ribbonsOf(container).times.length) {
          // On a phone the bookmark key is in Settings, not on the picture (menu.ts): the hint says where.
          const key = container.querySelector<HTMLElement>('.fb-top-key.fb-bookmark, .fb-slab-key.fb-bookmark');
          const onPicture = Array.from(container.querySelectorAll<HTMLElement>('.fb-bookmark')).some((el) => el.getClientRects().length > 0);
          const touch = key && !onPicture ? 'fbPages.hintBookmarkSettings' : 'fbPages.hintBookmarkTouch';
          this.#show('bookmark', this.#touch ? touch : 'fbPages.hintBookmarkKey', 'B');
        }
      }, { signal });
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort?.abort();
    clearTimeout(this.#timer);
    clearTimeout(this.#dragTimer);
  }

  #dragStart() {
    this.#dragAt = performance.now();
    clearTimeout(this.#dragTimer);
    // Half a second into a drag: they're scrubbing, not clicking.
    // Finer is away from the edge: up from its row.
    this.#dragTimer = window.setTimeout(() => this.#show('fine', 'fbPages.hintFine', '', 60000), 500);
  }

  #dragEnd(thrown: boolean) {
    clearTimeout(this.#dragTimer);
    const long = performance.now() - this.#dragAt > 1500;
    const flick = !thrown && long && !seen().has('flick');
    // A long slow drag earns the next lesson: the drag hint gives way to it at once.
    if (this.#showing === 'fine') this.#hide(flick ? 0 : 1200);
    if (flick) window.setTimeout(() => this.#show('flick', 'fbPages.hintFlick', ''), 450);
  }

  #show(hint: Hint, key: PagesKey, cap: string, hold = SHOW) {
    if (seen().has(hint) || this.#showing || !isOn(this.#container, TEACHES[hint])) return;
    const text = this.#text;
    if (!text) return;
    remember(hint);
    const message = tell(this.#i18n, key, { key: '\u0000' });
    const [before, after = ''] = message.split('\u0000');
    text.replaceChildren(before);
    if (message.includes('\u0000')) {
      const kbd = document.createElement('kbd');
      kbd.className = 'fb-keycap';
      kbd.textContent = cap;
      text.append(kbd, after);
    }
    this.#showing = hint;
    this.toggleAttribute('data-open', true);
    this.#say?.(tell(this.#i18n, key, { key: cap }));
    clearTimeout(this.#timer);
    this.#timer = window.setTimeout(() => this.#hide(), hold);
  }

  #hide(after = 0) {
    clearTimeout(this.#timer);
    this.#timer = window.setTimeout(() => {
      this.#showing = null;
      this.toggleAttribute('data-open', false);
    }, after);
  }
}

customElements.define('fb-hints', FbHintsElement);
