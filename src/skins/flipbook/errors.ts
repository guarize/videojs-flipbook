import { type PropertyValues, PlayerController, playerContext, selectError, UIElement } from '@videojs/html';
import { I18nController, i18nContext } from '@videojs/html/i18n';
import { videoIn } from './book';
import { attach } from './companion';
import { type FlipbookKey, say } from './i18n';
import { open } from './sources';

/** The media error codes (HTMLMediaElement's `MediaError`), in the skin's own words: what happened, and what to do. */
const WORDS: Record<number, FlipbookKey> = {
  1: 'flipbook.errorAborted',
  2: 'flipbook.errorNetwork',
  3: 'flipbook.errorDecode',
  4: 'flipbook.errorSource',
  5: 'flipbook.errorEncrypted',
};

/** The same, where the dialog has its retry (the `states` detail, details.ts): what to do is the key beside the words. */
const WORDS_RETRY: Record<number, FlipbookKey> = {
  1: 'flipbook.missAborted',
  2: 'flipbook.missNetwork',
  3: 'flipbook.missDecode',
  4: 'flipbook.missSource',
  5: 'flipbook.errorEncrypted',
};
/** A film that can't be unlocked here won't be on a second try: no retry for it. */
const NO_RETRY = 5;
/** An error raised before the player was listening is looked for this many frames after this joins the player (the
 *  player is listening a microtask after it connects; a second is room for any order of arrival). */
const CATCH_UP = 60;

/**
 * The error dialog's words. Video.js shows a known error code's translated message, but a browser that sends its own
 * text with the error (Chromium's "MEDIA_ELEMENT_ERROR: Format error", "PipelineStatus::DEMUXER_ERROR…") has it shown
 * as written. So the skin authors the dialog's title and description (skin.html carries English text in both, which
 * tells Video.js they're the skin's), and here every code, known or not, gets the skin's sober wording through the
 * player's translator (i18n.ts, `flipbook.error*`): what happened, and what to do. The browser's text never shows.
 *
 * It also sees that the dialog opens at all. Video.js learns of an error from the film's `error` event, and only
 * from the moment the player is listening: a film refused at once (a 404 on a page that builds the player off the
 * document, or whose script arrives after its markup) has raised its error by then, and the dialog never opened
 * (on the showcase, in Chromium, it opened in 9 loads of 20 for a 404 and 3 of 20 for a refused connection). So when
 * this joins a player whose film already carries an error the player has not heard, the event is raised again, once
 * the player is listening. An error the viewer has closed is not brought back: each error is raised here once.
 *
 * And the words follow what they depend on, in whatever order it arrives: the `states` detail (details.ts resolves
 * it when its own element joins the player) and the page's number (edge.ts prints it once the storyboard has loaded).
 */
export class FbErrorsElement extends UIElement {
  #error = new PlayerController(this, playerContext, selectError);
  #i18n = new I18nController(this, i18nContext);

  /** The player's store itself (no subscription): what it is listening to. */
  #store = new PlayerController(this, playerContext);
  #abort: AbortController | null = null;
  /** The error the player has heard, or that was raised for it here: it is not raised again. */
  #heard: object | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.hidden = true;
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    const container = this.closest<HTMLElement>('media-container');
    if (!container) return;
    // What the words are set from, when it changes under an error that is already up: the details, and the page's
    // number on its stamp (watched from when it joins the player; watching it twice changes nothing).
    const again = new MutationObserver(() => {
      const stamp = container.querySelector(':scope > .fb-stamp');
      if (stamp) again.observe(stamp, { childList: true, characterData: true, subtree: true });
      this.#words(container);
    });
    again.observe(container, { attributes: true, attributeFilter: ['data-fb-details'], childList: true });
    signal.addEventListener('abort', () => again.disconnect());
    queueMicrotask(() => this.#catchUp(signal, CATCH_UP));
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort?.abort();
  }

  /**
   * The film's error, if it raised one before the player was listening: raised again for the player to hear. Until
   * the player has a film to listen to, looked at again next frame.
   */
  #catchUp(signal: AbortSignal, tries: number) {
    if (signal.aborted) return;
    // (The `<video>`, or the element that speaks for one, such as `<mux-video>`; one that can fail carries `error`.)
    const film: (EventTarget & { error?: object | null }) | null | undefined = this.#store.value?.target?.media;
    if (!film) {
      if (tries > 0) requestAnimationFrame(() => this.#catchUp(signal, tries - 1));
      return;
    }
    const error = film.error;
    if (!error || error === this.#heard || this.#error.value?.error) return;
    this.#heard = error;
    film.dispatchEvent(new Event('error'));
  }

  update(changed: PropertyValues) {
    super.update(changed);
    const container = this.closest<HTMLElement>('media-container');
    if (!container) return;
    this.#heard = this.#error.value?.error ?? this.#heard;
    this.#words(container);
  }

  /** The dialog's title, its line and its retry key, for the error the player holds. Nothing without one. */
  #words(container: HTMLElement) {
    const error = this.#error.value?.error;
    if (!error) return;
    const set = (selector: string, text: string) => {
      const part = container.querySelector<HTMLElement>(selector);
      if (part && part.textContent !== text) part.textContent = text;
    };
    // The missing page (details.ts, `states`): the same dialog with a way back in it, and the words to match.
    const states = (container.getAttribute('data-fb-details') ?? '').split(/\s+/).includes('states');
    const retry = states && error.code !== NO_RETRY;
    const offline = states && error.code === 2 && typeof navigator !== 'undefined' && navigator.onLine === false;
    const words = offline ? 'flipbook.missOffline' : ((states ? WORDS_RETRY : WORDS)[error.code] ?? (states ? 'flipbook.missUnknown' : 'flipbook.errorUnknown'));
    set('media-error-dialog media-dialog-title', say(this.#i18n, 'flipbook.errorTitle'));
    set('media-error-dialog media-dialog-description', say(this.#i18n, words));
    this.#retry(container, retry);
  }

  /** The retry key, beside the dialog's close key while the missing page is on; gone with it. */
  #retry(container: HTMLElement, on: boolean) {
    const popup = container.querySelector<HTMLElement>('media-error-dialog media-dialog-popup');
    let key = popup?.querySelector<HTMLButtonElement>('.fb-error-retry') ?? null;
    if (!on || !popup) {
      key?.remove();
      return;
    }
    if (!key) {
      key = document.createElement('button');
      key.type = 'button';
      key.className = 'media-button fb-error-retry';
      key.addEventListener('click', () => this.#again(container));
      popup.insertBefore(key, popup.querySelector('media-dialog-close'));
    }
    const text = say(this.#i18n, 'flipbook.errorRetry');
    if (key.textContent !== text) key.textContent = text;
    // Where the film stopped, printed where the page's number would be: the page that is missing.
    const page = container.querySelector(':scope > .fb-stamp')?.textContent ?? '';
    if (popup.getAttribute('data-fb-page') !== page) popup.setAttribute('data-fb-page', page);
  }

  /** Loads the film again and takes it back to where it stopped. A second failure opens the dialog again. */
  #again(container: HTMLElement) {
    const video = videoIn(container);
    const at = video?.currentTime ?? 0;
    this.#error.value?.dismissError();
    if (!video) return;
    video.addEventListener(
      'loadedmetadata',
      () => {
        if (at > 0) video.currentTime = at;
        void video.play().catch(() => undefined);
      },
      { once: true },
    );
    // (Asked again through `open`, not `load()`: see sources.ts for the iPhone that needs the tracks out of the way.)
    open(video, video.getAttribute('src') ?? undefined);
    container.focus({ preventScroll: true });
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('fb-errors')) customElements.define('fb-errors', FbErrorsElement);
attach('fb-errors');
