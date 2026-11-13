import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHAPTERS as SCENE_CHAPTERS } from '../../apps/preview/src/book/object';
import { parseVtt } from '../../src/shared/storyboard';
import { CHAPTERS, DURATION, PAGES, PER_PAGE, TITLES } from '../e2e/support/player';

/**
 * The film's numbers typed elsewhere (the battery's constants, the page's scenes) against the film's own tracks: a
 * new film, or a new cut of this one, fails here by name instead of somewhere in a browser.
 */
const track = (name: string) => parseVtt(readFileSync(new URL(`../../apps/preview/public/media/film/${name}`, import.meta.url), 'utf8'));
const chapters = track('chapters.vtt');
const pages = track('storyboard.vtt');
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

describe('the film, as the tests and the page count it', () => {
  it('the battery’s chapters, length and pages are the tracks’', () => {
    expect(chapters.map((c) => c.startTime)).toEqual(CHAPTERS);
    expect(chapters.map((c) => c.text)).toEqual(TITLES);
    expect(chapters.at(-1)?.endTime).toBe(DURATION);
    expect(pages).toHaveLength(PAGES);
    expect(pages[1].startTime).toBe(PER_PAGE);
    expect(pages.at(-1)?.endTime).toBe(DURATION);
  });

  it('the page’s scenes name each chapter, its time and the first page that shows it', () => {
    // The skin's rule (pageFrom, src/skins/flipbook/book.ts): the page starting at the chapter's start, or the next.
    const first = (time: number) => pages.findIndex((page) => page.startTime >= time - 0.05);
    expect(SCENE_CHAPTERS.map(({ n, name, page, t }) => ({ n, name, page, t }))).toEqual(
      chapters.map((c, i) => ({ n: i + 1, name: c.text, page: first(c.startTime), t: clock(c.startTime) })),
    );
  });

  it('every caption and description lies inside the film', () => {
    for (const name of ['captions.vtt', 'descriptions.vtt']) {
      const cues = track(name);
      expect(cues.length, name).toBeGreaterThan(0);
      for (const cue of cues) expect(cue.startTime < cue.endTime && cue.endTime <= DURATION, `${name}: ${cue.text}`).toBe(true);
    }
  });
});
