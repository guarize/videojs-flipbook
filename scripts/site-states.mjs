/**
 * The stills of the player's states for the site's "Every state" sheet, and the two frames its contrast was measured
 * over, taken from the site's own production build (`pnpm site:build`, `pnpm site:preview`): the real player in the
 * hero, driven with real keys and a real pointer, one fresh page per state.
 *
 * Writes `apps/preview/public/book/states/<id>-<width>.{avif,webp}` (the site's public folder) at 1× and 2× of the
 * sheet's largest cell, and `manifest.json` with each still's dimensions, which the page reads at build time
 * (apps/site/src/lib/stills.ts). The stills are tracked, so a fresh clone builds; run this again whenever the player's
 * look changes. The page's sheet is not involved: any build of the site will do.
 *
 * Usage: `node scripts/site-states.mjs [url] [--only id,id] [--keep]` (needs cwebp and avifenc on the PATH).
 * The raw PNGs are intermediates and never go under the site's public folder: they are written to
 * `design/previews/states-raw/` (git-ignored) and removed at the end; `--keep` leaves them there to look at. One browser, muted, every context silenced
 * (scripts/quiet.mjs, over test-fixtures/silence.mjs); every film is muted before it can play.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { quiet } from './quiet.mjs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');

const args = process.argv.slice(2);
const url = args.find((a) => /^https?:/.test(a)) ?? 'http://127.0.0.1:4403/';
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
const keep = args.includes('--keep');
const out = fileURLToPath(new URL('../apps/preview/public/book/states/', import.meta.url));
const raw = fileURLToPath(new URL('../design/previews/states-raw/', import.meta.url));
mkdirSync(raw, { recursive: true });
// An older run's intermediates, from when they were kept beside the stills: never left where a deploy would take them.
rmSync(`${out}raw/`, { recursive: true, force: true });

/** The player's width for the stills, CSS px: wide enough for every key's name, small enough to read in a cell. */
const PLAYER = 640;
/** The paused page is taken wider: its strip of frames stands in the foot from about 840 px (plate.ts). */
const PAGE = 960;
/** The phone the Settings sheet is taken on. */
const PHONE = { width: 390, height: 700 };
/** The moments of the film used: a page of the gallop for the paused states, and a caption's middle for the intertitle. */
const PAUSE_AT = 20.4;
const CAPTION_AT = 28.5;
const run = (cmd, argv) => execFileSync(cmd, argv, { stdio: ['ignore', 'ignore', 'inherit'] });

const browser = await chromium.launch({ args: ['--mute-audio'] });

async function open({ phone = false, storage = {}, block = null, width = PLAYER, scale = 2 } = {}) {
  const context = await browser.newContext({
    viewport: phone ? PHONE : { width: Math.max(1280, width + 240), height: Math.max(800, Math.round((width * 9) / 16) + 320) },
    deviceScaleFactor: scale,
    hasTouch: phone,
    isMobile: phone,
    reducedMotion: 'no-preference',
  });
  await quiet(context);
  const page = await context.newPage();
  await page.addInitScript((saved) => {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      this.muted = true;
      return play.call(this);
    };
    for (const [key, value] of Object.entries(saved)) localStorage.setItem(key, value);
  }, storage);
  // The refusal comes two seconds in, as from a slow server: the player stands by then. (An error that arrives while
  // the player is still mounting is not always shown: seen in 3 of 4 loads, 10 Nov.)
  if (block) {
    await page.route(block, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await route.fulfill({ status: 404, body: '' });
    });
  }
  await page.goto(url, { waitUntil: 'load' });
  // The player at the stills' width, whatever the hero's layout would give it.
  if (!phone) await page.addStyleTag({ content: `.hero { --player-w: ${width}px !important; } .hero-leaves { visibility: hidden; }` });
  await page.waitForSelector('media-container', { state: 'attached', timeout: 20_000 });
  if (!block) await page.waitForSelector('media-container fb-edge[data-ready]', { state: 'attached', timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(900);
  return { context, page };
}

const video = (page, fn, arg) => page.evaluate(([source, value]) => new Function('video', 'value', `return (${source})(video, value)`)(document.querySelector('video'), value), [fn.toString(), arg]);
const box = (page) => page.locator('#player').boundingBox();
const centre = async (page) => {
  const b = await box(page);
  return [b.x + b.width / 2, b.y + b.height * 0.4];
};
const hover = async (page) => page.mouse.move(...(await centre(page)));
const away = (page) => page.mouse.move(4, 4);

/** Starts the film with a real click on the Play disc and lets it run a moment. */
async function play(page) {
  await page.locator('.fb-cover-play').first().click();
  await page.waitForFunction(() => {
    const v = document.querySelector('video');
    return !!v && !v.paused && v.currentTime > 0.6;
  });
}

/** Seeks from script and waits for the new frame to be on screen. */
async function seek(page, time) {
  await page.evaluate(
    (t) =>
      new Promise((resolve) => {
        const v = document.querySelector('video');
        v.addEventListener('seeked', () => requestAnimationFrame(() => requestAnimationFrame(resolve)), { once: true });
        v.currentTime = t;
      }),
    time,
  );
}

/** Paused on a chosen moment: the print shows, with its strip of frames read where the page has room for one. */
async function pausedAt(page, time) {
  await play(page);
  await hover(page);
  await video(page, (v) => v.pause());
  await seek(page, time);
  await page.waitForSelector('media-container[data-fb-print]', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);
  if (await page.locator('fb-plate[data-strip]').count()) {
    await page.waitForFunction(() => document.querySelectorAll('.fb-strip-cell[data-ready]').length === 12, undefined, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(300);
  }
}

async function shot(page, id, { viewport = false } = {}) {
  const path = `${raw}${id}.png`;
  if (viewport) await page.screenshot({ path });
  else await page.locator('#player').screenshot({ path });
  return path;
}

/** Each state: how to reach it. `tall` is the phone's screen; the rest are the player's own box. */
const STATES = {
  cover: async () => {
    const { context, page } = await open();
    await page.waitForSelector('media-container[data-fb-loaded~="cover"]', { timeout: 10_000 });
    await away(page);
    await page.waitForTimeout(600);
    return { context, page };
  },
  playing: async () => {
    const { context, page } = await open();
    await play(page);
    await seek(page, 3.6);
    await hover(page);
    await page.waitForTimeout(700);
    return { context, page };
  },
  paused: async () => {
    const { context, page } = await open({ width: PAGE });
    await pausedAt(page, PAUSE_AT);
    if (!(await page.locator('fb-plate[data-strip]').count())) throw new Error('the paused still has no strip');
    return { context, page };
  },
  'edge-drag': async () => {
    const { context, page } = await open();
    await play(page);
    await seek(page, 24);
    const edge = await page.locator('media-time-slider').first().boundingBox();
    const y = edge.y + edge.height / 2;
    const x0 = edge.x + edge.width * 0.4;
    await page.mouse.move(x0, y);
    await page.mouse.down();
    // A steady hand, about twice the film's own speed, still moving when the still is taken.
    for (let i = 1; i <= 24; i++) {
      await page.mouse.move(x0 + i * 0.9, y);
      await page.waitForTimeout(32);
    }
    return { context, page, after: () => page.mouse.up() };
  },
  contents: async () => {
    const { context, page } = await open();
    await pausedAt(page, PAUSE_AT);
    await page.keyboard.press('t');
    await page.waitForTimeout(1400);
    return { context, page };
  },
  intertitle: async () => {
    const { context, page } = await open({ storage: { 'fb-caption-style': JSON.stringify({ mode: 'intertitle' }) } });
    await pausedAt(page, CAPTION_AT);
    await page.keyboard.press('c');
    await page.waitForSelector('media-container[data-fb-intertitle]', { timeout: 6000 });
    // The "Captions on" slip over the top keys has gone by then.
    await page.waitForTimeout(3200);
    return { context, page };
  },
  'dog-ear': async () => {
    const { context, page } = await open();
    await pausedAt(page, PAUSE_AT);
    await page.keyboard.press('b');
    await page.waitForTimeout(800);
    return { context, page };
  },
  'torn-page': async () => {
    const { context, page } = await open();
    await pausedAt(page, PAUSE_AT);
    page.on('download', (download) => void download.cancel().catch(() => {}));
    await page.keyboard.press('s');
    await page.waitForTimeout(700);
    return { context, page };
  },
  'missing-page': async () => {
    const { context, page } = await open({ block: /film-720\.mp4|\.m3u8/ });
    await page.waitForSelector('media-error-dialog[data-open]', { state: 'attached', timeout: 10_000 });
    await page.waitForTimeout(1200);
    return { context, page };
  },
  'back-cover': async () => {
    const { context, page } = await open();
    await play(page);
    await video(page, (v) => (v.currentTime = v.duration - 0.4));
    await page.waitForFunction(() => document.querySelector('video').ended, undefined, { timeout: 8000 });
    await away(page);
    await page.waitForTimeout(2200);
    return { context, page };
  },
  'phone-sheet': async () => {
    const { context, page } = await open({ phone: true });
    await page.locator('#player').evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + scrollY));
    await page.waitForTimeout(300);
    await page.locator('.fb-cover-play').first().tap();
    await page.waitForFunction(() => document.querySelector('video').currentTime > 0.6);
    // The film goes on playing behind the sheet.
    await seek(page, 2.2);
    await page.locator('#flipbook-settings-trigger').tap();
    await page.waitForTimeout(900);
    return { context, page, viewport: true };
  },
  // The two frames themselves, drawn from the film as the player holds it: no controls, only the picture.
  'frame-bright': async (times) => {
    const { context, page } = await open();
    await pausedAt(page, times.bright);
    return { context, page, frame: true };
  },
  'frame-dark': async (times) => {
    const { context, page } = await open();
    await pausedAt(page, times.dark);
    return { context, page, frame: true };
  },
};

/** The two frames, from the contrast spec's own record. */
const measurements = JSON.parse(readFileSync(fileURLToPath(new URL('../design/previews/audit/measurements.json', import.meta.url)), 'utf8'));
const times = { bright: measurements.contrast.flipbook.bright.time, dark: measurements.contrast.flipbook.dark.time };
if (![times.bright, times.dark].every(Number.isFinite)) throw new Error('measurements.json has no bright and dark frame times');

const manifestPath = `${out}manifest.json`;
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { stills: {} };
manifest.stills ??= {};

for (const [id, reach] of Object.entries(STATES)) {
  if (only && !only.includes(id)) continue;
  const { context, page, after, viewport, frame } = await reach(times);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let png = `${raw}${id}.png`;
  if (frame) {
    const data = await page.evaluate(() => {
      const film = document.querySelector('video');
      const canvas = Object.assign(document.createElement('canvas'), { width: film.videoWidth, height: film.videoHeight });
      canvas.getContext('2d').drawImage(film, 0, 0);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    writeFileSync(png, Buffer.from(data, 'base64'));
  } else png = await shot(page, id, { viewport });
  await after?.();
  await context.close();

  // 2× and 1× of the sheet's largest cell (about 400 CSS px); a phone's screen is shown about 400 px wide too.
  const full = Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width', '-of', 'csv=p=0', png]).toString().trim());
  const high = Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height', '-of', 'csv=p=0', png]).toString().trim());
  const widths = [400, 800];
  const sizes = [];
  for (const width of widths) {
    const scaled = `${raw}${id}-${width}.png`;
    run('ffmpeg', ['-v', 'error', '-y', '-i', png, '-vf', `scale=${width}:-2:flags=lanczos`, '-frames:v', '1', scaled]);
    run('avifenc', ['-q', '58', '-s', '3', '-y', '420', scaled, `${out}${id}-${width}.avif`]);
    run('cwebp', ['-quiet', '-q', '76', '-m', '6', scaled, '-o', `${out}${id}-${width}.webp`]);
    sizes.push(`${width}: avif ${(statSync(`${out}${id}-${width}.avif`).size / 1000).toFixed(1)} kB, webp ${(statSync(`${out}${id}-${width}.webp`).size / 1000).toFixed(1)} kB`);
  }
  manifest.stills[id] = { width: 800, height: Math.round((800 * high) / full / 2) * 2, widths };
  manifest.taken = new Date().toISOString();
  manifest.from = url;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${id}: ${full}×${high} → ${sizes.join('; ')}${errors.length ? `  ERRORS ${errors.join(' | ')}` : ''}`);
}

// The player as the Fore-edge and Picture-in-picture chapters show it: paused at 0:20, at the widest the page's hero
// makes it (1160 px), taken at two to the pixel and written 1200 px wide (book/player-20.webp).
if (!only || only.includes('player-20')) {
  const { context, page } = await open({ width: 1160, scale: 2 });
  await pausedAt(page, 20);
  await away(page);
  await hover(page);
  await page.waitForTimeout(300);
  const png = await shot(page, 'player-20');
  // Where the page's foot ends: under the strip of frames, with the page's own margin below it.
  const foot = await page.evaluate(() => {
    const player = document.querySelector('#player').getBoundingClientRect();
    const row = document.querySelector('fb-plate[data-strip] .fb-strip-window')?.getBoundingClientRect();
    return row ? (row.bottom - player.top + 16) / player.height : null;
  });
  await context.close();
  const file = fileURLToPath(new URL('../apps/preview/public/book/player-20.webp', import.meta.url));
  run('ffmpeg', ['-v', 'error', '-y', '-i', png, '-vf', 'scale=1200:676:flags=lanczos', '-frames:v', '1', `${raw}player-20-1200.png`]);
  run('cwebp', ['-quiet', '-q', '82', '-m', '6', `${raw}player-20-1200.png`, '-o', file]);
  console.log(`player-20: webp ${(statSync(file).size / 1000).toFixed(1)} kB`);

  // The same paused player down to its strip, for the Plate chapter (book/plate-page.webp): the frame set as a page
  // and the twelve frames in its foot, without the slab. The page reads its size from the manifest.
  if (foot == null) throw new Error('the paused player has no strip: the Plate chapter has nothing to show');
  const width = 1520;
  const page20 = fileURLToPath(new URL('../apps/preview/public/book/plate-page.webp', import.meta.url));
  run('ffmpeg', ['-v', 'error', '-y', '-i', png, '-vf', `crop=iw:ih*${foot.toFixed(5)}:0:0,scale=${width}:-2:flags=lanczos`, '-frames:v', '1', `${raw}plate-page.png`]);
  const height = Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height', '-of', 'csv=p=0', `${raw}plate-page.png`]).toString().trim());
  run('cwebp', ['-quiet', '-q', '82', '-m', '6', `${raw}plate-page.png`, '-o', page20]);
  manifest.plate = { width, height };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`plate-page: ${width}×${height}, webp ${(statSync(page20).size / 1000).toFixed(1)} kB`);
}

if (!keep) rmSync(raw, { recursive: true, force: true });
await browser.close();
