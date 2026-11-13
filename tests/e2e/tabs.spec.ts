import type { Page } from '@playwright/test';
import { BARE, featured, open, SHOWCASE, tabTo, TITLES } from './support/player';
import { expect, test } from './support/test';

/**
 * The chapter tabs on the fore-edge: where they stand, and what they print.
 *
 * - They are in place in the first layout the player ever gets, however a page mounts it (hidden and shown later,
 *   or with no box): nothing measures and corrects them afterwards.
 * - A tab prints its chapter's whole name where it fits before the next tab, else its number alone. Never part of a
 *   name, never an ellipsis; a tab numbered alone names its chapter on its slip.
 */

interface Tab {
  /** What is printed on the face, as drawn. */
  text: string;
  label: string;
  left: number;
  right: number;
  width: number;
  height: number;
  /** The name is on the face. */
  named: boolean;
  /** Anything on the face cut by its box, or set to be. */
  cut: boolean;
  /** How far the tab, lettered, would reach past the start of the next (or the edge's end): positive, it doesn't fit. */
  over: number;
}

/** Every tab as laid out now, and whether the page scrolls sideways. */
const read = (page: Page) =>
  page.evaluate(() => {
    const strip = document.querySelector<HTMLElement>('.fb-tabs')!;
    const buttons = [...strip.querySelectorAll<HTMLElement>('.fb-tab')];
    const drawn = (el: HTMLElement) => !el.hidden && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const end = strip.getBoundingClientRect().right;
    const tabs = buttons.map((tab, i) => {
      const face = tab.querySelector<HTMLElement>('.fb-tab-face')!;
      const name = tab.querySelector<HTMLElement>('.fb-tab-short')!;
      const named = drawn(name);
      const number = [...face.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim();
      const r = tab.getBoundingClientRect();
      const cut =
        [face, name].some((el) => /ellipsis/.test(getComputedStyle(el).textOverflow)) ||
        (named && (name.scrollWidth > name.clientWidth || face.scrollWidth > face.clientWidth || name.getBoundingClientRect().right > face.getBoundingClientRect().right + 0.5));
      // Lettered for a moment (nothing is painted meanwhile), to hold the rule to both its halves.
      const was = name.hidden;
      name.hidden = false;
      const next = buttons[i + 1]?.getBoundingClientRect().left ?? end;
      const over = tab.getBoundingClientRect().right - next;
      name.hidden = was;
      return { text: named ? `${number} ${name.textContent}` : number, label: tab.getAttribute('aria-label') ?? '', left: r.left, right: r.right, width: r.width, height: r.height, named, cut, over };
    });
    const pad = !!document.querySelector('media-container')?.hasAttribute('data-fb-pad');
    return { tabs, end, pad, sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });

/** The rule, on whatever is on the page now. */
async function expectRule(page: Page, where: string) {
  const { tabs, end, pad, sideways } = await read(page);
  expect(tabs.length, `${where}: six tabs`).toBe(TITLES.length);
  // On a phone's pad the tabs are a row of keys beside a running foot that names the chapter: all lettered, or none.
  const all = tabs.every((tab) => tab.over <= 0.01);
  // Elsewhere: the names that fit, where most of them do; where only a few would, numbers on every tab.
  const most = tabs.filter((tab) => tab.over <= 0.01).length > tabs.length / 2;
  tabs.forEach((tab, i) => {
    const n = `${where}, tab ${i + 1}`;
    expect([`${i + 1}`, `${i + 1} ${TITLES[i]}`], `${n} prints its number, or its number and whole name`).toContain(tab.text);
    expect(tab.text, `${n}: no ellipsis`).not.toMatch(/…|\.\.\./);
    expect(tab.cut, `${n}: nothing cut`).toBe(false);
    expect(tab.named, `${n}: lettered exactly when the name fits (it would reach ${tab.over.toFixed(1)} px past its room; ${pad ? 'on the pad, when every name fits' : 'when most names fit'})`).toBe(pad ? all : most && tab.over <= 0.01);
    expect(tab.label.startsWith(`${i + 1} ${TITLES[i]}`), `${n}: its accessible name starts with what it prints`).toBe(true);
    expect(Math.min(tab.width, tab.height), `${n}: a whole target`).toBeGreaterThanOrEqual(44);
    expect(tab.right, `${n} ends before the next begins`).toBeLessThanOrEqual((tabs[i + 1]?.left ?? end) + 0.05);
  });
  expect(sideways, `${where}: no sideways scroll`).toBeLessThanOrEqual(0);
  return tabs;
}

const WIDTHS = [1280, 1024, 768, 390, 360, 320];

test.describe('what a chapter tab prints', () => {
  for (const [page_, path] of [['the player alone', BARE], ['the showcase', SHOWCASE]] as const) {
    for (const width of WIDTHS) {
      test(`${width} px, ${page_}: a whole name or a number alone, never part of a name`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await open(page, path);
        await expectRule(page, `${width} px`);
      });
    }
  }

  test('the room changes: the tabs are lettered again for it, and again when it comes back', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page, BARE);
    const wide = await expectRule(page, '1280 px');
    expect(wide.every((tab) => tab.named), 'at 1280 px every tab carries its name').toBe(true);
    await page.setViewportSize({ width: 768, height: 800 });
    await expect.poll(async () => (await read(page)).tabs.filter((tab) => tab.named).length, { message: 'lettered tabs at 768 px' }).toBeLessThan(6);
    await expectRule(page, '768 px, after 1280');
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(async () => (await read(page)).tabs.every((tab) => tab.named)).toBe(true);
    await expectRule(page, '1280 px, again');
  });

  test('the type grows wider (a page’s text spacing): names that no longer fit give way to numbers', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await open(page, BARE);
    const before = (await expectRule(page, '1024 px')).filter((tab) => tab.named).length;
    expect(before, 'lettered tabs before').toBeGreaterThan(0);
    await page.addStyleTag({ content: '.media-skin .fb-tab-short { letter-spacing: 0.45em !important; }' });
    await expect.poll(async () => (await read(page)).tabs.filter((tab) => tab.named).length, { message: 'lettered tabs with wide spacing' }).toBeLessThan(before);
    const { tabs, end } = await read(page);
    tabs.forEach((tab, i) => {
      expect(tab.cut, `tab ${i + 1}: nothing cut`).toBe(false);
      expect(tab.right, `tab ${i + 1} ends before the next begins`).toBeLessThanOrEqual((tabs[i + 1]?.left ?? end) + 0.05);
    });
  });

  test('a tab numbered alone names its chapter on its slip, on hover and on focus; a lettered one has no slip to show', async ({ page, browserName }) => {
    await page.setViewportSize({ width: 768, height: 800 });
    await open(page, BARE);
    const tabs = await expectRule(page, '768 px');
    const alone = tabs.findIndex((tab) => !tab.named);
    const lettered = tabs.findIndex((tab) => tab.named);
    expect(alone, 'a tab numbered alone at 768 px').toBeGreaterThanOrEqual(0);
    expect(lettered, 'a lettered tab at 768 px').toBeGreaterThanOrEqual(0);
    const slip = (i: number) => page.locator('.fb-tab').nth(i).locator('.fb-tab-name');
    const shown = (i: number) =>
      slip(i).evaluate((el) => {
        const style = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const box = el.closest('media-container')!.getBoundingClientRect();
        return { visible: style.display !== 'none' && style.visibility === 'visible' && Number(style.opacity) > 0.99, inside: r.left >= box.left && r.right <= box.right, text: el.textContent };
      });
    const face = (i: number) => page.locator('.fb-tab').nth(i).locator('.fb-tab-face');

    await face(alone).hover();
    await expect.poll(() => shown(alone), { message: 'the slip on hover' }).toEqual({ visible: true, inside: true, text: TITLES[alone] });
    await face(lettered).hover();
    await expect.poll(async () => (await shown(alone)).visible, { message: 'the slip folds when the pointer leaves' }).toBe(false);
    expect((await shown(lettered)).visible, 'a lettered tab shows no slip').toBe(false);
    await page.mouse.move(2, 2);

    // By keyboard: real keys, so the ring and the slip are the ones a keyboard user gets.
    await tabTo(page, browserName, '.fb-tab');
    for (let i = await page.evaluate(() => [...document.querySelectorAll('.fb-tab')].indexOf(document.activeElement as HTMLElement)); i !== alone; i = (i + 1) % tabs.length) {
      await page.keyboard.press('ArrowRight');
    }
    await expect(page.locator('.fb-tab').nth(alone)).toBeFocused();
    await expect.poll(() => shown(alone), { message: 'the slip on keyboard focus' }).toEqual({ visible: true, inside: true, text: TITLES[alone] });
  });
});

/** Hides the player's host from before the page is parsed, as a page that mounts its player out of sight does. */
const hideHost = (css: string) => {
  const add = () => {
    const style = document.createElement('style');
    style.id = 'tabs-spec-hide';
    style.textContent = css;
    (document.head ?? document.documentElement).append(style);
  };
  if (document.documentElement) add();
  else {
    new MutationObserver((_, observer) => {
      if (!document.documentElement) return;
      observer.disconnect();
      add();
    }).observe(document, { childList: true });
  }
};

test.describe('the tabs place themselves', () => {
  const HOSTS = [
    ['not displayed', '#player { display: none !important; }'],
    ['with no box', '#player { width: 0 !important; overflow: hidden !important; }'],
  ] as const;
  for (const [how, css] of HOSTS) {
    for (const width of [360, 390, 1280]) {
      test(`${width} px, mounted ${how} and shown later: every tab stands in its place, and prints what it will, from the first layout`, async ({ browser, browserName }) => {
        const phone = width < 480;
        const context = await browser.newContext(
          phone ? { viewport: { width, height: 800 }, deviceScaleFactor: 2, hasTouch: true, isMobile: browserName === 'chromium' } : { viewport: { width, height: 800 } },
        );
        try {
          const page = await context.newPage();
          await page.addInitScript(hideHost, css);
          await page.goto(featured(BARE));
          // Built and lengthed while out of sight: the case that used to wait for a measurement.
          await page.waitForFunction(() => document.querySelectorAll('.fb-tab').length === 6 && (document.querySelector('video')?.duration ?? 0) > 0);
          await page.evaluate(() => document.fonts.ready.then(() => undefined));
          const seen = await page.evaluate(
            () =>
              new Promise<{ first: number[]; painted: { lefts: number[]; texts: string[] }[]; shifts: number }>((resolve) => {
                const tabs = [...document.querySelectorAll<HTMLElement>('.fb-tab')];
                const lefts = () => tabs.map((tab) => tab.getBoundingClientRect().left);
                const texts = () =>
                  tabs.map((tab) => {
                    const name = tab.querySelector<HTMLElement>('.fb-tab-short');
                    return name && !name.hidden && name.getClientRects().length > 0 ? 'name' : 'number';
                  });
                let shifts = 0;
                try {
                  new PerformanceObserver((list) => {
                    for (const entry of list.getEntries() as (PerformanceEntry & { value: number; sources?: { node?: Node }[] })[]) {
                      if (entry.sources?.some((source) => source.node instanceof Element && !!source.node.closest('.fb-tab'))) shifts += entry.value;
                    }
                  }).observe({ type: 'layout-shift' });
                } catch {
                  // Only Chromium reports layout shifts; the positions below are read in both engines.
                }
                document.getElementById('tabs-spec-hide')?.remove();
                // The player takes its own measure as it is shown, as the showcase's mount asks it to (room.ts: a
                // phone's player is laid out as a pad); the tabs are asked nothing.
                document.querySelector<HTMLElement & { measure(): void }>('fb-room')?.measure();
                // The first layout the shown player gets, before any observer or frame callback has run.
                const first = lefts();
                const painted: { lefts: number[]; texts: string[] }[] = [];
                const frame = () => {
                  // After this frame's rendering steps (resize observers included): what the frame painted.
                  const channel = new MessageChannel();
                  channel.port1.onmessage = () => {
                    painted.push({ lefts: lefts(), texts: texts() });
                    if (painted.length < 8) requestAnimationFrame(frame);
                    else setTimeout(() => resolve({ first, painted, shifts }), 250);
                  };
                  channel.port2.postMessage(0);
                };
                requestAnimationFrame(frame);
              }),
          );
          const settled = seen.painted.at(-1)!;
          const off = (lefts: number[]) => Math.max(...lefts.map((left, i) => Math.abs(left - settled.lefts[i])));
          expect(off(seen.first), 'px from its final place, in the first layout').toBeLessThan(0.05);
          seen.painted.forEach((frame, i) => {
            expect(off(frame.lefts), `px from its final place, frame ${i + 1}`).toBeLessThan(0.05);
            expect(frame.texts, `what the tabs print, frame ${i + 1}`).toEqual(settled.texts);
          });
          expect(seen.shifts, 'layout shift of the tabs (Chromium)').toBe(0);
          // Nudged apart as a shown player's are: no two hit boxes overlap.
          await expectRule(page, `${width} px, shown`);
        } finally {
          await context.close();
        }
      });
    }
  }
});
