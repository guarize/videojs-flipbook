/**
 * Flipbook's weights and speed, essential against the full book, written to design/previews/audit/weights.json.
 *
 *   pnpm run build && pnpm run build:lib
 *   pnpm exec vite preview --host 127.0.0.1 --port 4410 --strictPort &   # the production build, as the e2e uses it
 *   node scripts/weights.mjs
 *
 * Weights are gzip -9 of the built files: the drop-in bundle (dist-lib: flipbook.js and flipbook.css are the core,
 * Video.js 10 included; each extra is its chunk beside them, its CSS inside it as a string), and what the showcase
 * actually fetched under each preset (dist, read back from the requests a real page made).
 *
 * Speed is measured in Chromium with Playwright (no Lighthouse here): five loads of the showcase per preset and
 * profile, the median kept. FCP and LCP from the paint entries; time to interactive as Lighthouse defines it, from
 * the long tasks and the requests (the first 5 s window after FCP with no long task and at most two requests in
 * flight, the film's own range requests left out), and `ttiCpu`, the same on the main thread alone; the player's
 * readiness as the moment its fore-edge has its pages.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { chromium } from '@playwright/test';
import { silence } from '../tests/e2e/support/silence.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const BASE = process.env.BASE ?? 'http://127.0.0.1:4410';
const RUNS = Number(process.env.RUNS ?? 5);
const FEATURES = ['turns', 'deck', 'contents', 'ribbons', 'plate', 'curl', 'cover', 'pip', 'hints', 'next', 'float', 'ear', 'tear', 'intertitle'];
/** Chunks more than one extra shares, and the details (details.ts): fetched by the full book, never by the core alone. */
const SHARED = ['paper', 'marks', 'details'];
/** The drop-in bundle before the split (HEAD at 79efba1 with the working tree of 9 Nov, measured the same way). */
const BEFORE = { js: 128006, css: 22757 };

const gz = (buffer) => gzipSync(buffer, { level: 9 }).length;
const kib = (bytes) => Math.round((bytes / 1024) * 10) / 10;
const median = (values) => {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]) : null;
};

/** The CSS an extra's chunk carries: its string literals that are stylesheets. */
function inlineCss(source) {
  let bytes = 0;
  for (const match of source.matchAll(/"((?:[^"\\]|\\.)*@layer[^"\\]*(?:[^"\\]|\\.)*)"/g)) bytes += gz(Buffer.from(JSON.parse(`"${match[1]}"`)));
  for (const match of source.matchAll(/`([^`]*@layer[^`]*)`/g)) bytes += gz(Buffer.from(match[1]));
  return bytes;
}

function libraryWeights() {
  const dir = join(ROOT, 'dist-lib');
  const files = readdirSync(dir);
  const read = (file) => readFileSync(join(dir, file));
  const core = { js: gz(read('flipbook.js')), css: gz(read('flipbook.css')) };
  const chunk = (name) => files.find((file) => new RegExp(`^${name}-[\\w-]+\\.js$`).test(file));
  const extras = {};
  for (const name of [...FEATURES, ...SHARED]) {
    const file = chunk(name);
    if (!file) continue;
    const source = read(file);
    extras[name] = { file, gzip: gz(source), css: inlineCss(source.toString()) };
  }
  const all = Object.values(extras).reduce((n, e) => n + e.gzip, 0);
  return {
    core: { ...core, total: core.js + core.css, kib: { js: kib(core.js), css: kib(core.css) } },
    extras,
    book: { total: core.js + core.css + all, extras: all, kib: kib(core.js + core.css + all) },
    before: { ...BEFORE, kib: { js: kib(BEFORE.js), css: kib(BEFORE.css) } },
  };
}

/** What a page fetched of the app's own scripts and styles, by preset, gzip -9 from dist. */
async function showcaseWeights(browser) {
  const out = {};
  for (const preset of ['essential', 'book']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await silence(context);
    const page = await context.newPage();
    const asked = new Set();
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.origin === new URL(BASE).origin && /\.(js|css)$/.test(url.pathname)) asked.add(url.pathname);
    });
    await page.goto(`${BASE}/?features=${preset}`);
    await page.waitForSelector('fb-edge[data-ready]', { state: 'attached' });
    await page.waitForTimeout(6000);
    let js = 0;
    let css = 0;
    const extras = [];
    for (const path of asked) {
      const size = gz(readFileSync(join(ROOT, 'dist', path)));
      if (path.endsWith('.css')) css += size;
      else js += size;
      const name = /\/assets\/([a-z]+)-[\w-]+\.js$/.exec(path)?.[1];
      if (name && [...FEATURES, ...SHARED].includes(name)) extras.push(name);
    }
    out[preset] = { requests: asked.size, js, css, kib: { js: kib(js), css: kib(css) }, extras: extras.sort() };
    await context.close();
  }
  return out;
}

const PROFILES = {
  // Lighthouse's desktop: a fast connection, the CPU as it is.
  desktop: { latency: 40, down: (10 * 1024 * 1024) / 8, up: (10 * 1024 * 1024) / 8, cpu: 1 },
  // Lighthouse's mobile: slow 4G and a CPU four times slower.
  mobile: { latency: 150, down: (1.6 * 1024 * 1024) / 8, up: (750 * 1024) / 8, cpu: 4 },
};

async function speedOnce(browser, preset, profile) {
  const context = await browser.newContext({ viewport: profile === 'mobile' ? { width: 412, height: 823 } : { width: 1280, height: 800 } });
  await silence(context);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const p = PROFILES[profile];
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: p.latency, downloadThroughput: p.down, uploadThroughput: p.up });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: p.cpu });
  await page.addInitScript(() => {
    const w = window;
    w.__perf = { long: [], lcp: 0, ready: 0 };
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__perf.long.push([e.startTime, e.startTime + e.duration]);
    }).observe({ type: 'longtask', buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__perf.lcp = e.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    const watch = new MutationObserver(() => {
      if (!w.__perf.ready && document.querySelector('fb-edge[data-ready]')) w.__perf.ready = performance.now();
    });
    watch.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-ready'] });
  });
  await page.goto(`${BASE}/?features=${preset}`, { waitUntil: 'load', timeout: 90_000 });
  await page.waitForTimeout(profile === 'mobile' ? 16_000 : 10_000);
  const result = await page.evaluate(() => {
    const w = window;
    const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? 0;
    const requests = performance
      .getEntriesByType('resource')
      .filter((r) => !/\.(mp4|webm|m3u8)(\?|$)/.test(r.name))
      .map((r) => [r.startTime, r.responseEnd || r.startTime]);
    const long = w.__perf.long.sort((a, b) => a[0] - b[0]);
    const inFlight = (from, to) => {
      // The most requests in flight at any moment of [from, to].
      const marks = [];
      for (const [s, e] of requests) if (e > from && s < to) marks.push([Math.max(s, from), 1], [Math.min(e, to), -1]);
      marks.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let n = 0;
      let most = 0;
      for (const [, d] of marks) most = Math.max(most, (n += d));
      return most;
    };
    let tti = fcp;
    for (;;) {
      const next = long.find(([s]) => s >= tti);
      const end = next ? next[0] : performance.now();
      if (end - tti >= 5000 && inFlight(tti, tti + 5000) <= 2) break;
      if (!next) {
        // No long task left, but the network wasn't quiet yet: move on to the end of the next request.
        const later = requests.map(([, e]) => e).filter((e) => e > tti).sort((a, b) => a - b)[0];
        if (!later || later + 5000 > performance.now()) break;
        tti = later;
        continue;
      }
      tti = next[1];
    }
    // The main thread alone: the end of the last long task before 5 s without one (the network left out, since the
    // core's own fore-edge painting keeps fetching frames for a while on any preset).
    let cpu = fcp;
    for (const [s, e] of long) {
      if (s - cpu >= 5000) break;
      if (e > cpu) cpu = e;
    }
    const tbt = long.filter(([s]) => s >= fcp && s < tti).reduce((n, [s, e]) => n + Math.max(0, e - s - 50), 0);
    const extras = document.querySelector('media-container')?.getAttribute('data-fb-loaded') ?? '';
    return { fcp, lcp: w.__perf.lcp, tti, ttiCpu: cpu, tbt, ready: w.__perf.ready, longTasks: long.length, extras };
  });
  await context.close();
  return result;
}

async function speed(browser) {
  const out = {};
  for (const profile of Object.keys(PROFILES)) {
    out[profile] = {};
    for (const preset of ['essential', 'book']) {
      const runs = [];
      for (let i = 0; i < RUNS; i++) runs.push(await speedOnce(browser, preset, profile));
      const pick = (key) => median(runs.map((r) => r[key]));
      out[profile][preset] = { fcp: pick('fcp'), lcp: pick('lcp'), tti: pick('tti'), ttiCpu: pick('ttiCpu'), tbt: pick('tbt'), playerReady: pick('ready'), longTasks: pick('longTasks'), runs: runs.length, extrasLoaded: runs.at(-1)?.extras };
      console.log(profile, preset, JSON.stringify(out[profile][preset]));
    }
  }
  return out;
}

const browser = await chromium.launch({ args: ['--mute-audio'] });
const library = libraryWeights();
const showcase = await showcaseWeights(browser);
const timing = await speed(browser);
await browser.close();

const report = {
  measured: new Date().toISOString(),
  how: 'node scripts/weights.mjs, on the production builds (dist, dist-lib); gzip -9; Chromium via Playwright, median of RUNS loads',
  units: 'bytes (gzip -9) and ms',
  library,
  showcase,
  speed: timing,
};
writeFileSync(join(ROOT, 'design/previews/audit/weights.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ library: { core: library.core, book: library.book, before: library.before }, showcase }, null, 2));
