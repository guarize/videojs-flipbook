import AxeBuilder from '@axe-core/playwright';
import { type Page } from '@playwright/test';
import { BARE, DURATION, ESSENTIAL, focusPlayer, open, pointerOnPlayer, revealControls, seekPainted, startAndHold } from './support/player';
import { expect, test } from './support/test';

/**
 * Where the book's features meet: the paused page with its stamp, its keys, the plate, the dog-ear, the kept page's
 * slip, a hint and a caption, on the sizes where they compete for the same picture. Boxes are read from the running
 * page; two things that are both drawn must not share a pixel.
 */

const container = (page: Page) => page.locator('media-container');

/** The boxes of what is drawn for a selector: laid out, visible, and not faded away. */
const drawn = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    const seen = (el: Element) =>
      el.getClientRects().length > 0 && (el as HTMLElement & { checkVisibility: (o: object) => boolean }).checkVisibility({ opacityProperty: true, visibilityProperty: true });
    const solid = (el: Element) => {
      let opacity = 1;
      for (let node: Element | null = el; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
      return opacity > 0.5;
    };
    return [...document.querySelectorAll(sel)]
      .filter((el) => seen(el) && solid(el))
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      })
      .filter((r) => r.w > 1 && r.h > 1);
  }, selector);

type Box = { x: number; y: number; w: number; h: number };
const overlap = (a: Box, b: Box) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5;

/** Every pair, one from each selector, that shares a pixel. */
async function collisions(page: Page, pairs: [string, string][]) {
  const hits: string[] = [];
  for (const [one, other] of pairs) {
    const a = await drawn(page, one);
    const b = await drawn(page, other);
    if (a.some((x) => b.some((y) => overlap(x, y)))) hits.push(`${one} × ${other}`);
  }
  return hits;
}

/** Paused by hand (a real K) at `time`, so what follows a pause made by hand follows. */
async function pauseByHand(page: Page, time: number) {
  await pointerOnPlayer(page);
  await page.keyboard.press('k');
  await page.waitForFunction(() => (document.querySelector('video') as HTMLVideoElement).currentTime > 1.2);
  await seekPainted(page, time);
  await page.keyboard.press('k');
  await page.waitForFunction(() => (document.querySelector('video') as HTMLVideoElement).paused);
}

test.describe('the paused page, where its parts meet', () => {
  test.skip(ESSENTIAL, 'the book’s extras');

  test('the open plate has the picture to itself: no caption line and no hint are drawn over it', async ({ page }) => {
    await open(page, BARE);
    await pointerOnPlayer(page);
    // Captions on by the viewer's key, and a hint asked for by going back (the bookmark hint).
    await page.evaluate(() => localStorage.removeItem('fb-hints'));
    await page.keyboard.press('c');
    // (0:37–0:41 has a caption up.)
    await pauseByHand(page, 39);
    await seekPainted(page, 38);
    await expect(page.locator('fb-captions[data-open]')).toHaveCount(1);
    await focusPlayer(page);
    await page.keyboard.press('p');
    await expect(page.locator('.fb-plate-sheet')).toBeVisible();
    expect(await collisions(page, [['.fb-plate-sheet', '.fb-captions-line'], ['.fb-plate-sheet', '.fb-hint']])).toEqual([]);
    // Put away, the caption is back.
    await page.keyboard.press('Escape');
    await expect(page.locator('.fb-plate-sheet')).toBeHidden();
    expect((await drawn(page, '.fb-captions-line')).length).toBeGreaterThan(0);
  });

  test('a page kept just after a pause keeps the picture: nothing lays itself over the slip', async ({ page }) => {
    await open(page, BARE);
    await pauseByHand(page, 20.9);
    await Promise.all([page.waitForEvent('download'), page.keyboard.press('s')]);
    await expect(page.locator('.fb-tear-slip')).toBeVisible();
    // Well past the moment the plate used to lay itself out (1.1 s after a pause): it never does now.
    await page.waitForTimeout(1600);
    await expect(container(page)).not.toHaveAttribute('data-fb-plate', /.*/);
    await expect(page.locator('.fb-tear-slip')).toBeVisible();
    // The slip is about that page: it leaves when the film plays on.
    await focusPlayer(page);
    await page.keyboard.press('k');
    await expect(page.locator('.fb-tear-slip')).toBeHidden();
  });

  for (const width of [480, 520, 560, 768, 1024]) {
    test(`${width} px: the stamp, the keys on the page, the corner’s Undo, the slip and the back cover keep off each other`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await open(page, BARE);
      await pointerOnPlayer(page);
      await startAndHold(page, 20.9);
      await revealControls(page);
      await expect(container(page)).toHaveAttribute('data-fb-print', '');
      const PAGE: [string, string][] = [
        ['.fb-stamp', '.fb-plate-toggle'],
        ['.fb-keep', '.fb-plate-toggle'],
        ['.fb-keep', '.video-controls-top > .media-button'],
        ['.fb-stamp', '.fb-keep'],
      ];
      expect(await collisions(page, PAGE), 'paused').toEqual([]);

      // The corner folded and unfolded: its Undo stands clear of the top row's keys.
      await page.locator('.fb-ear-button').click();
      await page.locator('.fb-ear-button').click();
      await expect(page.locator('.fb-ear-undo')).toBeVisible();
      expect(await collisions(page, [['.fb-ear-undo', '.video-controls-top > .media-button'], ['.fb-ear-undo', '.fb-keep']]), 'undo').toEqual([]);
      await page.keyboard.press('Escape');

      // The page kept: its slip clear of the plate key and the chapter tabs.
      await focusPlayer(page);
      await Promise.all([page.waitForEvent('download'), page.keyboard.press('s')]);
      await expect(page.locator('.fb-tear-slip')).toBeVisible();
      expect(await collisions(page, [['.fb-tear-slip', '.fb-plate-toggle'], ['.fb-tear-slip', '.fb-tab-face'], ['.fb-tear-slip', '.fb-bar']]), 'slip').toEqual([]);

      // The back cover: its words under the top row.
      await page.evaluate(async () => {
        const video = document.querySelector('video') as HTMLVideoElement;
        video.currentTime = video.duration - 0.3;
        await video.play();
      });
      await page.waitForFunction(() => (document.querySelector('video') as HTMLVideoElement).ended);
      await expect(page.locator('.fb-cover-title')).toBeVisible();
      await revealControls(page);
      expect(await collisions(page, [['.fb-cover-title', '.video-controls-top > .media-button'], ['.fb-cover-again', '.video-controls-top > .media-button']]), 'back cover').toEqual([]);
    });
  }
});

test.describe('a phone', () => {
  test.skip(ESSENTIAL, 'the book’s extras');
  test.use({ viewport: { width: 390, height: 780 }, hasTouch: true });

  test('a hint takes the page stamp’s place, and the stamp comes back after it', async ({ page }) => {
    await open(page, BARE);
    await page.evaluate(() => localStorage.removeItem('fb-hints'));
    await focusPlayer(page);
    await startAndHold(page, 30);
    // Going back a little asks for the bookmark hint.
    await seekPainted(page, 21);
    await expect(page.locator('fb-hints[data-open]')).toHaveCount(1);
    expect(await collisions(page, [['.fb-hint', '.fb-stamp']])).toEqual([]);
    await expect(page.locator('fb-hints[data-open]')).toHaveCount(0, { timeout: 12_000 });
    expect((await drawn(page, '.fb-stamp')).length).toBe(1);
  });

  test('the ribbon is a whole 24 px target on the film’s first and last page, inside the pad', async ({ page }) => {
    await open(page, BARE);
    await focusPlayer(page);
    await startAndHold(page, 30);
    for (const time of [0.2, DURATION - 0.27]) {
      await seekPainted(page, time);
      // (A phone's controls are the pad under the picture: phone.spec.ts.)
      const [player] = await drawn(page, '.fb-bar');
      const [ribbon] = await drawn(page, '.media-time-slider-thumb');
      expect(Math.min(ribbon.w, ribbon.h), `the ribbon’s box at ${time} s, px`).toBeGreaterThanOrEqual(24);
      expect(ribbon.x, `its left at ${time} s, inside the pad`).toBeGreaterThanOrEqual(player.x - 0.5);
      expect(ribbon.x + ribbon.w, `its right at ${time} s, inside the pad`).toBeLessThanOrEqual(player.x + player.w + 0.5);
      expect(ribbon.y, `its top at ${time} s, inside the pad`).toBeGreaterThanOrEqual(player.y - 0.5);
      expect(ribbon.y + ribbon.h, `its foot at ${time} s, inside the pad`).toBeLessThanOrEqual(player.y + player.h + 0.5);
      const result = await new AxeBuilder({ page }).include('media-container').withRules(['target-size']).analyze();
      expect(result.violations.flatMap((v) => v.nodes.map((n) => n.target.join(' '))), `axe target-size at ${time} s`).toEqual([]);
    }
  });

  test('the plate filling a phone’s picture leaves no sliver of the edge to press, and axe finds no small target', async ({ page }) => {
    await open(page, BARE);
    await focusPlayer(page);
    await startAndHold(page, 0.6);
    await page.keyboard.press('p');
    await expect(page.locator('.fb-plate-sheet')).toBeVisible();
    await expect(page.locator('fb-plate')).toHaveAttribute('data-full', '');
    expect(await collisions(page, [['.fb-plate-sheet', 'media-time-slider'], ['.fb-plate-close', '.media-time-slider-thumb']])).toEqual([]);
    const result = await new AxeBuilder({ page }).include('media-container').withRules(['target-size']).analyze();
    expect(result.violations.flatMap((v) => v.nodes.map((n) => n.target.join(' ')))).toEqual([]);
    // Put away, the edge is back.
    await page.keyboard.press('Escape');
    expect((await drawn(page, 'media-time-slider')).length).toBe(1);
  });
});
