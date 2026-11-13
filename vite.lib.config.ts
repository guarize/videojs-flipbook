import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vite';

import { layersPlugin } from './build/layers.mjs';
import { unscopePlugin } from './build/unscope.mjs';

const path = (file: string) => fileURLToPath(new URL(file, import.meta.url));

// Flipbook as a drop-in bundle for other sites (src/skins/flipbook/standalone.ts): one ES module and its stylesheet.
export default defineConfig({
  // What ships has no `@scope`: Safari mishandles it (build/unscope.mjs has the two defects). And its layers carry
  // names of their own, above a Tailwind page's (build/layers.mjs).
  css: { postcss: { plugins: [unscopePlugin(), layersPlugin()] } },
  resolve: {
    alias: {
      '@': path('./src'),
    },
  },
  build: {
    outDir: path('./dist-lib'),
    emptyOutDir: true,
    copyPublicDir: false,
    cssCodeSplit: false,
    sourcemap: true,
    lib: {
      entry: path('./src/skins/flipbook/standalone.ts'),
      formats: ['es'],
      fileName: () => 'flipbook.js',
      cssFileName: 'flipbook',
    },
    rolldownOptions: {
      preserveEntrySignatures: 'allow-extension',
      output: {
        // A library's ES output keeps its whitespace and its module-path comments by default (names are shortened,
        // nothing more: Vite leaves it readable for the host's own bundler). This one is also loaded as it is, from
        // a page with no bundler (`<script type="module">`), so it ships fully minified, with a source map beside it
        // for whoever debugs it. Nothing in the skin reads a class or a function by its name.
        minify: true,
        // The core is everything the entry imports statically: one file, flipbook.js, fetched in one go. The book's
        // extras (features.ts) and Video.js's locales stay chunks of their own beside it, fetched when used.
        codeSplitting: {
          groups: [{ name: 'flipbook', tags: ['$initial'] }],
        },
      },
    },
  },
});
