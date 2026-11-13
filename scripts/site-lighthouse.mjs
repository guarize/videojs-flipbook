/**
 * Lighthouse on the site's production build (`pnpm site:build`, `pnpm site:preview`): the phone preset (slow 4G, a
 * processor four times slower) RUNS times and the desktop preset once, medians written to
 * `design/previews/audit/site-lighthouse.json`. The page prints its performance line from that file at build time
 * (apps/site/src/lib/measured.ts), so measure, then build again. Without the file the page leaves the line out.
 *
 * Usage: `node scripts/site-lighthouse.mjs [url] [--check]`. `--check` measures and prints without writing, and exits
 * 1 over the budgets (LCP 2.5 s, TBT 200 ms, CLS 0.001 on the phone preset). Run it alone on a quiet machine: one browser
 * at a time, and never two Lighthouse runs at once. Chrome is headless and muted.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, loadavg } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const url = args.find((a) => /^https?:/.test(a)) ?? 'http://127.0.0.1:4403/';
const check = args.includes('--check');
const RUNS = 3;
const VERSION = '12.8.2';
/** CLS under 0.001 is a sub-pixel settling (Lighthouse prints it as 0); the site's guard draws the same line. */
const BUDGET = { lcp: 2500, tbt: 200, cls: 0.001 };
const dir = mkdtempSync(join(tmpdir(), 'site-lighthouse-'));

function once(preset, n) {
  const out = join(dir, `${preset}-${n}.json`);
  const flags = ['--yes', `lighthouse@${VERSION}`, url, '--quiet', '--chrome-flags=--headless=new --mute-audio', '--only-categories=performance,accessibility,best-practices', '--output=json', `--output-path=${out}`];
  if (preset === 'desktop') flags.push('--preset=desktop');
  execFileSync('npx', flags, { stdio: ['ignore', 'ignore', 'inherit'] });
  const report = JSON.parse(readFileSync(out, 'utf8'));
  const audit = (id) => report.audits[id].numericValue;
  const run = {
    performance: Math.round(report.categories.performance.score * 100),
    accessibility: Math.round(report.categories.accessibility.score * 100),
    bestPractices: Math.round(report.categories['best-practices'].score * 100),
    fcp: Math.round(audit('first-contentful-paint')),
    lcp: Math.round(audit('largest-contentful-paint')),
    tbt: Math.round(audit('total-blocking-time')),
    cls: Number(audit('cumulative-layout-shift').toFixed(4)),
    load: Number(loadavg()[0].toFixed(1)),
  };
  console.log(`${preset} ${n}: ${JSON.stringify(run)}`);
  return run;
}

const median = (runs, key) => [...runs].map((r) => r[key]).sort((a, b) => a - b)[Math.floor(runs.length / 2)];
const summary = (runs) => Object.fromEntries(['performance', 'accessibility', 'bestPractices', 'fcp', 'lcp', 'tbt', 'cls'].map((key) => [key, median(runs, key)]));

const mobileRuns = Array.from({ length: RUNS }, (_, i) => once('mobile', i + 1));
const desktopRuns = [once('desktop', 1)];
const result = {
  measured: new Date().toISOString(),
  how: `node scripts/site-lighthouse.mjs, Lighthouse ${VERSION} on the site's production build; the phone preset is the median of ${RUNS} runs (simulated slow 4G, CPU 4x slower), the desktop preset one run; ms, and CLS as a score`,
  url,
  runs: RUNS,
  mobile: { ...summary(mobileRuns), all: mobileRuns },
  desktop: { ...summary(desktopRuns), all: desktopRuns },
};
rmSync(dir, { recursive: true, force: true });

console.log(`\nphone (median of ${RUNS}): ${JSON.stringify(summary(mobileRuns))}\ndesktop: ${JSON.stringify(summary(desktopRuns))}`);
const over = Object.entries(BUDGET).filter(([key, limit]) => (key === 'cls' ? result.mobile[key] >= limit : result.mobile[key] > limit));
if (over.length) console.log(`OVER BUDGET on the phone preset: ${over.map(([key, limit]) => `${key} ${result.mobile[key]} > ${limit}`).join(', ')}`);
if (!check) {
  const file = fileURLToPath(new URL('../design/previews/audit/site-lighthouse.json', import.meta.url));
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`written: ${file}`);
}
process.exit(over.length ? 1 : 0);
