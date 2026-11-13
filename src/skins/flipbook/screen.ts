import { UIElement } from '@videojs/html';
import { videoIn } from './book';
import { attach } from './companion';

type Doc = Document & { webkitFullscreenEnabled?: boolean; webkitFullscreenElement?: Element | null };
type Orientation = ScreenOrientation & { lock?: (orientation: string) => Promise<void> };

/** Whether this page may put an element in fullscreen. An iPhone's may not: only its own video player gets the screen. */
function elementFullscreen(): boolean {
  const doc = document as Doc;
  return !!(doc.fullscreenEnabled || doc.webkitFullscreenEnabled);
}

/**
 * Filling the screen, with the book's own controls, everywhere.
 *
 * Where the page can ask for fullscreen (every desktop browser, Android, iPadOS) Video.js does, on the player's
 * container, and this only turns the screen with the film: a landscape film asks the phone for landscape while it
 * has the screen, and lets go when it leaves. A browser that refuses is left alone.
 *
 * An iPhone gives fullscreen to no element but a video, in its own player: Video.js falls back to that, and the
 * book's controls, captions and pages would be gone. So there the fullscreen key (and F, and a double tap) makes
 * the player fill the window instead: fixed over the page, in the top layer where the browser has popovers, the
 * page behind held still. It is the same layout as fullscreen (`data-fb-screen`, room.ts), with the notch's and the
 * home indicator's insets. Escape, or the key again, puts it back. Turn the phone and it is landscape.
 */
export class FbScreenElement extends UIElement {
  #abort: AbortController | null = null;
  #container: HTMLElement | null = null;
  #scroll: string | null = null;
  #locked = false;

  connectedCallback() {
    super.connectedCallback();
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    this.hidden = true;
    const container = this.closest<HTMLElement>('media-container');
    this.#container = container;
    if (!container) return;

    const ours = () => !elementFullscreen() || this.filled;
    container.addEventListener('click', (event) => {
      const key = (event.target as Element | null)?.closest?.('media-fullscreen-button');
      if (!key || !container.contains(key) || !ours()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.toggle();
    }, { capture: true, signal });
    container.addEventListener('keydown', (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const typing = (event.target as Element | null)?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
      if ((event.key === 'f' || event.key === 'F') && !typing && ours()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.toggle();
      } else if (event.key === 'Escape' && this.filled && !event.defaultPrevented && !(event.target as Element | null)?.closest?.('[aria-modal="true"], .media-popup')) {
        event.preventDefault();
        this.toggle(false);
      }
    }, { capture: true, signal });

    // With no fullscreen of any kind (a frame the page didn't allow it in, some in-app browsers) Video.js hides and
    // disables its key. The fill needs no permission: the key stays, and fills the frame.
    queueMicrotask(() => {
      const key = container.querySelector<HTMLElement>('media-fullscreen-button');
      if (!key || signal.aborted || elementFullscreen()) return;
      // (phone.css shows the key again on this mark.)
      container.toggleAttribute('data-fb-fillable', true);
      const keep = () => {
        if (key.hasAttribute('hidden')) key.removeAttribute('hidden');
        if (key.getAttribute('aria-disabled') === 'true') key.removeAttribute('aria-disabled');
      };
      const watch = new MutationObserver(keep);
      watch.observe(key, { attributes: true, attributeFilter: ['hidden', 'aria-disabled'] });
      signal.addEventListener('abort', () => watch.disconnect());
      keep();
    });

    for (const type of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(type, () => this.#turn(), { signal });
    signal.addEventListener('abort', () => {
      if (this.filled) this.toggle(false);
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort?.abort();
  }

  /** Whether the player fills the window by itself (not the browser's fullscreen). */
  get filled(): boolean {
    return !!this.#container?.hasAttribute('data-fb-fill');
  }

  toggle(on = !this.filled) {
    const container = this.#container;
    if (!container || on === this.filled) return;
    const root = document.documentElement;
    if (on) {
      container.toggleAttribute('data-fb-fill', true);
      // The top layer, where there is one: over the page whatever its stacking, and out of any transformed parent.
      try {
        container.setAttribute('popover', 'manual');
        container.showPopover();
      } catch {
        container.removeAttribute('popover');
      }
      this.#scroll = root.style.overflow;
      root.style.overflow = 'hidden';
    } else {
      try {
        if (container.matches(':popover-open')) container.hidePopover();
      } catch {
        // No popovers here: it was fixed in place, and the attribute going is enough.
      }
      container.removeAttribute('popover');
      container.toggleAttribute('data-fb-fill', false);
      root.style.overflow = this.#scroll ?? '';
      this.#scroll = null;
    }
    const key = container.querySelector<HTMLElement>('media-fullscreen-button');
    key?.toggleAttribute('data-fb-filled', on);
    container.dispatchEvent(new CustomEvent('fb-fill', { detail: { filled: on } }));
    // Focus stays on the key that was pressed (showing a popover may have moved it).
    if (key && document.activeElement !== key && container.contains(document.activeElement)) key.focus({ preventScroll: true });
  }

  /** A landscape film turns the phone with it while it has the screen. Fails quietly wherever that isn't allowed. */
  #turn() {
    const container = this.#container;
    const doc = document as Doc;
    const orientation = screen.orientation as Orientation | undefined;
    if (!container || !orientation) return;
    const element = doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
    const full = element === container;
    const video = videoIn(container);
    try {
      if (full && video && video.videoWidth > video.videoHeight && matchMedia('(pointer: coarse)').matches && typeof orientation.lock === 'function') {
        this.#locked = true;
        void orientation.lock('landscape').catch(() => {
          this.#locked = false;
        });
      } else if (!full && this.#locked) {
        this.#locked = false;
        orientation.unlock();
      }
    } catch {
      this.#locked = false;
    }
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('fb-screen')) customElements.define('fb-screen', FbScreenElement);
attach('fb-screen');
