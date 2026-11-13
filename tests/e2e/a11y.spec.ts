import AxeBuilder from '@axe-core/playwright';
import { type Locator, type Page } from '@playwright/test';
import { BARE, ESSENTIAL, media, measure, open, recordFullscreen, settle, SHOWCASE, skipWithout, startAndHold, tabKey, tabTo } from './support/player';
import { expect, test } from './support/test';

/**
 * The accessibility fixes (design/previews/audit-a11y/findings.md), each held by a check that failed against the code
 * before it: forced colours read from pixels, the time field's error in words, character keys kept to the player, the shortcuts
 * card scrolled by keys, one announcement per chapter turn, Escape out of the volume, and axe in every state.
 * Focus moves by real key presses only.
 */

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const browser = () => test.info().project.name;

/** Into the bare player with the keyboard: the container is the first stop. */
async function enter(page: Page, path = BARE) {
  await open(page, path);
  await tabTo(page, browser(), 'media-container');
}

type Box = { x: number; y: number; width: number; height: number };

/** The RGB of every pixel in a region of the page, read from a real screenshot. */
async function pixels(page: Page, clip: Box): Promise<number[]> {
  const png = await page.screenshot({ clip });
  return page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes]));
    const cv = new OffscreenCanvas(bmp.width, bmp.height);
    const cx = cv.getContext('2d') as OffscreenCanvasRenderingContext2D;
    cx.drawImage(bmp, 0, 0);
    const { data } = cx.getImageData(0, 0, bmp.width, bmp.height);
    const rgb: number[] = [];
    for (let i = 0; i < data.length; i += 4) rgb.push(data[i], data[i + 1], data[i + 2]);
    return rgb;
  }, png.toString('base64'));
}

const lin = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (r: number, g: number, b: number) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

/**
 * The contrast between the darkest and the lightest pixel inside an element, its edge left out (inset by 4 px), so
 * a bordered box with nothing in it reads 1:1 however dark its border.
 */
async function inkRange(page: Page, target: Locator): Promise<number> {
  const box = await target.boundingBox();
  if (!box) throw new Error('not laid out');
  const rgb = await pixels(page, { x: box.x + 4, y: box.y + 4, width: Math.max(1, box.width - 8), height: Math.max(1, box.height - 8) });
  let lo = 1;
  let hi = 0;
  for (let i = 0; i < rgb.length; i += 3) {
    const l = luminance(rgb[i], rgb[i + 1], rgb[i + 2]);
    lo = Math.min(lo, l);
    hi = Math.max(hi, l);
  }
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * A focus ring, from pixels: the pixels that change between focused and not, how many, and whether they moved
 * towards the system highlight colour (forced colours' highlight can be translucent, so it is never matched exactly).
 */
function ringChange(focused: number[], unfocused: number[], highlight: number[]) {
  const distance = (rgb: number[], i: number) =>
    Math.abs(rgb[i] - highlight[0]) + Math.abs(rgb[i + 1] - highlight[1]) + Math.abs(rgb[i + 2] - highlight[2]);
  let changed = 0;
  let towards = 0;
  for (let i = 0; i < focused.length; i += 3) {
    const delta = Math.abs(focused[i] - unfocused[i]) + Math.abs(focused[i + 1] - unfocused[i + 1]) + Math.abs(focused[i + 2] - unfocused[i + 2]);
    if (delta < 40) continue;
    changed++;
    if (distance(focused, i) < distance(unfocused, i)) towards++;
  }
  return { changed, towards };
}

/** The system highlight colour, as the page resolves it under forced colours. */
const highlight = (page: Page) =>
  page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'Highlight';
    document.body.append(probe);
    const rgb = getComputedStyle(probe).color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
    probe.remove();
    return rgb;
  });

/** Every live region's messages, recorded as they're set (installed before the page loads). */
const recordLive = () => {
  const said: { region: string; text: string }[] = [];
  (window as unknown as { __said: typeof said }).__said = said;
  const seen = new WeakSet<Element>();
  const hook = () => {
    for (const el of document.querySelectorAll('[aria-live], [role="status"], [role="alert"]')) {
      if (seen.has(el)) continue;
      seen.add(el);
      new MutationObserver(() => {
        const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (text && el.getAttribute('aria-live') !== 'off') said.push({ region: String(el.className).split(' ')[0] || el.tagName.toLowerCase(), text });
      }).observe(el, { childList: true, subtree: true, characterData: true });
    }
  };
  new MutationObserver(hook).observe(document, { childList: true, subtree: true });
};
const said = (page: Page) => page.evaluate(() => (window as unknown as { __said: { region: string; text: string }[] }).__said.slice());

/** Forced colours replace the skin's colours with the system's: checked to leave nothing behind. */
for (const theme of ['flipbook']) {
  const path = BARE;

  test.describe(`forced colours, ${theme}`, () => {
    test.beforeEach(async ({ page, browserName }) => {
      test.skip(browserName !== 'chromium', 'forced-colours emulation exists only in Chromium');
      await page.emulateMedia({ forcedColors: 'active' });
    });

    test('every label, keycap and value reads as text, not a blank box', async ({ page }, testInfo) => {
      await enter(page, path);
      await startAndHold(page, 14);
      const parts: [string, Locator][] = [
        ['speed', page.locator('.fb-rate')],
        ['title', page.locator('.media-title')],
        ['bar keycap', page.locator('.fb-slab-key .fb-keycap').first()],
        ['chapter tab', page.locator('.fb-tab-face').nth(1)],
        ['time', page.locator('.fb-time-display')],
      ];
      const results: Record<string, number> = {};
      for (const [name, part] of parts) {
        if (!(await part.isVisible())) continue;
        results[name] = await inkRange(page, part);
      }
      await page.keyboard.press('Shift+C');
      await expect(page.locator('fb-caption-style [role="dialog"]')).toBeVisible();
      results['caption option, not chosen'] = await inkRange(page, page.locator('.fb-captype-option:not(:has(:checked))').first());
      results['caption reset'] = await inkRange(page, page.locator('.fb-captype-reset'));
      await measure(testInfo, { kind: 'forced-text', theme, ...results });
      expect(Object.keys(results).length, 'measured too few parts').toBeGreaterThanOrEqual(6);
      for (const [name, ratio] of Object.entries(results)) expect(ratio, `${name}: darkest to lightest pixel`).toBeGreaterThanOrEqual(4.5);
    });

    test('the focus ring is drawn in the highlight colour, on the player and on a key', async ({ page }) => {
      await open(page, path);
      const rgb = await highlight(page);
      expect(rgb.length).toBe(3);
      const player = await page.locator('media-container').boundingBox();
      if (!player) throw new Error('no player');
      // The player's own ring: a strip along its top edge, focused (the first Tab) and not (the next).
      const strip = { x: player.x + 20, y: player.y, width: player.width - 40, height: 6 };
      await tabTo(page, browser(), 'media-container');
      const playerOn = await pixels(page, strip);
      await page.keyboard.press(tabKey(browser()));
      const playerOff = await pixels(page, strip);
      const onPlayer = ringChange(playerOn, playerOff, rgb);
      expect(onPlayer.changed, 'pixels along the player top edge that change with focus').toBeGreaterThan(strip.width * 2);
      expect(onPlayer.towards / onPlayer.changed, 'share of them turned towards the highlight colour').toBeGreaterThan(0.9);

      // The Plate key (shown while paused), or under essential (no plate) the slab's Caption style key: its ring, in the
      // band 2 to 4 px outside its edge, against that band before.
      const KEY = ESSENTIAL ? '#flipbook-caption-style-slab' : '.fb-plate-toggle';
      await startAndHold(page, 14);
      await tabTo(page, browser(), 'media-container');
      const key = await page.locator(KEY).boundingBox();
      if (!key) throw new Error('no plate key');
      const pad = 6;
      const around = { x: Math.round(key.x) - pad, y: Math.round(key.y) - pad, width: Math.round(key.width) + pad * 2, height: Math.round(key.height) + pad * 2 };
      const band = (rgb: number[]) => {
        const out: number[] = [];
        for (let i = 0, p = 0; i < rgb.length; i += 3, p++) {
          const x = p % around.width;
          const y = Math.floor(p / around.width);
          const dx = Math.max(pad - x, x - (around.width - pad - 1), 0);
          const dy = Math.max(pad - y, y - (around.height - pad - 1), 0);
          if (Math.max(dx, dy) >= 2 && Math.max(dx, dy) <= 4) out.push(rgb[i], rgb[i + 1], rgb[i + 2]);
        }
        return out;
      };
      const keyOff = band(await pixels(page, around));
      await tabTo(page, browser(), KEY);
      const keyOn = band(await pixels(page, around));
      const onKey = ringChange(keyOn, keyOff, rgb);
      expect(onKey.changed, 'ring pixels around the Plate key').toBeGreaterThan(2 * (key.width + key.height));
      // Anti-aliased corners and the tooltip's edge account for the rest.
      expect(onKey.towards / onKey.changed, 'share of them turned towards the highlight colour').toBeGreaterThan(0.8);
    });
  });
}

test('a mistyped time is said in words, linked to the field and announced', async ({ page }) => {
  await page.addInitScript(recordLive);
  await enter(page);
  await tabTo(page, browser(), '.fb-time-display');
  await page.keyboard.press('Enter');
  const field = page.locator('.fb-time-field');
  await expect(field).toBeFocused();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('soon');
  await page.keyboard.press('Enter');

  const error = page.locator('.fb-time [data-x-part="error"]');
  await expect(error).toBeVisible();
  await expect(error).toHaveText(/isn’t a time.+1:23/);
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(field).toHaveAccessibleDescription(/isn’t a time/);
  await expect(field, 'focus stays in the field to fix it').toBeFocused();
  await expect.poll(async () => (await said(page)).filter((s) => /isn’t a time/.test(s.text)).length).toBe(1);

  // Past the end: a different message, also heard.
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('9:00');
  await page.keyboard.press('Enter');
  await expect(error).toHaveText(/after the end, 1:38/);
  await expect.poll(async () => (await said(page)).filter((s) => /after the end/.test(s.text)).length).toBe(1);

  // Typing again clears it; Escape puts the field away with nothing left behind.
  await page.keyboard.type('1');
  await expect(error).toBeEmpty();
  await expect(field).not.toHaveAttribute('aria-invalid', /.*/);
  await page.keyboard.press('Escape');
  await expect(page.locator('.fb-time-display')).toBeFocused();
});

test('character keys typed on the page do nothing; they answer with the pointer over the player or focus in it (2.1.4)', async ({ page }) => {
  await page.addInitScript(recordFullscreen);
  await open(page, SHOWCASE);
  const container = page.locator('media-container').first();
  const state = async () => ({
    ...(await media(page)),
    bookmarks: await page.locator('.fb-ribbon, [data-fb-ribbon]').count(),
    bookmarked: await page.locator('.fb-bookmark[data-bookmarked]').count(),
    cards: await page.locator('fb-keymap [role="dialog"]:visible, fb-contents [role="dialog"]:visible').count(),
    fullscreen: await page.evaluate(() => (window as unknown as { __fullscreen?: string[] }).__fullscreen?.length ?? 0),
  });
  // The pointer starts in the page's corner, away from the player, and nothing has focus.
  await page.mouse.move(2, 2);
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  expect(await container.evaluate((el) => el.matches(':hover')), 'pointer off the player').toBe(false);
  const before = await state();
  expect(before.paused).toBe(true);

  // Speech input spelling words, or a stray press: every character key the player knows, typed on the page.
  // No spaces: Space is not a character key here, it still plays from the page (below).
  await page.keyboard.type('backkjlmctbnpif0123456789<>[]?');
  await page.waitForTimeout(400);
  expect(await state(), 'character keys typed on the page, pointer elsewhere').toEqual(before);
  expect((await media(page)).time, 'the film has not moved').toBe(before.time);

  // The switch is gone: nothing to find, nothing kept.
  expect(await page.evaluate(() => localStorage.getItem('x-page-keys'))).toBeNull();

  // Keys that type nothing still work from the page: Space plays and pauses, without scrolling it.
  const scrolled = await page.evaluate(() => scrollY);
  await page.keyboard.press('Space');
  await expect.poll(async () => (await media(page)).paused).toBe(false);
  await page.keyboard.press('Space');
  await expect.poll(async () => (await media(page)).paused).toBe(true);
  expect(await page.evaluate(() => scrollY), 'Space did not scroll the page').toBe(scrolled);

  // The pointer over the player: K and M are the player's, with nothing focused still.
  const box = await container.boundingBox();
  if (!box) throw new Error('no player');
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.3);
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  await page.keyboard.press('k');
  await expect.poll(async () => (await media(page)).paused).toBe(false);
  await page.keyboard.press('m');
  await expect.poll(async () => (await media(page)).muted).toBe(true);
  await page.keyboard.press('k');
  await expect.poll(async () => (await media(page)).paused).toBe(true);

  // The pointer leaves: they're the page's again.
  await page.mouse.move(2, 2);
  await page.keyboard.press('k');
  await page.keyboard.press('m');
  await page.waitForTimeout(400);
  expect(await media(page), 'K and M with the pointer off the player again').toMatchObject({ paused: true, muted: true });

  // Focus in the player, pointer still away: its keys work, and the card says when they do.
  await tabTo(page, browser(), 'media-container');
  await page.keyboard.press('m');
  await expect.poll(async () => (await media(page)).muted).toBe(false);
  await page.keyboard.press('?');
  const card = page.locator('fb-keymap [role="dialog"]');
  await expect(card).toBeVisible();
  await expect(card.getByRole('switch')).toHaveCount(0);
  await expect(card.locator('.fb-keymap-note')).toHaveText(/while the player has focus or the pointer is over it/);
});

test('the shortcuts card is a named region that scrolls with the keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 420 });
  await enter(page);
  await page.keyboard.press('?');
  const region = page.locator('.fb-keymap');
  await expect(region).toBeVisible();
  await expect(region).toHaveAttribute('role', 'region');
  await expect(region).toHaveAccessibleName('Shortcuts');
  const room = await region.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  expect(room.scroll, 'the card has to overflow for this to mean anything').toBeGreaterThan(room.client + 40);
  await tabTo(page, browser(), '.fb-keymap', 6);
  await page.keyboard.press('PageDown');
  await expect.poll(() => region.evaluate((el) => el.scrollTop)).toBeGreaterThan(40);
  await page.keyboard.press('End');
  await expect.poll(() => region.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop), 'End reaches the bottom').toBeLessThanOrEqual(2);
  // Two keys in a row are heard as alternatives.
  await expect(page.locator('.fb-keymap-row dt').first()).toHaveText('Space or K');
});

test('a chapter turn is announced once, where it lands, and nowhere else', async ({ page }) => {
  await page.addInitScript(recordLive);
  await enter(page);
  await startAndHold(page, 3);
  await tabTo(page, browser(), 'media-container');
  const before = (await said(page)).length;

  await page.keyboard.press('n');
  await expect.poll(async () => (await media(page)).time).toBeGreaterThan(12);
  await page.waitForTimeout(1200);
  let heard = (await said(page)).slice(before);
  expect(heard.filter((s) => /^Chapter 2: .+, 0:12$/.test(s.text)), JSON.stringify(heard)).toHaveLength(1);
  expect(heard.filter((s) => /Chapter|Seeked/.test(s.text)), JSON.stringify(heard)).toHaveLength(1);

  // Another turn, another single message.
  const next = (await said(page)).length;
  await page.keyboard.press('n');
  await expect.poll(async () => (await media(page)).time).toBeGreaterThan(36);
  await page.waitForTimeout(1200);
  heard = (await said(page)).slice(next);
  expect(heard.filter((s) => /Chapter|Seeked/.test(s.text)), JSON.stringify(heard)).toEqual([expect.objectContaining({ text: 'Chapter 3: The Herd, 0:36' })]);
});

test('the lifted corner draws its focus ring above the fold, all the way round (2.4.7, finding 2)', async ({ page }, testInfo) => {
  skipWithout(test, 'curl');
  await open(page, BARE);
  await startAndHold(page, 14);
  const corner = page.locator('.fb-curl-button');
  await expect(page.locator('fb-curl[data-open]')).toBeAttached();
  await page.waitForTimeout(700);
  await settle(page);
  const box = await corner.boundingBox();
  if (!box) throw new Error('no corner');
  const clip = { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
  // Nothing focused, the pointer away: the corner at rest.
  const rest = await pixels(page, clip);
  await tabTo(page, browser(), '.fb-curl-button');
  await settle(page);
  const ring = await corner.evaluate((el) => getComputedStyle(el, '::after').borderTopColor.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? []);
  expect(ring.length).toBe(3);
  const focused = await pixels(page, clip);
  await testInfo.attach('corner-focused', { body: await page.screenshot({ clip: { x: clip.x - 12, y: Math.max(0, clip.y - 12), width: clip.width + 24, height: clip.height + 24 } }), contentType: 'image/png' });
  const change = ringChange(focused, rest, ring);
  // A 2 px ring 3 px inside the corner's square: four sides of it, less the rounded corners. The outline it replaced
  // was painted under the fold and changed 8 pixels in all.
  const whole = 2 * 2 * (clip.width - 6 + clip.height - 6);
  await measure(testInfo, { kind: 'curl-ring', corner: `${clip.width}×${clip.height}`, changed: change.changed, towardsRing: change.towards, wholeRing: whole });
  expect(change.towards, `pixels turned to the ring colour, of a whole ring's ${whole}`).toBeGreaterThan(whole * 0.7);
});

test('the skip link reads when it has focus (1.4.3, finding 6)', async ({ page }, testInfo) => {
  await open(page, SHOWCASE);
  await page.keyboard.press(tabKey(browser()));
  const link = page.locator('a.skip');
  await expect(link).toBeFocused();
  await settle(page);
  const colours = await link.evaluate((el) => ({ color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor }));
  const ratio = await inkRange(page, link);
  await measure(testInfo, { kind: 'skip-link', ratio: Math.round(ratio * 100) / 100, ...colours });
  expect(ratio, `the link’s text against its own ground (${colours.color} on ${colours.background})`).toBeGreaterThanOrEqual(4.9);
});

test('Escape in the volume slider puts focus back on the mute key', async ({ page }) => {
  await enter(page);
  await tabTo(page, browser(), '.fb-mute');
  await expect(page.locator('.fb-mute')).not.toHaveAttribute('aria-haspopup', /.*/);
  await tabTo(page, browser(), '.media-volume-slider-thumb');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(page.locator('media-volume-slider')).toBeHidden();
  await expect(page.locator('.fb-mute')).toBeFocused();
});

/** Runs axe over the page in a state and asserts it is clean and checked enough to mean something. */
async function axe(page: Page, state: string, floor: number) {
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const nodesChecked = [...result.passes, ...result.violations, ...result.incomplete].reduce((n, r) => n + r.nodes.length, 0);
  await measure(test.info(), { kind: 'axe', state, nodesChecked, violations: result.violations.length });
  expect(nodesChecked, `axe checked too little in "${state}"`).toBeGreaterThanOrEqual(floor);
  expect(
    result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`),
    `axe, ${state}`,
  ).toEqual([]);
}

test('axe is clean in every state of the player', async ({ page }) => {
  await enter(page);
  await axe(page, 'poster', 60);
  await startAndHold(page, 20);
  await axe(page, 'paused', 100);

  // The contents and the plate are the book's: under essential their keys do nothing (features.spec.ts checks that).
  const pages = [
    ['t', 'fb-contents [role="dialog"]', 'contents'],
    ['?', 'fb-keymap [role="dialog"]', 'shortcuts'],
    ['Shift+C', 'fb-caption-style [role="dialog"]', 'caption style'],
    ['p', '.fb-plate-sheet', 'plate'],
  ] as const;
  for (const [key, open, state] of pages.filter(([, , name]) => !ESSENTIAL || (name !== 'contents' && name !== 'plate'))) {
    await tabTo(page, browser(), 'media-container');
    await page.keyboard.press(key);
    await expect(page.locator(open)).toBeVisible();
    await axe(page, state, 60);
    await page.keyboard.press('Escape');
    await expect(page.locator(open)).toBeHidden();
  }

  await tabTo(page, browser(), '.fb-settings');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu', { name: 'Settings' })).toBeVisible();
  await axe(page, 'settings', 60);
  await page.keyboard.press('Escape');

  await tabTo(page, browser(), '.fb-time-display');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('x');
  await page.keyboard.press('Enter');
  await expect(page.locator('.fb-time [data-x-part="error"]')).not.toBeEmpty();
  await axe(page, 'time error', 60);
  await page.keyboard.press('Escape');

  // The back cover, at the end (the book's: under essential the film simply ends on its replay disc).
  await tabTo(page, browser(), '.media-time-slider-thumb');
  await page.keyboard.press('End');
  if (ESSENTIAL) {
    await expect(page.locator('.fb-cover-play[data-ended]')).toBeVisible({ timeout: 10_000 });
    await axe(page, 'the end, essential', 40);
  } else {
    await expect(page.locator('fb-cover[data-open], .fb-cover[data-open]').first()).toBeVisible({ timeout: 10_000 });
    await axe(page, 'back cover', 40);
  }
});
