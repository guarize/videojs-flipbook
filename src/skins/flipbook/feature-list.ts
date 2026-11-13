/*
 * The book's extras by name, and how `features` reads: pure, so it's tested without a browser
 * (tests/unit/flipbook-features.test.ts). features.ts does the loading.
 */

export const FEATURES = ['turns', 'deck', 'contents', 'ribbons', 'plate', 'curl', 'cover', 'pip', 'hints', 'next', 'float', 'ear', 'tear', 'intertitle'] as const;
export type Feature = (typeof FEATURES)[number];

export const PRESETS = {
  essential: [] as readonly Feature[],
  book: FEATURES as readonly Feature[],
} as const;
export type Preset = keyof typeof PRESETS;

/** What `features` asks for: names and presets, in any order and case; unknown words are ignored. */
export function parseFeatures(value: string | null | undefined): Set<Feature> {
  if (value == null) return new Set(PRESETS.book);
  const on = new Set<Feature>();
  for (const word of value.trim().toLowerCase().split(/[\s,]+/)) {
    if (word === 'book') for (const name of PRESETS.book) on.add(name);
    else if ((FEATURES as readonly string[]).includes(word)) on.add(word as Feature);
  }
  return on;
}

/** The attribute as a value for `features`: a preset's name when it is one, otherwise the names in their order. */
export function formatFeatures(on: Iterable<Feature>): string {
  const set = new Set(on);
  if (set.size === FEATURES.length) return 'book';
  if (!set.size) return 'essential';
  return FEATURES.filter((name) => set.has(name)).join(' ');
}
