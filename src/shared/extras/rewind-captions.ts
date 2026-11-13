import { type PropertyValues, PlayerController, playerContext, selectTextTrack, UIElement } from '@videojs/html';
import { findMedia, videoOf } from '../storyboard';

/** How far back counts as "what did they say?", and how long the captions stay. */
const REWIND_MAX = 30;
const SHOW_FOR = 10_000;

/**
 * Going back a little turns the captions on for a while: the "what did they say?" moment, which Apple's TV app
 * handles and web players don't. Only when captions were off, only for short jumps back (not a restart) in a film
 * that is playing (a paused film read back a page or a frame at a time has nothing said to catch), and they go off
 * again by themselves unless the viewer touched them in between. Renders nothing.
 */
export class XRewindCaptionsElement extends UIElement {
  #tracks = new PlayerController(this, playerContext, selectTextTrack);
  #video: HTMLVideoElement | null = null;
  #last = 0;
  #timer = 0;
  #ours = false;
  #abort: AbortController | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.hidden = true;
    queueMicrotask(() => this.#bind());
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort?.abort();
    clearTimeout(this.#timer);
  }

  update(changed: PropertyValues) {
    super.update(changed);
    // The viewer turned captions off (or on) themselves: the timer is no longer ours to keep.
    if (this.#ours && !this.#tracks.value?.subtitlesShowing) this.#forget();
  }

  #bind() {
    const container = this.closest('media-container');
    this.#video = videoOf(container ? findMedia(container) : null);
    const video = this.#video;
    if (!video) return;
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    video.addEventListener('timeupdate', () => {
      if (!video.seeking) this.#last = video.currentTime;
    }, { signal });
    video.addEventListener('seeking', () => {
      const back = this.#last - video.currentTime;
      const tracks = this.#tracks.value;
      if (!tracks || video.paused || back < 1 || back > REWIND_MAX || video.currentTime < 1) return;
      if (!tracks.subtitlesShowing) {
        tracks.toggleSubtitles(true);
        this.#ours = true;
      }
      if (!this.#ours) return;
      clearTimeout(this.#timer);
      this.#timer = window.setTimeout(() => {
        if (this.#ours && this.#tracks.value?.subtitlesShowing) this.#tracks.value.toggleSubtitles(false);
        this.#forget();
      }, SHOW_FOR);
    }, { signal });
  }

  #forget() {
    this.#ours = false;
    clearTimeout(this.#timer);
  }
}

customElements.define('x-rewind-captions', XRewindCaptionsElement);
