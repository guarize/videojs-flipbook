/**
 * `@scope`, written out as plain selectors at build time.
 *
 * The skin's source keeps `@scope` (it reads as what it means: these rules are the player's and nobody else's), but
 * what ships has none, as Video.js's own packaged skins have none. Two WebKit defects, both seen in Mobile Safari
 * (design/previews/safari-r1/notes.md):
 *
 * 1. A scoped rule never matches a shadow host or an element slotted into one, in Safari 18.2 and 26.5. Video.js's
 *    poster and slider thumbnail are such hosts: the poster lost `position: absolute` and its image `object-fit`, so
 *    the picture lay under the player's box at its natural size and the player showed black.
 * 2. In Safari 18.2, changing an attribute on a scope's root does not restyle what `:scope[attr]` selects. The skin
 *    is driven by such attributes (`data-paused`, `data-fb-pad`, …): icons kept the wrong state, and the phone
 *    layout, measured once with a stale margin, was refused.
 *
 * The rewriting keeps every selector's specificity, so the cascade inside the layers is the one the source says:
 *
 *   @scope (R) { a {}  :scope[x] b {}  & c {}  > d {} }
 *   →  :where(R) a {}  :where(R).r[x] b {}  :where(R) c {}  :where(R) > d {}
 *
 * `:scope` weighs one class, so it becomes `:where(R)` and the root's own first class (`.r`); a selector without it
 * is a descendant of the root at no weight; `&` straight inside `@scope` is `:where(:scope)`. A scope inside a scope
 * has its root looked for inside the outer one. What is lost is scope proximity (a nearer root winning over a farther
 * one), which only matters where one scope root sits inside another of the same kind: the skin has no such case.
 *
 * Refused, loudly, rather than guessed at: a scope with a lower boundary (`to (…)`), a root that is a list, a root
 * that does not begin with a class, and declarations straight inside `@scope`.
 */
import { createRequire } from 'node:module';

/** Vite's own PostCSS: the repo has no other, and this is the one that runs the plugin. */
const postcss = createRequire(createRequire(import.meta.url).resolve('vite'))('postcss');

/** Splits a selector list on its top-level commas. */
export function splitSelectors(list) {
  const out = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (let i = 0; i < list.length; i++) {
    const char = list[i];
    if (quote) {
      if (char === '\\') current += char + (list[++i] ?? '');
      else {
        if (char === quote) quote = '';
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '\\') {
      current += char + (list[++i] ?? '');
      continue;
    } else if (char === '(' || char === '[') depth++;
    else if (char === ')' || char === ']') depth--;
    else if (char === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** Replaces `token` wherever it stands outside a string, when `test` accepts what follows it. */
function replaceOutsideStrings(selector, pattern, replacement) {
  let out = '';
  let quote = '';
  for (let i = 0; i < selector.length; i++) {
    const char = selector[i];
    if (quote) {
      if (char === '\\') out += char + (selector[++i] ?? '');
      else {
        if (char === quote) quote = '';
        out += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      out += char;
      continue;
    }
    pattern.lastIndex = i;
    const match = pattern.exec(selector);
    if (match) {
      out += replacement;
      i += match[0].length - 1;
    } else out += char;
  }
  return out;
}

const SCOPE = /:scope(?![\w-])/y;
const AMPERSAND = /&/y;
const HAS_SCOPE = /:scope(?![\w-])/;
const GROUPS = new Set(['media', 'container', 'supports', 'layer', 'starting-style', 'document']);

/** One scope: what stands for `:scope` at one class's weight, and at none. */
function context(params, outer, node) {
  const match = /^\(([\s\S]*)\)$/.exec(params.trim());
  if (!match || /\)\s*to\s*\(/.test(params)) throw node.error(`unscope: only "@scope (root)" is written out, not "${params}"`);
  const root = match[1].trim();
  if (splitSelectors(root).length !== 1) throw node.error(`unscope: a scope root that is a list is not supported: "${root}"`);
  const first = /^\.(?:[\w-]|\\.)+/.exec(root)?.[0];
  if (!first) throw node.error(`unscope: a scope root must begin with a class: "${root}"`);
  const inside = outer ? `${outer.plain} ${root}` : root;
  return { plain: inside, zero: `:where(${inside})`, one: `:where(${inside})${first}` };
}

function rewrite(selector, scope, top) {
  const scoped = HAS_SCOPE.test(selector);
  let out = replaceOutsideStrings(selector, SCOPE, scope.one);
  if (!top) return out;
  const nested = selector.includes('&');
  if (nested) out = replaceOutsideStrings(out, AMPERSAND, scope.zero);
  return scoped || nested ? out : `${scope.zero} ${out}`;
}

function walk(container, scope, top) {
  for (const node of [...container.nodes]) {
    if (node.type === 'rule') {
      node.selector = splitSelectors(node.selector)
        .map((selector) => rewrite(selector, scope, top))
        .join(',\n');
      // Rules nested in this one hang off it with `&`; only a literal `:scope` in them still names the root.
      walk(node, scope, false);
    } else if (node.type === 'atrule') {
      if (node.name === 'scope') unscope(node, scope);
      else if (GROUPS.has(node.name) && node.nodes) walk(node, scope, top);
    } else if (node.type === 'decl' && top && container.type === 'atrule' && container.name === 'scope') {
      throw node.error('unscope: a declaration straight inside @scope is not supported; give it a ":scope { }" rule');
    }
  }
}

function unscope(atrule, outer) {
  const scope = context(atrule.params, outer, atrule);
  walk(atrule, scope, true);
  atrule.replaceWith(atrule.nodes);
}

/** The PostCSS plugin. */
export function unscopePlugin() {
  return {
    postcssPlugin: 'unscope',
    Once(root) {
      const scopes = [];
      root.walkAtRules('scope', (atrule) => {
        // Outermost only: each writes out the scopes inside it.
        for (let parent = atrule.parent; parent; parent = parent.parent) if (parent.type === 'atrule' && parent.name === 'scope') return;
        scopes.push(atrule);
      });
      for (const atrule of scopes) unscope(atrule, null);
    },
  };
}
unscopePlugin.postcss = true;

/** A stylesheet's text, written out. For tests and scripts. */
export function unscopeCss(css) {
  return postcss([unscopePlugin()]).process(css, { from: undefined }).css;
}
