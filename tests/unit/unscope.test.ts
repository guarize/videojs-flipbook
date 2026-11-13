import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error a build script, typed beside itself (build/unscope.d.mts)
import { splitSelectors, unscopeCss } from '../../build/unscope.mjs';

/**
 * What ships has no `@scope` (build/unscope.mjs): Mobile Safari never matches a scoped rule on a shadow host or what
 * is slotted in it (Video.js's poster: the hero showed black), and Safari 18.2 does not restyle `:scope[attr]` when
 * the attribute changes. The rewriting must keep each selector's weight, or the cascade inside the layers changes.
 * The build itself is held to it where it is served: scripts/site-check.mjs fails on any `@scope` the page loads.
 */
const ROOT = '.media-skin[data-theme="flipbook"][data-preset="video"]';
const flat = (css: string) => unscopeCss(css).replace(/\s+/g, ' ').trim();

describe('@scope written out', () => {
  it('gives :scope one class’s weight and everything else the root at none', () => {
    expect(flat(`@scope (${ROOT}) { :scope { a: b } .x > .y { a: b } :scope[q]::after { a: b } > .z { a: b } }`)).toBe(
      `:where(${ROOT}).media-skin { a: b } :where(${ROOT}) .x > .y { a: b } :where(${ROOT}).media-skin[q]::after { a: b } :where(${ROOT}) > .z { a: b }`,
    );
  });

  it('reads & straight inside @scope as the root at no weight, and leaves a nested rule’s & alone', () => {
    expect(flat('@scope (.b) { &[on] .i { a: b } .p { a: b; .q & { c: d } :scope[x] & { e: f } } }')).toBe(
      ':where(.b)[on] .i { a: b } :where(.b) .p { a: b; .q & { c: d } :where(.b).b[x] & { e: f } }',
    );
  });

  it('looks for an inner scope’s root inside the outer one', () => {
    expect(flat('@scope (.s) { @scope (.b) { :scope:hover, svg { a: b } } }')).toBe(':where(.s .b).b:hover, :where(.s .b) svg { a: b }');
  });

  it('goes through @media and @container, and leaves keyframes and strings alone', () => {
    expect(flat('@layer c { @scope (.s) { @media (x) { :scope[d="a, :scope & b"] .q, .r { a: b } } @keyframes fb-k { from { a: b } to { a: c } } } }')).toBe(
      '@layer c { @media (x) { :where(.s).s[d="a, :scope & b"] .q, :where(.s) .r { a: b } } @keyframes fb-k { from { a: b } to { a: c } } }',
    );
    expect(splitSelectors('a:is(b, c), d[e="f,g"], h')).toEqual(['a:is(b, c)', 'd[e="f,g"]', 'h']);
  });

  it('refuses what it cannot write out exactly', () => {
    expect(() => unscopeCss('@scope (.a) to (.b) { c { d: e } }')).toThrow(/unscope/);
    expect(() => unscopeCss('@scope (.a, .b) { c { d: e } }')).toThrow(/unscope/);
    expect(() => unscopeCss('@scope (div) { c { d: e } }')).toThrow(/unscope/);
    expect(() => unscopeCss('@scope (.a) { d: e }')).toThrow(/unscope/);
  });

  it('leaves no @scope and no :scope in any stylesheet of the source', () => {
    const sheets: string[] = [];
    const gather = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) gather(join(dir, entry.name));
        else if (entry.name.endsWith('.css')) sheets.push(join(dir, entry.name));
      }
    };
    gather(join(__dirname, '../../src'));
    const scoped = sheets.filter((file) => /@scope\s*\(/.test(readFileSync(file, 'utf8')));
    expect(scoped.length).toBeGreaterThan(20);
    for (const file of scoped) {
      const out = unscopeCss(readFileSync(file, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
      // (`:scope` outside any `@scope` is left as written: one other skin has such a line, for a shadow root.)
      expect(/@scope/.test(out), file).toBe(false);
      if (file.includes('/skins/flipbook/')) expect(/:scope(?![\w-])/.test(out), file).toBe(false);
    }
  });
});
