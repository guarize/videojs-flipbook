import { type Page } from '@playwright/test';
import { BARE, featured, media, open, revealControls, startAndHold } from './support/player';
import { expect, test } from './support/test';

/**
 * The film's tracks while its source opens (src/skins/flipbook/sources.ts, `open`).
 *
 * Safari 27 on a real iPhone (iOS 27.2.1, 12 Nov 2026) refuses any source when the film holds a caption or a
 * description track as its address is set; no simulator and no desktop engine shows it. So those tracks step out
 * for the opening and return, each to its place and with its mode, once the film has its metadata: at the first
 * load, at a change of quality, at a failover, at "Try again". What can be held here, in both engines, is that the
 * dance itself is right:
 *
 * - while the film opens, only its `default` tracks are in it; opened, all are back in the order the page gave;
 * - captions are off until someone asks (a track put back is a new track to Chromium, which then shows one by itself);
 * - a C pressed before the film has opened is not lost: the choice waits for the track;
 * - nothing on the bar moves when the tracks come back;
 * - after a change of quality and after a failover the tracks are as they were.
 *
 * (That the film's address is given nowhere else is held by tests/unit/flipbook-sources.test.ts.)
 */

const film = (page: Page) => page.locator('video:not(.fb-stand)');
/** The film's tracks as they stand in it: kind and label, in order. */
const tracks = (page: Page) =>
  film(page).evaluate((video: HTMLVideoElement) => Array.from(video.children).filter((child) => child.localName === 'track').map((track) => `${(track as HTMLTrackElement).kind}:${(track as HTMLTrackElement).label}`));
/** As the bench's page gives them (apps/preview/src/pages/mount.ts). */
const GIVEN = ['chapters:Chapters', 'captions:English', 'descriptions:Audio description', 'metadata:thumbnails'];
const DEFAULTS = ['chapters:Chapters', 'metadata:thumbnails'];
const opened = (page: Page) => film(page).evaluate((video: HTMLVideoElement) => video.readyState >= 1);

/** The tracks that are on, of those that are not `default` (a default chapters track is always "showing"). */
const shown = (page: Page) =>
  film(page).evaluate((video: HTMLVideoElement) => Array.from(video.textTracks).filter((track) => track.mode === 'showing' && track.kind !== 'chapters' && track.kind !== 'metadata').map((track) => track.kind));

/** The film's file answered late, so the page can be looked at while the film is still opening (the page is not waited for: its `load` waits for the film). */
async function slowFilm(page: Page, ms = 2500) {
  await page.route(/\/media\/film\/film-720[^/]*\.mp4/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await route.fallback();
  });
}

test.describe('the film’s tracks while its source opens', () => {
  test('opening, only the default tracks are in the film; opened, all are back in their order, and captions are off until asked for', async ({ page }) => {
    await slowFilm(page);
    await page.goto(featured(BARE), { waitUntil: 'commit' });
    await expect(page.locator('media-container')).toHaveCount(1);
    expect(await opened(page), 'the film is still opening').toBe(false);
    expect(await tracks(page), 'in the film while it opens').toEqual(DEFAULTS);
    await expect.poll(() => opened(page), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => tracks(page), { message: 'in the film once it has opened' }).toEqual(GIVEN);
    // Nobody asked for captions. (Chromium picks a track to show by itself a task after it is added.)
    await page.waitForTimeout(600);
    expect((await media(page)).captions, 'captions, with nobody asking').toBe('disabled');
    expect(await shown(page), 'tracks showing by themselves').toEqual([]);
    // Asked for, they come with their cues: the same track element came back, not an empty one.
    await page.locator('media-container').evaluate((el: HTMLElement) => el.focus({ preventScroll: true }));
    await page.keyboard.press('c');
    await expect.poll(async () => (await media(page)).captions).toBe('showing');
    await expect.poll(() => film(page).evaluate((video: HTMLVideoElement) => Array.from(video.textTracks).find((track) => track.kind === 'captions')?.cues?.length ?? 0), { message: 'cues in the captions track' }).toBeGreaterThan(3);
  });

  test('a C pressed before the film has opened is kept: captions are on when it has', async ({ page }) => {
    await slowFilm(page);
    await page.goto(featured(BARE), { waitUntil: 'commit' });
    await expect(page.locator('fb-captions')).toHaveCount(1);
    await page.locator('media-container').evaluate((el: HTMLElement) => el.focus({ preventScroll: true }));
    expect(await opened(page), 'the film is still opening').toBe(false);
    await page.keyboard.press('c');
    expect(await opened(page), 'and still was when C was pressed').toBe(false);
    await expect.poll(() => opened(page), { timeout: 15_000 }).toBe(true);
    await expect.poll(async () => (await media(page)).captions, { message: 'captions, asked for before the film opened' }).toBe('showing');
    // It is the player's own state too: its key shows captions on, and a second C turns them off.
    await page.waitForTimeout(300);
    expect((await media(page)).captions, 'and they stay on').toBe('showing');
    await page.keyboard.press('c');
    await expect.poll(async () => (await media(page)).captions).toBe('disabled');
  });

  test('two presses before the film has opened cancel out: captions stay off', async ({ page }) => {
    await slowFilm(page);
    await page.goto(featured(BARE), { waitUntil: 'commit' });
    await expect(page.locator('fb-captions')).toHaveCount(1);
    await page.locator('media-container').evaluate((el: HTMLElement) => el.focus({ preventScroll: true }));
    await page.keyboard.press('c');
    await page.keyboard.press('c');
    expect(await opened(page), 'the film was still opening').toBe(false);
    await expect.poll(() => opened(page), { timeout: 15_000 }).toBe(true);
    await page.waitForTimeout(600);
    expect((await media(page)).captions).toBe('disabled');
  });

  test('the captions key keeps its place on the bar while the film opens: nothing beside it moves when the tracks come back', async ({ page }) => {
    await slowFilm(page);
    await page.goto(featured(BARE), { waitUntil: 'commit' });
    await expect(page.locator('fb-edge')).toHaveCount(1);
    // The key's own box, and the room between the keys either side of it. (Not their places on the page: a name set
    // in the fallback face before the type arrives is a pixel or two another width, and that is not the film's doing.)
    const place = () =>
      page.evaluate(() => {
        const key = document.querySelector('.fb-bar .fb-captions') as HTMLElement;
        const drawn = (el: Element | null): el is HTMLElement => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
        let before = key.previousElementSibling;
        while (before && !drawn(before)) before = before.previousElementSibling;
        let after = key.nextElementSibling;
        while (after && !drawn(after)) after = after.nextElementSibling;
        if (!before || !after) return null;
        const box = key.getBoundingClientRect();
        return { between: Math.round((after.getBoundingClientRect().left - before.getBoundingClientRect().right) * 10) / 10, key: [Math.round(box.width), Math.round(box.height)], seen: getComputedStyle(key).visibility === 'visible' };
      });
    await expect.poll(async () => (await place())?.between ?? 0, { message: 'the bar is laid out while the film opens' }).toBeGreaterThan(0);
    expect(await opened(page), 'the film is still opening').toBe(false);
    const before = await place();
    expect(before?.seen, 'while the film opens the key is not shown: it has nothing to turn on').toBe(false);
    await expect.poll(() => opened(page), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => tracks(page)).toEqual(GIVEN);
    await expect.poll(async () => (await place())?.seen, { message: 'the key is shown once the film has its captions' }).toBe(true);
    const after = await place();
    expect(after?.key, 'the key').toEqual([44, 44]);
    expect(before?.key, 'its box while the film opened').toEqual(after?.key);
    expect(before?.between, 'the room between its neighbours, while the film opened and after').toBe(after?.between);
  });

  // The place is kept only where the row has the key. A short player under 720 px has none (Captions is in Settings
  // there), and a place forced on it moved the time and the tabs 46 px when the film opened (the gate, 13 Nov 2026).
  test('on a short player, whose row has no captions key, no place is made for one while the film opens: the time stays where it is', async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 360 });
    await slowFilm(page);
    await page.goto(featured(BARE), { waitUntil: 'commit' });
    await expect(page.locator('fb-edge')).toHaveCount(1);
    await expect(page.locator('media-container')).toHaveAttribute('data-fb-short', '');
    const row = () =>
      page.evaluate(() => ({
        captions: getComputedStyle(document.querySelector('.fb-bar .fb-captions') as Element).display,
        time: Math.round((document.querySelector('.fb-time-display') as Element).getBoundingClientRect().right * 10) / 10,
        settings: Math.round((document.querySelector('.fb-settings') as Element).getBoundingClientRect().left * 10) / 10,
      }));
    expect(await opened(page), 'the film is still opening').toBe(false);
    const before = await row();
    expect(before.captions, 'the captions key while the film opens').toBe('none');
    await expect.poll(() => opened(page), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => tracks(page)).toEqual(GIVEN);
    await page.waitForTimeout(400);
    const after = await row();
    expect(after.captions).toBe('none');
    expect(after.settings - after.time, 'the room between the time and Settings, while the film opened and after').toBe(before.settings - before.time);
  });

  test('after a change of quality the tracks are back as they were, captions still on', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox', 'Firefox plays no stream itself: its film is the page’s next source, a file, and Settings has no Quality');
    await open(page, `${BARE}&source=ladder`);
    await page.locator('media-container').evaluate((el: HTMLElement) => el.focus({ preventScroll: true }));
    await expect(page.locator('.fb-menu-quality')).toHaveAttribute('data-fb-quality', '');
    await startAndHold(page, 20);
    await page.keyboard.press('c');
    await expect.poll(async () => (await media(page)).captions).toBe('showing');
    await revealControls(page);
    await page.locator('.fb-settings').click();
    await page.locator('.fb-menu-quality').click();
    await page.locator('.fb-menu-quality-group media-menu-radio-item[value="180"]').click();
    await expect.poll(() => film(page).evaluate((video: HTMLVideoElement) => video.videoHeight), { timeout: 20_000 }).toBe(180);
    await expect(page.locator('canvas.fb-hold')).toHaveCount(0);
    await expect.poll(() => tracks(page)).toEqual(GIVEN);
    await page.waitForTimeout(400);
    expect((await media(page)).captions, 'captions, on before the change').toBe('showing');
    expect(await shown(page), 'and nothing else came on').toEqual(['captions']);
  });

  test('after a failover to the next source the tracks are in their order, and captions are still off', async ({ page }) => {
    // The showcase's own list: the battery refuses Mux, so the film reaches the file beside the page by itself.
    await open(page, `${BARE}&source=mux`);
    expect(await film(page).evaluate((video: HTMLVideoElement) => new URL(video.currentSrc).pathname)).toMatch(/\/media\/film\/film-720/);
    await expect.poll(() => tracks(page)).toEqual(GIVEN);
    await page.waitForTimeout(600);
    expect((await media(page)).captions).toBe('disabled');
    await page.locator('media-container').evaluate((el: HTMLElement) => el.focus({ preventScroll: true }));
    await page.keyboard.press('c');
    await expect.poll(async () => (await media(page)).captions).toBe('showing');
  });
});

/**
 * The picture-in-picture key's place while the film opens (src/skins/flipbook/skin.css, `.fb-pip`).
 *
 * Video.js says of the key what there is to know: `unavailable` (the browser and the film can, and the film has no
 * metadata yet: the key is still to come), `available`, or `unsupported` (it never will). Its place is kept while it
 * is still to come, by room before the fullscreen key, and let go in the very change that shows it. It was kept by
 * the film's length instead ("Ends at" still empty), which is known at `durationchange`, a moment before the key
 * comes at `loadedmetadata`: a frame drawn between the two had the keys before it 46 px to the right, and the next
 * one back (the showcase's layout shift at 1024 px, 5 loads in 18, 13 Nov 2026).
 */
interface Row {
  /** The left edge of the Settings key (the key before the place) and of the fullscreen key (the key after it), each
   *  time it was somewhere else than on the frame before. */
  settings: number[];
  fullscreen: number[];
  /** The room kept before the fullscreen key, likewise. */
  rooms: string[];
  /** Frames drawn between the film's length being known and its metadata reaching the player. */
  between: number;
}

/**
 * Reads the keys either side of the place on every frame from the moment they have a box, and holds the film's `loadedmetadata` back
 * from the player for three frames: what the player does when the length is known is on the glass before what it
 * does with the metadata, every time, not when a frame happens to fall between them. `bare`: a browser with no
 * picture-in-picture at all.
 */
async function watchRow(page: Page, bare = false) {
  await page.addInitScript((none) => {
    if (none) {
      Object.defineProperty(Document.prototype, 'pictureInPictureEnabled', { configurable: true, get: () => false });
      for (const name of ['requestPictureInPicture', 'webkitSetPresentationMode']) Reflect.deleteProperty(HTMLVideoElement.prototype, name);
    }
    const row = { settings: [] as number[], fullscreen: [] as number[], rooms: [] as string[], between: 0 };
    (window as unknown as { __row: typeof row }).__row = row;
    const joined = new MutationObserver(() => {
      const video = document.querySelector<HTMLVideoElement>('video:not(.fb-stand)');
      const key = document.querySelector<HTMLElement>('.fb-bar .fb-fullscreen');
      const settings = document.querySelector<HTMLElement>('.fb-bar .fb-settings');
      if (!video || !key || !settings) return;
      joined.disconnect();
      let waiting = false;
      video.addEventListener('durationchange', () => { waiting ||= video.duration > 0; }, true);
      video.addEventListener('loadedmetadata', (event) => {
        if (!event.isTrusted) return void (waiting = false);
        event.stopImmediatePropagation();
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => video.dispatchEvent(new Event('loadedmetadata')))));
      }, true);
      const look = () => {
        const box = key.getBoundingClientRect();
        if (box.width > 0) {
          const edges: [number[], number][] = [[row.fullscreen, box.x], [row.settings, settings.getBoundingClientRect().x]];
          for (const [list, x] of edges) if (list[list.length - 1] !== Math.round(x * 10) / 10) list.push(Math.round(x * 10) / 10);
          const room = getComputedStyle(key).marginInlineStart;
          if (row.rooms[row.rooms.length - 1] !== room) row.rooms.push(room);
          if (waiting) row.between++;
        }
        requestAnimationFrame(look);
      };
      requestAnimationFrame(look);
    });
    joined.observe(document, { childList: true, subtree: true });
  }, bare);
}
const rowSeen = (page: Page) => page.evaluate(() => (window as unknown as { __row: Row }).__row);
const pip = (page: Page) => page.locator('.fb-bar .fb-pip');

/** The page with the film answered late, so every part of the player is in before the film opens; then the film, and a second more. */
async function openSlowly(page: Page) {
  await slowFilm(page, 1500);
  await page.goto(featured(BARE), { waitUntil: 'commit' });
  await expect.poll(() => opened(page), { timeout: 15_000 }).toBe(true);
  await page.waitForTimeout(1000);
}

test.describe('the picture-in-picture key’s place while the film opens', () => {
  for (const { width, name, room } of [
    { width: 1024, name: 'a 1024 px player', room: '46px' },
    // (A short player: its keys stand edge to edge in one row, so the place is the key's width with no gap.)
    { width: 600, name: 'a 600 px player, short, its keys in one row', room: '44px' },
  ]) {
    test(`${name}: the keys either side of the place stand still on every frame, through the length being known and the key coming`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await watchRow(page);
      await openSlowly(page);
      await expect(pip(page), 'the key came').toHaveAttribute('data-availability', 'available');
      await expect(pip(page)).toBeVisible();
      const row = await rowSeen(page);
      expect(row.between, 'frames drawn with the length known and the key not yet there').toBeGreaterThanOrEqual(2);
      expect(row.settings, 'where the Settings key’s left edge was, frame by frame').toHaveLength(1);
      expect(row.fullscreen, 'and the fullscreen key’s').toHaveLength(1);
      expect(row.rooms, 'the room before the fullscreen key: kept while the key was to come, none once it had').toEqual([room, '0px']);
    });
  }

  test('a 420 px player, whose row has no such key: no place is kept, and the keys stand still', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 800 });
    await watchRow(page);
    await openSlowly(page);
    await expect(pip(page)).toBeHidden();
    const row = await rowSeen(page);
    expect(row.between).toBeGreaterThanOrEqual(2);
    expect(row.settings, 'where the Settings key’s left edge was, frame by frame').toHaveLength(1);
    expect(row.fullscreen, 'and the fullscreen key’s').toHaveLength(1);
    expect(row.rooms, 'the room before the fullscreen key').toEqual(['0px']);
  });

  test('a browser with no picture-in-picture: no place is kept for a key that never comes', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await watchRow(page, true);
    await openSlowly(page);
    await expect(pip(page)).toHaveAttribute('data-availability', 'unsupported');
    await expect(pip(page)).toBeHidden();
    const row = await rowSeen(page);
    expect(row.settings, 'where the Settings key’s left edge was, frame by frame').toHaveLength(1);
    expect(row.fullscreen, 'and the fullscreen key’s').toHaveLength(1);
    expect(row.rooms, 'the room before the fullscreen key').toEqual(['0px']);
    // It sits against the key before it, the row's own gap apart.
    const apart = await page.evaluate(() => {
      const key = document.querySelector('.fb-bar .fb-fullscreen') as HTMLElement;
      let before = key.previousElementSibling;
      while (before && !(before.getBoundingClientRect().width > 0)) before = before.previousElementSibling;
      return Math.round(key.getBoundingClientRect().left - (before as Element).getBoundingClientRect().right);
    });
    expect(apart, 'px between the fullscreen key and the key before it').toBe(2);
  });
});
