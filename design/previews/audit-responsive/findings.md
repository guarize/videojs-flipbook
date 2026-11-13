# Flipbook: responsive and device audit (9 Nov 2026)

> Written on 9 Nov 2026 against an earlier build and the first film. The checks that came out of it are in `tests/e2e/responsive.spec.ts`, each named after its finding. The data, screenshots and scripts this page names were working files and are not in the repository.

28 findings: 2 blocker · 10 serious · 11 moderate · 5 minor.

**Method:**
- 35 runs, one per device and orientation, about 30 states each.
- WebKit for the iPhones and iPads. Chromium for Android, the foldable, desktops, the player filling the viewport ("fill"), the 360/480/720 presets and the PiP window sizes.
- Hit areas measured with `elementFromPoint` on the element that takes the click; collisions are rect intersections.
- Tools: `audit.mjs`, `probe.mjs`, `checks.mjs`, `rotate-check.mjs`, `summarize.py` and `matrix.py`. Data is in `data/*.json`; screenshots are in `shots/` and `sheets/`.

**Not verified:** safe areas, the iOS zoom on input focus, and long-press feel, all of which need hardware. Document PiP was mocked.

## Blocker

1. **WebKit keeps the old player width when the viewport narrows (rotation, a resized Safari window), so the page scrolls sideways.**
   - Where: `site.css:271-281` (an auto grid track) and `:371-374`.
   - Evidence: on an iPhone 15 the frame stays 600 px in a 393 px viewport, a 223 px overflow. Safari at 1280 → 700 overflows by 174 px.
   - Fix, verified live: `.canvas { grid-template-columns: minmax(0, 1fr) }`.
2. **The plate doesn't fit short players 480 px or wider:** every phone in landscape, the foldable, and fill at 780×360, 667×375 and 852×393.
   - Where: `plate.ts:297` (full mode chosen by width only), plus the 44 px floor on cells.
   - Evidence: up to 7 of the 12 frames lie under the tabs or the scrubber.
   - Fix: choose full mode by room as well. Make the sheet scroll (`max-height`, `overflow-y: auto`, `overscroll-behavior: contain`). Run `#fit` in full mode too.

## Serious

3. **Chapter-tab hit boxes cover the Plate key and the resume buttons on every player 480 px or wider.**
   - Evidence: the Plate key's hit area is 86×26, and its bottom hit-tests to "Chapter 1".
   - Fix: from 30rem up, set `bottom: calc(var(--fb-slab-top) + 44px)` from one shared token.
4. **Captions collide with the Plate key, the top keys and the slab** (`captions.ts:168-172`).
   - Evidence: on phones in portrait, the Plate key hides the caption's first word.
   - Fix: re-test all obstacles after placing the caption, then narrow it or hide the Plate key while a caption shows.
5. **Below 30rem the scrubber is crushed:** 48–127 px wide on phones in portrait, 51 px in the mini player, and at 288 px it sits 15 px under the time. Fix: show only the elapsed time, or give the scrubber its own row.
6. **Below about 340 px the back cover clips:** the title goes under the top keys and "Watch again" is cut (`cover.css:71-83`, `:130`). Fix: `justify-content: safe center`, `flex-shrink: 0`, and hide the top keys there.
7. **At 288 px the full-screen plate is taller than the player** (the close key is 42×34). Fix: as in finding 2, and size cells by `aspect-ratio`.
8. **The title chip truncates to "T…" next to the T keycap.** Fix: hide the title when it has less than about 72 px of room.
9. **The mini player is sized by width only:** in landscape it covers 77 % of an iPhone SE's height. Fix: a height bound, or don't dock under 480 px tall.
10. **`viewport-fit=cover` without safe-area padding:** the page gutters and the fullscreen controls ignore `env(safe-area-inset-*)`.
11. **The time field is 15 px, so iOS zooms the page on focus** (`skin.css:1142`). Fix: 16 px.
12. **Small and Medium captions are both 14 px under 609 px.** Fix: floors of S 14, M 16, L 19, XL 22.

## Moderate

13. The seek chip lands on the play key or the time (`skin.css:2011-2043`). Fix: clamp it inside the scrubber.
14. The hint slip covers the Plate key on phones and the back-cover title. Fix: no hints on the back cover; place hints with the captions' obstacle pass.
15. The error dialog opens scrolled to OK at 288×162, and Chromium shows the raw media error. Fix: tighter padding, reset the scroll, and use the skin's own wording.
16. The next-chapter key never appears on this film (chapters of 5.7–17.1 s against a 30 s threshold), but the showcase promises it. When forced open, it overlaps the Rush tab. Fix: drop the promise, and lift the key clear of the tabs.
17. The plate's close key is 42–44 × 24–36 and overlaps frame 4 (`skin.css:2570`). Fix: a 44 px header.
18. At 288 px the cover's title plate runs under the slab, and the play disc touches the keys and the tabs' hit boxes.
19. At 288 px the resume offer sits under the top keys.
20. Tabs 2 and 3 have 42 px hit areas at 523 px and overlap at 480 px.
21. Sentence text inside the player is 14–15 px: hints, buttons, the shortcut card's descriptions, the cover's chapter names. Nothing is under 12 px.
22. In fullscreen phone landscape the controls cover about 45 % of the picture. Fix: a height axis, and the one-row bar under about 420 px tall.
23. An open plate doesn't re-lay itself out on rotation or resize (no ResizeObserver).

## Minor

24. Caption style's Reset and Done start out of view on phones. Fix: pin the footer.
25. At 288 px the settings menu cuts its last item with no scroll cue.
26. The lifted corner (`touch-action: none`) blocks page scrolls that start on it.
27. Tab names, ribbon labels and the "type a time" hint are hover/focus-only, so touch users never see them.
28. WebKit computes `user-select: text` on the controls. The corner label sits at a fractional x at 1×.

## Checked and clean

- No horizontal scroll at 320–2560, outside finding 1.
- Layout shift is 0 in Chromium.
- No text under 12 px, and no fractional borders at 2×, 2.625× or 3×.
- Tap highlight is off, there's no double-tap zoom on controls, dragging the scrubber never scrolls, and pinch zoom is allowed.
- Every hover style is gated to mouse devices.
- The panels scroll inside the player.
- The showcase passes the 16 px body floor and 44 px targets.
