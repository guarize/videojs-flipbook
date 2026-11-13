/**
 * The showcase site, checked in a real browser on its production build (`pnpm site:build`, then `pnpm site:preview`).
 * What the player's own battery (tests/e2e) cannot see, because it only exists on the page:
 *
 * - no console error, page error or failed request, and no sideways scroll at 360 to 1440 px, down the whole page;
 * - axe (WCAG 2.0 to 2.2, A and AA) at the top and at the foot, with a floor on the nodes it looked at;
 * - the page's layout does not move while the player takes the poster's place (layout-shift entries, summed), nor
 *   when the film's length arrives after the controls are laid out;
 * - a press on the poster, or Space, made BEFORE the player's script has arrived starts the film once the player
 *   stands, exactly once; and a real click and a real Space do after;
 * - Tab goes skip link, masthead, then into the player, a focus ring on every stop;
 * - under reduced motion nothing runs: two frames 800 ms apart are the same bytes;
 * - the page's styles stay out of the skin: a keycap and a heading inside the player compute as the skin sets them
 *   (the page's unlayered `kbd` and `h2` rules once restyled both);
 * - the proof on the page: the numbers it prints are the audit files' (design/previews/audit); the Essential / Full
 *   book switch is one Tab stop with the arrows inside, moves one thumb in 150 to 250 ms, changes `features` on the
 *   player without touching its time or whether it plays, and opened as `?features=essential` fetches none of the
 *   book's extras until Full book is chosen; each frame key pauses the film on its measured frame and brings the
 *   player into view; "Your settings" follows the browser; and every still is lazy, sized, described and loads.
 *
 * Usage: `node scripts/site-check.mjs [chromium|webkit|firefox] [url]`. Exit code 1 on any failure. One browser at a time.
 * Every film is muted before it can play, and every context is silenced (scripts/quiet.mjs, over test-fixtures/silence.mjs): no sound, in
 * either engine.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { quiet } from './quiet.mjs';
import { REAL_STREAM } from '../tests/e2e/support/silence.mjs';

const require = createRequire(import.meta.url);
const playwright = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;

const engine = process.argv[2] ?? 'chromium';
const url = process.argv[3] ?? 'http://127.0.0.1:4403/';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const WIDTHS = [360, 390, 768, 1024, 1280, 1440];
/** The fewest nodes an axe scan of this page may cover: "0 violations" of an empty page proves nothing. */
const AXE_FLOOR = 400;
/** A layout shift under this is a sub-pixel settling (a tab finding its place when the film's length arrives). */
const SHIFT_LIMIT = 0.001;

const failures = [];
const fail = (where, what) => {
  failures.push(`${where}: ${what}`);
  console.log(`  FAIL ${where}: ${what}`);
};
const check = (where, ok, what) => {
  if (!ok) fail(where, what);
  return ok;
};

const browser = await playwright[engine].launch(engine === 'chromium' ? { args: ['--mute-audio'] } : engine === 'firefox' ? { firefoxUserPrefs: { 'media.volume_scale': '0.0' } } : {});

/** A page with its errors collected, its films muted and counted, and its layout shifts summed. */
async function open(width, { reduced = false, holdPlayer = 0, holdFilm = 0, slow = 1, query = '', scheme = 'dark', forced = 'none' } = {}) {
  const context = await browser.newContext({
    viewport: { width, height: width < 500 ? 780 : 900 },
    reducedMotion: reduced ? 'reduce' : 'no-preference',
    hasTouch: width < 500,
    isMobile: width < 500 && engine === 'chromium',
    colorScheme: scheme,
    forcedColors: forced,
  });
  await quiet(context);
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('pageerror', (e) => errors.push(`pageerror ${e.message}`));
  // A silenced context answers nothing from Mux (tests/e2e/support/silence.mjs; FB_MUX=1 lets it through, muted): the
  // film then plays from the page's own copy, and the browser reports each refusal on the console. Those are the
  // helper's doing, not the page's.
  // (Chromium and WebKit name the refused address as the message's place; Firefox names it in the message's words.)
  const refused = (m) => !REAL_STREAM && (/^https?:\/\/([\w-]+\.)*mux\.com\//.test(m.location().url) || (engine === 'firefox' && /Cross-Origin Request Blocked.*https?:\/\/([\w-]+\.)*mux\.com\//.test(m.text())));
  page.on('console', (m) => m.type() === 'error' && !refused(m) && errors.push(`console ${m.text()}`));
  // (Firefox reports a request the page itself withdrew as failed, NS_BINDING_ABORTED: on a phone the storyboard's
  // picture is asked for twice in a row there, the first let go and the second answered. Nothing failed.)
  page.on('requestfailed', (r) => !/\.mp4|\.m3u8/.test(r.url()) && r.failure()?.errorText !== 'NS_BINDING_ABORTED' && errors.push(`failed ${r.url()}`));
  await page.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      this.muted = true;
      return play.call(this);
    };
    window.__site = { plays: 0, pauses: 0, shift: 0, shifts: [] };
    document.addEventListener('play', () => window.__site.plays++, true);
    // A film that goes on to its next source starts again there, and says `play` again: one start for whoever is
    // watching. So plays are counted on the source that has the film (here Mux is refused, and the film reaches the
    // page's own copy on its third); a pause is counted wherever it happens.
    document.addEventListener('emptied', () => (window.__site.plays = 0), true);
    document.addEventListener('pause', () => window.__site.pauses++, true);
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.hadRecentInput) continue;
          window.__site.shift += entry.value;
          window.__site.shifts.push(`${entry.value.toFixed(5)} ${(entry.sources ?? []).map((s) => s.node?.className ?? s.node?.nodeName).join(', ')}`);
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {
      // No layout-shift entries in this engine (WebKit, Firefox): the shift checks run in Chromium.
    }
  });
  // The film's bytes, held back: its length arrives after the player has laid its controls out. (Then on to the
  // silenced context's own route for the film.)
  if (holdFilm) {
    await page.route(/\/media\/film\/film-720[^/]*\.mp4/, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, holdFilm));
      await route.fallback();
    });
  }
  // The player's script, held back: the page stands on its poster for that long, as on a slow connection.
  if (holdPlayer) {
    await page.route(/\/_astro\/player\.[^/]+\.js$/, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, holdPlayer));
      await route.continue();
    });
  }
  // A processor `slow` times slower (Chromium only): on a fast one the player's first frames fall inside one paint, and
  // a frame painted before it has measured itself is never seen.
  const cdp = slow > 1 && engine === 'chromium' ? await context.newCDPSession(page) : null;
  await cdp?.send('Emulation.setCPUThrottlingRate', { rate: slow });
  await page.goto(url + query, { waitUntil: 'load' });
  return { context, page, errors, requests, fast: () => cdp?.send('Emulation.setCPUThrottlingRate', { rate: 1 }) };
}

const mounted = (page) => page.waitForSelector('media-container fb-edge[data-ready]', { state: 'attached', timeout: 20_000 });
const playing = (page) =>
  page.waitForFunction(
    () => {
      const video = document.querySelector('video');
      return !!video && !video.paused && video.currentTime > 0.3;
    },
    undefined,
    { timeout: 10_000 },
  );
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

console.log(`${engine} ${url}`);

// What the page loads has no `@scope` (build/unscope.mjs writes it out): Mobile Safari matches no scoped rule on a
// shadow host (Video.js's poster: the hero was black on an iPhone), and neither this Chromium nor this WebKit shows it.
// And the poster is a picture: the page's own before the player stands, the player's after, never an empty box.
{
  const at = `${engine} 390 shipped`;
  const { context, page } = await open(390);
  const before = await page.evaluate(async () => {
    const img = document.querySelector('#player img.player-poster');
    await img?.decode().catch(() => {});
    return { width: img?.naturalWidth ?? 0, src: img?.currentSrc ?? '' };
  });
  check(at, before.width > 0, `the page's poster did not load: ${before.src}`);
  await mounted(page);
  await page.waitForTimeout(600);
  const inline = await page.evaluate(() => [...document.querySelectorAll('style')].map((style) => style.textContent ?? ''));
  // Every stylesheet and script the page has fetched (an extra's styles travel inside its script), read again from the cache.
  const loaded = await page.evaluate(async () => {
    const urls = [...new Set(performance.getEntriesByType('resource').map((entry) => entry.name))].filter((name) => /\.(css|js)(\?|$)/.test(name));
    return Promise.all(urls.map(async (url) => ({ url, text: await (await fetch(url, { cache: 'force-cache' })).text() })));
  });
  check(at, loaded.filter((file) => /\.css/.test(file.url)).length > 0 && loaded.length > 5, `only ${loaded.length} stylesheets and scripts were seen loading with the player`);
  const scoped = [...loaded.filter((sheet) => /@scope\s*\(/.test(sheet.text)).map((sheet) => sheet.url), ...inline.filter((text) => /@scope\s*\(/.test(text)).map(() => 'an inline <style>')];
  check(at, scoped.length === 0, `@scope reached the page: ${scoped.join(', ')}`);
  const poster = await page.evaluate(async () => {
    const container = document.querySelector('media-container');
    const image = container.querySelector('.media-poster-image');
    await image.decode().catch(() => {});
    const box = container.getBoundingClientRect();
    const r = image.getBoundingClientRect();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 16;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, image.naturalWidth / 2 - 8, image.naturalHeight / 2 - 8, 16, 16, 0, 0, 16, 16);
    const data = ctx.getImageData(0, 0, 16, 16).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += data[i] + data[i + 1] + data[i + 2];
    const style = getComputedStyle(image.parentElement);
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + 12);
    return { natural: image.naturalWidth, mean: sum / (256 * 3), position: style.position, fit: getComputedStyle(image).objectFit, off: [r.left - box.left, r.top - box.top, r.width - box.width, r.height - box.height].map((n) => Math.round(Math.abs(n))), inside: !!hit && container.contains(hit) };
  });
  check(at, poster.natural > 0 && poster.mean > 8, `the player's poster is empty or black: ${poster.natural}px wide, centre ${poster.mean.toFixed(1)}`);
  check(at, poster.position === 'absolute' && poster.fit === 'contain' && Math.max(...poster.off) <= 1, `the poster does not fill the player's box: position ${poster.position}, object-fit ${poster.fit}, off by ${poster.off.join(' ')}`);
  console.log(`  ${at}: ${loaded.length} stylesheets and scripts, ${inline.length} inline styles, no @scope; poster ${poster.natural}px, centre ${poster.mean.toFixed(0)}, in its box`);
  await context.close();
}

// A film whose length arrives late (a slow connection: the controls are laid out, then the metadata comes): nothing
// that was drawn moves when it does. (The keys at the bar's end used to: picture-in-picture is unavailable until
// there is a film, and its key came into the row with the metadata.) Layout-shift entries: Chromium's.
if (engine === 'chromium') {
  for (const width of [768, 1024, 1280]) {
    const at = `${engine} ${width} late film`;
    const { context, page } = await open(width, { holdFilm: 2500 });
    await mounted(page);
    const laidOut = await page.evaluate(() => !(document.querySelector('video')?.duration > 0));
    check(at, laidOut, 'the film’s length was known before the controls stood: nothing late was tested');
    await page.waitForFunction(() => document.querySelector('video')?.duration > 0, undefined, { timeout: 20_000 });
    await page.waitForTimeout(1200);
    const shift = await page.evaluate(() => window.__site);
    check(at, shift.shift < SHIFT_LIMIT, `layout shift as the film’s length arrives ${shift.shift.toFixed(4)}: ${shift.shifts.join(' | ')}`);
    console.log(`  ${at}: shift ${shift.shift.toFixed(5)}`);
    await context.close();
  }
}

for (const width of WIDTHS) {
  const at = `${engine} ${width}`;
  const { context, page, errors, fast } = await open(width, { slow: 4 });
  await mounted(page);
  await page.waitForTimeout(1200);
  await fast();

  check(at, (await overflow(page)) === 0, 'sideways scroll at the top');
  const shift = await page.evaluate(() => window.__site);
  if (engine === 'chromium') check(at, shift.shift < SHIFT_LIMIT, `layout shift through the mount ${shift.shift.toFixed(4)}: ${shift.shifts.join(' | ')}`);
  let report = `overflow 0, shift ${shift.shift.toFixed(5)}`;

  // A phone's player hangs its pad under the picture (phone.css): the page keeps exactly that room under the host.
  if (width < 480) {
    const pad = await page.evaluate(() => {
      const host = document.querySelector('#player');
      const container = host.querySelector('media-container');
      const bar = container.querySelector('.fb-bar').getBoundingClientRect();
      return { has: container.hasAttribute('data-fb-pad'), hangs: Math.round((bar.bottom - host.getBoundingClientRect().bottom) * 10) / 10, kept: Number.parseFloat(getComputedStyle(host).marginBottom) };
    });
    check(at, pad.has ? Math.abs(pad.hangs - pad.kept) <= 1 : pad.kept === 0, `the player's pad hangs ${pad.hangs}px under its box (pad: ${pad.has}), the page keeps ${pad.kept}px`);
    report += `, pad ${pad.has ? pad.hangs : 'none'} in ${pad.kept}px kept`;
  }

  if (width === 390 || width === 1280) {
    const axe = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    const nodes = [...axe.passes, ...axe.violations, ...axe.incomplete].reduce((n, r) => n + r.nodes.length, 0);
    check(at, nodes >= AXE_FLOOR, `axe looked at ${nodes} nodes only`);
    check(at, axe.violations.length === 0, `axe at the top: ${axe.violations.map((v) => `${v.id} ${v.nodes[0]?.target.join(' ')}`).join(' | ')}`);
    report += `, axe 0 of ${nodes} nodes`;

    // The skin's own styles hold inside the page: a keycap and a heading compute as the skin sets them.
    const skin = await page.evaluate(() => {
      const cap = [...document.querySelectorAll('.media-skin kbd.fb-keycap')].find((k) => k.getClientRects().length);
      const head = document.querySelector('.media-skin h2');
      const style = (el) => el && getComputedStyle(el);
      return {
        cap: cap && { size: style(cap).fontSize, display: style(cap).display, family: style(cap).fontFamily, height: cap.getBoundingClientRect().height, clipped: cap.scrollHeight > cap.clientHeight + 1 },
        caps: document.querySelectorAll('.media-skin kbd.fb-keycap').length,
        head: head && style(head).fontFamily,
      };
    });
    check(at, skin.caps > 0, 'no keycap in the player to measure');
    check(at, !!skin.head, 'no heading in the player to measure');
    if (skin.cap) {
      check(at, skin.cap.size === '12px', `a keycap's font-size is ${skin.cap.size}, the skin sets 12px`);
      // inline-grid in the skin; a flex item computes it as grid.
      check(at, /grid$/.test(skin.cap.display), `a keycap's display is ${skin.cap.display}, the skin sets inline-grid`);
      check(at, !/Familjen|Book Display/.test(skin.cap.family), `a keycap is set in the page's face: ${skin.cap.family}`);
      check(at, skin.cap.height <= 20 && !skin.cap.clipped, `a keycap is ${skin.cap.height}px tall, clipped ${skin.cap.clipped}`);
      report += `, keycap ${skin.cap.size} ${skin.cap.display} ${skin.cap.height}px`;
    } else if (width === 1280) fail(at, 'no keycap on screen at 1280');
    if (skin.head) check(at, !/Familjen|Book Display/.test(skin.head), `a heading in the player is set in the page's face: ${skin.head}`);

    // A real click on the Play disc, then a real Space.
    await page.locator('.fb-cover-play').first().click();
    await playing(page).catch(() => fail(at, 'a click on the Play disc did not start the film'));
    await page.evaluate(() => document.querySelector('media-container').focus({ preventScroll: true }));
    await page.keyboard.press('Space');
    await page.waitForFunction(() => document.querySelector('video').paused, undefined, { timeout: 4000 }).catch(() => fail(at, 'Space did not pause'));
    await page.keyboard.press('Space');
    await page.waitForFunction(() => !document.querySelector('video').paused, undefined, { timeout: 4000 }).catch(() => fail(at, 'Space did not play again'));
    await page.keyboard.press('Space');
    report += ', click and Space play';
  }

  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  let worst = 0;
  for (let y = 0; y < height; y += 600) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(100);
    worst = Math.max(worst, await overflow(page));
  }
  check(at, worst === 0, `sideways scroll of ${worst}px somewhere down the page`);
  if (width === 390 || width === 1280) {
    const axe = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    check(at, axe.violations.length === 0, `axe at the foot: ${axe.violations.map((v) => `${v.id} ${v.nodes[0]?.target.join(' ')}`).join(' | ')}`);
  }
  check(at, errors.length === 0, `errors: ${errors.join(' | ')}`);
  console.log(`  ${width}: ${report}, errors ${errors.length}`);
  await context.close();
}

// A press, and a key, made while the page still stands on its poster.
for (const width of [390, 1280]) {
  for (const how of ['press', 'Space']) {
    const at = `${engine} ${width} early ${how}`;
    const { context, page, errors } = await open(width, { holdPlayer: 1500 });
    const host = page.locator('#player');
    check(at, (await page.locator('media-container').count()) === 0, 'the player was already there: the test pressed nothing early');
    if (how === 'press') {
      const box = await host.boundingBox();
      if (width < 500) await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      else await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    } else await page.keyboard.press('Space');
    check(at, (await page.locator('media-container').count()) === 0, 'the player arrived before the press: nothing early was tested');
    await playing(page).catch(() => fail(at, 'the film did not start once the player stood'));
    await page.waitForTimeout(1200);
    const state = await page.evaluate(() => ({ ...window.__site, paused: document.querySelector('video')?.paused, scrolled: scrollY }));
    check(at, state.plays === 1 && state.pauses === 0 && state.paused === false, `played ${state.plays} times, paused ${state.pauses}, paused now ${state.paused}`);
    check(at, state.scrolled === 0, `the page scrolled ${state.scrolled}px`);
    check(at, errors.length === 0, `errors: ${errors.join(' | ')}`);
    console.log(`  ${width} early ${how}: plays ${state.plays}, pauses ${state.pauses}, playing ${state.paused === false}`);
    await context.close();
  }
}

// Tab order from the top, a ring on every stop.
{
  const at = `${engine} 1280 keyboard`;
  const { context, page } = await open(1280);
  await mounted(page);
  await page.waitForTimeout(800);
  const stops = [];
  for (let i = 0; i < 9; i++) {
    await page.keyboard.press(engine === 'webkit' ? 'Alt+Tab' : 'Tab');
    stops.push(
      await page.evaluate(() => {
        const el = document.activeElement;
        // The skin draws some rings on the element's ::after (the player's own frame, a chapter tab).
        const drawn = (style) => (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== 'none';
        const ring = drawn(getComputedStyle(el)) || drawn(getComputedStyle(el, '::after'));
        return { name: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 24) || el.tagName, inPlayer: !!el.closest('.media-skin'), ring, visible: el.matches(':focus-visible') };
      }),
    );
  }
  const names = stops.map((s) => s.name);
  check(at, /Skip/.test(names[0]) && /Gua/.test(names[1]) && names[2] === 'Source' && names[3] === 'gua.studio', `the first stops are ${names.slice(0, 4).join(' > ')}`);
  check(at, stops.slice(4).every((s) => s.inPlayer), `after the masthead, focus is not in the player: ${names.slice(4).join(' > ')}`);
  check(at, stops.every((s) => s.ring && s.visible), `a stop without a ring: ${stops.filter((s) => !s.ring || !s.visible).map((s) => s.name).join(', ')}`);
  check(at, new Set(stops.slice(4).map((s) => s.name)).size === stops.length - 4, 'a stop was visited twice');
  console.log(`  keyboard: ${names.join(' > ')}`);
  await context.close();
}

// The page's fonts arriving late (their files held back, then let go): the page stands in fallback faces sized to
// them (book.css), so nothing under the masthead changes place and the hero's line keeps its lines. Firefox opened no
// fallback face while the face before it was loading, stood in plain Arial and Georgia, and moved 24 px under the
// hero on a phone when the fonts came (13 Nov 2026; the layout asks for the fallbacks by name).
for (const width of [390, 1280]) {
  const at = `${engine} ${width} late fonts`;
  const context = await browser.newContext({ viewport: { width, height: width < 500 ? 780 : 900 }, hasTouch: width < 500, isMobile: width < 500 && engine === 'chromium' });
  await quiet(context);
  const page = await context.newPage();
  let release;
  const held = new Promise((resolve) => (release = resolve));
  await page.route(/\.woff2(\?|$)/, async (route) => {
    await held;
    await route.fallback();
  });
  await page.goto(url, { waitUntil: 'commit' });
  await page.waitForSelector('#player', { state: 'attached', timeout: 20_000 });
  await page.waitForTimeout(1500);
  const places = () =>
    page.evaluate(() =>
      Object.fromEntries(
        ['#hero', '.hero-try', 'main > :nth-child(2)', 'main > :nth-child(3)'].map((selector) => {
          const el = document.querySelector(selector);
          let top = 0;
          for (let box = el; box; box = box.offsetParent) top += box.offsetTop;
          return [selector, { top, height: el.offsetHeight }];
        }),
      ),
    );
  const before = await places();
  release();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  const after = await places();
  const moved = Object.keys(before)
    .filter((selector) => Math.abs(before[selector].top - after[selector].top) > 4 || (selector === '.hero-try' && before[selector].height !== after[selector].height))
    .map((selector) => `${selector} top ${before[selector].top} → ${after[selector].top}, height ${before[selector].height} → ${after[selector].height}`);
  check(at, moved.length === 0, `moved when the fonts came: ${moved.join(' | ')}`);
  console.log(`  ${width} late fonts: the section under the hero at ${before['main > :nth-child(2)'].top} px, then ${after['main > :nth-child(2)'].top}`);
  await context.close();
}

// Reduced motion: nothing runs on its own.
for (const width of [390, 1280]) {
  const at = `${engine} ${width} reduced motion`;
  const { context, page, errors } = await open(width, { reduced: true });
  await mounted(page);
  await page.waitForTimeout(2500);
  const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length);
  const first = await page.screenshot();
  await page.waitForTimeout(800);
  const second = await page.screenshot();
  check(at, running === 0, `${running} animations running`);
  check(at, first.equals(second), 'two frames 800 ms apart differ');
  check(at, errors.length === 0, `errors: ${errors.join(' | ')}`);
  console.log(`  ${width} reduced motion: ${running} animations, frames ${first.equals(second) ? 'identical' : 'differ'}`);
  await context.close();
}

/* ─── Proof on the page ─────────────────────────────────────────────────── */

const audit = (name) => JSON.parse(readFileSync(new URL(`../design/previews/audit/${name}.json`, import.meta.url), 'utf8'));
const weights = audit('weights');
const measurements = audit('measurements');
const kB = (bytes, digits = 1) => (bytes / 1000).toFixed(digits);
/** A chunk of one of the book's extras, as the build names it (`_astro/deck.<hash>.js`). */
const EXTRA = new RegExp(`/_astro/(${Object.keys(weights.library.extras).join('|')})\\.[^/]+\\.js$`);
const film = (page) => page.evaluate(() => {
  const video = document.querySelector('video');
  return { time: video.currentTime, paused: video.paused, features: document.querySelector('video-player').getAttribute('features'), on: document.querySelector('media-container').getAttribute('data-fb-features') ?? '' };
});
const tab = engine === 'webkit' ? 'Alt+Tab' : 'Tab';

// The numbers the page prints are the files' numbers.
{
  const at = `${engine} 1280 numbers`;
  const { context, page } = await open(1280);
  const text = await page.evaluate(() => ({ holds: document.querySelector('#holds').innerText, preset: document.querySelector('[data-loads]').innerText, frames: [...document.querySelectorAll('[data-frame]')].map((b) => Number(b.dataset.frame)) }));
  const bright = measurements.contrast.flipbook.bright.time;
  const dark = measurements.contrast.flipbook.dark.time;
  const shipped = [measurements.contrast.flipbook, measurements.contrast['flipbook, 390 px']].flatMap((run) => [run.bright, run.dark]);
  const lowestText = Math.min(...shipped.flatMap((f) => ['text', 'large', 'captions'].map((k) => f[k]?.ratio).filter((r) => typeof r === 'number')));
  const expected = {
    'the core’s weight': `${kB(weights.library.core.total)} kB`,
    'the full book’s weight': `${kB(weights.library.book.total)} kB`,
    'the lowest text contrast': `${lowestText}:1`,
    'the smallest target': `${measurements.targets.minimum} px`,
    'axe’s nodes': measurements.axe.nodesChecked.toLocaleString('en-GB'),
    'the player’s Tab stops': String(Math.min(measurements.keyboard['playerStops.chromium'], measurements.keyboard['playerStops.webkit'])),
  };
  for (const [what, value] of Object.entries(expected)) check(at, text.holds.replace(/\s+/g, ' ').includes(value.replace(/ /g, ' ')) || text.holds.includes(value), `${what} (${value}) is not on the page`);
  check(at, text.preset.includes(kB(weights.library.core.total, 0)) && text.preset.includes(kB(weights.library.book.total, 0)), `the switch does not carry the two weights: ${text.preset.replace(/\s+/g, ' ')}`);
  check(at, text.frames.length === 2 && text.frames[0] === bright && text.frames[1] === dark, `the frame keys seek to ${text.frames.join(', ')}, the contrast spec measured ${bright} and ${dark}`);
  console.log(`  numbers: ${Object.values(expected).join(', ').replace(/ /g, ' ')}; frames ${text.frames.join(', ')}`);
  await context.close();
}

// The switch: one thing moves, the film keeps its place, and Essential fetches none of the book.
for (const width of [390, 1280]) {
  const at = `${engine} ${width} switch`;
  const { context, page, errors } = await open(width);
  await mounted(page);
  await page.waitForTimeout(600);
  const group = page.locator('[data-loads]');
  const essential = group.locator('[data-value="essential"]');
  const book = group.locator('[data-value="book"]');
  const sizes = await group.evaluate((el) => {
    const thumb = el.querySelector('.preset-thumb');
    return {
      keys: [...el.querySelectorAll('[role="radio"]')].map((k) => k.getBoundingClientRect()).map((r) => [Math.round(r.width), Math.round(r.height)]),
      duration: getComputedStyle(thumb).transitionDuration,
      property: getComputedStyle(thumb).transitionProperty,
      x: thumb.getBoundingClientRect().x,
      cursor: getComputedStyle(el.querySelector('[role="radio"]')).cursor,
    };
  });
  check(at, sizes.keys.every(([w, h]) => w >= 44 && h >= 44), `a key is under 44 px: ${JSON.stringify(sizes.keys)}`);
  const ms = Number.parseFloat(sizes.duration) * 1000;
  check(at, ms >= 150 && ms <= 250 && sizes.property === 'transform', `the thumb moves ${sizes.property} in ${sizes.duration}`);
  check(at, sizes.cursor === 'pointer', `the keys' cursor is ${sizes.cursor}`);

  await page.locator('.fb-cover-play').first().click();
  await playing(page).catch(() => fail(at, 'the film did not start'));
  const before = await film(page);
  await essential.click();
  await page.waitForFunction(() => document.querySelector('video-player').getAttribute('features') === 'essential');
  await page.waitForTimeout(700);
  const lean = await film(page);
  check(at, lean.features === 'essential' && lean.on === '', `Essential set features="${lean.features}", on: "${lean.on}"`);
  check(at, !lean.paused && lean.time > before.time && lean.time < before.time + 2.5, `playing ${before.time.toFixed(2)} became ${lean.paused ? 'paused' : 'playing'} ${lean.time.toFixed(2)}`);
  const moved = await group.evaluate((el) => ({ x: el.querySelector('.preset-thumb').getBoundingClientRect().x, checked: el.querySelector('[aria-checked="true"]').dataset.value, line: [...el.parentElement.querySelectorAll('.preset-line')].filter((l) => l.getClientRects().length).map((l) => l.dataset.for).join() }));
  check(at, moved.x < sizes.x - 20 && moved.checked === 'essential' && moved.line === 'essential', `thumb ${sizes.x} to ${moved.x}, checked ${moved.checked}, line shown: ${moved.line}`);
  check(at, new URL(page.url()).searchParams.get('features') === 'essential', `the address is ${page.url()}`);

  await page.evaluate(() => document.querySelector('video').pause());
  await page.waitForTimeout(300);
  const held = await film(page);
  await book.click();
  await page.waitForFunction(() => !document.querySelector('video-player').hasAttribute('features'));
  await page.waitForTimeout(700);
  const full = await film(page);
  check(at, full.paused && Math.abs(full.time - held.time) < 0.05, `paused at ${held.time.toFixed(2)} became ${full.paused ? 'paused' : 'playing'} at ${full.time.toFixed(2)}`);
  check(at, full.on.split(' ').length >= 10 && !new URL(page.url()).searchParams.has('features'), `Full book has on: "${full.on}", address ${page.url()}`);

  if (width === 1280) {
    // One Tab stop, the arrows inside, a ring on it.
    // (Tab comes round to it from the page's foot. Firefox does not come round: from its last stop Tab goes to the
    // browser's own toolbar, and with none, headless, stays. So there the walk is taken up from the top.)
    if (engine === 'firefox') {
      await page.evaluate(() => {
        document.body.tabIndex = -1;
        document.body.focus({ preventScroll: true });
        document.body.removeAttribute('tabindex');
      });
    }
    let reached = false;
    for (let i = 0; i < 60 && !reached; i++) {
      await page.keyboard.press(tab);
      reached = await page.evaluate(() => !!document.activeElement.closest('[data-loads]'));
    }
    const stop = await page.evaluate(() => ({ value: document.activeElement.dataset.value, checked: document.activeElement.getAttribute('aria-checked'), ring: getComputedStyle(document.activeElement).outlineStyle !== 'none' && document.activeElement.matches(':focus-visible') }));
    check(at, reached && stop.value === 'book' && stop.checked === 'true' && stop.ring, `Tab reached ${JSON.stringify(stop)}`);
    await page.keyboard.press('ArrowLeft');
    const left = await page.evaluate(() => ({ value: document.activeElement.dataset.value, checked: document.activeElement.getAttribute('aria-checked'), features: document.querySelector('video-player').getAttribute('features') }));
    check(at, left.value === 'essential' && left.checked === 'true' && left.features === 'essential', `ArrowLeft: ${JSON.stringify(left)}`);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press(tab);
    const out = await page.evaluate(() => ({ inGroup: !!document.activeElement.closest('[data-loads]'), features: document.querySelector('video-player').getAttribute('features') }));
    check(at, !out.inGroup && out.features === null, `after ArrowRight and Tab: ${JSON.stringify(out)}`);
  }
  check(at, errors.length === 0, `errors: ${errors.join(' | ')}`);
  console.log(`  ${width} switch: keys ${JSON.stringify(sizes.keys)}, thumb ${sizes.duration}, playing ${before.time.toFixed(2)} → ${lean.time.toFixed(2)} in Essential, paused ${held.time.toFixed(2)} → ${full.time.toFixed(2)} in Full book`);
  await context.close();
}

// Opened as Essential, the book's extras are not fetched; choosing Full book fetches them.
{
  const at = `${engine} 1280 essential network`;
  const { context, page, requests, errors } = await open(1280, { query: '?features=essential' });
  await mounted(page);
  await page.waitForTimeout(2500);
  const state = await film(page);
  const early = requests.filter((u) => EXTRA.test(u));
  check(at, state.features === 'essential' && state.on === '', `the player opened with features="${state.features}"`);
  check(at, early.length === 0, `Essential fetched ${early.map((u) => u.split('/').pop()).join(', ')}`);
  const shown = await page.evaluate(() => ({ checked: document.querySelector('[data-loads] [aria-checked="true"]').dataset.value, tabbable: document.querySelector('[data-loads] [tabindex="0"]').dataset.value }));
  check(at, shown.checked === 'essential' && shown.tabbable === 'essential', `the switch shows ${JSON.stringify(shown)}`);
  const scripts = requests.filter((u) => /\/_astro\/.+\.js$/.test(u)).length;
  await page.locator('[data-loads] [data-value="book"]').click();
  await page.waitForFunction(() => (document.querySelector('media-container').getAttribute('data-fb-loaded') ?? '').split(' ').length >= 10, undefined, { timeout: 15_000 }).catch(() => fail(at, 'the extras did not arrive after Full book'));
  const late = requests.filter((u) => EXTRA.test(u));
  check(at, late.length >= 10, `Full book fetched ${late.length} extras`);
  check(at, errors.length === 0, `errors: ${errors.join(' | ')}`);
  console.log(`  essential network: ${scripts} scripts and 0 extras as Essential; ${late.length} extras after Full book`);
  await context.close();
}

// The frame keys: the film paused on the measured frame, the player in view and focused.
for (const width of [390, 1280]) {
  const at = `${engine} ${width} frames`;
  const { context, page, errors } = await open(width);
  // With the plate's extra arrived (it prints the paused page's strip, and must never lay the plate itself out).
  await mounted(page);
  await page.waitForFunction(() => (document.querySelector('media-container').getAttribute('data-fb-loaded') ?? '').split(' ').includes('plate'), undefined, { timeout: 15_000 }).catch(() => fail(at, 'the plate never arrived'));
  const report = [];
  for (const key of await page.locator('[data-frame]').all()) {
    await key.scrollIntoViewIfNeeded();
    const box = await key.boundingBox();
    check(at, box.height >= 44 && box.width >= 44, `a frame key is ${Math.round(box.width)} × ${Math.round(box.height)}`);
    const time = Number(await key.getAttribute('data-frame'));
    await key.click();
    await page.waitForFunction((t) => {
      const video = document.querySelector('media-container video');
      return !!video && video.paused && !video.seeking && Math.abs(video.currentTime - t) < 0.02;
    }, time, { timeout: 15_000 }).catch(() => fail(at, `the film did not come to rest on ${time}`));
    // Well past the 1.1 s after which the plate once laid itself over a paused frame: it must not.
    await page.waitForTimeout(1800);
    const seen = await page.evaluate(() => {
      const host = document.querySelector('#player');
      const r = host.getBoundingClientRect();
      return { time: document.querySelector('video')?.currentTime, inView: r.top >= 0 && r.top < innerHeight / 2, focused: document.activeElement === host || host.contains(document.activeElement), plate: document.querySelector('media-container').hasAttribute('data-fb-plate') };
    });
    check(at, seen.inView && seen.focused, `after the key: ${JSON.stringify(seen)}`);
    check(at, !seen.plate, 'the plate lies over the frame the key shows');
    report.push(`${time} → ${seen.time?.toFixed(2)}`);
  }
  check(at, report.length === 2, `${report.length} frame keys`);
  check(at, errors.length === 0, `errors: ${errors.join(' | ')}`);
  console.log(`  ${width} frames: ${report.join(', ')}`);
  await context.close();
}

// Your settings: what the browser reports, and a change followed live.
{
  const at = `${engine} settings`;
  const read = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-pref]')].map((row) => [row.dataset.pref, `${row.querySelector('[data-pref-value]').textContent}${row.hasAttribute('data-set') ? '*' : ''}`])));
  const plain = await open(1280);
  await plain.page.waitForTimeout(400);
  const a = await read(plain.page);
  check(at, a.motion === 'no preference' && a.forced === 'none' && a.pointer === 'mouse or trackpad' && a.scheme === 'dark', `a plain desktop reads ${JSON.stringify(a)}`);
  await plain.page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
  await plain.page.waitForTimeout(300);
  const b = await read(plain.page);
  check(at, b.motion === 'reduce*' && b.scheme === 'light', `after the system changed: ${JSON.stringify(b)}`);
  await plain.context.close();
  const phone = await open(390, { reduced: true, forced: engine === 'chromium' ? 'active' : 'none' });
  await phone.page.waitForTimeout(400);
  const c = await read(phone.page);
  check(at, c.motion === 'reduce*' && (engine !== 'chromium' || (c.forced === 'active*' && c.pointer === 'finger*')), `a phone with reduced motion reads ${JSON.stringify(c)}`);
  await phone.context.close();
  console.log(`  settings: ${JSON.stringify(a)} | changed ${JSON.stringify(b)} | phone ${JSON.stringify(c)}`);
}

// The stills: none fetched before they are near, and each one sized, described and loading.
for (const width of [390, 1280]) {
  const at = `${engine} ${width} stills`;
  const { context, page, requests, errors } = await open(width);
  await mounted(page);
  await page.waitForTimeout(1200);
  const early = requests.filter((u) => u.includes('/book/states/'));
  check(at, early.length === 0, `${early.length} stills fetched at the top of the page`);
  await page.locator('#states-title').scrollIntoViewIfNeeded();
  const list = page.locator('[data-states]');
  for (const item of await list.locator('li').all()) await item.scrollIntoViewIfNeeded();
  await page.locator('[data-frame]').first().scrollIntoViewIfNeeded();
  await page.waitForFunction(() => [...document.querySelectorAll('#holds img')].every((img) => img.complete), undefined, { timeout: 15_000 }).catch(() => {});
  const stills = await page.evaluate(() => [...document.querySelectorAll('#holds img')].map((img) => ({ src: img.currentSrc.split('/').pop(), ok: img.complete && img.naturalWidth > 0, sized: img.width > 0 && img.height > 0 && img.hasAttribute('width') && img.hasAttribute('height'), lazy: img.loading === 'lazy', alt: img.alt, inState: !!img.closest('.state') })));
  check(at, stills.length === 13, `${stills.length} stills on the page`);
  check(at, stills.every((s) => s.ok && s.sized && s.lazy), `a still is broken, unsized or eager: ${stills.filter((s) => !s.ok || !s.sized || !s.lazy).map((s) => s.src).join(', ')}`);
  check(at, stills.filter((s) => s.inState).every((s) => s.alt.length > 20), 'a state has no description');
  const strip = await list.evaluate((el) => ({ scrolls: el.scrollWidth > el.clientWidth + 1, tabindex: el.getAttribute('tabindex'), page: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
  check(at, strip.page === 0 && (width < 700 ? strip.scrolls && strip.tabindex === '0' : !strip.scrolls && strip.tabindex === null), `the sheet: ${JSON.stringify(strip)}`);
  // Type floors in the new blocks: 16 px for text, 12 px for mono labels.
  const small = await page.evaluate(() =>
    [...document.querySelectorAll('.hero-foot *, #holds *')]
      .filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && el.getClientRects().length)
      .map((el) => ({ el: el.className || el.tagName, size: Number.parseFloat(getComputedStyle(el).fontSize), mono: /mono|Menlo/i.test(getComputedStyle(el).fontFamily) }))
      .filter((t) => t.size < (t.mono ? 12 : 16)),
  );
  check(at, small.length === 0, `text under the floor: ${small.map((t) => `${t.el} ${t.size}`).join(', ')}`);
  check(at, errors.length === 0, `errors: ${errors.join(' | ')}`);
  console.log(`  ${width} stills: ${stills.length} lazy, sized and loaded (${stills.filter((s) => /avif$/.test(s.src)).length} as AVIF); sheet ${strip.scrolls ? 'a strip, one Tab stop' : 'a grid'}`);
  await context.close();
}

await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED\n${failures.join('\n')}` : '\nall passed');
process.exit(failures.length ? 1 : 0);
