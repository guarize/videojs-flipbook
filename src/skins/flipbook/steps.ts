/**
 * Pure decisions the picture-in-picture companions make, kept apart so they can be tested without a browser.
 */

export interface ChapterSpan {
  startTime: number;
  endTime: number;
}

/** Seconds into a chapter after which "previous" goes back to its start rather than to the chapter before. */
export const RESTART_WITHIN = 3;

/** The chapter a time falls in: past the last one's end counts as the last, before the first as none (-1). */
export function chapterIndexAt(chapters: readonly ChapterSpan[], time: number): number {
  if (!chapters.length || time < chapters[0].startTime) return -1;
  for (let i = chapters.length - 1; i >= 0; i--) {
    if (time >= chapters[i].startTime) return i;
  }
  return -1;
}

/**
 * Where "previous chapter" goes, as a track's previous key does on a record: a few seconds into a chapter, back to its
 * start; at its start, to the chapter before; in the first chapter, to the beginning.
 */
export function previousChapterStart(chapters: readonly ChapterSpan[], time: number, within = RESTART_WITHIN): number {
  const index = chapterIndexAt(chapters, time);
  if (index < 0) return 0;
  const start = chapters[index].startTime;
  if (time - start > within) return start;
  return index > 0 ? chapters[index - 1].startTime : 0;
}

/** Where "next chapter" goes: the start of the chapter after the one playing, or null in the last. */
export function nextChapterStart(chapters: readonly ChapterSpan[], time: number): number | null {
  const next = chapters.find((chapter) => chapter.startTime > time + 0.05);
  return next ? next.startTime : null;
}

/** A position state the Media Session accepts: a finite, positive duration, a non-zero rate, a position inside. */
export function positionState(duration: number, position: number, rate: number): MediaPositionState | null {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const playbackRate = Number.isFinite(rate) && rate !== 0 ? rate : 1;
  const at = Number.isFinite(position) ? Math.min(Math.max(position, 0), duration) : 0;
  return { duration, playbackRate, position: at };
}

export interface DockState {
  /** The page asked for it (`data-fb-float`). */
  optedIn: boolean;
  /** The player's place on the page is scrolled out of view. */
  outOfView: boolean;
  playing: boolean;
  /** In a picture-in-picture window: the film is already elsewhere. */
  pip: boolean;
  fullscreen: boolean;
  /** Closed from the dock: stays closed until the player's place comes back into view. */
  dismissed: boolean;
}

/**
 * Whether the player floats in the corner. It goes there only while playing; once there, pausing keeps it there
 * (it would otherwise vanish under the hand that paused it). It comes back when its place is in view again.
 */
export function shouldDock(docked: boolean, state: DockState): boolean {
  if (!state.optedIn || !state.outOfView || state.pip || state.fullscreen || state.dismissed) return false;
  return docked || state.playing;
}
