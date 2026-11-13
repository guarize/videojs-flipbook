import { expect, type Page } from '@playwright/test';
import { BARE, pointerOnPlayer, startAndHold } from './player';

/**
 * The player with the book's extras but the plate: these tests are about the paused page itself (the print), its
 * corner and the band under it, without the strip of frames the plate prints in the page's foot.
 */
export const NO_PLATE = `${BARE}&features=${encodeURIComponent('turns deck contents ribbons curl cover hints next ear tear intertitle')}`;

export const container = (page: Page) => page.locator('media-container');

/** Paused at `time` with the print showing, the pointer on the picture and the controls up. */
export async function pausedAt(page: Page, time: number): Promise<void> {
  await pointerOnPlayer(page);
  await startAndHold(page, time);
  await expect(container(page)).toHaveAttribute('data-fb-print', '');
}

/** The bookmarks as they are stored for this film (marks.ts keeps them under `fb-ribbons:<path>`). */
export const storedMarks = (page: Page): Promise<number[]> =>
  page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('fb-ribbons:'));
    return key ? (JSON.parse(localStorage.getItem(key) ?? '[]') as number[]) : [];
  });

/** What the polite voice last said (pages.ts, `.fb-voice`). */
export const said = (page: Page) => page.locator('media-container > .fb-voice').first();

/** WCAG contrast of two `rgb()` colours. */
export function contrast(a: string, b: string): number {
  const lum = (colour: string) => {
    const [r, g, bl] = (colour.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => {
      const c = Number(v) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
