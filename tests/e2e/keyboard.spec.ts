import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Page } from '@playwright/test';
import { BARE, ESSENTIAL, measure, media, open, pointerOnPlayer, SHOWCASE, skipWithout, startAndHold, tabKey } from './support/player';
import { expect, test } from './support/test';

/**
 * The showcase with a keyboard alone, from page load: real Tab presses (Option-Tab in WebKit, as on a Mac), never
 * .focus(). Each stop must show a ring, read from computed styles (an outline, a box-shadow, or the player's own ring
 * layer), and is cropped into design/previews/audit/keyboard/ to be looked at.
 */

const CROPS = join(process.cwd(), 'design', 'previews', 'audit', 'keyboard');

interface Stop {
  key: string;
  tag: string;
  cls: string;
  name: string;
  inPlayer: boolean;
  ring: string | null;
  box: { x: number; y: number; width: number; height: number };
  /** Its top on the page, wherever the page had scrolled to when it took focus (Firefox scrolls as focus goes down the player). */
  top: number;
}

/** The focused element and the ring it draws, read from computed styles. */
const stop = (page: Page): Promise<Stop | null> =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const cs = getComputedStyle(el);
    const after = getComputedStyle(el, '::after');
    let ring: string | null = null;
    if (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2) ring = `outline ${cs.outlineWidth} ${cs.outlineStyle} ${cs.outlineColor}`;
    else if (cs.boxShadow !== 'none') ring = `box-shadow ${cs.boxShadow}`;
    else if (after.boxShadow !== 'none' && Number(after.opacity) > 0.9) ring = `::after box-shadow ${after.boxShadow}`;
    const r = el.getBoundingClientRect();
    const cls = typeof el.className === 'string' ? el.className.split(/\s+/).filter((c) => c.startsWith('fb-') || c.startsWith('media-')).slice(-1)[0] ?? '' : '';
    const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return {
      key: `${el.tagName.toLowerCase()}#${el.id}.${cls}|${name}`,
      tag: el.tagName.toLowerCase(),
      cls,
      name,
      inPlayer: !!el.closest('media-container'),
      ring,
      box: { x: r.x, y: r.y, width: r.width, height: r.height },
      top: r.y + scrollY,
    };
  });

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

test('Tab order from load: skip link, header, width presets, the features, then every control in the player, each with a ring', async ({ page, browserName }, testInfo) => {
  await open(page, SHOWCASE);
  const tab = tabKey(browserName);
  mkdirSync(CROPS, { recursive: true });

  const stops: Stop[] = [];
  for (let i = 0; i < 90; i++) {
    await page.keyboard.press(tab);
    const s = await stop(page);
    if (!s) break;
    // Left the player and went on to the page below it: the walk has covered what it is for.
    if (stops.some((p) => p.inPlayer) && !s.inPlayer && !s.cls && s.tag === 'a') break;
    stops.push(s);
    const pad = 12;
    await page.screenshot({
      path: join(CROPS, `${testInfo.project.name}-${String(stops.length).padStart(2, '0')}-${slug(s.cls || s.tag)}-${slug(s.name)}.png`),
      clip: { x: Math.max(0, s.box.x - pad), y: Math.max(0, s.box.y - pad), width: s.box.width + pad * 2, height: s.box.height + pad * 2 },
      animations: 'disabled',
    });
  }

  // The page's own stops, in the order they are drawn: the width presets, then the features (a radio group, one stop
  // on the choice).
  // Then the details on trial (the bench's Details row, one switch each; the row goes when the trial ends).
  const trial = ['Cloth bar', 'Type sorts', 'Folio', 'Spread icon', 'Sheets icon', 'Stick icon', 'Volume sheaf', 'Hover lift', 'States'];
  const page0 = ['Skip to the player', 'Gua, gua.studio', 'Source', 'gua.studio', '360 pixels', '480 pixels', '720 pixels', 'Fill', ESSENTIAL ? 'Essential' : 'Full book', ...trial];
  const head = stops.slice(0, page0.length).map((s) => s.name);
  expect(head).toEqual(page0);
  expect(stops[page0.length]?.tag, 'the player comes right after the switches').toBe('media-container');

  // Inside the player: every control is reachable.
  const player = stops.filter((s) => s.inPlayer);
  const reached = (cls: string) => player.some((s) => s.cls === cls || s.key.includes(`.${cls}|`));
  const book = ESSENTIAL ? [] : ['fb-contents-key', 'fb-bookmark'];
  for (const cls of ['fb-tab', 'media-time-slider-thumb', 'fb-play', 'fb-mute', 'media-volume-slider-thumb', 'fb-time-display', 'fb-rate', 'fb-captions', 'fb-settings', 'fb-pip', 'fb-fullscreen', 'fb-captype-key', ...book]) {
    expect.soft(reached(cls), `${cls} reached by Tab`).toBe(true);
  }
  // The poster's large play key is not a second "Play" stop beside the bar's (a11y finding 24).
  expect(reached('fb-cover-play'), 'fb-cover-play is a pointer target only').toBe(false);
  // The chapter tabs are one stop, with the arrow keys inside.
  expect(player.filter((s) => s.tag === 'button' && s.cls === 'fb-tab').length, 'chapter tabs are one Tab stop').toBe(1);

  // No stop without a ring; none visited twice (no trap).
  const ringless = stops.filter((s) => !s.ring).map((s) => s.key);
  expect(ringless, 'stops with no visible focus ring').toEqual([]);
  expect(new Set(stops.map((s) => s.key)).size, 'no stop visited twice').toBe(stops.length);
  // The walk measured something: the audit floor.
  expect(stops.length).toBeGreaterThanOrEqual(20);

  // The bar's bottom row reads left to right in Tab order.
  const row = player.filter((s) => s.top > (player.find((p) => p.cls === 'fb-play')?.top ?? 0) - 4 && s.box.height <= 60);
  const xs = row.map((s) => Math.round(s.box.x));
  expect(xs, `bottom row in visual order: ${row.map((s) => s.cls).join(', ')}`).toEqual([...xs].sort((a, b) => a - b));

  await measure(testInfo, { pageStops: stops.length, playerStops: player.length, ringless: ringless.length });
});

test('the plate grid and the contents list are one Tab stop each', async ({ page, browserName }, testInfo) => {
  skipWithout(test, 'plate', 'contents');
  await open(page, SHOWCASE);
  const tab = tabKey(browserName);
  // The pointer on the picture: P and T are the player's while it is there (or focus is in the player).
  await pointerOnPlayer(page);
  await startAndHold(page, 20);

  // The plate: P lays it out; Tab through it counts its cells.
  await page.keyboard.press('p');
  await expect(page.locator('.fb-plate-sheet')).toBeVisible();
  // Focus moves into the grid as it opens; from there, Shift+Tab and Tab walk out both ways.
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.matches('.fb-plate-cell'))).toBe(true);
  const plateStops: string[] = [];
  for (const key of [`Shift+${tab}`, tab]) {
    for (let i = 0; i < 6; i++) {
      const s = await stop(page);
      if (s && !plateStops.includes(s.key)) plateStops.push(s.key);
      await page.keyboard.press(key);
    }
    while (!(await page.evaluate(() => !!document.activeElement?.matches('.fb-plate-cell')))) await page.keyboard.press(key === tab ? `Shift+${tab}` : tab);
  }
  const cells = plateStops.filter((k) => k.includes('.fb-plate-cell'));
  expect(cells.length, `plate cells among the stops: ${plateStops.join(' → ')}`).toBe(1);
  // Arrows move inside the grid.
  const before = await page.evaluate(() => document.activeElement?.textContent);
  await page.keyboard.press('ArrowRight');
  const after = await page.evaluate(() => document.activeElement?.textContent);
  expect(after).not.toBe(before);
  await page.keyboard.press('Escape');
  await expect(page.locator('.fb-plate-sheet')).toBeHidden();

  // The contents: T opens it; its chapter list is one stop.
  await page.keyboard.press('t');
  await expect(page.locator('.fb-contents-page')).toBeVisible();
  const contentsStops: string[] = [];
  for (let i = 0; i < 30; i++) {
    const s = await stop(page);
    if (!s || contentsStops.includes(s.key)) break;
    contentsStops.push(s.key);
    await page.keyboard.press(tab);
  }
  const options = contentsStops.filter((k) => k.startsWith('li#') && k.includes('fb-contents-option'));
  expect(options.length, `chapter options among the stops: ${contentsStops.join(' → ')}`).toBe(1);
  await page.keyboard.press('Escape');

  await measure(testInfo, { plateStops: plateStops.length, contentsStops: contentsStops.length });
});

test('shortcuts work without focusing the player: Space from the page, and K with the pointer over the player', async ({ page }) => {
  await open(page, SHOWCASE);
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  expect((await media(page)).paused).toBe(true);
  await page.keyboard.press('Space');
  await expect.poll(async () => (await media(page)).paused).toBe(false);
  await page.keyboard.press('Space');
  await expect.poll(async () => (await media(page)).paused).toBe(true);
  // A character key needs the pointer on the player (or focus in it): a11y.spec.ts holds the other half.
  await page.locator('media-container').first().hover({ position: { x: 200, y: 120 } });
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  await page.keyboard.press('k');
  await expect.poll(async () => (await media(page)).paused).toBe(false);
  await page.keyboard.press('k');
  await expect.poll(async () => (await media(page)).paused).toBe(true);
});

// Firefox makes a Tab stop of every film, controls or none, and a second one inside it (its own picture-in-picture
// toggle): from the player, two presses of Tab landed on the film, nothing with a name, the first with the browser's
// own ring (13 Nov 2026, Firefox 157; a11y.ts takes the film out of the order there).
test('the film itself is no Tab stop, before it has played or after: from the player, Tab goes to a key', async ({ page, browserName }) => {
  await open(page, BARE);
  const stops = async () => {
    await page.locator('media-container').evaluate((el: HTMLElement) => el.focus({ preventScroll: true }));
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press(tabKey(browserName));
      seen.push(await page.evaluate(() => (document.activeElement as HTMLElement).localName));
    }
    return seen;
  };
  expect(await stops(), 'the first four stops after the player, before the film has played').not.toContain('video');
  await startAndHold(page, 20);
  expect(await stops(), 'and paused, after it has').not.toContain('video');
});

