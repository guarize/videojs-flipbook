import { PlayerController, playerContext, selectPiP, UIElement } from '@videojs/html';
import { videoIn } from './book';
import { attach, claim, currentOwner, inPip, onOwner } from './companion';

/**
 * The player's own PiP key. pip.ts (built alongside) wraps its `activate` to open the Document picture-in-picture
 * window where the browser has one; without pip.ts it asks Video.js for the browser's plain video window. Going through
 * it keeps one way in and out, whichever of the two is there.
 */
type PipKey = HTMLElement & { activate?: () => unknown };

/**
 * Picture-in-picture by itself when you switch tabs, in Chrome: while the film plays and the tab goes out of sight,
 * Chrome asks the page (the Media Session's `enterpictureinpicture` action) and the film goes to a window. Coming back
 * to the tab brings it home, if it went on its own; a window you opened yourself stays open. Elsewhere this is
 * silent: the action doesn't exist and nothing is registered.
 */
export class FbAutoPipElement extends UIElement {
  #pip = new PlayerController(this, playerContext, selectPiP);
  #abort: AbortController | null = null;
  #container: HTMLElement | null = null;
  #video: HTMLVideoElement | null = null;
  #auto = false;

  connectedCallback() {
    super.connectedCallback();
    if (!('mediaSession' in navigator)) return;
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    const container = this.closest<HTMLElement>('media-container');
    this.#container = container;
    if (!container) return;
    const stop = onOwner((owner) => {
      if (owner === container) this.#register();
    });
    signal.addEventListener('abort', stop);
    queueMicrotask(() => {
      const video = videoIn(container);
      if (!video || signal.aborted) return;
      this.#video = video;
      video.addEventListener('play', () => claim(container), { signal });
      const left = () => {
        this.#auto = false;
      };
      video.addEventListener('leavepictureinpicture', left, { signal });
      container.addEventListener('fb-pip-leave', left, { signal });
      document.addEventListener('visibilitychange', () => this.#back(), { signal });
      if (currentOwner() === container) this.#register();
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort?.abort();
  }

  #register() {
    try {
      navigator.mediaSession.setActionHandler('enterpictureinpicture' as MediaSessionAction, () => this.#enter());
    } catch {
      // Not Chrome, or a Chrome without automatic picture-in-picture: nothing to do.
    }
  }

  #enter() {
    const container = this.#container;
    const video = this.#video;
    if (!container || !video || currentOwner() !== container || video.paused || inPip(container, video)) return;
    this.#auto = true;
    try {
      const key = container.querySelector<PipKey>('media-pip-button');
      const opened = typeof key?.activate === 'function' ? key.activate() : this.#pip.value?.requestPictureInPicture();
      void Promise.resolve(opened).catch(() => {
        this.#auto = false;
      });
    } catch {
      this.#auto = false;
    }
  }

  /** Back on the tab: a window that opened on its own closes again. */
  #back() {
    const container = this.#container;
    const video = this.#video;
    if (document.visibilityState !== 'visible' || !this.#auto || !container) return;
    this.#auto = false;
    // The Document window (pip.ts): its key closes it.
    if (container.getAttribute('data-fb-pip') === 'document') {
      const key = container.querySelector<PipKey>('media-pip-button');
      if (typeof key?.activate === 'function') void Promise.resolve(key.activate()).catch(() => undefined);
      return;
    }
    if (video && document.pictureInPictureElement === video) void this.#pip.value?.exitPictureInPicture().catch(() => undefined);
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('fb-autopip')) customElements.define('fb-autopip', FbAutoPipElement);
attach('fb-autopip');
