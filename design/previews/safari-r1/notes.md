# Flipbook in real Mobile Safari, round 1 (11 Nov 2026)

> Written on 11 Nov 2026. The captures and the harness this page names were working files and are not in the repository. The guards at the end of the page are.

Instrument: the iOS Simulator's own Mobile Safari, iOS 26.5 (iPhone 17 Pro, 402 × 874) and iOS 18.2 (iPhone 16,
393 × 852). Chromium and Playwright's WebKit build showed none of the three defects below: only the simulator did.
Captures are in `before/` and `after/` (not committed), with `sheet.jpg` as the before | after contact sheet.

## The harness (`harness/`)

- `serve.mjs <dir> <port>`: a static server (ranges, gzip) that swaps the film for its silent copy
  (`test-fixtures/film-720-silent.mp4`) and puts `dbg.js` first in the page's head. One port per simulator.
- `dbg.js`: turns the page-flutter and Web Audio off, sends errors, rejections and failed loads to the server's log,
  and polls the server for script to run: a console for a browser that has none.
- `run.sh <port> '<js that returns a value>'`: runs it in the newest tab on that port and prints the result.
- `shoot.sh <udid> <port> <dir> <prefix>`: walks the page in small steps, then captures each chapter at three stops.
- `logical2.js`: the test that maps defect 3. `head.mjs <url>`: the headline at 360 to 430 px and on its side.
- On the page itself: `?debug=1` prints the same facts on the page (apps/site/src/scripts/debug.ts), for a real phone.

## Three WebKit defects, each reduced to a test run in the page

1. **A rule inside `@scope` never matches a shadow host, nor an element slotted into one** (18.2 and 26.5).
   A `div.media-poster` appended to the player computes `position: absolute`; give the same div a shadow root and it
   computes `static`; an `img.media-poster-image` slotted into it computes `object-fit: fill`. Video.js's
   `<media-poster>` and `<media-slider-thumbnail>` are shadow hosts. The poster lay under the player's box, 402 × 724,
   its image at 1280 × 720: the hero was black.
2. **In 18.2, changing an attribute on a scope's root does not restyle `:scope[attr]`.** After
   `toggleAttribute('data-fb-pad', false)` the container's `margin-bottom` still computed 172px. The phone layout
   (measured once, against a stale 0) was refused on a cold load, and the keys' icons kept the wrong state.
3. **In 26.5, under the armour's unlayered `all: revert-layer`, a logical shorthand holding `var()` or `env()`
   computes to nothing**: `padding-inline`, `padding-block`, `margin-inline`, `margin-block`, `inset-inline`,
   `inset-block`, `border-inline`, `border-block` and their `-width` / `-color`, `scroll-margin-inline`,
   `scroll-padding-block`. The longhands (`padding-inline-start: var(--x)`), the physical sides, and a shorthand with
   a literal value all hold. 18.2 is not affected. The fullscreen top row lost its notch inset, the plate's strip
   its margin.

## What changed

- `build/unscope.mjs`: `@scope` written out as plain selectors of the same weight when the CSS is built (all three
  Vite configs). The source keeps `@scope`; nothing that ships has it. Checked in Chromium on the same source built
  both ways: 1,412 boxes of the player with their `::before` and `::after`, every computed property, at 390, 768 and
  1280 px, with the menu and the sheet open: the only differences were the film's buffered amount.
- Logical shorthands with `var()` / `env()`: three, replaced (skin.css, phone.css, plate.css).
- The iPhone's fill (`data-fb-fill`) takes the insets `:fullscreen` had: the page stamp, the Keep key, the slip.
- The phone headline: three lines at 29 to 36 px, heads and figures stepped down under it; two lines on a phone on
  its side.
- Page keys (`.preset-key`, `.frame-key`): a long press selects nothing.

## Guards

- `tests/unit/unscope.test.ts`: the rewriting's weights, nested scopes, refusals; no `@scope` left in any source sheet.
- `tests/unit/flipbook-armour.test.ts`: no logical shorthand with `var()` or `env()` (it flags the committed skin.css
  and phone.css).
- `scripts/site-check.mjs`, first block: no `@scope` in any stylesheet or script the page fetched (fails on a build
  made without the plugin: 8 files named), and the player's poster is a picture, in the player's box.
