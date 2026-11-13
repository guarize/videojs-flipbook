/**
 * The skin's cascade layers under names of its own, written at build time.
 *
 * The skin's source names its layers as Video.js 10's skins do: `base`, `components`, `utilities`. Tailwind CSS 4
 * names its own the same way (`theme`, `base`, `components`, `utilities`), so on a page built with it the two met in
 * the same layers: Tailwind's preflight and a project's `@layer base { kbd { … } button { … } svg { … } }` stood
 * beside the skin's rules at the same rank, and won wherever they weighed more, came later, or named a property the
 * skin leaves to the browser. Seen on a live page: a keycap lettered white on paper. 1,421 of the player's 3,852
 * computed styles moved (tests/e2e/hostile.spec.ts holds the comparison).
 *
 * What ships:
 *
 *   (first in every stylesheet)         →  @layer theme, base, components, utilities, fb-reset, fb-base,
 *                                                  fb-components, fb-utilities, fb-a11y, fb-apart;
 *   @layer base.preset { … }            →  @layer fb-base.preset { … }
 *   @layer components { … }             →  @layer fb-components { … }
 *
 * Every layer of the skin carries the prefix, and every stylesheet of the skin's that has a layer opens with the
 * whole order: Tailwind's four, then the skin's own (armour.css says what each is for). A layer's rank is set where
 * its name is first met, and a build decides which stylesheet a page meets first: the bench's build put the shared
 * base ahead of the armour, `fb-reset` then ranked above `fb-components`, and the reset undid the skin (the volume
 * fader and the speed key gone, seen in the battery, 12 Nov 2026). With the order at the head of each, no order of
 * loading can change it; the same goes for a page's Tailwind sheet loaded before or after. (A page with layers of
 * other names keeps the rule it always had: the skin's stylesheet goes after its own.)
 * Under them all the skin keeps a layer of its own, `fb-reset` (armour.css), that hands every element of the player
 * back to the browser's own stylesheet, so a property the skin does not set is the browser's and not the page's.
 *
 * Only the skin's own stylesheets are rewritten (the folder given): a host's, or the workbench's Tailwind, are not.
 * A layer nested in a layer is refused: the skin writes sublayers with a dot.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const postcss = createRequire(createRequire(import.meta.url).resolve('vite'))('postcss');

export const PREFIX = 'fb-';
/** Tailwind CSS 4's layers, in its order. */
export const UNDER = ['theme', 'base', 'components', 'utilities'];
/** The skin's own, lowest first (armour.css states the same order, and what each is for). */
export const ORDER = ['reset', 'base', 'components', 'utilities', 'a11y', 'apart'];
const SKIN = fileURLToPath(new URL('../src/', import.meta.url));

const names = (params) => params.split(',').map((name) => name.trim()).filter(Boolean);
const own = (name) => (name.startsWith(PREFIX) ? name : `${PREFIX}${name}`);
const WHOLE = [...UNDER, ...ORDER.map(own)].join(', ');

/** The PostCSS plugin. `within`: the folder whose stylesheets are the skin's (every stylesheet, if null). */
export function layersPlugin({ within = SKIN } = {}) {
  return {
    postcssPlugin: 'flipbook-layers',
    Once(root, { AtRule }) {
      const file = root.source?.input.file;
      if (within && !(file && file.startsWith(within))) return;
      let layered = false;
      root.walkAtRules('layer', (atrule) => {
        for (let parent = atrule.parent; parent; parent = parent.parent) {
          if (parent.type === 'atrule' && parent.name === 'layer') throw atrule.error('layers: a layer inside a layer is not renamed; write the sublayer with a dot ("base.preset")');
        }
        // (The order itself, from an earlier pass: Tailwind's names in it are not the skin's to rename.)
        if (names(atrule.params).join(', ') === WHOLE) return;
        const renamed = names(atrule.params).map(own);
        // An anonymous layer (`@layer { … }`) has no name to carry.
        if (!renamed.length) return;
        layered = true;
        atrule.params = renamed.join(', ');
      });
      // The whole order, ahead of everything (a layer statement may stand before an `@import`).
      if (layered && !(root.first?.type === 'atrule' && root.first.name === 'layer' && root.first.params === WHOLE)) root.prepend(new AtRule({ name: 'layer', params: WHOLE }));
    },
  };
}
layersPlugin.postcss = true;

/** A stylesheet's text, its layers renamed; as the build would for the stylesheet at `file`, if one is named. For tests. */
export function layersCss(css, file) {
  return postcss([layersPlugin(file ? {} : { within: null })]).process(css, { from: file }).css;
}
