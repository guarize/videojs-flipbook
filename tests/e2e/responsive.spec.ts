import { type Browser, type BrowserContextOptions, devices, type Page } from '@playwright/test';
import { BARE, DURATION, ESSENTIAL, measure, open, revealControls, seekPainted, SHOWCASE, skipWithout, startAndHold } from './support/player';
import { expect, test } from './support/test';

/**
 * The player at the sizes of real devices: phones in both orientations, the player filling a phone's screen (as in
 * fullscreen), the narrowest phone's 288 px player, tablets and laptops. Each check is a measurement of the running
 * page: rect intersections between what's drawn, and hit tests (elementFromPoint) on what takes the click. They come
 * from the responsive audit (design/previews/audit-responsive/findings.md); each names its finding.
 *
 * WebKit stands in for Safari (iPhones, iPads, rotation); Chromium for Android and desktops. A test that needs one
 * engine skips on the other. One context per test, closed in `finally`.
 */

type Box = { x: number; y: number; w: number; h: number };

/** The player filling the window, as in fullscreen on that screen (the bare page, no showcase around it). */
const FILL_CSS =
  '#player{width:100vw!important;height:100dvh!important;max-width:none!important}#player .media-skin{aspect-ratio:auto!important;height:100%!important}body{padding:0!important;display:block!important}.notes{display:none!important}';

const phone = {
  iPhoneSE: devices['iPhone SE'],
  iPhone15: devices['iPhone 15'],
  pixel7: devices['Pixel 7'],
};

async function context(browser: Browser, options: BrowserContextOptions) {
  const ctx = await browser.newContext({ ...options });
  const page = await ctx.newPage();
  return { ctx, page };
}

/** Opens the bare player filling a window of this size. */
async function fill(page: Page) {
  await open(page, BARE);
  await page.addStyleTag({ content: FILL_CSS });
  await page.waitForTimeout(300);
}

/** Sets the showcase's player to this width, as its width presets and handle do. */
async function frameWidth(page: Page, width: number) {
  await page.evaluate((w) => (document.querySelector('.canvas') as HTMLElement).style.setProperty('--frame-w', `${w}px`), width);
  await page.waitForFunction((w) => Math.abs(document.querySelector('media-container')!.getBoundingClientRect().width - w) < 1, width);
  await page.waitForTimeout(300);
}

/** Scrolls the showcase so the whole player is in view. */
const toPlayer = (page: Page) =>
  page.evaluate(() => {
    const r = document.querySelector('media-container')!.getBoundingClientRect();
    window.scrollBy(0, r.top - Math.max(0, (innerHeight - r.height) / 2));
  });

/** Rects of every element matching, drawn and visible (visibility, opacity, display), in viewport px. */
const boxes = (page: Page, selector: string) =>
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

const overlap = (a: Box, b: Box) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0.5 && h > 0.5 ? { w: Math.round(w), h: Math.round(h) } : null;
};

/** Every pair (one from each list) that shares pixels, for the message. */
const collisions = (a: Box[], b: Box[]) => a.flatMap((x) => b.map((y) => overlap(x, y)).filter(Boolean));

const inside = (a: Box, outer: Box, slack = 0.5) =>
  a.x >= outer.x - slack && a.y >= outer.y - slack && a.x + a.w <= outer.x + outer.w + slack && a.y + a.h <= outer.y + outer.h + slack;

/**
 * The hit area of each element matching: from its centre, walk out along both axes while elementFromPoint still lands
 * on it. 0 × 0 when its centre belongs to something else.
 */
const hitAreas = (page: Page, selector: string, scroll = false) =>
  page.evaluate(
    ({ sel, scroll }) => {
      return [...document.querySelectorAll<HTMLElement>(sel)]
        .filter((el) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true }))
        .map((el) => {
          if (scroll) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          const r = el.getBoundingClientRect();
          const owns = (x: number, y: number) => {
            const hit = document.elementFromPoint(x, y);
            return !!hit && (el === hit || el.contains(hit));
          };
          const cx = r.x + r.width / 2;
          const cy = r.y + r.height / 2;
          const name = `${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 28)} .${el.className.split(' ')[0]}`;
          if (!owns(cx, cy)) {
            const hit = document.elementFromPoint(cx, cy);
            return { name, w: 0, h: 0, by: hit ? `${hit.tagName.toLowerCase()}.${String(hit.className).split(' ')[0]}` : 'nothing' };
          }
          const reach = (dx: number, dy: number) => {
            let n = 0;
            while (n < 400 && owns(cx + dx * (n + 1), cy + dy * (n + 1))) n++;
            return n;
          };
          return { name, w: reach(-1, 0) + reach(1, 0) + 1, h: reach(0, -1) + reach(0, 1) + 1, by: '' };
        });
    },
    { sel: selector, scroll },
  );

const player = async (page: Page): Promise<Box> => (await boxes(page, 'media-container'))[0];

/** Waits until nothing in the page is mid-transition (the plate's cells, the chip, a slip). */
const still = (page: Page) =>
  page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity));

/** Opens the plate with P and waits for its frames to stand still. */
async function openPlate(page: Page) {
  await page.evaluate(() => (document.querySelector('media-container') as HTMLElement).focus({ preventScroll: true }));
  await page.keyboard.press('p');
  await expect(page.locator('.fb-plate-sheet')).toBeVisible();
  await page.waitForTimeout(600);
  await still(page);
}

/** The plate laid out: every frame and the close key are whole targets, inside the picture, clear of the tabs. */
async function expectPlateFits(page: Page, where: string) {
  const p = await player(page);
  const sheet = (await boxes(page, '.fb-plate-sheet'))[0];
  expect(inside(sheet, p), `${where}: the plate inside the picture`).toBe(true);
  const full = await page.locator('fb-plate').evaluate((el) => el.hasAttribute('data-full'));
  if (!full) {
    const tabs = await boxes(page, '.fb-tab');
    expect(collisions([sheet], tabs), `${where}: the plate clear of the chapter tabs`).toEqual([]);
  }
  const cells = await hitAreas(page, '.fb-plate-cell', true);
  expect(cells.length, `${where}: twelve frames`).toBe(12);
  const small = cells.filter((c) => c.w < 44 || c.h < 44).map((c) => `${c.w}×${c.h} ${c.name}${c.by ? ` (under ${c.by})` : ''}`);
  expect(small, `${where}: every frame a 44 px target, its own at its centre`).toEqual([]);
  const close = await hitAreas(page, '.fb-plate-close');
  // (42 to 44 in Firefox, which answers for a box from the whole pixel after a fractional edge: targets.spec.ts.)
  const whole = test.info().project.name === 'firefox' ? /^(4[2-9]|[5-9]\d)×(4[2-9]|[5-9]\d)$/ : /^(4[4-9]|[5-9]\d)×(4[4-9]|[5-9]\d)$/;
  expect(close.map((c) => `${c.w}×${c.h}`), `${where}: the close key a whole target`).toEqual([expect.stringMatching(whole)]);
  await measure(test.info(), { kind: 'plate', where, full, smallestCell: Math.min(...cells.map((c) => Math.min(c.w, c.h))), close: close[0] });
}

test.describe('the showcase holds the window', () => {
  test('WebKit, an iPhone turned to landscape and back: no sideways scroll (finding 1)', async ({ browser, browserName }) => {
    test.skip(browserName !== 'webkit', 'the auto-track bug is WebKit’s');
    const { ctx, page } = await context(browser, phone.iPhone15);
    try {
      await open(page, SHOWCASE);
      const portrait = phone.iPhone15.viewport;
      const steps: Record<string, number> = {};
      const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      steps.portrait = await overflow();
      await page.setViewportSize({ width: portrait.height, height: portrait.width });
      await page.waitForTimeout(600);
      steps.landscape = await overflow();
      await page.setViewportSize(portrait);
      await page.waitForTimeout(600);
      steps.back = await overflow();
      await measure(test.info(), { kind: 'rotation', steps });
      expect(steps, 'sideways overflow at each step, px').toEqual({ portrait: 0, landscape: 0, back: 0 });
    } finally {
      await ctx.close();
    }
  });

  test('WebKit, a Safari window narrowed from 1280 to 700: no sideways scroll (finding 1)', async ({ page, browserName }) => {
    test.skip(browserName !== 'webkit', 'the auto-track bug is WebKit’s');
    await open(page, SHOWCASE);
    await page.setViewportSize({ width: 700, height: 800 });
    await page.waitForTimeout(600);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBe(0);
  });
});

test.describe('what stands over the slab is clear of the chapter tabs', () => {
  for (const width of [768, 1280]) {
    test(`${width} px: the plate key and the next-chapter key are theirs to the edge (finding 3, 16)`, async ({ page }) => {
      skipWithout(test, 'plate', 'next');
      await page.setViewportSize({ width, height: 800 });
      await open(page, SHOWCASE);
      await toPlayer(page);
      await startAndHold(page, 20);
      await revealControls(page);
      await still(page);
      const tabs = await boxes(page, '.fb-tab');
      expect(tabs.length, 'the tabs are up').toBeGreaterThan(3);
      const key = (await boxes(page, '.fb-plate-toggle'))[0];
      expect(key, 'the plate key shows').toBeTruthy();
      expect(collisions([key], tabs), 'the plate key against the tabs').toEqual([]);
      // Its whole box is its own: the middle of each edge, 2 px in (its corners are rounded off).
      const owned = await page.evaluate(({ x, y, w, h }) => {
        const key = document.querySelector('.fb-plate-toggle')!;
        return [[x + w / 2, y + 2], [x + w / 2, y + h - 2], [x + 2, y + h / 2], [x + w - 2, y + h / 2]].map(([px, py]) => key.contains(document.elementFromPoint(px, py)));
      }, key);
      expect(owned, 'the plate key at the top, foot, start and end').toEqual([true, true, true, true]);

      // The next-chapter key never opens on this film by itself (its chapters are short): opened by hand.
      await page.evaluate(() => {
        const next = document.querySelector('fb-next') as HTMLElement;
        next.inert = false;
        next.toggleAttribute('data-open', true);
      });
      await page.waitForTimeout(400);
      const next = await boxes(page, '.fb-next-button');
      expect(next.length).toBe(1);
      expect(collisions(next, tabs), 'the next-chapter key against the tabs').toEqual([]);
      await measure(test.info(), { kind: 'over-slab', width, plateKeyBottom: Math.round(key.y + key.h), tabsTop: Math.round(Math.min(...tabs.map((t) => t.y))) });
    });

    test(`${width} px: the resume offer is clear of the tabs (finding 3)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await open(page, SHOWCASE);
      // A film part-watched: the offer to resume shows on the cover.
      await page.evaluate(() => {
        const v = document.querySelector('video')!;
        localStorage.setItem(`x-resume:${new URL(v.getAttribute('data-fb-film') ?? v.getAttribute('src')!, location.href).pathname}`, JSON.stringify({ t: 30, d: v.duration }));
      });
      await open(page, SHOWCASE);
      await toPlayer(page);
      await expect(page.locator('.fb-resume-button').first()).toBeVisible();
      await still(page);
      const tabs = await boxes(page, '.fb-tab');
      const offer = await boxes(page, '.fb-resume-button');
      expect(collisions(offer, tabs), 'the resume keys against the tabs').toEqual([]);
      await page.evaluate(() => localStorage.clear());
    });
  }
});

test.describe('the plate fits the picture it lies on', () => {
  test.beforeEach(() => skipWithout(test, 'plate'));
  const fills = [
    { name: 'a Galaxy S24 on its side, 780 × 360', engine: 'chromium', options: { ...devices['Galaxy S24 landscape'], viewport: { width: 780, height: 360 } } },
    { name: 'a Pixel 7 on its side, 915 × 412', engine: 'chromium', options: { ...devices['Pixel 7 landscape'], viewport: { width: 915, height: 412 } } },
    { name: 'an iPhone SE on its side, 667 × 375', engine: 'webkit', options: { ...devices['iPhone SE (3rd gen) landscape'], viewport: { width: 667, height: 375 } } },
    { name: 'an iPhone 15 on its side, 852 × 393', engine: 'webkit', options: { ...devices['iPhone 15 landscape'], viewport: { width: 852, height: 393 } } },
  ];
  for (const { name, engine, options } of fills) {
    test(`filling ${name} (finding 2, 17)`, async ({ browser, browserName }) => {
      test.skip(browserName !== engine, `measured in ${engine}`);
      const { ctx, page } = await context(browser, options);
      try {
        await fill(page);
        await startAndHold(page, 20);
        await openPlate(page);
        await expectPlateFits(page, name);
      } finally {
        await ctx.close();
      }
    });
  }

  test('the narrowest phone’s 288 px player (finding 7, defect 3)', async ({ browser, browserName }) => {
    test.skip(browserName !== 'webkit', 'an iPhone SE is Safari');
    const { ctx, page } = await context(browser, phone.iPhoneSE);
    try {
      await open(page, SHOWCASE);
      await toPlayer(page);
      await startAndHold(page, 20);
      await openPlate(page);
      await expectPlateFits(page, '288 px');
    } finally {
      await ctx.close();
    }
  });

  for (const width of [768, 1280]) {
    test(`${width} px: the close key is a whole target, clear of the frames (finding 17, defect 3)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await open(page, SHOWCASE);
      await toPlayer(page);
      await startAndHold(page, 20);
      await openPlate(page);
      await expectPlateFits(page, `${width} px`);
    });
  }

  test('an open plate lays itself out again when the phone turns (finding 23)', async ({ browser, browserName }) => {
    test.skip(browserName !== 'chromium', 'rotation is checked on Android here, the showcase’s on WebKit above');
    const { ctx, page } = await context(browser, phone.pixel7);
    try {
      await open(page, SHOWCASE);
      await toPlayer(page);
      await startAndHold(page, 20);
      await openPlate(page);
      await expectPlateFits(page, 'portrait');
      const portrait = phone.pixel7.viewport;
      await page.setViewportSize({ width: portrait.height, height: portrait.width });
      await page.waitForTimeout(500);
      await toPlayer(page);
      await page.waitForTimeout(500);
      await still(page);
      await expectPlateFits(page, 'turned to landscape');
      await page.setViewportSize(portrait);
      await page.waitForTimeout(500);
      await toPlayer(page);
      await page.waitForTimeout(500);
      await still(page);
      await expectPlateFits(page, 'turned back');
    } finally {
      await ctx.close();
    }
  });
});

test.describe('a phone in portrait', () => {
  test('captions never cover the plate key, the top keys or the slab, at every size and place (finding 4)', async ({ browser, browserName }) => {
    test.skip(browserName !== 'webkit', 'an iPhone is Safari');
    const { ctx, page } = await context(browser, phone.iPhone15);
    try {
      await open(page, SHOWCASE);
      await toPlayer(page);
      await startAndHold(page, 20);
      // C is the player's with the pointer over it (page-keys.ts). (This used to pass without it: going back to a caption
      // switched captions on by itself, which a paused film no longer does, rewind-captions.ts.)
      await revealControls(page);
      await page.keyboard.press('c');
      await seekPainted(page, 28);
      await revealControls(page);
      await expect(page.locator('.fb-captions-line').first()).toBeVisible();
      const hits: string[] = [];
      for (const size of ['s', 'm', 'l', 'xl']) {
        for (const position of ['auto', 'top']) {
          await page.evaluate(([s, p]) => {
            const c = document.querySelector('media-container')!;
            c.setAttribute('data-fb-cap-size', s);
            c.setAttribute('data-fb-cap-position', p);
          }, [size, position]);
          await revealControls(page);
          await page.waitForTimeout(350);
          await still(page);
          const lines = await boxes(page, '.fb-captions-line');
          expect(lines.length, `captions ${size} ${position} show`).toBeGreaterThan(0);
          for (const [what, sel] of [['plate key', '.fb-plate-toggle'], ['top keys', '.video-controls-top > .media-button'], ['slab', '.fb-bar'], ['title', '.media-title']]) {
            const found = collisions(lines, await boxes(page, sel));
            if (found.length) hits.push(`${size}/${position} over the ${what}: ${JSON.stringify(found)}`);
          }
        }
      }
      expect(hits).toEqual([]);
    } finally {
      await ctx.close();
    }
  });

  for (const [name, options, least] of [
    ['iPhone 15, a 361 px player', phone.iPhone15, 120],
    ['iPhone SE, a 288 px player', phone.iPhoneSE, 72],
  ] as const) {
    test(`${name}: the fore-edge keeps a thumb’s width, clear of the time (finding 5)`, async ({ browser, browserName }) => {
      test.skip(browserName !== 'webkit', 'an iPhone is Safari');
      const { ctx, page } = await context(browser, options);
      try {
        await open(page, SHOWCASE);
        await toPlayer(page);
        await startAndHold(page, 20);
        const slider = (await boxes(page, 'media-time-slider'))[0];
        const time = await boxes(page, '.fb-time-display');
        // Its length along the film: down the picture's side on a phone (phone.spec.ts), across the slab otherwise.
        const length = Math.max(slider.w, slider.h);
        await measure(test.info(), { kind: 'scrubber', name, width: Math.round(length) });
        expect(length, 'the fore-edge’s length, px').toBeGreaterThanOrEqual(least);
        expect(Math.min(slider.w, slider.h), 'and a whole target across, px').toBeGreaterThanOrEqual(44);
        expect(collisions([slider], time), 'the fore-edge against the time').toEqual([]);
        // The time still says the whole of it to a screen reader.
        await expect(page.locator('.fb-time-display')).toHaveAttribute('aria-label', /^0:20 \/ 1:38/);
      } finally {
        await ctx.close();
      }
    });
  }

  test('the time field is 16 px, so Safari doesn’t zoom into it (finding 11)', async ({ browser, browserName }) => {
    test.skip(browserName !== 'webkit', 'the zoom is iOS Safari’s');
    const { ctx, page } = await context(browser, phone.iPhone15);
    try {
      await open(page, SHOWCASE);
      const size = await page.locator('.fb-time-field').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      expect(size).toBeGreaterThanOrEqual(16);
    } finally {
      await ctx.close();
    }
  });

  test('the four caption sizes stay four, each on its floor (finding 12)', async ({ browser, browserName }) => {
    test.skip(browserName !== 'webkit', 'an iPhone is Safari');
    const { ctx, page } = await context(browser, phone.iPhone15);
    try {
      await open(page, SHOWCASE);
      const sizes = await page.evaluate(() => {
        const c = document.querySelector('media-container')!;
        const lines = document.querySelector('.fb-captions-lines')!;
        const out: Record<string, number> = {};
        for (const s of ['s', 'm', 'l', 'xl']) {
          if (s === 'm') c.removeAttribute('data-fb-cap-size');
          else c.setAttribute('data-fb-cap-size', s);
          out[s] = parseFloat(getComputedStyle(lines).fontSize);
        }
        return out;
      });
      await measure(test.info(), { kind: 'caption-sizes', sizes });
      expect(sizes.s).toBeGreaterThanOrEqual(14);
      expect(sizes.m).toBeGreaterThanOrEqual(16);
      expect(sizes.l).toBeGreaterThanOrEqual(19);
      expect(sizes.xl).toBeGreaterThanOrEqual(22);
      expect(sizes.s < sizes.m && sizes.m < sizes.l && sizes.l < sizes.xl, JSON.stringify(sizes)).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  test('sentence text in the player is at least 16 px (finding 21)', async ({ browser, browserName }) => {
    test.skip(browserName !== 'webkit', 'an iPhone is Safari');
    const { ctx, page } = await context(browser, phone.iPhone15);
    try {
      await open(page, SHOWCASE);
      // The shortcut card is drawn when it first opens.
      await page.evaluate(() => (document.querySelector('media-container') as HTMLElement).focus({ preventScroll: true }));
      await page.keyboard.press('?');
      await expect(page.locator('fb-keymap [role="dialog"]')).toBeVisible();
      const sizes = await page.evaluate(() =>
        Object.fromEntries(
          ['.fb-resume-button', '.fb-plate-toggle', '.fb-hint', '.fb-next-button', '.fb-keymap-row dd', '.fb-cover-entry', '.fb-captype-reset', '.fb-captype-done'].map((s) => {
            const el = document.querySelector(s);
            return [s, el ? parseFloat(getComputedStyle(el).fontSize) : -1];
          }),
        ),
      );
      // An extra that's off isn't in the page (-1): under essential only the core's text is measured.
      const under = Object.entries(sizes).filter(([, v]) => v < 16 && !(ESSENTIAL && v === -1));
      expect(under, JSON.stringify(sizes)).toEqual([]);
    } finally {
      await ctx.close();
    }
  });

  test('caption style opens with Reset and Done in reach (finding 24)', async ({ browser, browserName }) => {
    test.skip(browserName !== 'webkit', 'an iPhone is Safari');
    const { ctx, page } = await context(browser, phone.iPhone15);
    try {
      await open(page, SHOWCASE);
      await toPlayer(page);
      await page.evaluate(() => (document.querySelector('media-container') as HTMLElement).focus({ preventScroll: true }));
      await page.keyboard.press('Shift+C');
      const dialog = page.locator('fb-caption-style [role="dialog"]');
      await expect(dialog).toBeVisible();
      await still(page);
      const keys = await hitAreas(page, '.fb-captype-reset, .fb-captype-done');
      expect(keys.map((k) => `${k.name}: ${k.w}×${k.h}${k.by ? ` under ${k.by}` : ''}`).filter((k) => !/: (4[4-9]|[5-9]\d|\d{3})×(4[4-9]|[5-9]\d)$/.test(k))).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
});

test.describe('the smallest player: 288 px on a 320 px phone', () => {
  test('the covers keep their title, play and offer clear of the keys and the slab (finding 6, 18, 19)', async ({ browser, browserName }) => {
    skipWithout(test, 'cover');
    test.skip(browserName !== 'webkit', 'an iPhone SE is Safari');
    const { ctx, page } = await context(browser, phone.iPhoneSE);
    try {
      await open(page, SHOWCASE);
      await toPlayer(page);
      await page.waitForTimeout(400);
      await still(page);
      const keys = await boxes(page, '.video-controls-top > .media-button');
      const bar = await boxes(page, '.fb-bar');
      const front = [...(await boxes(page, '.fb-jacket-plate')), ...(await boxes(page, '.fb-cover-play'))];
      expect(front.length, 'the cover shows its plate').toBeGreaterThan(0);
      expect(collisions(front, [...keys, ...bar]), 'the front cover’s plate and disc against the keys and the slab').toEqual([]);

      // The back cover, at the end.
      await page.evaluate(() => {
        const v = document.querySelector('video')!;
        v.currentTime = v.duration - 0.4;
        return v.play();
      });
      await expect(page.locator('fb-cover[data-open]')).toBeVisible({ timeout: 8000 });
      await page.waitForTimeout(800);
      await still(page);
      const inner = (await boxes(page, '.fb-cover-inner'))[0];
      const title = await boxes(page, '.fb-cover-title');
      const again = await boxes(page, '.fb-cover-again');
      expect(title.length && again.length, 'title and Watch again show').toBeTruthy();
      expect([...title, ...again].every((b) => inside(b, inner)), 'title and Watch again whole inside the cover').toBe(true);
      expect(collisions([...title, ...again], await boxes(page, '.video-controls-top > .media-button')), 'against the top keys').toEqual([]);
      const againHit = await hitAreas(page, '.fb-cover-again');
      expect(againHit[0].h, 'Watch again a whole target').toBeGreaterThanOrEqual(44);

      // The front cover again, with a film part-watched: the offer. Seeded before the page loads (leaving the ended
      // film's page would write its own position).
      const key = await page.evaluate(() => `x-resume:${new URL(document.querySelector('video')!.getAttribute('data-fb-film') ?? document.querySelector('video')!.getAttribute('src')!, location.href).pathname}`);
      await page.close();
      const again2 = await ctx.newPage();
      await again2.addInitScript(([k, d]) => localStorage.setItem(k, JSON.stringify({ t: 30, d })), [key, DURATION] as const);
      await open(again2, SHOWCASE);
      await toPlayer(again2);
      await expect(again2.locator('.fb-resume-button').first()).toBeVisible();
      await still(again2);
      const offer = await boxes(again2, '.fb-resume-button');
      expect(collisions(offer, [...(await boxes(again2, '.video-controls-top > .media-button')), ...(await boxes(again2, '.fb-bar'))]), 'the offer against the keys and the slab').toEqual([]);
    } finally {
      await ctx.close();
    }
  });

  test('the settings menu shows it has more (finding 25)', async ({ browser, browserName }) => {
    test.skip(browserName !== 'webkit', 'an iPhone SE is Safari');
    const { ctx, page } = await context(browser, phone.iPhoneSE);
    try {
      await open(page, SHOWCASE);
      await toPlayer(page);
      await startAndHold(page, 20);
      await page.locator('.fb-settings').click();
      await expect(page.locator('#flipbook-settings')).toBeVisible();
      await still(page);
      const m = await page.locator('#flipbook-settings .media-menu-content').first().evaluate((el) => ({
        more: el.scrollHeight > el.clientHeight + 1,
        attachment: getComputedStyle(el).backgroundAttachment,
      }));
      // Where it's taller than its room, it carries the scroll shade (backgrounds that scroll with the items).
      if (m.more) expect(m.attachment).toContain('local');
    } finally {
      await ctx.close();
    }
  });
});

test.describe('titles, chips and slips', () => {
  test('the title shows a word or two, or steps aside (finding 8)', async ({ page }) => {
    for (const width of [288, 393, 480, 523, 600]) {
      await open(page, SHOWCASE);
      await frameWidth(page, width);
      await toPlayer(page);
      await startAndHold(page, 20);
      const title = await page.locator('.media-title').evaluate((el) => ({
        // (A phone's pad keeps the title off the picture altogether: phone.spec.ts.)
        shown: el.checkVisibility() && getComputedStyle(el).visibility !== 'hidden' && Number(getComputedStyle(el).opacity) > 0.05,
        width: el.getBoundingClientRect().width,
      }));
      if (title.shown) expect(title.width, `at ${width}: the title’s width`).toBeGreaterThanOrEqual(72);
    }
  });

  test('the seek chip stays on the fore-edge, at the start and the end (finding 13)', async ({ browser, browserName }) => {
    test.skip(browserName !== 'chromium', 'measured on Android');
    const { ctx, page } = await context(browser, phone.pixel7);
    try {
      await open(page, SHOWCASE);
      await toPlayer(page);
      await startAndHold(page, 2);
      for (const [at, key] of [[2, 'ArrowLeft'], [60, 'ArrowRight'], [30, 'ArrowRight']] as const) {
        await seekPainted(page, at);
        await page.waitForFunction(() => !document.querySelector('.fb-edge-chip[data-open]'));
        await page.evaluate(() => (document.querySelector('media-container') as HTMLElement).focus({ preventScroll: true }));
        // Playing: the chip counts a seek by key on a running film; paused, the book's arrows turn one page (flip.ts).
        await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).play());
        await page.waitForFunction(() => !(document.querySelector('video') as HTMLVideoElement).paused);
        await page.keyboard.press(key);
        await expect(page.locator('.fb-edge-chip[data-open]')).toBeVisible();
        await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).pause());
        await page.waitForTimeout(220);
        const chip = (await boxes(page, '.fb-edge-chip'))[0];
        const slider = (await boxes(page, 'media-time-slider'))[0];
        // Over the ribbon, where the preview stands (round 2): within the edge's width, above it.
        const where = `chip at ${at} s (${key}): ${JSON.stringify({ chip, slider })}`;
        expect(chip.x >= slider.x - 1 && chip.x + chip.w <= slider.x + slider.w + 1, `${where}, within the fore-edge’s width`).toBe(true);
        expect(chip.y + chip.h <= slider.y, `${where}, above the fore-edge`).toBe(true);
        expect(collisions([chip], [...(await boxes(page, '.fb-play')), ...(await boxes(page, '.fb-time-display'))])).toEqual([]);
      }
    } finally {
      await ctx.close();
    }
  });

  test('hints keep off the plate key, and off the back cover (finding 14)', async ({ page }) => {
    skipWithout(test, 'hints', 'plate', 'cover');
    await open(page, SHOWCASE);
    await frameWidth(page, 480);
    await toPlayer(page);
    await startAndHold(page, 20);
    await page.evaluate(() => localStorage.removeItem('fb-hints'));
    await revealControls(page);
    await page.locator('.fb-tab').nth(3).click({ force: true });
    await expect(page.locator('.fb-hint')).toBeVisible();
    await page.waitForTimeout(400);
    await still(page);
    expect(collisions(await boxes(page, '.fb-hint'), await boxes(page, '.fb-plate-toggle'))).toEqual([]);
    // On the back cover, a slip that opens anyway isn't drawn.
    const drawn = await page.evaluate(() => {
      const c = document.querySelector('media-container')!;
      c.toggleAttribute('data-fb-cover', true);
      const hints = document.querySelector('fb-hints') as HTMLElement;
      hints.toggleAttribute('data-open', true);
      const shown = hints.checkVisibility();
      c.toggleAttribute('data-fb-cover', false);
      return shown;
    });
    expect(drawn).toBe(false);
  });

  test('the showcase promises only what the N key does (finding 16)', async ({ page }) => {
    await open(page, SHOWCASE);
    await expect(page.locator('.move', { hasText: 'Next chapter.' })).not.toContainText('last seconds');
  });
});

test.describe('the slab holds its keys whole', () => {
  // Every width a window is dragged through, closest together around the widths where the slab changes its row
  // (480, 720) and where the keys take their names (1240): the folio was cut by the keys at 1200 to 1220 px.
  const WIDTHS = [320, 360, 390, 479, 480, 640, 719, 720, 768, 900, 1024, 1100, 1180, 1200, 1210, 1220, 1230, 1239, 1240, 1260, 1280, 1440];

  test('from 320 to 1440 px: nothing on the slab is cut, nothing lies over its neighbour', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page, BARE);
    await startAndHold(page, 20);
    const cut: string[] = [];
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      await revealControls(page);
      await still(page);
      const found = await page.evaluate(() => {
        const bar = document.querySelector('.fb-bar') as HTMLElement;
        const seen = (el: Element) => (el as HTMLElement).checkVisibility({ opacityProperty: true, visibilityProperty: true }) && el.getBoundingClientRect().width > 0;
        const out: string[] = [];
        const name = (el: Element) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(-1)[0]}`;
        // What is written on the slab: every element holding text of its own, in sight.
        // (Not a name kept for a screen reader alone, clipped to a pixel on purpose. And not the time's own key: under
        // 720 px it shows the elapsed clock alone by design, the film's length clipped off and kept in its name and field.)
        const written = [...bar.querySelectorAll<HTMLElement>('*')].filter((el) => seen(el) && el.getBoundingClientRect().width > 1 && !el.matches('.fb-time-display') && !el.closest('[popover], media-tooltip, media-menu, .fb-sr-only') && [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent?.trim()));
        for (const el of written) {
          if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible') out.push(`${name(el)} holds ${el.scrollWidth} px of text in ${el.clientWidth}`);
          // Cut by something that clips it further up.
          const box = el.getBoundingClientRect();
          for (let up = el.parentElement; up && bar.contains(up); up = up.parentElement) {
            if (getComputedStyle(up).overflowX === 'visible') continue;
            const clip = up.getBoundingClientRect();
            if (box.left < clip.left - 0.5 || box.right > clip.right + 0.5) out.push(`${name(el)} runs ${Math.round(Math.max(clip.left - box.left, box.right - clip.right))} px out of ${name(up)}`);
          }
        }
        // The keys and the clock, side by side: no two share a pixel.
        const keys = [...bar.querySelectorAll<HTMLElement>('button, [role="button"], [role="slider"], .fb-clock, .fb-ends')].filter((el) => seen(el) && !el.closest('[popover], media-tooltip, media-menu, media-time-slider, .fb-clock button, .fb-clock [role="button"]'));
        for (let i = 0; i < keys.length; i++) {
          for (let j = i + 1; j < keys.length; j++) {
            if (keys[i].contains(keys[j]) || keys[j].contains(keys[i])) continue;
            const [a, b] = [keys[i].getBoundingClientRect(), keys[j].getBoundingClientRect()];
            const over = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const high = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (over > 0.5 && high > 0.5) out.push(`${name(keys[i])} lies ${Math.round(over)} px over ${name(keys[j])}`);
          }
        }
        if (bar.scrollWidth > bar.clientWidth + 1) out.push(`the slab holds ${bar.scrollWidth} px in ${bar.clientWidth}`);
        return { out, written: written.length, keys: keys.length };
      });
      expect(found.keys, `${width} px: the slab's keys were measured`).toBeGreaterThan(3);
      cut.push(...found.out.map((line) => `${width} px: ${line}`));
    }
    expect(cut, 'cut or overlapping on the slab').toEqual([]);
  });
});

test.describe('chapter tabs, close together', () => {
  for (const width of [480, 523]) {
    test(`a ${width} px player: each tab a whole target, none overlapping (finding 20)`, async ({ page }) => {
      await open(page, SHOWCASE);
      await frameWidth(page, width);
      await toPlayer(page);
      await startAndHold(page, 20);
      const tabs = await boxes(page, '.fb-tab');
      expect(tabs.length).toBe(6);
      const pairs = tabs.slice(1).map((t, i) => overlap(tabs[i], t)).filter(Boolean);
      expect(pairs, 'neighbouring tabs share pixels').toEqual([]);
      const hits = await hitAreas(page, '.fb-tab');
      expect(hits.filter((h) => h.w < 44 || h.h < 44).map((h) => `${h.w}×${h.h} ${h.name}`)).toEqual([]);
    });
  }
});

test.describe('the docked mini player', () => {
  test.beforeEach(() => skipWithout(test, 'float'));
  test('an iPhone SE on its side: no taller than a third of the window, and focus scrolls clear of it (finding 9, a11y 12)', async ({ browser, browserName }) => {
    test.skip(browserName !== 'webkit', 'an iPhone is Safari');
    const { ctx, page } = await context(browser, { ...devices['iPhone SE (3rd gen) landscape'], viewport: { width: 667, height: 375 } });
    try {
      await open(page, SHOWCASE);
      await toPlayer(page);
      // Space plays from the page; K would need the pointer on the player or focus in it.
      await page.keyboard.press('Space');
      await page.waitForFunction(() => !(document.querySelector('video') as HTMLVideoElement).paused);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await expect(page.locator('media-container[data-fb-dock="in"]')).toBeAttached();
      await page.waitForTimeout(500);
      const m = await page.evaluate(() => {
        const r = document.querySelector('media-container')!.getBoundingClientRect();
        const bar = document.querySelector('.fb-float-bar')!.getBoundingClientRect();
        return { h: r.height, vh: innerHeight, barTop: bar.top, padding: parseFloat(getComputedStyle(document.documentElement).scrollPaddingBottom) || 0 };
      });
      await measure(test.info(), { kind: 'dock', ...m, share: Math.round((m.h / m.vh) * 100) });
      expect(m.h / m.vh, `the docked player is ${Math.round(m.h)} of ${m.vh} px`).toBeLessThanOrEqual(0.36);
      expect(m.padding, 'the page scrolls focus clear of the corner').toBeGreaterThanOrEqual(m.vh - m.barTop);
    } finally {
      await ctx.close();
    }
  });
});

test.describe('a short player gets one row', () => {
  for (const [name, engine, options] of [
    ['an iPhone 15 on its side, filled, 852 × 393', 'webkit', { ...devices['iPhone 15 landscape'], viewport: { width: 852, height: 393 } }],
    ['a Pixel 7 on its side, filled, 915 × 412', 'chromium', { ...devices['Pixel 7 landscape'], viewport: { width: 915, height: 412 } }],
  ] as const) {
    test(`${name}: the controls leave the picture most of its height (finding 22)`, async ({ browser, browserName }) => {
      test.skip(browserName !== engine, `measured in ${engine}`);
      const { ctx, page } = await context(browser, options);
      try {
        await fill(page);
        await startAndHold(page, 20);
        await revealControls(page);
        await still(page);
        const p = await player(page);
        const bar = (await boxes(page, '.fb-bar'))[0];
        const top = await boxes(page, '.video-controls-top > .media-button');
        const topBand = top.length ? Math.max(...top.map((t) => t.y + t.h)) - p.y : 0;
        const covered = (p.y + p.h - bar.y + topBand) / p.h;
        await measure(test.info(), { kind: 'short', name, covered: Math.round(covered * 100), bar: Math.round(bar.h) });
        expect(covered, 'share of the picture’s height under the controls').toBeLessThanOrEqual(0.32);
        // One row, and its keys are whole targets.
        expect(bar.h).toBeLessThan(60);
        const keys = await hitAreas(page, '.fb-bar .media-button');
        expect(keys.filter((k) => k.w < 44 || k.h < 44).map((k) => `${k.w}×${k.h} ${k.name}`)).toEqual([]);
      } finally {
        await ctx.close();
      }
    });
  }
});

test.describe('touch and the pixel grid', () => {
  test('the corner lets a page scroll start on it; controls select nothing on a long press (finding 26, 28)', async ({ browser, browserName }) => {
    skipWithout(test, 'curl');
    const options = browserName === 'webkit' ? phone.iPhone15 : phone.pixel7;
    const { ctx, page } = await context(browser, options);
    try {
      await open(page, SHOWCASE);
      const m = await page.evaluate(() => {
        const css = (sel: string) => getComputedStyle(document.querySelector(sel)!);
        return {
          curl: css('.fb-curl-button').touchAction,
          play: css('.fb-play').webkitUserSelect || css('.fb-play').userSelect,
          tab: css('.fb-time-display').webkitUserSelect || css('.fb-time-display').userSelect,
        };
      });
      expect(m.curl).toContain('pan-y');
      expect(m.play).toBe('none');
      expect(m.tab).toBe('none');
    } finally {
      await ctx.close();
    }
  });

  test('the corner’s label sits on whole pixels at 1× (finding 28)', async ({ page, browserName }) => {
    skipWithout(test, 'curl');
    test.skip(browserName !== 'chromium', 'measured once');
    for (const width of [1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await open(page, SHOWCASE);
      await toPlayer(page);
      await startAndHold(page, 20);
      await expect(page.locator('fb-curl[data-open]')).toBeAttached();
      await page.waitForTimeout(700);
      await still(page);
      // Measured from the player's right edge, where the corner hangs: the page may set the player itself on a half
      // pixel (it centres it), but nothing inside the corner adds a fraction.
      const x = await page.evaluate(() => {
        const label = document.querySelector('.fb-curl-label')!;
        const player = document.querySelector('media-container')!;
        return player.getBoundingClientRect().right - label.getBoundingClientRect().x;
      });
      expect(Math.abs(x - Math.round(x)), `the label’s x from the player’s right edge at ${width}: ${x}`).toBeLessThan(0.02);
    }
  });

  test('a press on a chapter tab names it, without hover (finding 27)', async ({ browser, browserName }) => {
    test.skip(browserName !== 'webkit', 'an iPad is Safari');
    const { ctx, page } = await context(browser, { ...devices['iPad Mini landscape'] });
    try {
      await open(page, SHOWCASE);
      await toPlayer(page);
      await startAndHold(page, 20);
      expect(await page.evaluate(() => matchMedia('(hover: none)').matches), 'a device without hover').toBe(true);
      const tab = page.locator('.fb-tab:not([data-fb-full])').first();
      await expect(tab).toBeVisible();
      const box = (await tab.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height - 6);
      await page.mouse.down();
      await page.waitForTimeout(300);
      const opacity = await tab.locator('.fb-tab-name').evaluate((el) => Number(getComputedStyle(el).opacity));
      await page.mouse.up();
      expect(opacity).toBeGreaterThan(0.9);
    } finally {
      await ctx.close();
    }
  });
});

test.describe('safe areas and text spacing', () => {
  test('the page gutters and the fullscreen controls take the safe-area insets (finding 10)', async ({ page }) => {
    // Insets are 0 off a phone, so the rules themselves are checked: they exist and they're applied.
    await open(page, SHOWCASE);
    const rules = await page.evaluate(() => {
      const all: string[] = [];
      const walk = (list: CSSRuleList) => {
        for (const r of list) {
          if ('cssRules' in r && (r as CSSGroupingRule).cssRules) walk((r as CSSGroupingRule).cssRules);
          if (r instanceof CSSStyleRule || 'style' in r) all.push(r.cssText);
        }
      };
      for (const sheet of document.styleSheets) {
        try {
          walk(sheet.cssRules);
        } catch {}
      }
      return all.filter((t) => t.includes('safe-area-inset'));
    });
    expect(rules.some((t) => t.includes('--gutter')), 'the page gutter').toBe(true);
    expect(rules.some((t) => t.includes(':fullscreen') && t.includes('fb-bar')), 'the slab in fullscreen').toBe(true);
    expect(rules.some((t) => t.includes(':fullscreen') && t.includes('video-controls-top')), 'the top keys in fullscreen').toBe(true);
  });

  test('a 1280 px player with WCAG text spacing: the slab’s keys stay whole and apart (a11y 10)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page, BARE);
    await page.addStyleTag({
      content: '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }',
    });
    await toPlayer(page);
    await startAndHold(page, 20);
    await revealControls(page);
    await still(page);
    const bar = (await boxes(page, '.fb-bar'))[0];
    const keys = await boxes(page, '.fb-bar .media-button');
    expect(keys.filter((k) => !inside(k, bar)).length, 'keys outside the slab').toBe(0);
    const folio = await boxes(page, '.fb-folio');
    expect(collisions(folio, await boxes(page, '.fb-rate, .fb-ends, .fb-captions, .fb-mute')), 'the page counter against its neighbours').toEqual([]);
    const fs = await hitAreas(page, '.fb-fullscreen');
    expect(fs[0].w).toBeGreaterThanOrEqual(44);
  });

  test('the poster has one Play stop for the keyboard (a11y 24)', async ({ page }) => {
    await open(page, SHOWCASE);
    await expect(page.locator('.fb-cover-play')).toHaveAttribute('tabindex', '-1');
  });
});
