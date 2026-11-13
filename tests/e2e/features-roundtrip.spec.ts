import { type Page } from '@playwright/test';
import { open, revealControls, SHOWCASE } from './support/player';
import { expect, test } from './support/test';

/**
 * The features switch, both ways and back: Full → Essential → Full, and Essential → Full. Each leaves the player as a
 * fresh load at the same playback state leaves it (the cover if nothing has played, the open book at the current time
 * otherwise), and every extra works again, driven by real key presses and pointer moves on the showcase's own switch.
 */

const container = (page: Page) => page.locator('media-container');
const video = (page: Page) => page.evaluate(() => {
  const v = document.querySelector('video') as HTMLVideoElement;
  return { time: v.currentTime, paused: v.paused };
});

/** The player's state as its own attributes and parts say it: what a fresh load at rest is compared against. */
const fingerprint = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector('media-container')!;
    const attributes = [...c.attributes]
      .map((a) => a.name)
      .filter((name) => name.startsWith('data-fb-') && !['data-fb-loaded', 'data-fb-caption-over'].includes(name))
      .sort();
    const parts = [...c.querySelectorAll('fb-turn, fb-riffle, fb-deck, fb-flip, fb-curl, fb-jacket, fb-scan, fb-cover, fb-plate, fb-contents, fb-ribbons, fb-hints, fb-next, fb-pip, [data-fb-action]')]
      .map((el) => el.tagName.toLowerCase() + (el.getAttribute('data-fb-action') ? `[${el.getAttribute('data-fb-action')}]` : ''))
      .sort();
    const disc = document.querySelector<HTMLElement>('.fb-cover-play');
    return { attributes, parts, discPlaced: !!disc?.style.top };
  });

async function choose(page: Page, value: 'essential' | 'book') {
  await page.locator(`#features [data-value="${value}"]`).click();
  await expect(container(page)).toHaveAttribute('data-fb-features', value === 'book' ? /turns deck contents/ : '');
  // Every extra that is on has arrived, whichever the book has today (the list is the player's own).
  if (value === 'book') {
    await expect
      .poll(() =>
        container(page).evaluate((el) => {
          const loaded = new Set((el.getAttribute('data-fb-loaded') ?? '').split(' '));
          return (el.getAttribute('data-fb-features') ?? '').split(' ').filter((name) => !loaded.has(name));
        }),
      )
      .toEqual([]);
  }
  // Each extra that came back has settled (its book read, its first update run).
  await page.waitForTimeout(400);
}

async function edgePoint(page: Page, share: number) {
  const box = await page.locator('media-time-slider').boundingBox();
  if (!box) throw new Error('no fore-edge');
  return { x: box.x + box.width * share, y: box.y + box.height / 2 };
}

/** Every extra, by hand: the deck by hover and drag, T, B, P and the corner while paused, and the book's PiP window. */
async function exercise(page: Page, browserName: string) {
  await revealControls(page);
  // Hover the edge: the deck opens; press and drag along it: the deck closes and the film itself moves (flip.ts).
  const a = await edgePoint(page, 0.3);
  await page.mouse.move(a.x, a.y);
  await page.mouse.move(a.x + 4, a.y, { steps: 2 });
  await expect(container(page)).toHaveAttribute('data-fb-deck', 'open');
  await page.mouse.down();
  const b = await edgePoint(page, 0.55);
  await page.mouse.move(b.x, b.y, { steps: 10 });
  await expect(page.locator('fb-flip')).toHaveAttribute('data-mode', 'drag');
  await expect(container(page)).toHaveAttribute('data-fb-deck', 'flip');
  // Held still before letting go, so it lands rather than being thrown.
  await page.waitForTimeout(400);
  await page.mouse.up();
  await expect(container(page)).not.toHaveAttribute('data-fb-deck', /.*/, { timeout: 4000 });
  // Away from the edge, so the deck stays shut.
  const box = await container(page).boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height * 0.3);

  await container(page).focus();
  await page.keyboard.press('t');
  await expect(container(page)).toHaveAttribute('data-fb-contents', '');
  await page.keyboard.press('Escape');
  await expect(container(page)).not.toHaveAttribute('data-fb-contents', /.*/);

  await page.keyboard.press('b');
  await expect(page.locator('.fb-ribbon')).toHaveCount(1);
  await page.locator('.fb-ribbon').focus();
  await page.keyboard.press('Delete');
  await expect(page.locator('.fb-ribbon')).toHaveCount(0);

  // Paused mid-film (by K, a real key): the corner lifts on the next chapter; P lays the plate out. 1 goes to 10 %,
  // in the first chapter, so there is a next one.
  await container(page).focus();
  await page.keyboard.press('1');
  if ((await video(page)).paused) {
    await page.keyboard.press('k');
    await page.waitForFunction(() => !(document.querySelector('video') as HTMLVideoElement).paused);
  }
  await page.waitForFunction(() => (document.querySelector('video') as HTMLVideoElement).currentTime > 0.4);
  await page.keyboard.press('k');
  await page.waitForFunction(() => (document.querySelector('video') as HTMLVideoElement).paused);
  await expect(page.locator('fb-curl')).toHaveAttribute('data-open', '');
  // The plate may lay itself out after a pause made by hand; P puts it away or lays it out: either way, P works.
  await page.waitForTimeout(1300);
  if (!(await page.locator('.fb-plate-sheet').isVisible())) await page.keyboard.press('p');
  await expect(page.locator('.fb-plate-sheet')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.fb-plate-sheet')).toBeHidden();

  // The next-chapter prompt is the book's again (this film's chapters are all under its 30 s threshold, so it never
  // opens here: its element is back and live).
  await expect(page.locator('fb-next .fb-next-button')).toHaveCount(1);

  // The PiP key opens the book's own window, where the browser has one; bring it back.
  if (browserName === 'chromium' && (await page.evaluate(() => 'documentPictureInPicture' in window))) {
    await revealControls(page);
    await page.locator('media-pip-button').click();
    await expect(page.locator('.fb-pip-page')).toBeVisible();
    await page.locator('.fb-pip-back').click();
    await expect(page.locator('media-container')).toHaveCount(1);
  }
}

test.describe('the features switch, there and back', () => {
  test('Full → Essential → Full before anything has played: the cover is back, as on a fresh load, and every extra works', async ({ page, browserName }) => {
    await open(page, `${SHOWCASE}?features=book`);
    const fresh = await fingerprint(page);
    expect(fresh.attributes).toContain('data-fb-jacket');

    await choose(page, 'essential');
    const plain = await fingerprint(page);
    // Nothing of the book left on the player: the same as a fresh essential load.
    const page2 = await page.context().newPage();
    await open(page2, `${SHOWCASE}?features=essential`);
    expect(plain, 'the same as a fresh essential load').toEqual(await fingerprint(page2));
    await page2.close();
    expect(plain.discPlaced, 'the disc sits in the middle of a plain poster').toBe(false);

    await choose(page, 'book');
    expect(await fingerprint(page), 'the same as a fresh load').toEqual(fresh);
    await exercise(page, browserName);
  });

  test('Essential → Full: the same player as a fresh full load, and every extra works', async ({ page, browserName }) => {
    await open(page, `${SHOWCASE}?features=book`);
    const fresh = await fingerprint(page);
    await open(page, `${SHOWCASE}?features=essential`);
    await choose(page, 'book');
    expect(await fingerprint(page), 'the same as a fresh load').toEqual(fresh);
    await exercise(page, browserName);
  });

  test('mid-film, Full → Essential → Full: the open book at the same moment, no cover, and every extra works', async ({ page, browserName }) => {
    await open(page, `${SHOWCASE}?features=book`);
    await container(page).focus();
    await page.keyboard.press('k');
    await page.waitForFunction(() => (document.querySelector('video') as HTMLVideoElement).currentTime > 1.5);
    await page.keyboard.press('k');
    const before = await video(page);
    await choose(page, 'essential');
    await choose(page, 'book');
    const after = await video(page);
    expect(Math.abs(after.time - before.time), 'the film stays where it was').toBeLessThan(0.05);
    const state = await fingerprint(page);
    expect(state.attributes).not.toContain('data-fb-jacket');
    expect(state.attributes).not.toContain('data-fb-cover');
    await exercise(page, browserName);
  });
});
