import { type Page, type Route } from '@playwright/test';
import { BARE, ESSENTIAL, SHOWCASE, featured } from './support/player';
import { expect, test } from './support/test';

/**
 * The missing page: the error dialog, in the skin's words, with its way back. It must show every time a film is
 * refused, in whatever order the refusal, the player, the details and the book's extras arrive. Video.js hears of an
 * error only from the film's `error` event: a film refused before the player is listening had none left to give, and
 * the dialog stayed shut (the showcase builds its player off the document, and showed it in 1 load of 8).
 *
 * The orders are made by hand here, so they are the same on every machine: the player's own element is defined only
 * when the test says (so the film is refused first), or the extras' files are held back.
 */

const FILM = /\/media\/film\/film-720(-silent)?\.mp4(\?.*)?$/;
/** The book's extras as they are served: by the dev server as modules, by a build as chunks named for them. */
const EXTRAS = /\/(src\/skins\/flipbook\/extras\/[\w-]+\.ts|assets\/(turns|deck|contents|ribbons|plate|curl|cover|pip|hints|next|float|ear|tear|intertitle|details)-[\w-]+\.js)(\?.*)?$/;
const STORYBOARD = /\/media\/film\/storyboard\.vtt(\?.*)?$/;

const REFUSALS: Record<string, (route: Route) => Promise<void>> = {
  'a 404': (route) => route.fulfill({ status: 404, body: '' }),
  'a 403': (route) => route.fulfill({ status: 403, body: '' }),
  'a refused connection': (route) => route.abort('connectionrefused'),
  'a file that is not a film': (route) => route.fulfill({ status: 200, contentType: 'video/mp4', body: 'not a film' }),
};

/** Holds `<video-player>` undefined until `release()`: its markup and its film are in the page, the player is not. */
async function holdPlayer(page: Page): Promise<() => Promise<void>> {
  await page.addInitScript(() => {
    const define = customElements.define.bind(customElements);
    customElements.define = (name: string, ctor: CustomElementConstructor, options?: ElementDefinitionOptions) => {
      if (name !== 'video-player') return define(name, ctor, options);
      (window as unknown as { __player: () => void }).__player = () => define(name, ctor, options);
    };
  });
  return async () => {
    await page.waitForFunction(() => typeof (window as unknown as { __player?: () => void }).__player === 'function');
    await page.evaluate(() => (window as unknown as { __player: () => void }).__player());
  };
}

const refused = (page: Page) =>
  page.waitForFunction(() => {
    const video = document.querySelector('video');
    return !!video?.error;
  });

const popup = (page: Page) => page.locator('media-error-dialog media-dialog-popup');

/** The dialog as a viewer meets it: drawn, opaque, in the skin's words. */
async function expectMissingPage(page: Page, retry: boolean): Promise<void> {
  const dialog = popup(page);
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate((el) => Number(getComputedStyle(el).opacity)), { message: 'the dialog, opaque' }).toBe(1);
  await expect(dialog.locator('.media-dialog-title')).toHaveText('The film can’t play');
  if (retry) {
    await expect(dialog.locator('.media-dialog-description')).toHaveText(/Try again/);
    await expect(dialog.locator('.fb-error-retry')).toBeVisible();
    await expect(dialog.locator('.fb-error-retry')).toHaveText('Try again');
  } else {
    await expect(dialog.locator('.media-dialog-description')).toHaveText(/Reload the page/);
    await expect(dialog.locator('.fb-error-retry')).toHaveCount(0);
  }
  // Named and described by its own words, for a screen reader.
  await expect(page.getByRole('alertdialog', { name: 'The film can’t play' })).toBeVisible();
}

test.describe('the missing page shows whenever the film is refused', () => {
  for (const [kind, refuse] of Object.entries(REFUSALS)) {
    test(`${kind}, before the player is there to hear it`, async ({ page }) => {
      await page.route(FILM, refuse);
      const release = await holdPlayer(page);
      await page.goto(featured(BARE));
      await refused(page);
      await release();
      await expectMissingPage(page, !ESSENTIAL);
    });

    test(`${kind}, with the player there`, async ({ page }) => {
      await page.route(FILM, refuse);
      await page.goto(featured(BARE));
      await expectMissingPage(page, !ESSENTIAL);
    });
  }

  test('refused before the player: its keys work, a closed dialog stays closed, and Try again brings the film back', async ({ page }) => {
    test.skip(ESSENTIAL, 'the retry is the `states` detail');
    let broken = true;
    await page.route(FILM, (route) => (broken ? route.fulfill({ status: 404, body: '' }) : route.fallback()));
    const release = await holdPlayer(page);
    await page.goto(BARE);
    await refused(page);
    await release();
    await expectMissingPage(page, true);
    // Focus is in the dialog, on a key of it; Escape closes it, and nothing brings it back while the film stays as it is.
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('media-error-dialog'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(popup(page)).toBeHidden();
    await page.waitForTimeout(600);
    await expect(popup(page)).toBeHidden();
    expect(await page.evaluate(() => document.querySelector('video')?.error?.code), 'the film is still refused').toBe(4);

    // A second refusal (the film asked for again) is heard as any error is.
    await page.evaluate(() => document.querySelector('video')?.load());
    await expectMissingPage(page, true);
    // Still refused: the dialog comes back. Then served: the film loads, and the dialog is gone.
    await popup(page).locator('.fb-error-retry').click();
    await expectMissingPage(page, true);
    broken = false;
    await popup(page).locator('.fb-error-retry').click();
    await expect(popup(page)).toBeHidden();
    await expect.poll(() => page.evaluate(() => {
      const video = document.querySelector('video') as HTMLVideoElement;
      return !video.error && video.readyState >= 1 && video.duration > 0;
    })).toBe(true);
  });

  test('refused before the book’s extras have arrived: the words and the retry are there at once, the torn page when its sheet lands', async ({ page }) => {
    test.skip(ESSENTIAL, 'the core alone has no extras to wait for');
    const held: Route[] = [];
    let hold = true;
    await page.route(EXTRAS, (route) => (hold ? void held.push(route) : route.fallback()));
    await page.route(FILM, REFUSALS['a 404']);
    // (Not to `load`: a file held back holds that too.)
    await page.goto(BARE, { waitUntil: 'domcontentloaded' });
    await expectMissingPage(page, true);
    expect(await page.locator('media-container').getAttribute('data-fb-loaded'), 'no extra has arrived').toBeFalsy();
    expect(await popup(page).evaluate((el) => getComputedStyle(el).backgroundImage), 'the plain dialog, until the details’ sheet').toBe('none');
    const size = (await popup(page).locator('.fb-error-retry').boundingBox())!;
    expect(Math.min(size.width, size.height), 'Try again, a whole target already').toBeGreaterThanOrEqual(44);
    hold = false;
    for (const route of held) await route.fallback();
    await expect.poll(() => popup(page).evaluate((el) => getComputedStyle(el).backgroundImage), { message: 'torn at the spine' }).toContain('data:image/svg+xml');
    await expectMissingPage(page, true);
  });

  test('the words follow the `states` detail when it comes after the error, and when it goes', async ({ page }) => {
    test.skip(ESSENTIAL, 'the details are the book’s');
    await page.route(FILM, REFUSALS['a 404']);
    await page.goto(`${BARE}&details=`);
    await page.locator('video-player').evaluate((el) => el.setAttribute('details', ''));
    await expectMissingPage(page, false);
    await page.locator('video-player').evaluate((el) => el.setAttribute('details', 'states'));
    await expectMissingPage(page, true);
    await page.locator('video-player').evaluate((el) => el.setAttribute('details', 'cloth'));
    await expectMissingPage(page, false);
  });

  test('the page’s number is printed on it once the book knows it', async ({ page }) => {
    test.skip(ESSENTIAL, 'the page’s number on the dialog is the `states` detail');
    const held: Route[] = [];
    await page.route(STORYBOARD, (route) => void held.push(route));
    await page.route(FILM, REFUSALS['a 404']);
    await page.goto(BARE, { waitUntil: 'domcontentloaded' });
    await expectMissingPage(page, true);
    expect(await popup(page).getAttribute('data-fb-page'), 'no page yet: the storyboard has not come').toBeFalsy();
    await expect.poll(() => held.length).toBeGreaterThan(0);
    // Everything else the page was going to do with the error has been done by now: the number must come by itself.
    await page.waitForTimeout(800);
    for (const route of held.splice(0)) await route.fallback();
    await expect(popup(page)).toHaveAttribute('data-fb-page', 'p. 1');
    expect(await popup(page).evaluate((el) => getComputedStyle(el, '::before').content)).toContain('p. 1');
  });

  // The showcase builds its player off the document and connects it two tasks later, with the film already asked
  // for: the order the dialog was lost in. Nothing is held here; `--repeat-each=20` runs it as often as wanted.
  test('on the showcase, as it mounts its player, with the film refused at once', async ({ page }) => {
    await page.route(FILM, REFUSALS['a 404']);
    await page.goto(featured(SHOWCASE));
    await expect(page.locator('media-container')).toHaveCount(1);
    await expectMissingPage(page, !ESSENTIAL);
  });
});
