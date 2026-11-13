/**
 * The audit's values as the copy prints them (content/copy.ts `Measured`): formatted here, once, so a component only
 * places words. The page's own Lighthouse run is optional: without its file the line is left out.
 */
import type { Measured } from '../content/copy';
import { audit, kB } from './audit';

interface Lighthouse {
  measured: string;
  runs: number;
  mobile: { performance: number; lcp: number; tbt: number };
  desktop: { performance: number };
}
const found = Object.values(import.meta.glob<{ default: Lighthouse }>('../../../../design/previews/audit/site-lighthouse.json', { eager: true }))[0]?.default;

const seconds = (ms: number) => (ms / 1000).toFixed(1);
const list = (values: (string | number)[]) => (values.length > 1 ? `${values.slice(0, -1).join(', ')} and ${values.at(-1)}` : String(values[0]));
const day = (iso: string) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso));

export const measured: Measured = {
  weights: {
    measured: audit.weights.measured,
    core: kB(audit.weights.core),
    coreJs: kB(audit.weights.coreJs),
    coreCss: kB(audit.weights.coreCss),
    book: kB(audit.weights.book),
    extras: kB(audit.weights.extras),
    chunks: audit.weights.chunks,
    smallest: kB(audit.weights.smallest),
    largest: kB(audit.weights.largest),
  },
  ready: { desktop: seconds(audit.ready.desktop), mobile: seconds(audit.ready.mobile), runs: audit.ready.runs },
  measured: audit.measured,
  browsers: list(audit.browsers),
  bars: audit.bars,
  bright: audit.bright,
  dark: audit.dark,
  text: audit.text,
  target: { smallest: audit.target.smallest, widths: list(audit.target.widths) },
  axe: { ...audit.axe, nodes: audit.axe.nodes.toLocaleString('en-GB') },
  keyboard: audit.keyboard,
  shift: audit.shift,
  overflow: { clean: audit.overflow.worst === 0, from: audit.overflow.from as number, to: audit.overflow.to as number },
  lighthouse: found && {
    mobile: found.mobile.performance,
    desktop: found.desktop.performance,
    runs: found.runs,
    lcp: seconds(found.mobile.lcp),
    tbt: Math.round(found.mobile.tbt),
    measured: day(found.measured),
  },
};

/** The two presets' weights for the switch in the hero: whole kilobytes. */
export const presetWeights = { essential: kB(audit.weights.core, 0), book: kB(audit.weights.book, 0) };
/** The two frames the contrast spec measures over, in seconds, for the keys that seek to them. */
export const frameTimes = { bright: audit.bright.time, dark: audit.dark.time };
