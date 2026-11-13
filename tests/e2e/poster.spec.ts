import { type Page } from '@playwright/test';
import { BARE, featured, open } from './support/player';
import { expect, test } from './support/test';

/**
 * The film under its poster (src/skins/flipbook/skin.css, room.ts).
 *
 * A browser may draw a film's first frame before anyone plays it, under the opaque poster, where nobody sees it. On a
 * phone that frame, a row of pixels larger than the page's own picture, was the page's largest contentful paint, and
 * on a slow connection it is seconds late (Lighthouse: 8.2 s, 13 Nov 2026). So while the poster stands, the film
 * under it is not painted: hidden, and clipped to nothing (Chromium counts a film's first frame whatever its
 * visibility or opacity, and counts none for a film clipped away; measured). The same state shows the one and hides
 * the other, so there is never a frame with neither; and a poster with no picture to show (none given, or one that
 * failed) leaves the film's own first frame in sight.
 *
 * The page's own measure of it, on the showcase with the real stream, is scripts/site-lighthouse.mjs.
 */

const film = (page: Page) => page.locator('video:not(.fb-stand)');
const painted = (page: Page) =>
  film(page).evaluate((video) => {
    const style = getComputedStyle(video);
    const box = video.getBoundingClientRect();
    return { visibility: style.visibility, clip: style.clipPath, box: [Math.round(box.width), Math.round(box.height)] };
  });

test.describe('the film under its poster', () => {
  test('while the poster stands the film is not painted, and keeps its box; no paint of it is counted', async ({ page, browserName }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __lcp: string[] };
      w.__lcp = [];
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) w.__lcp.push((entry as unknown as { element?: Element }).element?.tagName ?? '?');
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      } catch {
        // No such entries in this engine (WebKit): the styles below are what is held there.
      }
    });
    await open(page, BARE);
    await expect(page.locator('.media-poster')).toHaveAttribute('data-visible', '');
    await expect.poll(() => page.locator('.media-poster-image').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0), { message: 'the poster’s picture is in' }).toBe(true);
    // (Chromium has the film's first frame by now, and would draw it; Safari reads no picture before a play.)
    await expect.poll(() => film(page).evaluate((video: HTMLVideoElement) => video.readyState), { message: 'the film has opened, with its first frame where the browser reads one' }).toBeGreaterThanOrEqual(browserName === 'chromium' ? 2 : 1);
    const under = await painted(page);
    expect(under.visibility, 'the film under the poster').toBe('hidden');
    expect(under.clip, 'and clipped to nothing').toBe('inset(50%)');
    const poster = await page.locator('.media-poster').evaluate((el) => [Math.round(el.getBoundingClientRect().width), Math.round(el.getBoundingClientRect().height)]);
    expect(under.box, 'its box is the poster’s still').toEqual(poster);
    await page.waitForTimeout(600);
    if (browserName === 'chromium') {
      const counted = await page.evaluate(() => (window as unknown as { __lcp: string[] }).__lcp);
      expect(counted.length, 'paints counted on the page').toBeGreaterThan(0);
      expect(counted.filter((tag) => tag === 'VIDEO'), 'the film among them').toEqual([]);
    }
  });

  test('the first play shows the film on the very frame the poster leaves: never neither, never both', async ({ page }) => {
    await open(page, BARE);
    await expect(page.locator('.media-poster')).toHaveAttribute('data-visible', '');
    await page.evaluate(() => {
      const video = document.querySelector('video:not(.fb-stand)') as HTMLVideoElement;
      const poster = document.querySelector('.media-poster') as HTMLElement;
      const seen: { poster: boolean; film: boolean }[] = [];
      (window as unknown as { __seen: typeof seen }).__seen = seen;
      const look = () => {
        const style = getComputedStyle(video);
        seen.push({ poster: poster.hasAttribute('data-visible') && getComputedStyle(poster).display !== 'none', film: style.visibility === 'visible' && style.clipPath === 'none' });
        if (seen.length < 600) requestAnimationFrame(look);
      };
      requestAnimationFrame(look);
    });
    await page.locator('media-container').evaluate((el: HTMLElement) => el.focus({ preventScroll: true }));
    await page.keyboard.press('k');
    await page.waitForFunction(() => (document.querySelector('video:not(.fb-stand)') as HTMLVideoElement).currentTime > 0.6);
    const seen = await page.evaluate(() => (window as unknown as { __seen: { poster: boolean; film: boolean }[] }).__seen);
    expect(seen.length, 'frames looked at').toBeGreaterThan(10);
    expect(seen.filter((frame) => !frame.poster && !frame.film).length, 'frames with neither the poster nor the film').toBe(0);
    expect(seen.filter((frame) => frame.poster && frame.film).length, 'frames with both').toBe(0);
    expect(seen.at(-1), 'playing: the film, and no poster').toEqual({ poster: false, film: true });
  });

  test('a poster that fails to load leaves the film’s own first frame in sight', async ({ page }) => {
    await page.route(/\/media\/film\/poster[^/]*\.(webp|avif|jpg)/, (route) => route.abort());
    await open(page, BARE);
    await expect(page.locator('media-container')).toHaveAttribute('data-fb-posterless', '');
    expect(await painted(page)).toMatchObject({ visibility: 'visible', clip: 'none' });
  });

  test('a film given no poster is in sight from the start', async ({ page }) => {
    await page.goto(featured(`${BARE}&film=bare`));
    await expect.poll(() => film(page).evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(1);
    await expect(page.locator('media-container')).toHaveAttribute('data-fb-posterless', '');
    expect(await painted(page)).toMatchObject({ visibility: 'visible', clip: 'none' });
  });
});
