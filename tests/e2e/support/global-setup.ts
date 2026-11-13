import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FullConfig } from '@playwright/test';
import { ensureStream } from './stream.mjs';

/** The newest modification time under a directory. */
function newest(dir: string): number {
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    latest = Math.max(latest, entry.isDirectory() ? newest(path) : statSync(path).mtimeMs);
  }
  return latest;
}

/**
 * The battery tests the production build, which `pnpm run build` makes as its own step. This refuses to run against
 * a missing build, or one older than the skin or the pages it was built from, so a stale dist/ can't pass. It also
 * makes the battery's local stream if it is missing (stream.mjs).
 */
export default function globalSetup(config: FullConfig): void {
  // The film as a local stream, for the tests of a streamed source: made once, and again after a new film.
  ensureStream();
  if (process.env.BASE_URL) return;
  const root = config.rootDir.replace(/\/tests\/e2e$/, '');
  const built = join(root, 'dist', 'index.html');
  if (!existsSync(built)) throw new Error('No production build: run `pnpm run build` before `pnpm run test:e2e`.');
  const sources = Math.max(newest(join(root, 'src')), newest(join(root, 'apps', 'preview')));
  if (statSync(built).mtimeMs < sources) {
    throw new Error('dist/ is older than src/ or apps/preview/: run `pnpm run build` before `pnpm run test:e2e`.');
  }
}
