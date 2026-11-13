/**
 * The sound of pages under a thumb: one short tick of filtered noise per page, made here with Web Audio (no file to
 * load or license). A slow riffle is a few soft, low ticks; a fast one is a brighter, closer flutter: level and pitch
 * follow the pages per second.
 *
 * On by default; the viewer turns it off with "Page sound" in Settings, and a page with `data-fb-flutter="off"`
 * (sound.ts has the rule). It only sounds while a hand is on the edge of a film that isn't muted, at the film's own
 * volume and well under it; never before a gesture in the player (the context is made by the first press or key),
 * and never in an automated browser.
 */
import { pageSound } from './sound';


/** Ticks closer together than this run into one sound: the fastest riffle is a flutter, not a buzz. */
const GAP = 1 / 36;
/** Pages per second at which the flutter is as bright and as loud as it gets. */
const FAST = 30;
/** The loudest tick, as a share of the film's volume. */
const LEVEL = 0.16;

type AudioWindow = Window & { webkitAudioContext?: typeof AudioContext };

/** Half a second of white noise, shared by every tick: each one reads a few milliseconds from a random place in it. */
function noise(context: BaseAudioContext): AudioBuffer {
  const buffer = context.createBuffer(1, Math.floor(context.sampleRate / 2), context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/**
 * One page: a burst of noise through a band-pass (paper is all upper-mids, no thump and no hiss), up in two
 * milliseconds and gone in thirty to fifty. `speed` is pages per second; `level` the film's volume, 0–1.
 * Works on any context, so the same page can be rendered offline (design/previews/flip-r1/flutter.wav).
 */
export function page(context: BaseAudioContext, out: AudioNode, buffer: AudioBuffer, when: number, speed: number, level: number): void {
  const pace = Math.min(1, Math.max(0, speed / FAST));
  const source = context.createBufferSource();
  source.buffer = buffer;
  const band = context.createBiquadFilter();
  band.type = 'bandpass';
  // A slow page is a low, papery tick; fast ones climb, with a little spread so no two are the same.
  band.frequency.value = (1500 + pace * 2600) * (0.9 + Math.random() * 0.2);
  band.Q.value = 0.8;
  const floor = context.createBiquadFilter();
  floor.type = 'highpass';
  floor.frequency.value = 700;
  const gain = context.createGain();
  const peak = level * LEVEL * (0.45 + pace * 0.55);
  const length = 0.05 - pace * 0.022;
  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(peak, when + 0.002);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * 0.01), when + length);
  source.connect(band).connect(floor).connect(gain).connect(out);
  source.start(when, Math.random() * 0.4, length + 0.01);
}

export class Flutter {
  #context: AudioContext | null = null;
  #buffer: AudioBuffer | null = null;
  #last = 0;
  #scope: Element | null = null;

  /** Whether this player may sound at all: not in an automated browser, and only where the page sound is on. */
  static allowed(scope: Element): boolean {
    return !navigator.webdriver && pageSound(scope);
  }

  /** Called from a press or a key in the player: the first one makes the context (a gesture is what lets it sound). */
  arm(scope: Element) {
    this.#scope = scope;
    if (this.#context || !Flutter.allowed(scope)) return;
    const Context = window.AudioContext ?? (window as AudioWindow).webkitAudioContext;
    if (!Context) return;
    try {
      this.#context = new Context({ latencyHint: 'interactive' });
      this.#buffer = noise(this.#context);
    } catch {
      this.#context = null;
    }
  }

  /**
   * Called when a finger lifts, a key goes down or a click lands in the player: the moments a browser counts as the
   * visitor's own act. On an iPhone a context made on the way down of a touch is born suspended and only one of
   * these may start it (measured on iOS 27.2.1, 12 Nov 2026: made on pointerdown, it never ran, and no page sounded).
   */
  wake(scope: Element) {
    this.arm(scope);
    const context = this.#context;
    if (context && context.state !== 'running') void context.resume().catch(() => undefined);
  }

  /** A page went under the thumb. Silent while the film is muted or at zero, or before a gesture. */
  tick(video: HTMLVideoElement | null, speed: number) {
    const context = this.#context;
    if (!context || !this.#buffer || !video || video.muted || video.volume <= 0) return;
    // Turned off in Settings since it was armed: silent from the next page on.
    if (this.#scope && !Flutter.allowed(this.#scope)) return;
    if (context.state !== 'running') {
      void context.resume().catch(() => undefined);
      return;
    }
    const now = context.currentTime;
    if (now - this.#last < GAP) return;
    this.#last = now;
    page(context, context.destination, this.#buffer, now, speed, video.volume);
  }

  close() {
    void this.#context?.close().catch(() => undefined);
    this.#context = null;
    this.#buffer = null;
  }
}

export { noise as flutterNoise };
