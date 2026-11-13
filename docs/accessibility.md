# Accessibility, measured

Each claim on this page is a browser test in `tests/e2e/`, run with real key presses in Chromium and WebKit against the production build. The tests write their measurements to `design/previews/audit/measurements.json`. Where the two browsers differ, the lower number is the one quoted. The same tests also pass in Firefox when it is asked for (`FB_FIREFOX=1`).

## Contrast over the film itself

Every visible label, time, tab, keycap, caption and icon is measured against the pixels composited behind it. The film is paused on its brightest frame (1:28.56, the colophon's paper page) and its darkest (0:00.50, the opening before the light comes up). `media-src/film/notes.md` says how those two frames were found.

The bar is 4.9:1 for text under 24 px and 3.4:1 for icons, large text and the playhead's edge. That is WCAG AA plus a margin of 0.4.

| Accent | Text | Icons | Playhead edge | Captions |
|---|---|---|---|---|
| Shipped red, 1280 px | 5.15:1 | 12.87:1 | 8.96:1 | 14.08:1 |
| Rebranded blue, 1280 px | 5.49:1 | 12.87:1 | 8.96:1 | 14.08:1 |
| Shipped red, a 390 px phone | 5.15:1 | 13.39:1 | 7.05:1 | not measured |

The lowest text pair is the number on the strip's current frame, paper on the accent's text red. The rebranded run uses the block in [theming.md](theming.md). The test is `contrast.spec.ts`.

## Targets

Targets are measured on the element that takes the click, with a coarse pointer, at 360, 768 and 1280 px. The smallest is 44 × 44 px at each width (`targets.spec.ts`).

On a phone the fore-edge is a strip that is all the slider's, and each chapter tab is its own target of 44 px or more.

## Keyboard

Tab order follows the screen. Walking the player with <kbd>Tab</kbd> reaches 15 stops, and every stop shows a ring in both browsers. The ring is read from computed styles and cropped to be looked at (`keyboard.spec.ts`). <kbd>Esc</kbd> closes the menus and panels and returns focus to the key that opened them. The whole map is in [keyboard.md](keyboard.md).

Letter, number and symbol keys reach the player only while it has focus or the pointer is over it (WCAG 2.1.4). There is no switch to find.

## Automated checks

axe finds no violations of WCAG 2.0 and 2.1, A and AA, in 10 scans that covered 8,777 nodes. The smallest scan looked at 788 nodes, so an empty scan cannot pass as a clean one (`layout.spec.ts`, `a11y.spec.ts`).

The page does not scroll sideways at 360, 390, 768, 1024 or 1280 px, and nothing shifts over load and first play (`layout.spec.ts`, Chromium for the layout shift).

## Forced colours

Windows contrast themes get the system's colours on each part by what it is. A control, a keycap, a surface, a selection and a focus ring each take their own system colour. Every label, keycap and value spans at least 4.5:1 from its darkest to its lightest pixel, and the focus ring is drawn in the system highlight colour (`a11y.spec.ts`). This runs in Chromium, the one engine that can emulate forced colours.

## Reduced motion

Nothing travels. Each still state is photographed twice, 800 ms apart, and the two frames must be identical byte for byte (`motion.spec.ts`). The WebGL page turn is never created.

## Names

- Each frame of the paused page's strip is named "Frame 4 of 12, 0:19.5", and the one you are on is `aria-current`.
- Two keycaps in one row of the shortcuts card are read as alternatives, "Space or K".
- Turning to a chapter announces it once.
- The book's own glyphs are new shapes, so each key keeps its exact name and tooltip ("Volume", "Settings", "Full screen").

## The film

The film has English captions, a chapters track and a descriptions track for a browser or screen reader that speaks one. The first caption names the music.

## What was not tested

- **Flashes.** There was no certified run with PEAT or the Harding test. The film's own frame analysis (`media-src/film/measured.json`) found at most two general flashes in any second, and the limit is three.
- **Screen readers.** Names, roles and states are read from the accessibility tree. There was no full session with VoiceOver or NVDA.
- **Real devices.** Mobile Safari was run in the iOS Simulator on iOS 18.2 and 26.5, and on one iPhone on iOS 27.2.1. No Android device was used.

Two earlier audits are kept as they were written, at `design/previews/audit-a11y/findings.md` and `design/previews/audit-responsive/findings.md`. The tests cite them by finding.
