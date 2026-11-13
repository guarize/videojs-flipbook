import { PlayerController, playerContext, selectTextTrack, UIElement } from '@videojs/html';
import { videoIn } from './book';
import { attach } from './companion';
import './pip-captions.css';

const isCaption = (track: TextTrack) => track.kind === 'captions' || track.kind === 'subtitles';

/**
 * Captions inside the browser's own picture-in-picture window. The skin draws captions itself (captions.ts) and hides
 * the browser's rendering, so in the plain video window they'd be gone. While the film is in that window,
 * `data-fb-pip-captions` lets the browser's rendering through (pip-captions.css), and the skin's own layer steps
 * aside, so the page never shows them twice. The track that's on stays the one Video.js chose: when captions are on
 * but their track is only `hidden`, it's shown for the window and put back on the way out.
 *
 * The Document picture-in-picture window (pip.ts) carries the whole player, captions included, and needs none of this.
 */
export class FbPipCaptionsElement extends UIElement {
  #textTracks = new PlayerController(this, playerContext, selectTextTrack);
  #abort: AbortController | null = null;
  #container: HTMLElement | null = null;
  #raised: TextTrack[] = [];

  connectedCallback() {
    super.connectedCallback();
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    const container = this.closest<HTMLElement>('media-container');
    this.#container = container;
    if (!container) return;
    queueMicrotask(() => {
      const video = videoIn(container);
      if (!video || signal.aborted) return;
      video.addEventListener('enterpictureinpicture', () => this.#enter(video), { signal });
      video.addEventListener('leavepictureinpicture', () => this.#leave(), { signal });
      // WebKit's own presentation mode, where the standard events don't fire.
      video.addEventListener(
        'webkitpresentationmodechanged',
        () => {
          const mode = (video as HTMLVideoElement & { webkitPresentationMode?: string }).webkitPresentationMode;
          if (mode === 'picture-in-picture') this.#enter(video);
          else this.#leave();
        },
        { signal },
      );
      if (document.pictureInPictureElement === video) this.#enter(video);
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort?.abort();
    this.#leave();
  }

  #enter(video: HTMLVideoElement) {
    const container = this.#container;
    if (!container) return;
    container.toggleAttribute('data-fb-pip-captions', true);
    const tracks = Array.from(video.textTracks).filter(isCaption);
    // Captions on, by Video.js's account, with no track the browser would draw: show the one that's selected.
    if (this.#textTracks.value?.subtitlesShowing && !tracks.some((t) => t.mode === 'showing')) {
      const chosen = tracks.find((t) => t.mode === 'hidden');
      if (chosen) {
        chosen.mode = 'showing';
        this.#raised.push(chosen);
      }
    }
  }

  #leave() {
    this.#container?.toggleAttribute('data-fb-pip-captions', false);
    for (const track of this.#raised) if (track.mode === 'showing') track.mode = 'hidden';
    this.#raised = [];
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('fb-pip-captions')) customElements.define('fb-pip-captions', FbPipCaptionsElement);
attach('fb-pip-captions');
