import { type Page } from '@playwright/test';
import { BARE, ESSENTIAL, open, revealControls } from './support/player';
import { expect, test } from './support/test';

/**
 * The page sound (src/skins/flipbook/sound.ts, flutter.ts, menu.ts): on until the viewer turns it off in Settings,
 * kept in this browser, said when it changes; a page may take it away (`data-fb-flutter="off"`). No automated browser
 * ever sounds (flutter.ts, and the battery's silenced contexts), so what is checked is the choice, as the page holds it.
 */

const item = (page: Page) => page.locator('[data-fb-menu="sound"]');

async function settings(page: Page) {
  await revealControls(page);
  await page.locator('#flipbook-settings-trigger').click();
  await expect(page.locator('media-menu.media-menu-popup[data-open]')).toHaveCount(1);
}

test.describe('Page sound', () => {
  test.skip(ESSENTIAL, 'the book’s deck makes the sound');

  test('is on by default; Settings turns it off, says so, and it is kept across a reload', async ({ page }) => {
    await open(page, BARE);
    expect(await page.evaluate(() => localStorage.getItem('fb-page-sound'))).toBeNull();
    await settings(page);
    await expect(item(page)).toBeVisible();
    await expect(item(page)).toHaveText(/Page sound/);
    await expect(item(page)).toHaveAttribute('aria-checked', 'true');
    await expect(item(page)).toHaveAttribute('role', 'menuitemcheckbox');
    // A row like the others: as tall as "Keep this page" above it. (Their laid-out heights, read together: the menu
    // is still growing into place, and two boxes read a moment apart are two sizes.)
    const heights = await page.evaluate(() => ['sound', 'keep'].map((name) => (document.querySelector(`[data-fb-menu="${name}"]`) as HTMLElement).offsetHeight));
    expect(heights[0], 'the row’s height').toBeGreaterThanOrEqual(44);
    expect(heights[0], 'as tall as the row above it').toBe(heights[1]);
    await item(page).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('fb-page-sound'))).toBe('off');
    await expect(page.locator('media-container > .fb-voice').filter({ hasText: 'Page sound off' })).toHaveCount(1);
    await page.reload();
    await open(page, BARE);
    await settings(page);
    await expect(item(page)).toHaveAttribute('aria-checked', 'false');
    await item(page).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('fb-page-sound'))).toBe('on');
    await expect(page.locator('media-container > .fb-voice').filter({ hasText: 'Page sound on' })).toHaveCount(1);
  });

  test('a page that takes the sound away has no setting for it', async ({ page }) => {
    await open(page, BARE);
    // On the player's element, as a page would write it; the Settings rows are read again when the book's features are.
    await page.evaluate(() => {
      const container = document.querySelector('media-container') as HTMLElement;
      (container.closest('video-player') ?? container).setAttribute('data-fb-flutter', 'off');
      container.dispatchEvent(new CustomEvent('fb-features'));
    });
    await settings(page);
    await expect(page.locator('[data-fb-menu="keep"]')).toBeVisible();
    await expect(item(page)).toBeHidden();
  });
});

test('Essential has no Page sound: nothing there makes one', async ({ page }) => {
  await open(page, `${BARE}&features=essential`);
  await revealControls(page);
  await page.locator('#flipbook-settings-trigger').click();
  await expect(page.locator('media-menu.media-menu-popup[data-open]')).toHaveCount(1);
  await expect(item(page)).toBeHidden();
});
