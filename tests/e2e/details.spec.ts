import AxeBuilder from '@axe-core/playwright';
import { type Page } from '@playwright/test';
import { measureContrast } from './support/contrast';
import { BARE, BRIGHT, DARK, ESSENTIAL, focusPlayer, open, pointerOnPlayer, revealControls, seekPainted, startAndHold } from './support/player';
import { expect, test } from './support/test';

/**
 * The details (src/skins/flipbook/details.ts): each one behind its token in `data-fb-details`, measured on the page
 * with the token on and with it off. Computed styles, pixels and real key presses; never a class's presence.
 */

const ALL = 'cloth type folio icons sheaf lift states';
/** What the full book has when the page says nothing: every one of them (details.ts; Pedro, 11 Nov 2026). */
const DEFAULT = ALL;
const container = (page: Page) => page.locator('media-container').first();

/** Sets `details` on the player (as the bench's switches do) and waits for the container and the details' script. */
async function details(page: Page, value: string | null): Promise<void> {
  await page.evaluate((v) => {
    const player = document.querySelector('video-player') as HTMLElement;
    if (v === null) player.removeAttribute('details');
    else player.setAttribute('details', v);
  }, value);
  await expect(container(page)).toHaveAttribute('data-fb-details', value ?? DEFAULT);
  if ((value ?? DEFAULT).trim()) await expect(page.locator('media-container > fb-details-ui')).toHaveCount(1);
}

/** The details' chunk has arrived and the folio is set (the last thing the script does on a fresh page). */
async function ready(page: Page): Promise<void> {
  await expect(container(page)).toHaveAttribute('data-fb-details', DEFAULT);
  await expect(page.locator('media-container > fb-details-ui')).toHaveCount(1);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

test.describe('the switch', () => {
  test('the full book has every detail, and a token taken out turns that one off, live', async ({ page }) => {
    test.skip(ESSENTIAL, 'the details are the full book’s');
    await open(page, BARE);
    await ready(page);
    await details(page, 'cloth folio');
    const cap = page.locator('.fb-keycap').first();
    expect(await cap.evaluate((el) => getComputedStyle(el).clipPath), 'type is off: the keycap is the plain one').toBe('none');
    expect(await page.locator('.fb-bar').evaluate((el) => getComputedStyle(el).backgroundImage)).toContain('data:image/svg+xml');
    // Written on the container by hand, as an A/B in the inspector would: it stands.
    await page.evaluate(() => document.querySelector('media-container')?.setAttribute('data-fb-details', 'type'));
    await expect.poll(() => cap.evaluate((el) => getComputedStyle(el).clipPath)).not.toBe('none');
    expect(await page.locator('.fb-bar').evaluate((el) => getComputedStyle(el).backgroundImage)).not.toContain('data:image/svg+xml');
  });

  test('essential has none of them, and never fetches their chunk', async ({ page }) => {
    const asked: string[] = [];
    page.on('request', (request) => asked.push(new URL(request.url()).pathname));
    await open(page, `${BARE}&features=essential`);
    await expect(container(page)).toHaveAttribute('data-fb-details', '');
    await page.waitForTimeout(1500);
    expect(asked.filter((path) => /details|newsreader/i.test(path)), 'no details chunk, no folio font').toEqual([]);
    await expect(page.locator('fb-details-ui')).toHaveCount(0);
    // Asked for by name, an essential player takes them: the switch is the page's.
    await details(page, 'folio');
    await expect(page.locator('fb-folio .fb-fig').first()).toBeAttached();
  });
});

test.describe('details', () => {
  test.skip(ESSENTIAL, 'the details are the full book’s');

  for (const scale of [1, 2]) {
    test(`cloth: the gilt hairline is one CSS pixel of whole device pixels at ${scale}×, on the slab's top edge`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: scale });
      const page = await context.newPage();
      await open(page, BARE);
      await ready(page);
      await startAndHold(page, 20);
      await revealControls(page);
      const rows = async () => {
        const box = (await page.locator('.fb-bar').boundingBox())!;
        // A 1 px wide column through the slab's middle, from 3 px above its top edge to 4 px below.
        const png = await page.screenshot({ clip: { x: Math.round(box.x + box.width / 2), y: box.y - 3, width: 1, height: 7 } });
        return page.evaluate(async (b64) => {
          const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
          ctx.drawImage(bitmap, 0, 0);
          const out: boolean[] = [];
          for (let y = 0; y < bitmap.height; y++) {
            const [r, g, b] = ctx.getImageData(0, y, 1, 1).data;
            // Gilt: bright, warm, and clearly yellower than paper or the board.
            out.push(r > 190 && g > 160 && b < 190 && r - b > 50);
          }
          return out;
        }, png.toString('base64'));
      };
      const on = await rows();
      expect(on.filter(Boolean).length, `gilt rows at ${scale}× (${on.map((v) => (v ? '█' : '·')).join('')})`).toBe(scale);
      expect(on.indexOf(true), 'the rows are together').toBe(on.lastIndexOf(true) - (scale - 1));
      await details(page, ALL.replace('cloth', ''));
      expect((await rows()).filter(Boolean).length, 'no hairline with cloth off').toBe(0);
      await context.close();
    });
  }

  test('cloth: the weave is drawn in the page, with no request, and the slab keeps its corners', async ({ page }) => {
    const asked: string[] = [];
    page.on('request', (request) => asked.push(request.url()));
    await open(page, BARE);
    await ready(page);
    const bar = page.locator('.fb-bar');
    const style = await bar.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { image: cs.backgroundImage, radius: cs.borderTopLeftRadius, animation: cs.animationName };
    });
    expect(style.image).toContain('feTurbulence');
    expect(style.radius).toBe('19px');
    expect(style.animation, 'still').toBe('none');
    expect(asked.filter((url) => /\.svg|noise|weave/i.test(url))).toEqual([]);
  });

  test('type: a keycap is ink on type metal, and sinks while its real key is down', async ({ page }) => {
    await open(page, BARE);
    await ready(page);
    await pointerOnPlayer(page);
    await revealControls(page);
    const cap = page.locator(':is(.fb-top-key, .fb-slab-key).fb-bookmark .fb-keycap').filter({ visible: true }).first();
    await expect(cap).toHaveText('B');
    const style = await cap.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { color: cs.color, image: cs.backgroundImage, radius: cs.borderTopLeftRadius, size: cs.fontSize, property: cs.transitionProperty, duration: cs.transitionDuration, transform: cs.transform };
    });
    expect(style.color).toBe('rgb(20, 17, 14)');
    expect(style.image).toContain('linear-gradient');
    expect(style.radius, 'still 4 px, 4 px inside the key’s 8').toBe('4px');
    expect(parseFloat(style.size)).toBeGreaterThanOrEqual(12);
    expect(style.property.split(', '), 'the sink is a transform, beside the lift').toContain('transform');
    expect(new Set(style.duration.split(', '))).toEqual(new Set(['0.15s']));
    expect(style.transform).toBe('none');

    const transform = () => cap.evaluate((el) => getComputedStyle(el).transform);
    await page.keyboard.down('b');
    await expect.poll(transform, 'down with the key').toBe('matrix(0.96, 0, 0, 0.96, 0, 1)');
    await page.keyboard.up('b');
    await expect.poll(transform, 'up with the key').toBe('none');
    // A key that isn't its own leaves it alone.
    await page.keyboard.down('j');
    await page.waitForTimeout(200);
    expect(await transform()).toBe('none');
    await page.keyboard.up('j');
  });

  for (const [frame, time] of [['bright', BRIGHT], ['dark', DARK]] as const) {
    test(`what the details print (keycaps, folio, the slab's labels on the weave, the stand-in icons) holds its contrast over the ${frame} frame`, async ({ page }, testInfo) => {
      await open(page, BARE);
      await ready(page);
      // Every stand-in glyph on, the two that are off by default too: all of them are measured.
      await details(page, ALL);
      await pointerOnPlayer(page);
      await startAndHold(page, time);
      await revealControls(page);
      const { results } = await measureContrast(page);
      const lowest = (pattern: RegExp, kind: 'text' | 'graphics') => {
        const hits = results.filter((r) => pattern.test(r.label) && (kind === 'graphics' ? r.kind === 'graphics' : r.kind !== 'graphics'));
        return { count: hits.length, worst: hits.reduce<(typeof hits)[number] | undefined>((a, b) => (!a || b.ratio < a.ratio ? b : a), undefined) };
      };
      const parts = {
        keycap: lowest(/\.fb-keycap/, 'text'),
        folio: lowest(/\.fb-(fig|folio)/, 'text'),
        slab: lowest(/\.(fb-ends|fb-key-name|fb-time-display|fb-rate)/, 'text'),
        icons: lowest(/\.(fb-mute|media-mute-button|fb-settings|fb-fullscreen|media-fullscreen-button|media-button-icon)/, 'graphics'),
      };
      await testInfo.attach('details-contrast', { body: JSON.stringify(parts, null, 1), contentType: 'application/json' });
      console.log(`details contrast, ${frame}: ${Object.entries(parts).map(([name, part]) => `${name} ${part.worst?.ratio}:1 ×${part.count} (${part.worst?.color} on ${part.worst?.ground})`).join(' · ')}`);
      for (const [name, part] of Object.entries(parts)) {
        expect(part.count, `${name} was measured`).toBeGreaterThan(0);
        expect(part.worst?.ratio ?? 0, `${name}: ${part.worst?.label}`).toBeGreaterThanOrEqual(name === 'icons' ? 3.4 : 4.9);
      }
    });
  }

  test('type: a key typed on the page, with the pointer and focus elsewhere, sinks nothing', async ({ page }) => {
    await open(page, BARE);
    await ready(page);
    await page.mouse.move(2, 2);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.down('b');
    await page.waitForTimeout(200);
    expect(await page.locator('.fb-keycap[data-fb-down]').count()).toBe(0);
    await page.keyboard.up('b');
  });

  test('folio: the page number is set in the skin’s own serif and holds its width as it counts', async ({ page }) => {
    await open(page, BARE);
    await ready(page);
    await startAndHold(page, 20);
    const folio = page.locator('fb-folio');
    await expect(folio).toHaveText(/^p\. \d+ \/ \d+$/);
    const face = await folio.evaluate(async (el) => {
      await document.fonts.load('15px "Flipbook Newsreader"', 'p. 11 / 52');
      const cs = getComputedStyle(el);
      return { family: cs.fontFamily, size: cs.fontSize, style: cs.fontStyle, loaded: [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'Flipbook Newsreader' && f.status === 'loaded'), page: /(^|, )"?Newsreader"?(,|$)/.test(cs.fontFamily) };
    });
    expect(face.family).toContain('Flipbook Newsreader');
    expect(face.loaded, 'the skin’s own file is there').toBe(true);
    expect(face.page, 'a page’s own Newsreader (a display cut) is never borrowed: the skin’s is the one in use').toBe(false);
    expect(parseFloat(face.size)).toBeGreaterThanOrEqual(12);
    expect(face.style, 'roman: the skin bundles no italic').toBe('normal');
    // The time beside it stays in the mono.
    expect(await page.locator('.fb-time-display').evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/mono/i);

    // Two-figure pages with narrow and wide figures (11, 17, 38, 44): one width, to the tenth of a pixel.
    const widths: Record<string, number> = {};
    for (const time of [20, 31.5, 72, 83.5]) {
      await seekPainted(page, time);
      const text = (await folio.textContent()) ?? '';
      widths[text] = Math.round((await folio.evaluate((el) => (el.firstElementChild as HTMLElement).getBoundingClientRect().width)) * 10) / 10;
    }
    expect(Object.keys(widths).length, `four different pages (${JSON.stringify(widths)})`).toBe(4);
    expect(new Set(Object.values(widths)).size, `one width (${JSON.stringify(widths)})`).toBe(1);

    await details(page, ALL.replace('folio', ''));
    await expect(folio.locator('.fb-fig')).toHaveCount(0);
    expect(await folio.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/mono/i);
  });

  test('icons: each stand-in takes its key’s glyph and gives it back, and no key is renamed', async ({ page }) => {
    await open(page, BARE);
    await ready(page);
    await revealControls(page);
    const read = () =>
      page.evaluate(() => {
        const one = (selector: string) => {
          const key = document.querySelector(selector) as HTMLElement;
          return {
            name: key.getAttribute('aria-label') ?? key.textContent?.trim() ?? '',
            icons: [...key.querySelectorAll('media-icon')].map((icon) => icon.getAttribute('name')),
            drawn: [...key.querySelectorAll('media-icon svg')].map((svg) => `${svg.getAttribute('viewBox')} ${getComputedStyle(svg.querySelector('path') as Element).strokeWidth}`),
          };
        };
        return { fullscreen: one('.fb-fullscreen'), mute: one('.fb-mute'), settings: one('.fb-settings') };
      });
    // As shipped: the book's own glyphs for all three, and each key still says exactly what it is.
    const shipped = await read();
    expect(shipped.fullscreen.icons).toEqual(['spread-open', 'spread-closed']);
    expect(shipped.mute.icons).toEqual(['sheets-off', 'sheets-low', 'sheets-high']);
    expect(shipped.settings.icons).toEqual(['stick']);
    expect(shipped.settings.name, 'the Settings key’s name').toBe('Settings');
    expect(shipped.mute.name, 'the volume key’s name').toMatch(/^(Mute|Unmute|Volume)/);

    await details(page, ALL);
    const on = await read();
    expect(on.fullscreen.icons).toEqual(['spread-open', 'spread-closed']);
    expect(on.mute.icons).toEqual(['sheets-off', 'sheets-low', 'sheets-high']);
    expect(on.settings.icons).toEqual(['stick']);
    for (const key of Object.values(on)) for (const drawn of key.drawn) expect(drawn, 'the set’s grid and pen').toBe('0 0 20 20 1.5px');

    await details(page, 'cloth type folio sheaf lift states icon-fullscreen');
    const one = await read();
    expect(one.fullscreen.icons).toEqual(['spread-open', 'spread-closed']);
    expect(one.mute.icons).toEqual(['volume-off', 'volume-low', 'volume-high']);
    expect(one.settings.icons).toEqual(['gear']);

    await details(page, '');
    const off = await read();
    expect(off.fullscreen.icons).toEqual(['fullscreen-enter', 'fullscreen-exit']);
    for (const key of ['fullscreen', 'mute', 'settings'] as const) {
      expect(on[key].name.length, `${key} has a name`).toBeGreaterThan(0);
      expect(on[key].name, `${key} keeps its name`).toBe(off[key].name);
    }
  });

  test('icons: a phone’s keys, with no tooltip to tell a new glyph, keep the shapes everyone knows for fullscreen and volume', async ({ browser, browserName }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: browserName === 'chromium' });
    try {
      const page = await ctx.newPage();
      await open(page, BARE);
      await ready(page);
      const names = (selector: string) => page.locator(`${selector} media-icon`).evaluateAll((icons) => icons.map((icon) => icon.getAttribute('name')));
      await expect(page.locator('media-container')).toHaveAttribute('data-fb-details', /\bicons\b/);
      await expect.poll(() => names('.fb-settings'), 'the details’ script has run').toEqual(['stick']);
      expect(await names('.fb-fullscreen')).toEqual(['fullscreen-enter', 'fullscreen-exit']);
      expect(await names('.fb-bar .fb-mute')).toEqual(['volume-off', 'volume-low', 'volume-high']);
      await expect(page.locator('.fb-fullscreen')).toHaveAccessibleName(/full ?screen/i);
    } finally {
      await ctx.close();
    }
  });

  test('icons: a narrow player takes the conventional fullscreen glyph and gives the book’s back when it is wide again', async ({ page }) => {
    await open(page, BARE);
    await ready(page);
    const names = () => page.locator('.fb-fullscreen media-icon').evaluateAll((icons) => icons.map((icon) => icon.getAttribute('name')));
    await expect.poll(names).toEqual(['spread-open', 'spread-closed']);
    await page.setViewportSize({ width: 400, height: 800 });
    await expect(page.locator('media-container')).toHaveAttribute('data-fb-phone', '');
    await expect.poll(names).toEqual(['fullscreen-enter', 'fullscreen-exit']);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(names).toEqual(['spread-open', 'spread-closed']);
  });

  test('sheaf: the fader is still the slider, 44 px wide to the pointer, and the keys move it', async ({ page }) => {
    await open(page, BARE);
    await ready(page);
    await page.evaluate(() => {
      const video = document.querySelector('video') as HTMLVideoElement;
      video.muted = false;
      video.volume = 0.5;
    });
    await revealControls(page);
    await page.locator('.fb-mute').hover();
    const slider = page.locator('.media-volume-slider');
    await expect(slider).toBeVisible();
    const thumb = page.locator('.media-volume-slider-thumb');
    const box = (await slider.boundingBox())!;
    expect(box.width, 'hit area').toBeGreaterThanOrEqual(44);
    const drawn = await page.evaluate(() => {
      const fill = getComputedStyle(document.querySelector('.media-volume-slider-fill') as Element);
      const knob = document.querySelector('.media-volume-slider-thumb') as HTMLElement;
      const track = (document.querySelector('.media-volume-slider-track') as HTMLElement).getBoundingClientRect();
      const filled = (document.querySelector('.media-volume-slider-fill') as HTMLElement).getBoundingClientRect();
      return { fill: fill.backgroundImage, knob: [knob.offsetWidth, knob.offsetHeight], share: filled.height / track.height };
    });
    expect(drawn.fill, 'one hairline a page').toContain('repeating-linear-gradient');
    expect(drawn.knob).toEqual([30, 6]);
    expect(drawn.share, 'the stack is as tall as the level').toBeCloseTo(0.5, 1);
    // Whatever carries the slider's role keeps it, with its value.
    const role = page.locator('.media-volume-popover-popup [role="slider"]');
    await expect(role).toHaveCount(1);
    await role.focus();
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).volume)).toBeGreaterThan(0.5);
    const ring = await thumb.evaluate((el) => getComputedStyle(el).outlineWidth);
    expect(ring, 'the one ring, on the top sheet').toBe('2px');
  });

  test('lift: under the pointer a key’s plate and its print rise two pixels, and the key itself stays put', async ({ page }) => {
    await open(page, BARE);
    await ready(page);
    await revealControls(page);
    const key = page.locator('.fb-settings');
    const before = (await key.boundingBox())!;
    await key.hover();
    const read = () =>
      key.evaluate((el) => {
        const plate = getComputedStyle(el, '::after');
        const icon = getComputedStyle(el.querySelector('.media-button-icon') as Element);
        return { plate: plate.translate, icon: icon.translate, property: plate.transitionProperty, duration: plate.transitionDuration, opacity: plate.opacity };
      });
    await expect.poll(async () => (await read()).plate).toBe('0px -2px');
    const lifted = await read();
    expect(lifted.icon).toBe('0px -2px');
    expect(lifted.property).toBe('opacity, translate');
    expect(lifted.duration).toBe('0.15s, 0.15s');
    await expect.poll(async () => (await read()).opacity).toBe('1');
    expect(await key.boundingBox(), 'the key’s box never moves').toEqual(before);
    // Pressed, it lies flat under the house press.
    await page.mouse.down();
    await expect.poll(async () => (await read()).plate).toBe('none');
    expect(await key.evaluate((el) => getComputedStyle(el).transform)).not.toBe('none');
    await page.mouse.up();
    await page.keyboard.press('Escape');

    await details(page, ALL.replace('lift', ''));
    await page.mouse.move(2, 2);
    await key.hover();
    await page.waitForTimeout(250);
    expect((await read()).plate, 'off: nothing rises').toBe('none');
  });

  test('lift: nothing rises under reduced motion', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    await open(page, BARE);
    await ready(page);
    await revealControls(page);
    const key = page.locator('.fb-settings');
    await key.hover();
    await page.waitForTimeout(250);
    expect(await key.evaluate((el) => getComputedStyle(el, '::after').translate)).toBe('none');
    await context.close();
  });

  test('lift: nothing rises on a touch screen', async ({ browser, browserName }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true, ...(browserName === 'chromium' ? { isMobile: true } : {}) });
    const page = await context.newPage();
    await open(page, BARE);
    await ready(page);
    test.skip(!(await page.evaluate(() => matchMedia('(hover: none)').matches)), 'this engine reports a hover here');
    await focusPlayer(page);
    const key = page.locator('.fb-settings');
    await key.tap();
    await page.waitForTimeout(250);
    expect(await key.evaluate((el) => getComputedStyle(el, '::after').translate)).toBe('none');
    await context.close();
  });

  test('states: the missing page says what happened, and Try again brings the film back', async ({ page }) => {
    let broken = true;
    let refused = 0;
    await open(page, BARE);
    await ready(page);
    const real = await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).currentSrc);
    // Mended, the address is the film's own again, and goes on to whoever answers the film here (`fallback`, not
    // `continue`: the silent copy, support/silence.mjs). Sent straight to the server it was the film with its sound
    // for the first bytes and the silent copy for the rest, two lengths for one film: WebKit then asked past the end
    // of the shorter one for as long as the page stood.
    await page.route('**/missing-page.mp4', (route) => {
      if (!broken) return route.fallback({ url: real });
      refused++;
      return route.fulfill({ status: 404, body: '' });
    });
    await page.evaluate(() => {
      const video = document.querySelector('video') as HTMLVideoElement;
      video.src = '/missing-page.mp4';
      video.load();
    });
    const popup = page.locator('media-error-dialog media-dialog-popup');
    await expect(popup).toBeVisible();
    expect(refused, 'times the film was asked for and refused').toBe(1);
    await expect(popup.locator('.media-dialog-title')).toHaveText('The film can’t play');
    await expect(popup.locator('.media-dialog-description')).toHaveText(/Try again/);
    const retry = popup.locator('.fb-error-retry');
    await expect(retry).toHaveText('Try again');
    const size = (await retry.boundingBox())!;
    expect(Math.min(size.width, size.height)).toBeGreaterThanOrEqual(44);
    expect(await popup.evaluate((el) => getComputedStyle(el).backgroundImage), 'torn at the spine').toContain('data:image/svg+xml');
    const axe = await new AxeBuilder({ page }).include('media-error-dialog').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(', ')}`)).toEqual([]);

    // Still broken: the film is asked for again, refused again, and the dialog is there with its way back. (The
    // second refusal is waited for before the film is mended. The dialog alone says nothing of it: it is still on
    // screen in the moment after the press, and the film was mended 1 ms before its second asking arrived, measured:
    // the first Try again then brought the film back, and the second press had no key to press, for a minute.)
    await retry.click();
    await expect.poll(() => refused, 'times the film was asked for and refused').toBe(2);
    await expect.poll(() => page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).error?.code)).toBe(4);
    await expect(popup).toBeVisible();
    await expect(retry).toBeVisible();
    broken = false;
    await retry.click();
    await expect(popup).toBeHidden();
    await expect.poll(() => page.evaluate(() => {
      const video = document.querySelector('video') as HTMLVideoElement;
      return !video.error && video.readyState >= 1;
    })).toBe(true);
  });

  test('states: with the detail off the dialog is the plain one, with its own words and no retry', async ({ page }) => {
    await open(page, BARE);
    await ready(page);
    await details(page, ALL.replace('states', ''));
    await page.route('**/missing-page.mp4', (route) => route.fulfill({ status: 404, body: '' }));
    await page.evaluate(() => {
      const video = document.querySelector('video') as HTMLVideoElement;
      video.src = '/missing-page.mp4';
      video.load();
    });
    const popup = page.locator('media-error-dialog media-dialog-popup');
    await expect(popup).toBeVisible();
    await expect(popup.locator('.fb-error-retry')).toHaveCount(0);
    await expect(popup.locator('.media-dialog-description')).toHaveText(/Reload the page/);
    expect(await popup.evaluate((el) => getComputedStyle(el).backgroundImage)).toBe('none');
  });

  test('states: a film with no captions says so in Settings, and only then', async ({ page }) => {
    await open(page, BARE);
    await ready(page);
    await revealControls(page);
    const none = page.locator('.fb-menu-none');
    await page.locator('#flipbook-settings-trigger').click();
    await expect(page.locator('.media-menu-item[commandfor="flipbook-subtitles"]')).toBeVisible();
    await expect(none).toBeHidden();
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      for (const track of document.querySelectorAll('track[kind="captions"], track[kind="subtitles"]')) track.remove();
    });
    await expect(page.locator('.media-menu-item[commandfor="flipbook-subtitles"]')).toHaveAttribute('data-availability', 'unavailable');
    await revealControls(page);
    await page.locator('#flipbook-settings-trigger').click();
    await expect(none).toBeVisible();
    await expect(none).toHaveText(/Captions\s*None/);
    await expect(none).toHaveText(/This film has no captions\.$/);
    expect(await none.getAttribute('aria-label'), 'named by what it prints').toBeNull();
    expect(await none.evaluate((el) => getComputedStyle(el).cursor), 'nothing to open: the arrow').toBe('default');
    const axe = await new AxeBuilder({ page }).include('.media-menu-popup').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(', ')}`)).toEqual([]);
    await page.keyboard.press('Escape');
    await details(page, ALL.replace('states', ''));
    await expect(page.locator('.fb-menu-none')).toHaveCount(0);
  });
});
