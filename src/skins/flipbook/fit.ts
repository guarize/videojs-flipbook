import { heightAt, under } from './renditions';
import { begun, ceiling, fitsHere, reopen } from './sources';

/**
 * Auto's ceiling, from a film's first opening to the first time its picture needs more.
 *
 * A browser's own HLS picks a rendition by the connection alone, and Chromium fills its buffer before anyone presses
 * play. What that costs goes with the ceiling the stream is asked under, and not always the way one would think
 * (measured on the showcase, 13 Nov 2026: a phone held upright took 6.1 MB under its screen's 1080p and 0.84 MB
 * under its box's 540p; a 1280 px window at 2x took 5.1 MB under its screen's 1440p and 6.1 MB under its box's
 * 1080p). And a ceiling lifted while the film plays holds a frame for about a second (quality.ts). So:
 *
 * - where the pointer can hover (a desktop), the stream is opened for all the screen can show and never opened
 *   again: play, then fullscreen, loads nothing (sources.ts, `ceiling`);
 * - on a touch screen it is first opened by its box, and lifted to the screen's ceiling once:
 *   - at once, in a browser that takes nothing of a film before a press: one that has stopped loading with its
 *     metadata and no picture buffered (Safari). There the megabytes were never at stake (below);
 *   - otherwise when its box grows past its ceiling, by Quality: unseen while the film is paused, with the frame held
 *     while it plays (Chrome on Android, the first time the phone is turned or the player takes the screen);
 * - on an iPhone, by the screen from the start (sources.ts).
 */
export function liftAtRest(video: HTMLVideoElement, signal: AbortSignal): void {
  const idle = () => {
    if (video.readyState < 1 || video.networkState !== HTMLMediaElement.NETWORK_IDLE || video.buffered.length) return;
    const src = video.getAttribute('src') ?? '';
    // (A height the viewer chose is not Auto: it has no ceiling to lift.)
    if (signal.aborted || begun(video) || !fitsHere(video, src) || heightAt(src) != null) return;
    const full = under(src, ceiling(null));
    if (full !== src) reopen(video, full);
  };
  for (const type of ['loadedmetadata', 'suspend']) video.addEventListener(type, idle, { signal });
  idle();
}
