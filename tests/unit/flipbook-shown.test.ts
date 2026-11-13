import { describe, expect, it } from 'vitest';
import { FrameClock } from '../../src/skins/flipbook/shown';

/**
 * The frame clock on films longer than a minute and a half (shown.ts).
 *
 * A film that is not there: its frames are shown by hand, each under the name the engine would give it, measured on
 * the bench (13 Nov 2026):
 *
 * - Chromium writes a frame's time to the microsecond (0.041667, 0.083333: steps of 0.041666 and 0.041667), and
 *   names a frame shown for a seek by its own time;
 * - WebKit names every frame by its own time, in full;
 * - Firefox does the same while the film plays, and names a frame shown for a seek by the moment that was asked for.
 *
 * The clock puts a seek's name back on the frame it falls in (for Firefox). It counted frames from the last one
 * played with a frame's length learned from eight steps: 0.041666 for a 24th of a second, 0.67 µs short, 9.6 ms out
 * ten minutes away. There a frame's own time in Chromium read as "between two frames" and was put back, onto the
 * frame before.
 */

type Engine = 'chromium' | 'webkit' | 'firefox';

class Film {
  paused = true;
  seeking = false;
  playbackRate = 1;
  currentTime = 0;
  #asked: VideoFrameRequestCallback[] = [];
  #heard = new Map<string, (() => void)[]>();

  requestVideoFrameCallback(callback: VideoFrameRequestCallback): number {
    this.#asked.push(callback);
    return this.#asked.length;
  }

  addEventListener(type: string, listener: () => void): void {
    this.#heard.set(type, [...(this.#heard.get(type) ?? []), listener]);
  }

  say(type: string): void {
    for (const listener of this.#heard.get(type) ?? []) listener();
  }

  /** A frame is on the glass, under this name. */
  show(mediaTime: number): void {
    for (const callback of this.#asked.splice(0)) callback(0, { mediaTime } as VideoFrameCallbackMetadata);
  }
}

const micro = (time: number) => Math.round(time * 1e6) / 1e6;

/** A film of `fps` frames a second in one engine: played, and sought while paused. */
function film(engine: Engine, fps: number) {
  const video = new Film();
  const clock = new FrameClock(video as unknown as HTMLVideoElement);
  const start = (frame: number) => frame / fps;
  /** The name the engine gives frame `frame` when the film itself goes on to it. */
  const own = (frame: number) => (engine === 'chromium' ? micro(start(frame)) : start(frame));
  /** The film is asked for `time`, and has not shown it yet. */
  const ask = (time: number) => {
    video.seeking = true;
    video.currentTime = time;
    video.say('seeking');
    video.seeking = false;
  };
  /** The frame a seek asked for comes on the glass, under the engine's name for it (`frame` is the one it falls in). */
  const show = (time: number, frame: number) => video.show(engine === 'firefox' ? time : own(frame));
  return {
    clock,
    start,
    own,
    ask,
    show,
    /** Plays `frames` frames from frame `from`, then pauses on the last. */
    play(from: number, frames: number) {
      video.paused = false;
      for (let frame = from; frame < from + frames; frame++) {
        video.currentTime = start(frame) + 0.004;
        video.show(own(frame));
      }
      video.paused = true;
    },
    /** A paused seek to `time`, which falls in frame `frame`. */
    seek(time: number, frame: number) {
      ask(time);
      show(time, frame);
    },
  };
}

const RATES = [
  ['24', 24],
  ['29.97', 30000 / 1001],
] as const;
const AWAY = [
  ['10 s', 10],
  ['2 min', 120],
  ['10 min', 600],
  ['60 min', 3600],
] as const;
/** How far into its frame a seek asks: on its start, a third in, and a hair before the next. */
const INTO = [0, 0.37, 0.98];
/** A frame's time is written to the microsecond at the coarsest. */
const EXACT = 1.5e-6;

describe('a paused seek far from the frames the film played', () => {
  for (const [rate, fps] of RATES) {
    for (const engine of ['chromium', 'webkit'] as const) {
      it(`${engine}, ${rate} frames a second: a frame named by its own time is answered as named, at any distance`, () => {
        for (const played of [12, 48]) {
          const { clock, own, start, play, seek } = film(engine, fps);
          play(3, played);
          expect(clock.sure, `a frame's length is known after ${played} frames`).toBe(true);
          const moved: string[] = [];
          for (const [name, seconds] of AWAY) {
            for (const into of INTO) {
              const frame = Math.round(seconds * fps);
              // (On its start: the very moment the engine names, as a page that keeps a frame's time asks for it.)
              seek(into === 0 ? own(frame) : start(frame) + into / fps, frame);
              if (clock.time !== own(frame)) moved.push(`${name} away, ${into} of a frame in: named ${own(frame)}, answered ${clock.time} (${(((clock.time ?? 0) - own(frame)) * 1000).toFixed(3)} ms)`);
            }
          }
          expect(moved, `after ${played} frames played`).toEqual([]);
        }
      });
    }

    it(`firefox, ${rate} frames a second: a seek's name is answered as the start of the frame it falls in, or not vouched for`, () => {
      for (const played of [12, 48]) {
        const { clock, start, play, seek } = film('firefox', fps);
        play(3, played);
        const wrong: string[] = [];
        const vouched: string[] = [];
        for (const [name, seconds] of AWAY) {
          for (const into of INTO) {
            const frame = Math.round(seconds * fps);
            seek(start(frame) + into / fps, frame);
            if (clock.own) vouched.push(name);
            // (Asked on a frame's very start, the name is that frame's time whether or not it is vouched for.)
            else if (into !== 0) continue;
            if (Math.abs((clock.time ?? 0) - start(frame)) > EXACT) wrong.push(`${name} away, ${into} of a frame in: the frame begins at ${start(frame)}, answered ${clock.time}`);
          }
        }
        expect(wrong, `after ${played} frames played`).toEqual([]);
        // The fix for Firefox stands where the frames can be counted: two minutes from two seconds of playing, for
        // both seeks that fall inside a frame.
        if (played === 48) expect(vouched.filter((name) => name === '10 s' || name === '2 min').length, 'seeks inside a frame vouched for within two minutes').toBe(4);
      }
    });
  }

  // Keys pressed faster than the film shows their frames: a frame comes on the glass when the film has already been
  // asked for the next. Its name is then not the film's clock any more, and was answered as a frame's own time: five
  // quick presses of . landed six frames on (steps.spec.ts, Firefox, 3 runs in 7).
  it('firefox: a frame shown after the next seek has been asked is still put back on its own frame', () => {
    const { clock, start, play, ask, show } = film('firefox', 24);
    play(3, 48);
    ask(start(480) + 0.02);
    ask(start(481) + 0.02);
    show(start(480) + 0.02, 480);
    expect(clock.own).toBe(true);
    expect(clock.time).toBeCloseTo(start(480), 9);
    show(start(481) + 0.02, 481);
    expect(clock.time).toBeCloseTo(start(481), 9);
  });

  it('firefox, before the film has played: a seek’s name is not vouched for', () => {
    const { clock, start, seek } = film('firefox', 24);
    seek(start(480) + 0.02, 480);
    expect(clock.own).toBe(false);
    expect(clock.time).toBe(start(480) + 0.02);
  });
});
