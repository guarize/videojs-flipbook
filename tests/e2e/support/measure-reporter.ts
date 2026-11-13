import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { FullConfig, FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';

interface Row {
  spec: string;
  project: string;
  test: string;
  status: string;
  data: Record<string, any>;
}

interface Extreme {
  value: number;
  element?: string;
  browser: string;
  [key: string]: unknown;
}

/** Keeps the lower (or, with `max`, the higher) of two measurements. */
const pick = (a: Extreme | undefined, b: Extreme | undefined, max = false): Extreme | undefined => {
  if (!a) return b;
  if (!b) return a;
  return (max ? b.value > a.value : b.value < a.value) ? b : a;
};

/**
 * Collects the `measure` attachments every spec makes, writes them per spec to test-results/measure/<spec>.json, and
 * merges the numbers the showcase quotes into design/previews/audit/measurements.json. A run of one spec updates only
 * that spec's numbers there.
 */
export default class MeasureReporter implements Reporter {
  #rows: Row[] = [];
  #root = process.cwd();
  #baseURL = '';

  onBegin(config: FullConfig): void {
    this.#root = config.configFile ? dirname(config.configFile) : process.cwd();
    this.#baseURL = String(config.projects[0]?.use.baseURL ?? '');
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    for (const attachment of result.attachments) {
      if (attachment.name !== 'measure' || !attachment.body) continue;
      this.#rows.push({
        spec: basename(test.location.file).replace(/\.spec\.ts$/, ''),
        project: test.parent.project()?.name ?? 'unknown',
        test: test.title,
        status: result.status,
        data: JSON.parse(attachment.body.toString()),
      });
    }
  }

  onEnd(result: FullResult): void {
    if (!this.#rows.length) return;
    const measureDir = join(this.#root, 'test-results', 'measure');
    mkdirSync(measureDir, { recursive: true });
    const specs = [...new Set(this.#rows.map((r) => r.spec))];
    for (const spec of specs) {
      const rows = this.#rows.filter((r) => r.spec === spec);
      writeFileSync(join(measureDir, `${spec}.json`), `${JSON.stringify(rows, null, 2)}\n`);
    }

    // The showcase quotes the numbers of the two engines the gate runs, by name (Chromium, WebKit). A Firefox run
    // (FB_FIREFOX=1) has its own per-spec files above and leaves the audit file as it is: written from Firefox alone
    // it had none of the numbers the site's page reads, and the site did not build.
    this.#rows = this.#rows.filter((r) => r.project !== 'firefox');
    if (!this.#rows.length) return;
    const audited = new Set(this.#rows.map((r) => r.spec));
    const out = join(this.#root, 'design', 'previews', 'audit', 'measurements.json');
    mkdirSync(dirname(out), { recursive: true });
    const summary: Record<string, any> = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};
    summary.generated = new Date().toISOString();
    summary.target = this.#baseURL;
    summary.run = result.status;
    summary.browsers = [...new Set(this.#rows.map((r) => r.project))].sort();

    if (audited.has('contrast')) summary.contrast = this.#contrast();
    if (audited.has('targets')) summary.targets = this.#targets();
    if (audited.has('keyboard')) summary.keyboard = this.#keyboard();
    if (audited.has('layout')) Object.assign(summary, this.#layout());
    writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
  }

  #contrast() {
    const themes: Record<string, Record<string, Record<string, Extreme | undefined>>> = {};
    for (const row of this.#rows.filter((r) => r.spec === 'contrast')) {
      const frames = (themes[row.data.theme ?? 'flipbook'] ??= {});
      const frame = (frames[row.data.frame] ??= { time: row.data.time });
      for (const key of ['text', 'large', 'graphics', 'boundary', 'captions'] as const) {
        const m = row.data[key];
        if (m) frame[key] = pick(frame[key], { ...m, value: m.ratio, browser: row.project });
      }
    }
    return {
      note: 'Minimum contrast ratio per category and theme, measured on the composited pixels behind each element, over the film paused at its brightest and darkest frames; the lowest across browsers.',
      thresholds: { text: 4.9, large: 3.4, graphics: 3.4, boundary: 3.4 },
      ...themes,
    };
  }

  #targets() {
    const widths: Record<string, Extreme | undefined> = {};
    for (const row of this.#rows.filter((r) => r.spec === 'targets')) {
      const s = row.data.smallest;
      if (s) widths[row.data.width] = pick(widths[row.data.width], { ...s, value: Math.min(s.width, s.height), browser: row.project });
    }
    return {
      note: 'Smallest hit area (CSS px, the shorter side) among the player and the width presets, measured on the element that receives the click, with a coarse pointer; the lowest across browsers.',
      minimum: 44,
      ...widths,
    };
  }

  #keyboard() {
    const out: Record<string, unknown> = {};
    for (const row of this.#rows.filter((r) => r.spec === 'keyboard')) {
      for (const [key, value] of Object.entries(row.data)) out[`${key}.${row.project}`] = value;
    }
    return out;
  }

  #layout() {
    const rows = this.#rows.filter((r) => r.spec === 'layout');
    let cls: Extreme | undefined;
    let shifts: Extreme | undefined;
    const axe = { scans: 0, nodesChecked: 0, smallestScan: Infinity, violations: 0 };
    const overflow: Record<string, number> = {};
    for (const row of rows) {
      if (row.data.kind === 'cls') {
        cls = pick(cls, { value: row.data.cls, browser: row.project }, true);
        shifts = pick(shifts, { value: row.data.allShifts, browser: row.project }, true);
      } else if (row.data.kind === 'axe') {
        axe.scans += 1;
        axe.nodesChecked += row.data.nodesChecked;
        axe.smallestScan = Math.min(axe.smallestScan, row.data.nodesChecked);
        axe.violations += row.data.violations;
      } else if (row.data.kind === 'overflow') {
        const key = `${row.data.page}@${row.data.width}`;
        overflow[key] = Math.max(overflow[key] ?? 0, row.data.overflow);
      }
    }
    return {
      cls: cls && { ...cls, shiftsIncludingInput: shifts?.value, note: 'Load and first play, Chromium (layout-shift entries are Chromium-only).' },
      axe: { ...axe, smallestScan: Number.isFinite(axe.smallestScan) ? axe.smallestScan : 0, tags: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      horizontalOverflow: overflow,
    };
  }
}
