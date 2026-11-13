import { findMedia, tileAt } from '@/shared/storyboard';
import { type Book, reducedMotion, spritePosition } from './book';
import { sharpAt } from './frames';
import { frameClock, type FrameClock } from './shown';
import { type Standing, standing } from './standing';

/*
 * The stand-in: what takes the picture's place while the film itself cannot keep up with a hand.
 *
 * A film that plays from a stream is sought slowly (a keyframe every five seconds, or fifteen in a stream's MP4: a
 * paused seek takes 0.3 to 2.5 s, measured), and a flipbook's pages cannot wait that long for the hand. What stands
 * in is the best there is (standing.ts):
 *
 * - **A copy.** A page may give the player a second address, `scrub` on `<video-player>`: the same film as a small
 *   file that seeks at once (a keyframe a second; 33 ms a seek). It is never heard and never plays, and it is fetched
 *   when a hand first needs it. Under the hand it is chased with exact seeks, frame by frame.
 * - **The pages.** With no copy, the storyboard's stills (the page's own, or Mux's), drawn at the picture's size: the
 *   page under the hand, sharp as soon as its frame has loaded. A still is its page, not the exact frame, and nothing
 *   here says otherwise: the readout counts pages, and a step of one frame, the strip and a kept page wait for the
 *   film's own frame.
 * - **Nothing**, for a film that keeps up (a file beside the page): the film itself is chased.
 *
 * Either stand-in lies over the picture in the picture's own box, and every rule that sizes, scales or prints the
 * picture holds for it (the copy is a `<video>` of the player's; the pages' canvas is named beside the video in those
 * rules). Meanwhile the film is only told where the hand is, a few times a second, so its clock, the fore-edge and
 * the captions follow. When the hand rests, the film is sought there and the stand-in leaves once the film shows
 * that frame itself, by the browser's own word (shown.ts): never on a timer, and never on `seeked` alone.
 *
 * The copy never shows a frame that is not the one asked for: it comes up only when its own frame for that moment is
 * on it. Before its first frame has arrived at all (the first moment of the first flip) it shows the page's still,
 * as the pages do.
 */

/** How long the copy's first picture may take to come by itself before it is asked to play (an iPhone's never does). */
const PRIME_AFTER = 250;
/** A seek that never reports back is forgotten after this. */
const SEEK_LOST = 600;
/** Times are the same to within this. */
const HAIR = 0.005;
/** A paused film that has landed, in a browser that names no frames, has shown it this long after. */
const LANDED_AFTER = 150;
/** The copy's frame for a seek that has landed is named within this; if none is, the picture did not need to change. */
const ARRIVED_AFTER = 200;
/** The copy's picture at rest is judged this long after its seek has landed. */
const HOLD_AFTER = 120;
/** A playing film this far from the landing has been sent somewhere else (a stream's keyframes are up to this far apart, and more). */
const ELSEWHERE = 12;
/** A film that has landed and shows another frame is asked again after this, twice at most. */
const ASK_AGAIN = 600;
/** A film that never shows the landing at all (it cannot decode it) has its picture back from the pages after this (a copy stays). */
const GIVE_UP = 8000;
/** Its leaving: a fade this long. */
const LEAVE = 150;

/** The address of a player's scrub copy (`scrub` on `<video-player>`), or '' where it has none. */
export function scrubOf(container: Element): string {
  const src = (container.closest('video-player') ?? container).getAttribute('scrub') ?? '';
  return src ? new URL(src, document.baseURI).href : '';
}

export class Stand {
  #container: HTMLElement;
  #film: HTMLVideoElement;
  #book: () => Book | null;
  #src: string;
  #filmClock: FrameClock | null;
  #abort = new AbortController();
  /** The copy: its video, how far its loading has got, the frames it shows. */
  #video: HTMLVideoElement | null = null;
  #state: 'cold' | 'loading' | 'ready' | 'failed' = 'cold';
  #clock: FrameClock | null = null;
  /** The pages: a canvas, the storyboard's sheet, and the page drawn on it. */
  #canvas: HTMLCanvasElement | null = null;
  #sheet: HTMLImageElement | null = null;
  #page = -1;
  /** The film's own seeks have proved slow under the hand (flip.ts says so). */
  slow = false;
  /** The moment asked for, the last one asked of the copy, and whether that seek is still in flight. */
  #want = -1;
  #asked = -1;
  #busy = false;
  #askedAt = 0;
  /** Up, or about to be (waiting for its own frame). */
  #up = false;
  /** Counts its showings: a seek asked in an earlier one never brings it up in this one. */
  #showing = 0;
  #askedIn = -1;
  /** A hand drives it (flip.ts, between `to` and `land`): the film's own seeks meanwhile are only its clock following. */
  #driven = false;
  /** The moment the film is to show before the stand-in leaves; null while a hand still drives. */
  #landing: number | null = null;
  #landedTimer = 0;
  /** Times the film has been asked again for this landing, and the copy held to it. */
  #asks = 0;
  #held = 0;
  /** The film's frame count when it was last landed, or began to play: a frame shown since has a higher one. */
  #playedFrom = 0;
  /** Playing on from a landing: the last frame the film showed at it or after, if the one before it was not. */
  #on: { count: number; time: number } | null = null;
  /** Waiting for the copy's own frame before it comes up: the way to stop waiting. */
  #arriving: (() => void) | null = null;

  constructor(container: HTMLElement, film: HTMLVideoElement, book: () => Book | null) {
    this.#container = container;
    this.#film = film;
    this.#src = scrubOf(container);
    this.#book = book;
    this.#filmClock = frameClock(film);
    const { signal } = this.#abort;
    this.#filmClock?.watch(() => this.#settle());
    film.addEventListener('seeked', () => this.#settle(), { signal });
    film.addEventListener('play', () => {
      this.#playedFrom = this.#filmClock?.count ?? 0;
      this.#on = null;
    }, { signal });
    // A film sought by anything else (a chapter, a frame of the strip, a key): the copy shows that frame at once
    // too, by itself, held still or playing (a stream sought while it plays stalls for as long as its seek takes: the
    // frame it is going to is in sight meanwhile, and it plays on from it). Only the copy (a still is not a frame),
    // and only once it has been fetched for a hand.
    film.addEventListener('seeking', () => {
      if (!this.#driven && this.#state === 'ready' && this.kind === 'copy' && this.#landing !== film.currentTime) this.land(film.currentTime);
    }, { signal });
    // The film itself gone (another source, an error): nothing to stand in for.
    for (const type of ['emptied', 'error']) film.addEventListener(type, () => this.leave(), { signal });
  }

  /** What stands in for this film now. */
  get kind(): Standing {
    return standing({ src: this.#film.currentSrc || this.#film.src, scrub: this.#src, failed: this.#state === 'failed', slow: this.slow });
  }

  /** Over the picture now. */
  get shown(): boolean {
    return !!(this.#video?.hasAttribute('data-on') || this.#canvas?.hasAttribute('data-on'));
  }

  /** The copy's frames as it shows them, for a step of one frame (flip.ts): null unless it is a copy with a picture. */
  get clock(): FrameClock | null {
    return this.kind === 'copy' && this.#state === 'ready' ? this.#clock : null;
  }

  /** Fetches what will stand in, if it has not been: at the first sign a hand is coming (the pointer on the edge, a pause). */
  warm() {
    const kind = this.kind;
    if (kind === 'stills') this.#pages();
    if (kind !== 'copy' || this.#state !== 'cold') return;
    this.#state = 'loading';
    const video = document.createElement('video');
    video.className = 'fb-stand';
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.crossOrigin = this.#film.crossOrigin;
    video.disablePictureInPicture = true;
    video.disableRemotePlayback = true;
    video.tabIndex = -1;
    video.setAttribute('aria-hidden', 'true');
    this.#video = video;
    const { signal } = this.#abort;
    let primed: Promise<void> = Promise.resolve();
    video.addEventListener('loadeddata', () => void primed.then(() => this.#ready()), { once: true, signal });
    video.addEventListener('error', () => this.#fail(), { once: true, signal });
    // An iPhone decodes no picture for a film that has never played: a muted play, stopped at once, brings the frames.
    video.addEventListener('loadedmetadata', () => {
      window.setTimeout(() => {
        if (signal.aborted || video.readyState >= 2) return;
        primed = video.play().then(() => video.pause(), () => undefined);
      }, PRIME_AFTER);
    }, { once: true, signal });
    video.addEventListener('seeked', () => this.#sought(), { signal });
    // After the film in the tree: the player takes the first video it finds for its own.
    (findMedia(this.#container) ?? this.#film).after(video);
    video.src = this.#src;
  }

  /** A hand drives: this moment, now. */
  to(time: number) {
    if (this.kind === 'film') return;
    this.#driven = true;
    this.#show(time);
  }

  /** The hand has rested at this moment: the stand-in shows it, and leaves once the film shows it too. */
  land(time: number) {
    if (this.kind === 'film') return;
    const before = this.#landing;
    this.#driven = false;
    this.#playedFrom = this.#filmClock?.count ?? 0;
    this.#on = null;
    this.#show(time);
    if (before == null || Math.abs(before - time) > HAIR) this.#asks = this.#held = 0;
    if (this.#state === 'ready' && !this.#busy) window.setTimeout(() => this.#hold(), HOLD_AFTER);
    this.#landing = time;
    this.#settle();
  }

  /**
   * The copy shows a moment and answers with the time of the frame it then shows (for a step of exactly one frame,
   * flip.ts): null if there is no copy with a picture, or the seek was lost.
   */
  async seek(time: number): Promise<number | null> {
    const clock = this.clock;
    if (!clock) return null;
    this.#driven = true;
    this.#landing = null;
    clearTimeout(this.#landedTimer);
    this.#up = true;
    this.#want = this.#asked = time;
    this.#askedIn = this.#showing;
    this.#busy = true;
    this.#askedAt = performance.now();
    return clock.seek(time, 250);
  }

  /** Leaves now (the film has the picture again). */
  leave() {
    this.#up = false;
    this.#driven = false;
    this.#showing++;
    this.#arriving?.();
    this.#landing = null;
    clearTimeout(this.#landedTimer);
    for (const part of [this.#video, this.#canvas]) {
      if (!part?.hasAttribute('data-on')) continue;
      part.toggleAttribute('data-on', false);
      part.toggleAttribute('data-still', false);
      // The film shows the same moment under it by now, from another encoding (or sharper than a still): a cut
      // between the two could be seen.
      if (!reducedMotion.matches) part.animate([{ opacity: 1 }, { opacity: 0 }], { duration: LEAVE, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
    }
  }

  destroy() {
    this.#abort.abort();
    clearTimeout(this.#landedTimer);
    this.#arriving?.();
    const video = this.#video;
    this.#video = null;
    this.#canvas?.remove();
    this.#canvas = null;
    if (!video) return;
    video.removeAttribute('src');
    video.load();
    video.remove();
  }

  #show(time: number) {
    this.warm();
    this.#want = time;
    this.#landing = null;
    clearTimeout(this.#landedTimer);
    this.#up = true;
    if (this.kind === 'stills') this.#draw(time);
    else if (this.#state === 'ready') this.#pump();
    else this.#still(time);
  }

  // ─── The copy ─────────────────────────────────────────────────────────────

  #ready() {
    const video = this.#video;
    if (!video || this.#state !== 'loading') return;
    this.#state = 'ready';
    this.#clock = frameClock(video);
    // The pages that stood in while it loaded (if any) give way to it.
    this.#canvas?.toggleAttribute('data-on', false);
    if (this.#up) this.#pump();
  }

  #fail() {
    const up = this.#up;
    const want = this.#want;
    this.#state = 'failed';
    this.#video?.remove();
    this.#video = null;
    // No copy after all: the pages stand in, if this film needs a stand-in.
    if (up && this.kind === 'stills') this.#draw(want);
    else this.leave();
  }

  /** The storyboard's page for a moment, behind the copy's own (still empty) picture. */
  #still(time: number) {
    const video = this.#video;
    const book = this.#book();
    if (!video || !book) return;
    const position = spritePosition(book, tileAt(book.tiles, time));
    if (video.style.backgroundPosition !== position) video.style.backgroundPosition = position;
    video.toggleAttribute('data-still', true);
    video.toggleAttribute('data-on', true);
  }

  /** One exact seek in flight at a time; the next is asked when it lands, for wherever the hand is by then. */
  #pump() {
    const video = this.#video;
    if (!video || this.#state !== 'ready' || this.#want < 0) return;
    const now = performance.now();
    if (this.#busy && now - this.#askedAt < SEEK_LOST) return;
    if (Math.abs(this.#want - this.#asked) < 0.004 && !video.seeking) {
      if (!this.shown && !this.#arriving) this.#arrive(this.#asked);
      return;
    }
    this.#busy = true;
    this.#askedAt = now;
    this.#asked = this.#want;
    this.#askedIn = this.#showing;
    video.currentTime = this.#want;
  }

  #sought() {
    this.#busy = false;
    if (!this.#up) return;
    if (this.#landing != null) window.setTimeout(() => this.#hold(), HOLD_AFTER);
    // It comes up with a frame asked for in this showing in it, never the one it held from the time before.
    if (this.#askedIn === this.#showing) this.#arrive(this.#asked);
    this.#pump();
    this.#settle();
  }

  /**
   * Comes up once the copy shows the frame for a moment it was asked: `seeked` alone is not that (Safari reports the
   * seek done a frame's time before the picture changes, and the picture until then is the one from before). The
   * frame is: its time is the moment's, or just before it. Where no frame is named a moment after, it has come.
   */
  #arrive(time: number) {
    const clock = this.#clock;
    const showing = this.#showing;
    const there = () => clock?.time != null && time - clock.time > -HAIR && time - clock.time < this.#frame() + HAIR;
    if (!clock || there()) {
      this.#reveal();
      return;
    }
    this.#arriving?.();
    const done = () => {
      stop();
      clearTimeout(timer);
      this.#arriving = null;
    };
    const stop = clock.watch(() => {
      if (showing !== this.#showing) return done();
      if (!there()) return;
      done();
      this.#reveal();
    });
    const timer = window.setTimeout(() => {
      done();
      if (showing === this.#showing && Math.abs(this.#asked - time) < 0.004) this.#reveal();
    }, ARRIVED_AFTER);
    this.#arriving = done;
  }

  #reveal() {
    const video = this.#video;
    if (!video || !this.#up) return;
    video.toggleAttribute('data-still', false);
    video.toggleAttribute('data-on', true);
    this.#settle();
  }

  // ─── The pages ────────────────────────────────────────────────────────────

  /** The canvas the pages are drawn on, and the storyboard's sheet, fetched once. */
  #pages() {
    if (this.#canvas) return;
    const book = this.#book();
    if (!book) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'fb-stand';
    canvas.setAttribute('aria-hidden', 'true');
    this.#canvas = canvas;
    const sheet = new Image();
    sheet.crossOrigin = 'anonymous';
    sheet.decoding = 'async';
    sheet.addEventListener('load', () => {
      if (this.#up && this.kind === 'stills') this.#draw(this.#want, true);
    }, { once: true });
    sheet.src = book.sprite;
    this.#sheet = sheet;
    (findMedia(this.#container) ?? this.#film).after(canvas);
  }

  /**
   * The page a moment is on, at the picture's size: the storyboard's tile at once, and the page's sharp still over it
   * when that has loaded (frames.ts), if the hand is still on that page.
   */
  #draw(time: number, again = false) {
    this.#pages();
    const canvas = this.#canvas;
    const sheet = this.#sheet;
    const book = this.#book();
    if (!canvas || !book) return;
    const page = tileAt(book.tiles, time);
    if (page !== this.#page || again) {
      this.#page = page;
      const tile = book.tiles[page];
      const ctx = canvas.getContext('2d');
      if (tile && ctx && sheet?.complete && sheet.naturalWidth > 0) {
        if (canvas.width !== tile.w || canvas.height !== tile.h) {
          canvas.width = tile.w;
          canvas.height = tile.h;
        }
        ctx.drawImage(sheet, tile.x, tile.y, tile.w, tile.h, 0, 0, tile.w, tile.h);
        canvas.toggleAttribute('data-drawn', true);
      }
      void sharpAt(this.#container, book, time, page).then((image) => {
        if (!image || this.#page !== page || !this.#canvas) return;
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.getContext('2d')?.drawImage(image, 0, 0);
        canvas.toggleAttribute('data-drawn', true);
      });
    }
    // Up only with a page on it: an empty canvas would be a hole in the picture.
    if (this.#up && canvas.hasAttribute('data-drawn')) canvas.toggleAttribute('data-on', true);
  }

  /** One frame's length, by whichever picture has learned it; until then a frame is taken to be no longer than a twentieth of a second. */
  #frame(): number {
    return this.#filmClock?.sure ? this.#filmClock.span : this.#clock?.sure ? this.#clock.span : 0.05;
  }

  /**
   * At rest, the copy is held to the frame it was asked for, as the film is (goto.ts): Safari now and then leaves a
   * paused video on the frame from the seek before, and says so (the frame it names is not its clock's). A seek a
   * millisecond on brings the picture.
   */
  #hold() {
    const video = this.#video;
    const clock = this.#clock;
    const landing = this.#landing;
    if (!video || !clock || landing == null || !this.#up || this.#busy || video.seeking || this.#held >= 3) return;
    if (clock.time == null || (video.currentTime - clock.time > -HAIR && video.currentTime - clock.time < this.#frame() + HAIR)) return;
    this.#held++;
    this.#want = this.#asked = video.currentTime + 0.001;
    this.#busy = true;
    this.#askedAt = performance.now();
    video.currentTime = this.#want;
  }

  // ─── Leaving ──────────────────────────────────────────────────────────────

  /** Whether the film itself now shows the landing: then the stand-in has nothing left to do. */
  #settle() {
    const landing = this.#landing;
    const film = this.#film;
    if (landing == null || !this.#up) return;
    const copy = this.kind === 'copy' && this.#state === 'ready';
    // (The copy's own frame for the landing first: it does not leave before it has shown what it was asked.)
    if (copy && (this.#busy || Math.abs(this.#asked - landing) >= 0.004 + HAIR)) return;
    if (film.seeking) return;
    // The film has been sent somewhere else since. Held still, any other place is that (but not a hair's breadth: a
    // film nudged onto its frame, goto.ts, is still here). Playing, its clock moves by itself, and may start a little
    // before the landing (Safari plays a stream on from the keyframe before it): only far from it is somewhere else.
    if (Math.abs(film.currentTime - landing) > (film.paused ? HAIR : ELSEWHERE)) {
      this.leave();
      return;
    }
    const filmClock = this.#filmClock;
    if (!filmClock) {
      // A browser that names no frames: a film that has landed has shown its frame a moment later.
      clearTimeout(this.#landedTimer);
      this.#landedTimer = window.setTimeout(() => {
        if (this.#landing === landing && !film.seeking) this.leave();
      }, LANDED_AFTER);
      return;
    }
    // (`seeked` is not the frame: Safari reports a stream's seek done well before it shows the picture. The frame is.)
    const shown = filmClock.time;
    const span = this.#frame();
    // Held still on the landing: the frame that holds that moment. Playing on from it: a frame at it or after, shown
    // since it began to (the frame it held before it played does not count: Safari plays a stream on from the
    // keyframe before the place it was held at, and the picture would step back).
    let there = shown != null && film.paused && landing - shown > -HAIR && landing - shown < span + HAIR;
    if (shown != null && !film.paused) {
      // (And not on the first such frame alone: Safari, now and then, names the frame the film was held on as it
      // begins to play, and only then goes back to the keyframe: two frames running, the second on from the first.)
      const on = filmClock.count > this.#playedFrom && shown > landing - span;
      there = on && this.#on != null && filmClock.count > this.#on.count && shown > this.#on.time;
      this.#on = on ? { count: filmClock.count, time: shown } : null;
    }
    if (there) {
      this.leave();
      return;
    }
    // Landed, and showing another frame: asked once more, a millisecond on (the film may hold a frame from before:
    // goto.ts does the same for any paused seek). After that a copy simply stays: it is the exact frame, and a film
    // held still on another one has nothing better to show. (It leaves when the film plays, shows the frame, or is
    // sent elsewhere.) The pages are not the frame, so they give the picture back to a film that never shows it.
    clearTimeout(this.#landedTimer);
    const again = film.paused && this.#asks < 2;
    if (!again && copy && film.paused) return;
    this.#landedTimer = window.setTimeout(() => {
      if (this.#landing !== landing || film.seeking) return;
      if (film.paused && this.#asks < 2) {
        this.#asks++;
        this.#landing = landing + 0.001;
        film.currentTime = this.#landing;
        return;
      }
      this.leave();
    }, again ? ASK_AGAIN : GIVE_UP);
  }
}
