import fs from 'node:fs';
import { type Download, type Page } from '@playwright/test';
import { container, NO_PLATE, pausedAt, said } from './support/book-features';
import { BARE, media, open, pointerOnPlayer, startAndHold, tabTo } from './support/player';
import { expect, test } from './support/test';

/**
 * Tear out the page (src/skins/flipbook/tear.ts): the paused page pulled out as a PNG, the same from a key, the link
 * that opens the film on a page, and a film whose frames the browser won't export.
 */

const sheet = (page: Page) => page.locator('.fb-tear-sheet');
const slip = (page: Page) => page.locator('.fb-tear-slip');

/** The sheet's size for a picture, restated from the rule (5 % margins, a 10 % foot; 640 to 1920 px wide). */
function expectedSheet(width: number, height: number) {
  const w = Math.round(Math.max(640, Math.min(1920, width)));
  const h = Math.round((w * height) / width);
  const margin = Math.round(w * 0.05);
  return { width: w + margin * 2, height: h + margin + Math.round(w * 0.1), x: margin, y: margin, w, h };
}

/** A PNG's size, from its header. */
function pngSize(bytes: Buffer) {
  expect(bytes.subarray(0, 8).toString('latin1'), 'a PNG').toBe('\u0089PNG\r\n\u001a\n');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function read(download: Download): Promise<Buffer> {
  const path = await download.path();
  return fs.readFileSync(path);
}

/** The pull's centre, clear of the keys, and how far the page must travel to tear on this player. */
async function grip(page: Page) {
  const box = await container(page).boundingBox();
  if (!box) throw new Error('no player');
  return { x: box.x + box.width * 0.5, y: box.y + box.height * 0.5, tear: Math.max(72, Math.min(160, box.width * 0.16)), box };
}

/** How far the mean colour of the sheet's picture is from the film's frame, at nine points across it. */
async function compare(page: Page, bytes: Buffer, at: { x: number; y: number; w: number; h: number }) {
  return page.evaluate(
    async ({ data, at }) => {
      const video = document.querySelector('video') as HTMLVideoElement;
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
      const kept = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
      kept.drawImage(bitmap, 0, 0);
      const frame = new OffscreenCanvas(video.videoWidth, video.videoHeight).getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
      frame.drawImage(video, 0, 0);
      const mean = (ctx: OffscreenCanvasRenderingContext2D, x: number, y: number) => {
        const { data } = ctx.getImageData(Math.round(x) - 4, Math.round(y) - 4, 8, 8);
        const sum = [0, 0, 0];
        for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) sum[c] += data[i + c];
        return sum.map((v) => v / 64);
      };
      let worst = 0;
      let spread = 0;
      const seen: number[] = [];
      for (const fy of [0.25, 0.5, 0.75]) {
        for (const fx of [0.25, 0.5, 0.75]) {
          const a = mean(kept, at.x + at.w * fx, at.y + at.h * fy);
          const b = mean(frame, video.videoWidth * fx, video.videoHeight * fy);
          worst = Math.max(worst, ...a.map((v, c) => Math.abs(v - b[c])));
          seen.push(b[0] + b[1] + b[2]);
        }
      }
      spread = Math.max(...seen) - Math.min(...seen);
      // The paper margin, at the sheet's top-left corner.
      const paper = mean(kept, 6, 6);
      return { worst, spread, paper };
    },
    { data: bytes.toString('base64'), at },
  );
}

test.describe('tear out the page', () => {
  test('a pull past the threshold tears the page out: a PNG of the frame, set as a page', async ({ page }) => {
    await open(page, NO_PLATE);
    await pausedAt(page, 36.4);
    const from = await grip(page);
    const folio = (await page.locator('fb-folio').textContent()) ?? '';
    const number = Number(/p\. (\d+)/.exec(folio)?.[1]);
    expect(number).toBeGreaterThan(1);

    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    // Short of the tear the page holds on: it follows at a third of the pull.
    await page.mouse.move(from.x + from.tear * 0.6, from.y, { steps: 8 });
    await expect(sheet(page)).toHaveCount(1);
    await expect(page.locator('fb-tear')).not.toHaveAttribute('data-torn', /.*/);
    await expect.poll(async () => (await sheet(page).boundingBox())?.x ?? 0).toBeGreaterThan(from.box.x + from.tear * 0.6 * 0.3 - 8);
    expect((await sheet(page).boundingBox())?.x ?? 0).toBeLessThan(from.box.x + from.tear * 0.6 * 0.3 + 12);
    // Past it, it's free, and follows the hand.
    await page.mouse.move(from.x + from.tear * 1.6, from.y + 30, { steps: 10 });
    await expect(page.locator('fb-tear')).toHaveAttribute('data-torn', '');
    const [download] = await Promise.all([page.waitForEvent('download'), page.mouse.up()]);

    const bytes = await read(download);
    const video = await page.evaluate(() => {
      const v = document.querySelector('video') as HTMLVideoElement;
      return { width: v.videoWidth, height: v.videoHeight };
    });
    const want = expectedSheet(video.width, video.height);
    expect(pngSize(bytes)).toEqual({ width: want.width, height: want.height });
    const match = await compare(page, bytes, { x: want.x, y: want.y, w: want.w, h: want.h });
    // The nine points really differ from one another in this frame, so matching them means something.
    expect(match.spread, 'the frame has detail to compare').toBeGreaterThan(30);
    expect(match.worst, 'the sheet carries the frame on screen').toBeLessThan(10);
    for (const [channel, value] of [246, 241, 231].entries()) expect(Math.abs(match.paper[channel] - value)).toBeLessThan(3);
    expect(download.suggestedFilename()).toBe(`locomotion-p${number}.png`);

    await expect(slip(page)).toBeVisible();
    await expect(slip(page).locator('.fb-tear-said')).toHaveText(`Page ${number} saved`);
    await expect(said(page)).toHaveText(`Page ${number} saved`);
    await expect(sheet(page)).toHaveCount(0);
    await expect(container(page)).not.toHaveAttribute('data-fb-tearing', /.*/);
    // The pull was not a click: the film is still paused.
    expect((await media(page)).paused).toBe(true);
  });

  test('a short pull keeps nothing and the page comes back; caught on the way, it follows again; a click still plays', async ({ page }) => {
    await open(page, NO_PLATE);
    await pausedAt(page, 36.4);
    const from = await grip(page);
    let downloads = 0;
    page.on('download', () => downloads++);

    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + from.tear * 0.7, from.y + 8, { steps: 8 });
    await expect(sheet(page)).toHaveCount(1);
    await page.mouse.up();
    // On its way back it can be caught: the same sheet, held again from where it is.
    await page.mouse.down();
    await page.mouse.move(from.x + from.tear * 0.7 + 14, from.y + 8, { steps: 3 });
    await page.waitForTimeout(450);
    await expect(sheet(page)).toHaveCount(1);
    expect((await sheet(page).boundingBox())?.x ?? 0).toBeGreaterThan(from.box.x + 2);
    await page.mouse.up();
    // Let go: back flat, and gone.
    await expect(sheet(page)).toHaveCount(0);
    await expect(container(page)).not.toHaveAttribute('data-fb-tearing', /.*/);
    await expect(slip(page)).toBeHidden();
    expect((await media(page)).paused).toBe(true);
    await page.waitForTimeout(400);
    expect(downloads).toBe(0);

    // An ordinary click is still the player's: it plays.
    await page.mouse.click(from.x, from.y);
    await expect.poll(async () => (await media(page)).paused).toBe(false);
    // And while it plays, a drag on the picture lifts nothing.
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + from.tear * 1.5, from.y, { steps: 6 });
    await expect(sheet(page)).toHaveCount(0);
    await page.mouse.up();
    expect(downloads).toBe(0);
  });

  test('"Keep this page" does the same from the keyboard, and from Settings', async ({ page, browserName }) => {
    await open(page, NO_PLATE);
    await pausedAt(page, 36.4);
    const key = page.locator('.fb-keep');
    await expect(key).toBeVisible();
    await expect(key).toHaveAccessibleName('Keep this page');
    await expect(key.locator('kbd')).toHaveText('S');
    const size = await key.boundingBox();
    expect(size?.height).toBeGreaterThanOrEqual(44);
    expect(await key.evaluate((el) => getComputedStyle(el).cursor)).toBe('pointer');

    await container(page).focus();
    await tabTo(page, browserName, '.fb-keep');
    expect(await key.evaluate((el) => getComputedStyle(el).outlineStyle + ' ' + getComputedStyle(el).outlineWidth)).toBe('solid 2px');
    const [first] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
    expect(pngSize(await read(first)).width).toBe(1408);
    await expect(slip(page)).toBeVisible();
    await expect(said(page)).toHaveText(/^Page \d+ saved$/);
    // The key is under the slip now: focus is on what the slip offers, and Escape gives it back.
    await expect(page.locator('.fb-tear-copy')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(slip(page)).toBeHidden();
    await expect(key).toBeFocused();
    expect((await media(page)).paused).toBe(true);

    // S, anywhere in the player.
    const [second] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('s')]);
    expect(pngSize(await read(second)).height).toBe(912);
    await page.locator('.fb-tear-close').click();

    // Settings carries it at every width.
    await page.locator('.fb-settings').click();
    const item = page.locator('[data-fb-menu="keep"]');
    await expect(item).toBeVisible();
    await expect(item).toContainText('Keep this page');
    const [third] = await Promise.all([page.waitForEvent('download'), item.click()]);
    expect(third.suggestedFilename()).toMatch(/^locomotion-p\d+\.png$/);
  });

  test('the link opens the film on that page, and the slip copies it', async ({ page, browserName, context }) => {
    await open(page, `${NO_PLATE}#p=31`);
    await expect(page.locator('fb-folio')).toHaveText(/^p\. 31 \//);
    await expect(said(page)).toHaveText('Opened at page 31');
    expect((await media(page)).paused).toBe(true);
    // At rest the link shows its page, not the cover: the jacket and the poster are gone and the page is printed.
    await expect(container(page)).not.toHaveAttribute('data-fb-jacket', /.*/);
    await expect(container(page)).toHaveAttribute('data-fb-print', '');
    await expect(page.locator('.media-poster')).not.toHaveAttribute('data-visible', /.*/);

    // A moment wins over a page, and a changed hash is followed.
    await page.evaluate(() => (location.hash = 'p=2&t=13.2'));
    await expect.poll(async () => (await media(page)).time).toBeCloseTo(13.2, 1);

    // The slip's link is that address for the page kept, and it lands on the same page.
    await pointerOnPlayer(page);
    await startAndHold(page, 36.4);
    const folio = (await page.locator('fb-folio').textContent()) ?? '';
    const number = /p\. (\d+)/.exec(folio)?.[1];
    if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await Promise.all([page.waitForEvent('download'), page.keyboard.press('s')]);
    const link = await page.locator('.fb-tear-link').inputValue();
    expect(new URL(link).hash).toBe(`#p=${number}&t=36.4`);
    expect(new URL(link).pathname).toBe('/flipbook.html');
    if (browserName === 'chromium') {
      await page.locator('.fb-tear-copy').click();
      await expect(page.locator('.fb-tear-copy')).toHaveText(`Link to page ${number} copied`);
      await expect(said(page)).toHaveText(`Link to page ${number} copied`);
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
    }
    const other = await context.newPage();
    await open(other, `${new URL(link).pathname}${new URL(link).search}${new URL(link).hash}`);
    await expect(other.locator('fb-folio')).toHaveText(new RegExp(`^p\\. ${number} /`));
    await other.close();
  });

  test('a film the browser won’t export falls back to the page’s still, then to the link alone, and nothing throws', async ({ page, context, browserName }) => {
    // The premise needs the same film from a second origin (localhost beside 127.0.0.1); Playwright's WebKit never
    // loads that copy (60 s, no `loadeddata`), so the fallbacks are measured in Chromium only.
    test.skip(browserName === 'webkit', 'the cross-origin copy of the film does not load in Playwright WebKit');
    const thrown: string[] = [];
    page.on('pageerror', (error) => thrown.push(error.message));
    /** The same film from another origin, without CORS: drawn to a canvas, it taints it. */
    const taint = (target: Page) =>
      target.evaluate(async () => {
        const video = document.querySelector('video') as HTMLVideoElement;
        video.removeAttribute('crossorigin');
        video.src = video.currentSrc.replace('127.0.0.1', 'localhost');
        await new Promise((resolve) => video.addEventListener('loadeddata', resolve, { once: true }));
      });
    const tainted = (target: Page) =>
      target.evaluate(() => {
        const video = document.querySelector('video') as HTMLVideoElement;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 8;
        canvas.getContext('2d')?.drawImage(video, 0, 0, 8, 8);
        try {
          canvas.toDataURL();
          return false;
        } catch {
          return true;
        }
      });

    await open(page, NO_PLATE);
    await taint(page);
    await pausedAt(page, 36.4);
    expect(await tainted(page), 'the film taints a canvas').toBe(true);
    const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('s')]);
    // The page's sharp still, set the same way.
    const size = pngSize(await read(download));
    expect(size.width).toBeGreaterThanOrEqual(704);
    await expect(slip(page).locator('.fb-tear-said')).toHaveText(/^Page \d+ saved$/);
    expect(thrown).toEqual([]);

    // With no still and no storyboard to draw from either: the link alone, said plainly.
    const bare = await context.newPage();
    bare.on('pageerror', (error) => thrown.push(error.message));
    let downloads = 0;
    bare.on('download', () => downloads++);
    await bare.route(/\/frames\/.*\.(webp|avif|jpe?g|png)$|storyboard\.(jpg|webp)$/, (route) => route.abort());
    await open(bare, NO_PLATE);
    await taint(bare);
    await pausedAt(bare, 36.4);
    await bare.keyboard.press('s');
    await expect(slip(bare)).toBeVisible();
    await expect(slip(bare)).toHaveAttribute('data-link-only', '');
    await expect(slip(bare).locator('.fb-tear-said')).toHaveText('This page can’t be saved as a picture here. Copy its link instead.');
    await expect(said(bare)).toHaveText('This page can’t be saved as a picture here. Copy its link instead.');
    await expect(bare.locator('.fb-tear-thumb')).toBeHidden();
    expect(new URL(await bare.locator('.fb-tear-link').inputValue()).hash).toMatch(/^#p=\d+&t=36\.4$/);
    // The pull still lifts the page (drawing is allowed, exporting is not) and ends the same way.
    await bare.locator('.fb-tear-close').click();
    const from = await grip(bare);
    await bare.mouse.move(from.x, from.y);
    await bare.mouse.down();
    await bare.mouse.move(from.x + from.tear * 1.5, from.y, { steps: 8 });
    await expect(sheet(bare)).toHaveCount(1);
    await bare.mouse.up();
    await expect(slip(bare)).toHaveAttribute('data-link-only', '');
    await bare.waitForTimeout(300);
    expect(downloads).toBe(0);
    expect(thrown).toEqual([]);
    await bare.close();
  });

  test('reduced motion: nothing lifts, a pull past the threshold simply keeps the page', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, NO_PLATE);
    await pausedAt(page, 36.4);
    const from = await grip(page);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + from.tear * 1.5, from.y, { steps: 8 });
    await expect(sheet(page)).toHaveCount(0);
    const [download] = await Promise.all([page.waitForEvent('download'), page.mouse.up()]);
    expect(pngSize(await read(download)).width).toBe(1408);
    await expect(said(page)).toHaveText(/^Page \d+ saved$/);
  });
});

test.describe('tear out the page, by touch', () => {
  test.use({ hasTouch: true });

  test('a tap and a swipe are not a pull; a still hold, then a pull, tears', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'touch points are sent through the Chromium DevTools protocol');
    await open(page, NO_PLATE);
    await pausedAt(page, 36.4);
    const from = await grip(page);
    const client = await page.context().newCDPSession(page);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x?: number, y?: number) =>
      client.send('Input.dispatchTouchEvent', { type, touchPoints: x == null || y == null ? [] : [{ x, y }] });
    let downloads = 0;
    page.on('download', () => downloads++);

    // Whether the page was ever taken hold of, however briefly: the attribute is watched, not sampled.
    await page.evaluate(() => {
      const root = document.querySelector('media-container') as HTMLElement;
      const seen = window as unknown as { __held: number };
      seen.__held = 0;
      new MutationObserver(() => {
        if (root.hasAttribute('data-fb-tearing')) seen.__held += 1;
      }).observe(root, { attributes: true, attributeFilter: ['data-fb-tearing'] });
    });
    const held = () => page.evaluate(() => (window as unknown as { __held: number }).__held);

    // A tap: the film's own (it plays, hand.ts), nothing lifts. Paused again where it was for what follows.
    await touch('touchStart', from.x, from.y);
    await touch('touchEnd');
    await expect.poll(() => page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).paused)).toBe(false);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const video = document.querySelector('video') as HTMLVideoElement;
          video.pause();
          video.addEventListener('seeked', () => resolve(), { once: true });
          video.currentTime = 36.4;
        }),
    );
    await expect(container(page)).toHaveAttribute('data-fb-print', '');
    // A swipe that starts at once: the film follows the finger (flip.ts), nothing lifts.
    await touch('touchStart', from.x, from.y + 20);
    for (let i = 1; i <= 6; i++) await touch('touchMove', from.x + i * 30, from.y + 20);
    await page.waitForTimeout(120);
    await touch('touchEnd');
    await page.waitForTimeout(500);
    expect(await held(), 'a tap or a swipe took hold of the page').toBe(0);
    await expect(sheet(page)).toHaveCount(0);
    expect(downloads).toBe(0);
    await expect(container(page)).toHaveAttribute('data-fb-print', '');

    // Held still for the hold's length, the page is taken; pulled past the threshold and let go, it's kept.
    await touch('touchStart', from.x, from.y);
    await expect(container(page)).toHaveAttribute('data-fb-tearing', '', { timeout: 2000 });
    await expect(sheet(page)).toHaveCount(1);
    expect(await held()).toBe(1);
    for (let i = 1; i <= 10; i++) await touch('touchMove', from.x + (from.tear * 1.6 * i) / 10, from.y + i * 2);
    await expect(page.locator('fb-tear')).toHaveAttribute('data-torn', '');
    const [download] = await Promise.all([page.waitForEvent('download'), touch('touchEnd')]);
    expect(pngSize(await read(download)).width).toBe(1408);
  });
});

test('essential fetches none of the three, whatever is pressed or pulled', async ({ page, context }) => {
  /** The three extras' modules: their chunks in the build, their sources on a dev server. */
  const MINE = /(?:^|\/)(?:ear|tear|intertitle)(?:[-.][\w-]+)?\.(?:js|ts|css)(?:$|\?)/;
  const asked: string[] = [];
  page.on('request', (request) => asked.push(new URL(request.url()).pathname));
  await page.goto(`${BARE}&features=essential#p=5`);
  await expect(page.locator('fb-edge[data-ready]')).toHaveCount(1);
  await page.waitForFunction(() => (document.querySelector('video') as HTMLVideoElement | null)?.readyState! >= 1);
  await page.evaluate(() => localStorage.setItem('fb-caption-style', JSON.stringify({ mode: 'intertitle' })));
  await pointerOnPlayer(page);
  await page.keyboard.press('k');
  await page.waitForFunction(() => (document.querySelector('video') as HTMLVideoElement).currentTime > 0.8);
  await page.keyboard.press('k');
  for (const key of ['s', 'b', 'c']) await page.keyboard.press(key);
  const from = await grip(page);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 260, from.y + 20, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(2500);
  expect(asked.filter((path) => MINE.test(path))).toEqual([]);
  await expect(page.locator('fb-ear, fb-tear, fb-intertitle, [data-fb-menu="keep"], .fb-keep')).toHaveCount(0);
  // The link is the tear extra's to read: without it the film stays at its start.
  await expect(container(page)).toHaveAttribute('data-fb-loaded', '');

  // And the pattern reads something: the whole book asks for all three.
  const book = await context.newPage();
  const fetched: string[] = [];
  book.on('request', (request) => fetched.push(new URL(request.url()).pathname));
  await open(book, BARE);
  const names = new Set(fetched.filter((path) => MINE.test(path)).map((path) => /(ear|tear|intertitle)(?=[-.])/.exec(path.split('/').pop() ?? '')?.[1]));
  expect([...names].sort()).toEqual(['ear', 'intertitle', 'tear']);
  await book.close();
});
