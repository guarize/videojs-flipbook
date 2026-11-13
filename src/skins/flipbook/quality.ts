import type { I18nController } from '@videojs/html/i18n';
import { reducedMotion } from './book';
import { say } from './i18n';
import { storageKey, voiceFor } from './pages';
import { atHeight, heightAt, heightsIn, keptChoice, nameOf, under } from './renditions';
import { frameClock } from './shown';
import { HUSHED, ceiling, fitsHere, open, outgrown } from './sources';

/**
 * Quality, in Settings: Auto and each height the stream offers (renditions.ts), for a film whose address takes Mux's
 * resolution limits. Fetched only for such a film, and only once someone is at the player (menu.ts).
 *
 * A choice is the same stream asked again at one height, so the film is loaded anew, and the viewer must not see it:
 *
 * - The picture is held. The frame on screen is kept on a canvas over the film (and the hand's stand-in, where there
 *   is one, is asked to the same moment under it: flip.ts) until the new stream shows that very moment; then the
 *   canvas fades in 150 ms. Never black, never the poster, never another frame.
 * - The player is not told of the emptiness between. While the new stream opens, the film's `emptied`, `loadstart`
 *   and its length gone are kept from the player's store and the skin's parts (a listener that hears them first), and
 *   the clock reads the moment the film is going back to: the ribbon, the page number, the paused print stay as they
 *   are. Playing or paused, speed, volume and captions are the film element's own and stay; speed is set again.
 * - It waits like the film waits: the three riffling pages (the buffering indicator), after a moment.
 * - A height that cannot be loaded gives way to Auto, said once in the skin's voice; the film goes on.
 *
 * The choice is kept for the film in this browser, and dropped when the film no longer offers it.
 *
 * Auto's ceiling (fit.ts). Where the pointer can hover the stream is opened for all the screen can show, and there
 * is nothing to do here. On a touch screen it is first opened asking no taller than its box can show, and what is
 * left for here is a film whose box grows past that ceiling (a phone turned, the player taking the screen): Auto is
 * asked again under the screen's ceiling the same way a choice is, the frame held, the same moment. Unseen while the
 * film is paused; about a second of held frame while it plays. It is never lowered for a box that shrinks (a reload
 * for nothing), and never changed at the press of a film that is already playing.
 */

/** A stream that has not shown the moment this long after it was asked is taken as failed. */
const SWITCH_LIMIT = 15_000;
/** Once the new stream is ready at the moment, its frame is waited for this long at most before the hold lets go. */
const FRAME_PATIENCE = 1500;
/** The waiting pages come up if the switch is still under way after this. */
const WAIT_AFTER = 400;
const LEAVE = 150;
/** A frame is the one for a moment within this of it (seconds). */
const HAIR = 0.005;
/** The widest the held frame is kept at: a 4K frame held at its own size would be 33 MB for a moment's use. */
const HOLD_WIDTH = 1920;
/** A box that is changing size (a window dragged larger, fullscreen opening) is read once it has been still this long. */
const SETTLE = 300;

type Radios = HTMLElement & { value?: string };

export class Quality {
  #container: HTMLElement;
  #video: HTMLVideoElement;
  #i18n: () => I18nController | null;
  #abort = new AbortController();
  /** The stream's address with no limits, the one Auto plays from (as the page opened it), and the heights it offers. */
  #base: string;
  #auto: string;
  /** Whether Auto's ceiling is the skin's own (sources.ts), and so is lifted when the film's box outgrows it. */
  #fitted: boolean;
  #heights: number[] = [];
  #choice: number | null = null;
  #run = 0;
  #held: HTMLCanvasElement | null = null;

  constructor(container: HTMLElement, video: HTMLVideoElement, src: string, i18n: () => I18nController | null) {
    this.#container = container;
    this.#video = video;
    this.#i18n = i18n;
    this.#base = atHeight(src, null);
    this.#choice = heightAt(src);
    // (Auto is the address the film was opened with: a stream comes under a ceiling of the skin's, sources.ts.)
    this.#auto = this.#choice == null ? src : this.#base;
    this.#fitted = fitsHere(video, src);
    void this.#offer();
  }

  /** Puts the page away: the film plays from something else now (sources.ts), or the player has gone. */
  destroy() {
    this.#abort.abort();
    this.#run++;
    this.#release(false);
    this.#trigger?.removeAttribute('data-fb-quality');
    this.#trigger?.toggleAttribute('data-hidden', true);
    this.#container.removeAttribute('data-fb-quality');
    this.#group?.replaceChildren();
  }

  get #trigger() {
    return this.#container.querySelector<HTMLElement>('.fb-menu-quality');
  }

  get #group() {
    return this.#container.querySelector<Radios>('.fb-menu-quality-group');
  }

  get #key() {
    return storageKey(this.#container, 'fb-quality');
  }

  /** Reads the stream's renditions once and, with two or more, lays the page out. With fewer there is no page. */
  async #offer() {
    const { signal } = this.#abort;
    try {
      const response = await fetch(new URL(this.#base, document.baseURI).href, { signal });
      this.#heights = response.ok ? heightsIn(await response.text()) : [];
    } catch {
      this.#heights = [];
    }
    const group = this.#group;
    if (signal.aborted || !group || this.#heights.length < 2) return;
    group.replaceChildren(...[null, ...this.#heights].map((height) => this.#item(height)));
    group.addEventListener('value-change', () => {
      const height = group.value === 'auto' ? null : Number(group.value);
      if (height !== this.#choice) void this.#switch(height, true);
    }, { signal });
    for (const type of ['resize', 'loadedmetadata']) this.#video.addEventListener(type, () => this.#show(), { signal });
    if (this.#fitted) {
      let settling = 0;
      const box = new ResizeObserver(() => {
        clearTimeout(settling);
        settling = window.setTimeout(() => this.#fit(), SETTLE);
      });
      box.observe(this.#video);
      signal.addEventListener('abort', () => {
        box.disconnect();
        clearTimeout(settling);
      });
      // The player taking the screen is one step, not a drag: answered at once, so the frame is held while the
      // screen is still changing over and not after it.
      for (const type of ['fullscreenchange', 'webkitfullscreenchange']) {
        document.addEventListener(type, () => {
          clearTimeout(settling);
          this.#fit();
        }, { signal });
      }
      // (A box that grew while the film was still opening is answered once it has opened.)
      this.#video.addEventListener('loadedmetadata', () => this.#fit(), { signal });
    }
    this.#trigger?.toggleAttribute('data-fb-quality', true);
    this.#trigger?.removeAttribute('data-hidden');
    this.#container.toggleAttribute('data-fb-quality', true);
    this.#show();
    // The choice kept for this film, if the film still has it.
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(this.#key);
    } catch {
      // No storage here: Auto.
    }
    const kept = keptChoice(stored, this.#heights);
    if (kept !== this.#choice && stored != null) void this.#switch(kept, false);
  }

  #item(height: number | null): HTMLElement {
    const item = document.createElement('media-menu-radio-item');
    item.className = 'media-menu-radio-item';
    item.setAttribute('value', height == null ? 'auto' : String(height));
    item.innerHTML =
      '<span class="media-menu-radio-label" aria-hidden="true"><span data-part="label"></span><sup data-part="tier" class="media-menu-tier"></sup></span><span data-part="badge" class="media-menu-badge" aria-hidden="true"></span><media-menu-item-indicator force-mount class="media-menu-indicator"><media-icon family="flipbook" name="check" class="media-menu-radio-icon"></media-icon></media-menu-item-indicator>';
    return item;
  }

  /** The page as it stands: each row named, the choice checked and named on the way in; under Auto, the height playing. */
  #show() {
    const group = this.#group;
    if (!group) return;
    const i18n = this.#i18n();
    const auto = say(i18n, 'flipbook.qualityAuto');
    const playing = this.#choice == null && this.#video.videoHeight > 0 ? `${this.#video.videoHeight}p` : '';
    for (const item of group.children) {
      const value = item.getAttribute('value');
      const { label, tier } = value === 'auto' ? { label: auto, tier: '' } : nameOf(Number(value));
      const badge = value === 'auto' ? playing : '';
      const parts: [string, string][] = [['label', label], ['tier', tier], ['badge', badge]];
      for (const [part, text] of parts) {
        const node = item.querySelector<HTMLElement>(`[data-part="${part}"]`);
        if (node && node.textContent !== text) node.textContent = text;
      }
      // Read as one line: "2160p, 4K", "Auto, 720p".
      const name = [label, tier || badge].filter(Boolean).join(', ');
      if (item.getAttribute('aria-label') !== name) item.setAttribute('aria-label', name);
    }
    const value = this.#choice == null ? 'auto' : String(this.#choice);
    if (group.value !== value) group.value = value;
    const hint = this.#container.querySelector<HTMLElement>('[data-fb-part="quality"]');
    const text = this.#choice == null ? auto : nameOf(this.#choice).label;
    if (hint && hint.textContent !== text) hint.textContent = text;
  }

  /** Auto asked again, taller, when the film's box has grown past the ceiling it plays under. */
  #fit() {
    if (this.#choice != null || this.#video.readyState < 1) return;
    // (By the address the film is on now: it may have been lifted since this page was made, fit.ts.)
    if (outgrown(this.#video, this.#video.getAttribute('src') ?? '')) void this.#switch(null, false);
  }

  #keep(height: number | null) {
    try {
      if (height == null) localStorage.removeItem(this.#key);
      else localStorage.setItem(this.#key, String(height));
    } catch {
      // Not kept, then: it holds for this visit.
    }
  }

  /** Plays the film from the stream at one height (or at any: null), from the moment it is on, as it was playing. */
  async #switch(height: number | null, chosen: boolean) {
    const video = this.#video;
    const run = ++this.#run;
    const state = { at: video.currentTime, playing: !video.paused && !video.ended, rate: video.playbackRate };
    this.#choice = height;
    // (Opened again for any cause, Auto asks for all the screen can show: it is then never lifted a second time.)
    if (this.#fitted) this.#auto = under(this.#base, ceiling(null));
    this.#show();
    this.#hold();
    const waiting = window.setTimeout(() => this.#container.toggleAttribute('data-fb-switching', true), WAIT_AFTER);
    // (A height that fails gives way to Auto, below. Auto failing is the film failing: the player's to show.)
    let shown = await this.#load(height == null ? this.#auto : atHeight(this.#base, height), state, run, height != null);
    if (run !== this.#run) return void clearTimeout(waiting);
    if (!shown && height != null) {
      // That height cannot be had: Auto, and said.
      this.#choice = null;
      this.#show();
      voiceFor(this.#container)(say(this.#i18n(), 'flipbook.qualityFailed', { name: nameOf(height).label }));
      shown = await this.#load(this.#auto, state, run, false);
      if (run !== this.#run) return void clearTimeout(waiting);
    } else if (shown && chosen) {
      voiceFor(this.#container)(say(this.#i18n(), 'flipbook.qualitySet', { name: height == null ? say(this.#i18n(), 'flipbook.qualityAuto') : nameOf(height).label }));
    }
    clearTimeout(waiting);
    this.#container.removeAttribute('data-fb-switching');
    if (chosen || !shown) this.#keep(this.#choice);
    this.#show();
    this.#release(shown);
  }

  /**
   * The film from another address, at the same moment and as it was. Resolves true once its own picture shows that
   * moment, false if it fails or takes too long. While it opens the player hears nothing of it (see the top).
   */
  #load(src: string, state: { at: number; playing: boolean; rate: number }, run: number, guarded: boolean): Promise<boolean> {
    const video = this.#video;
    const { at, playing, rate } = state;
    return new Promise((resolve) => {
      const local = new AbortController();
      const options = { capture: true, signal: local.signal };
      let opened = false;
      const done = (ok: boolean) => {
        if (local.signal.aborted) return;
        local.abort();
        clearTimeout(limit);
        clearInterval(looking);
        resolve(ok);
      };
      const limit = window.setTimeout(() => done(false), SWITCH_LIMIT);
      this.#abort.signal.addEventListener('abort', () => done(false), { signal: local.signal });
      for (const type of HUSHED) {
        video.addEventListener(type, (event) => {
          // (Its length said again as it opens is the same length: only its going is kept back.)
          if (!opened && !(type === 'durationchange' && video.duration > 0)) event.stopImmediatePropagation();
        }, options);
      }
      video.addEventListener('loadedmetadata', () => {
        opened = true;
        if (Math.abs(video.currentTime - at) > 0.25) video.currentTime = at;
        if (video.playbackRate !== rate) video.playbackRate = rate;
        // Nothing was on screen to hold (a film not yet begun): open is all there is to wait for.
        if (!this.#held) done(true);
      }, options);
      // A height that fails is not the film failing: the player is not told, and Auto is tried (#switch).
      video.addEventListener('error', (event) => {
        if (guarded) event.stopImmediatePropagation();
        done(false);
      }, options);
      // The new stream shows the moment: ready there, and (where the browser says which frame is on screen) a frame
      // of the new stream named for it. A paused film must hold the moment itself; a playing one may be past it.
      const clock = frameClock(video);
      const since = performance.now();
      let ready = 0;
      const look = () => {
        if (run !== this.#run) return done(false);
        if (!opened || video.seeking || video.readyState < 2 || Math.abs(video.currentTime - at) > (playing ? 30 : 0.25)) return;
        ready ||= performance.now();
        const frame = clock && clock.at > since ? clock.time : null;
        const holds = frame != null && clock && (playing ? frame > at - clock.span - HAIR : at - frame > -HAIR && at - frame < clock.span + HAIR);
        if (holds || performance.now() - ready > FRAME_PATIENCE) done(true);
      };
      const looking = window.setInterval(look, 40);
      const unwatch = clock?.watch(look);
      local.signal.addEventListener('abort', () => unwatch?.());

      open(video, src);
      // (A new source sets the speed back to the default, and holds the film still.)
      video.playbackRate = rate;
      // Before the source has opened, the clock reads where the film is going: the player never sees it at zero.
      if (at > 0) video.currentTime = at;
      if (playing) void video.play().catch(() => undefined);
    });
  }

  /** The frame on screen, kept over the film. (Already held, by a switch this one follows: that frame stays.) */
  #hold() {
    const video = this.#video;
    if (this.#held || video.readyState < 2 || !video.videoWidth) return;
    // (Under a poster the film is not on screen, skin.css: there is no frame of it to hold.)
    if (this.#container.matches(':not([data-fb-posterless]):has(> .media-poster[data-visible])')) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'fb-stand fb-hold';
    canvas.setAttribute('aria-hidden', 'true');
    const scale = Math.min(1, HOLD_WIDTH / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    try {
      canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
    } catch {
      return;
    }
    canvas.toggleAttribute('data-on', true);
    // Over the film and over the hand's stand-ins, which come after it too.
    const stands = this.#container.querySelectorAll('.fb-stand');
    (stands[stands.length - 1] ?? video).after(canvas);
    this.#held = canvas;
    // The hand's stand-in to the same moment, under the canvas: where a browser will not draw a stream's frame on a
    // canvas, it is the picture held (flip.ts hears this; with no stand-in, nothing does).
    this.#container.dispatchEvent(new CustomEvent('fb-hold', { detail: { time: video.currentTime } }));
  }

  #release(faded: boolean) {
    const canvas = this.#held;
    this.#held = null;
    if (!canvas) return;
    if (!faded || reducedMotion.matches) return void canvas.remove();
    const leaving = canvas.animate([{ opacity: 1 }, { opacity: 0 }], { duration: LEAVE, easing: 'cubic-bezier(0.23, 1, 0.32, 1)', fill: 'forwards' });
    leaving.finished.then(() => canvas.remove(), () => canvas.remove());
  }
}
