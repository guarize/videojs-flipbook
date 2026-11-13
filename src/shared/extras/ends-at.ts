import {
  type PropertyValues,
  PlayerController,
  playerContext,
  selectPlaybackRate,
  selectTime,
  UIElement,
} from '@videojs/html';
import { clock, text } from './i18n';

/** Under this much time left (at the current rate), a countdown says more than a clock time that barely moves. */
const COUNTDOWN_BELOW = 600;

/**
 * When the video will finish, from the time left and the playback rate: "Ends 21:42" on the viewer's clock, or
 * "Done in 0:38" when less than ten minutes are left, so a speed change shows at once. It answers the question
 * speed controls raise ("if I watch at 1.5×, when am I done?"). Text is written only when it changes.
 */
export class XEndsAtElement extends UIElement {
  #time = new PlayerController(this, playerContext, selectTime);
  #rate = new PlayerController(this, playerContext, selectPlaybackRate);
  // Made when a clock time is first written: the first Intl formatter costs about 10 ms, which this element would
  // otherwise spend in its constructor, inside the task that connects the whole player.
  #format: Intl.DateTimeFormat | null = null;
  #timer = 0;

  connectedCallback() {
    super.connectedCallback();
    // The clock moves even while paused: check every second (the text only changes when its words do).
    this.#timer = window.setInterval(() => this.#write(), 1000);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearInterval(this.#timer);
  }

  update(changed: PropertyValues) {
    super.update(changed);
    this.#write();
  }

  #clock() {
    this.#format ??= new Intl.DateTimeFormat(document.documentElement.lang || undefined, { hour: 'numeric', minute: '2-digit' });
    return this.#format;
  }

  #write() {
    const time = this.#time.value;
    const rate = this.#rate.value?.playbackRate || 1;
    const left = time?.duration ? Math.max(0, time.duration - time.currentTime) / rate : 0;
    // Nothing to say before the length is known, or once it's over.
    if (left < 0.5) {
      if (this.textContent) this.textContent = '';
      return;
    }
    const label =
      left < COUNTDOWN_BELOW
        ? text('doneIn', { time: clock(Math.ceil(left)) })
        : text('endsAt', { time: this.#clock().format(new Date(Date.now() + left * 1000)) });
    if (this.textContent !== label) this.textContent = label;
  }
}

customElements.define('x-ends-at', XEndsAtElement);
