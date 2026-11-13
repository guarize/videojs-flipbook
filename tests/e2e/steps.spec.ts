import { type Page } from '@playwright/test';
import { BARE, FRAME, focusPlayer, open, pointerOnPlayer, seekPainted, skipWithout, startAndHold } from './support/player';
import { expect, test } from './support/test';

/**
 * A step of one frame (src/skins/flipbook/flip.ts #step, shown.ts).
 *
 * `.` and `,` (and Shift with an arrow) step by the frame on screen, as the browser names it, not by arithmetic on
 * the clock: every press shows another frame, and as many presses back return to the very frame it started on. That
 * holds before the film has ever played (one frame's length is not known yet: the step finds it), and for presses
 * made faster than the film can show them (they are kept and taken in turn).
 *
 * The frames are read as the browser names them (`requestVideoFrameCallback`), with real key presses.
 */

const container = (page: Page) => page.locator('media-container');

/** Records every frame the film shows from now on (its own time, in seconds). */
async function watch(page: Page) {
  await page.evaluate(() => {
    const video = document.querySelector('video') as HTMLVideoElement;
    const shown: number[] = [];
    (window as unknown as { __steps: number[] }).__steps = shown;
    const next = (_now: number, frame: VideoFrameCallbackMetadata) => {
      if (shown.at(-1) !== frame.mediaTime) shown.push(frame.mediaTime);
      video.requestVideoFrameCallback(next);
    };
    video.requestVideoFrameCallback(next);
  });
}

/** The frame a moment is in, on a 24-frames-a-second film. */
const frameOf = (time: number) => Math.floor(time / FRAME + 0.001) * FRAME;

// (Each name as the frame it falls in: Chromium and WebKit name a frame by its own time, Firefox names one it shows
// for a seek by the moment that was asked for, somewhere inside it.)
const shown = (page: Page) => page.evaluate(() => [...(window as unknown as { __steps: number[] }).__steps]).then((names) => names.map(frameOf));
const last = async (page: Page) => (await shown(page)).at(-1) ?? null;

test.describe('one frame at a time', () => {
  test.beforeEach(() => skipWithout(test, 'deck'));

  test('a film that has never played, opened on a moment and stepped at once: six presses are six frames, and six back return exactly', async ({ page, browserName }) => {
    test.fixme(browserName === 'firefox', 'Firefox names a sought frame by the moment asked for, so a film that has never played has nothing to count frames by: a step there moves the clock by a guess (shown.ts). Open for a decision.');
    await open(page, BARE);
    await expect(container(page)).toHaveAttribute('data-fb-flip', '');
    await watch(page);
    // Opened on a moment, as a kept page's link opens it: sought, never played.
    await page.evaluate(() => new Promise<void>((resolve) => {
      const video = document.querySelector('video') as HTMLVideoElement;
      video.addEventListener('seeked', () => resolve(), { once: true });
      video.currentTime = 20.02;
    }));
    expect(await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).played.length), 'the film has not played').toBe(0);
    const start = frameOf(20.02);
    await expect.poll(() => last(page)).toBeCloseTo(start, 3);
    await pointerOnPlayer(page);
    await focusPlayer(page);

    for (let i = 1; i <= 6; i++) {
      await page.keyboard.press('.');
      await expect.poll(() => last(page), { message: `press ${i} of .` }).toBeCloseTo(start + i * FRAME, 3);
    }
    // Every frame on the way was shown once, in order: none skipped, none twice.
    const on = (await shown(page)).filter((time) => time > start - 0.001);
    expect(on.map((time) => Math.round((time - start) / FRAME))).toEqual([0, 1, 2, 3, 4, 5, 6]);

    for (let i = 1; i <= 6; i++) {
      await page.keyboard.press(',');
      await expect.poll(() => last(page), { message: `press ${i} of ,` }).toBeCloseTo(start + (6 - i) * FRAME, 3);
    }
    expect(await last(page), 'back on the very frame it started on').toBeCloseTo(start, 3);
  });

  test('presses made faster than the film can show them are all taken: five quick presses are five frames', async ({ page }) => {
    await open(page, BARE);
    await startAndHold(page, 20.02);
    await watch(page);
    await pointerOnPlayer(page);
    await focusPlayer(page);
    const start = frameOf(20.02);
    for (let i = 0; i < 5; i++) await page.keyboard.press('.');
    await expect.poll(() => last(page)).toBeCloseTo(start + 5 * FRAME, 3);
    for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft');
    await expect.poll(() => last(page)).toBeCloseTo(start, 3);
    // The clock is inside the frame on screen.
    const clock = await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).currentTime);
    expect(clock - start).toBeGreaterThanOrEqual(0);
    expect(clock - start).toBeLessThan(FRAME);
  });

  // By the pictures themselves, whatever the browser names them. Firefox names a frame it shows for a seek by the
  // moment asked for, not by the frame's own time (shown.ts): a step that believed the name found a new frame in every
  // seek, and six presses of . showed frames 1, 1, 2, 2, 3, 4 and six of , then 3, 3, 3, 3, 3, 2 (13 Nov 2026).
  test('on a film that has played, each press is the next picture and each press back the one before: by the pictures, not their names', async ({ page }) => {
    await open(page, BARE);
    await startAndHold(page, 20.02);
    // Each frame's picture from 0:19.5 to 0:20.5, read once: the film sought into the middle of the frame, drawn small.
    const first = Math.round(19.5 / FRAME);
    const at = Math.round(20 / FRAME) - first;
    const pictures = await page.evaluate(async ({ first, frame }) => {
      const video = document.querySelector('video') as HTMLVideoElement;
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 90;
      const pen = canvas.getContext('2d', { willReadFrequently: true })!;
      const picture = () => {
        pen.drawImage(video, 0, 0, 160, 90);
        const data = pen.getImageData(0, 0, 160, 90).data;
        let sum = 1;
        for (let i = 0; i < data.length; i += 4) sum = (sum * 31 + data[i]) >>> 0;
        return sum;
      };
      (window as unknown as { __picture: () => number }).__picture = picture;
      const seen: number[] = [];
      for (let k = first; k <= first + 24; k++) {
        // Read once the seek has landed and the browser has said it has shown a frame (or half a second on: a
        // browser that says nothing), and a moment after for the picture to be there to draw. (A tenth of a second
        // after `seeked` alone, a busy machine still drew the frame before, in one run of a whole battery.)
        await Promise.all([
          new Promise<void>((resolve) => video.addEventListener('seeked', () => resolve(), { once: true })),
          new Promise<void>((resolve) => {
            video.requestVideoFrameCallback(() => resolve());
            setTimeout(resolve, 500);
            video.currentTime = (k + 0.5) * frame;
          }),
        ]);
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100))));
        seen.push(picture());
      }
      return seen;
    }, { first, frame: FRAME });
    expect(new Set(pictures).size, 'different pictures among the 25 frames read').toBe(25);
    await seekPainted(page, 20.02);
    await pointerOnPlayer(page);
    await focusPlayer(page);
    /** The frame on the glass, counted from the one that holds 0:20. */
    const onGlass = async () => pictures.indexOf(await page.evaluate(() => (window as unknown as { __picture: () => number }).__picture())) - at;
    await expect.poll(onGlass, 'the frame that holds 0:20.02').toBe(0);
    for (let i = 1; i <= 6; i++) {
      await page.keyboard.press('.');
      await expect.poll(onGlass, { message: `press ${i} of .` }).toBe(i);
    }
    for (let i = 1; i <= 6; i++) {
      await page.keyboard.press(',');
      await expect.poll(onGlass, { message: `press ${i} of ,` }).toBe(6 - i);
    }
  });

});
