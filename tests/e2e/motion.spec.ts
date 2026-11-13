import { type Page } from '@playwright/test';
import { focusPlayer, measure, media, open, SHOWCASE, skipWithout } from './support/player';
import { expect, test } from './support/test';

/**
 * Reduced motion removes the travel, never the information. With `prefers-reduced-motion: reduce`, each still state
 * (loaded, paused with its strip, contents open, plate open) is photographed twice, 800 ms apart, and the two must be byte-identical.
 * The WebGL page turn is never created: no `.fb-paper` canvas and no WebGL context, at any point.
 */
test.use({ reducedMotion: 'reduce' });

/** Counts WebGL contexts and `.fb-paper` canvases from the first script on. */
const watchWebGL = () => {
  const seen = { webgl: 0, paper: 0 };
  (window as unknown as { __motion: typeof seen }).__motion = seen;
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
    if (/webgl/i.test(type)) seen.webgl++;
    return (getContext as (...a: unknown[]) => unknown).call(this, type, ...rest);
  } as typeof getContext;
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n instanceof Element && (n.matches('.fb-paper') || n.querySelector('.fb-paper'))) seen.paper++;
  }).observe(document, { childList: true, subtree: true });
};

/** Two screenshots 800 ms apart, byte for byte. The pointer is parked off the page, the caret hidden. */
async function still(page: Page, state: string) {
  // Controls answer input within 250 ms; give the state a moment to finish arriving, then hold it.
  await page.waitForTimeout(600);
  const a = await page.screenshot({ caret: 'hide' });
  await page.waitForTimeout(800);
  const b = await page.screenshot({ caret: 'hide' });
  const same = a.equals(b);
  if (!same) {
    await test.info().attach(`${state}-a`, { body: a, contentType: 'image/png' });
    await test.info().attach(`${state}-b`, { body: b, contentType: 'image/png' });
  }
  expect.soft(same, `${state}: two frames 800 ms apart are identical`).toBe(true);
  return same;
}

test('reduced motion: every still state is still, and the WebGL page turn never starts', async ({ page }, testInfo) => {
  skipWithout(test, 'plate', 'turns');
  await page.addInitScript(watchWebGL);
  await open(page, SHOWCASE);
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
  await page.locator('#player').scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);

  const results: Record<string, boolean> = {};
  results.loaded = await still(page, 'loaded');

  // Focus in the player (the pointer stays parked off the page): K, T, P and N are its own.
  await focusPlayer(page);
  // Play (K), let it run, pause (K): the page prints, and the plate stays away.
  await page.keyboard.press('k');
  await page.waitForFunction(() => (document.querySelector('video') as HTMLVideoElement).currentTime > 2);
  await page.keyboard.press('k');
  await expect.poll(async () => (await media(page)).paused).toBe(true);
  await expect(page.locator('media-container')).toHaveAttribute('data-fb-print', '');
  await expect(page.locator('.fb-plate-sheet')).toBeHidden();
  // The showcase's player (753 px in this window) keeps under 56 % of its picture over a foot, so its page has the
  // Plate key and no strip (plate.ts; the strip's own stillness under reduced motion is plate.spec's). Where a strip
  // does stand, its frames are read one by one: that's the content arriving, not motion.
  await expect(page.locator('.fb-plate-toggle')).toBeVisible();
  if (await page.locator('fb-plate[data-strip]').count()) await expect(page.locator('.fb-strip-cell:not([data-ready])')).toHaveCount(0);
  results.paused = await still(page, 'paused');

  await page.keyboard.press('t');
  await expect(page.locator('.fb-contents-page')).toBeVisible();
  results.contents = await still(page, 'contents');
  await page.keyboard.press('Escape');
  await expect(page.locator('.fb-contents-page')).toBeHidden();

  await page.keyboard.press('p');
  await expect(page.locator('.fb-plate-sheet')).toBeVisible();
  await expect(page.locator('.fb-plate-cell:not([data-ready])')).toHaveCount(0);
  results.plate = await still(page, 'plate');

  // A chapter turn (N) under reduced motion cuts instead of turning a page.
  await page.keyboard.press('Escape');
  await page.keyboard.press('n');
  await expect.poll(async () => (await media(page)).time).toBeGreaterThan(11);
  results.afterTurn = await still(page, 'after a chapter turn');

  const webgl = await page.evaluate(() => (window as unknown as { __motion: { webgl: number; paper: number } }).__motion);
  await measure(testInfo, { still: results, ...webgl });
  expect(webgl.paper, '.fb-paper canvases created').toBe(0);
  expect(webgl.webgl, 'WebGL contexts requested').toBe(0);
});

test('reduced motion: the first play riffles nothing', async ({ page }) => {
  await page.addInitScript(() => {
    const seen = { flicks: 0 };
    (window as unknown as { __riffle: typeof seen }).__riffle = seen;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, ...args: Parameters<Element['animate']>) {
      if (this.classList?.contains('fb-edge-flick-page')) seen.flicks++;
      return animate.apply(this, args);
    };
  });
  await open(page, SHOWCASE);
  // The pages the riffle would lift are there: it's the motion that is withheld, not the edge.
  await expect(page.locator('.fb-edge-flick-page')).toHaveCount(5);
  await page.keyboard.press('Space');
  await expect.poll(async () => (await media(page)).time).toBeGreaterThan(0.8);
  expect(await page.evaluate(() => (window as unknown as { __riffle: { flicks: number } }).__riffle.flicks), 'pages riffled under reduced motion').toBe(0);
  expect(await page.locator('.fb-edge-flick-page').evaluateAll((pages) => pages.flatMap((p) => p.getAnimations()).length), 'animations on the loose pages').toBe(0);
});
