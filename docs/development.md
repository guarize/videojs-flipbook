# Development

## Set up

Node 22 and pnpm. The lockfile was written by pnpm 12.9.1.

```sh
npx pnpm@12.9.1 install --frozen-lockfile
```

## The film's files

The film is not in the repository. The 720p file is 38 MB, and the showcase site plays the film from Mux.

```sh
pnpm film:fetch
```

That downloads the film from the live site, checks its size and SHA-256 against `media-src/film/checksums.json`, and writes the copy with no audio track that every automated browser plays. The last step needs `ffmpeg` on the PATH and copies the picture's stream without re-encoding it. Both files land in places git ignores.

| File | Used by |
|---|---|
| `apps/preview/public/media/film/film-720.mp4` | The workbench pages (`pnpm dev`, `pnpm run build`) |
| `test-fixtures/film-720-silent.mp4` | Every automated browser |

`pnpm film:fetch --check` asks the site for each file's size and downloads nothing. `--from <url>`, or `FILM_BASE=<url>`, points it at another address that serves the same paths. The film's tracks, storyboard, stills and posters are committed, so nothing else has to be fetched.

Type checking, the unit tests and all three builds work without the film. The workbench pages load without it and have nothing to play. Each browser test fails at once with a message that names the missing file. They are written against this film's chapters, pages and frames, and `tests/unit/film.test.ts` holds those numbers to the film's own tracks.

To work from a new delivery of the film instead, `node scripts/film-assets.mjs --from <folder>` writes both files along with the storyboard, the stills and the posters. It needs `ffmpeg`, `ffprobe`, `cwebp` and `avifenc` on the PATH, and `media-src/film/notes.md` describes the delivery.

## Commands

```sh
pnpm film:fetch     # the film (above)
pnpm dev            # the workbench: http://localhost:5173, and the player alone at /flipbook.html?bare
pnpm site:dev       # the showcase site: http://127.0.0.1:4402
pnpm typecheck
pnpm test           # unit tests
pnpm run build      # the workbench's production build, into dist/
pnpm test:e2e       # the browser tests, against dist/
pnpm build:lib      # the drop-in bundle, into dist-lib/
pnpm site:check     # the site's type check
pnpm site:build     # the site, into apps/site/dist/
```

`flipbook.html?bare&features=essential` opens the player with the core alone.

## The browser tests

They run against the production build, never the dev server. `pnpm run build` is its own step, and the tests refuse to start if `dist/` is missing or older than the source.

```sh
pnpm run build
pnpm exec playwright test --trace off
```

Chromium and WebKit, two workers. `FB_FEATURES=essential pnpm test:e2e` runs the same tests with the core alone, and tests that need an extra skip themselves.

Firefox runs when asked for, with `FB_FIREFOX=1 pnpm exec playwright test --project=firefox`. The header of `playwright.config.ts` says how to start it on a Mac that will not let Firefox reach its profiles folder.

The tests of a streamed film play a local HLS copy of the silent film, so they ask Mux for nothing. The first run makes it in `test-fixtures/stream/` with `ffmpeg` and `ffprobe` (`tests/e2e/support/stream.mjs`), and it takes a few seconds.

No automated browser may play sound. Every test imports `test` from `tests/e2e/support/test.ts`, which silences each browser context (the film is swapped for its silent copy, and Web Audio never reaches the speakers). `tests/e2e/silence.spec.ts` fails a spec that goes around it.

A run rewrites `design/previews/audit/measurements.json` with what it measured.

## The measured numbers

| File | Written by | Read by |
|---|---|---|
| `design/previews/audit/measurements.json` | the browser tests | the site, the README |
| `design/previews/audit/weights.json` | `node scripts/weights.mjs`, on `dist/` and `dist-lib/` | the site, the README |
| `design/previews/audit/site-lighthouse.json` | `node scripts/site-lighthouse.mjs`, on the site's build | the site, the README |

The site prints its numbers from these files at build time, and `apps/site/src/lib/audit.ts` stops the build if one is missing.

## Other scripts

| Script | What it does |
|---|---|
| `scripts/film-fetch.mjs` | Downloads the film and makes the tests' silent copy (`pnpm film:fetch`) |
| `scripts/film-assets.mjs` | Makes everything the pages serve of the film from a delivery of it |
| `scripts/site-check.mjs` | Checks the built site in Chromium and WebKit |
| `scripts/site-states.mjs` | Takes the stills of the player's states that the site shows |
| `scripts/hero-images.mjs` | Writes the poster at each size |
| `scripts/gallop.mjs` | Cuts the eleven photographs of the gallop for the site's riffle chapter |

## What the build does to the skin's CSS

The skin's CSS is written with `@scope`. The build writes it out as plain selectors (`build/unscope.mjs`), because Safari matches no scoped rule on a shadow host. `design/previews/safari-r1/notes.md` has the defects as they were found.

The build also gives the skin's cascade layers names of their own (`build/layers.mjs`), so they do not meet a Tailwind page's layers. [theming.md](theming.md#on-a-page-with-css-of-its-own) has the reason.

## Deploy

`pnpm run deploy` deploys the workbench's build to Vercel, Netlify or Cloudflare Pages, as the Video.js scaffold set it up. The showcase site is a static build in `apps/site/dist/` and goes to any static host.
