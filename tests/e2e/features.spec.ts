import AxeBuilder from '@axe-core/playwright';
import { type Page } from '@playwright/test';
import { BARE, CHAPTERS, measure, media, open, revealControls, SHOWCASE, startAndHold } from './support/player';
import { expect, test } from './support/test';

/**
 * The features API (src/skins/flipbook/features.ts): a core that loads at once, and the book's extras, opt-in and
 * loaded on use. Each check runs on the production build and reads the running page: what the network fetched, what
 * the stylesheets hold, what a key did, where focus went, what axe and the layout-shift entries say.
 *
 * These pick their preset themselves (`?features=`), so they run the same whichever preset the battery is under.
 */

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** The extras' chunks in the production build (extras/*.ts and what only they import). */
const EXTRA_CHUNK = /\/assets\/(turns|deck|contents|ribbons|plate|curl|cover|pip|hints|next|float|paper|marks)-[\w-]+\.js$/;

/** Selectors only an extra's stylesheet styles: none of them may be in the page under essential. */
const EXTRA_HOOKS = [
  '.fb-card', '.fb-deck-', 'data-fb-deck', '.fb-plate', 'data-fb-plate', '.fb-curl', '.fb-jacket', 'data-fb-jacket', '.fb-scan',
  '.fb-cover-board', 'data-fb-cover', '.fb-contents-page', 'data-fb-contents', '.fb-ribbon', '.fb-hint', '.fb-next', '.fb-turn',
  '.fb-riffle', '.fb-paper', '.fb-float', 'data-fb-dock', '.fb-pip-page', 'fb-pip-window', '.fb-print-', 'data-fb-flip',
];

/** Every selector in every stylesheet the page has (its own and adopted), at any depth of @layer, @scope, @media. */
const selectors = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = [];
    const walk = (rules: CSSRuleList) => {
      for (const rule of rules) {
        if (rule instanceof CSSStyleRule) out.push(rule.selectorText);
        if ('cssRules' in rule && (rule as CSSGroupingRule).cssRules) walk((rule as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of [...document.styleSheets, ...document.adoptedStyleSheets]) {
      try {
        walk(sheet.cssRules);
      } catch {
        // A cross-origin sheet: not ours.
      }
    }
    return out;
  });

/** Opens a page without waiting for the extras (open() waits for them all): the core is up, the film's metadata in. */
async function arrive(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator('fb-edge[data-ready]')).toHaveCount(1);
  await page.waitForFunction(() => (document.querySelector('video') as HTMLVideoElement | null)?.readyState! >= 1);
}

/** Holds every extra's chunk back this long, as a slow network would: the prefetch can't land before a trigger. */
async function slowExtras(page: Page, ms = 1500) {
  const held: string[] = [];
  await page.route(EXTRA_CHUNK, async (route) => {
    held.push(new URL(route.request().url()).pathname);
    await new Promise((resolve) => setTimeout(resolve, ms));
    await route.continue().catch(() => undefined);
  });
  return held;
}

const container = (page: Page) => page.locator('media-container');
const loadedList = (page: Page) => container(page).getAttribute('data-fb-loaded');

test.describe('essential', () => {
  test('fetches none of the extras, styles none and draws no WebGL, whatever is pressed', async ({ page }, testInfo) => {
    const asked: string[] = [];
    page.on('request', (request) => asked.push(new URL(request.url()).pathname));
    await page.addInitScript(() => {
      const contexts: string[] = [];
      (window as unknown as { __gl: string[] }).__gl = contexts;
      const get = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
        if (/webgl/.test(type)) contexts.push(type);
        return (get as (...a: unknown[]) => RenderingContext | null).call(this, type, ...rest);
      } as typeof get;
    });
    await open(page, `${SHOWCASE}?features=essential`);
    // Everything a viewer might do: hover and drag the edge, a chapter tab, the book's keys, a pause by hand, the end.
    await revealControls(page);
    const edge = await page.locator('media-time-slider').boundingBox();
    if (!edge) throw new Error('no fore-edge');
    await page.mouse.move(edge.x + edge.width * 0.3, edge.y + edge.height / 2);
    await page.mouse.move(edge.x + edge.width * 0.6, edge.y + edge.height / 2, { steps: 6 });
    await page.mouse.down();
    await page.mouse.move(edge.x + edge.width * 0.5, edge.y + edge.height / 2, { steps: 4 });
    await page.mouse.up();
    await page.locator('.fb-tab').nth(2).click();
    await page.locator('media-container').focus();
    for (const key of ['t', 'b', 'p', '[', ']', 'n']) await page.keyboard.press(key);
    await page.keyboard.press('k');
    await page.waitForTimeout(600);
    await page.keyboard.press('k');
    // Past the page's load, its first paint and several idle periods: when the book's prefetch would have run.
    await page.waitForTimeout(2500);

    const extras = asked.filter((path) => EXTRA_CHUNK.test(path));
    const styled = (await selectors(page)).filter((selector) => EXTRA_HOOKS.some((hook) => selector.includes(hook)));
    const gl = await page.evaluate(() => (window as unknown as { __gl: string[] }).__gl);
    await measure(testInfo, { kind: 'features', state: 'essential', scripts: asked.filter((p) => p.endsWith('.js')).length, extras, styled: styled.length, gl });
    expect(extras, 'extras fetched under essential').toEqual([]);
    expect(styled, 'extras styled under essential').toEqual([]);
    expect(gl, 'WebGL contexts under essential').toEqual([]);
    expect(await container(page).getAttribute('data-fb-loaded')).toBe('');
    // And the selector walk is reading something: the core's own rules are there.
    expect((await selectors(page)).filter((s) => s.includes('.fb-tab')).length).toBeGreaterThan(5);
  });

  test('disabled keys do nothing and leave the shortcuts card; the extras the page names are there', async ({ page }) => {
    await open(page, `${BARE}&features=essential`);
    await container(page).focus();
    for (const key of ['t', 'b', 'p', '[', ']']) await page.keyboard.press(key);
    await page.waitForTimeout(400);
    await expect(container(page)).not.toHaveAttribute('data-fb-contents', /.*/);
    await expect(container(page)).not.toHaveAttribute('data-fb-plate', /.*/);
    await expect(page.locator('fb-contents, fb-ribbons, fb-plate, fb-deck, fb-curl, fb-jacket, fb-cover, fb-turn')).toHaveCount(0);
    await expect(page.locator('[data-fb-action="contents"], [data-fb-action="bookmark"]')).toHaveCount(0);
    // N is the core's: it still turns to the next chapter (a cut, without the book's turns).
    const before = await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).currentTime);
    await page.keyboard.press('n');
    await page.waitForFunction((t) => (document.querySelector('video') as HTMLVideoElement).currentTime > t + 5, before);

    await page.keyboard.press('?');
    const card = page.locator('fb-keymap .fb-keymap');
    await expect(card).toBeVisible();
    const keys = await card.locator('.fb-keymap-row dt').allInnerTexts();
    const flat = keys.map((k) => k.replace(/\s+or\s+/g, ' ').trim());
    expect(flat).not.toContain('T');
    expect(flat).not.toContain('B');
    expect(flat).not.toContain('P');
    expect(flat.some((k) => k.includes('['))).toBe(false);
    expect(flat).toContain('N');
    expect(flat).toContain('?');
    const gestures = await card.locator('.fb-keymap-gestures li').allInnerTexts();
    expect(gestures.join(' ')).not.toMatch(/Flick|corner/i);
    await page.keyboard.press('Escape');

    // A list names extras one by one: B works with ribbons on, T still does nothing.
    await page.evaluate(() => document.querySelector('video-player')!.setAttribute('features', 'essential ribbons'));
    await expect(container(page)).toHaveAttribute('data-fb-loaded', 'ribbons');
    await container(page).focus();
    await page.keyboard.press('b');
    await expect(page.locator('.fb-ribbon')).toHaveCount(1);
    await page.keyboard.press('t');
    await page.waitForTimeout(300);
    await expect(container(page)).not.toHaveAttribute('data-fb-contents', /.*/);
    await page.keyboard.press('Delete');
  });

  test('the stand-ins are axe clean: the poster, the preview card, the end, Settings on a narrow player', async ({ page }, testInfo) => {
    const scan = async (state: string, floor: number) => {
      const result = await new AxeBuilder({ page }).include('media-container').withTags(TAGS).analyze();
      const checked = [...result.passes, ...result.violations, ...result.incomplete].reduce((n, r) => n + r.nodes.length, 0);
      await measure(testInfo, { kind: 'axe', state, nodesChecked: checked, violations: result.violations.length });
      expect(checked, `axe checked too little in "${state}"`).toBeGreaterThanOrEqual(floor);
      expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`), state).toEqual([]);
    };
    await open(page, `${BARE}&features=essential`);
    await scan('essential at rest: the plain poster and its disc', 60);

    await revealControls(page);
    const edge = await page.locator('media-time-slider').boundingBox();
    if (!edge) throw new Error('no fore-edge');
    await page.mouse.move(edge.x + edge.width * 0.4, edge.y + edge.height / 2);
    await page.mouse.move(edge.x + edge.width * 0.42, edge.y + edge.height / 2);
    await expect(page.locator('.media-time-slider-preview')).toHaveCSS('opacity', '1');
    await expect(page.locator('.fb-peek-sharp[data-shown]')).toHaveCount(1);
    await scan('essential: the preview card, sharp', 60);

    await page.evaluate(async () => {
      const video = document.querySelector('video') as HTMLVideoElement;
      video.muted = true;
      video.currentTime = video.duration - 0.25;
      await video.play();
    });
    await page.waitForFunction(() => (document.querySelector('video') as HTMLVideoElement).ended);
    const replay = page.locator('.fb-cover-play');
    await expect(replay).toBeVisible();
    await expect(replay).toHaveAttribute('data-ended', /.*/);
    await scan('essential at the end: the replay disc', 60);

    // The end on a phone-sized player: the fore-edge has its own row there, so the playhead at the very end has
    // nothing beside it (it used to sit against the clock, a target-size finding under 480 px).
    await page.setViewportSize({ width: 400, height: 700 });
    await page.waitForTimeout(300);
    await revealControls(page);
    await scan('essential at the end under 480 px', 30);

    await page.evaluate(() => {
      const video = document.querySelector('video') as HTMLVideoElement;
      video.currentTime = 20;
    });
    await page.waitForTimeout(300);
    await revealControls(page);
    await page.locator('#flipbook-settings-trigger').click();
    await expect(page.locator('[data-fb-menu="mute"]')).toBeVisible();
    await expect(page.locator('.fb-menu-volume')).toBeVisible();
    await scan('essential under 480 px: Settings with Volume, Mute and Picture in picture', 30);
  });
});

test.describe('the book, before its extras arrive', () => {
  test('a key or a click on a key waits for its extra, then does what it would have done', async ({ page }) => {
    const held = await slowExtras(page);
    await arrive(page, BARE);
    await container(page).focus();
    // T: the contents open, once their chunk has come.
    expect(await loadedList(page)).not.toContain('contents');
    await page.keyboard.press('t');
    await expect(container(page)).toHaveAttribute('data-fb-contents', '', { timeout: 6000 });
    await expect(page.locator('fb-contents [role="option"]:focus')).toHaveCount(1);
    await page.keyboard.press('Escape');
    // B: a ribbon at this moment; ] then [ go between ribbons.
    await page.keyboard.press('b');
    await expect(page.locator('.fb-ribbon')).toHaveCount(1, { timeout: 6000 });
    expect(held.some((path) => /contents-/.test(path))).toBe(true);
    expect(held.some((path) => /ribbons-/.test(path))).toBe(true);
    await page.locator('.fb-ribbon').focus();
    await page.keyboard.press('Delete');
    await expect(page.locator('.fb-ribbon')).toHaveCount(0);
  });

  test('a click on the Contents key, P, and a pause made by hand wait for theirs', async ({ page }) => {
    await slowExtras(page);
    await arrive(page, BARE);
    await revealControls(page);
    await page.locator('[data-fb-action="contents"]:visible').first().click();
    await expect(container(page)).toHaveAttribute('data-fb-contents', '', { timeout: 6000 });
    await page.keyboard.press('Escape');
    await expect(container(page)).not.toHaveAttribute('data-fb-contents', /.*/);
    // P, paused: the plate lays out around the moment.
    await page.evaluate(() => {
      const video = document.querySelector('video') as HTMLVideoElement;
      video.currentTime = 20;
    });
    await container(page).focus();
    await page.keyboard.press('p');
    await expect(page.locator('.fb-plate-sheet')).toBeVisible({ timeout: 6000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('.fb-plate-sheet')).toBeHidden();
  });

  test('the paused page prints its strip even when the plate arrives after the pause, and the plate stays put away', async ({ page }) => {
    // The plate's chunk is held until the pause has been made, however soon the page's idle prefetch asks for it: a
    // fixed 1.8 s delay raced that prefetch, which lands before the film reaches 1.5 s once nothing else is loading.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/assets\/plate-[\w-]+\.js$/, async (route) => {
      await held;
      await route.continue().catch(() => undefined);
    });
    await arrive(page, BARE);
    await revealControls(page);
    await container(page).focus();
    await page.keyboard.press('k');
    await page.waitForFunction(() => (document.querySelector('video') as HTMLVideoElement).currentTime > 1.5);
    expect(await loadedList(page)).not.toContain('plate');
    await page.keyboard.press('k');
    await page.waitForTimeout(300);
    release();
    await expect(page.locator('fb-plate[data-strip]')).toHaveCount(1, { timeout: 8000 });
    await expect(page.locator('.fb-strip-cell[data-ready]')).toHaveCount(12);
    await expect(page.locator('.fb-plate-sheet')).toBeHidden();
  });

  test('hovering the fore-edge opens the deck once it arrives, under a resting pointer', async ({ page }) => {
    await page.route(/\/assets\/deck-[\w-]+\.js$/, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue().catch(() => undefined);
    });
    await arrive(page, BARE);
    await revealControls(page);
    const edge = await page.locator('media-time-slider').boundingBox();
    if (!edge) throw new Error('no fore-edge');
    await page.mouse.move(edge.x + edge.width * 0.5, edge.y + edge.height / 2, { steps: 4 });
    // Meanwhile the core's card stands in.
    await expect(page.locator('.media-time-slider-preview')).toHaveCSS('opacity', '1');
    expect(await loadedList(page)).not.toContain('deck');
    await expect(container(page)).toHaveAttribute('data-fb-deck', 'open', { timeout: 6000 });
  });

  test('a chapter tab waits for the turns, then lands where it was asked', async ({ page }) => {
    await page.route(/\/assets\/turns-[\w-]+\.js$/, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.continue().catch(() => undefined);
    });
    await arrive(page, BARE);
    await revealControls(page);
    await page.locator('.fb-tab').nth(3).click();
    await page.waitForFunction((start) => Math.abs((document.querySelector('video') as HTMLVideoElement).currentTime - start) < 0.3, CHAPTERS[3], { timeout: 6000 });
    expect(await loadedList(page)).toContain('turns');
  });

  test('play on the cover turns the cover over, its turn arriving with the cover', async ({ page, browserName }) => {
    const gl = await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2') || !!document.createElement('canvas').getContext('webgl'));
    test.skip(!gl, `no WebGL in this ${browserName}: the cover simply goes`);
    await slowExtras(page, 800);
    await arrive(page, BARE);
    // The jacket is the player at rest: it's what is pressed, and it only shows once its chunk (the opening with it) is in.
    await expect(container(page)).toHaveAttribute('data-fb-jacket', '', { timeout: 6000 });
    await page.locator('.fb-cover-play').click();
    await expect(container(page)).toHaveAttribute('data-fb-riffle', '', { timeout: 2000 });
  });

  test('the PiP key waits for the book’s window where the browser has one', async ({ page }) => {
    await slowExtras(page, 1000);
    await arrive(page, BARE);
    const documentPiP = await page.evaluate(() => 'documentPictureInPicture' in window);
    test.skip(!documentPiP, 'no Document Picture-in-Picture here: the key is the browser’s own window, the core’s');
    await revealControls(page);
    await page.locator('media-pip-button').click();
    // The book's window opens (the click's activation outlives the wait): the player leaves for it, and its place in
    // the page turns over to the waiting page. Bring it back.
    await expect(page.locator('.fb-pip-page')).toBeVisible({ timeout: 6000 });
    await expect(page.locator('media-container')).toHaveCount(0);
    await page.locator('.fb-pip-back').click();
    await expect(page.locator('media-container')).toHaveCount(1);
    await expect(container(page)).toHaveAttribute('data-fb-loaded', /\bpip\b/);
  });
});

test.describe('switching live', () => {
  test('turning the book off closes what it had open, returns focus, and turning it on loads it again', async ({ page }) => {
    await open(page, `${SHOWCASE}?features=book`);
    await container(page).focus();
    await page.keyboard.press('t');
    await expect(container(page)).toHaveAttribute('data-fb-contents', '');
    const playing = await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).currentSrc);

    await page.locator('#features [data-value="essential"]').click();
    await expect(page).toHaveURL(/[?&]features=essential/);
    await expect(container(page)).not.toHaveAttribute('data-fb-contents', /.*/);
    await expect(page.locator('fb-contents, [data-fb-action="contents"], fb-deck, fb-plate')).toHaveCount(0);
    // Nothing left asleep, nothing reloaded.
    expect(await page.evaluate(() => [...document.querySelector('media-container')!.children].filter((c) => (c as HTMLElement).inert && c.tagName !== 'FB-NEXT').length)).toBe(0);
    expect(await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).currentSrc)).toBe(playing);
    // The radio keeps focus: it was clicked, and the contents closing doesn't pull focus back into the player.
    await expect(page.locator('#features [data-value="essential"]')).toBeFocused();

    await page.locator('#features [data-value="book"]').click();
    await expect(page).not.toHaveURL(/features=/);
    // Each of the three Contents keys is back, once: the slab's, the top bar's and the phone pad's (phone.css).
    await expect(page.locator('[data-fb-action="contents"]')).toHaveCount(3);
    expect(await page.locator('[data-fb-action="contents"]').evaluateAll((keys) => keys.map((key) => key.id).sort())).toEqual(['flipbook-contents-pad', 'flipbook-contents-slab', 'flipbook-contents-top']);
    await container(page).focus();
    await page.keyboard.press('t');
    await expect(container(page)).toHaveAttribute('data-fb-contents', '');
  });

  test('focus inside an extra that leaves goes back where its page said, or to the play key', async ({ page }) => {
    await open(page, `${BARE}&features=book`);
    await container(page).focus();
    await page.keyboard.press('t');
    await expect(page.locator('fb-contents [role="option"]:focus')).toHaveCount(1);
    await page.evaluate(() => document.querySelector('video-player')!.setAttribute('features', 'essential'));
    // The contents return focus to what opened them: the player.
    await expect(container(page)).toBeFocused();

    await page.evaluate(() => document.querySelector('video-player')!.setAttribute('features', 'book'));
    await expect(container(page)).toHaveAttribute('data-fb-loaded', /contents/);
    await revealControls(page);
    await page.locator('[data-fb-action="bookmark"]:visible').first().focus();
    await page.evaluate(() => document.querySelector('video-player')!.setAttribute('features', 'essential'));
    // The key itself left: focus goes to play, not to the page.
    await expect(page.locator('.fb-play')).toBeFocused();
  });

  test('starting essential and switching to the book fetches the extras and they work', async ({ page }) => {
    const asked: string[] = [];
    page.on('request', (request) => asked.push(new URL(request.url()).pathname));
    await open(page, `${SHOWCASE}?features=essential`);
    expect(asked.filter((path) => EXTRA_CHUNK.test(path))).toEqual([]);
    await page.locator('#features [data-value="book"]').click();
    await expect(container(page)).toHaveAttribute('data-fb-loaded', /deck.*contents.*ribbons.*plate.*curl.*cover/);
    expect(asked.filter((path) => EXTRA_CHUNK.test(path)).length).toBeGreaterThanOrEqual(8);
    await revealControls(page);
    const edge = await page.locator('media-time-slider').boundingBox();
    if (!edge) throw new Error('no fore-edge');
    await page.mouse.move(edge.x + edge.width * 0.5, edge.y + edge.height / 2, { steps: 4 });
    // (And a pixel along it: Firefox gives the edge the pointer's arrival as over and enter with no move, and the deck
    // opens with the pointer's next move. A hand's mouse sends dozens.)
    await page.mouse.move(edge.x + edge.width * 0.5 + 1, edge.y + edge.height / 2);
    await expect(container(page)).toHaveAttribute('data-fb-deck', 'open');
  });

  test('switching the features shifts nothing (layout shift under 0.01)', async ({ page, browserName }, testInfo) => {
    test.skip(browserName !== 'chromium', 'layout-shift entries exist only in Chromium');
    await page.addInitScript(() => {
      const shifts: { at: number; value: number; input: boolean; sources: string[] }[] = [];
      (window as unknown as { __shifts: typeof shifts }).__shifts = shifts;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: { node?: Node }[] })[]) {
          shifts.push({
            at: Math.round(e.startTime),
            value: e.value,
            input: e.hadRecentInput,
            sources: (e.sources ?? []).map((s) => (s.node instanceof Element ? `${s.node.tagName.toLowerCase()}.${s.node.className}` : String(s.node?.nodeName))),
          });
        }
      }).observe({ type: 'layout-shift', buffered: true });
    });
    await open(page, `${SHOWCASE}?features=book`);
    await page.waitForTimeout(800);
    const start = await page.evaluate(() => performance.now());
    for (const value of ['essential', 'book', 'essential', 'book']) {
      await page.locator(`#features [data-value="${value}"]`).click();
      await page.waitForTimeout(700);
    }
    // And the same from the keyboard: arrows move the choice.
    await page.locator('#features [aria-checked="true"]').focus();
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(700);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(700);
    const shifts = (await page.evaluate(() => (window as unknown as { __shifts: { at: number; value: number; input: boolean; sources: string[] }[] }).__shifts)).filter(
      (s) => s.at >= start,
    );
    // Every shift counts here, even those right after a click (CLS itself leaves those out).
    const all = shifts.reduce((n, s) => n + s.value, 0);
    await measure(testInfo, { kind: 'cls', state: 'switching the features', allShifts: Math.round(all * 10000) / 10000, shifts });
    expect(all, `layout shifts: ${JSON.stringify(shifts)}`).toBeLessThan(0.01);
  });
});

test.describe('the showcase switch', () => {
  test('is a radio group: one Tab stop, arrows choose, the address follows, and a shared link opens as shown', async ({ page }) => {
    await open(page, `${SHOWCASE}?features=essential`);
    await expect(page.locator('video-player')).toHaveAttribute('features', 'essential');
    await expect(page.locator('#features [data-value="essential"]')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#features [role="radio"][tabindex="0"]')).toHaveCount(1);
    await page.locator('#features [data-value="essential"]').focus();
    await page.keyboard.press('End');
    await expect(page.locator('#features [data-value="book"]')).toBeFocused();
    await expect(page.locator('#features [data-value="book"]')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('video-player')).not.toHaveAttribute('features', /.*/);
    await expect(page).not.toHaveURL(/features=/);
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('video-player')).toHaveAttribute('features', 'essential');
    await expect(page).toHaveURL(/features=essential/);
    // The indicator travels to the choice: one element moves, the radios don't.
    const travel = await page.locator('#features .seg').evaluate((seg) => getComputedStyle(seg, '::before').transform);
    expect(travel).not.toBe('none');
    // 44 px targets.
    for (const height of await page.locator('#features [role="radio"]').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) {
      expect(height).toBeGreaterThanOrEqual(44);
    }
  });
});

test.describe('Save-Data', () => {
  test('nothing is fetched ahead: only the cover, which is on screen, and then each extra on its first use', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: true, effectiveType: '4g', addEventListener() {} } });
    });
    const asked: string[] = [];
    page.on('request', (request) => asked.push(new URL(request.url()).pathname));
    await arrive(page, BARE);
    await page.waitForTimeout(3000);
    const ahead = asked.filter((path) => EXTRA_CHUNK.test(path)).map((path) => /\/assets\/([a-z]+)-/.exec(path)?.[1]);
    expect(ahead.filter((name) => !['cover', 'paper', 'marks'].includes(name ?? ''))).toEqual([]);
    expect(await loadedList(page)).toBe('cover');
    // First use still works: T fetches the contents and opens them.
    await container(page).focus();
    await page.keyboard.press('t');
    await expect(container(page)).toHaveAttribute('data-fb-contents', '', { timeout: 6000 });
  });
});

test.describe('the three fixes in the same files', () => {
  test('a media error is said in the skin’s words, never the browser’s', async ({ page }) => {
    await open(page, `${BARE}&features=essential`);
    await page.evaluate(() => {
      const video = document.querySelector('video') as HTMLVideoElement;
      video.src = '/index.html';
      video.load();
    });
    const dialog = page.locator('media-error-dialog');
    await expect(dialog.locator('media-dialog-description')).toHaveText(/couldn’t|can’t|stopped/, { timeout: 8000 });
    const words = await dialog.locator('media-dialog-popup').innerText();
    expect(words).not.toMatch(/MEDIA_ELEMENT_ERROR|PipelineStatus|DEMUXER|FFmpeg|Format error|NotSupported/i);
    await expect(dialog.locator('media-dialog-title')).toHaveText('The film can’t play');
  });

  test('on touch, a tab’s first tap shows its name and the second goes there; a tab that prints its whole name goes at once', async ({ browser, browserName }) => {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 }, hasTouch: true, isMobile: browserName === 'chromium' });
    const page = await context.newPage();
    try {
      await open(page, `${BARE}&features=essential`);
      // A tab whose name is already printed in full has no slip to show (labels.css): one tap goes (touch.ts).
      const named = page.locator('.fb-tab[data-fb-full]').first();
      if (await named.count()) {
        const index = await named.evaluate((el) => [...el.parentElement!.querySelectorAll('.fb-tab')].indexOf(el));
        await named.tap();
        await page.waitForFunction((start) => Math.abs((document.querySelector('video') as HTMLVideoElement).currentTime - start) < 0.3, CHAPTERS[index]);
        await page.evaluate(() => ((document.querySelector('video') as HTMLVideoElement).currentTime = 0));
      }
      const tab = page.locator('.fb-tab:not([data-fb-full])').first();
      test.skip(!(await tab.count()), 'every tab prints its whole name at this width');
      const start = CHAPTERS[await tab.evaluate((el) => [...el.parentElement!.querySelectorAll('.fb-tab')].indexOf(el))];
      await tab.tap();
      await expect(tab).toHaveAttribute('data-fb-tap', '');
      await expect(tab.locator('.fb-tab-name')).toHaveCSS('opacity', '1');
      expect(await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).currentTime)).toBeLessThan(1);
      await tab.tap();
      await page.waitForFunction((at) => Math.abs((document.querySelector('video') as HTMLVideoElement).currentTime - at) < 0.3, start);
      await expect(tab).not.toHaveAttribute('data-fb-tap', /.*/);
    } finally {
      await context.close();
    }
  });

  test('under 480 px, Settings carries Mute and Picture in picture, and they work', async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 700 });
    await open(page, `${BARE}&features=essential`);
    await revealControls(page);
    // (On the phone's pad Mute is a key too, phone.spec; its fader is not, so Settings has the volume.)
    await expect(page.locator('.media-volume-popover-popup')).toBeHidden();
    await page.locator('#flipbook-settings-trigger').click();
    const mute = page.locator('[data-fb-menu="mute"]');
    await expect(mute).toBeVisible();
    await expect(mute).toHaveAttribute('role', 'menuitemcheckbox');
    await expect(mute).toHaveAccessibleName('Mute');
    await mute.click();
    await page.waitForFunction(() => (document.querySelector('video') as HTMLVideoElement).muted);
    await expect(mute).toHaveAttribute('aria-checked', 'true');
    const pip = await page.evaluate(() => document.querySelector('media-pip-button')?.getAttribute('data-availability'));
    if (pip === 'available') await expect(page.locator('[data-fb-menu="pip"]')).toBeVisible();
    // A wide player has the keys on the slab: the entries step out of Settings.
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator('[data-fb-menu="mute"]')).toBeHidden();
  });

  test('Settings lists the chapters, the one playing checked, each a way there', async ({ page }) => {
    await open(page, `${BARE}&features=essential`);
    await revealControls(page);
    await page.locator('#flipbook-settings-trigger').click();
    await page.locator('.fb-menu-chapters').click();
    const items = page.locator('.fb-menu-chapter');
    await expect(items).toHaveCount(6);
    await expect(items.first()).toHaveAttribute('aria-checked', 'true');
    await expect(items.nth(3)).toHaveAccessibleName('Chapter 4: Flight');
    await items.nth(3).click();
    await page.waitForFunction((start) => Math.abs((document.querySelector('video') as HTMLVideoElement).currentTime - start) < 0.3, CHAPTERS[3]);
    await expect(page.locator('.fb-voice')).toHaveText(/Chapter 4: Flight/);
  });
});

/** Every riffle and flick of the edge's loose pages, counted as they start (installed before the page loads). */
const recordFlicks = () => {
  const seen = { flicks: 0, playAt: -1 };
  (window as unknown as { __riffle: typeof seen }).__riffle = seen;
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (this: Element, ...args: Parameters<Element['animate']>) {
    if (this.classList?.contains('fb-edge-flick-page')) seen.flicks++;
    return animate.apply(this, args);
  };
  document.addEventListener('play', (event) => {
    if (seen.playAt < 0) seen.playAt = (event.target as HTMLVideoElement).currentTime;
  }, true);
};
const riffle = (page: Page) => page.evaluate(() => ({ ...(window as unknown as { __riffle: { flicks: number; playAt: number } }).__riffle }));

test.describe('the first play riffles the edge, once', () => {
  test('five pages on the first play; none on the second, nor on a play from 0:00 again', async ({ page }, testInfo) => {
    await page.addInitScript(recordFlicks);
    await open(page, BARE);
    expect((await riffle(page)).flicks, 'nothing moves before the first play').toBe(0);
    await page.keyboard.press('Space');
    await expect.poll(async () => (await media(page)).time).toBeGreaterThan(0.6);
    const first = await riffle(page);
    expect(first.flicks, 'pages riffled on the first play').toBe(5);

    // Paused and played again mid-film.
    await page.keyboard.press('Space');
    await expect.poll(async () => (await media(page)).paused).toBe(true);
    await page.keyboard.press('Space');
    await expect.poll(async () => (await media(page)).paused).toBe(false);
    await page.waitForTimeout(500);
    expect((await riffle(page)).flicks, 'a second play, mid-film').toBe(5);

    // Back to the first page (Home, from the page), and played once more: still the one riffle.
    await page.keyboard.press('Space');
    await expect.poll(async () => (await media(page)).paused).toBe(true);
    await page.keyboard.press('Home');
    await expect.poll(async () => (await media(page)).time).toBeLessThan(0.1);
    const before = (await riffle(page)).flicks;
    await page.keyboard.press('Space');
    await expect.poll(async () => (await media(page)).paused).toBe(false);
    await page.waitForTimeout(500);
    expect((await riffle(page)).flicks - before, 'a play from 0:00 again').toBe(0);
    await measure(testInfo, { kind: 'first-play-riffle', pages: first.flicks, playEventAt: first.playAt });
  });

  test('a play event that lands late (a busy main thread) still riffles', async ({ page, browserName }, testInfo) => {
    // The main thread held for 700 ms as play() is called, as a slow phone holds it while the cover's turn is set up:
    // the film is already past half a second when the play event arrives.
    await page.addInitScript(recordFlicks);
    await page.addInitScript(() => {
      const play = HTMLMediaElement.prototype.play;
      let held = false;
      HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
        const promise = play.call(this);
        if (!held) {
          held = true;
          const until = performance.now() + 700;
          while (performance.now() < until);
        }
        return promise;
      };
    });
    await open(page, BARE);
    await page.keyboard.press('Space');
    await expect.poll(async () => (await media(page)).time).toBeGreaterThan(1);
    const seen = await riffle(page);
    await measure(testInfo, { kind: 'late-play-riffle', browserName, playEventAt: seen.playAt, pages: seen.flicks });
    // Chromium's film runs on while the page is held; WebKit starts it only once the page is free again, so there the
    // event is never late and this only repeats the test above.
    if (browserName === 'chromium') expect(seen.playAt, 'the film was past 0.5 s when the play event arrived').toBeGreaterThan(0.5);
    expect(seen.flicks, 'pages riffled').toBe(5);
  });
});

test.describe('the fore-edge keeps the main thread free', () => {
  test('its pages are cropped from one decoded bitmap, eight to a task at most', async ({ page }, testInfo) => {
    // Every createImageBitmap call, with its source and the task it was made in. A task is closed by a timer set at
    // its first call: the edge's own pause between batches is set later, so it always runs after this one.
    await page.addInitScript(() => {
      const calls: { source: string; crop: boolean; task: number }[] = [];
      (window as unknown as { __bitmaps: typeof calls }).__bitmaps = calls;
      const make = window.createImageBitmap;
      let task = 0;
      let open = false;
      window.createImageBitmap = function (this: unknown, ...args: unknown[]) {
        if (!open) {
          open = true;
          task++;
          setTimeout(() => (open = false));
        }
        calls.push({ source: (args[0] as object)?.constructor?.name ?? typeof args[0], crop: typeof args[1] === 'number', task });
        return (make as (...a: unknown[]) => Promise<ImageBitmap>).apply(window, args);
      } as typeof window.createImageBitmap;
    });
    await open(page, BARE);
    const pages = Number(await page.locator('fb-edge').evaluate((el) => getComputedStyle(el).getPropertyValue('--fb-pages')));
    expect(pages, 'the storyboard has its pages').toBeGreaterThan(20);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __bitmaps: { crop: boolean }[] }).__bitmaps.filter((c) => c.crop).length)).toBe(pages);
    const calls = await page.evaluate(() => (window as unknown as { __bitmaps: { source: string; crop: boolean; task: number }[] }).__bitmaps.slice());
    const crops = calls.filter((c) => c.crop);
    const perTask = new Map<number, number>();
    for (const c of crops) perTask.set(c.task, (perTask.get(c.task) ?? 0) + 1);
    const most = Math.max(...perTask.values());
    await measure(testInfo, { kind: 'edge-crops', pages, tasks: perTask.size, mostPerTask: most, sources: [...new Set(crops.map((c) => c.source))] });
    // An <img> cropped decodes the whole sprite again for every page: the crops come from the bitmap.
    expect(crops.filter((c) => c.source !== 'ImageBitmap').length, 'crops asked of the <img> itself').toBe(0);
    expect(most, 'crops made in one task').toBeLessThanOrEqual(8);
  });
});

test.describe('the seek chip counts every key', () => {
  test('three arrows pressed as fast as they go read +15 s, and the film is 15 s on', async ({ page, browserName }) => {
    await open(page, BARE);
    await startAndHold(page, 20);
    await page.locator('media-container').evaluate((el) => (el as HTMLElement).focus({ preventScroll: true }));
    // Playing: on a paused film the book's arrows turn one page each (flip.ts) and there is nothing to count; the
    // five-second seek and its chip are for a film that is running. It runs on while the keys go: 15 s and a moment.
    await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).play());
    await page.waitForFunction(() => !(document.querySelector('video') as HTMLVideoElement).paused);
    const from = (await media(page)).time;
    // No wait between them: each seek starts before the one before it has finished.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await media(page)).time - from).toBeGreaterThanOrEqual(15);
    expect((await media(page)).time - from).toBeLessThan(17.5);
    await expect(page.locator('.fb-edge-chip')).toHaveText(/\+15\s?s/);
    test.info().annotations.push({ type: 'engine', description: browserName });
  });

  // The chip counts presses, and a press is timed by itself. It was timed by when the page heard the film answer:
  // a seek heard more than 400 ms after its key was taken for someone else's, and keys heard more than a second apart
  // for separate counts. On a busy page three quick presses then moved the film 15 s and the chip said nothing, or
  // "+5 s" three times (WebKit under load, 2 runs in 12, 13 Nov 2026).
  test('on a page too busy to answer in time, three quick arrows still read +15 s: the presses are timed, not the answers', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox', 'Playwright’s Firefox sends a key only once the page has answered the one before: three presses 1.2 s apart, which are three counts');
    await open(page, BARE);
    await startAndHold(page, 20);
    await page.locator('media-container').evaluate((el) => (el as HTMLElement).focus({ preventScroll: true }));
    // Running, but almost at a stand: what the film plays on while the page stands still is then not in the sum
    // (the player seeks from where it last heard the film was, and the chip says how far the film went).
    await page.evaluate(() => {
      const video = document.querySelector('video') as HTMLVideoElement;
      video.playbackRate = 0.0625;
      return video.play();
    });
    await page.waitForFunction(() => !(document.querySelector('video') as HTMLVideoElement).paused);
    const from = (await media(page)).time;
    // The page stands still for 1.2 s after each arrow (once the key is up again: a key the page takes for held
    // riffles the book). The film's `seeking` is heard that much later than its key, and each key is taken that much
    // after the one before, though all three were pressed within a moment.
    await page.evaluate(() => {
      const held = { arrows: 0, stamps: [] as number[] };
      (window as unknown as { __held: typeof held }).__held = held;
      window.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowRight') return;
        held.arrows++;
        held.stamps.push(event.timeStamp);
      });
      window.addEventListener('keyup', (event) => {
        if (event.key !== 'ArrowRight') return;
        const until = performance.now() + 1200;
        while (performance.now() < until);
      });
    });
    // All three sent at once, as fast as a hand: they wait their turn in the browser, each with its own time.
    const sent: Promise<void>[] = [];
    for (let i = 0; i < 3; i++) sent.push(page.keyboard.down('ArrowRight'), page.keyboard.up('ArrowRight'));
    await Promise.all(sent);
    const held = await page.evaluate(() => (window as unknown as { __held: { arrows: number; stamps: number[] } }).__held);
    expect(held.arrows, 'arrows the page took').toBe(3);
    expect(held.stamps[2] - held.stamps[0], 'ms between the first press and the third, by the presses’ own time').toBeLessThan(600);
    await expect(page.locator('.fb-edge-chip')).toHaveText(/\+15\s?s/);
    await expect.poll(async () => Math.round((await media(page)).time - from)).toBe(15);
  });

  // The book keeps the chip quiet for a moment after a seek of its own (a chapter jump, a paused picture put right).
  // That quiet was for any seek heard in it, a person's keys too: arrows pressed inside it moved the film and were
  // not counted. It is what the test above ran into in WebKit under load, 4 runs in 45: there the film, sought while
  // paused, is sometimes sought once more to put its picture right (goto.ts), 700 ms of quiet, and the film was set
  // playing and the arrows pressed inside them. Here the quiet is a chapter cut's, 1400 ms, which every run has.
  test('arrows pressed just after a seek of the book’s own are counted: a chapter cut by N, then three arrows, read +15 s', async ({ page }) => {
    await open(page, `${BARE}&features=essential`);
    await page.locator('media-container').evaluate((el) => (el as HTMLElement).focus({ preventScroll: true }));
    await page.evaluate(() => {
      const video = document.querySelector('video') as HTMLVideoElement;
      video.playbackRate = 0.0625;
      const taken: Record<string, number> = ((window as unknown as { __taken: Record<string, number> }).__taken = {});
      window.addEventListener('keydown', (event) => (taken[event.key] = performance.now()));
      return video.play();
    });
    await page.waitForFunction(() => !(document.querySelector('video') as HTMLVideoElement).paused);
    const before = (await media(page)).time;
    await page.keyboard.press('n');
    const chapter = await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).currentTime);
    expect(chapter - before, 'seconds the cut went on').toBeGreaterThan(5);
    // The cut's own seek is the book's, and stays uncounted.
    await expect(page.locator('.fb-edge-chip')).toHaveText('');
    await Promise.all([1, 2, 3].map(() => page.keyboard.press('ArrowRight')));
    const taken = await page.evaluate(() => (window as unknown as { __taken: Record<string, number> }).__taken);
    expect(taken.ArrowRight - taken.n, 'ms from the cut to the last arrow: inside the cut’s quiet, or this proves nothing').toBeLessThan(1400);
    await expect(page.locator('.fb-edge-chip')).toHaveText(/\+15\s?s/);
    await expect.poll(async () => Math.round((await media(page)).time - chapter)).toBe(15);
  });
});
