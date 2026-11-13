import { registerI18n } from '@videojs/html/i18n';

/** The extras' strings, in Video.js's registry so locale packs can translate them. English is the default. */
export const EXTRAS_TEXT = {
  goToTime: 'Go to time',
  timeField: 'Time to go to, as minutes and seconds',
  timeInvalid: 'That isn’t a time. Type one such as 1:23.',
  timeTooLate: 'That’s after the end, {end}. Type an earlier time.',
  endsAt: 'Ends {time}',
  doneIn: 'Done in {time}',
  resumeFrom: 'Resume from {time}',
  startOver: 'Start over',
  scrubFull: 'Full speed scrubbing',
  scrubHalf: 'Half speed scrubbing',
  scrubQuarter: 'Quarter speed scrubbing',
  scrubFine: 'Fine scrubbing',
} as const;

registerI18n('en', { extras: EXTRAS_TEXT } as unknown as Parameters<typeof registerI18n>[1]);

/** The English text for a key, with `{name}` placeholders filled. */
export function text(key: keyof typeof EXTRAS_TEXT, values: Record<string, string> = {}): string {
  return EXTRAS_TEXT[key].replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '');
}

/** `0:42`, `12:05`, `1:02:03`: a time as people say it. */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Reads `1:23`, `83`, `1:02:03`, `83s`, `1m23s`; null for anything else. */
export function parseTime(input: string): number | null {
  const value = input.trim().toLowerCase();
  if (!value) return null;
  const units = /^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+(?:\.\d+)?)s?)?$/.exec(value);
  if (units && /[hms]/.test(value)) {
    const [, h = '0', m = '0', s = '0'] = units;
    return Number(h) * 3600 + Number(m) * 60 + Number(s);
  }
  const parts = value.split(':');
  if (parts.length > 3 || parts.some((part) => !/^\d+(\.\d+)?$/.test(part))) return null;
  return parts.reduce((total, part) => total * 60 + Number(part), 0);
}
