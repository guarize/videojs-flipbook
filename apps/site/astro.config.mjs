// @ts-check
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import { layersPlugin } from '../../build/layers.mjs';
import { silentFilm } from '../../build/silent-film.mjs';
import { unscopePlugin } from '../../build/unscope.mjs';

/** @param {string} path */
const repo = (path) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

/**
 * Astro gives a page every stylesheet its scripts reach, dynamic imports included, so the skin's styles (79 KB, fetched
 * with the player on intent) would block the first paint. Vite already lists them with the player's chunks
 * (`__vite__mapDeps`) and loads them with it; this drops the page's copy of any stylesheet listed there, and writes
 * the page's own stylesheet into its head.
 * @type {import('astro').AstroIntegration}
 */
const lazyStyles = {
  name: 'lazy-styles',
  hooks: {
    'astro:build:done': ({ dir }) => {
      const root = fileURLToPath(dir);
      const files = readdirSync(root, { recursive: true, encoding: 'utf8' });
      const deferred = new Set();
      for (const file of files.filter((f) => f.endsWith('.js'))) {
        const map = readFileSync(join(root, file), 'utf8').match(/m\.f=\[([^\]]*)\]/)?.[1] ?? '';
        for (const [, dep] of map.matchAll(/"([^"]+\.css)"/g)) deferred.add(dep.split('/').pop());
      }
      for (const page of files.filter((f) => f.endsWith('.html'))) {
        const path = join(root, page);
        const html = readFileSync(path, 'utf8').replace(/<link rel="stylesheet" href="[^"]*?([^/"]+\.css)">/g, (link, name) => {
          if (deferred.has(name)) return '';
          // What is left is the page's own sheet (7 kB compressed, every URL in it absolute): written into the page,
          // the first paint waits for one response, not two. On a slow connection that is a round trip, 0.3 s or more.
          const sheet = files.find((f) => f.endsWith(`/${name}`) || f === name);
          return sheet ? `<style>${readFileSync(join(root, sheet), 'utf8').replaceAll('</style', '<\\/style')}</style>` : link;
        });
        writeFileSync(path, html);
      }
    },
  },
};

/**
 * The Flipbook site: one static page. The scene code and styles come from apps/preview/src/book and the skin from
 * src/, through the same aliases the Vite workbench uses, so a fix there lands here. The public folder is the
 * workbench's, so the book, the media and the fonts exist once on disk.
 *
 * SITE_BASE serves the build from a subfolder (`SITE_BASE=/flipbook/ pnpm site:build`); every URL the page writes
 * goes through it (src/lib/asset.ts), and the scene code's own URLs are relative to the page.
 *
 * SITE_INDEX=1 is the release switch: without it the page carries `noindex` (src/layouts/Base.astro).
 */
export default defineConfig({
  // The page's public address: the canonical link, og:url and the share picture's URL are written from it
  // (src/layouts/Base.astro). Nothing else on the page prints an origin.
  site: 'https://flipbook.gua.studio',
  base: process.env.SITE_BASE ?? '/',
  output: 'static',
  publicDir: repo('apps/preview/public'),
  outDir: './dist',
  devToolbar: { enabled: false },
  integrations: [lazyStyles],
  vite: {
    // Chunks name their dependencies relative to themselves, as the workbench's `base: './'` build does: the player's
    // prefetch (load-player.ts) resolves them against its own URL, and the build works from any folder.
    experimental: { renderBuiltUrl: (_file, { hostType }) => (hostType === 'js' ? { relative: true } : undefined) },
    // What ships has no `@scope`: Safari mishandles it (build/unscope.mjs has the two defects). And the skin's layers
    // carry names of their own, above a host page's (build/layers.mjs), as in the workbench and library builds.
    css: { postcss: { plugins: [unscopePlugin(), layersPlugin()] } },
    // The battery's film with no audio track, from the dev and preview servers only (never in dist).
    plugins: [silentFilm()],
    resolve: {
      alias: {
        '@preview': repo('apps/preview/src'),
        '@': repo('src'),
      },
    },
    server: { strictPort: true, fs: { allow: [repo('.')] } },
    preview: { strictPort: true },
  },
});
