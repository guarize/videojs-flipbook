/**
 * The frame on screen.
 *
 * A film's clock (`currentTime`) and its picture are two things. The clock is set the moment a seek is asked; the
 * picture follows when the frame has been decoded, and a browser may pause with a frame on screen that is not the
 * clock's (Safari stops a few frames behind it). Where the browser says which frame it has just shown
 * (`requestVideoFrameCallback`, whose `mediaTime` is that frame's own time, measured in Chromium and WebKit), this
 * keeps the last one for every part that must act on the picture and not on the clock: a step of exactly one frame
 * (flip.ts), a pause that must print the frame the eye saw (goto.ts), the stand-in that waits for the film to show a
 * frame before it leaves (stand.ts).
 *
 * It also learns one frame's length: while the film plays at its own speed, the shortest step between frames shown;
 * or told by a step that proved it (`learn`). Until then it is a guess, and says so.
 *
 * A browser shows a frame only when the picture changes: a paused seek inside the frame already on screen calls
 * nothing in WebKit, and a seek to the very same time calls nothing in Chromium. So "no frame came" is an answer
 * too, and `next` gives it after a wait.
 *
 * Firefox names a frame by its own time only while the film plays. A frame it shows for a seek is named by the
 * moment that was asked for (measured, Firefox 157: sought to 0:20.02, the frame that begins at 0:20.00 is named
 * 20.02). A step that takes that for the frame's own time finds "another frame" in every seek, whatever is on the
 * glass. So a name that is a moment the film was asked for is put back on the frame it falls in, counted from a
 * frame the film played. Only such a name: any other is a frame's own time and is answered as it is, at any distance
 * (Chromium and WebKit name a sought frame so).
 *
 * And only as far as the count can be vouched for. Chromium writes a frame's time to the microsecond, so a 24th of a
 * second learned from eight steps is 0.041666, 0.67 µs short: 1.6 ms out at the end of a film of 98 s, 9.6 ms ten
 * minutes away, the frame before. So the length used for counting is measured over the whole run the film has
 * played, first frame to last, and is as sure as the run is long; how far out a count may be is reckoned from that
 * and from how roughly the names keep to their line; and past a millisecond of doubt, or with nothing played, the
 * name is answered as it is and `own` says it cannot be vouched for.
 */

/** Frames at the film's own speed are this far apart, give or take: anything else is a seek or a stall. */
const SHORTEST = 0.008;
const LONGEST = 0.11;
/** This many steps seen before the shortest is believed. */
const ENOUGH = 8;
/** A frame's time is written to the microsecond at the coarsest seen (Chromium). */
const WRITTEN = 1e-6;
/** Frames are counted from one the film played only while the count may be this far out at most. */
const VOUCHED = 0.001;

export class FrameClock {
  /** The media time of the frame last shown, or null before any has been. */
  time: number | null = null;
  /** How many frames have been shown: a new frame has a new count. */
  count = 0;
  /** When the last one was shown (`performance.now()`). */
  at = 0;
  /** One frame's length in seconds: a thirtieth until it is learned (`sure`). */
  span = 1 / 30;
  sure = false;
  /** Whether `time` is a frame's own time: not when it is only the moment a seek asked for, with no counting to
   *  put it on its frame by. */
  own = true;
  #video: HTMLVideoElement;
  #spans: number[] = [];
  #watchers = new Set<(time: number) => void>();
  /** Frames the film has gone on to by itself since it last sought, paused or changed pace: from the second on, a
   *  name is the frame's own in every browser (the first may be the frame a seek left on the glass). */
  #run = 0;
  /** The own time of a frame the film played, the latest: with one frame's length, where every frame begins. */
  #played: number | null = null;
  #named = 0;
  /** The run being played, from the first frame counted: its own time, and the frames gone by since (none counted
   *  yet: -1). */
  #from = 0;
  #gone = -1;
  /** One frame's length over the longest run played, and that run's frames: the longer, the surer. */
  #counted: { span: number; frames: number } | null = null;
  /** How far a played frame's name has been seen off its line: the microsecond it is written to, at least. */
  #rough = WRITTEN;
  /** The moments the film was last asked for: a frame can come on the glass after the next has been asked. */
  #asked: number[] = [];

  constructor(video: HTMLVideoElement) {
    this.#video = video;
    video.addEventListener('seeking', () => {
      this.#run = 0;
      this.#asked = [...this.#asked.slice(-7), video.currentTime];
    });
    const shown: VideoFrameRequestCallback = (_now, frame) => {
      this.#run = !video.paused && !video.seeking && video.playbackRate === 1 ? this.#run + 1 : 0;
      const step = frame.mediaTime - this.#named;
      this.#named = frame.mediaTime;
      // (A step is between two frames the film played: the third of a run is the first with one behind it.)
      if (!this.sure && this.#run > 2 && step > SHORTEST && step < LONGEST) {
        this.#spans.push(step);
        if (this.#spans.length >= ENOUGH) this.learn(Math.min(...this.#spans));
      }
      if (this.#run > 1) {
        this.#count(frame.mediaTime, step);
        this.#played = frame.mediaTime;
        this.own = true;
        this.time = frame.mediaTime;
      } else {
        this.#gone = -1;
        this.time = this.#frame(frame.mediaTime);
      }
      this.count++;
      this.at = performance.now();
      for (const watcher of [...this.#watchers]) watcher(this.time);
      video.requestVideoFrameCallback(shown);
    };
    video.requestVideoFrameCallback(shown);
  }

  /** A frame the film has gone on to, `step` after the one before: the run is a frame or more longer. */
  #count(named: number, step: number) {
    if (!this.sure) return;
    if (this.#gone < 0) {
      this.#from = named;
      this.#gone = 0;
      return;
    }
    const frames = Math.round(step / this.span);
    this.#rough = Math.max(this.#rough, Math.abs(step - frames * (this.#counted?.span ?? this.span)));
    this.#gone += frames;
    if (this.#gone > (this.#counted?.frames ?? 0)) this.#counted = { span: (named - this.#from) / this.#gone, frames: this.#gone };
  }

  /** The time of the frame a name shown for a seek belongs to. */
  #frame(named: number): number {
    // Not a moment the film was asked for: a frame's own time.
    this.own = ![this.#video.currentTime, ...this.#asked].some((asked) => Math.abs(named - asked) <= WRITTEN);
    if (this.own || !this.#counted || this.#played == null) return named;
    const { span, frames: run } = this.#counted;
    const frames = (named - this.#played) / span;
    // How far out the count may be, this many frames from the last one played.
    const doubt = (Math.abs(frames) / run + 1) * 2 * this.#rough;
    // Past vouching for; or on a frame's start as near as can be told, which is that frame's own name or a moment a
    // hair to either side of it.
    if (doubt > VOUCHED || Math.abs(frames - Math.round(frames)) * span <= doubt) return named;
    this.own = true;
    return this.#played + Math.floor(frames) * span;
  }

  /** One frame's length, from something that measured it exactly. */
  learn(span: number) {
    if (!(span > SHORTEST / 2 && span < 1)) return;
    this.span = span;
    this.sure = true;
    this.#spans = [];
  }

  /** Hears every frame as it is shown. Returns the way to stop hearing. */
  watch(watcher: (time: number) => void): () => void {
    this.#watchers.add(watcher);
    return () => this.#watchers.delete(watcher);
  }

  /** The next frame shown, or null if none is within `ms` (the picture did not change). */
  next(ms: number): Promise<number | null> {
    return new Promise((resolve) => {
      const stop = this.watch((time) => {
        clearTimeout(timer);
        stop();
        resolve(time);
      });
      const timer = window.setTimeout(() => {
        stop();
        resolve(null);
      }, ms);
    });
  }

  /**
   * Seeks, and answers with the frame on screen once the seek has landed: the new frame's time, or the one that was
   * already there if the picture did not change (`patience` ms are given to a frame that comes after `seeked`). Null
   * if the seek never landed.
   */
  async seek(time: number, patience = 120, lost = 1500): Promise<number | null> {
    const video = this.#video;
    const before = this.count;
    const landed = new Promise<boolean>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        video.removeEventListener('seeked', done);
        resolve(true);
      };
      const timer = window.setTimeout(() => {
        video.removeEventListener('seeked', done);
        resolve(false);
      }, lost);
      video.addEventListener('seeked', done);
    });
    video.currentTime = time;
    if (!(await landed)) return null;
    if (this.count === before) await this.next(patience);
    return this.time;
  }
}

const clocks = new WeakMap<HTMLVideoElement, FrameClock>();

/** The film's frame clock, started the first time it is asked for; null where the browser cannot say what it shows. */
export function frameClock(video: HTMLVideoElement | null | undefined): FrameClock | null {
  if (!video || typeof video.requestVideoFrameCallback !== 'function') return null;
  let clock = clocks.get(video);
  if (!clock) {
    clock = new FrameClock(video);
    clocks.set(video, clock);
  }
  return clock;
}
