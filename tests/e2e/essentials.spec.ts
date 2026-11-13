import { type Page } from '@playwright/test';
import { BARE, CHAPTERS, DURATION, focused, media, open, recordFullscreen, revealControls, skipWithout, startAndHold, tabKey, tabTo } from './support/player';
import { expect, test } from './support/test';

/**
 * The challenge's minimum controls, each driven the two ways a viewer drives it: real key presses (reaching the
 * control with Tab, never .focus()) and the pointer. Every assertion reads the media element or the page's own state.
 */

const near = (actual: number, expected: number, within = 0.35) => Math.abs(actual - expected) <= within;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(recordFullscreen);
  await open(page, BARE);
  // Into the player with the keyboard: the container is the first stop on the bare page.
  await tabTo(page, test.info().project.name === 'webkit' ? 'webkit' : 'chromium', 'media-container');
});

const browser = () => test.info().project.name;

test('play and pause: Enter and Space on the play key, and a click', async ({ page }) => {
  // The poster's large play key is the pointer's; the keyboard's is the bar's (a11y finding 24).
  await tabTo(page, browser(), '.fb-play');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await media(page)).paused).toBe(false);

  await page.keyboard.press('Space');
  await expect.poll(async () => (await media(page)).paused).toBe(true);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await media(page)).paused).toBe(false);

  await revealControls(page);
  await page.locator('.fb-play').click();
  await expect.poll(async () => (await media(page)).paused).toBe(true);
  await page.locator('.fb-play').click();
  await expect.poll(async () => (await media(page)).paused).toBe(false);
});

test('seek on the fore-edge: arrows, Home and End, Page Up and Down between chapters, and a click', async ({ page }) => {
  await tabTo(page, browser(), '.media-time-slider-thumb');
  await expect(page.locator('.media-time-slider-thumb')).toHaveAttribute('role', 'slider');

  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await media(page)).time).toBeGreaterThan(0.5);
  const afterRight = (await media(page)).time;
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await media(page)).time).toBeLessThan(afterRight);

  // Page Down: the next chapter's first frame, twice; Page Up: back one.
  await page.keyboard.press('Home');
  await expect.poll(async () => (await media(page)).time).toBe(0);
  await page.keyboard.press('PageDown');
  await expect.poll(async () => near((await media(page)).time, CHAPTERS[1], 0.1)).toBe(true);
  await page.keyboard.press('PageDown');
  await expect.poll(async () => near((await media(page)).time, CHAPTERS[2], 0.1)).toBe(true);
  await page.keyboard.press('PageUp');
  await expect.poll(async () => near((await media(page)).time, CHAPTERS[1], 0.1)).toBe(true);

  await page.keyboard.press('End');
  await expect.poll(async () => near((await media(page)).time, DURATION, 0.2)).toBe(true);
  await page.keyboard.press('Home');
  await expect.poll(async () => (await media(page)).time).toBe(0);

  // A click at the middle of the fore-edge lands in the middle of the film.
  await revealControls(page);
  const edge = await page.locator('media-time-slider').boundingBox();
  if (!edge) throw new Error('no fore-edge');
  await page.mouse.click(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await expect.poll(async () => near((await media(page)).time, DURATION / 2, 1.5)).toBe(true);
});

test('the time display shows where the playhead is, and takes a time typed in', async ({ page }) => {
  const display = page.locator('.fb-time-display');
  await expect(display).toHaveText(/^0:00 \/ 1:38$/);
  await tabTo(page, browser(), '.media-time-slider-thumb');
  await page.keyboard.press('PageDown');
  await expect(display).toHaveText(/^0:12 \/ 1:38$/);

  // Enter on the display opens a field: type a time, Enter goes there.
  await tabTo(page, browser(), '.fb-time-display');
  await page.keyboard.press('Enter');
  await expect(page.locator('.fb-time-field')).toBeFocused();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('0:30');
  await page.keyboard.press('Enter');
  await expect.poll(async () => near((await media(page)).time, 30, 0.2)).toBe(true);
  await expect(display).toHaveText(/^0:30 \/ 1:38$/);
});

test('volume and mute: the mute key, the volume slider by arrows, and the pointer', async ({ page }) => {
  await tabTo(page, browser(), '.fb-mute');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await media(page)).muted).toBe(true);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await media(page)).muted).toBe(false);

  await tabTo(page, browser(), '.media-volume-slider-thumb');
  await expect(page.locator('.media-volume-slider-thumb')).toHaveAttribute('role', 'slider');
  const before = (await media(page)).volume;
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await media(page)).volume).toBeLessThan(before);

  // Escape puts the slider away and hands focus back to the mute key it opened from.
  await page.keyboard.press('Escape');
  await expect(page.locator('media-volume-slider')).toBeHidden();
  await expect(page.locator('.fb-mute'), `focus after Escape: ${JSON.stringify(await focused(page))}`).toBeFocused();

  // Pointer: the slider opens on hover over the mute key; a click a quarter of the way up sets about a quarter.
  await revealControls(page);
  const mute = await page.locator('.fb-mute').boundingBox();
  if (!mute) throw new Error('no mute key');
  await page.mouse.move(mute.x + mute.width / 2, mute.y + mute.height / 2, { steps: 5 });
  const slider = page.locator('media-volume-slider');
  await expect(slider).toBeVisible();
  const box = await slider.boundingBox();
  if (!box) throw new Error('no volume slider');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.75);
  await expect.poll(async () => (await media(page)).volume).toBeLessThan(0.45);
  await page.locator('.fb-mute').click();
  await expect.poll(async () => (await media(page)).muted).toBe(true);
});

test('fullscreen is requested by the key, the F hotkey and a click', async ({ page }) => {
  const calls = () => page.evaluate(() => (window as unknown as { __fullscreen: string[] }).__fullscreen.slice());
  await tabTo(page, browser(), '.fb-fullscreen');
  await expect(page.locator('.fb-fullscreen')).toHaveAttribute('aria-label', 'Enter fullscreen');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await calls()).length).toBe(1);
  // The whole player goes fullscreen (its controls with it), not the bare video.
  const target = (await calls())[0];
  expect(target === 'requestFullscreen:media-container' || target === 'webkitRequestFullscreen:media-container' || target.startsWith('webkitSetPresentationMode'), target).toBe(true);

  await page.keyboard.press('f');
  await expect.poll(async () => (await calls()).length).toBe(2);

  await revealControls(page);
  await page.locator('.fb-fullscreen').click();
  await expect.poll(async () => (await calls()).length).toBe(3);
});

test('captions: the key, the C hotkey and a click turn the English track on and off', async ({ page }) => {
  const key = page.locator('.fb-captions');
  await tabTo(page, browser(), '.fb-captions');
  await expect(key).toHaveAttribute('aria-label', 'Enable captions');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await media(page)).captions).toBe('showing');
  await expect(key).toHaveAttribute('aria-label', 'Disable captions');
  await page.keyboard.press('c');
  await expect.poll(async () => (await media(page)).captions).not.toBe('showing');

  await revealControls(page);
  await key.click();
  await expect.poll(async () => (await media(page)).captions).toBe('showing');
  // The caption is drawn by the skin over the picture: first the music, later the first sentence.
  await startAndHold(page, 1.0);
  await expect(page.locator('.fb-captions-line').first()).toHaveText(/Origami/);
  await startAndHold(page, 28);
  await expect(page.locator('.fb-captions-line').first()).toHaveText(/Palo Alto, 19 June 1878/);
});

/** The id selector of the one visible element among several (the keys sit on top or in the bar, by width). */
const visible = (page: Page, selector: string) =>
  page.evaluate((s) => {
    const el = [...document.querySelectorAll(s)].find((e) => e.checkVisibility({ visibilityProperty: true, opacityProperty: true }));
    if (!el?.id) throw new Error(`no visible ${s}`);
    return `#${el.id}`;
  }, selector);

/** Opens with `open`, checks what opened, closes with Escape and checks focus went back to `opener`. */
async function roundTrip(page: Page, opener: string, openWith: () => Promise<void>, panel: string) {
  await tabTo(page, browser(), opener);
  await openWith();
  await expect(page.locator(panel)).toBeVisible();
  await expect.poll(() => page.evaluate((p) => !!document.activeElement?.closest(p), panel), 'focus moved into the panel').toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator(panel)).toBeHidden();
  await expect.poll(() => page.evaluate((o) => !!document.activeElement?.matches(o), opener), `focus back on ${opener}: ${JSON.stringify(await focused(page))}`).toBe(true);
}

test('settings menu: opens on Enter, Speed changes the rate, Escape closes it on its key', async ({ page }) => {
  await roundTrip(page, '.fb-settings', () => page.keyboard.press('Enter'), '#flipbook-settings');

  // Into Speed and pick a rate, by keys alone.
  await page.keyboard.press('Enter');
  await expect(page.locator('#flipbook-settings')).toBeVisible();
  for (let i = 0; i < 6 && !(await page.evaluate(() => /Speed/.test(document.activeElement?.textContent ?? ''))); i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('#flipbook-speed')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await media(page)).rate).not.toBe(1);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.locator('#flipbook-settings')).toBeHidden();
  await expect(page.locator('.fb-settings')).toBeFocused();

  // The speed key cycles the rate by pointer.
  await revealControls(page);
  const rate = (await media(page)).rate;
  await page.locator('.fb-rate').click();
  await expect.poll(async () => (await media(page)).rate).not.toBe(rate);

  // And the menu opens by pointer too.
  await page.locator('.fb-settings').click();
  await expect(page.locator('#flipbook-settings')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#flipbook-settings')).toBeHidden();
});

test('caption style: the key and Shift+C open the card, Escape returns focus', async ({ page }) => {
  await roundTrip(page, await visible(page, '.fb-captype-key'), () => page.keyboard.press('Enter'), 'fb-caption-style [role="dialog"]');
  await roundTrip(page, await visible(page, '.fb-captype-key'), () => page.keyboard.press('Shift+C'), 'fb-caption-style [role="dialog"]');
  await revealControls(page);
  await page.locator(await visible(page, '.fb-captype-key')).click();
  await expect(page.locator('fb-caption-style [role="dialog"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('fb-caption-style [role="dialog"]')).toBeHidden();
});

test('contents: the key and T open the page, Escape returns focus', async ({ page }) => {
  skipWithout(test, 'contents');
  await roundTrip(page, await visible(page, '.fb-contents-key'), () => page.keyboard.press('Enter'), '.fb-contents-page');
  await roundTrip(page, await visible(page, '.fb-contents-key'), () => page.keyboard.press('t'), '.fb-contents-page');
  await revealControls(page);
  await page.locator(await visible(page, '.fb-contents-key')).click();
  await expect(page.locator('.fb-contents-page')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.fb-contents-page')).toBeHidden();
});

test('shortcuts card: ? opens it from any control, Escape returns focus there', async ({ page }) => {
  await roundTrip(page, '.fb-captions', () => page.keyboard.press('?'), 'fb-keymap [role="dialog"]');
  await roundTrip(page, '.fb-play', () => page.keyboard.press('?'), 'fb-keymap [role="dialog"]');
});

test('the plate: P lays it out when paused, Escape puts it away and returns focus', async ({ page }) => {
  skipWithout(test, 'plate');
  await startAndHold(page, 20);
  await roundTrip(page, '.fb-play', () => page.keyboard.press('p'), '.fb-plate-sheet');
});
