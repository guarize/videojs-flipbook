import { type Page } from '@playwright/test';
import { BARE, DURATION, open } from './support/player';
import { expect, test } from './support/test';

/**
 * "Resume from 0:30" (src/shared/extras/resume.ts, place.ts): the place a viewer stopped at is kept under the film's
 * address with the film's length, and offered only on a film of that length. An address can come to serve another
 * film (this one did: a 62.867 s film gave way to a 98 s one), and a place in the old one means nothing in the new.
 */

const offer = (page: Page) => page.locator('.fb-resume-button').first();
/** The key the film's place is kept under: its name for this browser (`data-fb-film`, the first source given), else its address. */
const key = (page: Page) =>
  page.evaluate(() => {
    const video = document.querySelector('video') as HTMLVideoElement;
    return `x-resume:${new URL((video.getAttribute('data-fb-film') ?? video.getAttribute('src')) as string, location.href).pathname}`;
  });

async function openWith(page: Page, value: (duration: number) => string) {
  await open(page, BARE);
  const name = await key(page);
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [name, value(DURATION)] as const);
  await open(page, BARE);
  return name;
}

test.describe('the place kept for a film', () => {
  test.afterEach(async ({ page }) => {
    await page.evaluate(() => localStorage.clear());
  });

  test('is offered on the film it was kept for', async ({ page }) => {
    await openWith(page, (duration) => JSON.stringify({ t: 30, d: duration }));
    await expect(offer(page)).toBeVisible();
    await expect(offer(page)).toHaveText(/0:30/);
  });

  test('kept for a film of another length (62.867 s) is not offered on this one, and is forgotten', async ({ page }) => {
    const name = await openWith(page, () => JSON.stringify({ t: 15, d: 62.867 }));
    // The film's length is known, so the offer has been decided.
    await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), name)).toBeNull();
    await expect(offer(page)).toBeHidden();
  });

  test('kept as a bare number, before the length was kept, is not offered either', async ({ page }) => {
    const name = await openWith(page, () => '15');
    await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), name)).toBeNull();
    await expect(offer(page)).toBeHidden();
  });

  test('is kept with the film’s length when the viewer stops', async ({ page }) => {
    await open(page, BARE);
    const name = await key(page);
    await page.evaluate(() => new Promise<void>((resolve) => {
      const video = document.querySelector('video') as HTMLVideoElement;
      video.addEventListener('seeked', () => resolve(), { once: true });
      void video.play().then(() => {
        video.currentTime = 40;
      });
    }));
    await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).pause());
    await expect.poll(async () => JSON.parse((await page.evaluate((k) => localStorage.getItem(k), name)) ?? 'null')).toEqual({ t: 40, d: DURATION });
  });
});
