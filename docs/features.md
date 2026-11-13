# Features

A small core loads at once. Each of the book's extras is a chunk of its own, fetched on first use or when the page is idle, and never required. This page describes each one. The sizes are in the [README](../README.md#choose-what-loads).

## Choosing them

Set `features` on `<video-player>`, as one of two presets or a space-separated list.

| Value | What loads |
|---|---|
| `essential` | The core alone |
| `book` | Every extra. This is the default when the attribute is missing. |
| a list | The core and the extras named, such as `features="essential plate ribbons"` |

With the drop-in bundle, pass `{ features: 'essential' | 'book' | string[] }` as the third argument of `mountFlipbook`.

`features` can change while the film plays. Removing an extra closes its parts and puts focus somewhere sensible. Adding one loads it. Nothing reloads the player or interrupts playback. An extra that is off is never fetched, its keys do nothing, and its rows leave the shortcuts card.

After the page's `load` and the player's first paint, each enabled extra is prefetched on idle. A key pressed before its extra has arrived waits for it and then does what it would have done. With Save-Data on, or on a 2G connection, nothing is prefetched and each extra loads the first time it is used.

## The core

Always on.

- **The control bar.** Play, back and forward 10 s, volume and mute, a time you can type to seek, when you will finish, speed, captions, settings and fullscreen. A seek by key or button shows its count over the playhead (+10 s, then +20 s as the presses add up).
- **Where the film plays from.** One address or a list tried in order, a stream first and files after it (`sources.ts`). For a stream on Mux, Settings has a Quality page with Auto and each height the stream offers. It is a small chunk of its own, fetched only for such a film.
- **AirPlay and Cast.** A key for each appears when the browser says a receiver is there, and goes when it says there is none. Nothing else in the bar moves when one comes or goes (`tests/e2e/receivers.spec.ts`).
- **The fore-edge timeline.** It is painted with the film's storyboard and carries the playhead ribbon, the chapter tabs and fine scrubbing. Page Up and Page Down go by chapter. On hover or drag it shows a print of the page under the pointer with its page number, chapter and time.
- **Still pictures becoming film.** The first play from the poster riffles the first pages under the ribbon, once. Paused, the picture takes a print's border and a page stamp.
- **Captions** drawn by the skin and kept clear of the controls, with a caption style page (<kbd>Shift</kbd> <kbd>C</kbd>).
- **The shortcuts card** (<kbd>?</kbd>).
- **Resume**, the system's media controls (title, chapter and artwork, with previous and next going by chapter), captions inside the browser's picture-in-picture, and the status announcer.
- **The phone layout.** On a player under 480 px wide the picture is the film's alone and the controls are a pad under it. See [the phone](#the-phone) below.
- **A film with no storyboard.** It has no pages, so the timeline is Video.js's own slider and the extras that are made of pages (`turns`, `deck`, `contents`, `plate`, `curl`, `next`, `hints`) stay off whatever `features` asks. The cover, bookmarks, a kept page, picture-in-picture and intertitles still work.
- **Reduced motion, forced colours and every accessibility fix.** None of them is a feature you can turn off.

## The book

| Extra | What it adds | Without it |
|---|---|---|
| `deck` | Flipping by hand. A drag, a flick, the wheel or a held arrow on the fore-edge moves the film itself at the hand's speed. A flick throws it at no more than 4× and it settles to exactly 1×, playing. A click on the edge goes there and leaves the film as it was. <kbd>Esc</kbd> during a drag puts the film back where the press began. On a touch screen a swipe across the picture does the same, and right is on. Paused, the picture takes a paper margin with its page number and chapter, and <kbd>←</kbd> and <kbd>→</kbd> turn exactly one page. A soft page sound goes with the hand. | The core's preview card, Video.js's own seek slider, and a thin print border |
| `turns` | Paper page turns (WebGL) for chapter jumps, the opening cover, the Contents page and the back cover | The picture cuts to the new place |
| `contents` | The Contents page (<kbd>T</kbd>) | Chapters stay on the tabs and in Settings |
| `ribbons` | Bookmark ribbons (<kbd>B</kbd>, <kbd>[</kbd> and <kbd>]</kbd>) | No bookmarks |
| `plate` | The paused page's strip, and the plate. See [the paused page](#the-paused-page). | The paused page without the strip |
| `curl` | A lifted corner while paused that turns to the next chapter. Not on a phone's picture, where the tabs are a thumb away. | Nothing |
| `cover` | A designed jacket at the start and a back cover at the end | A plain poster, and the film just ends |
| `pip` | The whole book in a Document Picture-in-Picture window, with a waiting page and a live fore-edge left in its place | The browser's own picture-in-picture |
| `hints` | One-time hints | Nothing |
| `next` | "Next" and the chapter's name in a long chapter's last seconds. <kbd>N</kbd> stays in the core. | Nothing |
| `float` | A docked mini player when the page scrolls the film away. It also needs `data-fb-float` on the player or a parent. | Nothing |
| `ear` | The dog-ear. A bookmarked page's top-left corner folds down, and unfolds with an Undo beside it. It needs `ribbons`, since the two share one list of bookmarks. | The ribbons and <kbd>B</kbd> alone |
| `tear` | Tear out the paused page. Pull it, press <kbd>S</kbd>, or use "Keep this page" for a PNG of the frame set as a page. A touch screen that can share files gets the share sheet, and everything else gets a download. It also makes a link (`#p=31`) that opens the film on that page, at rest, in place of the cover. | No <kbd>S</kbd> key and no link reader |
| `intertitle` | "Intertitle" on the caption style page. The cue is set in ink on the page under the picture. | Captions on the picture only |

The page sound is quiet, plays only while a hand is on the edge, never before a press or key in the player, and follows the film's mute and volume. "Page sound" in Settings turns it off and is remembered. A page can take it away with `data-fb-flutter="off"` on the player or an ancestor.

## The paused page

With `plate` on, nothing lies over a paused frame. The twelve frames around the moment are printed as one thin row in the page's foot. There are six before, the one you are on, and five after, a sixth of a second apart. Choosing a frame turns the page to it.

<kbd>P</kbd>, or the Plate key at the head of the strip, lays the same twelve out large, four by three. On a phone the Plate key is in Settings. The plate never opens by itself.

When the film plays from a stream, the strip and the plate are read from the `scrub` copy, so each frame is the moment's own.

The strip shows wherever the picture keeps at least 56 % of its height in sight over it. That is from about 840 px wide, and on a phone, where the controls are under the picture and the strip scrolls sideways. On smaller players the Plate key stands alone. With intertitles on, the band under the picture is the caption's and there is no strip. `tests/e2e/plate.spec.ts` measures that the picture is exactly as large with the strip as without it.

For a film that plays from a file, the frames are read from a muted copy of it kept while the page is paused and let go on play.

## The phone

On a player under 480 px wide the pad under the picture is 220 px tall. From the top it holds the chapter tabs, the fore-edge as a strip the whole width, the chapter and page as a running foot, the book's own keys by name (Contents, Bookmark, Caption style), and the transport row with a large Play, Mute, the time, captions, Settings and fullscreen. A page that wants no layout shift keeps 220 px free under the player at those widths.

- A tap on the picture plays and pauses.
- A swipe across it flips the film under the thumb, and right is on.
- A double tap on a side skips 10 s.
- A hold plays at 2×.
- Up and down still scroll the page.

Settings is a sheet from the foot of the screen. It carries what has no key on the pad (Keep this page, Plate, volume, picture-in-picture, Quality for a stream on Mux, AirPlay or Cast when there is a receiver), so the paused picture keeps only the print. Fullscreen and volume keep their conventional glyphs on a touch screen, which has no tooltip to name a new one.

Where a page cannot ask for fullscreen, as on an iPhone, the key fills the window with the player's own controls, clear of the notch and the home indicator. A page that holds the player in a box of fixed height has no room for the pad. There the controls stay a small slab over the film.

## The details

Small touches on the controls, each behind a token in `details` on `<video-player>`, or `data-fb-details` on the container.

| Token | What it does |
|---|---|
| `cloth` | The control slab as bookcloth with a gilt hairline |
| `type` | Keycaps as type sorts |
| `folio` | The page number in a serif (Newsreader) |
| `icons` | The book's own glyphs. One at a time with `icon-fullscreen`, `icon-volume` and `icon-settings`. |
| `sheaf` | The volume fader as a sheaf of pages |
| `lift` | A key's plate rises 2 px under the pointer |
| `states` | The error as a missing page with Try again |

The full book has all of them unless the page says otherwise. The book's glyphs are new shapes, so each key keeps its exact name and tooltip. `features="essential"` has none of them and fetches none.
