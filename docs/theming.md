# Rebrand

The colours are custom properties, named by role in `src/skins/flipbook/theme.css`. Override them in your own stylesheet. No rule in the skin hard-codes them.

There are two tiers. The materials (ink, paper, the desk) are the book's own and stay. The roles below them are what a site sets.

## The accent

The accent is a family, and its tokens move together.

| Token | What it colours | What it has to hold |
|---|---|---|
| `--fb-accent` | The mark itself, the focus ring and the playhead | 3.4:1 on the cover (`--fb-cover`) |
| `--fb-accent-edge` | The edge of the pages you have watched | |
| `--fb-accent-mid`, `--fb-accent-deep` | Fills that carry paper text | 4.9:1 under `--fb-paper` |
| `--fb-accent-glow`, `--fb-accent-shade`, `--fb-accent-shade-deep` | Their light and shade | |
| `--fb-cloth`, `--fb-cloth-playhead`, `--fb-page-read` | The cloth gradients built from them | |

A whole rebrand in blue looks like this.

```css
.media-skin[data-theme="flipbook"] {
  --fb-accent: #3d7bf2;
  --fb-accent-edge: #3a6fd8;
  --fb-accent-mid: #2457c5;
  --fb-accent-deep: #1d469e;
  --fb-accent-glow: rgb(215 228 255);
  --fb-accent-shade: rgb(4 18 60);
  --fb-accent-shade-deep: rgb(2 12 44);
  --fb-cloth: linear-gradient(90deg, #0e2350, #183a82 38%, #1d469e 56%, #10295c);
  --fb-cloth-playhead: linear-gradient(90deg, #2a5cc4, var(--fb-accent) 45%, #6d9cf7 60%, #2e63cf);
  --fb-page-read: linear-gradient(180deg, #7aa4f5, var(--fb-accent-edge) 40%, #1f4ba6);
}
```

That block is the contrast test's second run, named `rebranded` in `tests/e2e/contrast.spec.ts`. It is measured over the film's brightest and darkest frames like the shipped red, and its lowest text pair reads 5.49:1 (`design/previews/audit/measurements.json`).

## The cover and what is printed on it

| Token | What it colours |
|---|---|
| `--fb-cover`, `--fb-cover-hi`, `--fb-cover-lo` | The board the controls are bound into |
| `--fb-cover-raised`, `--fb-cover-solid` | Popovers, and the solid version for more contrast |
| `--fb-on-cover`, `--fb-on-cover-soft`, `--fb-on-cover-mute` | Lettering on the cover |
| `--fb-line-control-cover` | A control's boundary on the cover, at least 3.4:1 against it |
| `--fb-ring`, `--fb-ring-plate` | The focus ring, and the plate under it that holds it over a bright frame |
| `--fb-caption-ground`, `--fb-caption-text` | Captions. The caption style page can change both. |

## The typeface

`--fb-font` is the skin's stack. It starts with Onest, served from `/fonts/flipbook/onest-latin.woff2`, with a fallback sized to it so the swap moves nothing. Set `--fb-font` to use your own.

The page numbers are set in Newsreader when the `folio` detail is on. `newsreader-latin.woff2` is fetched from the same folder, and only then.

## On a page with CSS of its own

The skin has to look the same on any page, so it defends itself in two ways.

Its cascade layers ship under names of their own (`fb-reset`, `fb-base`, `fb-components`, `fb-utilities`, `fb-a11y`, `fb-apart`). Video.js 10's skins name their layers `base`, `components` and `utilities`, and so does Tailwind CSS 4, which would put a Tailwind page's preflight in the same layers as the skin's rules. The build renames them (`build/layers.mjs`), and every stylesheet of the skin opens with the whole order, Tailwind's four first, so it does not matter which stylesheet a page loads first. Under them all is a reset layer that hands every element of the player back to the browser's own stylesheet, so a property the skin does not set is the browser's and never the page's. A page with layers of other names loads the skin's stylesheet after its own.

`src/skins/flipbook/armour.css` then hands every element of the skin back to the skin's layers with an unlayered `all: revert-layer`, so an unlayered rule on the host page (`kbd { … }`, `button { … }`, `* { … }`) cannot restyle the player. Custom properties are untouched by it, which is why the tokens above still work, and a host's deliberate `!important` still reaches in.

`tests/e2e/hostile.spec.ts` mounts the player with the drop-in call on a quiet page and on pages written to break it, one of them shaped like a Tailwind 4 page, and compares every computed style and the player's pixels between them.
