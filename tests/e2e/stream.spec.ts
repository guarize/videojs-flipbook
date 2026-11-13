import { type Page } from '@playwright/test';
import { BARE, DURATION, FRAME, focusPlayer, open, PAGES, PER_PAGE, pointerOnPlayer, skipWithout, startAndHold } from './support/player';
import { expect, test } from './support/test';

/**
 * A film that plays from a stream (src/skins/flipbook/sources.ts, stand.ts, standing.ts).
 *
 * The stream here is the battery's own: a local HLS copy of the silent film with a keyframe every five seconds, as a
 * streaming service cuts it (support/stream.mjs), played by each engine's own HLS. Nothing is asked of Mux.
 *
 * - The film plays from the stream. A hand on the fore-edge flips a silent copy that seeks at once (`scrub`): it
 *   stands over the picture with exact frames, and the film takes the picture back only with the very frame the copy
 *   shows. Thrown forwards, the pages run on and the film plays from where they arrive.
 * - A step of one frame, and the paused page's strip, are the copy's frames.
 * - With no copy, the storyboard's pages stand in, counted as pages, and the film's own frame takes over.
 * - A stream that cannot be reached gives way to the next source, and nobody is told.
 *
 * Every check reads the running page: each picture's frames as the browser names them, computed styles, real keys
 * and a real mouse.
 */

const STREAM = `${BARE}&source=stream`;
const container = (page: Page) => page.locator('media-container');
const film = (page: Page) => page.locator('video:not(.fb-stand)');
const copy = (page: Page) => page.locator('video.fb-stand');
const pages = (page: Page) => page.locator('canvas.fb-stand');

interface Seen {
  /** The frame each picture shows (seconds), as the browser last named it. */
  film: number | null;
  copy: number | null;
  /** Different frames the copy has shown. */
  copyFrames: number;
  /** Each time a stand-in left: what the film and the copy showed a frame later, and the film's clock. */
  leaves: { film: number | null; copyAt: number | null; clock: number; paused: boolean }[];
}

/** Watches both pictures' frames, and every leaving of a stand-in, from now on. */
async function watch(page: Page) {
  await page.evaluate(() => {
    const video = document.querySelector('video:not(.fb-stand)') as HTMLVideoElement;
    const seen = { film: null as number | null, copy: null as number | null, copyFrames: 0, leaves: [] as unknown[] };
    const frames = new Set<string>();
    (window as unknown as { __stream: typeof seen }).__stream = seen;
    const own = (_now: number, frame: VideoFrameCallbackMetadata) => {
      seen.film = frame.mediaTime;
      video.requestVideoFrameCallback(own);
    };
    video.requestVideoFrameCallback(own);
    const hooked = new WeakSet<Element>();
    const hook = () => {
      for (const stand of document.querySelectorAll<HTMLElement>('.fb-stand')) {
        if (hooked.has(stand)) continue;
        hooked.add(stand);
        if (stand instanceof HTMLVideoElement) {
          const its = (_now: number, frame: VideoFrameCallbackMetadata) => {
            seen.copy = frame.mediaTime;
            frames.add(frame.mediaTime.toFixed(3));
            seen.copyFrames = frames.size;
            stand.requestVideoFrameCallback(its);
          };
          stand.requestVideoFrameCallback(its);
        }
        let on = stand.hasAttribute('data-on');
        new MutationObserver(() => {
          const now = stand.hasAttribute('data-on');
          if (on && !now) {
            // The copy's clock as it leaves; the film's frame a frame later (every frame callback has run by then).
            const copyAt = stand instanceof HTMLVideoElement ? stand.currentTime : null;
            requestAnimationFrame(() => requestAnimationFrame(() => seen.leaves.push({ film: seen.film, copyAt, clock: video.currentTime, paused: video.paused })));
          }
          on = now;
        }).observe(stand, { attributes: true, attributeFilter: ['data-on'] });
      }
    };
    hook();
    new MutationObserver(hook).observe(document.querySelector('media-container') as Element, { childList: true });
  });
}

const seen = (page: Page): Promise<Seen> => page.evaluate(() => (window as unknown as { __stream: Seen }).__stream);

interface Strip {
  /** Since the strip was last laid on a moment (its row named for it): what its cells held, frame by frame. */
  looks: { ms: number; ready: number; still: number }[];
}

/**
 * Watches the paused page's strip, every frame the browser draws: how many of its twelve cells hold a picture, and
 * how many of those are a page's still standing in for the frame. The count starts again each time the strip is laid
 * on another moment.
 */
async function watchStrip(page: Page) {
  await page.evaluate(() => {
    const strip = { looks: [] as { ms: number; ready: number; still: number }[] };
    (window as unknown as { __strip: typeof strip }).__strip = strip;
    const row = document.querySelector('.fb-strip-row') as HTMLElement;
    let laid = performance.now();
    new MutationObserver(() => {
      laid = performance.now();
      strip.looks = [];
    }).observe(row, { attributes: true, attributeFilter: ['aria-label'] });
    const look = () => {
      strip.looks.push({
        ms: Math.round(performance.now() - laid),
        ready: row.querySelectorAll('.fb-strip-cell[data-ready]').length,
        still: row.querySelectorAll('.fb-strip-cell[data-still]').length,
      });
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
}
const strip = (page: Page): Promise<Strip> => page.evaluate(() => (window as unknown as { __strip: Strip }).__strip);
/** A cell holds a picture within this of the strip being laid: its frame, or its page's still until the frame comes. */
const STRIP_BOUND = 1000;
/** The strip's twelve pictures, each as a number: alike numbers are alike pictures. */
const prints = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLCanvasElement>('.fb-strip-cell canvas')].map((canvas) => {
      const data = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data ?? new Uint8ClampedArray();
      if (![...data].some((value, i) => i % 4 === 3 && value > 0)) return 0;
      let sum = 1;
      for (let i = 0; i < data.length; i += 16) sum = (sum * 31 + data[i]) >>> 0;
      return sum;
    }),
  );

async function edge(page: Page) {
  const box = await page.locator('media-time-slider').boundingBox();
  if (!box) throw new Error('no fore-edge');
  return box;
}

/** The pointer on the fore-edge, and the copy fetched with a picture in it (it is fetched when a hand first comes). */
async function hand(page: Page, share: number) {
  const box = await edge(page);
  await page.mouse.move(box.x + box.width * share, box.y + box.height / 2);
  await expect.poll(() => copy(page).evaluate((el: HTMLVideoElement) => el.readyState).catch(() => 0), { message: 'the copy has a picture' }).toBeGreaterThanOrEqual(2);
  return box;
}

/**
 * A quick throw along the edge, taken as one (flip.spec.ts: whether a release is a flick is a matter of milliseconds,
 * and a loaded runner can stretch them until it reads as letting go still; the same throw is then made again).
 */
async function thrown(page: Page, box: { x: number; y: number; width: number; height: number }) {
  const y = box.y + box.height / 2;
  const mode = () => page.locator('fb-flip').getAttribute('data-mode');
  for (let attempt = 0; attempt < 4; attempt++) {
    const from = 0.1 + attempt * 0.02;
    await page.mouse.move(box.x + box.width * from, y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) {
      if (i > 1) await page.waitForTimeout(12);
      await page.mouse.move(box.x + box.width * (from + (0.2 * i) / 8), y);
    }
    await page.mouse.up();
    if ((await mode()) === 'coast' || !(await page.locator('video:not(.fb-stand)').evaluate((el: HTMLVideoElement) => el.paused))) return;
    await expect(page.locator('fb-flip')).toHaveAttribute('data-mode', 'idle');
  }
  throw new Error('four throws, none taken as a flick');
}

/** A drag along the edge at a hand's pace. */
async function drag(page: Page, box: { x: number; y: number; width: number; height: number }, from: number, to: number, steps = 30) {
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * from, y);
  await page.mouse.down();
  await expect(page.locator('fb-flip')).toHaveAttribute('data-mode', 'drag');
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(box.x + box.width * (from + ((to - from) * i) / steps), y);
    await page.waitForTimeout(16);
  }
}

test.describe('a streamed film, with a copy for the hand', () => {
  test.skip(({ browserName }) => browserName === 'firefox', 'Firefox plays no stream itself: its film is the page’s next source, a file, and Settings has no Quality');
  test.beforeEach(() => skipWithout(test, 'deck'));

  test('plays from the stream itself, with no stand-in in sight', async ({ page }) => {
    await open(page, STREAM);
    expect(await film(page).evaluate((el: HTMLVideoElement) => el.currentSrc)).toMatch(/\/media\/stream\/film\.m3u8$/);
    expect(await film(page).evaluate((el: HTMLVideoElement) => el.duration)).toBeCloseTo(DURATION, 0);
    await pointerOnPlayer(page);
    await page.keyboard.press('k');
    await expect.poll(() => film(page).evaluate((el: HTMLVideoElement) => el.currentTime)).toBeGreaterThan(1);
    await expect(page.locator('.fb-stand[data-on]')).toHaveCount(0);
    // The copy is not fetched for a film that only plays.
    await expect(copy(page)).toHaveCount(0);
  });

  test('a hand on the edge flips the copy; the film takes the picture back with the very frame', async ({ page }) => {
    await open(page, STREAM);
    await startAndHold(page, 5);
    await watch(page);
    const box = await hand(page, 0.2);
    await drag(page, box, 0.2, 0.5);
    // The page count reads where the hand is, at once: the hand is ahead of a stream's clock, and a count that
    // waited for the film read a page behind what the hand read over the edge (seen on the live page, 12 Nov 2026).
    expect(await page.locator('fb-folio').evaluate((el) => el.textContent), 'the page count, the moment the hand stops at the film’s middle').toBe(`p. ${Math.floor((DURATION * 0.5) / PER_PAGE) + 1} / ${PAGES}`);
    // Under the hand: the copy over the picture, in the picture's own box, with the film held still under it.
    await expect(copy(page)).toHaveAttribute('data-on', '');
    await expect(copy(page)).toHaveCSS('opacity', '1');
    const boxes = await page.evaluate(() => {
      const r = (el: Element | null) => el?.getBoundingClientRect().toJSON();
      return { film: r(document.querySelector('video:not(.fb-stand)')), copy: r(document.querySelector('video.fb-stand')) };
    });
    expect(boxes.copy, 'the copy fills the picture’s own box').toEqual(boxes.film);
    expect(await film(page).evaluate((el: HTMLVideoElement) => el.paused)).toBe(true);
    expect((await seen(page)).copyFrames, 'frames the copy showed along the way').toBeGreaterThan(12);
    // The fore-edge's ribbon is at the hand, whatever the film's own seeks take.
    const fill = await page.locator('media-time-slider').evaluate((el: HTMLElement) => Number.parseFloat(el.style.getPropertyValue('--media-slider-fill')));
    expect(fill, 'the ribbon, as a share of the edge').toBeCloseTo(50, 0);

    // The hand rests, then lifts: nothing is thrown.
    await page.waitForTimeout(250);
    const before = (await seen(page)).leaves.length;
    await page.mouse.up();
    // At rest: the film is sought there once, and the copy leaves only when the film shows the same frame.
    await expect(copy(page)).not.toHaveAttribute('data-on', /.*/, { timeout: 10_000 });
    await expect.poll(async () => (await seen(page)).leaves.length).toBeGreaterThan(before);
    const { leaves } = await seen(page);
    const left = leaves[leaves.length - 1];
    expect(left.paused, 'a film held still before the drag is still held').toBe(true);
    expect(left.clock, 'the film is where the hand let go').toBeCloseTo(DURATION * 0.5, 0);
    expect(left.film, 'the film names the frame it shows').not.toBeNull();
    // The film shows the frame of the very moment the copy was on (the copy shows the frame its own clock is in:
    // the step test below reads that).
    expect(Math.abs(left.clock - (left.copyAt as number)), 'the film’s clock against the copy’s, in seconds').toBeLessThan(0.01);
    expect(left.clock - (left.film as number), 'the film’s clock is inside the frame it shows').toBeGreaterThanOrEqual(-0.001);
    expect(left.clock - (left.film as number)).toBeLessThan(FRAME + 0.001);
    await expect(copy(page)).toHaveCSS('opacity', '0');
  });

  test('thrown forwards, the pages run on and the film plays from where they arrive', async ({ page }) => {
    await open(page, STREAM);
    await startAndHold(page, 5);
    const box = await hand(page, 0.1);
    // What is in sight at every frame from here on: the copy (and the moment it shows) or the film (and its clock).
    await page.evaluate(() => {
      const video = document.querySelector('video:not(.fb-stand)') as HTMLVideoElement;
      const stand = document.querySelector('video.fb-stand') as HTMLVideoElement;
      const sight: { copy: boolean; at: number; held: boolean; clock: number }[] = [];
      (window as unknown as { __sight: typeof sight }).__sight = sight;
      // The film's moment in sight is the frame it shows, as the browser names it. (Its clock is not the picture:
      // Safari's reads the start of the stream's segment for an instant as a sought stream begins to play.)
      let shown = video.currentTime;
      const frame = (_now: number, named: VideoFrameCallbackMetadata) => {
        shown = named.mediaTime;
        video.requestVideoFrameCallback(frame);
      };
      video.requestVideoFrameCallback(frame);
      const look = () => {
        const copy = stand.hasAttribute('data-on');
        sight.push({ copy, at: copy ? stand.currentTime : shown, held: video.paused || video.seeking, clock: video.currentTime });
        requestAnimationFrame(look);
      };
      requestAnimationFrame(look);
    });
    await thrown(page, box);
    // It ends as a film simply playing, at exactly its own rate, from the stream, the copy gone.
    await expect(page.locator('fb-flip')).toHaveAttribute('data-mode', 'idle', { timeout: 10_000 });
    await expect(copy(page)).not.toHaveAttribute('data-on', /.*/);
    const state = await film(page).evaluate((el: HTMLVideoElement) => ({ paused: el.paused, rate: el.playbackRate }));
    expect(state).toEqual({ paused: false, rate: 1 });
    const sight = await page.evaluate(() => (window as unknown as { __sight: { copy: boolean; at: number; held: boolean; clock: number }[] }).__sight);
    const thrownAt = sight.findIndex((s) => s.copy);
    const after = sight.slice(thrownAt);
    const handed = after.findIndex((s) => !s.copy);
    expect(thrownAt, 'the copy came up under the hand').toBeGreaterThanOrEqual(0);
    expect(handed, 'the film took the picture back').toBeGreaterThan(0);
    // While the film was held still or on its way, the copy had the picture: never the film's own stale frame.
    const bare = after.slice(0, handed).filter((s) => !s.copy).length;
    expect(bare, 'frames with the film in sight before it played').toBe(0);
    expect(after[handed].held, 'the film is playing when it takes the picture').toBe(false);
    // And the picture never goes back: each moment in sight is the one before it, or later (a frame's slack).
    const back = after.filter((s, i) => i > 0 && s.at < after[i - 1].at - FRAME);
    expect(back.map((s) => `${s.at.toFixed(2)} (clock ${s.clock.toFixed(2)})`), 'moments in sight that went backwards').toEqual([]);
  });

  test('a step of one frame is the copy’s next frame at once, and the film follows to the same frame', async ({ page }) => {
    await open(page, STREAM);
    await startAndHold(page, 20.02);
    await watch(page);
    await hand(page, 0.2);
    await pointerOnPlayer(page);
    await focusPlayer(page);
    const start = Math.floor(20.02 / FRAME + 0.001) * FRAME;
    // Three presses, as quickly as a hand makes them: three frames on.
    for (let i = 0; i < 3; i++) await page.keyboard.press('.');
    await expect.poll(async () => (await seen(page)).copy, { message: 'the frame the copy shows' }).toBeCloseTo(start + 3 * FRAME, 3);
    await expect(copy(page)).not.toHaveAttribute('data-on', /.*/, { timeout: 10_000 });
    await expect.poll(async () => (await seen(page)).film, { message: 'the frame the film shows' }).toBeCloseTo(start + 3 * FRAME, 3);
    // And three back return to the very frame it started on.
    for (let i = 0; i < 3; i++) await page.keyboard.press(',');
    await expect.poll(async () => (await seen(page)).copy).toBeCloseTo(start, 3);
    await expect(copy(page)).not.toHaveAttribute('data-on', /.*/, { timeout: 10_000 });
    await expect.poll(async () => (await seen(page)).film).toBeCloseTo(start, 3);
  });

  test('the paused page’s strip is read from the copy: twelve frames, each another picture, none left empty', async ({ page }) => {
    skipWithout(test, 'plate');
    await open(page, STREAM);
    await watchStrip(page);
    // The gallop, riffled: every sixth of a second is another photograph.
    await startAndHold(page, 30.5);
    await expect(page.locator('.fb-strip-cell[data-ready]:not([data-still])'), 'cells holding their own frame').toHaveCount(12, { timeout: 15_000 });
    const { looks } = await strip(page);
    const full = looks.find((look) => look.ready === 12);
    expect(full?.ms, 'every cell held a picture this long after the strip was laid (ms)').toBeLessThanOrEqual(STRIP_BOUND);
    expect(looks.slice(looks.indexOf(full!)).every((look) => look.ready === 12), 'and none went empty again').toBe(true);
    const pictures = await prints(page);
    expect(pictures.filter((print) => print === 0).length, 'cells with nothing drawn').toBe(0);
    expect(new Set(pictures).size, 'different pictures among the twelve').toBeGreaterThanOrEqual(10);
  });
});

test.describe('a streamed film, with no copy', () => {
  test.skip(({ browserName }) => browserName === 'firefox', 'Firefox plays no stream itself: its film is the page’s next source, a file, and Settings has no Quality');
  test.beforeEach(() => skipWithout(test, 'deck'));
  const BARE_STREAM = `${STREAM}&scrub=none`;

  test('the storyboard’s pages stand in under the hand, counted as pages; the film’s own frame takes over', async ({ page }) => {
    await open(page, BARE_STREAM);
    await startAndHold(page, 5);
    await watch(page);
    const box = await edge(page);
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
    await drag(page, box, 0.2, 0.5);
    await expect(copy(page)).toHaveCount(0);
    await expect(pages(page)).toHaveAttribute('data-on', '');
    await expect(pages(page)).toHaveCSS('opacity', '1');
    // A page is drawn on it, at the picture's own box: never a hole in the picture.
    const drawn = await pages(page).evaluate((canvas: HTMLCanvasElement) => {
      const data = canvas.getContext('2d')?.getImageData(canvas.width >> 1, canvas.height >> 1, 8, 8).data ?? new Uint8ClampedArray();
      const video = document.querySelector('video:not(.fb-stand)') as HTMLVideoElement;
      return { opaque: [...data].filter((_, i) => i % 4 === 3).every((a) => a === 255), width: canvas.width, box: canvas.getBoundingClientRect().toJSON(), film: video.getBoundingClientRect().toJSON() };
    });
    expect(drawn.opaque, 'the page’s still is on the canvas').toBe(true);
    expect(drawn.box, 'the pages fill the picture’s own box').toEqual(drawn.film);
    // What is on the picture is a page, and the readout says so: "p. 26", never a speed.
    await expect(page.locator('.fb-edge-chip')).toHaveText(/^p\.\s?\d+$/);

    await page.waitForTimeout(250);
    const before = (await seen(page)).leaves.length;
    await page.mouse.up();
    await expect(pages(page)).not.toHaveAttribute('data-on', /.*/, { timeout: 10_000 });
    await expect.poll(async () => (await seen(page)).leaves.length).toBeGreaterThan(before);
    const { leaves } = await seen(page);
    const left = leaves[leaves.length - 1];
    expect(left.clock).toBeCloseTo(DURATION * 0.5, 0);
    expect(left.clock - (left.film as number), 'the film shows the frame its clock is in').toBeGreaterThanOrEqual(-0.001);
    expect(left.clock - (left.film as number)).toBeLessThan(FRAME + 0.001);
  });

  test('the paused page’s strip has its pages’ stills at once, and each gives way to its frame: never an empty cell', async ({ page }) => {
    skipWithout(test, 'plate');
    await open(page, BARE_STREAM);
    await watchStrip(page);
    await startAndHold(page, 30.5);
    // The frames are read from the stream itself, which takes its time: every cell ends with its own.
    await expect(page.locator('.fb-strip-cell[data-ready]:not([data-still])'), 'cells holding their own frame').toHaveCount(12, { timeout: 20_000 });
    const { looks } = await strip(page);
    // Laid, the row is whole at the first look: the stills are on the page already, nothing is waited for.
    const full = looks.find((look) => look.ready === 12);
    expect(full?.ms, 'every cell held a picture this long after the strip was laid (ms)').toBeLessThanOrEqual(STRIP_BOUND);
    expect(full?.still, 'of them, pages’ stills standing in').toBeGreaterThan(0);
    expect(looks.slice(looks.indexOf(full!)).every((look) => look.ready === 12), 'and none went empty again').toBe(true);
    const pictures = await prints(page);
    expect(pictures.filter((print) => print === 0).length, 'cells with nothing drawn').toBe(0);
    expect(new Set(pictures).size, 'different pictures among the twelve, once the frames are in').toBeGreaterThanOrEqual(10);
  });
});

test.describe('the sources a film is given', () => {
  // The showcase's own list (site/media.ts): the Mux stream, its MP4, the file beside the page. The battery refuses
  // every request to Mux (support/silence.mjs), so the film must reach the last of them by itself.
  const CHAIN = `${BARE}&source=mux`;

  test('a stream that cannot be reached gives way to the file beside the page, and nobody is told', async ({ page }) => {
    const failed: string[] = [];
    page.on('requestfailed', (request) => failed.push(new URL(request.url()).hostname));
    await open(page, CHAIN);
    expect(failed.some((host) => host.endsWith('mux.com')), 'Mux was asked first, and refused').toBe(true);
    expect(await film(page).evaluate((el: HTMLVideoElement) => el.currentSrc)).toMatch(/\/media\/film\/film-720\.mp4$/);
    // No error was shown for the sources that were passed over.
    await expect(page.locator('media-error-dialog media-dialog-popup')).not.toBeVisible();
    expect(await film(page).evaluate((el: HTMLVideoElement) => el.error)).toBeNull();
    await pointerOnPlayer(page);
    await page.keyboard.press('k');
    await expect.poll(() => film(page).evaluate((el: HTMLVideoElement) => el.currentTime)).toBeGreaterThan(1);
  });

  test('a film that plays from the very file given as its copy is flipped itself: no stand-in', async ({ page }) => {
    skipWithout(test, 'deck');
    await open(page, CHAIN);
    await startAndHold(page, 5);
    const box = await edge(page);
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
    await drag(page, box, 0.2, 0.5);
    await expect(page.locator('.fb-stand[data-on]')).toHaveCount(0);
    await expect.poll(() => film(page).evaluate((el: HTMLVideoElement) => el.currentTime)).toBeCloseTo(DURATION * 0.5, 0);
    await page.waitForTimeout(250);
    await page.mouse.up();
    await expect(container(page)).not.toHaveAttribute('data-fb-deck', 'flip');
  });
});
