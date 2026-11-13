import { type Page } from '@playwright/test';
import { BARE, DURATION, media, open, skipWithout, startAndHold } from './support/player';
import { expect, test } from './support/test';

/**
 * A mouse on the fore-edge: hover, click, hold and drag, and every way a drag can end (src/skins/flipbook/flip.ts,
 * "Who has the film", is the state machine these hold the code to; deck.ts is the hover).
 *
 * - Hover shows the deck; a click goes there and shuts it at once, playing or paused as it was, and a pointer left
 *   resting on the edge opens nothing until it moves on.
 * - A click is a press under 4 px and 250 ms: it never pauses the film, not for a blink.
 * - A drag moves the film; let go still it rests there as it was before the press, let go moving it plays on near
 *   where the hand let go, its rate falling to exactly 1. A hand's pause is never the viewer's: no print.
 * - Escape puts the film back where the press began. A pointer lost any other way ends the drag at rest.
 * - Whatever happened, a moment after the hand has gone nothing of it is left on the player.
 *
 * Real mouse input throughout (`page.mouse`), on the production build, at 1440 and 1024 wide. Each check reads the
 * running page: the video's own clock and rate, attributes as they change, computed styles.
 */

const SIZES = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
];

const container = (page: Page) => page.locator('media-container');
const flip = (page: Page) => page.locator('fb-flip');
const deck = (page: Page) => page.locator('fb-deck');

async function ready(page: Page) {
  await open(page, BARE);
  await expect(container(page)).toHaveAttribute('data-fb-flip', '');
  await page.locator('media-time-slider').scrollIntoViewIfNeeded();
}

async function edge(page: Page) {
  const box = await page.locator('media-time-slider').boundingBox();
  if (!box) throw new Error('no fore-edge');
  const y = box.y + box.height / 2;
  return { ...box, y, at: (share: number) => box.x + box.width * share };
}

/** The film playing from the keyboard, a little way in. */
async function playing(page: Page) {
  await page.keyboard.press('Space');
  await page.waitForFunction(() => {
    const video = document.querySelector('video') as HTMLVideoElement;
    return !video.paused && video.currentTime > 1.2;
  });
}

interface Seen {
  pauses: number;
  plays: number;
  prints: number;
  plates: number;
  rates: number[];
  /** Milliseconds from the last press on the player to the deck being put away (-1: it was not up, or never went). */
  shut: number;
  /** How long the last press lasted, in milliseconds. */
  held: number;
}

/** From now on: every pause and play of the film, every rate it is given, every time the page prints or the plate opens. */
async function watch(page: Page) {
  await page.evaluate(() => {
    const video = document.querySelector('video') as HTMLVideoElement;
    const player = document.querySelector('media-container') as HTMLElement;
    const seen = { pauses: 0, plays: 0, prints: 0, plates: 0, rates: [] as number[], shut: -1, held: -1 };
    const deck = player.querySelector('fb-deck') as HTMLElement;
    let pressed = 0;
    // Before the skin hears it (capture, on the document), so the time is the press's own.
    document.addEventListener('pointerdown', () => {
      pressed = performance.now();
      seen.shut = -1;
    }, true);
    document.addEventListener('pointerup', () => {
      seen.held = performance.now() - pressed;
    }, true);
    new MutationObserver(() => {
      if (pressed && seen.shut < 0 && !deck.hasAttribute('data-active') && !player.hasAttribute('data-fb-deck')) seen.shut = performance.now() - pressed;
    }).observe(player, { attributes: true, subtree: true, attributeFilter: ['data-active', 'data-fb-deck'] });
    (window as unknown as { __edge: typeof seen }).__edge = seen;
    video.addEventListener('pause', () => seen.pauses++);
    video.addEventListener('play', () => seen.plays++);
    video.addEventListener('ratechange', () => seen.rates.push(video.playbackRate));
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.attributeName === 'data-fb-print' && player.hasAttribute('data-fb-print')) seen.prints++;
        if (record.attributeName === 'data-fb-plate' && player.hasAttribute('data-fb-plate')) seen.plates++;
      }
    }).observe(player, { attributes: true, attributeFilter: ['data-fb-print', 'data-fb-plate'] });
  });
}

const seen = (page: Page) => page.evaluate(() => (window as unknown as { __edge: Seen }).__edge);

/** What a hand leaves on the player while it has the film. All of it must be gone a moment after it has let go. */
const leftovers = (page: Page) =>
  page.evaluate(() => {
    const player = document.querySelector('media-container') as HTMLElement;
    const slider = player.querySelector('media-time-slider') as HTMLElement;
    const shown = (selector: string) =>
      [...player.querySelectorAll<HTMLElement>(selector)].some((el) => {
        const style = getComputedStyle(el);
        return style.visibility !== 'hidden' && Number(style.opacity) > 0.01 && el.getBoundingClientRect().width > 0;
      });
    const left: string[] = [];
    const mode = player.querySelector<HTMLElement>('fb-flip')?.dataset.mode;
    if (mode !== 'idle') left.push(`fb-flip is ${mode}`);
    if (player.hasAttribute('data-fb-deck')) left.push(`data-fb-deck="${player.getAttribute('data-fb-deck')}"`);
    if (player.querySelector('fb-deck')?.hasAttribute('data-active')) left.push('the deck is up');
    if (player.querySelector('fb-flip')?.hasAttribute('data-fine')) left.push('data-fine');
    if (shown('.fb-edge-chip')) left.push('the chip over the ribbon');
    if (shown('.fb-pace-chip')) left.push('the chip on the picture');
    if (shown('.fb-fan')) left.push('the fan');
    // (The mouse is pointer 1 in Chromium and WebKit, 0 in Firefox.)
    for (const id of [0, 1, 2, 3, 4]) {
      try {
        if (slider.hasPointerCapture(id)) left.push(`pointer ${id} is still captured`);
      } catch {
        // No such pointer.
      }
    }
    if (String(getSelection())) left.push('a text selection');
    return left;
  });

/** Nothing of the hand is left a moment after it has gone: 300 ms, and the time it takes to ask the page. */
const gone = (page: Page) => expect.poll(() => leftovers(page), { timeout: 350, intervals: [40] }).toEqual([]);

/** Nothing of the hand is left, and the film and its play key are as expected. */
async function clean(page: Page, expected: { paused: boolean }) {
  await gone(page);
  await expect.poll(async () => (await media(page)).paused, { timeout: 1000 }).toBe(expected.paused);
  await expect(page.locator('#flipbook-play')).toHaveAttribute('aria-label', expected.paused ? 'Play' : 'Pause');
}

async function dragTo(page: Page, from: number, to: number, steps = 20, every = 16) {
  const row = await edge(page);
  await page.mouse.move(row.at(from), row.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(row.at(from + ((to - from) * i) / steps), row.y);
    await page.waitForTimeout(every);
  }
  return row;
}

/** The pointer comes to rest on the edge, as a hand looking for a moment does: the deck opens on it. */
async function hover(page: Page, share: number) {
  const row = await edge(page);
  await page.mouse.move(row.at(share) - 40, row.y);
  await page.mouse.move(row.at(share), row.y, { steps: 5 });
  await expect(deck(page)).toHaveAttribute('data-mode', 'hover');
  await expect(container(page)).toHaveAttribute('data-fb-deck', 'open');
  return row;
}

for (const size of SIZES) {
  test.describe(`a mouse on the fore-edge, ${size.width} wide`, () => {
    test.use({ viewport: size });
    test.beforeEach(() => skipWithout(test, 'deck'));

    test('hover, then click: the film goes there, the deck is gone at once and stays gone under a resting pointer', async ({ page }) => {
      await ready(page);
      await playing(page);
      const row = await hover(page, 0.6);
      await watch(page);
      await page.mouse.down();
      await page.mouse.up();
      await clean(page, { paused: false });
      // Gone with the press itself: not closing, gone, in the task that heard the press (a frame is 16 ms).
      const press = await seen(page);
      expect(press.held, 'the press was a click, ms').toBeLessThan(250);
      expect(press.shut, 'ms from the press to the deck being gone').toBeGreaterThanOrEqual(0);
      expect(press.shut, 'ms from the press to the deck being gone').toBeLessThan(16);
      const now = await media(page);
      expect(Math.abs(now.time - DURATION * 0.6), 'at the click').toBeLessThan(1.5);
      expect(now.rate).toBe(1);
      // The pointer rests where it clicked: three seconds on, nothing has come back.
      await page.waitForTimeout(3000);
      expect(await leftovers(page)).toEqual([]);
      expect((await media(page)).paused).toBe(false);
      const during = await seen(page);
      expect(during.pauses, 'a click never pauses the film').toBe(0);
      expect(during.prints, 'nor prints the page').toBe(0);
      expect(during.rates, 'nor touches its rate').toEqual([]);
      // It moves on: the deck is the hover's again.
      await page.mouse.move(row.at(0.6) + 60, row.y, { steps: 6 });
      await expect(deck(page)).toHaveAttribute('data-mode', 'hover');
    });

    test('hover, then click on a paused film: it stays paused on the new page, printed, the deck gone', async ({ page }) => {
      await ready(page);
      await startAndHold(page, 4);
      await hover(page, 0.6);
      await watch(page);
      await page.mouse.down();
      await page.mouse.up();
      await clean(page, { paused: true });
      expect((await seen(page)).shut, 'ms from the press to the deck being gone').toBeLessThan(16);
      await expect.poll(async () => Math.abs((await media(page)).time - DURATION * 0.6)).toBeLessThan(1.5);
      await expect(container(page)).toHaveAttribute('data-fb-print', '');
      await page.waitForTimeout(1500);
      expect(await leftovers(page)).toEqual([]);
      expect((await seen(page)).plays, 'a click never plays a paused film').toBe(0);
    });

    test('a click a hand takes its time over (some 200 ms) is still a click: the film never pauses', async ({ page }) => {
      await ready(page);
      await playing(page);
      const row = await edge(page);
      await page.mouse.move(row.at(0.5), row.y);
      await watch(page);
      await page.mouse.down();
      await page.waitForTimeout(170);
      await page.mouse.up();
      await clean(page, { paused: false });
      const during = await seen(page);
      // (Where a loaded machine stretched the press past a click's length, it was a hold, and this says nothing.)
      test.skip(during.held >= 245, `the press lasted ${Math.round(during.held)} ms: not a click`);
      expect(during.held, 'longer than the old click (140 ms)').toBeGreaterThan(150);
      expect(during.pauses).toBe(0);
      expect(during.prints).toBe(0);
    });

    test('two clicks, one after the other, and a double click: the film is at the last one, playing', async ({ page }) => {
      await ready(page);
      await playing(page);
      const row = await edge(page);
      await watch(page);
      await page.mouse.click(row.at(0.3), row.y);
      await page.mouse.click(row.at(0.7), row.y);
      await clean(page, { paused: false });
      expect(Math.abs((await media(page)).time - DURATION * 0.7)).toBeLessThan(1.5);
      // The pointer arrives, as a hand's does, and then clicks twice: its arrival is not a hover to act on after them.
      await page.mouse.move(row.at(0.4) - 30, row.y);
      await page.mouse.move(row.at(0.4), row.y, { steps: 3 });
      await page.mouse.dblclick(row.at(0.4), row.y);
      await clean(page, { paused: false });
      expect(Math.abs((await media(page)).time - DURATION * 0.4)).toBeLessThan(1.5);
      // The pointer rests on the edge after them: the deck's hover does not take that for pointing.
      await page.waitForTimeout(800);
      expect(await leftovers(page)).toEqual([]);
      expect((await seen(page)).pauses).toBe(0);
    });

    test('a drag on a playing film, held, let go still: it plays on from there at 1×, and the page never printed', async ({ page }) => {
      await ready(page);
      await playing(page);
      await watch(page);
      const row = await dragTo(page, 0.2, 0.6, 30);
      await expect(flip(page)).toHaveAttribute('data-mode', 'drag');
      expect((await media(page)).paused, 'held by the hand').toBe(true);
      await page.waitForTimeout(500);
      await page.mouse.up();
      await clean(page, { paused: false });
      const now = await media(page);
      expect(now.rate).toBe(1);
      expect(Math.abs(now.time - DURATION * 0.6)).toBeLessThan(1.5);
      const during = await seen(page);
      expect(during.prints, 'the hand’s pause is not the viewer’s: no print').toBe(0);
      expect(during.plates, 'and no plate').toBe(0);
      // The pointer moves on along the edge: the deck is the hover's again (it is not locked out by the drag).
      await page.mouse.move(row.at(0.6) + 80, row.y, { steps: 8 });
      await expect(deck(page)).toHaveAttribute('data-mode', 'hover');
      // And off the player: the controls go as they do for a film left alone.
      await page.mouse.move(row.at(0.5), 4, { steps: 4 });
      await expect(container(page)).not.toHaveAttribute('data-controls-visible', /.*/, { timeout: 6000 });
      // The deck it had opened on the way closes up calmly, as for any pointer that leaves.
      await gone(page);
    });

    test('a drag let go while still moving: the film plays on near there, its rate falling to exactly 1', async ({ page }) => {
      await ready(page);
      await playing(page);
      await watch(page);
      // A third of the film in a tenth of a second: a hand's own speed is hundreds of times the film's.
      await dragTo(page, 0.2, 0.5, 6, 12);
      await page.mouse.up();
      await expect.poll(async () => (await media(page)).paused, { timeout: 1000 }).toBe(false);
      await expect(flip(page)).toHaveAttribute('data-mode', 'idle', { timeout: 4000 });
      await clean(page, { paused: false });
      const now = await media(page);
      expect(now.rate).toBe(1);
      expect(now.time - DURATION * 0.5, 'seconds on from where the hand let go').toBeGreaterThan(-0.5);
      expect(now.time - DURATION * 0.5, 'seconds on from where the hand let go').toBeLessThan(8);
      const during = await seen(page);
      expect(Math.max(...during.rates), `rates: ${during.rates.join(' ')}`).toBeLessThanOrEqual(4);
      for (let i = 1; i < during.rates.length; i++) expect(during.rates[i], `never a bounce: ${during.rates.join(' ')}`).toBeLessThanOrEqual(during.rates[i - 1]);
      expect(during.prints).toBe(0);
    });

    test('a drag on a paused film, let go still: paused on that page, printed again', async ({ page }) => {
      await ready(page);
      await startAndHold(page, 4);
      await watch(page);
      await dragTo(page, 0.3, 0.7, 24);
      await expect(container(page)).not.toHaveAttribute('data-fb-print', /.*/);
      await page.waitForTimeout(400);
      await page.mouse.up();
      await clean(page, { paused: true });
      expect(Math.abs((await media(page)).time - DURATION * 0.7)).toBeLessThan(1.5);
      await expect(container(page)).toHaveAttribute('data-fb-print', '');
      const during = await seen(page);
      expect(during.plays).toBe(0);
      expect(during.plates).toBe(0);
    });

    test('a drag from the cover, on a film that has never played: at rest on that page, paused, nothing left open', async ({ page }) => {
      await ready(page);
      await dragTo(page, 0.1, 0.5, 24);
      await page.waitForTimeout(300);
      await page.mouse.up();
      await clean(page, { paused: true });
      expect(Math.abs((await media(page)).time - DURATION * 0.5)).toBeLessThan(1.5);
      await expect(container(page)).not.toHaveAttribute('data-fb-jacket', /.*/);
    });

    test('Escape during a drag: the film is back where the press began, playing as it was', async ({ page }) => {
      await ready(page);
      await playing(page);
      const before = (await media(page)).time;
      await dragTo(page, 0.3, 0.7, 15);
      await expect(flip(page)).toHaveAttribute('data-mode', 'drag');
      await page.keyboard.press('Escape');
      await clean(page, { paused: false });
      const now = await media(page);
      expect(now.time - before, 'seconds on from where it was pressed').toBeGreaterThan(-0.2);
      expect(now.time - before).toBeLessThan(2.5);
      // The button is still down: moving it now moves nothing.
      const row = await edge(page);
      await page.mouse.move(row.at(0.9), row.y, { steps: 4 });
      await page.mouse.up();
      await page.waitForTimeout(200);
      expect((await media(page)).time - before).toBeLessThan(3.5);
      expect(await leftovers(page)).toEqual([]);
    });

    for (const [how, lose] of [
      ['the window loses focus', (page: Page) => page.evaluate(() => void window.dispatchEvent(new Event('blur')))],
      ['a context menu opens', (page: Page) => page.evaluate(() => void document.querySelector('media-time-slider')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))],
      ['the browser takes the pointer back', (page: Page) => page.evaluate(() => {
        const slider = document.querySelector('media-time-slider') as HTMLElement;
        for (const id of [0, 1, 2, 3, 4]) {
          try {
            if (slider.hasPointerCapture(id)) slider.releasePointerCapture(id);
          } catch {
            // No such pointer.
          }
        }
      })],
    ] as const) {
      test(`a drag ends at rest where it is when ${how}`, async ({ page }) => {
        await ready(page);
        await playing(page);
        const row = await dragTo(page, 0.3, 0.6, 15);
        await expect(flip(page)).toHaveAttribute('data-mode', 'drag');
        await lose(page);
        // (A browser says a capture is lost with the pointer's next event: the hand is still there, and moves.)
        await page.mouse.move(row.at(0.6) + 1, row.y);
        await clean(page, { paused: false });
        expect(Math.abs((await media(page)).time - DURATION * 0.6)).toBeLessThan(1.5);
        expect((await media(page)).rate).toBe(1);
        // The button is still down, as far as the mouse knows: it moves nothing now, and its lift ends nothing twice.
        await page.mouse.move(row.at(0.2), row.y, { steps: 4 });
        await page.mouse.up();
        await page.waitForTimeout(200);
        expect((await media(page)).time, 'the film did not follow a pointer that was let go of').toBeGreaterThan(DURATION * 0.5);
        expect(await leftovers(page)).toEqual([]);
        expect((await media(page)).paused).toBe(false);
      });
    }

    test('a second button pressed during a drag ends it at rest', async ({ page, browserName }) => {
      test.skip(browserName === 'webkit', 'Playwright’s WebKit sends no event for a second button while the first is held');
      await ready(page);
      await playing(page);
      const row = await dragTo(page, 0.3, 0.6, 15);
      await page.mouse.down({ button: 'right' });
      await clean(page, { paused: false });
      await page.mouse.move(row.at(0.2), row.y, { steps: 4 });
      await page.mouse.up({ button: 'right' });
      await page.mouse.up();
      await page.waitForTimeout(200);
      expect((await media(page)).time).toBeGreaterThan(DURATION * 0.5);
      expect(await leftovers(page)).toEqual([]);
    });

    test('a drag let go above the player, and one let go outside the window, end as any other', async ({ page }) => {
      await ready(page);
      await playing(page);
      await watch(page);
      const row = await edge(page);
      // Up and away, slowly enough to be a rest (the finer lanes are on the way), let go far above the edge.
      await page.mouse.move(row.at(0.3), row.y);
      await page.mouse.down();
      for (let i = 1; i <= 12; i++) {
        await page.mouse.move(row.at(0.3 + 0.02 * i), row.y - i * 40);
        await page.waitForTimeout(16);
      }
      await page.waitForTimeout(250);
      await page.mouse.up();
      await clean(page, { paused: false });
      expect((await media(page)).rate).toBe(1);
      // And past the window's corner.
      await page.mouse.move(row.at(0.4), row.y);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) {
        await page.mouse.move(row.at(0.4 + 0.01 * i), row.y + i * 30);
        await page.waitForTimeout(16);
      }
      await page.mouse.move(row.at(0.5), size.height + 300);
      await page.waitForTimeout(250);
      await page.mouse.up();
      await clean(page, { paused: false });
      expect((await media(page)).rate).toBe(1);
      expect((await seen(page)).prints).toBe(0);
    });

    test('a glide ends at once for Space and for a chapter tab; a press on the edge catches it', async ({ page }) => {
      await ready(page);
      await playing(page);
      const row = await edge(page);
      // Whether a release is a flick is a matter of milliseconds between the last move and the lift; a loaded runner
      // can stretch them until it reads as letting go still (the film then plays on, and the throw is made again).
      const thrown = async () => {
        for (let attempt = 0; attempt < 4; attempt++) {
          await dragTo(page, 0.2, 0.35, 6, 12);
          await page.mouse.up();
          if ((await flip(page).getAttribute('data-mode')) === 'coast') return;
          await expect(flip(page)).toHaveAttribute('data-mode', 'idle');
          await expect.poll(async () => (await media(page)).paused).toBe(false);
        }
        throw new Error('four throws, none taken as a flick');
      };
      await thrown();
      await page.keyboard.press('Space');
      await expect(flip(page)).toHaveAttribute('data-mode', 'idle', { timeout: 300 });
      expect((await media(page)).rate).toBe(1);
      await gone(page);
      if ((await media(page)).paused) await page.keyboard.press('Space');
      await expect.poll(async () => (await media(page)).paused).toBe(false);

      await thrown();
      await page.locator('.fb-tab').nth(1).click();
      await expect(flip(page)).toHaveAttribute('data-mode', 'idle', { timeout: 300 });
      expect((await media(page)).rate).toBe(1);
      await expect(page.locator('.fb-tab').nth(1)).toHaveAttribute('data-current', '');
      await expect.poll(async () => (await media(page)).paused).toBe(false);

      await thrown();
      await page.mouse.move(row.at(0.7), row.y);
      await page.mouse.down();
      await page.waitForTimeout(40);
      await page.mouse.up();
      await clean(page, { paused: false });
      expect((await media(page)).rate).toBe(1);
      expect(Math.abs((await media(page)).time - DURATION * 0.7)).toBeLessThan(1.5);
    });
  });
}
