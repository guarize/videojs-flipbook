import AxeBuilder from '@axe-core/playwright';
import { type Page } from '@playwright/test';
import { measure, media, open, pointerOnPlayer, SHOWCASE, skipWithout, startAndHold } from './support/player';
import { expect, test } from './support/test';

/**
 * The page holds its shape: no sideways scroll at five widths, axe clean (WCAG 2.0 and 2.1, A and AA) in the
 * player's states, and no layout shift over load and the first play. Each audit has a floor, so a broken audit that
 * measured nothing can't read as clean.
 */

const WIDTHS = [360, 390, 768, 1024, 1280];
const PAGES = [
  { name: 'showcase', path: SHOWCASE },
  { name: 'flipbook', path: '/flipbook.html' },
];
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

for (const { name, path } of PAGES) {
  for (const width of WIDTHS) {
    test(`${name} at ${width} px: no horizontal scroll`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 800 });
      await open(page, path);
      const m = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        // The audit's floor: it looked at a laid-out page.
        boxes: document.querySelectorAll('body *').length,
        // What pokes out, if anything, for the message.
        wide: [...document.querySelectorAll<HTMLElement>('body *')]
          .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5 && el.checkVisibility())
          .slice(0, 5)
          .map((el) => `${el.tagName.toLowerCase()}.${typeof el.className === 'string' ? el.className.split(' ')[0] : ''}`),
      }));
      await measure(testInfo, { kind: 'overflow', page: name, width, overflow: m.scrollWidth - m.clientWidth });
      expect(m.boxes).toBeGreaterThanOrEqual(name === 'showcase' ? 150 : 100);
      expect(m.scrollWidth, `wider than the window: ${m.wide.join(', ')}`).toBeLessThanOrEqual(m.clientWidth);
    });
  }
}

/** Runs axe over the page in a state; reports and asserts its violations and how much it checked. */
async function axe(page: Page, state: string, floor: number) {
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const nodesChecked = [...result.passes, ...result.violations, ...result.incomplete].reduce((n, r) => n + r.nodes.length, 0);
  await measure(test.info(), { kind: 'axe', state, nodesChecked, violations: result.violations.length, incomplete: result.incomplete.map((r) => r.id) });
  expect(nodesChecked, `axe checked too little in "${state}" to mean anything`).toBeGreaterThanOrEqual(floor);
  expect(
    result.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).slice(0, 4).join(' | ')}`),
    `axe violations, ${state}`,
  ).toEqual([]);
}

test('axe: the showcase as it loads', async ({ page }) => {
  await open(page, SHOWCASE);
  await axe(page, 'showcase', 150);
});

test('axe: the player paused, with its controls', async ({ page }) => {
  await open(page, SHOWCASE);
  await startAndHold(page, 20);
  await axe(page, 'paused', 150);
});

test('axe: the contents open', async ({ page }) => {
  skipWithout(test, 'contents');
  await open(page, SHOWCASE);
  await pointerOnPlayer(page);
  await startAndHold(page, 20);
  await page.keyboard.press('t');
  await expect(page.locator('.fb-contents-page')).toBeVisible();
  await axe(page, 'contents', 100);
});

test('axe: the shortcuts card open', async ({ page }) => {
  await open(page, SHOWCASE);
  await pointerOnPlayer(page);
  await page.keyboard.press('?');
  await expect(page.locator('fb-keymap [role="dialog"]')).toBeVisible();
  await axe(page, 'shortcuts', 100);
});

test('axe: the plate open', async ({ page }) => {
  skipWithout(test, 'plate');
  await open(page, SHOWCASE);
  await pointerOnPlayer(page);
  await startAndHold(page, 20);
  await page.keyboard.press('p');
  await expect(page.locator('.fb-plate-sheet')).toBeVisible();
  await axe(page, 'plate', 150);
});

test('layout shift over load and the first play stays under 0.01', async ({ page, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'layout-shift entries exist only in Chromium');
  await page.addInitScript(() => {
    const shifts: { at: number; value: number; input: boolean; sources: string[] }[] = [];
    (window as unknown as { __shifts: typeof shifts }).__shifts = shifts;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: { node?: Node }[] })[]) {
        shifts.push({
          at: Math.round(e.startTime),
          value: e.value,
          input: e.hadRecentInput,
          sources: (e.sources ?? []).map((s: any) => `${s.node instanceof Element ? `${s.node.tagName.toLowerCase()}.${s.node.className}` : String(s.node?.nodeName)} ${JSON.stringify(s.previousRect)}→${JSON.stringify(s.currentRect)}`),
        });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
  // On a real network the small chapter track arrives before the film's metadata (a range request into a 10 MB
  // file). A fast local server makes that a coin toss, so the film is held back 400 ms to make it the rule.
  await page.route('**/*.mp4', async (route) => {
    await new Promise((r) => setTimeout(r, 400));
    await route.continue();
  });
  await open(page, SHOWCASE);
  await page.waitForTimeout(1500);
  // The first play, from the keyboard (Space, which plays from the page), then a few seconds of it.
  await page.keyboard.press('Space');
  await page.waitForFunction(() => (document.querySelector('video') as HTMLVideoElement).currentTime > 3);
  expect((await media(page)).paused).toBe(false);
  const shifts = await page.evaluate(() => (window as unknown as { __shifts: { at: number; value: number; input: boolean; sources: string[] }[] }).__shifts);
  const cls = shifts.filter((s) => !s.input).reduce((n, s) => n + s.value, 0);
  const all = shifts.reduce((n, s) => n + s.value, 0);
  await measure(testInfo, { kind: 'cls', cls: Math.round(cls * 10000) / 10000, allShifts: Math.round(all * 10000) / 10000, shifts });
  // Shifts right after a key press are left out of CLS by definition; the first play is one, so they count here too.
  expect(all, `layout shifts: ${JSON.stringify(shifts)}`).toBeLessThan(0.01);
});
