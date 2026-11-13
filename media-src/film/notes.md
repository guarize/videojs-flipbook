# Film notes: "Locomotion"

The film the player and the showcase play: a book of Eadweard Muybridge's motion photographs opened, turned and riffled on a desk, rendered with three.js to "Origami" by Scott Buckley. It is made in its own project (`flipbook-film`); this folder holds what that project delivers, and `CREDITS.md` has the sources, licences and the credit line the site and the README print word for word.

## Delivered (v1.1, 11 Nov 2026)

| File | | Tracked |
|---|---|---|
| `film-720.mp4` | 1280 × 720, H.264, 24 fps constant, 98.000 s, 2,352 frames, a keyframe every second, the moov atom at the front, AAC stereo; 33 MB | no (git-ignored) |
| `film-1080.mp4` | the same film at 1920 × 1080, 114 MB; the source of the sharp stills, never served | no |
| `poster-1.jpg`, `poster-2.jpg`, `poster-3.jpg` | 1920 × 1080 stills: 0:24.0 the gallop from overhead, 0:33.5 the open book on the desk, 1:23.0 the torn page | no |
| `poster.jpg` | the one in use, a copy of `poster-2.jpg` | no |
| `chapters.vtt` | six: The Book 0:00 · One Gallop 0:12.583 · The Herd 0:36.583 · Flight 1:09 · Torn Out 1:18.583 · Colophon 1:28.167 | yes |
| `captions.vtt` | 14 cues; the first names the music, bracketed cues are sounds | yes |
| `descriptions.vtt` | 13 cues describing the picture, for a browser or screen reader that speaks a descriptions track | yes |
| `measured.json` | the film project's own measurements (in Portuguese): flashes at most 2 a second, −16.0 LUFS, brightest and darkest frames | yes |

## What the pages serve

`node scripts/film-assets.mjs` writes all of it from this folder (`--from <folder>` copies a new delivery in first; `--poster <n>` changes the poster alone):

- `apps/preview/public/media/film/`: the 720p film and the three tracks; `storyboard.jpg` + `storyboard.vtt`, 52 pages of 284 × 160, one every 1.92 s (the length ÷ 51, to a hundredth; the last page is the 0.08 s that is left); `frames/`, one 1280 × 720 still per page from the 1080p; the poster at 480, 768, 1280 and 1920 px as AVIF and WebP.
- `apps/preview/public/book/pages/` and `plate/`: the pages at 800 px and the twelve frames round 0:20 for the showcase's scenes.
- `test-fixtures/film-720-silent.mp4`: the film with no audio track, for every automated browser.

Then, for what pictures the player or the book: `node scripts/site-states.mjs` (the stills of the player's states, from a build of the site) and `python3 design/directions/2-the-object/make-assets.py && node design/directions/2-the-object/render-macro.mjs` (the fore-edge macro). `tests/unit/film.test.ts` holds the numbers typed in the tests and the scenes to these tracks.

## The two frames contrast is measured over

Mean luma of every frame of the 720p (`ffmpeg signalstats`, 16–235). The brightest stretch is the colophon's paper page, 161.5–161.6 from 1:28.167 to 1:28.6; the tests pause at 1:28.56, the first of those frames with a caption up. The darkest is the opening: 15.4 at 0:00.0, where the player shows its cover, so the tests pause at 0:00.5 (16.0). After the opening the darkest passage is the fade at the end (72 at 1:37.9).
