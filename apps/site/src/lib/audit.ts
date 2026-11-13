/**
 * The measured numbers the page prints, read at build time from the two files the test battery and the weights script
 * write: `design/previews/audit/weights.json` (scripts/weights.mjs) and `design/previews/audit/measurements.json`
 * (tests/e2e). Nothing here is typed by hand. A missing file fails the build at the import; a missing or non-numeric
 * value fails it below, by name. Only .astro frontmatter imports this module, so the files never reach the browser.
 */
import measurements from '../../../../design/previews/audit/measurements.json';
import weights from '../../../../design/previews/audit/weights.json';

const num = (value: unknown, name: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`audit: "${name}" is missing or not a number in design/previews/audit. Run the battery and scripts/weights.mjs before building the site.`);
  return value;
};

const day = (iso: string, name: string) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`audit: "${name}" is not a date in design/previews/audit.`);
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
};

/** Bytes as kilobytes (1 kB = 1000 B, as the README counts them). */
export const kB = (bytes: number, digits = 1) => (bytes / 1000).toFixed(digits);
/** A film time as the player writes it to the hundredth: 88.56 → 1:28.56. */
export const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, '0')}`;
/** A ratio as measured, without trailing zeros: 5.18, 14.1. */
const ratio = (value: number) => String(Number(value.toFixed(2)));

const { library, speed } = weights;
const { contrast, keyboard, targets, axe, cls, horizontalOverflow } = measurements;

/** The player as shipped, at each width the contrast spec ran it; the rebranded run is the README's, not the page's. */
const shipped = [contrast.flipbook, contrast['flipbook, 390 px']];
type Frame = (typeof shipped)[number]['bright' | 'dark'];
const lowest = (frames: Frame[], kinds: ('text' | 'large' | 'graphics' | 'boundary' | 'captions')[], name: string) => {
  const found = frames.flatMap((frame) => kinds.map((kind) => (frame as unknown as Partial<Record<string, { ratio: number }>>)[kind]?.ratio)).filter((r): r is number => typeof r === 'number');
  return num(found.length ? Math.min(...found) : undefined, name);
};
const frame = (which: 'bright' | 'dark') => {
  const frames = shipped.map((run) => run[which]);
  const time = num(frames[0]?.time, `contrast.flipbook.${which}.time`);
  if (frames.some((f) => f.time !== time)) throw new Error(`audit: the ${which} frame is not the same moment in every contrast run.`);
  return {
    time,
    clock: clock(time),
    /** The lowest ratio of any text there, and of any icon or edge, across the desktop and phone layouts. */
    text: ratio(lowest(frames, ['text', 'large', 'captions'], `contrast ${which} text`)),
    marks: ratio(lowest(frames, ['graphics', 'boundary'], `contrast ${which} marks`)),
  };
};

const widths = (keys: string[]) => [...new Set(keys.map((key) => Number(key.split('@')[1])).filter(Number.isFinite))].sort((a, b) => a - b);
const overflowWidths = widths(Object.keys(horizontalOverflow));
const overflowWorst = Math.max(...Object.entries(horizontalOverflow).map(([key, value]) => num(value, `horizontalOverflow.${key}`)));
const targetWidths = Object.keys(targets).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
/** A keyboard count in every browser that ran: the file keys them `playerStops.chromium`, `playerStops.webkit`. */
const each = (name: string) => {
  const found = Object.entries(keyboard as Record<string, unknown>).filter(([key]) => key.startsWith(`${name}.`));
  if (!found.length) throw new Error(`audit: "keyboard.${name}" is missing in design/previews/audit/measurements.json.`);
  return found.map(([key, value]) => num(value, `keyboard.${key}`));
};
const extras = Object.keys(library.extras);

export const audit = {
  weights: {
    measured: day(weights.measured, 'weights.measured'),
    core: num(library.core.total, 'library.core.total'),
    coreJs: num(library.core.js, 'library.core.js'),
    coreCss: num(library.core.css, 'library.core.css'),
    book: num(library.book.total, 'library.book.total'),
    extras: num(library.book.extras, 'library.book.extras'),
    chunks: extras.length,
    smallest: Math.min(...extras.map((name) => num(library.extras[name as keyof typeof library.extras].gzip, `library.extras.${name}.gzip`))),
    largest: Math.max(...extras.map((name) => num(library.extras[name as keyof typeof library.extras].gzip, `library.extras.${name}.gzip`))),
  },
  ready: {
    runs: num(speed.desktop.book.runs, 'speed.desktop.book.runs'),
    desktop: num(speed.desktop.book.playerReady, 'speed.desktop.book.playerReady'),
    mobile: num(speed.mobile.book.playerReady, 'speed.mobile.book.playerReady'),
  },
  measured: day(measurements.generated, 'measurements.generated'),
  browsers: measurements.browsers.map((name) => ({ chromium: 'Chromium', webkit: 'WebKit', firefox: 'Firefox' })[name] ?? name),
  bars: { text: num(contrast.thresholds.text, 'contrast.thresholds.text'), marks: num(contrast.thresholds.graphics, 'contrast.thresholds.graphics') },
  bright: frame('bright'),
  dark: frame('dark'),
  /** The lowest text ratio at either frame, at either width. */
  text: ratio(lowest(shipped.flatMap((run) => [run.bright, run.dark]), ['text', 'large', 'captions'], 'contrast text')),
  target: { smallest: num(targets.minimum, 'targets.minimum'), widths: targetWidths },
  axe: { violations: num(axe.violations, 'axe.violations'), scans: num(axe.scans, 'axe.scans'), nodes: num(axe.nodesChecked, 'axe.nodesChecked') },
  keyboard: { stops: Math.min(...each('playerStops')), ringless: Math.max(...each('ringless')) },
  shift: num(cls.value, 'cls.value'),
  overflow: { worst: overflowWorst, from: overflowWidths[0], to: overflowWidths.at(-1) },
};

if (!audit.overflow.from || !audit.target.widths.length || !audit.browsers.length) throw new Error('audit: measurements.json has no widths or browsers listed.');
