import { type Page } from '@playwright/test';
import { BARE, DURATION, FRAME, open, pointerOnPlayer, startAndHold } from './support/player';
import { REAL_STREAM } from './support/silence.mjs';
import { expect, test } from './support/test';

/**
 * The real stream: the film as the showcase plays it, from Mux (apps/preview/src/site/media.ts).
 *
 * Opt-in, and never part of the battery (which is offline, and refuses every request to Mux): run it by itself with
 *
 *   FB_MUX=1 pnpm exec playwright test tests/e2e/mux.spec.ts --trace off --workers=1
 *
 * With FB_MUX=1 the silence helper lets Mux answer and makes every media element unmutable instead (support/
 * silence.mjs, `mute`): no browser plays a sound. It needs the network, so it measures nothing that must be exact to
 * the millisecond; what it holds is that the film plays from Mux, that a hand on the edge has a picture at once, that
 * nothing is ever blank, and that it lands on the frame.
 */

test.skip(!REAL_STREAM, 'the real stream is asked for only with FB_MUX=1');
test.describe.configure({ mode: 'serial', timeout: 120_000 });

const MUX = `${BARE}&source=mux`;
const film = (page: Page) => page.locator('video:not(.fb-stand)');
const stand = (page: Page) => page.locator('.fb-stand');

async function edge(page: Page) {
  const box = await page.locator('media-time-slider').boundingBox();
  if (!box) throw new Error('no fore-edge');
  return box;
}

/** A drag along the edge at a hand's pace, the hand resting before it lifts. */
async function dragAndRest(page: Page, from: number, to: number) {
  const box = await edge(page);
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * from, y);
  await page.mouse.down();
  await expect(page.locator('fb-flip')).toHaveAttribute('data-mode', 'drag');
  for (let i = 1; i <= 30; i++) {
    await page.mouse.move(box.x + box.width * (from + ((to - from) * i) / 30), y);
    await page.waitForTimeout(16);
  }
}

/** The film's frame as the browser names it, a moment from now (null if it names none). */
const frameShown = (page: Page) =>
  page.evaluate(() => new Promise<number | null>((resolve) => {
    const video = document.querySelector('video:not(.fb-stand)') as HTMLVideoElement;
    let last: number | null = null;
    const next = (_now: number, frame: VideoFrameCallbackMetadata) => {
      last = frame.mediaTime;
      video.requestVideoFrameCallback(next);
    };
    video.requestVideoFrameCallback(next);
    setTimeout(() => resolve(last), 600);
  }));

test('the film plays from Mux, muted here, at its own length', async ({ page }) => {
  await open(page, MUX);
  expect(await film(page).evaluate((el: HTMLVideoElement) => new URL(el.currentSrc).hostname)).toBe('stream.mux.com');
  expect(await film(page).evaluate((el: HTMLVideoElement) => el.duration)).toBeCloseTo(DURATION, 0);
  await pointerOnPlayer(page);
  await page.keyboard.press('k');
  await expect.poll(() => film(page).evaluate((el: HTMLVideoElement) => el.currentTime), { timeout: 30_000 }).toBeGreaterThan(1.5);
  expect(await film(page).evaluate((el: HTMLVideoElement) => el.muted)).toBe(true);
  // The pages are the page's own: the fore-edge is painted with them, not left gilt.
  await expect(page.locator('fb-edge')).toHaveAttribute('data-painted', '', { timeout: 15_000 });
});

test('a hand on the edge flips the copy at once, and the film lands on the very frame', async ({ page }) => {
  await open(page, MUX);
  await startAndHold(page, 5);
  const box = await edge(page);
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
  await expect.poll(() => page.locator('video.fb-stand').evaluate((el: HTMLVideoElement) => el.readyState).catch(() => 0), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  await dragAndRest(page, 0.2, 0.5);
  await expect(page.locator('video.fb-stand')).toHaveAttribute('data-on', '');
  await expect(page.locator('video.fb-stand')).toHaveCSS('opacity', '1');
  const copyAt = await page.locator('video.fb-stand').evaluate((el: HTMLVideoElement) => el.currentTime);
  expect(copyAt, 'the copy is where the hand is').toBeCloseTo(DURATION * 0.5, 0);
  await page.waitForTimeout(250);
  await page.mouse.up();
  await expect(page.locator('video.fb-stand')).not.toHaveAttribute('data-on', /.*/, { timeout: 30_000 });
  const clock = await film(page).evaluate((el: HTMLVideoElement) => el.currentTime);
  const shown = await frameShown(page);
  expect(clock).toBeCloseTo(DURATION * 0.5, 0);
  if (shown != null) {
    expect(clock - shown, 'the film’s clock is inside the frame it shows').toBeGreaterThanOrEqual(-0.001);
    expect(clock - shown).toBeLessThan(FRAME + 0.001);
  }
});

test('the paused page’s strip is twelve drawn frames, never blank', async ({ page }) => {
  await open(page, MUX);
  await startAndHold(page, 30.5);
  await expect(page.locator('.fb-strip-cell[data-ready]')).toHaveCount(12, { timeout: 30_000 });
  const blank = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLCanvasElement>('.fb-strip-cell canvas')].filter((canvas) => {
      const data = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data ?? new Uint8ClampedArray();
      return ![...data].some((value, i) => i % 4 === 3 && value > 0);
    }).length,
  );
  expect(blank).toBe(0);
});

test('with only the stream (no copy, none of the page’s tracks) the pages are Mux’s own, and they stand in under the hand', async ({ page }) => {
  await open(page, `${MUX}&scrub=none&tracks=none`);
  // Mux's storyboard, whatever its number of tiles: the fore-edge has that many pages, and is painted with them.
  const count = await page.locator('fb-edge').evaluate((el: HTMLElement) => Number(el.style.getPropertyValue('--fb-pages')));
  expect(count, 'pages from Mux’s storyboard').toBeGreaterThan(10);
  await startAndHold(page, 5);
  await expect(page.locator('fb-edge')).toHaveAttribute('data-painted', '', { timeout: 20_000 });
  const folio = (await page.locator('fb-folio').textContent()) ?? '';
  expect(folio, 'the folio counts Mux’s pages').toMatch(new RegExp(`/\\s*${count}$`));
  await dragAndRest(page, 0.2, 0.5);
  await expect(page.locator('canvas.fb-stand')).toHaveAttribute('data-on', '');
  await expect(page.locator('.fb-edge-chip')).toHaveText(/^p\.\s?\d+$/);
  await page.waitForTimeout(250);
  await page.mouse.up();
  await expect(stand(page).and(page.locator('[data-on]'))).toHaveCount(0, { timeout: 30_000 });
  expect(await film(page).evaluate((el: HTMLVideoElement) => el.currentTime)).toBeCloseTo(DURATION * 0.5, 0);
});

test('Quality: Settings lists the stream’s heights; 2160p is chosen and plays on the same frame, and Auto comes back', async ({ page }, testInfo) => {
  await open(page, MUX);
  await page.evaluate(() => (document.querySelector('media-container') as HTMLElement).focus({ preventScroll: true }));
  const row = page.locator('.fb-menu-quality');
  const items = page.locator('.fb-menu-quality-group media-menu-radio-item');
  await expect(row).toHaveAttribute('data-fb-quality', '', { timeout: 20_000 });
  await startAndHold(page, 20);
  const size = () => film(page).evaluate((el: HTMLVideoElement) => `${el.videoWidth}x${el.videoHeight}`);
  const choose = async (value: string, shows: (height: number) => boolean) => {
    await page.locator('.fb-settings').click();
    await row.click();
    await expect(items.first()).toBeVisible();
    const started = Date.now();
    await page.locator(`.fb-menu-quality-group media-menu-radio-item[value="${value}"]`).click();
    await expect.poll(async () => shows(await film(page).evaluate((el: HTMLVideoElement) => el.videoHeight)), { message: `the height playing after ${value} was chosen`, timeout: 60_000 }).toBe(true);
    await expect(page.locator('canvas.fb-hold')).toHaveCount(0, { timeout: 30_000 });
    const took = Date.now() - started;
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    return took;
  };
  const heights = await (async () => {
    await page.locator('.fb-settings').click();
    await row.click();
    const names = await items.evaluateAll((all) => all.map((item) => item.getAttribute('aria-label')));
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    return names;
  })();
  const auto = await size();
  const up = await choose('2160', (height) => height === 2160);
  const at4k = await size();
  expect(await film(page).evaluate((el: HTMLVideoElement) => el.currentSrc)).toMatch(/min_resolution=2160p&max_resolution=2160p$/);
  expect(await film(page).evaluate((el: HTMLVideoElement) => el.currentTime)).toBeCloseTo(20, 1);
  const down = await choose('auto', (height) => height > 0 && height < 2160);
  // On Auto the stream is asked no taller than this screen can show (the lowest of Mux's heights that covers the
  // largest 16:9 picture the screen has room for), and stays there: left to the connection alone, Chromium went back
  // up to 2160p in this 720 px player.
  const autoSrc = await film(page).evaluate((el: HTMLVideoElement) => el.currentSrc);
  const cap = Number(/[?&]max_resolution=(\d+)p/.exec(autoSrc)?.[1] ?? 0);
  expect(autoSrc, 'Auto has no chosen height').not.toMatch(/min_resolution/);
  const fits = await page.evaluate(() => {
    const picture = Math.min(Math.min(screen.width, screen.height), Math.max(screen.width, screen.height) * (9 / 16)) * devicePixelRatio;
    return [360, 540, 720, 1080, 1440].find((height) => height >= Math.round(picture)) ?? 0;
  });
  expect(fits, 'this screen is smaller than 4K, so Auto has a ceiling').toBeGreaterThan(0);
  expect(cap, `Auto’s ceiling for this screen, from ${autoSrc.split('/').pop()}`).toBe(fits);
  await page.keyboard.press('k');
  await page.waitForTimeout(5000);
  await page.keyboard.press('k');
  const settled = await size();
  expect(Number(settled.split('x')[1]), 'the height playing on Auto after five seconds').toBeLessThanOrEqual(cap);
  const report = { engine: testInfo.project.name, heights, auto, '2160p': at4k, 'to 2160p (ms)': up, 'back on Auto': settled, 'to Auto (ms)': down, 'Auto asked at most': `${cap}p` };
  console.log(`QUALITY ${JSON.stringify(report)}`);
  testInfo.annotations.push({ type: 'quality', description: JSON.stringify(report) });
  expect(at4k).toBe('3840x2160');
});
