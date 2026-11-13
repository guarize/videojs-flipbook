# Flipbook: accessibility audit (WCAG 2.2 A/AA)

> Written on 9 Nov 2026 against an earlier build and the first film. The fixes that came out of it are held by `tests/e2e/a11y.spec.ts`; today's measurements are in `docs/accessibility.md`. The data, screenshots and scripts this page names were working files and are not in the repository.

Audited on 9 Nov 2026 against the dev server, `src/skins/flipbook/*`, `src/shared/extras/*` and the showcase. Chromium at 1280×800 unless a width is stated, with real key presses. Evidence is in `data/`, `ax/` and `shots/` beside this file. To re-run a check: `node design/previews/audit-a11y/scripts/<name>.mjs` from the repo root, using Node 22.

**Counts:** 1 blocker · 6 serious · 9 moderate · 12 minor.

**What passed:**
- axe found nothing inside the player in all 11 states.
- Text over the brightest and darkest frames reads at least 6.68:1.
- Every target is at least 44 px.
- Under reduced motion nothing moves and no WebGL starts.
- The status announcements aren't chatty: 22 s of playback produced 2 messages.

## Blocker

1. **Forced colours (Windows contrast themes).**
   - `theme.css:116-117` maps `--fb-paper` to `CanvasText` and `--fb-ink` to `Canvas`. Text set in ink on a paper fill comes out white on white. This hits the unselected caption style options, Reset, the Plate key, the title, the speed value and "Watch again".
   - The `.fb-rate` and `.fb-keycap` boxes show blank.
   - Chapter tab numbers read 1.39:1.
   - **Fix:** drop the token overrides. Give controls `ButtonText`/`ButtonFace` and keycaps and tab faces `CanvasText`. Remove `forced-color-adjust: none`.

## Serious

2. **2.4.7. The corner curl has no visible focus ring.** The outline at `skin.css:2252` is painted under the fold's children; only 8 pixels change on focus. **Fix:** an `::after` ring above the fold.
3. **2.1.1, 1.4.4, 1.4.10. The shortcuts card can't be scrolled by keyboard.** At 200 % zoom, 58 % of it can't be reached. **Fix:** `tabindex=0`, `role=region` and `aria-labelledby` on `.fb-keymap`.
4. **2.1.4. Single-character keys work from the page body (`page-keys.ts`) and can't be turned off.** Typing "back" added a bookmark and toggled playback. **Fix:** any one of these: forwarding is opt-in, only non-letter keys are forwarded page-wide, or a persisted on/off switch.
5. **3.3.1, 3.3.3, 1.4.1, 4.1.3. A wrongly typed time is shown only by a red border** (`time-input.ts:92-97`). **Fix:** visible text, linked with `aria-describedby`, and announced.
6. **1.4.3 (showcase). The skip link's text reads 1.00:1 when focused.** The rule `a:not(.media-skin *)` outranks `.skip`. **Fix:** `a.skip { color: var(--ink) }`.
7. **2.4.7 in forced colours. The player's ring and the Plate key's ring disappear** (box-shadow is removed). **Fix:** a `Highlight` outline in the forced-colours block.

## Moderate

8. **1.4.13. Hover content can't be dismissed or hovered.** The deck doesn't close on Escape and closes when the pointer moves onto the cards. Tooltips close when hovered. The "type a time" hint has no dismiss.
9. **1.4.10. Below a 480 px player, mute, volume and PiP have no pointer route.** **Fix:** put them in Settings at narrow widths.
10. **1.4.12. Text spacing at 1280 clips the fullscreen key, and the page counter overlaps "1×".** **Fix:** let the clock shrink, and hide the counter first.
11. **4.1.3. Turning to a chapter announces nothing** (N, tabs, Contents, curl, `[` `]`). **Fix:** announce "Chapter 3: Sprint, 0:17" when the turn lands.
12. **2.4.11 (passes, no margin). The docked mini player covers focused links on a phone.** **Fix:** `scroll-padding-block-end` while docked.
13. **2.3.1 at risk (an estimate, not certified).** In a third-of-frame window, luminance swings 0.10–0.19 about 4.5 times a second, around 0.2–1.3 s, 10.5–11.4 s, 28.5–29.4 s, 48.2 s and 59.0 s. The cause is the Muybridge gallop loop and archive flicker; there is no red flash. **Fix:** run PEAT or Harding; deflicker or slow those shots if needed.
14. **1.2.5, 1.2.2 (content). No audio description, and the captions don't name the music.** **Fix:** `descriptions.vtt`, plus a first caption cue naming the music.
15. **4.1.2. The mute key announces a popup dialog** (`commandfor` at `skin.html:184` adds `aria-haspopup`/`aria-expanded`). **Fix:** remove `commandfor`.
16. **2.4.11. Caption style opens with its focused option scrolled out of view at 320 px** (`preventScroll` at `sheet.ts:126-127`). **Fix:** `scrollIntoView({block:'nearest'})`.

## Minor

17. The plate opens on its own with no announcement. Its grid is unnamed, and the current frame isn't exposed (no `aria-current`).
18. The bar's chapter tabs have no `aria-current`. An empty "Bookmarks" group is exposed.
19. The Settings menu has no name.
20. `text-transform: uppercase` names ("CONTENTS", "KEYS", "SIZE", "NOW") may be spelled out letter by letter.
21. Two keycaps in one shortcut-card row read "Space K". **Fix:** a visually hidden " or ".
22. Back cover headings come after their lists, and an empty Bookmarks heading stays.
23. Caption style says "Press C to show them", but the dialog swallows C (found in the code, not reproduced).
24. The poster has two "Play" Tab stops in a row. **Fix:** `tabindex=-1` on `.fb-cover-play`.
25. `aria-keyshortcuts="Shift+?"` should be `?`. The PiP names contain U+2011 (non-breaking hyphen).
26. Some text controls have faint borders: Reset and Shortcuts 1.00:1, back cover entries about 1.04:1, caption options up to 1.18:1. WCAG passes them; the house standard asks for 3:1.
27. The title truncates to "T…" at 320 px. "Plate" names a feature rather than what it does.
28. Caption styling covers size, background, colour and position; there's no font, opacity or edge style. This is advisory.

## Criteria

**Fail:**
- 1.4.1, 3.3.1 and 3.3.3 (#5)
- 1.4.3 on the showcase (#6)
- 1.4.4 and 2.1.1 (#3)
- 1.4.10 (#3, #9)
- 1.4.12 (#10)
- 1.4.13 (#8)
- 2.1.4 (#4)
- 2.4.7 (#2, #7)
- 4.1.2 (#15, #18, #19)
- 4.1.3 (#5, #11, #17)
- 1.2.5, content (#14)

**At risk:** 2.3.1 (#13).

**Pass, with notes:**
- 1.2.2 partial, content (#14)
- 1.3.1 (#18, #21, #22)
- 1.3.2 (#22)
- 2.4.6 (#27)
- 2.4.11, no margin (#12, #16)

**Pass:**
- 1.1.1, 1.2.3, 1.3.3, 1.3.4
- 1.4.2, 1.4.5, 1.4.11
- 2.1.2, 2.2.1, 2.2.2
- 2.4.1–2.4.4
- 2.5.1, 2.5.2, 2.5.3, 2.5.7, 2.5.8
- 3.1.1, 3.1.2
- 3.2.1–3.2.4
- 3.3.2, minor (#23)

**Not applicable:** 1.2.1, 1.2.4, 1.3.5, 2.4.5, 2.5.4, 3.2.6, 3.3.4, 3.3.7, 3.3.8.

**Display modes:**
- Forced colours: fail (#1, #7).
- `prefers-contrast: more` and `prefers-reduced-transparency`: no rules of their own, nothing breaks.
- `prefers-reduced-motion`: pass.

**Not verified:** a live VoiceOver session (the accessibility trees were read instead), WebKit, the PiP window's own controls, and a certified flash test.
