import { type Page } from '@playwright/test';
import { ESSENTIAL, focusPlayer, measure, open, settle, SHOWCASE, startAndHold } from './support/player';
import { expect, test } from './support/test';

/**
 * Every interactive element in the player, and the showcase's width presets, at least 44 × 44 CSS px with a coarse
 * pointer. Measured on the element that receives the click, by hit-testing: from the centre of the clickable element
 * (a slider's track, not its thumb; an sr-only input's label), walk out along both axes while elementFromPoint still
 * lands on it. So an invisible hit area counts, and a part covered by something else doesn't.
 */

const MIN = 44;
const WIDTHS = [360, 768, 1280];

interface Hit {
  label: string;
  width: number;
  height: number;
  state: string;
}

/**
 * Hit areas of every visible interactive element in the player and the presets, or, with a panel open, of the
 * panel's own (what it covers isn't on offer while it's up). Runs in the page.
 */
function hitAreas({ state, panel }: { state: string; panel: string | null }): Hit[] {
  const SELECTOR =
    'button, a[href], input, select, textarea, [role="button"], [role="slider"], [role="tab"], [role="option"], [role="menuitem"], [role="menuitemradio"], [role="radio"], [role="checkbox"], [role="switch"], [tabindex]:not([tabindex="-1"])';
  const player = document.querySelector('media-container') as HTMLElement;
  const scope = panel ? (document.querySelector(panel) as HTMLElement) : null;
  const els = scope
    ? [...scope.querySelectorAll<HTMLElement>(SELECTOR)]
    : [...player.querySelectorAll<HTMLElement>(SELECTOR), ...document.querySelectorAll<HTMLElement>('#seg button')];
  const seen = new Set<Element>();
  const out: Hit[] = [];
  for (const el of els) {
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) || el.closest('[inert]')) continue;
    // What receives the click.
    let target: HTMLElement = el;
    if (el.matches('media-slider-thumb')) target = el.closest('media-time-slider, media-volume-slider') as HTMLElement;
    // A phone's chapter tabs are printed on the fore-edge's own row and take no pointer (skin.css, "Phone: two rows"):
    // the row is the slider's, one target, and a tap on a tab is taken from it (phone.spec.ts checks that it lands).
    if (el.matches('.fb-tab') && getComputedStyle(el).pointerEvents === 'none') {
      target = (el.closest('.fb-seek')?.querySelector('media-time-slider') as HTMLElement | null) ?? el;
    }
    const r0 = el.getBoundingClientRect();
    if (el.matches('input') && (r0.width <= 2 || r0.height <= 2 || getComputedStyle(el).clip.startsWith('rect('))) {
      target = (el.closest('label') ?? (el.id ? document.querySelector<HTMLElement>(`label[for="${el.id}"]`) : null) ?? el) as HTMLElement;
    }
    // A phone's edge runs down the picture's side, where a thumb scrolls the page: until the film has been started
    // it is drawn, not live (skin.css, "The edge down the side"; phone.spec.ts checks that the touch reaches the page).
    if (target.matches('media-time-slider') && getComputedStyle(target).pointerEvents === 'none' && !player.querySelector('.fb-play[data-started]')) continue;
    if (seen.has(target)) continue;
    seen.add(target);
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = target.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const owns = (x: number, y: number) => {
      const hit = document.elementFromPoint(x, y);
      return !!hit && (target === hit || target.contains(hit));
    };
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 32);
    const cls = (typeof target.className === 'string' ? target.className : '').split(/\s+/).filter((c) => c.startsWith('fb-') || c.startsWith('media-')).slice(-1)[0] ?? target.tagName.toLowerCase();
    const label = `${name} · .${cls}`;
    if (!owns(cx, cy)) {
      out.push({ label: `${label} (covered at its centre)`, width: 0, height: 0, state });
      continue;
    }
    const reach = (dx: number, dy: number) => {
      let n = 0;
      while (n < 400 && owns(cx + dx * (n + 1), cy + dy * (n + 1))) n++;
      return n;
    };
    out.push({ label, width: reach(-1, 0) + reach(1, 0) + 1, height: reach(0, -1) + reach(0, 1) + 1, state });
  }
  return out;
}

const measureState = (page: Page, state: string, panel: string | null = null) => page.evaluate(hitAreas, { state, panel });

for (const width of WIDTHS) {
  test(`${width} px, coarse pointer: every target is at least 44 × 44`, async ({ browser, browserName }, testInfo) => {
    const context = await browser.newContext({
      viewport: { width, height: 800 },
      deviceScaleFactor: 1,
      hasTouch: true,
      isMobile: width === 360 && browserName === 'chromium',
    });
    const page = await context.newPage();
    try {
      await open(page, SHOWCASE);
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'the context has a coarse pointer').toBe(true);
      await page.locator('#player').scrollIntoViewIfNeeded();

      const hits: Hit[] = [];
      hits.push(...(await measureState(page, 'cover')));

      // Played, then paused: the bar, its keys and the corner.
      await startAndHold(page, 20);
      hits.push(...(await measureState(page, 'paused')));
      // A touch screen has no pointer to rest on the player: focus in it makes the panels' keys its own.
      await focusPlayer(page);

      const overlays: [string, string, string][] = [
        ['plate', 'p', '.fb-plate-sheet'],
        ['contents', 't', '.fb-contents-page'],
        ['caption style', 'Shift+C', 'fb-caption-style [role="dialog"]'],
        ['shortcuts', '?', 'fb-keymap [role="dialog"]'],
      ];
      // The plate and the contents are the book's: not there under essential.
      for (const [state, key, panel] of overlays.filter(([name]) => !ESSENTIAL || (name !== 'plate' && name !== 'contents'))) {
        await page.keyboard.press(key);
        await expect(page.locator(panel)).toBeVisible();
        hits.push(...(await measureState(page, state, panel)));
        await page.keyboard.press('Escape');
        await expect(page.locator(panel)).toBeHidden();
      }
      // The settings menu, opened from its key.
      await page.locator('.fb-settings').click();
      await expect(page.locator('#flipbook-settings')).toBeVisible();
      // On a phone it rises from the foot of the screen: measured once it has landed.
      await settle(page);
      hits.push(...(await measureState(page, 'settings', '#flipbook-settings')));
      await page.keyboard.press('Escape');

      // (Firefox answers for a box from the whole pixel after its edge: a 44 px key that begins at a fraction of a
      // pixel, as the page lays this player out, is its own for 43.7 px of them, and counted a pixel at a time from
      // its centre that reads 42 to 44. Its box is 44.00 in every engine.)
      const least = browserName === 'firefox' ? MIN - 2 : MIN;
      const small = hits.filter((h) => h.width < least || h.height < least);
      const smallest = hits.reduce((a, b) => (Math.min(b.width, b.height) < Math.min(a.width, a.height) ? b : a));
      await measure(testInfo, { width, smallest, count: hits.length, small, all: hits });

      // Audit floor: it found the controls (fewer under essential: no plate, contents, ribbons or their keys).
      expect(hits.length, 'targets measured').toBeGreaterThanOrEqual(ESSENTIAL ? 15 : 30);
      expect(
        small.map((h) => `${h.width}×${h.height} ${h.label} [${h.state}]`),
        `targets under ${MIN} px at ${width}`,
      ).toEqual([]);
    } finally {
      await context.close();
    }
  });
}
