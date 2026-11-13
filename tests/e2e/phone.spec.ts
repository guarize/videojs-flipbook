import { type Browser, type BrowserContext, type Page } from '@playwright/test';
import { BARE, CHAPTERS, DURATION, ESSENTIAL, measure, media, open, seekPainted, settle, SHOWCASE, skipWithout, startAndHold } from './support/player';
// The battery's `test`: every context it makes is silenced (support/silence.mjs). No automated browser makes a sound.
import { expect, test } from './support/test';

/**
 * A phone's player (under 480 px wide, held upright): the book in one hand.
 *
 * - In the page the picture is the film's alone. The controls are a pad under it, one object with it: the chapter
 *   tabs, the fore-edge as a strip the whole width, a running foot, and one row of keys. Nothing of theirs is on the
 *   picture, and they never hide.
 * - The picture takes a finger as a phone taught: a tap plays and pauses (once), a swipe across flips the pages with
 *   the thumb and a flick plays on at exactly 1×, a double tap on a side skips ten seconds, a hold runs at 2×. A drag
 *   up or down scrolls the page, on the picture and on the edge.
 * - Settings is a sheet from the foot of the screen: opened by a tap; put away by a tap outside, a drag down or
 *   Escape, with focus back on its key.
 * - Filling the screen where a page may not ask for fullscreen (an iPhone), the player fills the window with its
 *   own controls, clear of the notch and the home indicator.
 *
 * Each check measures the running page: rects of what is drawn, hit tests on what takes the tap, the film's own
 * clock, with a real touch screen (Chromium's, by the DevTools protocol; WebKit has none to drive, so there the same
 * pointer events are dispatched and what only a real touch can show, the browser taking a scroll, is Chromium's).
 * One touch context per test, closed in `finally`.
 */

type Box = { x: number; y: number; w: number; h: number };

/** A small Android, an iPhone SE, an iPhone 14, a Pixel 7. */
const PHONES: [name: string, width: number, height: number][] = [
  ['small Android', 360, 740],
  ['iPhone SE', 375, 667],
  ['iPhone 14', 390, 844],
  ['Pixel 7', 412, 915],
];

async function phone(browser: Browser, browserName: string, width = 390, height = 844, more: Parameters<Browser['newContext']>[0] = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, hasTouch: true, isMobile: browserName === 'chromium', ...more });
  const page = await ctx.newPage();
  return { ctx, page };
}

/** Rects of every element matching that is drawn and visible (display, visibility, opacity up the tree), in viewport px. */
const boxes = (page: Page, selector: string): Promise<Box[]> =>
  page.evaluate((sel) => {
    const out: { x: number; y: number; w: number; h: number }[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) || el.closest('[inert]')) continue;
      let o = 1;
      for (let n: HTMLElement | null = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
      if (o < 0.05) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      out.push({ x: r.x, y: r.y, w: r.width, h: r.height });
    }
    return out;
  }, selector);

const overlap = (a: Box, b: Box) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5;
const time = (page: Page) => page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).currentTime);

/** How far the element at this selector owns the taps around its centre, by hit-testing; 0 × 0 if its centre is another's. */
const hitArea = (page: Page, selector: string, nth = 0) =>
  page.evaluate(({ sel, nth }) => {
    const el = document.querySelectorAll<HTMLElement>(sel)[nth];
    if (!el) return { w: 0, h: 0 };
    const r = el.getBoundingClientRect();
    const owns = (x: number, y: number) => {
      const hit = document.elementFromPoint(x, y);
      return !!hit && (el === hit || el.contains(hit));
    };
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    if (!owns(cx, cy)) return { w: 0, h: 0 };
    const reach = (dx: number, dy: number) => {
      let n = 0;
      while (n < 600 && owns(cx + dx * (n + 1), cy + dy * (n + 1))) n++;
      return n;
    };
    return { w: reach(-1, 0) + reach(1, 0) + 1, h: reach(0, -1) + reach(0, 1) + 1 };
  }, { sel: selector, nth });

/** Counts the film's own play and pause events from here on. */
const countPlays = (page: Page) =>
  page.evaluate(() => {
    const video = document.querySelector('video') as HTMLVideoElement;
    const tally = { plays: 0, pauses: 0 };
    (window as unknown as { __tally: typeof tally }).__tally = tally;
    video.addEventListener('play', () => tally.plays++);
    video.addEventListener('pause', () => tally.pauses++);
  });
const tally = (page: Page) => page.evaluate(() => (window as unknown as { __tally: { plays: number; pauses: number } }).__tally);

/** One DevTools session per page: a touch begun in one is ended in the same one. */
const sessions = new WeakMap<Page, Promise<Awaited<ReturnType<BrowserContext['newCDPSession']>>>>();
function session(ctx: BrowserContext, page: Page) {
  let made = sessions.get(page);
  if (!made) sessions.set(page, (made = ctx.newCDPSession(page)));
  return made;
}

interface Stroke {
  /** How long the finger takes, and how many moves it makes of it. */
  ms?: number;
  steps?: number;
  /** Held still this long before it lifts (a drag that ends at rest, not a flick). */
  rest?: number;
  /** Stays down: the caller lifts it with `lift`. */
  keep?: boolean;
  /** The finger is already down (kept by the stroke before): it only moves on. */
  on?: boolean;
  /**
   * A flick: the moves go out on the finger's own clock, whether or not the page has answered the one before. A page
   * that can refuse a scroll answers each touch before Chromium takes the next, so a stroke sent one answer at a time
   * is as slow as the machine is busy (110 ms asked, 620 measured: 0.29 px per ms, on the very line of a flick).
   */
  swift?: boolean;
}

/**
 * One finger from a point to another. In Chromium a real touch (Input.dispatchTouchEvent: the browser decides what
 * is a scroll, as on a phone). In WebKit, which has no such door, the pointer events a touch makes, dispatched on
 * what is under the finger.
 */
async function stroke(ctx: BrowserContext, page: Page, browserName: string, from: [number, number], to: [number, number], { ms = 240, steps = 12, rest = 0, keep = false, on = false, swift = false }: Stroke = {}) {
  const at = (i: number): [number, number] => [from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps];
  if (browserName === 'chromium') {
    const cdp = await session(ctx, page);
    const point = ([x, y]: [number, number]) => [{ x, y, id: 1, radiusX: 8, radiusY: 8, force: 1 }];
    if (!on) await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(from) });
    if (swift) {
      const sent: Promise<unknown>[] = [];
      for (let i = 1; i <= steps; i++) {
        sent.push(cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(at(i)) }));
        await new Promise((done) => setTimeout(done, ms / steps));
      }
      if (!keep) sent.push(cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }));
      await Promise.all(sent);
      return;
    }
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(at(i)) });
      await page.waitForTimeout(ms / steps);
    }
    if (rest) await page.waitForTimeout(rest);
    if (!keep) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    return;
  }
  const fire = (type: string, [x, y]: [number, number]) =>
    page.evaluate(({ type, x, y }) => {
      const w = window as unknown as { __finger?: Element | null };
      if (type === 'pointerdown') w.__finger = document.elementFromPoint(x, y);
      w.__finger?.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 41, pointerType: 'touch', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y }));
    }, { type, x, y });
  if (!on) await fire('pointerdown', from);
  for (let i = 1; i <= steps; i++) {
    await fire('pointermove', at(i));
    await page.waitForTimeout(ms / steps);
  }
  if (rest) await page.waitForTimeout(rest);
  if (!keep) await fire('pointerup', to);
}

async function lift(ctx: BrowserContext, page: Page, browserName: string, at: [number, number]) {
  if (browserName === 'chromium') {
    const cdp = await session(ctx, page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    return;
  }
  await page.evaluate(([x, y]) => {
    (window as unknown as { __finger?: Element | null }).__finger?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, composed: true, pointerId: 41, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y }));
  }, at);
}

/** A tap: Playwright's own touch screen (touch events, and the pointer events the browser makes of them). */
const tap = (page: Page, x: number, y: number) => page.touchscreen.tap(x, y);

const picture = async (page: Page) => (await boxes(page, 'media-container'))[0];
/** The film started by a tap on the picture, run past its first second. */
async function tapToStart(page: Page) {
  const box = await picture(page);
  await tap(page, box.x + box.w * 0.5, box.y + box.h * 0.3);
  await page.waitForFunction(() => {
    const video = document.querySelector('video') as HTMLVideoElement;
    return !video.paused && video.currentTime > 1.2;
  });
}

test.describe('a phone’s player in the page: the picture, and the pad under it', () => {
  for (const [name, width, height] of PHONES) {
    test(`${name} (${width} × ${height}): nothing on the picture; tabs, edge and keys in the pad, each a whole target; no sideways scroll`, async ({ browser, browserName }, testInfo) => {
      const { ctx, page } = await phone(browser, browserName, width, height);
      try {
        await open(page, BARE);
        const container = page.locator('media-container');
        await expect(container).toHaveAttribute('data-fb-pad', '');
        await expect(container).toHaveAttribute('data-fb-hand', '');
        // Playing, the controls "idle": on a phone they are the pad, and stay.
        await tapToStart(page);
        await page.waitForTimeout(2600);
        await settle(page);
        const box = await picture(page);
        const bar = (await boxes(page, '.fb-bar'))[0];
        expect(Math.round(box.w), 'the player is the window’s width').toBe(width);
        expect(Math.abs(box.h - (width * 9) / 16), 'the picture keeps its 16:9 box').toBeLessThan(1);
        expect(bar, 'the pad shows while the film plays untouched').toBeTruthy();
        expect(Math.abs(bar.y - (box.y + box.h)), 'the pad starts where the picture ends, px').toBeLessThanOrEqual(0.5);
        expect([Math.round(bar.x), Math.round(bar.w)], 'the pad is the picture’s width').toEqual([0, width]);
        // Its room is the page's: what follows the player starts under the pad.
        const reserved = await container.evaluate((el) => parseFloat(getComputedStyle(el).marginBottom));
        expect(Math.abs(reserved - bar.h), 'the margin that holds the pad’s place, px from its height').toBeLessThanOrEqual(0.5);

        // Nothing of the controls on the picture at rest: no key, no title chip, no shade, no tab, no edge.
        const onPicture: string[] = [];
        for (const selector of ['.video-controls-top', '.media-title', '.video-controls-backdrop', '.fb-tab-face', '.fb-edge-block', '.media-button:not(.fb-cover-play)', '.fb-time-display', '.fb-plate-toggle', '.fb-keep', '.fb-hand-mark', '.fb-hand-chip', '.fb-pace-chip']) {
          for (const drawn of await boxes(page, selector)) if (overlap(drawn, box)) onPicture.push(selector);
        }
        expect(onPicture, 'what stands on the picture while it plays').toEqual([]);
        // And the picture's middle is the film's to tap: a hit test lands on the video.
        const top = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName.toLowerCase(), { x: box.x + box.w / 2, y: box.y + box.h / 2 });
        expect(top, 'what a tap on the picture’s middle lands on').toBe('video');

        // The edge: the whole width less the pad's margin, a strip 56 px tall that is all the slider's.
        const slider = (await boxes(page, 'media-time-slider'))[0];
        const pages = (await boxes(page, '.fb-edge-block'))[0];
        expect(slider.w, 'the edge’s length').toBeGreaterThanOrEqual(width - 24.5);
        expect(pages.h, 'the pages’ thickness, px').toBeGreaterThanOrEqual(28);
        const edgeHit = await hitArea(page, 'media-time-slider');
        expect(edgeHit.h, 'the edge’s target, px tall').toBeGreaterThanOrEqual(56);

        // The tabs: six, on the edge's upper side, each its own target of 44 px or more, none sharing a pixel.
        const tabs = await boxes(page, '.fb-tab');
        expect(tabs.length, 'chapter tabs').toBe(6);
        const tabHits: { w: number; h: number }[] = [];
        for (let i = 0; i < 6; i++) tabHits.push(await hitArea(page, '.fb-tab', i));
        expect(tabHits.filter((hit) => hit.w < 44 || hit.h < 44).map((hit) => `${hit.w}×${hit.h}`), 'tabs under a whole target').toEqual([]);
        for (let i = 1; i < tabs.length; i++) expect(overlap(tabs[i - 1], tabs[i]), `tabs ${i} and ${i + 1} share pixels`).toBe(false);
        for (const tab of tabs) expect(tab.y + tab.h, 'a tab’s foot is the edge’s top').toBeLessThanOrEqual(slider.y + 0.5);
        const faces = await page.locator('.fb-tab-face').evaluateAll((els) => els.map((el) => ({ text: (el.textContent ?? '').trim(), size: parseFloat(getComputedStyle(el).fontSize) })));
        expect(faces.map((face) => face.text[0]), 'numbered in order').toEqual(['1', '2', '3', '4', '5', '6']);
        expect(Math.min(...faces.map((face) => face.size)), 'the tabs’ type, px').toBeGreaterThanOrEqual(12);

        // The keys: Play the large one, Mute, then the time; captions, Settings, fullscreen. Each owns 44 × 44 or more.
        const keys = ['.fb-play', '.fb-mute', '.fb-time-display', '.fb-bar .fb-captions', '.fb-settings', '.fb-fullscreen'];
        const small: string[] = [];
        const drawn: Box[] = [];
        for (const key of keys) {
          const rect = (await boxes(page, key))[0];
          const hit = await hitArea(page, key);
          if (!rect || hit.w < 44 || hit.h < 44) small.push(`${key}: ${hit.w}×${hit.h}`);
          if (rect) drawn.push(rect);
        }
        expect(small, 'keys under a whole target').toEqual([]);
        for (let i = 1; i < drawn.length; i++) {
          expect(overlap(drawn[i - 1], drawn[i]), `${keys[i - 1]} and ${keys[i]} share pixels`).toBe(false);
          expect(drawn[i].x, 'in reading order').toBeGreaterThan(drawn[i - 1].x);
        }
        const play = (await boxes(page, '.fb-play'))[0];
        expect(Math.min(play.w, play.h), 'Play is the large key, px').toBeGreaterThanOrEqual(52);
        // The time: from 402 px the whole of it; narrower (Mute has the room) the elapsed time alone, whole, with the
        // film's length still in the key's text. Under the edge the chapter and the page.
        await expect(page.locator('.fb-time-display')).toHaveText(/^\d+:\d\d \/ 1:38$/);
        const clock = await page.locator('.fb-time-display').evaluate((el) => {
          // The text's own box against the key's (its scrollWidth also counts what a slip of its own may hang beside it).
          const inside = (range: Range) => {
            const text = range.getBoundingClientRect();
            const box = el.getBoundingClientRect();
            return getComputedStyle(el).overflow === 'visible' || (text.left >= box.left - 0.5 && text.right <= box.right + 0.5);
          };
          const whole = document.createRange();
          whole.selectNodeContents(el);
          const elapsed = document.createRange();
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          const first = walker.nextNode() as Text;
          elapsed.setStart(first, 0);
          elapsed.setEnd(first, Math.max(1, (first.data.indexOf(' ') + 1 || first.data.length + 1) - 1));
          return { size: parseFloat(getComputedStyle(el).fontSize), whole: inside(whole), elapsed: inside(elapsed) };
        });
        expect(clock, 'the time: 16 px; the elapsed time whole, and the film’s length from 402 px').toEqual({ size: 16, whole: width >= 402, elapsed: true });
        const foot = await page.locator('.fb-folio').evaluate((el) => ({ page: el.textContent, chapter: getComputedStyle(el, '::before').content, size: parseFloat(getComputedStyle(el).fontSize) }));
        expect(foot.page).toMatch(/^p\. \d+ \/ 52$/);
        expect(foot.chapter, 'the chapter in the running foot').toBe('"The Book"');
        expect(foot.size, 'the foot’s type, px').toBeGreaterThanOrEqual(12);

        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 'sideways scroll, px').toBeLessThanOrEqual(0);
        await measure(testInfo, { kind: 'phone-pad', width, pad: Math.round(bar.h), edge: edgeHit, tabs: tabHits, play: { w: play.w, h: play.h } });
      } finally {
        await ctx.close();
      }
    });
  }

  // Mute is a key of the pad, not only a row in Settings: the six widths the row is composed for.
  for (const [width, height] of [[320, 568], [360, 740], [375, 667], [390, 844], [402, 874], [430, 932]] as const) {
    test(`${width} px: Mute is on the pad, a whole target of its own, and a tap mutes the film and a second gives the sound back`, async ({ browser, browserName }) => {
      const { ctx, page } = await phone(browser, browserName, width, height);
      try {
        await open(page, BARE);
        await expect(page.locator('media-container')).toHaveAttribute('data-fb-pad', '');
        await tapToStart(page);
        const pad = (await boxes(page, '.fb-bar'))[0];
        // The row, in reading order, every key inside the pad and none sharing a pixel: nothing gave its place up
        // but the film's length (the time key's text, under 402 px).
        const row = ['.fb-play', '.fb-mute', '.fb-time-display', '.fb-bar .fb-captions', '.fb-settings', '.fb-fullscreen'];
        const drawn: Box[] = [];
        for (const key of row) {
          const rect = (await boxes(page, key))[0];
          expect(rect, `${key} is drawn on the pad`).toBeTruthy();
          expect(rect.x, `${key} starts inside the pad`).toBeGreaterThanOrEqual(pad.x + 8);
          expect(rect.x + rect.w, `${key} ends inside the pad`).toBeLessThanOrEqual(pad.x + pad.w - 8);
          drawn.push(rect);
        }
        for (let i = 1; i < drawn.length; i++) expect(drawn[i].x, `${row[i]} comes after ${row[i - 1]}, sharing no pixel`).toBeGreaterThanOrEqual(drawn[i - 1].x + drawn[i - 1].w - 0.5);

        const mute = page.locator('.fb-bar .fb-mute');
        const hit = await hitArea(page, '.fb-bar .fb-mute');
        expect(Math.min(hit.w, hit.h), 'Mute’s own target, px').toBeGreaterThanOrEqual(44);
        expect(Math.max(hit.w, hit.h), 'and no larger than a key').toBeLessThanOrEqual(48);
        await expect(mute).toHaveAccessibleName('Mute');
        const shown = () => mute.evaluate((el) => [...el.querySelectorAll('media-icon')].filter((icon) => Number(getComputedStyle(icon).opacity) > 0.99).map((icon) => icon.getAttribute('name')));
        // The shape everyone knows (no tooltip on a touch screen to tell the book's own glyph).
        await expect.poll(shown).toEqual(['volume-high']);
        const size = await mute.locator('media-icon[name="volume-high"]').evaluate((el) => el.getBoundingClientRect().width);
        expect(size, 'the glyph, px').toBe(24);

        const muted = () => page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).muted);
        expect(await muted()).toBe(false);
        const at = (await boxes(page, '.fb-bar .fb-mute'))[0];
        await tap(page, at.x + at.w / 2, at.y + at.h / 2);
        await expect.poll(muted, 'the film is muted by one tap').toBe(true);
        await expect(mute).toHaveAccessibleName('Unmute');
        await expect(mute).toHaveAttribute('data-muted', '');
        await expect.poll(shown).toEqual(['volume-off']);
        // The film goes on playing, and no fader comes up over the pad (the volume is the device's).
        expect((await media(page)).paused).toBe(false);
        expect(await boxes(page, '.media-volume-popover-popup')).toEqual([]);
        await tap(page, at.x + at.w / 2, at.y + at.h / 2);
        await expect.poll(muted, 'and unmuted by the next').toBe(false);
        await expect(mute).toHaveAccessibleName('Mute');
        // M does the same from a keyboard, as on every player.
        await page.keyboard.press('m');
        await expect.poll(muted, 'M mutes').toBe(true);
        await page.keyboard.press('m');
        await expect.poll(muted).toBe(false);
      } finally {
        await ctx.close();
      }
    });
  }

  test('from 480 px the controls are the slab over the film again, and the docked mini player keeps it too', async ({ browser, browserName }) => {
    const { ctx, page } = await phone(browser, browserName, 480, 800);
    try {
      await open(page, BARE);
      await startAndHold(page, 20);
      const container = page.locator('media-container');
      await expect(container).not.toHaveAttribute('data-fb-pad', /.*/);
      await expect(container).not.toHaveAttribute('data-fb-hand', /.*/);
      const box = await picture(page);
      const bar = (await boxes(page, '.fb-bar'))[0];
      expect(bar.y + bar.h, 'the slab is inside the picture').toBeLessThanOrEqual(box.y + box.h);
      expect(await container.evaluate((el) => getComputedStyle(el).marginBottom)).toBe('0px');
    } finally {
      await ctx.close();
    }
  });

  test('the tabs are keys for the keyboard too: arrows move between them, Enter opens the chapter', async ({ browser, browserName }) => {
    const { ctx, page } = await phone(browser, browserName);
    try {
      await open(page, `${BARE}&features=essential`);
      await startAndHold(page, 2);
      await page.locator('.fb-tab[tabindex="0"]').focus();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await expect(page.locator('.fb-tab').nth(2)).toBeFocused();
      await page.keyboard.press('Enter');
      // The edge's own key, pressed in the very instant of the jump (no wait for the time on the pad to follow):
      // it steps from where the film is going, never from where it was (goto.ts; it used to land on 0:03).
      await page.locator('.media-time-slider-thumb').focus();
      await page.keyboard.press('ArrowRight');
      await expect.poll(() => time(page)).toBeGreaterThan(CHAPTERS[2] + 0.3);
      expect(await time(page)).toBeLessThan(CHAPTERS[2] + 6);
    } finally {
      await ctx.close();
    }
  });

  test('a tap on a tab opens its chapter at once; a tap on the edge goes there', async ({ browser, browserName }) => {
    const { ctx, page } = await phone(browser, browserName);
    try {
      await open(page, BARE);
      await tapToStart(page);
      const tab = (await boxes(page, '.fb-tab'))[4];
      await tap(page, tab.x + 14, tab.y + tab.h - 12);
      await expect.poll(() => time(page), { message: 'one tap on tab 5' }).toBeGreaterThanOrEqual(CHAPTERS[4] - 0.2);
      expect(await time(page)).toBeLessThan(CHAPTERS[4] + 3);
      const slider = (await boxes(page, 'media-time-slider'))[0];
      await tap(page, slider.x + slider.w * 0.25, slider.y + 15);
      await expect.poll(async () => Math.abs((await time(page)) - DURATION * 0.25), { message: 'a tap a quarter of the way along, seconds off' }).toBeLessThan(2.5);
    } finally {
      await ctx.close();
    }
  });
});

test.describe('the picture under a finger', () => {
  for (const preset of ['book', 'essential'] as const) {
    test(`a tap on the cover plays, once; the next pauses; the next plays (${preset})`, async ({ browser, browserName }) => {
      test.skip(ESSENTIAL && preset === 'book', 'the full book');
      const { ctx, page } = await phone(browser, browserName);
      try {
        await open(page, `${BARE}&features=${preset}`);
        await countPlays(page);
        const box = await picture(page);
        // On the title's side of the cover, not on the play disc: anywhere on the picture plays.
        await tap(page, box.x + box.w * 0.3, box.y + box.h * 0.45);
        await expect.poll(async () => (await media(page)).paused, { message: 'one tap on the cover' }).toBe(false);
        await page.waitForTimeout(700);
        expect(await tally(page), 'one play, no pause').toEqual({ plays: 1, pauses: 0 });
        expect(await page.locator('media-container').evaluate((el) => getComputedStyle(el, '::after').opacity), 'no keyboard ring round the player after a touch').toBe('0');
        await tap(page, box.x + box.w * 0.5, box.y + box.h * 0.5);
        await expect.poll(async () => (await media(page)).paused, { message: 'a tap on the playing picture' }).toBe(true);
        await page.waitForTimeout(400);
        await tap(page, box.x + box.w * 0.5, box.y + box.h * 0.5);
        await expect.poll(async () => (await media(page)).paused, { message: 'a tap on the paused picture' }).toBe(false);
        await page.waitForTimeout(400);
        expect(await tally(page)).toEqual({ plays: 2, pauses: 1 });
      } finally {
        await ctx.close();
      }
    });
  }

  test('a double tap on the right third skips ten seconds on, on the left ten back, each further tap ten more; the film never stops', async ({ browser, browserName }) => {
    const { ctx, page } = await phone(browser, browserName);
    try {
      await open(page, `${BARE}&features=essential`);
      await tapToStart(page);
      await seekPainted(page, 20);
      await countPlays(page);
      const box = await picture(page);
      const y = box.y + box.h * 0.5;
      const right = box.x + box.w * 0.85;
      const left = box.x + box.w * 0.15;
      await tap(page, right, y);
      await page.waitForTimeout(80);
      await tap(page, right, y);
      await expect.poll(() => time(page), { message: 'a double tap on the right' }).toBeGreaterThanOrEqual(29.8);
      expect(await time(page)).toBeLessThan(32.5);
      await expect(page.locator('.fb-hand-mark[data-open]')).toHaveText('+10 s');
      // A third tap in the run: ten more, and the mark counts the run.
      await page.waitForTimeout(80);
      await tap(page, right, y);
      await expect.poll(() => time(page), { message: 'a third tap' }).toBeGreaterThanOrEqual(39.8);
      await expect(page.locator('.fb-hand-mark[data-open]')).toHaveText('+20 s');
      await expect(page.locator('.fb-hand-mark')).not.toHaveAttribute('data-open', /.*/, { timeout: 3000 });
      const before = await time(page);
      await tap(page, left, y);
      await page.waitForTimeout(80);
      await tap(page, left, y);
      await expect.poll(() => time(page), { message: 'a double tap on the left' }).toBeLessThan(before - 8);
      await expect(page.locator('.fb-hand-mark[data-open]')).toHaveText('−10 s');
      await page.waitForTimeout(500);
      expect((await media(page)).paused, 'still playing').toBe(false);
      expect((await tally(page)).pauses, 'the film was never paused by a double tap').toBe(0);
    } finally {
      await ctx.close();
    }
  });

  test('a single tap on a side third still pauses, a quarter of a second on', async ({ browser, browserName }) => {
    const { ctx, page } = await phone(browser, browserName);
    try {
      await open(page, `${BARE}&features=essential`);
      await tapToStart(page);
      const box = await picture(page);
      await tap(page, box.x + box.w * 0.85, box.y + box.h * 0.5);
      await expect.poll(async () => (await media(page)).paused, { timeout: 2000 }).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  test('a hold runs the film at 2× while the finger stays, and gives the rate back when it lifts', async ({ browser, browserName }) => {
    const { ctx, page } = await phone(browser, browserName);
    try {
      await open(page, `${BARE}&features=essential`);
      await tapToStart(page);
      const box = await picture(page);
      const at: [number, number] = [box.x + box.w * 0.5, box.y + box.h * 0.5];
      await stroke(ctx, page, browserName, at, at, { ms: 60, steps: 1, keep: true });
      await expect.poll(async () => (await media(page)).rate, { message: 'held' }).toBe(2);
      await expect(page.locator('.fb-hand-chip[data-open]')).toHaveText('2×');
      await lift(ctx, page, browserName, at);
      await expect.poll(async () => (await media(page)).rate, { message: 'lifted' }).toBe(1);
      await page.waitForTimeout(350);
      expect((await media(page)).paused, 'the hold’s lift is no tap: still playing').toBe(false);
      await expect(page.locator('.fb-hand-chip')).not.toHaveAttribute('data-open', /.*/);
    } finally {
      await ctx.close();
    }
  });

  test('a swipe across the picture moves the film with the thumb, to the right on and to the left back; at rest it plays on', async ({ browser, browserName }) => {
    skipWithout(test, 'deck');
    const { ctx, page } = await phone(browser, browserName);
    try {
      await open(page, BARE);
      await expect(page.locator('media-container')).toHaveAttribute('data-fb-flip', '');
      await tapToStart(page);
      await seekPainted(page, 20);
      const box = await picture(page);
      const y = box.y + box.h * 0.5;
      // The picture's width is sixteen seconds of film: 195 px of a 390 px picture is eight.
      const travel = box.w / 2;
      await stroke(ctx, page, browserName, [box.x + 60, y], [box.x + 60 + travel, y], { ms: 500, steps: 20, keep: true });
      await expect(page.locator('fb-flip')).toHaveAttribute('data-mode', 'drag');
      await expect(page.locator('.fb-pace-chip')).toHaveAttribute('data-open', '');
      await expect.poll(() => time(page), { message: 'under the thumb, half the picture to the right' }).toBeGreaterThan(26.5);
      expect(await time(page), 'eight seconds on, and what played before the thumb took it').toBeLessThan(29.5);
      expect((await media(page)).paused, 'the film is held under the thumb').toBe(true);
      // (The chase lands a frame or two after the thumb stops.)
      await page.waitForTimeout(500);
      const held = await time(page);
      await page.waitForTimeout(300);
      expect(Math.abs((await time(page)) - held), 'it holds still under a still thumb').toBeLessThan(0.05);
      await lift(ctx, page, browserName, [box.x + 60 + travel, y]);
      await expect(page.locator('fb-flip')).toHaveAttribute('data-mode', 'idle');
      await expect.poll(async () => (await media(page)).paused, { message: 'let go at rest: it plays on' }).toBe(false);
      expect((await media(page)).rate).toBe(1);
      // To the left goes back.
      const from = await time(page);
      await stroke(ctx, page, browserName, [box.x + 300, y], [box.x + 300 - travel / 2, y], { ms: 400, steps: 16, rest: 250 });
      await expect.poll(() => time(page), { message: 'a quarter of the picture to the left: four seconds back' }).toBeLessThan(from - 2.5);
      await expect(page.locator('.fb-pace-chip')).not.toHaveAttribute('data-open', /.*/);
    } finally {
      await ctx.close();
    }
  });

  // Found on a real iPhone (iOS 27.2.1, 12 Nov 2026): the very first swipe, to the left with the film at 0:01, had
  // nowhere to go, and the stroke back only undid it, so "it does not work the first time".
  test('the first swipe of all, back past the film’s start: the picture gives a little, and the stroke back moves the film on from the start', async ({ browser, browserName }) => {
    skipWithout(test, 'deck');
    const { ctx, page } = await phone(browser, browserName);
    try {
      await open(page, BARE);
      await expect(page.locator('media-container')).toHaveAttribute('data-fb-flip', '');
      await tapToStart(page);
      const started = await time(page);
      expect(started, 'the film has only just begun').toBeLessThan(3);
      const box = await picture(page);
      const y = box.y + box.h * 0.5;
      // Nothing else has been touched: this swipe is the first gesture. 240 px to the left is ten seconds back.
      await stroke(ctx, page, browserName, [box.x + 320, y], [box.x + 80, y], { ms: 400, steps: 16, keep: true });
      await expect(page.locator('fb-flip')).toHaveAttribute('data-mode', 'drag');
      await expect.poll(() => time(page), { message: 'pulled back past the start: the first frame' }).toBeLessThan(0.1);
      // The picture answers the pull: it gives towards the finger, by less than its 28 px.
      const given = Number.parseFloat(await page.evaluate(() => getComputedStyle(document.querySelector('video:not(.fb-stand)') as Element).translate));
      expect(given, 'the picture gives to the left').toBeLessThan(-4);
      expect(given, 'and no further than its reach').toBeGreaterThanOrEqual(-28);
      // The stroke back: 120 px to the right is five seconds on, from the start, not from where the pull began.
      await stroke(ctx, page, browserName, [box.x + 80, y], [box.x + 200, y], { ms: 300, steps: 12, keep: true, on: true });
      await expect.poll(() => time(page), { message: 'five seconds on from the film’s start' }).toBeGreaterThan(3.5);
      expect(await time(page)).toBeLessThan(6.5);
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('video:not(.fb-stand)') as Element).translate), { message: 'the picture is back in its place' }).toMatch(/^(none|0px( 0px)?)$/);
      await lift(ctx, page, browserName, [box.x + 200, y]);
      await expect(page.locator('fb-flip')).toHaveAttribute('data-mode', 'idle');
    } finally {
      await ctx.close();
    }
  });

  test('pulled on past the film’s end, the picture gives the other way, and the stroke back goes back from the end', async ({ browser, browserName }) => {
    skipWithout(test, 'deck');
    const { ctx, page } = await phone(browser, browserName);
    try {
      await open(page, BARE);
      await expect(page.locator('media-container')).toHaveAttribute('data-fb-flip', '');
      await tapToStart(page);
      await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).pause());
      await seekPainted(page, DURATION - 4);
      const box = await picture(page);
      const y = box.y + box.h * 0.5;
      // 240 px to the right is ten seconds on: six of them past the last page.
      await stroke(ctx, page, browserName, [box.x + 60, y], [box.x + 300, y], { ms: 400, steps: 16, keep: true });
      await expect.poll(() => time(page), { message: 'pulled on past the end: the last page' }).toBeGreaterThan(DURATION - 0.6);
      const given = await page.evaluate(() => getComputedStyle(document.querySelector('video:not(.fb-stand)') as Element).translate);
      expect(Number.parseFloat(given), `the picture gives to the right: ${given}`).toBeGreaterThan(4);
      expect(Number.parseFloat(given)).toBeLessThanOrEqual(28);
      // 120 px back is five seconds back from the end.
      await stroke(ctx, page, browserName, [box.x + 300, y], [box.x + 180, y], { ms: 300, steps: 12, keep: true, on: true });
      await expect.poll(() => time(page), { message: 'five seconds back from the film’s end' }).toBeLessThan(DURATION - 3.5);
      expect(await time(page)).toBeGreaterThan(DURATION - 6.5);
      await lift(ctx, page, browserName, [box.x + 180, y]);
    } finally {
      await ctx.close();
    }
  });

  // On the iPhone the pointer was cancelled 21 px off the line, mid-swipe, and the page scrolled instead: once a swipe
  // has the film it keeps it, wherever the finger wanders, and the page stays where it was.
  test('a swipe that has the film keeps it when the finger drifts up and down: no scroll, no letting go', async ({ browser, browserName }) => {
    test.skip(browserName !== 'chromium', 'only a real touch screen shows the browser taking a scroll: Chromium’s');
    skipWithout(test, 'deck');
    const { ctx, page } = await phone(browser, browserName);
    try {
      // The review page with its notes: a page that can scroll.
      await open(page, '/flipbook.html');
      await page.evaluate(() => window.scrollTo(0, 60));
      await tapToStart(page);
      await seekPainted(page, 20);
      const box = await picture(page);
      const y = box.y + box.h * 0.5;
      const scrolled = await page.evaluate(() => window.scrollY);
      expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight), 'the page has room to scroll').toBeGreaterThan(200);
      await page.evaluate(() => {
        const w = window as unknown as { __cancels: number; __moves: boolean[] };
        w.__cancels = 0;
        w.__moves = [];
        document.addEventListener('pointercancel', () => w.__cancels++, true);
        // Each move of the finger, once the player has heard it: whether the page's own answer (a scroll) was refused.
        window.addEventListener('touchmove', (event) => w.__moves.push(event.defaultPrevented), { passive: true });
      });
      // Sideways first, so the swipe is taken; then on, drifting 90 px down and back up across the picture.
      await stroke(ctx, page, browserName, [box.x + 40, y], [box.x + 120, y], { ms: 200, steps: 8, keep: true });
      await expect(page.locator('fb-flip')).toHaveAttribute('data-mode', 'drag');
      const taken = await time(page);
      await page.evaluate(() => ((window as unknown as { __moves: boolean[] }).__moves = []));
      await stroke(ctx, page, browserName, [box.x + 120, y], [box.x + 220, y + 90], { ms: 300, steps: 12, keep: true, on: true });
      await stroke(ctx, page, browserName, [box.x + 220, y + 90], [box.x + 320, y - 40], { ms: 300, steps: 12, keep: true, on: true });
      await expect(page.locator('fb-flip'), 'the swipe still has the film').toHaveAttribute('data-mode', 'drag');
      await expect.poll(() => time(page), { message: 'the film followed the finger across, drifting or not: 200 px more' }).toBeGreaterThan(taken + 6);
      const moves = await page.evaluate(() => (window as unknown as { __moves: boolean[] }).__moves);
      expect(moves.length, 'moves of the finger while the swipe had the film').toBeGreaterThan(10);
      expect(moves.filter((prevented) => !prevented).length, 'moves left for the page to scroll with').toBe(0);
      expect(await page.evaluate(() => (window as unknown as { __cancels: number }).__cancels), 'pointers the browser took back').toBe(0);
      expect(await page.evaluate(() => window.scrollY), 'the page did not scroll').toBe(scrolled);
      await lift(ctx, page, browserName, [box.x + 320, y - 40]);
      // And a touch that goes up or down first is still the page's: none of its moves is refused.
      await page.evaluate(() => ((window as unknown as { __moves: boolean[] }).__moves = []));
      await stroke(ctx, page, browserName, [box.x + 200, y + 40], [box.x + 204, y - 60], { ms: 200, steps: 8 });
      const scrolls = await page.evaluate(() => (window as unknown as { __moves: boolean[] }).__moves);
      expect(scrolls.filter(Boolean).length, 'moves of an up-and-down touch refused to the page').toBe(0);
    } finally {
      await ctx.close();
    }
  });

  test('a flick across the picture carries its speed and settles to exactly 1×, playing', async ({ browser, browserName }) => {
    skipWithout(test, 'deck');
    const { ctx, page } = await phone(browser, browserName);
    try {
      await open(page, BARE);
      await expect(page.locator('media-container')).toHaveAttribute('data-fb-flip', '');
      await tapToStart(page);
      await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).pause());
      await seekPainted(page, 10);
      const box = await picture(page);
      const y = box.y + box.h * 0.5;
      await stroke(ctx, page, browserName, [box.x + 60, y], [box.x + 240, y], { ms: 110, steps: 8, swift: true });
      await expect(page.locator('fb-flip')).toHaveAttribute('data-mode', 'coast');
      // Thrown forwards, a paused film plays: faster than 1× on the way, never past the picture's own throw.
      const rates: number[] = [];
      await expect.poll(async () => {
        const state = await media(page);
        rates.push(state.rate);
        return (await page.locator('fb-flip').getAttribute('data-mode')) === 'idle';
      }, { message: 'the glide ends', timeout: 8000, intervals: [60] }).toBe(true);
      const end = await media(page);
      expect(end.rate, 'settled to exactly the viewer’s rate').toBe(1);
      expect(end.paused, 'and playing').toBe(false);
      expect(Math.max(...rates), 'it was carried faster than 1× on the way').toBeGreaterThan(1);
      expect(end.time, 'a flick of the picture is seconds, not the whole film').toBeLessThan(10 + 16);
      expect(end.time).toBeGreaterThan(11.5);
    } finally {
      await ctx.close();
    }
  });

  test('a drag up or down, on the picture or on the edge, scrolls the page and leaves the film alone', async ({ browser, browserName }) => {
    test.skip(browserName !== 'chromium', 'only a real touch screen shows the browser taking a scroll: Chromium’s');
    const { ctx, page } = await phone(browser, browserName);
    try {
      // The review page with its notes: a page to scroll.
      await open(page, '/flipbook.html');
      await tapToStart(page);
      await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).pause());
      await seekPainted(page, 20);
      await countPlays(page);
      for (const where of ['picture', 'edge', 'tabs', 'keys'] as const) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.locator('media-container').evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 120));
        const scrolled = await page.evaluate(() => window.scrollY);
        const box = await picture(page);
        const slider = (await boxes(page, 'media-time-slider'))[0];
        const start: [number, number] =
          where === 'picture' ? [box.x + box.w * 0.6, box.y + box.h * 0.7] : where === 'edge' ? [slider.x + slider.w * 0.8, slider.y + 14] : where === 'tabs' ? [slider.x + slider.w * 0.4, slider.y - 16] : [slider.x + slider.w * 0.45, slider.y + slider.h + 30];
        await stroke(ctx, page, browserName, start, [start[0] + 6, start[1] - 110], { ms: 260, steps: 13 });
        await page.waitForTimeout(500);
        expect((await page.evaluate(() => window.scrollY)) - scrolled, `a 110 px drag up from the ${where}: the page scrolled, px`).toBeGreaterThan(60);
        const state = await media(page);
        expect(Math.abs(state.time - 20), `the film after a scroll from the ${where}, seconds from where it was`).toBeLessThan(0.1);
        expect(state.paused, `still paused after a scroll from the ${where}`).toBe(true);
      }
      expect(await tally(page), 'no play and no pause came of scrolling').toEqual({ plays: 0, pauses: 0 });
      // And a sideways drag on the same edge is the film's.
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.locator('media-container').evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 120));
      const slider = (await boxes(page, 'media-time-slider'))[0];
      const y = slider.y + 14;
      const scrolled = await page.evaluate(() => window.scrollY);
      await stroke(ctx, page, browserName, [slider.x + slider.w * 0.2, y], [slider.x + slider.w * 0.7, y + 4], { ms: 400, steps: 16, rest: 250 });
      await expect.poll(async () => Math.abs((await time(page)) - DURATION * 0.7), { message: 'a thumb along the edge to 70 %, seconds off' }).toBeLessThan(2);
      expect(await page.evaluate(() => window.scrollY), 'the page stayed').toBe(scrolled);
    } finally {
      await ctx.close();
    }
  });

  test('“Swipe right to flip on, left to flip back” is said once, a moment after the film is first started by touch, and a touch puts it away for good', async ({ browser, browserName }) => {
    skipWithout(test, 'deck', 'hints');
    const { ctx, page } = await phone(browser, browserName);
    try {
      await open(page, BARE);
      await page.evaluate(() => localStorage.removeItem('fb-hints'));
      await tapToStart(page);
      const slip = page.locator('fb-hints[data-open] .fb-hint');
      await expect(slip).toHaveText('Swipe right to flip on, left to flip back', { timeout: 6000 });
      await page.waitForTimeout(300);
      const box = (await boxes(page, '.fb-hint'))[0];
      const frame = await picture(page);
      expect(box.y >= frame.y && box.y + box.h <= frame.y + frame.h, `the slip is on the picture: ${JSON.stringify({ box, frame })}`).toBe(true);
      expect(await page.locator('.fb-hint').evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
      // A touch on the slip puts it away, and is no tap on the film.
      await tap(page, box.x + box.w / 2, box.y + box.h / 2);
      await expect(page.locator('fb-hints[data-open]')).toHaveCount(0);
      await page.waitForTimeout(400);
      expect((await media(page)).paused, 'the film plays on').toBe(false);
      // Never again: pause, play, wait.
      await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).pause());
      await tap(page, frame.x + frame.w / 2, frame.y + frame.h / 2);
      await page.waitForTimeout(2600);
      await expect(page.locator('fb-hints[data-open]')).toHaveCount(0);
      expect(await page.evaluate(() => localStorage.getItem('fb-hints'))).toContain('swipe');
    } finally {
      await ctx.close();
    }
  });
});

test.describe('Settings on a phone: a sheet from the bottom', () => {
  test('it fills the window’s width at its foot, every row a whole target; the book’s keys that are on the pad are not offered here again', async ({ browser, browserName }) => {
    skipWithout(test, 'contents', 'ribbons');
    const { ctx, page } = await phone(browser, browserName, 390, 760);
    try {
      await open(page, BARE);
      await startAndHold(page, 20);
      const menu = page.locator('#flipbook-settings');
      const openSheet = async () => {
        await page.locator('.fb-settings').tap();
        await expect(menu).toBeVisible();
        await settle(page);
      };
      await openSheet();
      const sheet = (await boxes(page, '#flipbook-settings'))[0];
      expect([Math.round(sheet.x), Math.round(sheet.w), Math.round(sheet.y + sheet.h)], 'the sheet: left, width, foot').toEqual([0, 390, 760]);
      expect(sheet.y, 'it leaves the top of the screen to the page').toBeGreaterThanOrEqual(56);

      const rows = await page.locator('#flipbook-settings > media-menu-content:not([data-submenu]) > [role^="menuitem"]').evaluateAll((els) =>
        els
          .filter((el) => el.checkVisibility())
          .map((el) => {
            const r = el.getBoundingClientRect();
            const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return { text: (el.querySelector('[data-part="label"], media-text')?.textContent ?? '').trim(), h: Math.round(r.height), w: Math.round(r.width), own: !!hit && el.contains(hit), size: parseFloat(getComputedStyle(el).fontSize) };
          }),
      );
      const names = rows.map((r) => r.text);
      for (const name of ['Speed', 'Captions', 'Chapters', 'Keep this page', 'Plate', 'Volume', 'Mute']) expect(names, `the sheet lists ${name}`).toContain(name);
      // Contents, Bookmark and Caption style are keys of the pad, by name (the next describe): nothing is offered twice.
      for (const name of ['Contents', 'Bookmark this moment', 'Remove bookmark', 'Caption style']) expect(names, `the sheet does not list ${name}`).not.toContain(name);
      // Shortcuts only where there may be a keyboard to use them.
      const keyboardless = await page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches);
      expect(names.includes('Shortcuts'), 'Shortcuts is listed only with a keyboard in reach').toBe(!keyboardless);
      expect(rows.filter((r) => r.h < 44 || r.w < 300 || !r.own || r.size < 16).map((r) => `${r.text}: ${r.w}×${r.h}, ${r.size}px${r.own ? '' : ', covered'}`), 'rows under a whole target, or under 16 px type').toEqual([]);
      // Opened by a finger: no keyboard ring on the first row.
      const ring = await page.locator('#flipbook-settings [data-highlighted]').first().evaluate((el) => (el.matches(':focus-visible') ? 'keyboard' : getComputedStyle(el).outlineStyle));
      expect(['none', 'keyboard'], 'the first row’s ring after a tap').toContain(ring);
      await measure(test.info(), { kind: 'phone-sheet', sheet, rows: rows.length, smallestRow: Math.min(...rows.map((r) => r.h)) });

      // A tap on the dimmed page puts the sheet away, and the Settings key has focus again. (It is open from above.)
      await page.touchscreen.tap(195, 30);
      await expect(menu).toBeHidden();
      await expect(page.locator('.fb-settings')).toBeFocused();

      // Escape, the same.
      await openSheet();
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
      await expect(page.locator('.fb-settings')).toBeFocused();

      // The chapters as the book's contents: each row a whole target with its first page and its start.
      await openSheet();
      await menu.getByRole('menuitem', { name: 'Chapters' }).tap();
      await expect(menu.locator('.fb-menu-chapter').first()).toBeVisible();
      await settle(page);
      const chapters = await menu.locator('.fb-menu-chapter').evaluateAll((els) =>
        els.map((el) => {
          const page = el.querySelector<HTMLElement>('.fb-menu-chapter-page')!;
          const r = page.getBoundingClientRect();
          return { h: Math.round(el.getBoundingClientRect().height), page: [Math.round(r.width), Math.round(r.height)], picture: getComputedStyle(page).backgroundImage !== 'none', time: el.querySelector('.fb-menu-chapter-time')?.textContent ?? '' };
        }),
      );
      expect(chapters.length, 'six chapters').toBe(6);
      expect(chapters.filter((c) => c.h < 48 || c.page[0] < 60 || !c.picture || !/^\d+:\d\d$/.test(c.time)), 'chapter rows without a whole target, a page or a start').toEqual([]);
      await menu.locator('.fb-menu-chapter').nth(3).tap();
      await expect.poll(() => time(page)).toBeCloseTo(CHAPTERS[3], 0);
    } finally {
      await ctx.close();
    }
  });

  test('it rises in 250 ms and leaves in 150; under reduced motion it is there or not', async ({ browser, browserName }) => {
    for (const reduced of [false, true]) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 760 }, hasTouch: true, isMobile: browserName === 'chromium', reducedMotion: reduced ? 'reduce' : 'no-preference' });
          const page = await ctx.newPage();
      try {
        await open(page, `${BARE}&features=essential`);
        await startAndHold(page, 20);
        const ms = await page.locator('#flipbook-settings').evaluate((el) => {
          const d = (v: string) => v.split(',').map((s) => parseFloat(s) * (s.trim().endsWith('ms') ? 1 : 1000));
          const style = getComputedStyle(el);
          const props = style.transitionProperty.split(',').map((p) => p.trim());
          return { transform: d(style.transitionDuration)[props.indexOf('transform')], all: props };
        });
        expect(ms.all, 'never transition: all').not.toContain('all');
        expect(ms.transform, `the sheet’s travel, ms${reduced ? ' (reduced motion)' : ''}`).toBe(reduced ? 0 : 250);
      } finally {
        await ctx.close();
      }
    }
  });

  // On Pedro's iPhone the Quality page's sheet stood against the page's own header: it keeps 128 px clear of the
  // window's top, and what does not fit scrolls inside it.
  // Video.js anchors the menu to its key (`position-anchor`), and the sheet is placed by the screen instead. Firefox
  // went on moving a box with an anchor by as far as the anchor's page had scrolled, though nothing of the sheet's
  // place was the anchor's any more: on a page scrolled 624 px the sheet stood 624 px too high, its foot at 176 px of
  // an 800 px screen and its first rows above the top (13 Nov 2026, Firefox 157).
  test('the sheet stands on the screen’s foot however far the page has been scrolled', async ({ browser, browserName }) => {
    const { ctx, page } = await phone(browser, browserName, 390, 760);
    try {
      await open(page, SHOWCASE);
      await page.locator('#player').evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 8));
      const scrolled = await page.evaluate(() => scrollY);
      expect(scrolled, 'px the page is scrolled: enough to tell the screen from the page').toBeGreaterThan(200);
      await page.locator('.fb-settings').tap();
      const menu = page.locator('#flipbook-settings');
      await expect(menu).toBeVisible();
      await settle(page);
      const sheet = (await boxes(page, '#flipbook-settings'))[0];
      expect([Math.round(sheet.x), Math.round(sheet.w), Math.round(sheet.y + sheet.h)], 'the sheet: left, width, foot').toEqual([0, 390, 760]);
      expect(sheet.y, 'its top is on the screen').toBeGreaterThanOrEqual(56);
      expect(await page.evaluate(() => scrollY), 'the page has not moved').toBe(scrolled);
    } finally {
      await ctx.close();
    }
  });

  test('on a short screen the sheet keeps 128 px of the page above it, and its rows scroll inside', async ({ browser, browserName }) => {
    const { ctx, page } = await phone(browser, browserName, 360, 520);
    try {
      await open(page, BARE);
      await startAndHold(page, 20);
      await page.locator('.fb-settings').tap();
      await expect(page.locator('#flipbook-settings')).toBeVisible();
      await settle(page);
      const sheet = (await boxes(page, '#flipbook-settings'))[0];
      expect(Math.round(sheet.y + sheet.h), 'the sheet stands on the window’s foot').toBe(520);
      expect(sheet.y, 'the page’s own header stays in sight over it').toBeGreaterThanOrEqual(128);
      const rows = await page.locator('#flipbook-settings > media-menu-content:not([data-submenu])').evaluate((el) => ({ holds: el.scrollHeight, shows: el.clientHeight, scrolls: getComputedStyle(el).overflowY }));
      expect(rows.holds, `the rows are more than the sheet shows (${JSON.stringify(rows)}): they scroll`).toBeGreaterThan(rows.shows);
      expect(['auto', 'scroll']).toContain(rows.scrolls);
    } finally {
      await ctx.close();
    }
  });

  test('a narrow player in a wide window keeps the popup by its key; its book keys are on its pad, and Shortcuts is in the popup', async ({ page }) => {
    skipWithout(test, 'contents', 'ribbons');
    await open(page, SHOWCASE);
    await page.evaluate(() => (document.querySelector('.canvas') as HTMLElement).style.setProperty('--frame-w', '400px'));
    await page.waitForFunction(() => Math.abs(document.querySelector('media-container')!.getBoundingClientRect().width - 400) < 1);
    await page.evaluate(() => {
      const r = document.querySelector('media-container')!.getBoundingClientRect();
      window.scrollBy(0, r.top - Math.max(0, (innerHeight - r.height) / 2));
    });
    await startAndHold(page, 20);
    expect(await boxes(page, '.video-controls-top > .media-button'), 'keys on the picture').toEqual([]);
    await page.locator('.fb-settings').click();
    await expect(page.locator('#flipbook-settings')).toBeVisible();
    await settle(page);
    const menu = (await boxes(page, '#flipbook-settings'))[0];
    const key = (await boxes(page, '.fb-settings'))[0];
    expect(menu.w, 'a popup, not a sheet').toBeLessThan(400);
    expect(Math.abs(menu.y + menu.h - key.y), 'it stands on its key').toBeLessThan(24);
    // A mouse's narrow player has the pad too, with the book's keys on it by name: the popup does not offer them
    // again. Shortcuts, which has no key on a pad, is here for whoever has a keyboard.
    expect((await boxes(page, '.fb-book-key')).length, 'the book’s keys on the pad').toBe(3);
    for (const name of ['Contents', 'Bookmark this moment', 'Caption style']) {
      await expect(page.locator('#flipbook-settings').getByRole('menuitem', { name })).toHaveCount(0);
    }
    await expect(page.locator('#flipbook-settings').getByRole('menuitem', { name: 'Shortcuts' })).toHaveCount(1);
    // By keyboard: Shortcuts opens the card, and Escape returns to the Settings key.
    await page.locator('#flipbook-settings').getByRole('menuitem', { name: 'Shortcuts' }).click();
    await expect(page.locator('fb-keymap [role="dialog"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.fb-settings')).toBeFocused();
  });

  test('a drag down on the sheet follows the finger: a short one comes back, a long one or a flick puts it away, focus on its key', async ({ browser, browserName }) => {
    const { ctx, page } = await phone(browser, browserName, 390, 760);
    try {
      await open(page, BARE);
      await startAndHold(page, 20);
      const menu = page.locator('#flipbook-settings');
      const openSheet = async () => {
        await page.locator('.fb-settings').tap();
        await expect(menu).toBeVisible();
        await settle(page);
        await page.waitForTimeout(350);
        return (await boxes(page, '#flipbook-settings'))[0];
      };
      let sheet = await openSheet();
      // Its handle is drawn, and every row is in sight, so the whole sheet takes the drag.
      const handle = await menu.evaluate((el) => {
        const style = getComputedStyle(el, '::before');
        return { w: parseFloat(style.width), h: parseFloat(style.height), touch: getComputedStyle(el).touchAction, contain: getComputedStyle(el).overscrollBehaviorY };
      });
      expect(handle, 'the handle, and the page behind kept still').toEqual({ w: 36, h: 4, touch: 'none', contain: 'contain' });
      // 40 px down, held: it is 40 px down.
      await stroke(ctx, page, browserName, [195, sheet.y + 120], [195, sheet.y + 160], { ms: 200, steps: 8, keep: true });
      await expect.poll(async () => Math.round((await boxes(page, '#flipbook-settings'))[0].y - sheet.y), { message: 'the sheet under the finger, px down' }).toBe(40);
      await page.waitForTimeout(150);
      await lift(ctx, page, browserName, [195, sheet.y + 160]);
      await expect.poll(async () => Math.round((await boxes(page, '#flipbook-settings'))[0].y - sheet.y), { message: 'let go short: it comes back' }).toBe(0);
      await expect(menu).toBeVisible();
      // No row was pressed by that lift.
      await expect(menu.locator('media-menu-content[data-submenu]:not([hidden]):not([inert])')).toHaveCount(0);
      // 130 px down from the handle: put away.
      await stroke(ctx, page, browserName, [195, sheet.y + 10], [195, sheet.y + 140], { ms: 260, steps: 13, rest: 120 });
      await expect(menu).toBeHidden();
      await expect(page.locator('.fb-settings')).toBeFocused();
      // A flick: 50 px, fast.
      sheet = await openSheet();
      await stroke(ctx, page, browserName, [195, sheet.y + 10], [195, sheet.y + 60], { ms: 60, steps: 4, swift: true });
      await expect(menu).toBeHidden();
      // And it opens whole again after (no transform left behind).
      const again = await openSheet();
      expect(Math.round(again.y), 'where it stood before').toBe(Math.round(sheet.y));
      expect(await menu.evaluate((el: HTMLElement) => el.style.transform)).toBe('');
    } finally {
      await ctx.close();
    }
  });
});

test.describe('the book’s own keys on the pad: Contents, Bookmark, Caption style', () => {
  // Upright, a phone's picture carries no keys, and these three were only in the Settings sheet, where the book's
  // owner did not find them (12 Nov 2026). They are a row of the pad, by name, between the running foot and Play.
  for (const [width, height] of [[320, 568], [360, 740], [390, 844], [402, 874], [430, 932]] as const) {
    test(`${width} px: three keys in the pad, each a whole target with its name where the names fit, in order after the tabs; no sideways scroll`, async ({ browser, browserName }) => {
      skipWithout(test, 'contents', 'ribbons');
      const { ctx, page } = await phone(browser, browserName, width, height);
      try {
        await open(page, BARE);
        await startAndHold(page, 20);
        await settle(page);
        const keys = ['#flipbook-contents-pad', '#flipbook-bookmark-pad', '#flipbook-caption-style-pad'];
        const drawn = await Promise.all(keys.map(async (key) => (await boxes(page, key))[0]));
        expect(drawn.filter(Boolean).length, 'the three keys are drawn').toBe(3);
        const picture = (await boxes(page, 'media-container'))[0];
        const pad = (await boxes(page, '.fb-bar'))[0];
        const foot = (await boxes(page, '.fb-folio'))[0];
        const play = (await boxes(page, '.fb-play'))[0];
        for (const [i, box] of drawn.entries()) {
          expect(box.y, `${keys[i]} is under the picture, in the pad`).toBeGreaterThanOrEqual(picture.y + picture.h);
          expect(box.y, `${keys[i]} is under the running foot`).toBeGreaterThanOrEqual(foot.y + foot.h - 0.5);
          expect(box.y + box.h, `${keys[i]} is over the row of Play`).toBeLessThanOrEqual(play.y + 0.5);
          expect(box.x, `${keys[i]} starts inside the pad`).toBeGreaterThanOrEqual(pad.x);
          expect(box.x + box.w, `${keys[i]} ends inside the pad`).toBeLessThanOrEqual(pad.x + pad.w + 0.5);
          const hit = await hitArea(page, keys[i]);
          expect(Math.min(hit.w, hit.h), `${keys[i]}: the least side of what takes its tap`).toBeGreaterThanOrEqual(44);
        }
        expect(overlap(drawn[0], drawn[1]) || overlap(drawn[1], drawn[2]), 'no key lies over its neighbour').toBe(false);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 'sideways scroll').toBe(0);

        // Their names: printed whole or not at all, never cut; said in full either way.
        const names = await page.evaluate((selectors) =>
          selectors.map((selector) => {
            const key = document.querySelector(selector) as HTMLElement;
            const name = key.querySelector('.fb-key-name') as HTMLElement;
            const box = name.getBoundingClientRect();
            const printed = box.width > 2 && box.height > 2;
            return { printed, cut: printed && name.scrollWidth > name.clientWidth + 1, text: name.textContent, size: parseFloat(getComputedStyle(name).fontSize), said: key.getAttribute('aria-label') ?? key.textContent?.trim() };
          }), keys);
        expect(names.map((name) => name.said), 'each key’s name for a screen reader').toEqual(['Contents', 'Bookmark', 'Caption style']);
        expect(names.filter((name) => name.cut).map((name) => name.text), 'names cut short').toEqual([]);
        // Contents and Bookmark keep their names down to 320 px; the caption key's joins them once all three fit.
        expect(names.slice(0, 2).map((name) => name.printed), 'Contents and Bookmark are named').toEqual([true, true]);
        expect(names[2].printed, 'Caption style is named where the row has room for it').toBe(width >= 390);
        expect(names.filter((name) => name.printed && name.size < 14).map((name) => name.text), 'names under 14 px').toEqual([]);
        await measure(test.info(), { kind: 'pad-book-row', width, keys: drawn.map((box) => [Math.round(box.w), Math.round(box.h)]), named: names.map((name) => name.printed) });

        // For the keyboard they come after the tabs and the edge, before Play, as they are drawn.
        const order = await page.evaluate(() => {
          const stops = [...document.querySelectorAll<HTMLElement>('media-container .fb-bar :is(button, [role="button"], [role="slider"])')].filter((el) => el.tabIndex >= 0 && el.checkVisibility());
          return stops.map((el) => el.id || el.className.split(' ').pop());
        });
        const [tab, contents, bookmark, style, playKey] = ['fb-tab', 'flipbook-contents-pad', 'flipbook-bookmark-pad', 'flipbook-caption-style-pad', 'flipbook-play'].map((name) => order.indexOf(name));
        expect([tab < contents, contents < bookmark, bookmark < style, style < playKey], `the order of the stops: ${order.join(', ')}`).toEqual([true, true, true, true]);
      } finally {
        await ctx.close();
      }
    });
  }

  test('each does what its key on the wide player does: Contents opens its page, Bookmark marks the moment and says so, Caption style opens its page', async ({ browser, browserName }) => {
    skipWithout(test, 'contents', 'ribbons');
    const { ctx, page } = await phone(browser, browserName, 390, 844);
    try {
      await open(page, BARE);
      await startAndHold(page, 20);
      await settle(page);

      // Bookmark: a ribbon on the edge, the key pressed, its ribbon red with a tick; a second tap takes it off.
      const bookmark = page.locator('#flipbook-bookmark-pad');
      await expect(bookmark).toHaveAttribute('aria-pressed', 'false');
      await bookmark.tap();
      await expect(page.locator('.fb-ribbon')).toHaveCount(1);
      await expect(bookmark).toHaveAttribute('aria-pressed', 'true');
      await expect(bookmark.locator('.fb-bookmark-on-icon')).toHaveCSS('opacity', '1');
      await expect(bookmark.locator('.fb-bookmark-add-icon')).toHaveCSS('opacity', '0');
      await bookmark.tap();
      await expect(page.locator('.fb-ribbon')).toHaveCount(0);
      await expect(bookmark).toHaveAttribute('aria-pressed', 'false');

      // Contents: its page, and Escape gives focus back to the key that opened it.
      await page.locator('#flipbook-contents-pad').tap();
      await expect(page.locator('.fb-contents-page')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('.fb-contents-page')).toBeHidden();
      await expect(page.locator('#flipbook-contents-pad')).toBeFocused();

      // Caption style: the same.
      await page.locator('#flipbook-caption-style-pad').tap();
      await expect(page.locator('fb-caption-style [role="dialog"]')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('fb-caption-style [role="dialog"]')).toBeHidden();
      await expect(page.locator('#flipbook-caption-style-pad')).toBeFocused();
    } finally {
      await ctx.close();
    }
  });

  test('a wide player has no such row: its book keys are on the slab or along the top', async ({ page }) => {
    await open(page, BARE);
    await startAndHold(page, 20);
    expect(await boxes(page, '.fb-book-row, .fb-book-key')).toEqual([]);
  });
});

test.describe('filling the screen', () => {
  /** A page that may not put an element in fullscreen, as on an iPhone: only its own video player gets the screen. */
  const noElementFullscreen = () => {
    for (const name of ['fullscreenEnabled', 'webkitFullscreenEnabled']) Object.defineProperty(document, name, { configurable: true, get: () => false });
    const calls: string[] = [];
    (window as unknown as { __native: string[] }).__native = calls;
    Object.defineProperty(HTMLVideoElement.prototype, 'webkitSetPresentationMode', { configurable: true, value: (mode: string) => calls.push(mode) });
  };

  // The pad stands 8 px in from the screen's sides here, so its row has 16 px less than in the page: at each width
  // where the row is composed differently, every key and the edge still end inside the pad.
  for (const [width, height] of [[344, 740], [390, 844], [402, 874], [430, 932]] as const) {
    test(`filling a ${width} px screen upright, the pad’s row and the edge end inside the pad, Mute among the keys`, async ({ browser, browserName }) => {
      const { ctx, page } = await phone(browser, browserName, width, height);
      try {
        await page.addInitScript(noElementFullscreen);
        await open(page, '/flipbook.html');
        await tapToStart(page);
        await page.locator('.fb-fullscreen').scrollIntoViewIfNeeded();
        await page.locator('.fb-fullscreen').tap();
        await expect(page.locator('media-container')).toHaveAttribute('data-fb-fill', '');
        await settle(page);
        const pad = (await boxes(page, '.fb-bar'))[0];
        expect([Math.round(pad.x), Math.round(pad.w)], 'the pad, 8 px in from either side').toEqual([8, width - 16]);
        for (const part of ['.fb-play', '.fb-bar .fb-mute', '.fb-time-display', '.fb-bar .fb-captions', '.fb-settings', '.fb-fullscreen', 'media-time-slider', '.fb-edge-block']) {
          const rect = (await boxes(page, part))[0];
          expect(rect, `${part} is drawn`).toBeTruthy();
          expect(rect.x, `${part} starts inside the pad`).toBeGreaterThanOrEqual(pad.x + 8);
          expect(rect.x + rect.w, `${part} ends inside the pad`).toBeLessThanOrEqual(pad.x + pad.w - 8);
        }
        const hit = await hitArea(page, '.fb-bar .fb-mute');
        expect(Math.min(hit.w, hit.h), 'Mute’s own target, px').toBeGreaterThanOrEqual(44);
      } finally {
        await ctx.close();
      }
    });
  }

  // An iPhone gives the screen to no element, only to a video in its own player. The fill above stays under Safari's
  // bars, so the real thing is offered too, named for what it is, and only there (Pedro's iPhone, 12 Nov 2026).
  test('Settings offers "Full screen in the system player" only where the page cannot have the screen and the film can; a tap asks the system for it', async ({ browser, browserName }) => {
    const row = (page: Page) => page.locator('#flipbook-settings').getByRole('menuitem', { name: 'Full screen in the system player' });
    const sheet = async (page: Page) => {
      await tapToStart(page);
      await page.locator('.fb-settings').scrollIntoViewIfNeeded();
      await page.locator('.fb-settings').tap();
      await expect(page.locator('#flipbook-settings')).toBeVisible();
      await settle(page);
    };
    // As on an iPhone: no element fullscreen, and the film has the system's own.
    const iphone = await phone(browser, browserName, 390, 844);
    try {
      await iphone.page.addInitScript(noElementFullscreen);
      await iphone.page.addInitScript(() => {
        Object.defineProperty(HTMLVideoElement.prototype, 'webkitEnterFullscreen', { configurable: true, value: () => (window as unknown as { __native: string[] }).__native.push('system') });
      });
      await open(iphone.page, '/flipbook.html');
      await sheet(iphone.page);
      await expect(row(iphone.page)).toBeVisible();
      expect((await row(iphone.page).boundingBox())?.height, 'the row is a whole target').toBeGreaterThanOrEqual(44);
      await row(iphone.page).tap();
      await expect.poll(() => iphone.page.evaluate(() => (window as unknown as { __native: string[] }).__native)).toEqual(['system']);
    } finally {
      await iphone.ctx.close();
    }
    // A page that can have the screen: the Full screen key is the real thing, and the row is not there.
    const other = await phone(browser, browserName, 390, 844);
    try {
      await open(other.page, '/flipbook.html');
      expect(await other.page.evaluate(() => document.fullscreenEnabled || (document as Document & { webkitFullscreenEnabled?: boolean }).webkitFullscreenEnabled), 'this page may ask for fullscreen').toBe(true);
      await sheet(other.page);
      await expect(row(other.page)).toBeHidden();
    } finally {
      await other.ctx.close();
    }
    // No element fullscreen and no system player either: nothing to offer.
    const neither = await phone(browser, browserName, 390, 844);
    try {
      await neither.page.addInitScript(noElementFullscreen);
      await neither.page.addInitScript(() => {
        Object.defineProperty(HTMLVideoElement.prototype, 'webkitEnterFullscreen', { configurable: true, value: undefined });
      });
      await open(neither.page, '/flipbook.html');
      await sheet(neither.page);
      await expect(row(neither.page)).toBeHidden();
    } finally {
      await neither.ctx.close();
    }
  });

  test('where a page can’t ask for fullscreen the key fills the window with the player’s own controls, upright and on its side, and never the system’s video player', async ({ browser, browserName }) => {
    const { ctx, page } = await phone(browser, browserName, 390, 844);
    try {
      await page.addInitScript(noElementFullscreen);
      await open(page, '/flipbook.html');
      await tapToStart(page);
      const container = page.locator('media-container');
      await page.locator('.fb-fullscreen').scrollIntoViewIfNeeded();
      await page.locator('.fb-fullscreen').tap();
      await expect(container).toHaveAttribute('data-fb-fill', '');
      await expect(container).toHaveAttribute('data-fb-screen', '');
      await expect(container).not.toHaveAttribute('data-fb-pad', /.*/);
      await settle(page);
      let box = await picture(page);
      expect([Math.round(box.x), Math.round(box.y), Math.round(box.w), Math.round(box.h)], 'the player is the window').toEqual([0, 0, 390, 844]);
      expect(await page.evaluate(() => (window as unknown as { __native: string[] }).__native), 'the system’s player was never asked for').toEqual([]);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow), 'the page behind is held').toBe('hidden');
      // Upright: the pad over the screen's foot, whole, its keys whole targets.
      let bar = (await boxes(page, '.fb-bar'))[0];
      expect(bar.y + bar.h, 'the pad is inside the screen').toBeLessThanOrEqual(844);
      expect(bar.w).toBeGreaterThan(360);
      expect((await hitArea(page, 'media-time-slider')).h, 'the edge’s target, upright').toBeGreaterThanOrEqual(56);
      // It hides with the film playing untouched, and a tap brings it back without pausing; a tap with it up pauses.
      await expect(page.locator('.video-controls-content')).not.toHaveAttribute('data-visible', /.*/, { timeout: 6000 });
      await tap(page, 195, 300);
      await expect(page.locator('.video-controls-content')).toHaveAttribute('data-visible', '');
      await page.waitForTimeout(350);
      expect((await media(page)).paused, 'the first tap only brings the controls back').toBe(false);
      await tap(page, 195, 300);
      await expect.poll(async () => (await media(page)).paused, { message: 'a tap with the controls up' }).toBe(true);

      // On its side: 667 × 375, and 844 × 390.
      for (const [width, height] of [[667, 375], [844, 390]] as const) {
        await page.setViewportSize({ width, height });
        await page.waitForFunction((w) => Math.abs(document.querySelector('media-container')!.getBoundingClientRect().width - w) < 1, width);
        await settle(page);
        box = await picture(page);
        expect([Math.round(box.w), Math.round(box.h)], `the player fills ${width} × ${height}`).toEqual([width, height]);
        await expect(container).toHaveAttribute('data-fb-short', '');
        bar = (await boxes(page, '.fb-bar'))[0];
        expect(bar.y + bar.h, `the slab is inside ${width} × ${height}`).toBeLessThanOrEqual(height);
        expect(bar.h, 'one row').toBeLessThan(64);
        const video = (await boxes(page, 'video'))[0];
        expect(video.h, 'the film has the screen’s height (less the print’s margin)').toBeGreaterThan(height * 0.85);
        const small: string[] = [];
        for (const key of ['.fb-play', 'media-time-slider', '.fb-settings', '.fb-fullscreen']) {
          const hit = await hitArea(page, key);
          if (hit.w < 44 || hit.h < 44) small.push(`${key}: ${hit.w}×${hit.h}`);
        }
        expect(small, `targets under 44 px at ${width} × ${height}`).toEqual([]);
        // The paused page composes: its stamp and the slab share no pixel. Under a finger (a phone on its side) the
        // picture carries no keys of the page's: Plate is in Settings, with Keep this page; Bookmark is in the top row.
        const parts = [...(await boxes(page, '.fb-stamp')), ...(await boxes(page, '.fb-plate-toggle')), bar];
        for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) expect(overlap(parts[i], parts[j]), `parts ${i} and ${j} of the paused page share pixels at ${width} × ${height}`).toBe(false);
        if (await page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches)) {
          for (const selector of ['.fb-plate-toggle', '.fb-keep', '.fb-ear-button', '.fb-curl-button']) expect(await boxes(page, selector), `${selector} on the paused picture at ${width} × ${height}`).toEqual([]);
          expect(await page.locator('.media-menu-item[data-fb-menu="plate"]').evaluate((el: HTMLElement) => el.hidden), 'Settings offers Plate').toBe(false);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      }

      // The key again puts it back in the page, where it was.
      await page.locator('.fb-fullscreen').tap();
      await expect(container).not.toHaveAttribute('data-fb-fill', /.*/);
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(container).toHaveAttribute('data-fb-pad', '');
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).not.toBe('hidden');
      expect(await container.evaluate((el) => el.hasAttribute('popover'))).toBe(false);
    } finally {
      await ctx.close();
    }
  });

  test('the controls keep clear of the notch and the home indicator', async ({ browser, browserName }) => {
    test.skip(browserName !== 'chromium', 'safe-area insets can only be set from Chromium’s DevTools protocol');
    const { ctx, page } = await phone(browser, browserName, 844, 390);
    try {
      await page.addInitScript(noElementFullscreen);
      const cdp = await ctx.newCDPSession(page);
      const insets = { top: 0, left: 47, bottom: 21, right: 47 };
      try {
        await cdp.send('Emulation.setSafeAreaInsetsOverride' as never, { insets } as never);
      } catch {
        test.skip(true, 'this Chromium can’t emulate safe-area insets');
      }
      await open(page, BARE);
      expect(await page.evaluate(() => {
        const probe = document.createElement('div');
        probe.style.cssText = 'position:fixed;left:env(safe-area-inset-left,0px);bottom:env(safe-area-inset-bottom,0px)';
        document.body.append(probe);
        const style = getComputedStyle(probe);
        const out = [style.left, style.bottom];
        probe.remove();
        return out;
      }), 'the page sees the insets (viewport-fit=cover)').toEqual(['47px', '21px']);
      await page.locator('video').evaluate((video: HTMLVideoElement) => video.play());
      await page.waitForFunction(() => (document.querySelector('video') as HTMLVideoElement).currentTime > 1.2);
      await page.locator('.fb-fullscreen').evaluate((el: HTMLElement) => el.click());
      await expect(page.locator('media-container')).toHaveAttribute('data-fb-fill', '');
      await page.locator('video').evaluate((video: HTMLVideoElement) => video.pause());
      await settle(page);
      const bar = (await boxes(page, '.fb-bar'))[0];
      expect(bar.x, 'the slab clears the left inset').toBeGreaterThanOrEqual(insets.left);
      expect(844 - (bar.x + bar.w), 'and the right').toBeGreaterThanOrEqual(insets.right);
      expect(390 - (bar.y + bar.h), 'and the home indicator').toBeGreaterThanOrEqual(insets.bottom);
    } finally {
      await ctx.close();
    }
  });
});

test.describe('what a phone needs besides', () => {
  test('the lock screen and a headset get the film: its title, the chapter, artwork, and handlers to play, pause and seek', async ({ browser, browserName }) => {
    const { ctx, page } = await phone(browser, browserName);
    try {
      await page.addInitScript(() => {
        const handlers: string[] = [];
        (window as unknown as { __handlers: string[] }).__handlers = handlers;
        if (!('mediaSession' in navigator)) return;
        const proto = Object.getPrototypeOf(navigator.mediaSession) as MediaSession;
        const set = proto.setActionHandler;
        proto.setActionHandler = function (this: MediaSession, action, handler) {
          if (handler) handlers.push(action);
          set.call(this, action, handler);
        };
      });
      await open(page, BARE);
      test.skip(!(await page.evaluate(() => 'mediaSession' in navigator)), 'no Media Session in this browser');
      await tapToStart(page);
      await expect.poll(() => page.evaluate(() => navigator.mediaSession.metadata?.title ?? '')).toBe('Locomotion');
      await expect.poll(() => page.evaluate(() => navigator.mediaSession.metadata?.artist ?? '')).toBe('The Book');
      await expect.poll(() => page.evaluate(() => navigator.mediaSession.metadata?.artwork.length ?? 0), { message: 'artwork' }).toBeGreaterThan(0);
      const handlers = await page.evaluate(() => (window as unknown as { __handlers: string[] }).__handlers);
      for (const action of ['play', 'pause', 'seekbackward', 'seekforward', 'seekto']) expect(handlers, `a handler for ${action}`).toContain(action);
      expect(await page.evaluate(() => navigator.mediaSession.playbackState)).toBe('playing');
      // The chapter follows the film.
      await seekPainted(page, CHAPTERS[2] + 1);
      await expect.poll(() => page.evaluate(() => navigator.mediaSession.metadata?.artist ?? '')).toBe('The Herd');
    } finally {
      await ctx.close();
    }
  });

  test('the film plays in the page (playsinline); nothing in the pad is selected or called out by a long press; no key zooms; hover stays a mouse’s', async ({ browser, browserName }) => {
    const { ctx, page } = await phone(browser, browserName);
    try {
      await open(page, BARE);
      expect(await page.locator('video').evaluate((video: HTMLVideoElement) => video.playsInline || video.hasAttribute('playsinline'))).toBe(true);
      await startAndHold(page, 20);
      const styles = await page.evaluate(() => {
        const read = (selector: string) => {
          const el = document.querySelector(selector) as HTMLElement;
          const style = getComputedStyle(el);
          return { select: style.userSelect || style.webkitUserSelect, touch: style.touchAction };
        };
        return { bar: read('.fb-bar'), play: read('.fb-play'), tab: read('.fb-tab'), slider: read('media-time-slider'), container: read('media-container'), video: read('video') };
      });
      for (const [name, style] of Object.entries(styles)) if (name !== 'container') expect(style.select, `user-select on ${name}`).toBe('none');
      expect(styles.play.touch, 'no double-tap zoom on a key').toBe('manipulation');
      expect(styles.tab.touch).toBe('manipulation');
      expect(styles.slider.touch, 'the edge lets the page scroll past it').toBe('pan-y');
      expect(styles.container.touch, 'the picture: sideways is the film’s, up and down the page’s, two fingers zoom').toBe('pan-y pinch-zoom');
      // (Firefox has no tap flash to take away, and no such property: it answers nothing.)
      expect(await page.locator('media-container').evaluate((el) => getComputedStyle(el).webkitTapHighlightColor ?? ''), 'no tap flash').toMatch(/rgba\(0, 0, 0, 0\)|transparent|^$/);
      // The time's field is 16 px (iOS zooms into anything smaller).
      await page.locator('.fb-time-display').tap();
      await expect(page.locator('.fb-time-field')).toBeVisible();
      expect(await page.locator('.fb-time-field').evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
      // No keycap on a screen with no keyboard.
      if (await page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches)) expect(await boxes(page, '.fb-plate-key, .fb-keycap')).toEqual([]);
    } finally {
      await ctx.close();
    }
  });

  test('reduced motion: the pad and the picture hold still, a swipe still moves the film, and nothing glides after a flick', async ({ browser, browserName }) => {
    skipWithout(test, 'deck');
    const { ctx, page } = await phone(browser, browserName, 390, 844, { reducedMotion: 'reduce' });
    try {
      await open(page, BARE);
      await tapToStart(page);
      await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).pause());
      await seekPainted(page, 10);
      await settle(page);
      await page.waitForTimeout(800);
      expect(await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length), 'running animations at rest').toBe(0);
      const a = await page.screenshot({ animations: 'allow' });
      await page.waitForTimeout(800);
      const b = await page.screenshot({ animations: 'allow' });
      expect(a.equals(b), 'two frames 800 ms apart are the same').toBe(true);
      const box = await picture(page);
      const y = box.y + box.h * 0.5;
      await stroke(ctx, page, browserName, [box.x + 60, y], [box.x + 240, y], { ms: 110, steps: 8, swift: true });
      await expect(page.locator('fb-flip')).toHaveAttribute('data-mode', 'idle');
      const state = await media(page);
      expect(state.time, 'the film went where the finger took it').toBeGreaterThan(14);
      expect(state.time).toBeLessThan(19);
      expect(state.paused, 'and rests there: no glide, no play').toBe(true);
      const durations = await page.evaluate(() => ['.fb-hand-mark', '.fb-hand-chip', '.fb-pace-chip', '.fb-bar'].map((selector) => getComputedStyle(document.querySelector(selector) as Element).transitionDuration));
      expect(durations.every((d) => d.split(',').every((part) => parseFloat(part) === 0)), `transitions under reduced motion: ${durations.join(' | ')}`).toBe(true);
    } finally {
      await ctx.close();
    }
  });
});

test.describe('the phone’s two moments: the fan under the thumb, and a chapter opening', () => {
  test.beforeEach(() => skipWithout(test, 'deck', 'turns'));

  /** Counts what the page asks of the phone's motor, and the chapters that open. */
  const watch = (page: Page) =>
    page.evaluate(() => {
      const seen = { buzz: [] as number[], openings: [] as { index: number; leaf: boolean; at: number }[] };
      (window as unknown as { __seen: typeof seen }).__seen = seen;
      navigator.vibrate = (() => {
        seen.buzz.push(performance.now());
        return true;
      }) as typeof navigator.vibrate;
      document.querySelector('media-container')!.addEventListener('fb-opening', (event) => {
        const { index, leaf } = (event as CustomEvent<{ index: number; leaf: boolean }>).detail;
        seen.openings.push({ index, leaf, at: (document.querySelector('video') as HTMLVideoElement).currentTime });
      });
    });
  const seen = (page: Page) => page.evaluate(() => (window as unknown as { __seen: { buzz: number[]; openings: { index: number; leaf: boolean; at: number }[] } }).__seen);
  const quietHints = (page: Page) => page.addInitScript(() => localStorage.setItem('fb-hints', JSON.stringify(['swipe', 'fine', 'flick', 'bookmark', 'contents'])));

  test('the fan stands up only while a finger flips the film, seven of its pages turning through it, and is gone within 300 ms of the lift; a page a tick, never a buzz', async ({ browser, browserName }) => {
    const { ctx, page } = await phone(browser, browserName);
    try {
      await quietHints(page);
      await open(page, BARE);
      await expect(page.locator('media-container')).toHaveAttribute('data-fb-flip', '');
      await tapToStart(page);
      await seekPainted(page, 20);
      await watch(page);
      const fan = page.locator('.fb-fan');
      await expect(fan).toHaveAttribute('hidden', '');
      // Tapping, holding and double tapping raise no fan.
      const box = await picture(page);
      const y = box.y + box.h * 0.6;
      await tap(page, box.x + box.w / 2, y);
      await page.waitForTimeout(450);
      await expect(fan).toHaveAttribute('hidden', '');
      await tap(page, box.x + box.w / 2, y);
      await page.waitForTimeout(450);
      // A swipe: it is up, over the finger, inside the picture, its middle leaf the page the film is on.
      await stroke(ctx, page, browserName, [box.x + 70, y], [box.x + 70 + 150, y], { ms: 600, steps: 30, keep: true });
      await expect(fan).not.toHaveAttribute('hidden', /.*/);
      await expect(page.locator('media-container')).toHaveAttribute('data-fb-fan', '');
      await page.waitForTimeout(250);
      const leaves = await page.locator('.fb-fan-leaf').evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return { cx: r.x + r.width / 2, bottom: r.bottom, top: r.top, opacity: Number(style.opacity), image: style.backgroundImage !== 'none', position: style.backgroundPosition, shown: style.visibility !== 'hidden' };
        }),
      );
      expect(leaves.length, 'leaves').toBe(7);
      expect(leaves.filter((leaf) => leaf.shown && leaf.opacity > 0.5).length, 'leaves in sight').toBeGreaterThanOrEqual(5);
      expect(leaves.every((leaf) => leaf.image), 'each leaf is a page of the film').toBe(true);
      expect(new Set(leaves.map((leaf) => leaf.position)).size, 'seven different pages').toBe(7);
      const middle = leaves[3];
      expect(Math.abs(middle.cx - (box.x + 70 + 150)), 'the fan is at the finger, px').toBeLessThan(40);
      expect(middle.bottom, 'and over it').toBeLessThanOrEqual(y);
      expect(Math.min(...leaves.filter((leaf) => leaf.opacity > 0.5).map((leaf) => leaf.top)), 'inside the picture').toBeGreaterThanOrEqual(box.y - 1);
      // It splays: the outer leaves stand to either side of the middle one.
      expect(leaves[1].cx, 'the earlier pages to the left').toBeLessThan(middle.cx - 8);
      expect(leaves[5].cx, 'the later pages to the right').toBeGreaterThan(middle.cx + 8);
      // Only transforms and opacity move it: no leaf's size or place in the layout changes as the film runs on.
      const before = await page.locator('.fb-fan-leaf').nth(3).evaluate((el: HTMLElement) => [el.offsetWidth, el.offsetHeight, el.offsetLeft, el.offsetTop]);
      await stroke(ctx, page, browserName, [box.x + 220, y], [box.x + 300, y], { ms: 300, steps: 15, keep: true, on: true });
      const after = await page.locator('.fb-fan-leaf').nth(3).evaluate((el: HTMLElement) => [el.offsetWidth, el.offsetHeight, el.offsetLeft, el.offsetTop]);
      expect(after, 'the leaf’s own box never changed').toEqual(before);
      await lift(ctx, page, browserName, [box.x + 300, y]);
      const lifted = Date.now();
      await expect(fan).toHaveAttribute('hidden', '', { timeout: 2000 });
      expect(Date.now() - lifted, 'gone this long after the lift, ms').toBeLessThanOrEqual(300 + 150);
      await expect(page.locator('media-container')).not.toHaveAttribute('data-fb-fan', /.*/);

      // Along the edge too, standing up from it over the picture's foot.
      const slider = (await boxes(page, 'media-time-slider'))[0];
      await stroke(ctx, page, browserName, [slider.x + 80, slider.y + 14], [slider.x + 200, slider.y + 14], { ms: 400, steps: 20, keep: true });
      await expect(fan).not.toHaveAttribute('hidden', /.*/);
      await page.waitForTimeout(200);
      const onEdge = await page.locator('.fb-fan-leaf').nth(3).evaluate((el) => el.getBoundingClientRect().bottom);
      expect(onEdge, 'the fan stands on the picture’s foot (a turned leaf’s corner may dip under the pad’s edge)').toBeLessThanOrEqual(box.y + box.h + 8);
      await lift(ctx, page, browserName, [slider.x + 200, slider.y + 14]);
      await expect(fan).toHaveAttribute('hidden', '', { timeout: 2000 });

      // The motor: a fast run of pages is a purr. Never more than 25 ticks in any second.
      await stroke(ctx, page, browserName, [box.x + 20, y], [box.x + 370, y], { ms: 500, steps: 40, rest: 200 });
      await expect(page.locator('fb-flip')).toHaveAttribute('data-mode', 'idle', { timeout: 8000 });
      const { buzz } = await seen(page);
      expect(buzz.length, 'pages were felt').toBeGreaterThan(3);
      let most = 0;
      for (let i = 0; i < buzz.length; i++) most = Math.max(most, buzz.filter((t) => t >= buzz[i] && t < buzz[i] + 1000).length);
      expect(most, 'ticks in the busiest second').toBeLessThanOrEqual(25);
    } finally {
      await ctx.close();
    }
  });

  test('a chapter opens once when the film plays into it: the page goes over, the title stands for a beat, the film never stops; no seek opens one', async ({ browser, browserName }) => {
    test.slow();
    const { ctx, page } = await phone(browser, browserName);
    try {
      await quietHints(page);
      await open(page, BARE);
      await tapToStart(page);
      await watch(page);
      await countPlays(page);
      const opening = page.locator('fb-opening');
      // Seeks inside a chapter, and across one (by script, by double tap, by a tap on the edge): nothing opens.
      await seekPainted(page, 5);
      await seekPainted(page, 8);
      await seekPainted(page, 13);
      const box = await picture(page);
      await tap(page, box.x + box.w * 0.85, box.y + box.h / 2);
      await page.waitForTimeout(80);
      await tap(page, box.x + box.w * 0.85, box.y + box.h / 2);
      await expect.poll(() => time(page)).toBeGreaterThan(22.8);
      const slider = (await boxes(page, 'media-time-slider'))[0];
      await tap(page, slider.x + slider.w * 0.6, slider.y + 14);
      await page.waitForTimeout(900);
      expect((await seen(page)).openings, 'chapters opened by seeks').toEqual([]);
      await expect(opening).not.toHaveAttribute('data-open', /.*/);

      // Played across the second chapter's start: one opening, with the page going over.
      await page.evaluate(() => ((window as unknown as { __seen: { buzz: number[] } }).__seen.buzz.length = 0));
      await seekPainted(page, CHAPTERS[1] - 0.7);
      await expect(opening).toHaveAttribute('data-open', '', { timeout: 4000 });
      await expect(page.locator('.fb-opening-number')).toHaveText('2');
      await expect(page.locator('.fb-opening-name')).toHaveText('One Gallop');
      const title = await page.locator('.fb-opening-title').evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { size: parseFloat(getComputedStyle(el).fontSize), x: r.x, right: r.right, y: r.y, bottom: r.bottom };
      });
      expect(title.size, 'the title is set large, px').toBeGreaterThanOrEqual(32);
      expect(title.x >= box.x && title.right <= box.x + box.w && title.y >= box.y && title.bottom <= box.y + box.h, 'whole, inside the picture').toBe(true);
      await expect(opening).not.toHaveAttribute('data-open', /.*/, { timeout: 2500 });
      await expect(page.locator('fb-turn')).not.toHaveAttribute('data-turning', /.*/);
      await page.waitForTimeout(1200);
      const first = await seen(page);
      expect(first.openings.map((o) => o.index), 'one opening for one boundary').toEqual([1]);
      expect(first.openings[0].at - CHAPTERS[1], 'it came as the film crossed, seconds after').toBeLessThan(0.8);
      if (await page.evaluate(() => !!document.createElement('canvas').getContext('webgl'))) expect(first.openings[0].leaf, 'the page went over').toBe(true);
      expect(first.buzz.length, 'one tick').toBe(1);
      expect(await tally(page), 'the film was never paused or restarted for it').toEqual({ plays: 0, pauses: 0 });
      expect((await media(page)).rate).toBe(1);

      // A tap puts the next one away at once, and still does what a tap does.
      await seekPainted(page, CHAPTERS[2] - 0.7);
      await expect(opening).toHaveAttribute('data-open', '', { timeout: 4000 });
      await tap(page, box.x + box.w / 2, box.y + box.h / 2);
      await expect(opening).not.toHaveAttribute('data-open', /.*/, { timeout: 400 });
      await expect(page.locator('fb-turn')).not.toHaveAttribute('data-turning', /.*/);
      await expect.poll(async () => (await media(page)).paused).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  test('flipped across several chapters, one opens: the one the film lands in; a chapter chosen by its tab turns and is titled once', async ({ browser, browserName }) => {
    const { ctx, page } = await phone(browser, browserName);
    try {
      await quietHints(page);
      await open(page, BARE);
      await tapToStart(page);
      await seekPainted(page, 14);
      await watch(page);
      // Along the edge from chapter 2 (14 s) to 85 % (83 s, in chapter 5): chapters 3 and 4 go by under the thumb.
      const slider = (await boxes(page, 'media-time-slider'))[0];
      await stroke(ctx, page, browserName, [slider.x + slider.w * (14 / DURATION), slider.y + 14], [slider.x + slider.w * 0.85, slider.y + 14], { ms: 700, steps: 28, rest: 300 });
      await expect(page.locator('fb-flip')).toHaveAttribute('data-mode', 'idle', { timeout: 6000 });
      await expect(page.locator('fb-opening')).toHaveAttribute('data-open', '');
      await expect(page.locator('.fb-opening-name')).toHaveText('Torn Out');
      await page.waitForTimeout(1800);
      expect((await seen(page)).openings.map((o) => o.index), 'one opening, for where it landed').toEqual([4]);

      // The tab for chapter 2: the turn (turn.ts) and, as it lands, the title; said once, by the turn.
      const tab = (await boxes(page, '.fb-tab'))[1];
      await tap(page, tab.x + 14, tab.y + tab.h - 12);
      await expect(page.locator('fb-opening')).toHaveAttribute('data-open', '', { timeout: 3000 });
      await expect(page.locator('.fb-opening-name')).toHaveText('One Gallop');
      await expect.poll(() => page.locator('.fb-voice').evaluateAll((els) => els.map((el) => el.textContent).join(' | ')), { message: 'the chapter is said' }).toMatch(/Chapter 2: One Gallop/);
      await page.waitForTimeout(1800);
      const all = await seen(page);
      expect(all.openings.map((o) => o.index), 'and one for the tab').toEqual([4, 1]);
      expect(all.openings[1].leaf, 'the tab’s turn is the turn: no second page goes over').toBe(false);
    } finally {
      await ctx.close();
    }
  });

  test('reduced motion: no fan and no page going over; the title comes and goes by opacity alone; nothing ticks', async ({ browser, browserName }) => {
    const { ctx, page } = await phone(browser, browserName, 390, 844, { reducedMotion: 'reduce' });
    try {
      await quietHints(page);
      await open(page, BARE);
      await tapToStart(page);
      await seekPainted(page, 20);
      await watch(page);
      const box = await picture(page);
      const y = box.y + box.h * 0.6;
      await stroke(ctx, page, browserName, [box.x + 70, y], [box.x + 220, y], { ms: 500, steps: 20, keep: true });
      await expect(page.locator('fb-flip')).toHaveAttribute('data-mode', 'drag');
      await expect(page.locator('.fb-fan')).toHaveAttribute('hidden', '');
      await lift(ctx, page, browserName, [box.x + 220, y]);
      await seekPainted(page, CHAPTERS[4] - 0.7);
      await expect(page.locator('fb-opening')).toHaveAttribute('data-open', '', { timeout: 4000 });
      await expect(page.locator('fb-turn')).not.toHaveAttribute('data-turning', /.*/);
      expect(await page.locator('.fb-opening-title').evaluate((el) => getComputedStyle(el).transform), 'the title doesn’t travel').toBe('none');
      const state = await seen(page);
      expect(state.openings.at(-1)?.leaf).toBe(false);
      expect(state.buzz, 'no tick under reduced motion').toEqual([]);
    } finally {
      await ctx.close();
    }
  });

  test('a wide player with a mouse: no chapter opening; a click on the edge raises no fan; held and dragged, the fan stands beside the pointer, whole, over the readout and the tabs and on neither', async ({ page }) => {
    await open(page, BARE);
    await startAndHold(page, CHAPTERS[1] - 0.7);
    await page.evaluate(() => {
      const w = window as unknown as { __openings: number; __fans: number };
      w.__openings = 0;
      w.__fans = 0;
      const container = document.querySelector('media-container')!;
      container.addEventListener('fb-opening', () => w.__openings++);
      new MutationObserver(() => {
        if (container.hasAttribute('data-fb-fan')) w.__fans++;
      }).observe(container, { attributes: true, attributeFilter: ['data-fb-fan'] });
      void (document.querySelector('video') as HTMLVideoElement).play();
    });
    await page.waitForFunction((start) => (document.querySelector('video') as HTMLVideoElement).currentTime > start + 1.2, CHAPTERS[1]);
    expect(await page.evaluate(() => (window as unknown as { __openings: number }).__openings), 'openings on a 1280 px player').toBe(0);
    await expect(page.locator('fb-opening')).not.toHaveAttribute('data-open', /.*/);
    await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).pause());

    // A click along the edge goes there, and nothing stands up.
    const slider = (await boxes(page, 'media-time-slider'))[0];
    const y = slider.y + slider.h / 2;
    await page.mouse.move(slider.x + 200, y);
    await page.mouse.down();
    await page.mouse.up();
    await expect.poll(() => time(page)).toBeCloseTo((200 / slider.w) * DURATION, 0);
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => (window as unknown as { __fans: number }).__fans), 'fans raised by a click').toBe(0);
    await expect(page.locator('.fb-fan')).toHaveAttribute('hidden', '');

    // Held and dragged (Pedro, 12 Nov 2026: the phone's fan for a mouse, beside the track): the fan is up.
    for (const [from, to] of [[0.56, 0.705], [0.2, 0.02]]) {
      await page.mouse.move(slider.x + slider.w * from, y, { steps: 4 });
      await page.mouse.down();
      for (let i = 1; i <= 16; i++) {
        await page.mouse.move(slider.x + slider.w * (from + ((to - from) * i) / 16), y);
        await page.waitForTimeout(16);
      }
      await expect(page.locator('media-container')).toHaveAttribute('data-fb-fan', '');
      // The readout over the edge and the page count read the same page, the hand's.
      const read = () => page.evaluate(() => [document.querySelector('.fb-edge-chip')?.textContent?.replace(/\s/g, ''), document.querySelector('fb-folio')?.textContent?.split(' /')[0].replace(/\s/g, '')]);
      await expect.poll(async () => (await read())[0], { message: 'the readout over the edge reads a page' }).toMatch(/^p\.\d+$/);
      const [over, count] = await read();
      expect(over, 'the page over the edge is the page in the count').toBe(count);
      const drawn = await page.evaluate(() => {
        const leaves = [...document.querySelectorAll<HTMLElement>('.fb-fan-leaf')].filter((leaf) => getComputedStyle(leaf).visibility !== 'hidden' && Number(getComputedStyle(leaf).opacity) > 0.05).map((leaf) => leaf.getBoundingClientRect());
        const box = (el: Element) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        };
        return {
          leaves: leaves.length,
          fan: { left: Math.min(...leaves.map((r) => r.left)), top: Math.min(...leaves.map((r) => r.top)), right: Math.max(...leaves.map((r) => r.right)), bottom: Math.max(...leaves.map((r) => r.bottom)) },
          chip: box(document.querySelector('.fb-edge-chip') as Element),
          tabs: [...document.querySelectorAll('.fb-tab')].map(box),
          player: box(document.querySelector('media-container') as Element),
        };
      });
      expect(drawn.leaves, 'leaves in sight').toBeGreaterThanOrEqual(4);
      expect(drawn.fan.bottom, 'the fan ends over the readout').toBeLessThanOrEqual(drawn.chip.top);
      expect(drawn.tabs.filter((tab) => tab.left < drawn.fan.right && tab.right > drawn.fan.left && tab.top < drawn.fan.bottom).length, 'tabs under the fan').toBe(0);
      expect([drawn.fan.left >= drawn.player.left, drawn.fan.right <= drawn.player.right, drawn.fan.top >= drawn.player.top], 'the fan is whole inside the player: left, right, top').toEqual([true, true, true]);
      await measure(test.info(), { kind: 'mouse-fan', from, to, fan: [Math.round(drawn.fan.right - drawn.fan.left), Math.round(drawn.fan.bottom - drawn.fan.top)], overReadout: Math.round(drawn.chip.top - drawn.fan.bottom) });
      await page.mouse.up();
      await expect(page.locator('.fb-fan')).toHaveAttribute('hidden', '');
    }
  });
});
