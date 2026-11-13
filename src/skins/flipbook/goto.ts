import { PlayerController, playerContext, UIElement } from '@videojs/html';
import { I18nController, i18nContext } from '@videojs/html/i18n';
import { type Book, chapterAt, clock, hush, loadBook, reducedMotion, videoIn } from './book';
import { attach } from './companion';
import { isOn, loaded, need, settled } from './features';
import { say } from './i18n';
import { isPlainKey, voiceFor } from './pages';
import { frameClock } from './shown';

/**
 * Going to a place in the film, wherever the request comes from: a chapter tab, the contents, a ribbon, the corner,
 * N, the system's media keys. Everything asks the same way, a bubbling `fb-turn` event (or `turnTo`), and this
 * answers it: with the book's real page turn when `turns` is on (loading it first if it hasn't arrived), otherwise
 * with a clean cut to the new place. Either way the landing is said once, politely, "Chapter 3: The Herd, 0:36", and
 * the status announcer's own "Seeked to…" for the same move is held back.
 *
 * Also the core's chapter keys: N turns to the next chapter, and Page Up and Page Down on the fore-edge go from
 * detent to detent (chapter starts), with or without the deck.
 *
 * And two things that keep the film's place true, whoever moved it:
 * - A key steps from where the film is going. Video.js's keys (the fore-edge's arrows, the skip keys) step from the
 *   place its store holds, and the store hears of a seek made on the video itself only when the browser reports it,
 *   a moment later: a key pressed in that moment stepped from the old place (a chapter opened, then an arrow at
 *   once: one step on from where it had been). The jumps made here go through the store, and any key that finds
 *   the video already on its way somewhere the store has not heard of tells it first.
 * - A pause prints the frame that was on screen. Safari stops its clock a few frames past the picture it holds
 *   (within a fifth of a second of a cut, the picture is the shot before and the clock the shot after). Where the
 *   browser names the frame it shows (shown.ts) and that frame is not the clock's, the clock is set to the frame,
 *   once: the picture does not change, and the page number, the caption and the strip are that picture's.
 * - A paused film that has been sought shows the frame it was sought to. Safari, on a stream that has played, often
 *   leaves the frame from the seek before on screen (measured by pixels: the picture of the place before, for as
 *   long as nothing else happens), and says so itself: the frame it names is not the clock's. A second seek to the
 *   same place brings the picture. So a paused seek that has landed and still shows another frame is nudged, twice
 *   at most.
 */

/** A pause's picture is the clock's when the clock is inside its frame, give or take half a frame. */
const SAME_FRAME = 0.5;
/** Further than this from the clock, the frame on screen is not a pause's lag: something else moved the film. */
const LAG_MOST = 1;
/** A frame shown longer ago than this is no witness of a pause (the film had stalled). */
const FRESH = 700;
/** The picture is judged this long after the pause. */
const PRINT_AFTER = 120;
/** A paused seek's picture is judged this long after it has landed, and nudged this many times at most. */
const SHOWN_AFTER = 150;
const NUDGES = 2;

export interface TurnRequest {
  time: number;
  direction?: 1 | -1;
  /** Which corner leads. The corner curl lifts the top one; everything else thumbs the bottom one. */
  corner?: 'top' | 'bottom';
  /** How far in from the corner the page is already folded, as a share of the picture's height (a corner pulled by hand). */
  reach?: number;
  /** Asked for by key: the turn runs a little quicker. */
  quick?: boolean;
}

type Turner = HTMLElement & { turnTo?: (time: number, direction?: 1 | -1, options?: Omit<TurnRequest, 'time' | 'direction'>) => Promise<void> };

/** Asks the player to go to a time, as a page turn where the book has them; `quick` when a key asked for it. */
export function turnTo(from: Element, time: number, quick = false) {
  from.dispatchEvent(new CustomEvent<TurnRequest>('fb-turn', { bubbles: true, detail: { time, quick } }));
}

const books = new WeakMap<HTMLElement, Book | null>();
const runs = new WeakMap<HTMLElement, number>();
const quiet = new WeakMap<HTMLElement, number>();

function announcer(container: HTMLElement) {
  return container.querySelector<HTMLElement>('media-status-announcer');
}

/** Holds the status announcer's "Seeked to…" back from now until shortly after the landing is said. */
function hold(container: HTMLElement, ms: number) {
  clearTimeout(quiet.get(container));
  announcer(container)?.setAttribute('aria-live', 'off');
  quiet.set(container, window.setTimeout(() => announcer(container)?.removeAttribute('aria-live'), ms));
}

/**
 * The cut: no page, no flash. The picture goes to the new place (the frame it was showing stays until the new one
 * is there), captions follow the film as they do for any seek, and the landing is said once.
 */
export function cut(container: HTMLElement, time: number, i18n: I18nController | null = null, seek: ((time: number) => unknown) | null = null) {
  const video = videoIn(container);
  if (!video) return;
  const to = Math.max(0, Math.min(time, Number.isFinite(video.duration) && video.duration > 0 ? video.duration : time));
  const run = (runs.get(container) ?? 0) + 1;
  runs.set(container, run);
  // A chapter jump, not a seek: the fore-edge's seek flick and its +/- chip stay out of it.
  hush(container, 1400);
  // Should it never land (the source changes under it), the announcer still speaks again.
  hold(container, 3000);
  // Through the player's store where there is one, so its own keys know at once where the film is going.
  if (seek) void seek(to);
  else video.currentTime = to;
  const speak = () => {
    if (runs.get(container) !== run) return;
    const chapters = books.get(container)?.chapters ?? [];
    const index = chapters.findIndex((c) => to >= c.startTime - 0.05 && to < c.endTime);
    const at = clock(to);
    voiceFor(container)(index < 0 ? at : say(i18n, 'flipbook.turnedTo', { number: index + 1, title: chapters[index].text, time: at }));
    // The announcer's own word on a seek comes 200 ms after it completes: past that, it speaks again.
    hold(container, 500);
  };
  if (video.seeking) video.addEventListener('seeked', speak, { once: true });
  else speak();
}

/** The chapter start a detent key goes to: the next one, or the one before (a second back skips the one just left). */
function detent(book: Book, now: number, forward: boolean): number {
  const starts = book.chapters.map((c) => c.startTime);
  const target = forward ? starts.find((t) => t > now + 0.5) : [...starts].reverse().find((t) => t < now - 1);
  return target ?? (forward ? now : 0);
}

/** The element (one per player, placed by companion.ts) that answers `fb-turn` and the chapter keys. */
export class FbGotoElement extends UIElement {
  #i18n = new I18nController(this, i18nContext);
  /** The player's store (no selector: nothing here re-renders with it). */
  #player = new PlayerController(this, playerContext);
  #abort: AbortController | null = null;
  #latest = 0;
  /** Nudges given to the place the film is paused on (#shows). */
  #nudged = { at: -1, times: 0 };

  connectedCallback() {
    super.connectedCallback();
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    this.hidden = true;
    const container = this.closest<HTMLElement>('media-container');
    if (!container) return;
    queueMicrotask(async () => {
      const video = videoIn(container);
      // (The frame clock starts here, with the player: it must see the first frame a film shows.)
      // (A frame already on its way to the screen still arrives after the pause: the picture is judged once it has.)
      if (video && frameClock(video)) {
        video.addEventListener('pause', () => window.setTimeout(() => this.#print(container, video), PRINT_AFTER), { signal });
        video.addEventListener('seeked', () => {
          if (video.paused) window.setTimeout(() => this.#shows(container, video), SHOWN_AFTER);
        }, { signal });
      }
      const book = await loadBook(container, signal).catch(() => null);
      if (!signal.aborted) books.set(container, book);
    });
    container.addEventListener('keydown', () => this.#tell(container), { capture: true, signal });
    container.addEventListener('fb-turn', (event) => this.#turn(container, event as CustomEvent<TurnRequest>), { signal });
    container.addEventListener('keydown', (event) => this.#next(container, event), { signal });
    container.addEventListener('keydown', (event) => this.#detent(container, event), { capture: true, signal });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort?.abort();
  }

  /** Seeks through the player's store, which then knows the place at once; on the video itself where there is none. */
  #seek = (time: number) => {
    const player = this.#player.value;
    const container = this.closest<HTMLElement>('media-container');
    if (player && 'seek' in player && typeof player.seek === 'function') void player.seek(time);
    else if (container) {
      const video = videoIn(container);
      if (video) video.currentTime = time;
    }
  };

  /**
   * A key is about to be heard, and the video is on its way somewhere the store has not heard of yet (a seek made on
   * the video itself, in the moment before the browser reports it): the store is told now, so the key steps from there.
   */
  #tell(container: HTMLElement) {
    const player = this.#player.value as { seeking?: boolean; currentTime?: number; seek?: (time: number) => unknown } | undefined;
    const video = videoIn(container);
    if (!player?.seek || !video?.seeking || player.seeking) return;
    if (Math.abs((player.currentTime ?? 0) - video.currentTime) < 0.05) return;
    void player.seek(video.currentTime);
  }

  /** A pause: if the frame on screen is not the clock's, the clock goes to the frame (see the note above). */
  #print(container: HTMLElement, video: HTMLVideoElement) {
    const clock = frameClock(video);
    if (!clock || clock.time == null || !video.paused || video.seeking || video.ended || !this.isConnected) return;
    // A hand has the film (flip.ts): the pause is its own, and so are the seeks that follow.
    if (container.getAttribute('data-fb-deck') === 'flip') return;
    if (performance.now() - clock.at > FRESH) return;
    // How far the clock stands into the frame on screen, in frames: 0 to 1 is that frame.
    const into = (video.currentTime - clock.time) / clock.span;
    if ((into > -SAME_FRAME && into < 1 + SAME_FRAME) || Math.abs(video.currentTime - clock.time) > LAG_MOST) return;
    // Nothing to see and nothing to say: no flick on the edge, no "Seeked to…".
    hush(container);
    hold(container, 600);
    this.#seek(clock.time + Math.min(clock.span / 2, 0.012));
  }

  /** A paused seek has landed: if the frame on screen is still another one, the film is sought there again (see the note above). */
  #shows(container: HTMLElement, video: HTMLVideoElement) {
    const clock = frameClock(video);
    if (!clock || clock.time == null || !video.paused || video.seeking || video.ended || !this.isConnected) return;
    // A hand has the film (flip.ts): it is only being told where the hand is, and is sought again when the hand rests.
    if (container.getAttribute('data-fb-deck') === 'flip') return;
    const at = video.currentTime;
    // The frame on screen holds the clock: exactly, once one frame's length is known (a frame out is a frame wrong).
    const into = (at - clock.time) / clock.span;
    const slack = clock.sure ? 0.1 : SAME_FRAME;
    if (into > -slack && into < 1 + slack) return;
    if (Math.abs(this.#nudged.at - at) > 0.01) this.#nudged = { at, times: 0 };
    if (this.#nudged.times >= NUDGES) return;
    this.#nudged.times++;
    hush(container);
    hold(container, 600);
    // (A millisecond on: a seek to the very same time is no seek at all.)
    this.#nudged.at = at + 0.001;
    video.currentTime = this.#nudged.at;
    // The film's very start is the one place a millisecond is told from: Home goes to 0:00.000, and stays there. Once
    // the picture has come, the clock goes back the millisecond, inside the same frame.
    if (at === 0) {
      video.addEventListener('seeked', () => {
        if (video.paused && !video.seeking && video.currentTime === this.#nudged.at) video.currentTime = 0;
      }, { once: true });
    }
  }

  #turn(container: HTMLElement, event: CustomEvent<TurnRequest>) {
    const detail = event.detail;
    if (!detail || !Number.isFinite(detail.time)) return;
    const request = ++this.#latest;
    if (!isOn(container, 'turns')) {
      cut(container, detail.time, this.#i18n, this.#seek);
      return;
    }
    const go = () => {
      if (request !== this.#latest) return;
      const turner = container.querySelector<Turner>('fb-turn');
      if (turner?.turnTo && isOn(container, 'turns')) void turner.turnTo(detail.time, detail.direction, detail);
      else cut(container, detail.time, this.#i18n, this.#seek);
    };
    if (loaded('turns')) {
      go();
      return;
    }
    need('turns')
      .then(() => settled(container))
      .then(go, () => {
        if (request === this.#latest) cut(container, detail.time, this.#i18n, this.#seek);
      });
  }

  /** N: the next chapter, from anywhere in the player (the next-chapter prompt is the book's; the key is the core's). */
  #next(container: HTMLElement, event: KeyboardEvent) {
    if ((event.key !== 'n' && event.key !== 'N') || event.shiftKey || !isPlainKey(event) || event.repeat) return;
    if ((event.target as Element | null)?.closest('[aria-modal="true"]')) return;
    const book = books.get(container);
    const video = videoIn(container);
    if (!book || !video) return;
    const at = chapterAt(book, video.currentTime);
    if (at < 0 || at >= book.chapters.length - 1) return;
    event.preventDefault();
    turnTo(container.querySelector('fb-turn') ?? container, book.chapters[at + 1].startTime, true);
  }

  /** Page Up and Page Down on the fore-edge: from detent to detent. They're the slider's keys here, before its own. */
  #detent(container: HTMLElement, event: KeyboardEvent) {
    if ((event.key !== 'PageUp' && event.key !== 'PageDown') || event.altKey || event.ctrlKey || event.metaKey) return;
    const slider = (event.target as Element | null)?.closest<HTMLElement>('media-time-slider');
    const book = books.get(container);
    const video = videoIn(container);
    if (!slider || !book || !video) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const time = detent(book, video.currentTime, event.key === 'PageDown');
    this.#seek(time);
    // The deck, if it's here, shows the moment still; the ribbon nods; the chapter is said.
    container.dispatchEvent(new CustomEvent('fb-detent', { detail: { time } }));
    const thumb = slider.querySelector<HTMLElement>('.media-time-slider-thumb');
    if (thumb && !reducedMotion.matches) {
      thumb.animate([{ transform: 'translateY(-4px)' }, { transform: 'translateY(0)' }], { duration: 180, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
    }
    const index = book.chapters.findIndex((c) => Math.abs(c.startTime - time) < 0.05);
    if (index >= 0) container.dispatchEvent(new CustomEvent('fb-chapter-settle', { detail: { index, title: book.chapters[index].text } }));
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('fb-goto')) customElements.define('fb-goto', FbGotoElement);
attach('fb-goto');
