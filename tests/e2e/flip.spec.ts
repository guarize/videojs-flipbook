import { type Page } from '@playwright/test';
import { BARE, DURATION, FRAME, focusPlayer, media, open, skipWithout, startAndHold } from './support/player';
import { expect, test } from './support/test';

/**
 * Flipping is playing, and pausing prints (src/skins/flipbook/flip.ts, print.ts).
 *
 * - A hand on the fore-edge moves the film itself: the film's clock follows the pointer, forwards and back, on a row
 *   (a wide player) and down the side (a phone's), and frames are shown as it goes.
 * - A flick leaves the film playing, its rate above 1 and falling to exactly 1. A touch, a key or the play key ends
 *   the glide at once. Reduced motion has no glide.
 * - A held arrow riffles faster the longer it's held, and settles when released.
 * - Paused, the picture is a print with a margin of the size print.ts states, and ← and → turn exactly one page; with
 *   Shift, or , and ., one frame. The second press never waits for the first.
 * - The seek slider underneath keeps its role, its value text and its keys.
 *
 * Every check reads the running page: the video's own clock and rate, computed rects and styles, real key presses.
 */

const container = (page: Page) => page.locator('media-container');
const flip = (page: Page) => page.locator('fb-flip');

async function ready(page: Page, path = BARE) {
  await open(page, path);
  await expect(container(page)).toHaveAttribute('data-fb-flip', '');
}

async function edge(page: Page) {
  const box = await page.locator('media-time-slider').boundingBox();
  if (!box) throw new Error('no fore-edge');
  return box;
}

/** Counts the film's frames as they're shown, and every rate the film is given, from now on. */
async function watch(page: Page) {
  await page.evaluate(() => {
    const video = document.querySelector('video') as HTMLVideoElement;
    const seen = { frames: new Set<string>(), rates: [] as number[], times: [] as number[] };
    (window as unknown as { __flip: typeof seen }).__flip = seen;
    const next = (_now: number, frame: VideoFrameCallbackMetadata) => {
      seen.frames.add(frame.mediaTime.toFixed(3));
      video.requestVideoFrameCallback(next);
    };
    video.requestVideoFrameCallback(next);
    video.addEventListener('ratechange', () => seen.rates.push(video.playbackRate));
  });
}

const watched = (page: Page) =>
  page.evaluate(() => {
    const seen = (window as unknown as { __flip: { frames: Set<string>; rates: number[] } }).__flip;
    return { frames: seen.frames.size, rates: [...seen.rates] };
  });

/** The page the folio prints, and the book's length: "p. 11 / 52". */
async function folio(page: Page): Promise<{ page: number; total: number }> {
  const text = (await page.locator('fb-folio').textContent()) ?? '';
  const match = /(\d+)\s*\/\s*(\d+)/.exec(text);
  if (!match) throw new Error(`no folio in "${text}"`);
  return { page: Number(match[1]), total: Number(match[2]) };
}

/**
 * After a move of the pointer, the film's clock must pass where it stood (`sign` 1 on, -1 back). The film is chased
 * with one seek in flight at a time, so the clock answers a move within a seek, not within the same task: polled.
 */
async function follows(page: Page, from: number, sign: 1 | -1, what: string): Promise<number> {
  let now = from;
  await expect.poll(async () => {
    now = (await media(page)).time;
    return (now - from) * sign;
  }, { message: `${what}: the film stayed at ${from}`, timeout: 2000, intervals: [15, 30, 60] }).toBeGreaterThan(0);
  return now;
}

/** A quick throw along the edge: a few fast moves, let go while still moving. */
async function flick(page: Page, from: number, to: number) {
  const box = await edge(page);
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * from, y);
  await page.mouse.down();
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    if (i > 1) await page.waitForTimeout(12);
    await page.mouse.move(box.x + box.width * (from + ((to - from) * i) / steps), y);
  }
  // Let go while it's still moving: nothing between the last move and the release.
  await page.mouse.up();
}

/**
 * A throw that was taken as one. Whether a release is a flick is a matter of milliseconds between the last move and
 * the lift; a loaded runner can stretch them until it reads as letting go still (the film then rests, paused, and
 * the same throw is made again from there).
 */
async function thrown(page: Page) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await flick(page, 0.1 + attempt * 0.02, 0.3 + attempt * 0.02);
    if ((await flip(page).getAttribute('data-mode')) === 'coast' || !(await media(page)).paused) return;
    await expect(flip(page)).toHaveAttribute('data-mode', 'idle');
  }
  throw new Error('four throws, none taken as a flick');
}

test.describe('the hand on the edge', () => {
  test.beforeEach(() => skipWithout(test, 'deck'));

  test('a drag along the row moves the film with the pointer, forwards and back, and shows its frames', async ({ page }) => {
    await ready(page);
    await startAndHold(page, 5);
    await watch(page);
    const box = await edge(page);
    const y = box.y + box.height / 2;
    const at = (share: number) => box.x + box.width * share;
    await page.mouse.move(at(0.2), y);
    await page.mouse.down();
    await page.mouse.move(at(0.21), y);
    const forwards: number[] = [(await media(page)).time];
    // (A hand's pace: a pointer reports a move a frame at most. Unpaced, WebKit takes all thirty-six moves in 0.4 s,
    // and how many frames a screen can show in that time says nothing about the film following the hand.)
    for (let share = 0.22; share <= 0.6001; share += 0.02) {
      await page.mouse.move(at(share), y);
      forwards.push(await follows(page, forwards.at(-1)!, 1, `forwards to ${share.toFixed(2)}`));
      await page.waitForTimeout(16);
    }
    // The hand has the film: held still under it, marked as a scrub, the chip reading its speed.
    await expect(container(page)).toHaveAttribute('data-fb-deck', 'flip');
    await expect(flip(page)).toHaveAttribute('data-mode', 'drag');
    expect((await media(page)).paused).toBe(true);
    await expect(page.locator('.fb-edge-chip')).toHaveAttribute('data-open', '');
    // A speed a film can be watched at reads as one; faster, the chip says the page going by.
    await expect(page.locator('.fb-edge-chip')).toHaveText(/^(−?[0-4]\.\d×|p\. \d+)$/);
    await expect.poll(async () => Math.abs((await media(page)).time - DURATION * 0.6), { message: 'the film is where the pointer is, seconds' }).toBeLessThan(0.5);
    const backwards: number[] = [(await media(page)).time];
    for (let share = 0.58; share >= 0.2999; share -= 0.02) {
      await page.mouse.move(at(share), y);
      backwards.push(await follows(page, backwards.at(-1)!, -1, `backwards to ${share.toFixed(2)}`));
      await page.waitForTimeout(16);
    }
    // Held still, then let go: it rests there, paused as it was, and everything that stood back returns.
    await page.waitForTimeout(250);
    await page.mouse.up();
    await expect(flip(page)).toHaveAttribute('data-mode', 'idle');
    await expect(container(page)).not.toHaveAttribute('data-fb-deck', /.*/);
    await expect(page.locator('.fb-edge-chip')).not.toHaveAttribute('data-open', /.*/);
    const end = await media(page);
    expect(end.paused).toBe(true);
    expect(end.rate).toBe(1);
    expect(Math.abs(end.time - DURATION * 0.3), `forwards ${forwards.join(' ')}, backwards ${backwards.join(' ')}`).toBeLessThan(0.5);
    // The film itself moved in the picture: real frames were shown along the way, not one at the end.
    expect((await watched(page)).frames, 'frames shown during the drag').toBeGreaterThan(12);
  });

  test('a click on the edge goes there and changes nothing else', async ({ page }) => {
    await ready(page);
    await page.keyboard.press('Space');
    await page.waitForFunction(() => (document.querySelector('video') as HTMLVideoElement).currentTime > 1);
    const box = await edge(page);
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);
    await expect.poll(async () => Math.abs((await media(page)).time - DURATION * 0.5)).toBeLessThan(1.5);
    const after = await media(page);
    expect(after.paused, 'still playing').toBe(false);
    expect(after.rate).toBe(1);
    await expect(container(page)).not.toHaveAttribute('data-fb-deck', 'flip');
  });

  test('a flick leaves the film playing, its rate above 1 and falling to exactly 1', async ({ page }) => {
    await ready(page);
    await startAndHold(page, 4);
    await watch(page);
    await thrown(page);
    // Thrown forwards, a paused film plays: first chased while it's faster than a browser plays, then for real.
    await expect.poll(async () => {
      const now = await media(page);
      return !now.paused && now.rate > 1;
    }, { timeout: 8000 }).toBe(true);
    await expect(flip(page)).toHaveAttribute('data-mode', 'idle', { timeout: 8000 });
    const end = await media(page);
    expect(end.paused).toBe(false);
    expect(end.rate, 'exactly the viewer’s own rate').toBe(1);
    const { rates } = await watched(page);
    expect(rates.length, `rates given: ${rates.join(' ')}`).toBeGreaterThan(4);
    expect(Math.max(...rates)).toBeLessThanOrEqual(4);
    for (let i = 1; i < rates.length; i++) expect(rates[i], `pages settling, never a bounce: ${rates.join(' ')}`).toBeLessThanOrEqual(rates[i - 1]);
    expect(rates.at(-1)).toBe(1);
    await expect(page.locator('.fb-edge-chip')).not.toHaveAttribute('data-open', /.*/);
  });

  // From 1.6× the glide needs about a second more to settle by itself: "at once" is a third of that.
  const AT_ONCE = { timeout: 300 };

  test.describe('a glide ends at once', () => {
    test.beforeEach(async ({ page }) => {
      await ready(page);
      await startAndHold(page, 4);
      await thrown(page);
      await expect.poll(async () => {
        const now = await media(page);
        return !now.paused && now.rate > 1.6;
      }, { timeout: 8000, intervals: [20] }).toBe(true);
    });

    test('for a key', async ({ page }) => {
      // A key that does nothing of its own to the film: it just ends the glide, and the film is simply playing.
      await focusPlayer(page);
      await page.keyboard.press('Shift+F9');
      await expect(flip(page)).toHaveAttribute('data-mode', 'idle', AT_ONCE);
      const now = await media(page);
      expect(now.rate).toBe(1);
      expect(now.paused).toBe(false);
    });

    test('for the play key', async ({ page }) => {
      await page.locator('.fb-play').click();
      await expect(flip(page)).toHaveAttribute('data-mode', 'idle', AT_ONCE);
      const now = await media(page);
      expect(now.paused, 'paused, as asked').toBe(true);
      expect(now.rate).toBe(1);
    });

    test('for a new touch on the edge, which takes the film', async ({ page }) => {
      const row = await edge(page);
      await page.mouse.move(row.x + row.width * 0.5, row.y + row.height / 2);
      // The edge is there to be touched (a playing film's controls fade when nothing moves; the move brought them back).
      await expect(container(page)).toHaveAttribute('data-controls-visible', '');
      await page.mouse.down();
      await expect(flip(page)).toHaveAttribute('data-mode', 'drag');
      expect((await media(page)).rate).toBe(1);
      expect((await media(page)).paused).toBe(true);
      await page.waitForTimeout(250);
      await page.mouse.up();
      // It was playing under the glide: let go still, it plays on from there.
      await expect(flip(page)).toHaveAttribute('data-mode', 'idle', AT_ONCE);
      await expect.poll(async () => (await media(page)).paused).toBe(false);
      expect((await media(page)).rate).toBe(1);
    });

    test('for a touch on the picture', async ({ page }) => {
      const box = await container(page).boundingBox();
      if (!box) throw new Error('no player');
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.4);
      await page.mouse.down();
      await expect(flip(page)).toHaveAttribute('data-mode', 'idle');
      expect((await media(page)).rate).toBe(1);
      await page.mouse.up();
    });
  });

  test('a held arrow riffles faster the longer it is held, and settles on a page when released', async ({ page }) => {
    await ready(page);
    await startAndHold(page, 3);
    await focusPlayer(page);
    const before = await folio(page);
    await page.keyboard.down('ArrowRight');
    // The press itself turns one page (paused); held, the riffle begins.
    await expect(flip(page)).toHaveAttribute('data-mode', 'keys');
    const sample = async () => ({ at: Date.now(), time: (await media(page)).time });
    await page.waitForTimeout(150);
    const a = await sample();
    await page.waitForTimeout(450);
    const b = await sample();
    await page.waitForTimeout(700);
    const c = await sample();
    await page.waitForTimeout(450);
    const d = await sample();
    const early = (b.time - a.time) / ((b.at - a.at) / 1000);
    const late = (d.time - c.time) / ((d.at - c.at) / 1000);
    expect(early, 'film seconds per second, early').toBeGreaterThan(2);
    expect(late, `late ${late.toFixed(1)} against early ${early.toFixed(1)}`).toBeGreaterThan(early * 1.5);
    await page.keyboard.up('ArrowRight');
    await expect(flip(page)).toHaveAttribute('data-mode', 'idle', { timeout: 6000 });
    await page.waitForFunction(() => !(document.querySelector('video') as HTMLVideoElement).seeking);
    const end = await media(page);
    expect(end.paused, 'paused before, paused after').toBe(true);
    expect(end.rate).toBe(1);
    expect((await folio(page)).page).toBeGreaterThan(before.page + 3);
    // Settled on a page's own start (its first 0.2 s), not somewhere inside it.
    const into = await page.evaluate(async () => {
      const video = document.querySelector('video') as HTMLVideoElement;
      const track = [...video.textTracks].find((t) => t.kind === 'metadata' && t.label === 'thumbnails');
      const cue = [...(track?.cues ?? [])].find((c) => video.currentTime >= c.startTime && video.currentTime < c.endTime);
      return cue ? video.currentTime - cue.startTime : -1;
    });
    if (into >= 0) expect(into).toBeLessThan(0.2);
    // Resting, the page is said once.
    await expect(page.locator('div.fb-voice[role="status"]')).toHaveText(/^Page \d+ of \d+, .+, \d+:\d\d$/);
  });

  test('a held arrow on a playing film plays on at exactly 1× when released', async ({ page }) => {
    await ready(page);
    await page.keyboard.press('Space');
    await page.waitForFunction(() => (document.querySelector('video') as HTMLVideoElement).currentTime > 1);
    await page.keyboard.down('ArrowRight');
    await expect(flip(page)).toHaveAttribute('data-mode', 'keys');
    await page.waitForTimeout(600);
    await page.keyboard.up('ArrowRight');
    await expect(flip(page)).toHaveAttribute('data-mode', 'idle', { timeout: 6000 });
    await expect.poll(async () => (await media(page)).paused).toBe(false);
    expect((await media(page)).rate).toBe(1);
  });

  test('the wheel over the edge riffles; a scroll passing over it is left to the page', async ({ page }) => {
    await ready(page);
    await startAndHold(page, 10);
    const box = await edge(page);
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
    await page.waitForTimeout(300);
    const from = (await media(page)).time;
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, 60);
      await page.waitForTimeout(30);
    }
    await expect(flip(page)).toHaveAttribute('data-mode', 'idle', { timeout: 3000 });
    const forward = (await media(page)).time;
    expect(forward, 'wheel down or right goes on').toBeGreaterThan(from + 2);
    await page.waitForTimeout(300);
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(-60, 0);
      await page.waitForTimeout(30);
    }
    await expect(flip(page)).toHaveAttribute('data-mode', 'idle', { timeout: 3000 });
    expect((await media(page)).time, 'and back').toBeLessThan(forward - 2);

    // A scroll that began over the picture and carries onto the edge is the page's: the film doesn't move.
    const frame = await container(page).boundingBox();
    if (!frame) throw new Error('no player');
    await page.waitForTimeout(400);
    const rest = (await media(page)).time;
    await page.mouse.move(frame.x + frame.width * 0.5, frame.y + frame.height * 0.4);
    await page.mouse.wheel(0, 40);
    await page.waitForTimeout(40);
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
    await page.mouse.wheel(0, 40);
    await page.waitForTimeout(40);
    await page.mouse.wheel(0, 40);
    await page.waitForTimeout(300);
    expect((await media(page)).time).toBe(rest);
  });
});

test.describe('the paused print', () => {
  test.beforeEach(() => skipWithout(test, 'deck'));

  test('the margin is the size print.ts states, inside the player’s own box', async ({ page }) => {
    await ready(page);
    const frame = () => container(page).evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    const picture = () => page.locator('video').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    const playing = await frame();
    await startAndHold(page, 20);
    await expect(container(page)).toHaveAttribute('data-fb-print', '');
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
    const box = await frame();
    expect(box, 'nothing outside the player moves').toEqual(playing);
    // 2.4 % of the picture's width, 10 to 28 px, a whole even number.
    const margin = 2 * Math.round(Math.min(28, Math.max(10, box.w * 0.024)) / 2);
    const inside = await picture();
    expect(Math.abs(inside.x - box.x - margin), `left margin, want ${margin}`).toBeLessThan(0.6);
    expect(Math.abs(box.x + box.w - (inside.x + inside.w) - margin), `right margin, want ${margin}`).toBeLessThan(0.6);
    expect(inside.y - box.y, 'top margin').toBeGreaterThan(margin * 0.3);
    expect(box.y + box.h - (inside.y + inside.h), 'bottom margin').toBeGreaterThan(margin * 0.3);
    const paper = await page.locator('.fb-print-frame').evaluate((el) => {
      const style = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { opacity: style.opacity, left: parseFloat(style.borderLeftWidth), right: parseFloat(style.borderRightWidth), top: parseFloat(style.borderTopWidth), x: r.x, w: r.width, colour: style.borderLeftColor };
    });
    expect(paper.opacity).toBe('1');
    expect(paper.left, 'the paper reaches the picture').toBe(margin);
    expect(paper.right).toBe(margin);
    expect(paper.top).toBeGreaterThanOrEqual(Math.floor(inside.y - box.y));
    expect(Math.abs(paper.x - box.x)).toBeLessThan(0.6);
    // With 20 px or more of margin the folio and chapter are printed in it, on whole pixels.
    if (margin >= 20) {
      const stamp = await page.locator('.fb-stamp').evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, right: r.right, y: r.y, text: el.textContent, chapter: getComputedStyle(el, '::after').content, opacity: getComputedStyle(el).opacity };
      });
      expect(stamp.opacity).toBe('1');
      expect(stamp.text).toMatch(/^p\. \d+$/);
      expect(stamp.chapter, 'the chapter follows the folio').toMatch(/·/);
      expect(stamp.x, 'inside the left margin').toBeGreaterThanOrEqual(box.x);
      expect(stamp.right).toBeLessThanOrEqual(box.x + margin);
      expect(Number.isInteger(stamp.x) && Number.isInteger(stamp.y), `whole pixels: ${stamp.x}, ${stamp.y}`).toBe(true);
    }
    // In and out inside the motion band, on transform and opacity alone.
    const motion = await page.evaluate(() => {
      const video = getComputedStyle(document.querySelector('video') as Element);
      const paper = getComputedStyle(document.querySelector('.fb-print-frame') as Element);
      return { video: [video.transitionProperty, video.transitionDuration], paper: [paper.transitionProperty, paper.transitionDuration] };
    });
    expect(motion.video).toEqual(['transform', '0.25s']);
    expect(motion.paper).toEqual(['opacity', '0.25s']);
    // Play: the margin goes, the page is film again.
    await page.keyboard.press('Space');
    await expect(container(page)).not.toHaveAttribute('data-fb-print', /.*/);
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
    await expect.poll(async () => (await picture()).w).toBe(box.w);
    await expect(page.locator('.fb-print-frame')).toHaveCSS('opacity', '0');
  });

  test('← and → turn exactly one page; with Shift, or , and ., one frame', async ({ page }) => {
    await ready(page);
    // (The frame on screen, as the browser names it, from here on.)
    await page.evaluate(() => {
      const video = document.querySelector('video') as HTMLVideoElement;
      const shown = (_now: number, frame: VideoFrameCallbackMetadata) => {
        (window as unknown as { __shown: number }).__shown = frame.mediaTime;
        video.requestVideoFrameCallback(shown);
      };
      video.requestVideoFrameCallback(shown);
    });
    await startAndHold(page, 20.3);
    await focusPlayer(page);
    const start = await folio(page);
    const pageNow = async () => (await folio(page)).page;
    await page.keyboard.press('ArrowRight');
    await expect.poll(pageNow).toBe(start.page + 1);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(pageNow).toBe(start.page);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(pageNow).toBe(start.page - 1);
    expect((await media(page)).paused).toBe(true);
    // One page turned over: a sheet of the picture, 150 to 250 ms, transform and opacity only.
    const turn = await page.evaluate(() =>
      [...document.querySelectorAll('.fb-print-sheet')].flatMap((sheet) => sheet.getAnimations()).map((a) => {
        const effect = a.effect as KeyframeEffect;
        const properties = new Set(effect.getKeyframes().flatMap((k) => Object.keys(k)).filter((k) => !['offset', 'easing', 'composite', 'computedOffset'].includes(k)));
        return { duration: Number(effect.getTiming().duration), properties: [...properties].sort() };
      }),
    );
    expect(turn.length, 'a page is in the air').toBeGreaterThan(0);
    for (const sheet of turn) {
      expect(sheet.duration).toBeGreaterThanOrEqual(150);
      expect(sheet.duration).toBeLessThanOrEqual(250);
      expect(sheet.properties).toEqual(['opacity', 'transform']);
    }
    // Resting, the page is said once: "Page 16 of 52, Chapter, 0:19".
    await expect(page.locator('div.fb-voice[role="status"]')).toHaveText(new RegExp(`^Page ${start.page - 1} of ${start.total}, .+, \\d+:\\d\\d$`));

    // One frame of a 24-frames-a-second film. A step goes by the frame on screen, as the browser names it, and is
    // taken when that frame is shown (flip.ts, #step; steps.spec.ts holds the rest). So the frame is read as the
    // browser names it too, not from the clock: Safari may show the frame after the one its paused clock is in.
    await page.waitForFunction(() => !(document.querySelector('video') as HTMLVideoElement).seeking);
    // (The frame the name falls in: Firefox names a frame it shows for a seek by the moment asked for, inside it.)
    const frame = () => page.evaluate((span) => Math.floor((window as unknown as { __shown: number }).__shown / span + 0.001), FRAME);
    // Where the step starts: the frame on screen. (After a paused seek Safari may name its frame a moment late, and
    // now and then names none at all for that place: the step then goes from the frame the clock is in, flip.ts.)
    await expect.poll(() => page.evaluate(() => Math.abs((window as unknown as { __shown: number }).__shown - (document.querySelector('video') as HTMLVideoElement).currentTime)), { message: 'the frame on screen, from the clock (s)', timeout: 1500 }).toBeLessThan(FRAME * 1.5).catch(() => undefined);
    const named = await page.evaluate(() => Math.abs((window as unknown as { __shown: number }).__shown - (document.querySelector('video') as HTMLVideoElement).currentTime) < 1);
    const before = named ? await frame() : Math.floor((await media(page)).time / FRAME + 0.001);
    await page.keyboard.press('Shift+ArrowRight');
    await expect.poll(frame, { message: 'Shift and → is one frame on' }).toBe(before + 1);
    await page.keyboard.press('.');
    await expect.poll(frame, { message: '. is one frame on' }).toBe(before + 2);
    await page.keyboard.press(',');
    await page.keyboard.press('Shift+ArrowLeft');
    await expect.poll(frame, { message: ', and Shift and ← are two frames back' }).toBe(before);
    await page.waitForTimeout(300);
    expect(await frame(), 'and it rests there').toBe(before);
    expect(await pageNow()).toBe(start.page - 1);
  });

  test('the second press never waits for the first: two quick presses are two pages', async ({ page }) => {
    await ready(page);
    await startAndHold(page, 20.3);
    await focusPlayer(page);
    const start = await folio(page);
    const pressed = Date.now();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    // Both pages are in the air at once.
    const inAir = await page.evaluate(() => [...document.querySelectorAll('.fb-print-sheet')].filter((sheet) => sheet.getAnimations().some((a) => a.playState === 'running')).length);
    if (Date.now() - pressed < 200) expect(inAir, 'two sheets turning').toBe(2);
    // (The folio is printed from the player's store, a moment after the film's own clock.)
    await expect.poll(async () => (await folio(page)).page).toBe(start.page + 2);
    await page.waitForFunction(() => [...document.querySelectorAll('.fb-print-sheet')].every((sheet) => sheet.getAnimations().length === 0));
    expect(Date.now() - pressed, 'both down within the band of one turn and the gap between the presses').toBeLessThan(1200);
    expect((await media(page)).paused).toBe(true);
    await expect(container(page)).toHaveAttribute('data-fb-print', '');
  });

  test('playing, an arrow is still five seconds, and Shift with an arrow goes one page on', async ({ page }) => {
    await ready(page);
    await page.keyboard.press('Space');
    await page.waitForFunction(() => (document.querySelector('video') as HTMLVideoElement).currentTime > 1);
    const a = (await media(page)).time;
    await page.keyboard.press('ArrowRight');
    const b = (await media(page)).time;
    expect(b - a).toBeGreaterThan(4.5);
    expect(b - a).toBeLessThan(6);
    const from = await folio(page);
    await page.keyboard.press('Shift+ArrowRight');
    await expect.poll(async () => (await folio(page)).page).toBeGreaterThanOrEqual(from.page + 1);
    expect((await folio(page)).page).toBeLessThanOrEqual(from.page + 2);
    expect((await media(page)).paused).toBe(false);
  });
});

test.describe('the slider underneath', () => {
  test.beforeEach(() => skipWithout(test, 'deck'));

  test('keeps its role, its value text and its keys', async ({ page }) => {
    await ready(page);
    await startAndHold(page, 20);
    const slider = page.locator('media-time-slider [role="slider"]');
    await expect(slider).toHaveCount(1);
    const read = () => slider.evaluate((el) => ({
      now: Number(el.getAttribute('aria-valuenow')),
      min: el.getAttribute('aria-valuemin'),
      max: Number(el.getAttribute('aria-valuemax')),
      text: el.getAttribute('aria-valuetext'),
      label: el.getAttribute('aria-label') ?? el.getAttribute('aria-labelledby'),
      orientation: el.getAttribute('aria-orientation'),
    }));
    const first = await read();
    expect(first.min).toBe('0');
    expect(first.max).toBeGreaterThan(0);
    expect(first.text).toBeTruthy();
    expect(first.label).toBeTruthy();
    // A drag by hand: the value and its text follow.
    const box = await edge(page);
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.3, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, y, { steps: 8 });
    await page.waitForTimeout(250);
    await page.mouse.up();
    await expect.poll(async () => (await read()).text).not.toBe(first.text);
    const share = async () => {
      const value = await read();
      return value.now / value.max;
    };
    expect(Math.abs((await share()) - 0.5)).toBeLessThan(0.03);
    // Its own keys, with focus on it: an arrow moves the value, Home and End go to the ends, Page Down to a chapter.
    await slider.focus();
    const at = await share();
    await page.keyboard.press('ArrowRight');
    await expect.poll(share).toBeGreaterThan(at);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect.poll(share).toBeLessThan(at);
    await page.keyboard.press('Home');
    await expect.poll(share).toBeLessThan(0.01);
    await page.keyboard.press('PageDown');
    await expect.poll(async () => (await media(page)).time).toBeGreaterThan(5);
    await page.keyboard.press('End');
    await expect.poll(share).toBeGreaterThan(0.98);
  });
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });
  test.beforeEach(() => skipWithout(test, 'deck'));

  test('the picture still follows the hand; there is no glide and nothing animates', async ({ page }) => {
    await ready(page);
    await startAndHold(page, 4);
    await watch(page);
    const animations: string[] = [];
    await page.exposeFunction('__animated', (what: string) => animations.push(what));
    await page.evaluate(() => {
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (this: Element, ...args: Parameters<typeof animate>) {
        void (window as unknown as { __animated: (what: string) => void }).__animated(this.className || this.tagName);
        return animate.apply(this, args);
      };
    });
    // The same throw that glides otherwise: here it stops where it was let go, paused as it was.
    await flick(page, 0.1, 0.3);
    await expect(flip(page)).toHaveAttribute('data-mode', 'idle');
    await page.waitForTimeout(500);
    const end = await media(page);
    expect(end.paused, 'no glide into playing').toBe(true);
    expect(end.rate).toBe(1);
    expect(Math.abs(end.time - DURATION * 0.3), 'where it was let go').toBeLessThan(1);
    const seen = await watched(page);
    expect(seen.rates, 'the rate is never touched').toEqual([]);
    expect(seen.frames, 'the picture followed the hand').toBeGreaterThan(2);
    // A page turn is instant: no sheet, no transition, and the margin is simply there.
    await focusPlayer(page);
    const start = await folio(page);
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await folio(page)).page).toBe(start.page + 1);
    expect(animations, 'nothing was animated').toEqual([]);
    expect(await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length)).toBe(0);
    await expect(container(page)).toHaveAttribute('data-fb-print', '');
    await expect(page.locator('video')).toHaveCSS('transition-duration', '0s');
    await expect(page.locator('.fb-print-frame')).toHaveCSS('transition-duration', '0s');
    await expect(page.locator('.fb-print-frame')).toHaveCSS('opacity', '1');
  });
});

test.describe('essential', () => {
  test('has none of it: the edge is Video.js’s own slider, and nothing of the flip is fetched or styled', async ({ page }) => {
    const asked: string[] = [];
    page.on('request', (request) => asked.push(new URL(request.url()).pathname));
    await open(page, `${BARE}&features=essential`);
    await startAndHold(page, 20);
    await expect(page.locator('fb-flip')).toHaveCount(0);
    await expect(container(page)).not.toHaveAttribute('data-fb-flip', /.*/);
    const box = await edge(page);
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => Math.abs((await media(page)).time - DURATION * 0.5)).toBeLessThan(1.5);
    await expect(container(page)).not.toHaveAttribute('data-fb-deck', /.*/);
    // Paused, an arrow is still Video.js's five seconds.
    await focusPlayer(page);
    const a = (await media(page)).time;
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await media(page)).time - a).toBeGreaterThan(4.5);
    expect(asked.filter((path) => /\/assets\/(deck|flip|flutter|print)-[\w-]+\.js$/.test(path))).toEqual([]);
    const styled = await page.evaluate(() => {
      const out: string[] = [];
      const walk = (rules: CSSRuleList) => {
        for (const rule of rules) {
          if (rule instanceof CSSStyleRule && /fb-print-|data-fb-flip|fb-flip\b/.test(rule.selectorText)) out.push(rule.selectorText);
          if ('cssRules' in rule && (rule as CSSGroupingRule).cssRules) walk((rule as CSSGroupingRule).cssRules);
        }
      };
      for (const sheet of [...document.styleSheets, ...document.adoptedStyleSheets]) {
        try {
          walk(sheet.cssRules);
        } catch {
          // Not ours.
        }
      }
      return out;
    });
    expect(styled).toEqual([]);
  });
});
