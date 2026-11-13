import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * What the armour (src/skins/flipbook/armour.css) stands on. Its unlayered `all: revert-layer` hands every element of
 * the skin back to the layers, so a rule of the skin's own left outside a layer would be reverted with the host's and
 * silently do nothing; and a length in rem would follow the host's root font size.
 */
const DIR = join(__dirname, '../../src/skins/flipbook');
const sheets = readdirSync(DIR)
  .filter((name) => name.endsWith('.css'))
  .map((name) => ({ name, css: readFileSync(join(DIR, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '') }));

/** The preludes of a stylesheet's top-level rules (what stands before each outermost `{`, or an at-rule's line). */
function topLevel(css: string): string[] {
  const preludes: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of css) {
    if (char === '{') {
      if (depth === 0) preludes.push(current.trim().replace(/\s+/g, ' '));
      depth++;
      current = '';
    } else if (char === '}') {
      depth--;
      current = '';
    } else if (char === ';' && depth === 0) {
      current = '';
    } else if (depth === 0) {
      current += char;
    }
  }
  return preludes;
}

/**
 * Unlayered on purpose: the armour's own lines (in armour.css, and in the two extras whose parts stand in the page),
 * and the picture-in-picture window's page (its html, body and the root).
 */
const ARMOUR = /:not\(#\\#\):not\(#\\#\)/;
const UNLAYERED: Record<string, RegExp> = {
  'armour.css': ARMOUR,
  'float.css': ARMOUR,
  'pip-page.css': /^html\.fb-pip-window|:not\(#\\#\):not\(#\\#\)/,
};

describe('the skin’s stylesheets', () => {
  it('were found', () => {
    expect(sheets.length).toBeGreaterThan(20);
    expect(topLevel('a { b: c } @layer x { d { e: f } } @media (g) { h { i: j } }')).toEqual(['a', '@layer x', '@media (g)']);
  });

  it('keep every rule in a layer, but the armour and the picture-in-picture window’s page', () => {
    const loose: string[] = [];
    for (const { name, css } of sheets) {
      for (const prelude of topLevel(css)) {
        if (/^@(layer|font-face|property|keyframes)\b/.test(prelude)) continue;
        if (UNLAYERED[name]?.test(prelude)) continue;
        loose.push(`${name}: ${prelude.slice(0, 80)}`);
      }
    }
    expect(loose).toEqual([]);
  });

  it('measure nothing in rem: the host’s root font size is not the skin’s', () => {
    const rems = sheets.flatMap(({ name, css }) => (css.match(/[^\n]*\d(?:\.\d+)?rem\b[^\n]*/g) ?? []).map((line) => `${name}: ${line.trim()}`));
    expect(rems).toEqual([]);
  });

  // Safari 26 (seen in Mobile Safari 26.5, not in 18.2, Chromium or Playwright's WebKit): on an element under the
  // armour's `all: revert-layer`, a logical *shorthand* whose value holds var() or env() computes to nothing
  // (`padding-inline: var(--m)` → 0), while the longhands (`padding-inline-start`) and the physical sides hold. The
  // fullscreen top row lost its notch inset to it, and the plate's strip its margin.
  it('give no logical shorthand a var() or an env(): Safari 26 drops it under revert-layer', () => {
    const SHORTHAND = /(?:^|[;{\s])((?:padding|margin|inset|scroll-margin|scroll-padding)-(?:inline|block)|border-(?:inline|block)(?:-(?:start|end|width|style|color))?)\s*:([^;}]*)/g;
    const dropped = sheets.flatMap(({ name, css }) => [...css.matchAll(SHORTHAND)].filter((match) => /\b(?:var|env)\(/.test(match[2])).map((match) => `${name}: ${match[1]}:${match[2].trim().slice(0, 60)}`));
    expect(dropped).toEqual([]);
    expect('a { padding-inline: var(--x) } b { padding-inline-start: var(--x); border-inline-end: 1px solid var(--c) }'.match(SHORTHAND)?.length).toBe(2);
  });

  it('name every keyframe for the skin', () => {
    const names = sheets.flatMap(({ css }) => [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((match) => match[1]));
    expect(names.filter((name) => !name.startsWith('fb-'))).toEqual([]);
  });
});
