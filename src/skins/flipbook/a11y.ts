import { UIElement } from '@videojs/html';
import { I18nController, i18nContext } from '@videojs/html/i18n';
import { videoIn } from './book';
import { say as text } from './i18n';
import { voiceFor } from './pages';
import './a11y.css';

/** The volume popup is closed by Escape: focus goes back to the key it opened from (WCAG 2.4.3). */
interface OpenChange {
  open: boolean;
  reason?: string;
}

type Hoverable = HTMLElement & { disableHoverablePopup?: boolean; closeDelay?: number };
type HoverOpener = HTMLElement & { openOnHover?: boolean };

/** Long enough for the pointer to cross from a key to its tooltip without the tooltip closing (WCAG 1.4.13). */
const TOOLTIP_LINGER = 120;

/**
 * Semantics the skin's markup and Video.js's primitives don't carry on their own, set from one place:
 *
 * - The mute key is a plain toggle. The volume popup opens on hover and focus, so the key needs no popup state; a
 *   "popup button, collapsed" that mutes when pressed misleads (WCAG 4.1.2).
 * - Escape in the volume popup puts focus back on the mute key instead of losing it to the page.
 * - Tooltips stay open while the pointer is on them (WCAG 1.4.13); Escape already closes them.
 * - The poster's large play key is a pointer target only: the bar's play key is the keyboard's, so Tab doesn't stop on
 *   "Play" twice in a row.
 * - The chapter tab and the plate's frame you're on are `aria-current`, as they are drawn; the plate's grid is named
 *   by its title, and a plate laid out again after a move says so (WCAG 4.1.3). The strip's frames are the same.
 */
export class FbA11yElement extends UIElement {
  #abort: AbortController | null = null;
  #observers: MutationObserver[] = [];
  /** What's already watched, so looking again (an extra arrived) doesn't watch it twice. */
  #watched = new WeakSet<Node>();
  #i18n = new I18nController(this, i18nContext);

  connectedCallback() {
    super.connectedCallback();
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    this.hidden = true;
    const container = this.closest<HTMLElement>('media-container');
    if (!container) return;
    // After the rest of the skin has connected: Video.js sets its buttons' attributes as they connect.
    queueMicrotask(() => {
      if (signal.aborted) return;
      this.#mute(container, signal);
      this.#tooltips(container);
      this.#coverPlay(container);
      this.#film(container);
      this.#current(container);
      this.#plate(container);
      this.#waiting(container);
    });
    // The plate is one of the book's extras: it may arrive (or come back) after this has looked.
    for (const type of ['fb-feature-load', 'fb-features']) {
      container.addEventListener(type, () => {
        this.#tooltips(container);
        this.#current(container);
        this.#plate(container);
      }, { signal });
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort?.abort();
    for (const observer of this.#observers) observer.disconnect();
    this.#observers = [];
    this.#watched = new WeakSet();
  }

  #watch(target: Node, options: MutationObserverInit, react: () => void) {
    const observer = new MutationObserver(react);
    observer.observe(target, options);
    this.#observers.push(observer);
    react();
  }

  #mute(container: HTMLElement, signal: AbortSignal) {
    const mute = container.querySelector<HTMLElement>('media-mute-button');
    const popup = container.querySelector<HoverOpener>('media-volume-popover');
    if (!mute) return;
    const POPUP_ARIA = ['aria-haspopup', 'aria-expanded', 'aria-controls'];
    this.#watch(mute, { attributes: true, attributeFilter: POPUP_ARIA }, () => {
      for (const name of POPUP_ARIA) if (mute.hasAttribute(name)) mute.removeAttribute(name);
    });
    if (!popup) return;
    popup.addEventListener('open-change', (event) => {
      const detail = (event as CustomEvent<OpenChange>).detail;
      if (detail?.open || detail?.reason !== 'escape' || !popup.contains(document.activeElement)) return;
      // The popup opens when its key gets focus: hold that back for this one focus, or Escape would reopen it.
      const opens = popup.openOnHover;
      popup.openOnHover = false;
      mute.focus();
      popup.openOnHover = opens;
    }, { signal });
  }

  #tooltips(container: HTMLElement) {
    for (const tip of container.querySelectorAll<Hoverable>('media-tooltip')) {
      tip.disableHoverablePopup = false;
      if (!tip.closeDelay) tip.closeDelay = TOOLTIP_LINGER;
    }
  }

  #coverPlay(container: HTMLElement) {
    const play = container.querySelector<HTMLElement>('.fb-cover-play');
    if (!play) return;
    // Video.js sets tabindex="0" each time the key connects (the player moves into picture-in-picture and back).
    this.#watch(play, { attributes: true, attributeFilter: ['tabindex'] }, () => {
      if (play.getAttribute('tabindex') !== '-1') play.setAttribute('tabindex', '-1');
    });
  }

  /**
   * The film itself is no Tab stop: its keys are the skin's. Firefox makes one of every film, controls or none, and
   * a second inside it, its own picture-in-picture toggle: two presses of Tab on nothing with a name, the first with
   * the browser's own ring (measured, Firefox 157). So there the film is taken out of the order. Not in Chromium or
   * WebKit, which pass a film by: given a tabindex it would take the focus of a press on the picture, which is the
   * player's there. (Told by a property only Firefox answers to: no page can ask a browser what it will Tab to.)
   */
  #film(container: HTMLElement) {
    if (!CSS.supports('-moz-appearance', 'none')) return;
    const film = videoIn(container);
    if (film && !film.controls && !film.hasAttribute('tabindex')) film.tabIndex = -1;
  }

  /** `data-current` drawn on a tab or a frame is `aria-current` to a screen reader. */
  #current(container: HTMLElement) {
    for (const root of container.querySelectorAll<HTMLElement>('fb-tabs, fb-plate')) {
      if (this.#watched.has(root)) continue;
      this.#watched.add(root);
      this.#watch(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-current'] }, () => {
        for (const item of root.querySelectorAll<HTMLElement>('.fb-tab, .fb-plate-cell, .fb-strip-cell')) {
          const current = item.hasAttribute('data-current');
          if (current && item.getAttribute('aria-current') !== 'true') item.setAttribute('aria-current', 'true');
          else if (!current && item.hasAttribute('aria-current')) item.removeAttribute('aria-current');
        }
      });
    }
  }

  /**
   * Waiting for the film: the riffling pages are drawn, and "Loading" is said once, politely, as they appear (the
   * status announcer covers play, pause and the rest, not this). Under reduced motion the pages stand still, and this
   * is how the wait is told (WCAG 4.1.3).
   */
  #waiting(container: HTMLElement) {
    const indicator = container.querySelector<HTMLElement>('.media-buffering-indicator');
    if (!indicator) return;
    const say = voiceFor(container);
    let shown = indicator.hasAttribute('data-visible');
    this.#watch(indicator, { attributes: true, attributeFilter: ['data-visible'] }, () => {
      const now = indicator.hasAttribute('data-visible');
      if (now === shown) return;
      shown = now;
      if (now) say(text(this.#i18n, 'flipbook.loading'));
    });
  }

  #plate(container: HTMLElement) {
    const plate = container.querySelector<HTMLElement>('fb-plate');
    // Not until the plate has arrived and built its grid; once per plate.
    if (!plate?.querySelector('.fb-plate-grid') || this.#watched.has(plate.firstElementChild ?? plate)) return;
    this.#watched.add(plate.firstElementChild ?? plate);
    const grid = plate.querySelector<HTMLElement>('.fb-plate-grid');
    const title = plate.querySelector<HTMLElement>('.fb-plate-title');
    if (grid && title) {
      title.id ||= `${container.id || 'fb'}-plate-title-${Math.random().toString(36).slice(2, 8)}`;
      grid.setAttribute('aria-labelledby', title.id);
    }
    const say = voiceFor(container);
    let open = container.hasAttribute('data-fb-plate');
    this.#watch(container, { attributes: true, attributeFilter: ['data-fb-plate'] }, () => {
      const now = container.hasAttribute('data-fb-plate');
      if (now === open) return;
      open = now;
      // Opened by P or its key, focus is already in it and the dialog's name is read; laid out again after a move
      // (the film scrubbed with the plate open), it is said.
      const sheet = plate.querySelector<HTMLElement>('.fb-plate-sheet');
      if (now && sheet && !sheet.contains(document.activeElement)) say(sheet.getAttribute('aria-label') ?? '');
    });
  }
}

customElements.define('fb-a11y', FbA11yElement);
