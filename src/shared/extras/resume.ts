import { type PropertyValues, PlayerController, playerContext, selectPlayback, selectTime, UIElement } from '@videojs/html';
import { findMedia } from '../storyboard';
import { clock, text } from './i18n';
import { EDGE, type Place, placeFits, readPlace } from './place';

/** Resume a little before where they stopped, so the sentence they were in starts again. */
const CONTEXT = 3;
/**
 * "Resume from 0:42": where the viewer stopped last time, kept per video in this browser, offered once before play.
 * Resuming starts a few seconds earlier, for context. Starting playback any other way puts the offer away.
 *
 * The place is kept under the film's address, with the film's length: an address can come to serve another film, and
 * a place in the old one means nothing in the new. So the offer waits until the film's length is known, and a place
 * kept for a film of another length (or with no length, as they were first kept) is forgotten, not offered.
 *
 * The skin may author buttons with `[data-x-part="resume"]` and `[data-x-part="restart"]` and a `[data-x-part="time"]`
 * inside; otherwise they are created. The element is `hidden` while there is nothing to offer.
 */
export class XResumeElement extends UIElement {
  #time = new PlayerController(this, playerContext, selectTime);
  #playback = new PlayerController(this, playerContext, selectPlayback);
  #key = '';
  #saved = 0;
  /** A place read from storage, not yet held against the film's length. */
  #found: Place | null = null;
  #lastWrite = 0;
  #abort: AbortController | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.hidden = true;
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;

    let resume = this.querySelector<HTMLButtonElement>('[data-x-part="resume"]');
    let restart = this.querySelector<HTMLButtonElement>('[data-x-part="restart"]');
    if (!resume) {
      resume = document.createElement('button');
      resume.type = 'button';
      resume.dataset.xPart = 'resume';
      resume.innerHTML = `${text('resumeFrom', { time: '<span data-x-part="time"></span>' })}`;
      this.append(resume);
    }
    if (!restart) {
      restart = document.createElement('button');
      restart.type = 'button';
      restart.dataset.xPart = 'restart';
      restart.textContent = text('startOver');
      this.append(restart);
    }
    // Authored but empty buttons get the default words, so the offer is never a blank chip.
    if (!resume.textContent?.trim()) {
      resume.innerHTML = text('resumeFrom', { time: '<span data-x-part="time"></span>' });
    }
    if (!restart.textContent?.trim()) restart.textContent = text('startOver');
    resume.addEventListener('click', () => {
      const time = this.#time.value;
      void time?.seek(Math.max(0, this.#saved - CONTEXT));
      void this.#playback.value?.play();
      this.#dismiss();
    }, { signal });
    restart.addEventListener('click', () => {
      this.#clear();
      void this.#time.value?.seek(0);
      void this.#playback.value?.play();
      this.#dismiss();
    }, { signal });

    queueMicrotask(() => this.#load());
    window.addEventListener('pagehide', () => this.#write(true), { signal });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#write(true);
    this.#abort?.abort();
  }

  update(changed: PropertyValues) {
    super.update(changed);
    const playback = this.#playback.value;
    this.#offer();
    if (playback && !playback.paused && !this.hidden) this.#dismiss();
    if (playback?.paused) this.#write(true);
    else this.#write(false);
  }

  #load() {
    const container = this.closest('media-container');
    const host = container ? findMedia(container) : null;
    // (A film given several sources is named by the first of them, whichever plays: `data-fb-film`, sources.ts.)
    const src = host?.getAttribute('data-fb-film') || host?.getAttribute('src') || '';
    if (!src) return;
    this.#key = `x-resume:${new URL(src, location.href).pathname}`;
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(this.#key);
    } catch {
      return;
    }
    if (raw == null) return;
    this.#found = readPlace(raw);
    if (!this.#found) this.#clear();
    this.#offer();
  }

  /** Offers the place that was found, once the film's length says it is this film's; forgets it if it is not. */
  #offer() {
    const found = this.#found;
    const duration = this.#time.value?.duration;
    if (!found || !duration) return;
    this.#found = null;
    if (!placeFits(found, duration)) {
      this.#clear();
      return;
    }
    this.#saved = found.t;
    for (const node of this.querySelectorAll<HTMLElement>('[data-x-part="time"]')) node.textContent = clock(found.t);
    const resume = this.querySelector('[data-x-part="resume"]');
    resume?.setAttribute('aria-label', text('resumeFrom', { time: clock(found.t) }));
    if (!this.#playback.value?.started) this.hidden = false;
  }

  #write(force: boolean) {
    const time = this.#time.value;
    // Before playback starts the position is the page's, not the viewer's: leave the saved one alone.
    if (!this.#key || !time?.duration || !this.#playback.value?.started) return;
    const now = Date.now();
    if (!force && now - this.#lastWrite < 5000) return;
    this.#lastWrite = now;
    try {
      if (time.currentTime < EDGE || time.currentTime > time.duration - EDGE) localStorage.removeItem(this.#key);
      else localStorage.setItem(this.#key, JSON.stringify({ t: Math.floor(time.currentTime), d: Math.round(time.duration * 1000) / 1000 } satisfies Place));
    } catch {
      // Storage blocked: resuming simply isn't offered.
    }
  }

  #clear() {
    try {
      localStorage.removeItem(this.#key);
    } catch {
      // Nothing to clear.
    }
  }

  #dismiss() {
    this.hidden = true;
  }
}

customElements.define('x-resume', XResumeElement);
