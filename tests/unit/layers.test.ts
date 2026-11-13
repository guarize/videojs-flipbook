import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error a build script, typed beside itself (build/layers.d.mts)
import { layersCss, ORDER, PREFIX, UNDER } from '../../build/layers.mjs';

/**
 * What ships has the skin's layers under names of its own (build/layers.mjs): a page built with Tailwind CSS 4 names
 * its layers as a Video.js skin does, and its preflight and element rules met the skin's at the same rank. The
 * browser comparison is tests/e2e/hostile.spec.ts; this holds the rewriting itself.
 */
const WHOLE = '@layer theme, base, components, utilities, fb-reset, fb-base, fb-components, fb-utilities, fb-a11y, fb-apart;';
const flat = (css: string) => layersCss(css).replace(/\s+/g, ' ').trim();
/** A stylesheet's own rules, after the order every one of them opens with. */
const body = (css: string) => {
  const out = flat(css);
  expect(out.startsWith(WHOLE), `opens with the whole order: ${out.slice(0, 120)}`).toBe(true);
  return out.slice(WHOLE.length).trim();
};

describe('the skin’s layers, renamed', () => {
  it('gives every layer the prefix: blocks, sublayers, lists and statements', () => {
    expect(body('@layer components { a { b: c } } @layer base.preset { d { e: f } } @layer a11y, apart { g { h: i } }')).toBe(
      '@layer fb-components { a { b: c } } @layer fb-base.preset { d { e: f } } @layer fb-a11y, fb-apart { g { h: i } }',
    );
    expect(body('@layer base.theme, base.preset; @layer base.theme { a { b: c } }')).toBe('@layer fb-base.theme, fb-base.preset; @layer fb-base.theme { a { b: c } }');
  });

  it('opens every stylesheet that has a layer with the whole order: Tailwind’s four, then the skin’s, lowest first', () => {
    expect(UNDER).toEqual(['theme', 'base', 'components', 'utilities']);
    expect(ORDER).toEqual(['reset', 'base', 'components', 'utilities', 'a11y', 'apart']);
    // Whichever of them a page meets first, the ranks are the same: a block alone would rank its layer where it stood.
    expect(flat('@layer components { a { b: c } }')).toBe(`${WHOLE} @layer fb-components { a { b: c } }`);
    expect(flat('@import "x.css"; @layer base { a { b: c } }')).toBe(`${WHOLE} @import "x.css"; @layer fb-base { a { b: c } }`);
    // Once only, and nothing for a stylesheet with no layer.
    expect(flat(flat('@layer base { a { b: c } }'))).toBe(`${WHOLE} @layer fb-base { a { b: c } }`);
    expect(flat('a { b: c }')).toBe('a { b: c }');
  });

  it('states the order the armour states', () => {
    const armour = readFileSync(join(__dirname, '../../src/skins/flipbook/armour.css'), 'utf8');
    expect(armour).toContain(`@layer ${ORDER.join(', ')};`);
  });

  it('goes through @media and @supports, and leaves an anonymous layer alone', () => {
    expect(body('@media (x) { @layer components { a { b: c } } } @supports (y) { @layer fb-apart { d { e: f } } } @layer { g { h: i } }')).toBe(
      '@media (x) { @layer fb-components { a { b: c } } } @supports (y) { @layer fb-apart { d { e: f } } } @layer { g { h: i } }',
    );
  });

  it('refuses a layer inside a layer', () => {
    expect(() => layersCss('@layer base { @layer preset { a { b: c } } }')).toThrow(/layer inside a layer/);
  });

  it('touches only the skin’s own stylesheets', () => {
    const run = (file: string) => layersCss('@layer base { a { b: c } }', join(__dirname, '../..', file));
    expect(run('src/skins/flipbook/skin.css')).toContain(`@layer ${PREFIX}base`);
    expect(run('apps/preview/src/shell/styles.css')).toContain('@layer base');
    expect(run('node_modules/x/y.css')).toContain('@layer base');
  });
});

/**
 * The armour's `reset` layer hands every element back to the browser's stylesheet, and a drawing back to its own
 * attributes. Of those, the paint on the `<svg>` itself is said again in the skin's layers (armour.css), so a page's
 * layered `svg { … }` cannot repaint an icon: that holds only while every icon carries exactly that paint.
 */
describe('the skin’s icons', () => {
  const DIR = join(__dirname, '../../src/skins/flipbook');
  const sources = readdirSync(DIR, { recursive: true, encoding: 'utf8' })
    .filter((name) => /\.(ts|html)$/.test(name))
    .map((name) => ({ name, text: readFileSync(join(DIR, name), 'utf8') }));
  const PAINT = ['fill="none"', 'stroke="currentColor"', 'stroke-width="1.5"', 'stroke-linecap="round"', 'stroke-linejoin="round"'];

  it('are all drawn with the paint armour.css states', () => {
    const tags = sources.flatMap(({ name, text }) => (text.match(/<svg\b[^>]*>/g) ?? []).map((tag) => ({ name, tag })));
    expect(tags.length).toBeGreaterThan(2);
    const odd = tags.filter(({ tag }) => !PAINT.every((attribute) => tag.includes(attribute))).map(({ name, tag }) => `${name}: ${tag.slice(0, 120)}`);
    expect(odd).toEqual([]);
    const armour = readFileSync(join(DIR, 'armour.css'), 'utf8');
    for (const attribute of PAINT) {
      const [, property, value] = /^([\w-]+)="([^"]+)"$/.exec(attribute) ?? [];
      expect(armour, attribute).toMatch(new RegExp(`\\n\\s+${property}: ${value};`));
    }
  });
});
