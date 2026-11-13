# Agent guide

This project is Flipbook, a Video.js 10 HTML skin. It started from `videojs skin create`, and `skin.json` records how. The skin is everything in `src/skins/flipbook/`, starting from `skin.ts` (it registers the elements and loads the CSS) and `skin.html` (the markup). It also uses `src/shared/` and `src/styles/`. `README.md` describes the rest.

- `src/skins/flipbook/` is the skin. It imports nothing from `apps/`, so it can move into an app as is.
- `apps/site/` is the showcase site (Astro). `apps/preview/` is the workbench: the pages the browser tests open, with the skin alone at `flipbook.html`. Change it only when asked.
- Use the `videojs-skin` skill when changing the skin. `npx @videojs/cli agents skills` prints how to install it.
- Keep every control keyboard operable, labeled, with a visible focus indicator, and in source order that matches its visual order. Keep the error dialog, hotkeys, and status announcer unless you replace them.
- Run `pnpm run typecheck`, `pnpm test` and `pnpm run build` after changes, and check the skin at `flipbook.html` with `pnpm run dev`.
- `pnpm run test:e2e` runs the browser tests against that build, on the silent film and with the browser muted. They need the film, which `pnpm run film:fetch` downloads; `docs/development.md` has the details. No automated browser may play sound: every Playwright context goes through `tests/e2e/support/silence.mjs`, and a test holds the others to it.
- Deploy only when asked.
