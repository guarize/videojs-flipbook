/**
 * The skin on someone else's page.
 *
 * The skin's CSS lives in cascade layers, and any unlayered rule on the host page beats a layered one whatever its
 * specificity: a site's ordinary `kbd { … }` once restyled the keycaps. These tests mount the player with the drop-in
 * call on a quiet page and on a hostile one (apps/preview/public/host/hostile.css: a reset, a preflight, element
 * rules, theme rules under classes and ids, heavy typography on body) and hold the two against each other:
 *
 * - every computed property and the box of every element of the skin, its ::before and ::after included;
 * - the player's pixels, at rest, paused, with a key under the pointer, with Settings, Shortcuts and Contents open;
 * - at 1280 and 390 px; with the host's stylesheet before and after the skin's; right to left; with the root font
 *   size at 20 and 12 px; zoomed; under the `!important` motion snippet;
 * - the other way round: the page's own elements compute the same with and without the skin's CSS;
 * - and what a host is meant to reach still answers: the custom properties, the player's size, `!important`.
 */
import { type Browser, type Page, type TestInfo } from '@playwright/test';
import { calm, type Comparison, compareStyles, describe, type Host, jacketMasks, networkMasks, openHost, pixelDiff, reach, type State, STATES, shoot } from './support/host';
import { ESSENTIAL, measure, startAndHold } from './support/player';
import { expect, test } from './support/test';

const SIZES = [
  { name: '1280', viewport: { width: 1280, height: 800 } },
  { name: '390', viewport: { width: 390, height: 780 } },
];

/**
 * The share of the player's pixels that may differ between two captures (a channel off by more than 8 of 255): one in
 * ten thousand, for a glyph's edge antialiased a level apart. A restyled keycap alone is hundreds of pixels; the
 * hostile page, before the armour, changed every one.
 */
const PIXELS = 0.0001;

/** The states a preset has: Contents is one of the book's extras. */
const states = (list: readonly State[]) => list.filter((state) => !(ESSENTIAL && state === 'contents'));

async function pair(browser: Browser, viewport: { width: number; height: number }, a: Host, b: Host) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const [one, two] = [await context.newPage(), await context.newPage()];
  await openHost(one, a);
  await openHost(two, b);
  return { context, one, two };
}

interface Row {
  state: State;
  styles: Comparison;
  pixels: number;
  share: number;
  box: unknown;
}

/** Walks both pages through the states, comparing styles and pixels at each. */
async function walk(one: Page, two: Page, list: readonly State[], testInfo: TestInfo): Promise<Row[]> {
  const rows: Row[] = [];
  for (const state of list) {
    // One page at a time holds the front: a background page's hover and focus are not to be trusted.
    await one.bringToFront();
    await reach(one, state);
    const shotOne = await shoot(one.locator('media-container'));
    await two.bringToFront();
    await reach(two, state);
    const shotTwo = await shoot(two.locator('media-container'));
    const styles = await compareStyles(one, two);
    const diff = await pixelDiff(two, shotOne, shotTwo, [...(await networkMasks(one, shotOne)), ...(await networkMasks(two, shotTwo)), ...(await jacketMasks(one, two, shotOne))]);
    if (styles.differing || diff.share > PIXELS) {
      // Both captures, kept with the failure: what the host did is plain to see.
      await testInfo.attach(`${state}-first.png`, { body: shotOne, contentType: 'image/png' });
      await testInfo.attach(`${state}-second.png`, { body: shotTwo, contentType: 'image/png' });
    }
    rows.push({ state, styles, pixels: diff.differing, share: diff.share, box: diff.box });
  }
  return rows;
}

function report(rows: Row[]): string {
  return rows
    .filter((row) => row.styles.differing || row.share > PIXELS)
    .map((row) => `— ${row.state}: ${row.pixels} px differ${row.box ? ` in ${JSON.stringify(row.box)}` : ''}\n${describe(row.styles)}`)
    .join('\n');
}

const summary = (rows: Row[]) =>
  Object.fromEntries(rows.map((row) => [row.state, { elements: row.styles.elements, properties: row.styles.properties, styles: row.styles.differing, pixels: row.pixels }]));

function expectSame(rows: Row[], what: string) {
  // A floor: "nothing differs" over a player that never mounted would prove nothing.
  for (const row of rows) expect(row.styles.elements, `${row.state}: the skin's elements were measured`).toBeGreaterThan(300);
  expect(report(rows), what).toBe('');
}

for (const size of SIZES) {
  test.describe(`a ${size.name} px page`, () => {
    test.describe.configure({ timeout: 180_000 });

    test('the measure is quiet: two quiet pages agree in every state', async ({ browser }, testInfo) => {
      const { context, one, two } = await pair(browser, size.viewport, { host: 'clean' }, { host: 'clean' });
      const rows = await walk(one, two, states(STATES), testInfo);
      await measure(testInfo, { hostControl: { size: size.name, ...summary(rows) } });
      expectSame(rows, 'two quiet pages');
      await context.close();
    });

    test('a hostile page changes nothing: every computed style, box and pixel, in every state', async ({ browser }, testInfo) => {
      const { context, one, two } = await pair(browser, size.viewport, { host: 'clean' }, { host: 'hostile' });
      const rows = await walk(one, two, states(STATES), testInfo);
      await measure(testInfo, { hostile: { size: size.name, ...summary(rows) } });
      expectSame(rows, 'the hostile page against the quiet one');
      await context.close();
    });

    test('a page built with Tailwind 4 changes nothing: every computed style, box and pixel, in every state', async ({ browser }, testInfo) => {
      const { context, one, two } = await pair(browser, size.viewport, { host: 'clean' }, { host: 'clean', tailwind: 'before' });
      const rows = await walk(one, two, states(STATES), testInfo);
      await measure(testInfo, { tailwind: { size: size.name, ...summary(rows) } });
      expectSame(rows, 'the Tailwind page against the quiet one');
      await context.close();
    });

    // Paused and with Settings open. At rest, straight after a load, the book's extras are still arriving on idle
    // (a hint, the storyboard), each page at its own moment; the walk above compares that state once both are still.
    // Zoomed, Settings is left out: its width follows its text, and at a fractional zoom that rounds a pixel either
    // way from one load to the next.
    const variants: { name: string; clean: Host; hostile: Host; states?: State[] }[] = [
      { name: 'the host’s stylesheet after the skin’s', clean: { host: 'clean' }, hostile: { host: 'hostile', late: true } },
      { name: 'right to left', clean: { host: 'clean', dir: 'rtl' }, hostile: { host: 'hostile', dir: 'rtl' } },
      { name: 'a 20 px root font size', clean: { host: 'clean' }, hostile: { host: 'hostile', root: 20 } },
      { name: 'a 12 px root font size', clean: { host: 'clean' }, hostile: { host: 'hostile', root: 12 } },
      { name: 'a quiet page with a 20 px root font size', clean: { host: 'clean' }, hostile: { host: 'clean', root: 20 } },
      { name: 'zoomed to 125 %', clean: { host: 'clean', zoom: 1.25 }, hostile: { host: 'hostile', zoom: 1.25 }, states: ['paused'] },
      // A page built with Tailwind CSS 4: its layers are named as a Video.js skin's are (`base`, `components`,
      // `utilities`), and its preflight, its element rules and its reaching utilities are all in them. The skin's
      // ship under names of their own, above those four whichever stylesheet comes first (build/layers.mjs).
      { name: 'a page built with Tailwind 4, its layers after the skin’s', clean: { host: 'clean' }, hostile: { host: 'clean', tailwind: 'after' } },
      { name: 'a page built with Tailwind 4, in its dark scheme', clean: { host: 'clean' }, hostile: { host: 'clean', tailwind: 'before', dark: true } },
      { name: 'a page built with Tailwind 4, dark, its layers after the skin’s', clean: { host: 'clean' }, hostile: { host: 'clean', tailwind: 'after', dark: true } },
    ];
    for (const variant of variants) {
      test(`a hostile page changes nothing: ${variant.name}`, async ({ browser }, testInfo) => {
        const { context, one, two } = await pair(browser, size.viewport, variant.clean, variant.hostile);
        const rows = await walk(one, two, variant.states ?? ['paused', 'menu'], testInfo);
        await measure(testInfo, { hostileVariant: { size: size.name, variant: variant.name, ...summary(rows) } });
        expectSame(rows, variant.name);
        await context.close();
      });
    }

    test('under the host’s `!important` motion snippet the player stands as it does at rest', async ({ browser }, testInfo) => {
      // The host means that snippet to win, and it does (as a visitor's own text-spacing stylesheet must): durations
      // go to zero. What must hold is everything else, so both pages carry the snippet and only one the hostile sheet.
      const { context, one, two } = await pair(browser, size.viewport, { host: 'clean', important: true }, { host: 'hostile', important: true });
      const rows = await walk(one, two, ['paused', 'menu'], testInfo);
      await measure(testInfo, { hostileImportant: { size: size.name, ...summary(rows) } });
      expectSame(rows, 'both pages under the snippet');
      await context.close();
    });
  });
}

test.describe('the mini player’s keys stand in the host’s page', () => {
  test.skip(ESSENTIAL, 'needs the book’s float');

  test('docked on a hostile page: the keys and the book’s place compute as on a quiet one', async ({ browser }, testInfo) => {
    test.setTimeout(120_000);
    const { context, one, two } = await pair(browser, { width: 1280, height: 800 }, { host: 'clean' }, { host: 'hostile' });
    for (const page of [one, two]) {
      await page.bringToFront();
      await page.locator('media-container').evaluate((el: HTMLElement) => el.focus({ preventScroll: true }));
      await page.keyboard.press('k');
      await page.waitForFunction(() => !(document.querySelector('video') as HTMLVideoElement).paused);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await expect(page.locator('.fb-float-bar')).toBeVisible();
      await expect(page.locator('media-container')).toHaveAttribute('data-fb-dock', 'in');
      await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).pause());
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            const video = document.querySelector('video') as HTMLVideoElement;
            video.addEventListener('seeked', () => resolve(), { once: true });
            video.currentTime = 20;
          }),
      );
      await page.mouse.move(2, 2);
      await calm(page);
    }
    const styles = await compareStyles(one, two);
    const [a, b] = [await shoot(one.locator('.fb-float-bar')), await shoot(two.locator('.fb-float-bar'))];
    const pixels = await pixelDiff(two, a, b);
    await measure(testInfo, { hostileFloat: { elements: styles.elements, styles: styles.differing, pixels: pixels.differing } });
    expect(await two.locator('.fb-float-bar').count(), 'the keys are there').toBe(1);
    expect(describe(styles), 'docked').toBe(`0 of ${styles.elements * 3} element and pseudo-element styles differ (${styles.properties} properties each)`);
    expect(pixels.share, 'the keys’ pixels').toBeLessThanOrEqual(PIXELS);
    await context.close();
  });
});

test.describe('the skin keeps to itself', () => {
  /** Every computed property of the page's own elements, outside the player. */
  const outside = (page: Page) =>
    page.evaluate(() => {
      const names = Array.from(getComputedStyle(document.documentElement)).filter((name) => !name.startsWith('--'));
      const elements = [document.documentElement, document.body, ...document.querySelectorAll('#page, #content, #outside, #outside *')];
      return elements.map((el) => {
        const out: Record<string, string> = { '(element)': `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}` };
        for (const pseudo of ['', '::before', '::after', '::placeholder', '::selection', '::marker']) {
          const style = getComputedStyle(el, pseudo || null);
          for (const name of names) out[`${pseudo}${name}`] = style.getPropertyValue(name);
        }
        const rect = el.getBoundingClientRect();
        if (el !== document.documentElement && el !== document.body) out['(box)'] = [rect.x, rect.y, rect.width, rect.height].map((n) => Math.round(n * 100) / 100).join(',');
        return out;
      });
    });

  for (const host of ['clean', 'hostile', 'tailwind'] as const) {
    test(`on a ${host} page, the page’s own elements compute the same with and without the skin`, async ({ browser }, testInfo) => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
      const [without, withSkin] = [await context.newPage(), await context.newPage()];
      const page: Host = host === 'tailwind' ? { host: 'clean', tailwind: 'before' } : { host };
      await openHost(without, { ...page, noskin: true });
      await openHost(withSkin, page);
      // The whole skin: the film has played, so every extra's stylesheet has arrived too.
      await withSkin.locator('media-container').evaluate((el: HTMLElement) => el.focus({ preventScroll: true }));
      await startAndHold(withSkin, 20);
      await withSkin.mouse.move(2, 2);
      const [a, b] = [await outside(without), await outside(withSkin)];
      expect(b.length, 'the same elements').toBe(a.length);
      expect(a.length, 'the page’s elements were measured').toBeGreaterThan(30);
      const leaks: string[] = [];
      a.forEach((before, index) => {
        for (const key of Object.keys(before)) {
          if (before[key] !== b[index][key]) leaks.push(`${before['(element)']} { ${key}: ${before[key]} → ${b[index][key]} }`);
        }
      });
      await measure(testInfo, { hostLeak: { host, elements: a.length, properties: Object.keys(a[0]).length, leaks: leaks.length } });
      expect(leaks.slice(0, 40).join('\n'), 'what the skin changed outside itself').toBe('');
      await context.close();
    });
  }

  test('its layers rank the same whichever of its stylesheets a page meets first: each opens with the whole order', async ({ page }) => {
    await openHost(page, { host: 'clean' });
    await page.locator('media-container').evaluate((el: HTMLElement) => el.focus({ preventScroll: true }));
    await startAndHold(page, 20);
    // (A layer's rank is set where its name is first met, in a statement or a block. A build may write the order out
    // as one statement or split between the blocks: what counts is the order in which each sheet first names them.)
    const sheets = await page.evaluate(() => {
      const out: { sheet: string; order: string }[] = [];
      for (const sheet of document.styleSheets) {
        let rules: CSSRuleList;
        try {
          rules = sheet.cssRules;
        } catch {
          continue;
        }
        const met: string[] = [];
        for (const rule of rules) {
          const names = rule instanceof CSSLayerStatementRule ? [...rule.nameList] : rule instanceof CSSLayerBlockRule ? [rule.name] : [];
          for (const name of names) if (!met.includes(name.split('.')[0])) met.push(name.split('.')[0]);
        }
        if (met.some((name) => name.startsWith('fb-'))) out.push({ sheet: (sheet.href ?? 'inline').split('/').pop() as string, order: met.join(', ') });
      }
      return out;
    });
    expect(sheets.length, 'stylesheets of the skin’s on the page').toBeGreaterThan(1);
    const WHOLE = 'theme, base, components, utilities, fb-reset, fb-base, fb-components, fb-utilities, fb-a11y, fb-apart';
    expect(sheets.filter((sheet) => !sheet.order.startsWith(WHOLE)), 'stylesheets that do not name the whole order first').toEqual([]);
    // And the order holds on the page: a key of the skin's is styled by its components, over the reset under them.
    expect(await page.locator('.fb-play').evaluate((el) => getComputedStyle(el).cursor)).toBe('pointer');
    expect(await page.locator('.fb-settings').evaluate((el) => getComputedStyle(el).display)).not.toBe('inline');
  });

  test('its names are its own: every keyframe, font and registered property it adds carries its prefix', async ({ page }) => {
    await openHost(page, { host: 'clean' });
    await page.locator('media-container').evaluate((el: HTMLElement) => el.focus({ preventScroll: true }));
    await startAndHold(page, 20);
    const names = await page.evaluate(() => {
      const found: string[] = [];
      const visit = (rules: CSSRuleList) => {
        for (const rule of rules) {
          if (rule instanceof CSSKeyframesRule) found.push(`@keyframes ${rule.name}`);
          else if (rule instanceof CSSFontFaceRule) found.push(`@font-face ${rule.style.getPropertyValue('font-family').replace(/["']/g, '')}`);
          else if (rule.constructor.name === 'CSSPropertyRule') found.push(`@property ${(rule as unknown as { name: string }).name}`);
          else if ('cssRules' in rule) visit((rule as CSSGroupingRule).cssRules);
        }
      };
      for (const sheet of [...document.styleSheets, ...document.adoptedStyleSheets]) {
        if (sheet.ownerNode instanceof HTMLStyleElement && !sheet.ownerNode.textContent?.includes('media-skin')) continue;
        try {
          visit(sheet.cssRules);
        } catch {
          // A cross-origin sheet: not the skin's.
        }
      }
      return found;
    });
    expect(names.length, 'the skin’s at-rules were found').toBeGreaterThan(2);
    const foreign = names.filter((name) => !/^@(keyframes|font-face|property) (fb-|--fb-|--media-|Flipbook |Gloock$)/.test(name));
    expect(foreign, 'names that could collide with the host’s').toEqual([]);
  });
});

test.describe('what the host is meant to reach still answers', () => {
  test('on a hostile page: the custom properties rebrand, the host sizes the player, and `!important` gets through', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openHost(page, { host: 'hostile' });
    await page.locator('media-container').evaluate((el: HTMLElement) => el.focus({ preventScroll: true }));
    await startAndHold(page, 20);

    // The documented theming: a custom property set from the host's own stylesheet, with a plain selector.
    await page.addStyleTag({ content: '.media-skin[data-theme="flipbook"] { --fb-accent: #3d7bf2; --fb-font: Georgia, serif; }' });
    const accent = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--fb-accent)';
      document.querySelector('media-container')!.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    expect(accent, 'the accent').toBe('rgb(61, 123, 242)');
    expect(await page.locator('.fb-settings').evaluate((el) => getComputedStyle(el).fontFamily), 'the font').toContain('Georgia');

    // The player's box is the host's: an ordinary rule sizes it.
    await page.addStyleTag({ content: '#player .media-skin { aspect-ratio: 4 / 3; }' });
    const box = await page.locator('media-container').boundingBox();
    expect(Math.abs(box!.width / box!.height - 4 / 3), 'a 4:3 player').toBeLessThan(0.01);

    // A visitor's text-spacing stylesheet (WCAG 1.4.12) and a host's deliberate override both use !important.
    await page.addStyleTag({ content: '* { letter-spacing: 0.12em !important; } .media-skin .fb-time-display { color: rgb(1, 2, 3) !important; }' });
    const display = page.locator('.fb-time-display');
    expect(await display.evaluate((el) => getComputedStyle(el).color), 'a deliberate override').toBe('rgb(1, 2, 3)');
    expect(await display.evaluate((el) => parseFloat(getComputedStyle(el).letterSpacing)), 'text spacing').toBeGreaterThan(1);
  });
});
