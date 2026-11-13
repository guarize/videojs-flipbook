import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vite';

import { silentFilm } from './build/silent-film.mjs';
import { layersPlugin } from './build/layers.mjs';
import { unscopePlugin } from './build/unscope.mjs';

const path = (file: string) => fileURLToPath(new URL(file, import.meta.url));

// The workbench in apps/preview serves the app; `@/` imports reach the skin in src/.
export default defineConfig({
  root: path('./apps/preview'),
  // Relative URLs, so the build works at a domain root or in a subfolder such as GitHub Pages.
  base: './',
  // (silentFilm: the battery's film with no audio track, from the dev and preview servers only; never in dist.)
  plugins: [silentFilm()],
  // What ships has no `@scope`: Safari mishandles it (build/unscope.mjs has the two defects). And its layers carry
  // names of their own, above a Tailwind page's (build/layers.mjs).
  css: { postcss: { plugins: [unscopePlugin(), layersPlugin()] } },
  resolve: {
    alias: {
      '@preview': path('./apps/preview/src'),
      '@': path('./src'),
    },
  },
  server: {
    fs: { allow: [path('.')] },
  },
  build: {
    outDir: path('./dist'),
    emptyOutDir: true,
    rolldownOptions: {
      // The showcase page the browser tests walk, and the player alone.
      input: {
        index: path('./apps/preview/index.html'),
        flipbook: path('./apps/preview/flipbook.html'),
        // Someone else's page, for the hostile-host tests (tests/e2e/hostile.spec.ts).
        host: path('./apps/preview/host.html'),
      },
      output: {
        // The base styles and the shared extras are a chunk of their own, so a page meets the skin's CSS as two
        // stylesheets and tests/e2e/hostile.spec.ts can hold each to the layer order (build/layers.mjs).
        codeSplitting: { groups: [{ name: 'extras', test: /\/src\/(?:shared|styles)\// }] },
      },
    },
  },
});
