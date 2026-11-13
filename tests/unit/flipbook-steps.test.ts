import { describe, expect, it } from 'vitest';
import { chapterIndexAt, type DockState, nextChapterStart, positionState, previousChapterStart, shouldDock } from '../../src/skins/flipbook/steps';

// The review film's chapters (apps/preview/public/media/film/chapters.vtt).
const chapters = [
  { startTime: 0, endTime: 6.857 },
  { startTime: 6.857, endTime: 13.714 },
  { startTime: 13.714, endTime: 20.571 },
  { startTime: 20.571, endTime: 30.857 },
  { startTime: 30.857, endTime: 44.571 },
  { startTime: 44.571, endTime: 60.867 },
];

describe('the chapter a time falls in', () => {
  it('finds it, counting a start as inside', () => {
    expect(chapterIndexAt(chapters, 0)).toBe(0);
    expect(chapterIndexAt(chapters, 6.856)).toBe(0);
    expect(chapterIndexAt(chapters, 6.857)).toBe(1);
    expect(chapterIndexAt(chapters, 50)).toBe(5);
  });

  it('holds the last past the end, and none before the first or without chapters', () => {
    expect(chapterIndexAt(chapters, 99)).toBe(5);
    expect(chapterIndexAt([{ startTime: 2, endTime: 4 }], 1)).toBe(-1);
    expect(chapterIndexAt([], 5)).toBe(-1);
  });
});

describe('previous chapter', () => {
  it('goes back to the start of the chapter playing, a few seconds in', () => {
    expect(previousChapterStart(chapters, 25)).toBe(20.571);
    expect(previousChapterStart(chapters, 3.5)).toBe(0);
  });

  it('goes to the chapter before at a chapter’s start', () => {
    expect(previousChapterStart(chapters, 20.571)).toBe(13.714);
    expect(previousChapterStart(chapters, 22)).toBe(13.714);
  });

  it('stays at the beginning in the first chapter, and without chapters', () => {
    expect(previousChapterStart(chapters, 1)).toBe(0);
    expect(previousChapterStart([], 12)).toBe(0);
  });
});

describe('next chapter', () => {
  it('goes to the start of the chapter after', () => {
    expect(nextChapterStart(chapters, 0)).toBe(6.857);
    expect(nextChapterStart(chapters, 25)).toBe(30.857);
  });

  it('skips a chapter starting this instant (a page turn just landed on it)', () => {
    expect(nextChapterStart(chapters, 6.83)).toBe(13.714);
  });

  it('has nowhere to go in the last chapter', () => {
    expect(nextChapterStart(chapters, 50)).toBeNull();
    expect(nextChapterStart([], 0)).toBeNull();
  });
});

describe('the position handed to the system', () => {
  it('is refused until the duration is known', () => {
    expect(positionState(Number.NaN, 0, 1)).toBeNull();
    expect(positionState(Number.POSITIVE_INFINITY, 0, 1)).toBeNull();
    expect(positionState(0, 0, 1)).toBeNull();
  });

  it('keeps the position inside the film and the rate non-zero', () => {
    expect(positionState(60, 75, 1)).toEqual({ duration: 60, position: 60, playbackRate: 1 });
    expect(positionState(60, -2, 2)).toEqual({ duration: 60, position: 0, playbackRate: 2 });
    expect(positionState(60, 10, 0)).toEqual({ duration: 60, position: 10, playbackRate: 1 });
  });
});

describe('the mini player', () => {
  const away: DockState = { optedIn: true, outOfView: true, playing: true, pip: false, fullscreen: false, dismissed: false };

  it('floats a playing film whose place is out of view', () => {
    expect(shouldDock(false, away)).toBe(true);
  });

  it('only on a page that asks for it', () => {
    expect(shouldDock(false, { ...away, optedIn: false })).toBe(false);
  });

  it('not before it plays, but pausing afloat keeps it there', () => {
    expect(shouldDock(false, { ...away, playing: false })).toBe(false);
    expect(shouldDock(true, { ...away, playing: false })).toBe(true);
  });

  it('comes back when its place is in view', () => {
    expect(shouldDock(true, { ...away, outOfView: false })).toBe(false);
  });

  it('never in picture-in-picture or fullscreen, and not once closed', () => {
    expect(shouldDock(true, { ...away, pip: true })).toBe(false);
    expect(shouldDock(true, { ...away, fullscreen: true })).toBe(false);
    expect(shouldDock(true, { ...away, dismissed: true })).toBe(false);
    expect(shouldDock(false, { ...away, dismissed: true })).toBe(false);
  });
});
