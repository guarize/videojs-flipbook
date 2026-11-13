import { type Page } from '@playwright/test';
import { BARE, open, revealControls, tabKey, tabTo } from './support/player';
import { arrive, receivers } from './support/receivers';
import { expect, test } from './support/test';

/**
 * AirPlay and Cast: keys that come when the network says there is a receiver, at any time after the mount, and go
 * when it says there is none (src/skins/flipbook/skin.html, skin.css, menu.ts).
 *
 * - No place is kept for them: most machines never have a receiver. And Cast is a key only with one: Video.js would
 *   keep it in the row, dim and dead, wherever the browser can cast at all.
 * - Nothing moves when one comes or goes. The top bar's keys are packed against the far side, and the receiver's
 *   key stands first of them, in the markup, so it takes its room from the title and Tab goes as the eye does. It
 *   stood last, and moved every key 48 px. The row is a key tall with or without one, so the title holds too.
 * - On a phone the keys are rows in Settings: a row that comes or goes while Settings is open waits until it is
 *   closed, for the sheet stands on the screen's foot and a row more lifted every row 50 px under the finger.
 *
 * No receiver is needed: the browser's own word is given (support/receivers.ts).
 */

const KEY = { webkit: '#flipbook-airplay', chromium: '#flipbook-cast' } as const;
const NAME = { webkit: 'Start AirPlay', chromium: 'Start casting' } as const;
const ROW = { webkit: 'airplay', chromium: 'cast' } as const;
type Engine = keyof typeof KEY;

/** Sets up the reading of every part's place on each frame, from when the test says (`watch`). */
async function watched(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __watch: (selector: string) => void; __places: () => Record<string, string[]> };
    const parts = new Map<Element, { name: string; places: string[] }>();
    w.__watch = (selector) => {
      const container = document.querySelector('media-container') as HTMLElement;
      const look = () => {
        for (const el of container.querySelectorAll(selector)) {
          if (el.closest('media-tooltip')) continue;
          const box = el.getBoundingClientRect();
          const part = parts.get(el) ?? parts.set(el, { name: `${el.id || el.getAttribute('data-fb-menu') || el.className}`, places: [] }).get(el)!;
          const place = box.width > 0 ? `${Math.round(box.x * 10) / 10}, ${Math.round(box.y * 10) / 10}` : 'not shown';
          if (part.places[part.places.length - 1] !== place) part.places.push(place);
        }
        requestAnimationFrame(look);
      };
      requestAnimationFrame(look);
    };
    w.__places = () => Object.fromEntries([...parts.values()].map((part, i) => [`${part.name} (${i})`, part.places]));
  });
}
const watch = (page: Page, selector: string) => page.evaluate((s) => (window as unknown as { __watch: (selector: string) => void }).__watch(s), selector);
/** Every part watched that was in more than one place, or came or went, with its places in order. */
const moved = async (page: Page) => Object.fromEntries(Object.entries(await page.evaluate(() => (window as unknown as { __places: () => Record<string, string[]> }).__places())).filter(([, places]) => places.length > 1));

/** Long enough for a key to come in and a sheet to finish growing (it eases over about 200 ms). */
const SETTLED = 700;
const ROWS = '.video-controls-top > *, .fb-bar button, .fb-bar [role="button"], .fb-bar .media-button, .fb-book-row > *';

test.describe('a receiver comes and goes: the key is there only then, and nothing else moves', () => {
  test.skip(({ browserName }) => browserName === 'firefox', 'Firefox has neither AirPlay nor the Remote Playback API: no receiver’s key ever comes (the last test here)');
  for (const { width, touch } of [
    { width: 1280, touch: false },
    { width: 1024, touch: false },
    { width: 1024, touch: true },
    { width: 600, touch: false },
  ]) {
    test(`a ${width} px player${touch ? ', by touch' : ''}`, async ({ browser, browserName }) => {
      const engine = browserName as Engine;
      const context = await browser.newContext({ viewport: { width, height: 800 }, ...(touch ? { hasTouch: true } : {}) });
      const page = await context.newPage();
      await receivers(page);
      await watched(page);
      await open(page, BARE);
      await revealControls(page);
      const key = page.locator(KEY[engine]);
      // With no receiver there is no key, and no dead one: the browser has said "none" by now.
      await expect(key).toBeHidden();
      await expect(page.locator('#flipbook-airplay, #flipbook-cast').filter({ visible: true })).toHaveCount(0);

      await watch(page, ROWS);
      await page.waitForTimeout(300);
      await arrive(page, true);
      await expect(key).toBeVisible();
      await expect(key).toHaveAttribute('aria-label', NAME[engine]);
      await expect(key).toBeEnabled();
      const box = await key.boundingBox();
      expect([Math.round(box?.width ?? 0), Math.round(box?.height ?? 0)], 'the key’s target').toEqual([44, 44]);
      await page.waitForTimeout(SETTLED);
      await arrive(page, false);
      await expect(key).toBeHidden();
      await page.waitForTimeout(SETTLED);

      const places = await moved(page);
      const own = Object.keys(places).filter((name) => name.startsWith(KEY[engine].slice(1)));
      expect(own, 'the key came and went').toHaveLength(1);
      expect(places[own[0]], 'and stood in one place').toHaveLength(3);
      expect(Object.keys(places).filter((name) => !own.includes(name)), 'every other part that was somewhere else on some frame, or came or went').toEqual([]);
      await context.close();
    });
  }

  test('it stands first of the top bar’s keys, and Tab reaches it there', async ({ page, browserName }) => {
    const engine = browserName as Engine;
    await page.setViewportSize({ width: 1024, height: 800 });
    await receivers(page);
    await open(page, BARE);
    await arrive(page, true);
    await expect(page.locator(KEY[engine])).toBeVisible();
    const order = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.video-controls-top > .media-button')]
        .filter((el) => el.getBoundingClientRect().width > 0)
        .map((el) => ({ id: el.id, x: Math.round(el.getBoundingClientRect().x) })),
    );
    expect(order[0].id, 'the first key drawn in the row').toBe(KEY[engine].slice(1));
    expect(order.map((entry) => entry.x), 'the keys from left to right are the keys in the order of the markup').toEqual([...order.map((entry) => entry.x)].sort((a, b) => a - b));
    await tabTo(page, browserName, KEY[engine]);
    await page.keyboard.press(tabKey(browserName));
    expect(await page.evaluate(() => document.activeElement?.id), 'the next stop after it').toBe(order[1].id);
  });
});

test.describe('on a phone the keys are rows in Settings', () => {
  test.skip(({ browserName }) => browserName === 'firefox', 'Firefox has neither AirPlay nor the Remote Playback API: no receiver’s key ever comes (the last test here)');
  test.use({ viewport: { width: 390, height: 780 }, hasTouch: true });

  test('a receiver that comes while Settings is open moves no row: its row is there the next time, a finger’s height, named; and stays until Settings is closed when it goes', async ({ page, browserName }) => {
    const engine = browserName as Engine;
    await receivers(page);
    await watched(page);
    await open(page, BARE);
    const settings = page.locator('#flipbook-settings');
    const row = page.locator(`#flipbook-settings [data-fb-menu="${ROW[engine]}"]`);
    // (Opened by its key; closed by Escape, for the sheet lies over the key.)
    const toggle = async (shown: boolean) => {
      if (shown) await page.locator('.fb-settings').click();
      else await page.keyboard.press('Escape');
      if (shown) await expect(settings).toBeVisible();
      else await expect(settings).toBeHidden();
      await page.waitForTimeout(SETTLED);
    };

    await toggle(true);
    await expect(row).toBeHidden();
    await watch(page, '#flipbook-settings, #flipbook-settings .media-menu-item');
    await page.waitForTimeout(300);
    await arrive(page, true);
    await page.waitForTimeout(SETTLED);
    expect(await moved(page), 'rows that were somewhere else on some frame, or came, with Settings open').toEqual({});
    await expect(row).toBeHidden();

    await toggle(false);
    await toggle(true);
    await expect(row).toBeVisible();
    await expect(row).toContainText(NAME[engine]);
    expect(Math.round((await row.boundingBox())?.height ?? 0), 'the row’s height under a finger').toBeGreaterThanOrEqual(44);

    // Gone again with Settings open: the row stays where the finger may be, until Settings is closed.
    await arrive(page, false);
    await page.waitForTimeout(SETTLED);
    await expect(row).toBeVisible();
    await toggle(false);
    await toggle(true);
    await expect(row).toBeHidden();
  });
});

test('with no word of a receiver from the browser there is neither key, nor a row for one in Settings', async ({ page }) => {
  await open(page, BARE);
  await revealControls(page);
  await expect(page.locator('#flipbook-airplay, #flipbook-cast').filter({ visible: true })).toHaveCount(0);
  await page.locator('.fb-settings').click();
  await expect(page.locator('#flipbook-settings')).toBeVisible();
  await expect(page.locator('#flipbook-settings :is([data-fb-menu="airplay"], [data-fb-menu="cast"])').filter({ visible: true })).toHaveCount(0);
});
