import { type Page } from '@playwright/test';
import { container, NO_PLATE, pausedAt, said, storedMarks } from './support/book-features';
import { media, open, tabTo } from './support/player';
import { expect, test } from './support/test';

/**
 * The dog-ear (src/skins/flipbook/ear.ts): the bookmark seen on the page. One list of bookmarks, shared with the
 * ribbons and the B key; the ear shows on a marked page only; undo stands where it was; the keyboard reaches it.
 */

const ear = (page: Page) => page.locator('fb-ear');
const corner = (page: Page) => page.locator('.fb-ear-button');
const ribbons = (page: Page) => page.locator('.fb-ribbon');
/** The fold as drawn: its side in px (36 folded, about 14 as the hint on a plain page). */
const fold = (page: Page) => page.locator('.fb-ear-fold').evaluate((el) => Math.round(el.getBoundingClientRect().width));

test.describe('dog-ear', () => {
  test('B and the corner toggle the same bookmark', async ({ page }) => {
    await open(page, NO_PLATE);
    await pausedAt(page, 20);
    await expect(ribbons(page)).toHaveCount(0);
    await expect(ear(page)).not.toHaveAttribute('data-marked', /.*/);
    await expect(corner(page)).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => fold(page)).toBeLessThan(18);

    // B folds the corner and hangs the ribbon: one entry.
    await page.keyboard.press('b');
    await expect(ribbons(page)).toHaveCount(1);
    await expect(ear(page)).toHaveAttribute('data-marked', '');
    await expect(corner(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(corner(page)).toHaveAccessibleName('Remove bookmark');
    await expect.poll(() => fold(page)).toBe(36);
    expect(await storedMarks(page)).toEqual([20]);
    await expect(said(page)).toHaveText('Bookmark added at 0:20');

    // The corner takes the same one out.
    await corner(page).click();
    await expect(ribbons(page)).toHaveCount(0);
    await expect(ear(page)).not.toHaveAttribute('data-marked', /.*/);
    await expect(corner(page)).toHaveAccessibleName('Bookmark this moment');
    expect(await storedMarks(page)).toEqual([]);
    await expect(said(page)).toHaveText('Bookmark at 0:20 removed');

    // And the other way round: the corner adds, B removes.
    await corner(page).click();
    await expect(ribbons(page)).toHaveCount(1);
    expect(await storedMarks(page)).toEqual([20]);
    await page.mouse.move(640, 300);
    await page.keyboard.press('b');
    await expect(ribbons(page)).toHaveCount(0);
    await expect(ear(page)).not.toHaveAttribute('data-marked', /.*/);
    expect(await storedMarks(page)).toEqual([]);
    // Still paused throughout: the corner is not the picture.
    expect((await media(page)).paused).toBe(true);
  });

  test('the ear shows on a marked page only, and through a playing film', async ({ page }) => {
    await open(page, NO_PLATE);
    await pausedAt(page, 24);
    await corner(page).click();
    await expect(ear(page)).toHaveAttribute('data-marked', '');
    // Off the corner: under the pointer the fold lifts a little, and this measures it at rest.
    await page.mouse.move(640, 300);
    const shown = () =>
      page.evaluate(() => {
        const button = document.querySelector('.fb-ear-button') as HTMLElement;
        const video = document.querySelector('video') as HTMLVideoElement;
        return {
          time: video.currentTime,
          marked: document.querySelector('fb-ear')?.hasAttribute('data-marked') ?? false,
          opacity: Number(getComputedStyle(button).opacity),
          controls: document.querySelector('media-container')?.hasAttribute('data-controls-visible') ?? false,
        };
      });

    // Another page, paused: the corner is the plain hint again.
    await page.evaluate(() => ((document.querySelector('video') as HTMLVideoElement).currentTime = 40));
    await expect(ear(page)).not.toHaveAttribute('data-marked', /.*/);
    await expect.poll(() => fold(page)).toBeLessThan(18);

    // Played through with the controls away: no corner before the page, the ear on it, none after.
    await page.evaluate(() => ((document.querySelector('video') as HTMLVideoElement).currentTime = 17.5));
    await page.mouse.move(640, 790);
    await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).play());
    await expect(container(page)).not.toHaveAttribute('data-controls-visible', /.*/, { timeout: 8000 });
    // The corner goes with the controls (their 150 ms): wait that out, then read it.
    await expect.poll(async () => (await shown()).opacity).toBe(0);
    const before = await shown();
    expect(before.time, 'the controls hid before the marked page').toBeLessThan(22.4);
    expect(before).toMatchObject({ marked: false, opacity: 0, controls: false });
    await expect.poll(async () => (await shown()).marked, { timeout: 8000 }).toBe(true);
    await expect.poll(async () => (await shown()).opacity).toBe(1);
    expect((await shown()).controls).toBe(false);
    await page.waitForFunction(() => (document.querySelector('video') as HTMLVideoElement).currentTime > 26);
    await expect.poll(async () => (await shown()).opacity).toBe(0);
    expect((await shown()).marked).toBe(false);
  });

  test('unfolding leaves Undo where the ear was, and Undo puts the same bookmark back', async ({ page }) => {
    await open(page, NO_PLATE);
    await pausedAt(page, 20);
    const undo = page.locator('.fb-ear-undo');
    await expect(undo).toBeHidden();
    await corner(page).click();
    expect(await storedMarks(page)).toEqual([20]);
    await expect(undo).toBeHidden();

    await corner(page).click();
    expect(await storedMarks(page)).toEqual([]);
    await expect(undo).toBeVisible();
    await expect(undo).toHaveAccessibleName('Undo: put the bookmark at 0:20 back');
    await expect(undo).toContainText('Undo');
    // Where the thing was: beside the corner, inside the player, a full target.
    const [at, key, box] = await Promise.all([undo.boundingBox(), corner(page).boundingBox(), container(page).boundingBox()]);
    if (!at || !key || !box) throw new Error('nothing to measure');
    expect(at.x - (key.x + key.width)).toBeLessThanOrEqual(8);
    expect(at.y - box.y).toBeLessThan(16);
    expect(at.height).toBeGreaterThanOrEqual(44);

    await undo.click();
    expect(await storedMarks(page)).toEqual([20]);
    await expect(undo).toBeHidden();
    await expect(ear(page)).toHaveAttribute('data-marked', '');
    await expect(ribbons(page)).toHaveCount(1);
    await expect(said(page)).toHaveText('Bookmark added at 0:20');

    // B removes it from the page it's on: the same offer, by the same route.
    await page.mouse.move(640, 300);
    await page.keyboard.press('b');
    await expect(undo).toBeVisible();
    // A new bookmark is an answer: the offer goes.
    await page.keyboard.press('b');
    await expect(undo).toBeHidden();
  });

  test('Tab reaches the corner, with a ring drawn; Enter folds it', async ({ page, browserName }) => {
    await open(page, NO_PLATE);
    await pausedAt(page, 20);
    await container(page).focus();
    await tabTo(page, browserName, '.fb-ear-button');
    const size = await corner(page).boundingBox();
    expect(size?.width).toBeGreaterThanOrEqual(44);
    expect(size?.height).toBeGreaterThanOrEqual(44);
    const ring = await corner(page).evaluate((el) => {
      const style = getComputedStyle(el, '::after');
      return { opacity: style.opacity, width: style.borderTopWidth, colour: style.borderTopColor, cursor: getComputedStyle(el).cursor };
    });
    expect(ring).toEqual({ opacity: '1', width: '2px', colour: 'rgb(226, 73, 43)', cursor: 'pointer' });
    // And in pixels: the accent's ring is on screen around the corner.
    const shot = (await corner(page).screenshot()).toString('base64');
    const ringPixels = await page.evaluate(async (data) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
      ctx.drawImage(bitmap, 0, 0);
      const { data: px } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      let count = 0;
      for (let i = 0; i < px.length; i += 4) if (Math.abs(px[i] - 226) < 24 && Math.abs(px[i + 1] - 73) < 24 && Math.abs(px[i + 2] - 43) < 24) count += 1;
      return count;
    }, shot);
    expect(ringPixels, 'accent pixels in the ring').toBeGreaterThan(150);

    await page.keyboard.press('Enter');
    await expect(ear(page)).toHaveAttribute('data-marked', '');
    expect(await storedMarks(page)).toEqual([20]);
    // Space on the corner is the corner's too: it unfolds, and the film stays paused.
    await page.keyboard.press('Space');
    await expect(ear(page)).not.toHaveAttribute('data-marked', /.*/);
    expect((await media(page)).paused).toBe(true);
    // The offer is the next stop, and Escape puts it away and gives focus back to the corner.
    await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
    await expect(page.locator('.fb-ear-undo')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('.fb-ear-undo')).toBeHidden();
    await expect(corner(page)).toBeFocused();
  });

  test('pulled down it folds, let go short it springs back', async ({ page }) => {
    await open(page, NO_PLATE);
    await pausedAt(page, 20);
    const box = await container(page).boundingBox();
    if (!box) throw new Error('no player');
    const tip = { x: box.x + 10, y: box.y + 10 };
    // A short pull: the fold follows, then goes back, and nothing is marked.
    await page.mouse.move(tip.x, tip.y);
    await page.mouse.down();
    await page.mouse.move(tip.x + 5, tip.y + 5, { steps: 4 });
    expect(await fold(page)).toBeGreaterThan(18);
    await page.mouse.up();
    await expect(ear(page)).not.toHaveAttribute('data-marked', /.*/);
    expect(await storedMarks(page)).toEqual([]);
    // A full pull: marked on release, once (the click that follows a drag doesn't toggle it back).
    await page.mouse.down();
    await page.mouse.move(tip.x + 20, tip.y + 20, { steps: 6 });
    await page.mouse.up();
    await expect(ear(page)).toHaveAttribute('data-marked', '');
    await page.waitForTimeout(150);
    expect(await storedMarks(page)).toEqual([20]);
  });
});
