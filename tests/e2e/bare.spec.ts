import { type Page } from '@playwright/test';
import { BARE, ESSENTIAL, featured } from './support/player';
import { expect, test } from './support/test';

/**
 * A film and nothing else: no title, poster, chapters, captions or storyboard, as a host may give it
 * (`mountFlipbook(host, { src })`; the bench mounts it with `?film=bare`).
 *
 * The skin is a book of the film's pages, and this film has none to show. Its states are designed, not left over:
 * the parts that are made of pages (the deck under the hand, Contents, the plate and its strip, the corner's next
 * page) are not there at all, never there and empty; the cover has no plate with nothing printed on it; and the film
 * plays, pauses and seeks as any other.
 *
 * Every check reads the running page: what is in sight, real keys, the film's own state.
 */

const FILM = `${BARE}&film=bare`;
const container = (page: Page) => page.locator('media-container');

async function openBare(page: Page) {
  await page.goto(featured(FILM));
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    const player = document.querySelector('media-container');
    const loaded = new Set((player?.getAttribute('data-fb-loaded') ?? '').split(' ').filter(Boolean));
    const wanted = (player?.getAttribute('data-fb-features') ?? '').split(' ').filter((name) => name && name !== 'float');
    return !!video && video.readyState >= 1 && video.duration > 0 && !!player?.hasAttribute('data-fb-features') && wanted.every((name) => loaded.has(name));
  });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

/** Everything in sight inside the player that a viewer could take for a control or a label, with what it says. */
const inSight = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('media-container button, media-container [role="button"], media-container [role="slider"], media-container .fb-jacket-plate, media-container .fb-folio, media-container .fb-strip, media-container fb-tabs button')]
      .filter((el) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && !el.closest('[inert]') && el.getBoundingClientRect().width > 0)
      .map((el) => ({ what: (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' '), cls: el.className, text: (el.textContent ?? '').trim() })),
  );

for (const size of [
  { name: '1280 px', viewport: { width: 1280, height: 800 }, touch: false },
  { name: '390 px', viewport: { width: 390, height: 780 }, touch: true },
]) {
  test.describe(`a film and nothing else, at ${size.name}`, () => {
    test.use({ viewport: size.viewport, hasTouch: size.touch });

    test('at rest and paused, nothing made of pages is there, and nothing in sight is empty', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      await openBare(page);
      if (!ESSENTIAL) await expect(container(page), 'the player knows the film has no pages').toHaveAttribute('data-fb-pageless', '');
      const pageless = async (state: string) => {
        const seen = await inSight(page);
        expect(seen.length, `${state}: the player's controls were looked at`).toBeGreaterThan(0);
        expect(seen.filter((el) => !el.what && !el.text).map((el) => el.cls), `${state}: in sight with nothing to say`).toEqual([]);
        expect(seen.filter((el) => /fb-jacket-plate|fb-strip\b|fb-plate-key|fb-contents-key|fb-tab\b/.test(el.cls)).map((el) => el.cls), `${state}: parts made of pages`).toEqual([]);
        expect(seen.filter((el) => /^(Contents|Plate)\b/.test(el.what)).map((el) => el.what), `${state}: keys to pages`).toEqual([]);
      };
      await pageless('at rest');

      // It plays and pauses like any film.
      await container(page).evaluate((el: HTMLElement) => el.focus({ preventScroll: true }));
      await page.keyboard.press('k');
      await page.waitForFunction(() => (document.querySelector('video') as HTMLVideoElement).currentTime > 1.5);
      await page.keyboard.press('k');
      await expect.poll(() => page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).paused)).toBe(true);
      await expect(container(page)).toHaveAttribute('data-controls-visible', '');
      await pageless('paused');
      await expect(page.locator('fb-plate .fb-strip'), 'no strip of frames under the paused picture').toBeHidden();

      // The keys to pages do nothing, and say nothing false: no plate, no Contents.
      for (const key of ['p', 't']) {
        await page.keyboard.press(key);
        await expect(container(page)).not.toHaveAttribute('data-fb-plate', /.*/);
        await expect(container(page)).not.toHaveAttribute('data-fb-contents', /.*/);
      }
      // And it seeks like any film: the arrows move it five seconds on and back. (One frame at a time is the deck's,
      // a part made of pages: its keys are not on the shortcuts card here, and do nothing.)
      const at = () => page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).currentTime);
      const start = await at();
      await page.keyboard.press('ArrowRight');
      await expect.poll(at).toBeGreaterThan(start + 4);
      await page.keyboard.press('ArrowLeft');
      await expect.poll(at).toBeLessThan(start + 1);
      // (At rest: Safari's paused picture may be asked once more for its frame, a millisecond on, after a seek.)
      await page.waitForTimeout(700);
      const rested = await at();
      await page.keyboard.press('.');
      await page.waitForTimeout(300);
      expect(await at(), 'a frame key, with no deck').toBe(rested);
      expect(errors, 'errors thrown on the page').toEqual([]);
    });
  });
}
