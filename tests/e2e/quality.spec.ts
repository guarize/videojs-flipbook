import { type Page } from '@playwright/test';
import { BARE, FRAME, focusPlayer, media, open, revealControls, skipWithout, startAndHold } from './support/player';
import { expect, test } from './support/test';

/**
 * Quality, in Settings (src/skins/flipbook/quality.ts, renditions.ts).
 *
 * The stream here is the battery's own with two renditions, 360p and 180p (support/stream.mjs), answered as Mux
 * answers a stream asked for one height (build/silent-film.mjs): the page says its address takes the limits
 * (`mux-limits`), as a Mux stream behind a domain of one's own does. Nothing is asked of Mux.
 *
 * - Settings lists Auto and each height the stream offers, read from its playlist; on a film with nothing to choose
 *   the row is not there.
 * - A choice plays the film from the stream at that height, from the same moment, as it was: paused or playing, its
 *   speed, volume and captions. The viewer never sees the film go: the frame is held until the new stream shows it,
 *   and the player is told nothing of the emptiness between.
 * - A height that cannot be loaded gives way to Auto, said once; the film goes on.
 * - The choice is kept for the film.
 *
 * Every check reads the running page: real clicks and keys, the film's own state, the frames the browser names.
 */

const LADDER = `${BARE}&source=ladder`;
/** The stream as Auto asks for it where the pointer can hover: no height chosen, and all this screen can show (fit.spec.ts). */
const AUTO = /ladder\.m3u8\?max_resolution=1080p$/;
const film = (page: Page) => page.locator('video:not(.fb-stand)');
const row = (page: Page) => page.locator('.fb-menu-quality');
const items = (page: Page) => page.locator('.fb-menu-quality-group media-menu-radio-item');
/** The lowest of the fixture's heights. (Not by its text: under Auto, the row of Auto says the height playing too.) */
const low = (page: Page) => page.locator('.fb-menu-quality-group media-menu-radio-item[value="180"]');
/** What the skin says aloud, politely (pages.ts). */
const voice = (page: Page) => page.locator('.fb-voice[role="status"]');

/** Opens the page with someone at the player, and waits for the stream's renditions to be on the Quality page. */
async function openWithQuality(page: Page, path = LADDER) {
  await open(page, path);
  await focusPlayer(page);
  await expect(row(page)).toHaveAttribute('data-fb-quality', '');
}

/** Settings → Quality, by pointer. */
async function toQuality(page: Page) {
  await revealControls(page);
  await page.locator('.fb-settings').click();
  await expect(page.locator('#flipbook-settings')).toBeVisible();
  await row(page).click();
  await expect(items(page).first()).toBeVisible();
}

interface Watched {
  /** Looks at the player, one per frame drawn, while a switch is under way. */
  looks: { started: boolean; covered: boolean; fill: string; held: boolean; time: number; paused: boolean }[];
  /** What a part of the player would have heard of the film going. */
  heard: string[];
  /** The frames of the film that were in sight (seconds), as the browser named them. */
  frames: number[];
  /** The frame the film shows now, in sight or under the held one. */
  last: number | null;
}

/** Watches the player through a switch, from now on: its state every frame, the film's events, its frames. */
async function watch(page: Page) {
  await page.evaluate(() => {
    const video = document.querySelector('video:not(.fb-stand)') as HTMLVideoElement;
    const container = document.querySelector('media-container') as HTMLElement;
    const seen = { looks: [] as unknown[], heard: [] as string[], frames: [] as number[], last: null as number | null };
    (window as unknown as { __quality: typeof seen }).__quality = seen;
    for (const type of ['emptied', 'loadstart', 'abort', 'error']) video.addEventListener(type, () => seen.heard.push(type));
    video.addEventListener('durationchange', () => {
      if (!(video.duration > 0)) seen.heard.push('durationchange to nothing');
    });
    video.addEventListener('timeupdate', () => {
      if (video.readyState === 0) seen.heard.push('timeupdate with nothing loaded');
    });
    // (Under the held frame the film's own frames are not in sight: the new stream opens on its first frame there.)
    const frame = (_now: number, shown: VideoFrameCallbackMetadata) => {
      seen.last = shown.mediaTime;
      if (!container.querySelector('canvas.fb-hold')) seen.frames.push(shown.mediaTime);
      video.requestVideoFrameCallback(frame);
    };
    video.requestVideoFrameCallback(frame);
    const look = () => {
      seen.looks.push({
        started: !!container.querySelector('.fb-play[data-started]'),
        covered: container.matches('[data-fb-cover], [data-fb-jacket]'),
        fill: getComputedStyle(container.querySelector('media-time-slider') as Element).getPropertyValue('--media-slider-fill').trim(),
        held: !!container.querySelector('canvas.fb-hold'),
        time: video.currentTime,
        paused: video.paused,
      });
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
}
const watched = (page: Page): Promise<Watched> => page.evaluate(() => (window as unknown as { __quality: Watched }).__quality);
const height = (page: Page) => film(page).evaluate((video: HTMLVideoElement) => video.videoHeight);
const source = (page: Page) => film(page).evaluate((video: HTMLVideoElement) => video.currentSrc);
/** The switch is over: the film plays from this height, and the held frame has gone. */
async function switched(page: Page, to: number) {
  await expect.poll(() => height(page), { message: 'the height the film plays at', timeout: 20_000 }).toBe(to);
  await expect(page.locator('canvas.fb-hold')).toHaveCount(0);
  await expect(page.locator('media-container')).not.toHaveAttribute('data-fb-switching', /.*/);
}

test.describe('Quality, on a stream with heights to choose from', () => {
  test.skip(({ browserName }) => browserName === 'firefox', 'Firefox plays no stream itself: its film is the page’s next source, a file, and Settings has no Quality');
  test('Settings lists Auto and each height, tallest first, the choice checked and named on the way in', async ({ page }) => {
    await openWithQuality(page);
    await revealControls(page);
    await page.locator('.fb-settings').click();
    await expect(row(page)).toBeVisible();
    await expect(row(page).locator('[data-fb-part="quality"]')).toHaveText('Auto');
    await row(page).click();
    await expect(items(page)).toHaveCount(3);
    expect(await items(page).evaluateAll((all) => all.map((item) => item.getAttribute('aria-label')))).toEqual([expect.stringMatching(/^Auto/), '360p', '180p']);
    expect(await items(page).evaluateAll((all) => all.map((item) => item.querySelector('[data-part="label"]')?.textContent))).toEqual(['Auto', '360p', '180p']);
    await expect(items(page).first()).toHaveAttribute('aria-checked', 'true');
    // Radio items, as Speed's are: one of them checked.
    expect(await items(page).evaluateAll((all) => all.map((item) => item.getAttribute('role')))).toEqual(['menuitemradio', 'menuitemradio', 'menuitemradio']);
    expect(await items(page).evaluateAll((all) => all.map((item) => item.getAttribute('aria-checked')))).toEqual(['true', 'false', 'false']);
    // Video.js's own list (empty, where the browser plays the stream itself) is not shown beside it.
    await expect(page.locator('media-quality-radio-group')).toBeHidden();
    // Each row is a target.
    for (const box of await items(page).evaluateAll((all) => all.map((item) => item.getBoundingClientRect().height))) expect(box).toBeGreaterThanOrEqual(44);
  });

  test('by keys alone: into Quality, a height chosen, Escape back to its row and then to the Settings key', async ({ page }) => {
    await openWithQuality(page);
    await startAndHold(page, 20);
    await revealControls(page);
    await page.locator('.fb-settings').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#flipbook-settings')).toBeVisible();
    for (let i = 0; i < 8 && !(await page.evaluate(() => !!document.activeElement?.matches('.fb-menu-quality'))); i++) await page.keyboard.press('ArrowDown');
    await expect(row(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(items(page).first()).toBeVisible();
    // Down to the last height, and chosen.
    for (let i = 0; i < 4 && !(await page.evaluate(() => document.activeElement?.getAttribute('value') === '180')); i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await switched(page, 180);
    await expect(items(page).last()).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    await expect(row(page)).toBeFocused();
    await expect(row(page).locator('[data-fb-part="quality"]')).toHaveText('180p');
    await page.keyboard.press('Escape');
    await expect(page.locator('#flipbook-settings')).toBeHidden();
    await expect(page.locator('.fb-settings')).toBeFocused();
  });

  test('paused: the film is loaded at that height on the same frame, as it was, and the viewer never sees it go', async ({ page }) => {
    await openWithQuality(page);
    await startAndHold(page, 20);
    // As it was: captions on, a speed and a volume of the viewer's.
    await page.keyboard.press('c');
    await film(page).evaluate((video: HTMLVideoElement) => {
      video.playbackRate = 1.5;
      video.volume = 0.4;
    });
    await expect.poll(async () => (await media(page)).captions).toBe('showing');
    const before = await media(page);
    await watch(page);
    await toQuality(page);
    await low(page).click();
    await switched(page, 180);

    expect(await source(page), 'the stream, asked for that height').toMatch(/ladder\.m3u8\?min_resolution=180p&max_resolution=180p$/);
    const after = await media(page);
    expect(after.time, 'the same moment').toBeCloseTo(before.time, 2);
    expect({ ...after, time: 0 }, 'paused, its speed, its volume, its captions').toEqual({ ...before, time: 0 });
    const { looks, heard, last } = await watched(page);
    expect(heard, 'what the player heard of the film going').toEqual([]);
    expect(looks.length, 'looks at the player').toBeGreaterThan(5);
    expect(looks.some((look) => look.held), 'the frame was held over the film').toBe(true);
    expect(looks.filter((look) => !look.started || look.covered), 'never back to the cover, never unbegun').toEqual([]);
    // (Two renditions of one film may differ in length by a frame: the ribbon may move by that, a hundredth of a per cent.)
    const fills = looks.map((look) => Number.parseFloat(look.fill));
    expect(Math.max(...fills) - Math.min(...fills), `the ribbon stood where it was: ${[...new Set(looks.map((look) => look.fill))].join(', ')}`).toBeLessThan(0.05);
    expect(looks.filter((look) => Math.abs(look.time - before.time) > 0.05).map((look) => look.time), 'the clock never read another moment').toEqual([]);
    // The new stream shows the frame the old one did.
    expect(last, 'the new stream named the frame it shows').not.toBeNull();
    expect(before.time - (last as number), 'the frame on screen holds the moment').toBeGreaterThan(-0.001);
    expect(before.time - (last as number)).toBeLessThan(FRAME + 0.001);
    // Said, and named on the way in.
    await expect(voice(page)).toHaveText('Quality: 180p');
    await expect(row(page).locator('[data-fb-part="quality"]')).toHaveText('180p');
  });

  test('playing: it goes on playing from the same moment, and the picture never goes back', async ({ page }) => {
    await openWithQuality(page);
    await startAndHold(page, 20);
    await page.keyboard.press('k');
    await expect.poll(async () => (await media(page)).time).toBeGreaterThan(20.5);
    await watch(page);
    const at = (await media(page)).time;
    await toQuality(page);
    await low(page).click();
    await switched(page, 180);
    await expect.poll(async () => (await media(page)).time, 'it plays on').toBeGreaterThan(at + 1);
    const { looks, heard, frames } = await watched(page);
    expect((await media(page)).paused).toBe(false);
    expect(heard).toEqual([]);
    expect(looks.filter((look) => !look.started || look.covered)).toEqual([]);
    expect(looks.filter((look) => look.time < at - 0.05).map((look) => look.time), 'the clock never read an earlier moment').toEqual([]);
    const back = frames.filter((time, i) => i > 0 && time < frames[i - 1] - 0.001);
    expect(back, 'frames shown earlier than the one before').toEqual([]);
  });

  test('a height that cannot be loaded gives way to Auto, said once; the film stays where it was', async ({ page }) => {
    await page.route(/ladder\.m3u8\?.*min_resolution=180p/, (route) => route.abort());
    await openWithQuality(page);
    await startAndHold(page, 20);
    const before = await media(page);
    await watch(page);
    await toQuality(page);
    await low(page).click();
    await expect(voice(page)).toHaveText('180p couldn’t be loaded. Playing on Auto.', { timeout: 20_000 });
    await expect(items(page).first()).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('canvas.fb-hold')).toHaveCount(0);
    expect(await source(page), 'the stream on Auto: no height chosen').toMatch(AUTO);
    const after = await media(page);
    expect(after.time).toBeCloseTo(before.time, 2);
    expect(after.paused).toBe(true);
    // Nobody is shown an error: the film has not failed.
    await expect(page.locator('media-error-dialog media-dialog-popup')).toBeHidden();
    const { looks, heard } = await watched(page);
    expect(heard.filter((type) => type !== 'error'), 'what the player heard of the film going').toEqual([]);
    expect(looks.filter((look) => !look.started || look.covered)).toEqual([]);
    expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('fb-quality'))), 'a height that failed is not kept').toEqual([]);
  });

  test('the choice is kept for the film: there on the next visit, gone when Auto is chosen', async ({ page }) => {
    await openWithQuality(page);
    await startAndHold(page, 20);
    await toQuality(page);
    await low(page).click();
    await switched(page, 180);
    expect(await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('fb-quality')))).toEqual([['fb-quality:/media/stream/ladder.m3u8', '180']]);

    await page.reload();
    await expect(row(page), 'the page is there without anyone at the player: the choice was theirs').toHaveAttribute('data-fb-quality', '');
    await expect.poll(() => source(page)).toMatch(/min_resolution=180p&max_resolution=180p$/);
    await focusPlayer(page);
    await startAndHold(page, 20);
    expect(await height(page)).toBe(180);
    await toQuality(page);
    await expect(items(page).last()).toHaveAttribute('aria-checked', 'true');
    await items(page).first().click();
    await expect.poll(() => source(page), { timeout: 20_000 }).toMatch(AUTO);
    await expect(page.locator('canvas.fb-hold')).toHaveCount(0);
    await expect(voice(page)).toHaveText('Quality: Auto');
    expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('fb-quality')))).toEqual([]);
    // Under Auto, the height playing (the browser's own choice) is beside it.
    await expect.poll(() => height(page)).toBeGreaterThan(0);
    await expect(items(page).first().locator('[data-part="badge"]')).toHaveText(`${await height(page)}p`);
  });

  test('a choice kept for a height the film no longer has is dropped: Auto', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('fb-quality:/media/stream/ladder.m3u8', '1080'));
    await open(page, LADDER);
    await expect(row(page)).toHaveAttribute('data-fb-quality', '');
    await expect(row(page).locator('[data-fb-part="quality"]')).toHaveText('Auto');
    expect(await source(page)).toMatch(AUTO);
  });

  test('the paused page’s strip reads the stream no taller than it needs, whatever height is watched', async ({ page }) => {
    skipWithout(test, 'plate');
    const asked: string[] = [];
    page.on('request', (request) => {
      if (/ladder\.m3u8/.test(request.url())) asked.push(request.url().split('/').pop() as string);
    });
    await page.addInitScript(() => localStorage.setItem('fb-quality:/media/stream/ladder.m3u8', '360'));
    await open(page, `${LADDER}&scrub=none`);
    await focusPlayer(page);
    await startAndHold(page, 30.5);
    await expect(page.locator('.fb-strip-cell[data-ready]:not([data-still])')).toHaveCount(12, { timeout: 20_000 });
    expect(asked, 'the strip’s own reading of the stream').toContain('ladder.m3u8?max_resolution=720p');
  });
});

test.describe('Quality, on a phone', () => {
  test.skip(({ browserName }) => browserName === 'firefox', 'Firefox plays no stream itself: its film is the page’s next source, a file, and Settings has no Quality');
  test.use({ viewport: { width: 390, height: 780 }, hasTouch: true });

  test('the sheet has the row and its page, each height a 44 px target, and a tap chooses', async ({ page }) => {
    await openWithQuality(page);
    await startAndHold(page, 20);
    await page.locator('.fb-settings').tap();
    await expect(row(page)).toBeVisible();
    await row(page).tap();
    await expect(items(page)).toHaveCount(3);
    for (const box of await items(page).evaluateAll((all) => all.map((item) => item.getBoundingClientRect().height))) expect(box).toBeGreaterThanOrEqual(44);
    await low(page).tap();
    await switched(page, 180);
    await expect(items(page).last()).toHaveAttribute('aria-checked', 'true');
  });
});

test.describe('Quality, with nothing to choose', () => {
  test.skip(({ browserName }) => browserName === 'firefox', 'Firefox plays no stream itself: its film is the page’s next source, a file, and Settings has no Quality');
  for (const [name, path] of [
    ['a file', BARE],
    ['a stream of one rendition', `${BARE}&source=stream`],
  ] as const) {
    test(`${name}: the row is not in Settings at all`, async ({ page }) => {
      await open(page, path);
      await focusPlayer(page);
      await startAndHold(page, 5);
      await revealControls(page);
      await page.locator('.fb-settings').click();
      await expect(page.locator('#flipbook-settings')).toBeVisible();
      await expect(row(page)).toBeHidden();
      await expect(row(page)).not.toHaveAttribute('data-fb-quality', /.*/);
    });
  }
});
