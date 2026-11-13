import { type Page } from '@playwright/test';
import { BARE, focusPlayer, media, open, revealControls, startAndHold } from './support/player';
import { expect, test } from './support/test';

/**
 * Auto's ceiling (src/skins/flipbook/fit.ts, sources.ts, quality.ts, renditions.ts).
 *
 * A browser's own HLS picks a rendition by the connection alone, and Chromium fills its buffer before anyone presses
 * play; a ceiling lifted while the film plays holds a frame for about a second. So a stream that takes Mux's limits
 * is asked under a ceiling of the skin's:
 *
 * - where the pointer can hover, all the screen can show, from the start: the film is loaded once, and a press of
 *   play followed by a larger picture loads nothing;
 * - on a touch screen, first no taller than its box can show, for the visitor who never comes near the player, and
 *   lifted to all the screen can show once: at once in a browser that takes nothing of a film before a press
 *   (WebKit); otherwise when the box grows past the ceiling, unseen while the film is paused, the frame held while it
 *   plays (a touch screen in a browser that buffers ahead).
 *
 * The stream is the battery's own (support/stream.mjs), which the page says takes the limits, as a Mux stream behind
 * a domain of one's own does. Nothing is asked of Mux. The ceilings are Mux's heights: 360, 540, 720, 1080, 1440. The
 * battery's screens (playwright.config.ts) show 1080 px of picture at 1×: that is "all the screen can show" here.
 */

const LADDER = `${BARE}&source=ladder`;
const SMALL = { width: 800, height: 600 };
const LARGE = { width: 1280, height: 800 };
/** Longer than the skin waits for a box to be still before it reads it (quality.ts, `SETTLE`). */
const STILL = 700;
const BOX = 'ladder.m3u8?max_resolution=540p';
const SCREEN = 'ladder.m3u8?max_resolution=1080p';

const film = (page: Page) => page.locator('video:not(.fb-stand)');
const row = (page: Page) => page.locator('.fb-menu-quality');
const item = (page: Page, value: string) => page.locator(`.fb-menu-quality-group media-menu-radio-item[value="${value}"]`);
/** What the film is asked for: its address from the playlist's name on. */
const asked = (page: Page) => film(page).evaluate((video) => (video.getAttribute('src') ?? '').split('/').pop());

/** The ceilings the film's box and the screen need, worked out again here from the page (2160: none). */
const needed = (page: Page) =>
  film(page).evaluate((video) => {
    const heights = [360, 540, 720, 1080, 1440];
    const rung = (picture: number) => heights.find((height) => height >= Math.round(picture)) ?? 2160;
    const box = rung(Math.min(video.clientHeight, video.clientWidth * (9 / 16)) * devicePixelRatio);
    const display = rung(Math.min(Math.min(screen.width, screen.height), Math.max(screen.width, screen.height) * (9 / 16)) * devicePixelRatio);
    return { box, display, picture: Math.round(video.clientHeight * devicePixelRatio) };
  });

interface Seen {
  /** What a part of the player would have heard of the film being loaded. */
  heard: string[];
  /** Times the film was loaded, heard before anything could keep it back. */
  loads: number;
  plays: number;
  pauses: number;
  /** A frame was held over the film. */
  held: boolean;
  /** The poster's own state was up. */
  poster: boolean;
  /** Frames drawn, and those with no picture at all: no poster shown, and no frame of the film to show. */
  frames: number;
  empty: number;
  /** Frames on which the poster stood in for a film asked to play and not yet standing. */
  covered: number;
  /** The film was opened again under its poster (sources.ts, `reopen`). */
  reopened: boolean;
}

/** Watches the film from the moment it joins the page: its loads, what the player hears of them, every frame drawn. */
async function watchFilm(page: Page) {
  await page.addInitScript(() => {
    const seen = { heard: [] as string[], loads: 0, plays: 0, pauses: 0, held: false, poster: false, frames: 0, empty: 0, covered: 0, reopened: false };
    (window as unknown as { __fit: typeof seen }).__fit = seen;
    const joined = new MutationObserver(() => {
      const video = document.querySelector<HTMLVideoElement>('video:not(.fb-stand)');
      const container = document.querySelector<HTMLElement>('media-container');
      if (!video || !container) return;
      joined.disconnect();
      for (const type of ['emptied', 'loadstart', 'abort', 'error']) video.addEventListener(type, () => seen.heard.push(type));
      // (Before anything else on the film hears it: a reload is kept from the player, not from this.)
      video.addEventListener('loadstart', () => seen.loads++, { capture: true });
      video.addEventListener('play', () => seen.plays++, { capture: true });
      video.addEventListener('pause', () => seen.pauses++, { capture: true });
      const look = () => {
        const poster = container.querySelector('.media-poster');
        const shown = !!poster && getComputedStyle(poster).display !== 'none';
        const frame = video.readyState >= 2 && getComputedStyle(video).visibility === 'visible';
        seen.frames++;
        if (!shown && !frame) seen.empty++;
        if (shown && !video.paused && video.hasAttribute('data-fb-reopening')) seen.covered++;
        seen.reopened ||= video.hasAttribute('data-fb-reopening');
        seen.held ||= !!container.querySelector('canvas.fb-hold');
        seen.poster ||= !!container.querySelector('.media-poster[data-visible]');
        requestAnimationFrame(look);
      };
      requestAnimationFrame(look);
    });
    joined.observe(document, { childList: true, subtree: true });
  });
}
const seen = (page: Page) => page.evaluate(() => (window as unknown as { __fit: Seen }).__fit);
/** From here on: what was seen before is put away. */
const mark = (page: Page) =>
  page.evaluate(() => Object.assign((window as unknown as { __fit: Seen }).__fit, { heard: [], loads: 0, plays: 0, pauses: 0, held: false, poster: false, frames: 0, empty: 0, covered: 0, reopened: false }));

/** Opens the page with someone at the player, and waits for the stream's renditions to be on the Quality page. */
async function openWithQuality(page: Page) {
  await open(page, LADDER);
  await focusPlayer(page);
  await expect(row(page)).toHaveAttribute('data-fb-quality', '');
}

/**
 * The player in a narrower place on its page (a picture 270 px tall: a 360p ceiling), from before it is mounted; and
 * the place given its full width again (450 px tall). The box grows and the window and screen stay as they are: a
 * window resized by the test would take the battery's screen with it.
 */
async function narrow(page: Page) {
  await page.addInitScript(() => {
    const style = document.createElement('style');
    style.id = 'fit-narrow';
    style.textContent = '#player { width: 480px !important; }';
    const placed = new MutationObserver(() => {
      if (!document.head) return;
      placed.disconnect();
      document.head.append(style);
    });
    placed.observe(document, { childList: true, subtree: true });
  });
}
const widen = (page: Page) => page.evaluate(() => document.getElementById('fit-narrow')?.remove());
const NARROW = 'ladder.m3u8?max_resolution=360p';

async function pointerArrives(page: Page) {
  const box = await page.locator('media-container').boundingBox();
  if (!box) throw new Error('no player');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.4);
}

test.beforeEach(async ({ page }) => {
  await watchFilm(page);
});

/** A touch screen: its pointer does not hover. The screen is said outright (a touch context's is otherwise its window). */
const TOUCH = { hasTouch: true, screen: { width: 1920, height: 1080 } };

test.describe('where the pointer can hover: all the screen can show, from the start', () => {
  test.skip(({ browserName }) => browserName === 'firefox', 'Firefox plays no stream itself: its film is the page’s next source, a file, and Settings has no Quality');
  test.use({ viewport: SMALL });

  test('the stream is asked for it before any press, and loaded once in all: through the pointer arriving, the press and a larger picture', async ({ page }) => {
    await open(page, LADDER);
    expect(await page.evaluate(() => matchMedia('(hover: hover)').matches), 'a pointer that hovers').toBe(true);
    const need = await needed(page);
    expect(need, 'the box needs less than the screen can show').toMatchObject({ box: 540, display: 1080 });
    expect(await asked(page)).toBe(SCREEN);
    await expect.poll(() => film(page).evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(1);

    await pointerArrives(page);
    await focusPlayer(page);
    await expect(row(page)).toHaveAttribute('data-fb-quality', '');
    await page.waitForTimeout(STILL);
    await page.keyboard.press('k');
    await page.waitForFunction(() => (document.querySelector('video:not(.fb-stand)') as HTMLVideoElement).currentTime > 1);
    await page.setViewportSize(LARGE);
    await page.waitForTimeout(STILL);

    const through = await seen(page);
    expect(through.loads, 'times the film was loaded, from the page opening').toBe(1);
    expect(through.heard, 'what the player heard of the film being loaded').toEqual(['loadstart']);
    expect(through.reopened, 'the film was opened again under its poster').toBe(false);
    expect(through.held, 'a frame was held').toBe(false);
    expect(through.plays, 'times play was heard').toBe(1);
    expect(through.pauses, 'times pause was heard').toBe(0);
    expect(await asked(page)).toBe(SCREEN);
  });

  test('a height the viewer chose before is not Auto: nothing is loaded again for it', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('fb-quality:/media/stream/ladder.m3u8', '180'));
    await open(page, LADDER);
    await expect.poll(() => asked(page)).toBe('ladder.m3u8?min_resolution=180p&max_resolution=180p');
    await expect.poll(() => film(page).evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(1);
    await mark(page);
    await pointerArrives(page);
    await page.waitForTimeout(STILL);
    expect((await seen(page)).loads, 'times the film was loaded again').toBe(0);
    expect(await asked(page)).toBe('ladder.m3u8?min_resolution=180p&max_resolution=180p');
  });
});

test.describe('a touch screen, nobody near the player, in a browser that buffers ahead: the stream is asked no taller than the film’s box needs', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'WebKit takes nothing of a film before a press: it is given the screen’s ceiling, below');

  for (const { name, viewport, ratio, ceiling, screen } of [
    { name: 'an 800 px window: a picture 450 px tall', viewport: SMALL, ratio: 1, ceiling: 540, screen: TOUCH.screen },
    { name: 'the same at 2x: 900 px', viewport: SMALL, ratio: 2, ceiling: 1080, screen: TOUCH.screen },
    { name: 'a phone upright at 1.75x: 406 px', viewport: { width: 412, height: 823 }, ratio: 1.75, ceiling: 540, screen: { width: 412, height: 823 } },
    { name: 'a phone upright at 3x: 658 px', viewport: { width: 390, height: 844 }, ratio: 3, ceiling: 720, screen: { width: 390, height: 844 } },
  ]) {
    test(name, async ({ browser }) => {
      const context = await browser.newContext({ viewport, deviceScaleFactor: ratio, hasTouch: true, screen });
      const page = await context.newPage();
      await watchFilm(page);
      await open(page, LADDER);
      const need = await needed(page);
      expect(need.box, `the box’s own ceiling, for a picture ${need.picture} px tall`).toBe(ceiling);
      expect(need.display, 'the screen could show more: the ceiling is the box’s, not the screen’s').toBeGreaterThan(ceiling);
      await expect.poll(() => film(page).evaluate((video: HTMLVideoElement) => video.buffered.length), { message: 'this browser buffers the film before any press' }).toBeGreaterThan(0);
      await page.waitForTimeout(STILL);
      expect(await asked(page)).toBe(`ladder.m3u8?max_resolution=${ceiling}p`);
      expect((await seen(page)).loads, 'the film was loaded once').toBe(1);
      await context.close();
    });
  }
});

test.describe('a touch screen, in a browser that takes nothing of a film before a press', () => {
  test.skip(({ browserName }) => browserName !== 'webkit', 'Chromium buffers ahead: its film waits for its box to grow, below');
  test.use({ viewport: SMALL, ...TOUCH });

  test('the film is asked for all its screen can show at once, the player told nothing of it; it is never loaded again', async ({ page }) => {
    await open(page, LADDER);
    expect(await page.evaluate(() => matchMedia('(hover: hover)').matches), 'a pointer that hovers').toBe(false);
    await expect.poll(() => asked(page)).toBe(SCREEN);
    await expect.poll(() => film(page).evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(1);
    const idle = await film(page).evaluate((video: HTMLVideoElement) => ({ buffered: video.buffered.length, stopped: video.networkState === HTMLMediaElement.NETWORK_IDLE, reopening: video.hasAttribute('data-fb-reopening') }));
    expect(idle, 'nothing of the picture taken, the browser at rest, the poster on its own rule').toEqual({ buffered: 0, stopped: true, reopening: false });
    const opening = await seen(page);
    expect(opening.loads, 'opened by its box, then for its screen').toBe(2);
    expect(opening.heard.filter((type) => type === 'loadstart').length, 'of which the player heard one').toBe(1);
    expect(opening.heard, 'and nothing of the film going').not.toContain('emptied');

    await focusPlayer(page);
    await expect(row(page)).toHaveAttribute('data-fb-quality', '');
    await startAndHold(page, 20);
    await mark(page);
    await page.setViewportSize(LARGE);
    await page.waitForTimeout(STILL);
    await page.keyboard.press('k');
    await page.waitForFunction(() => (document.querySelector('video:not(.fb-stand)') as HTMLVideoElement).currentTime > 21);
    const later = await seen(page);
    expect(later.loads, 'times the film was loaded again as its box grew and it played on').toBe(0);
    expect(later.held, 'a frame was held').toBe(false);
    expect(await asked(page)).toBe(SCREEN);
  });

  test('a press that lands while the film is opening again starts it when it stands: not lost, not doubled, the poster up until the film has a frame', async ({ page }) => {
    // The film is asked to play a task after the browser first comes to rest on it: the moment it has just been sent
    // to open again. (The engine's own loader does not wait on a route, so the opening cannot be held any longer.)
    await page.addInitScript(() => {
      const joined = new MutationObserver(() => {
        const video = document.querySelector<HTMLVideoElement>('video:not(.fb-stand)');
        if (!video) return;
        joined.disconnect();
        video.addEventListener('suspend', () => {
          setTimeout(() => {
            (window as unknown as { __pressed: object }).__pressed = { reopening: video.hasAttribute('data-fb-reopening'), standing: video.readyState >= 2 };
            void video.play();
          }, 0);
        }, { once: true });
      });
      joined.observe(document, { childList: true, subtree: true });
    });
    await open(page, LADDER);
    await page.waitForFunction(() => (document.querySelector('video:not(.fb-stand)') as HTMLVideoElement).currentTime > 1);
    expect(await page.evaluate(() => (window as unknown as { __pressed: object }).__pressed), 'the press landed in the opening, on a film not standing').toEqual({ reopening: true, standing: false });
    const through = await seen(page);
    expect(through.plays, 'times play was heard').toBe(1);
    expect(through.pauses, 'times pause was heard').toBe(0);
    expect(through.loads, 'opened by its box, then for its screen').toBe(2);
    expect(through.covered, 'frames on which the poster stood in for the film that was asked to play').toBeGreaterThan(0);
    expect(through.empty, 'frames with no picture, of ' + through.frames).toBe(0);
    expect((await media(page)).paused, 'the player knows it is playing').toBe(false);
    await expect(film(page)).not.toHaveAttribute('data-fb-reopening', /.*/);
    await expect(page.locator('.media-poster')).not.toHaveAttribute('data-visible', /.*/);
    expect(await asked(page)).toBe(SCREEN);
  });
});

test.describe('a touch screen in a browser that buffers ahead: the first sign of anyone is the press itself', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'WebKit’s film is already at its screen’s ceiling, above');
  test.use({ viewport: SMALL, ...TOUCH });

  test('the first press loads nothing again: the film plays from the address it was opened with', async ({ page }) => {
    await openWithQuality(page);
    expect(await page.evaluate(() => matchMedia('(hover: hover)').matches), 'a pointer that hovers').toBe(false);
    expect((await needed(page)).display, 'all this screen can show').toBe(1080);
    expect(await asked(page)).toBe(BOX);
    await mark(page);
    await page.keyboard.press('k');
    await page.waitForFunction(() => (document.querySelector('video:not(.fb-stand)') as HTMLVideoElement).currentTime > 1);
    await page.waitForTimeout(STILL);
    expect((await seen(page)).loads, 'times the film was loaded again, through the press and after').toBe(0);
    expect(await asked(page)).toBe(BOX);
  });

  test('paused, a box that grows past the ceiling: Auto is asked again for all the screen can show, at the same moment, the frame held, the player told nothing', async ({ page }) => {
    await narrow(page);
    await openWithQuality(page);
    expect(await asked(page)).toBe(NARROW);
    await startAndHold(page, 20);
    const before = await media(page);
    await mark(page);
    await widen(page);
    await expect.poll(() => asked(page)).toBe(SCREEN);
    expect((await needed(page)).box, 'what the box needs now: less than it was given, so it is not asked a second time').toBe(540);
    await expect.poll(() => film(page).evaluate((video: HTMLVideoElement) => video.readyState >= 2 && !video.seeking), { message: 'the film is back, with a frame' }).toBe(true);
    await expect(page.locator('canvas.fb-hold'), 'the held frame has let go').toHaveCount(0);

    const after = await media(page);
    expect(after.time, 'the same moment').toBeCloseTo(before.time, 2);
    expect({ ...after, time: 0 }, 'as it was: paused, its speed, its volume, its captions').toEqual({ ...before, time: 0 });
    const through = await seen(page);
    expect(through.loads, 'the film was loaded again, once').toBe(1);
    expect(through.heard, 'what the player heard of the film going').toEqual([]);
    expect(through.held, 'the frame on screen was held over the film meanwhile').toBe(true);
    expect(through.poster, 'the poster came back').toBe(false);
    // Quality still says what plays: Auto, checked, with the height on screen.
    const height = await film(page).evaluate((video: HTMLVideoElement) => video.videoHeight);
    await expect(item(page, 'auto')).toHaveAttribute('aria-checked', 'true');
    await expect(item(page, 'auto').locator('[data-part="badge"]')).toHaveText(`${height}p`);
    await expect(row(page).locator('[data-fb-part="quality"]')).toHaveText('Auto');
  });

  test('a press of play while a paused film is being asked again: it plays, and the held frame lets go for the film’s own', async ({ page }) => {
    await page.route(/ladder\.m3u8\?max_resolution=1080p/, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.continue();
    });
    await narrow(page);
    await openWithQuality(page);
    await startAndHold(page, 20);
    await mark(page);
    await widen(page);
    await expect(page.locator('canvas.fb-hold')).toHaveCount(1);
    await page.keyboard.press('k');
    // Half a second into playing again, the picture is the film's: a held frame over a film that plays is a stall.
    await page.waitForFunction(() => (document.querySelector('video:not(.fb-stand)') as HTMLVideoElement).currentTime > 20.5);
    await expect(page.locator('canvas.fb-hold'), 'the held frame, half a second into the film playing again').toHaveCount(0, { timeout: 500 });
    const through = await seen(page);
    expect(through.plays, 'times play was heard').toBe(1);
    expect(through.pauses, 'times pause was heard').toBe(0);
    expect(through.loads).toBe(1);
    expect(await asked(page)).toBe(SCREEN);
  });

  test('playing, a box that grows past the ceiling: asked again once, the frame held, and the film plays on', async ({ page }) => {
    await narrow(page);
    await openWithQuality(page);
    await page.keyboard.press('k');
    await page.waitForFunction(() => (document.querySelector('video:not(.fb-stand)') as HTMLVideoElement).currentTime > 1.5);
    await mark(page);
    await widen(page);
    await expect.poll(() => asked(page)).toBe(SCREEN);
    const at = await film(page).evaluate((video: HTMLVideoElement) => video.currentTime);
    await page.waitForFunction((from) => (document.querySelector('video:not(.fb-stand)') as HTMLVideoElement).currentTime > from + 1, at);
    await expect(page.locator('canvas.fb-hold')).toHaveCount(0);
    const through = await seen(page);
    expect(through.loads, 'the film was loaded again, once').toBe(1);
    expect(through.held, 'the frame on screen was held meanwhile').toBe(true);
    expect(through.heard, 'what the player heard of the film going').toEqual([]);
    expect(through.pauses, 'times pause was heard').toBe(0);
    expect((await media(page)).paused).toBe(false);
  });

  test('a box that shrinks is left alone: no reload for a smaller picture', async ({ page }) => {
    await openWithQuality(page);
    expect(await asked(page)).toBe(BOX);
    await startAndHold(page, 20);
    await mark(page);
    await page.evaluate(() => document.getElementById('player')?.style.setProperty('width', '480px'));
    await page.waitForTimeout(STILL);
    expect((await needed(page)).box, 'the box needs less now').toBe(360);
    expect((await seen(page)).loads, 'times the film was loaded again').toBe(0);
    expect(await asked(page)).toBe(BOX);
  });

  test('a box that grows before anyone is at the player is answered too', async ({ page }) => {
    await narrow(page);
    await open(page, LADDER);
    await expect(row(page), 'nobody at the player: Quality is not fetched yet').not.toHaveAttribute('data-fb-quality', '');
    expect(await asked(page)).toBe(NARROW);
    await widen(page);
    await expect.poll(() => asked(page)).toBe(SCREEN);
    await expect.poll(() => film(page).evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(1);
    await expect(page.locator('.media-poster'), 'not begun: the poster stands').toHaveAttribute('data-visible', '');
    await expect(page.locator('canvas.fb-hold'), 'and nothing is held over it').toHaveCount(0);
  });

  test('a player that is not displayed has no box to outgrow: nothing is fetched or loaded for it', async ({ page }) => {
    await open(page, LADDER);
    await mark(page);
    // (As a page does that mounts the player before it shows it: the showcase connects it a task before it displays it.)
    const player = page.locator('video-player');
    await player.evaluate((el: HTMLElement) => el.style.setProperty('display', 'none'));
    await page.waitForTimeout(STILL);
    await player.evaluate((el: HTMLElement) => el.style.removeProperty('display'));
    await page.waitForTimeout(STILL);
    await expect(row(page), 'Quality is fetched for nobody').not.toHaveAttribute('data-fb-quality', '');
    expect((await seen(page)).loads, 'times the film was loaded again').toBe(0);
    expect(await asked(page)).toBe(BOX);
  });

  test('a chosen height is not Auto’s to change; back on Auto, the film is asked for all the screen can show', async ({ page }) => {
    await narrow(page);
    await openWithQuality(page);
    await startAndHold(page, 20);
    await revealControls(page);
    await page.locator('.fb-settings').click();
    await row(page).click();
    await item(page, '180').click();
    await expect.poll(() => asked(page)).toBe('ladder.m3u8?min_resolution=180p&max_resolution=180p');
    await expect.poll(() => film(page).evaluate((video: HTMLVideoElement) => video.videoHeight)).toBe(180);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await mark(page);
    await widen(page);
    await page.waitForTimeout(STILL);
    expect((await seen(page)).loads, 'times the film was loaded again as its box grew').toBe(0);
    expect(await asked(page)).toBe('ladder.m3u8?min_resolution=180p&max_resolution=180p');

    await revealControls(page);
    await page.locator('.fb-settings').click();
    await row(page).click();
    await item(page, 'auto').click();
    await expect.poll(() => asked(page)).toBe(SCREEN);
  });
});
