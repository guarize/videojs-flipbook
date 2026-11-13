/**
 * The stills of the player's states (scripts/site-states.mjs writes them and their manifest into the public folder).
 * Read at build time: a state the copy names with no still fails the build, so the sheet never shows a hole.
 */
import manifest from '../../../preview/public/book/states/manifest.json';
import { asset } from './asset';

interface Still {
  width: number;
  height: number;
  widths: number[];
}

/** The paused player down to its strip of frames, for the Plate chapter (scripts/site-states.mjs writes it). */
export function platePage() {
  const size = (manifest as { plate?: { width: number; height: number } }).plate;
  if (!size) throw new Error('stills: no plate page in apps/preview/public/book/states/manifest.json. Run node scripts/site-states.mjs.');
  return { src: asset('book/plate-page.webp'), ...size };
}

export function still(id: string, sizes: string) {
  const entry = (manifest.stills as Record<string, Still | undefined>)[id];
  if (!entry) throw new Error(`stills: no still for "${id}" in apps/preview/public/book/states/manifest.json. Run node scripts/site-states.mjs.`);
  const file = (width: number, type: string) => asset(`book/states/${id}-${width}.${type}`);
  const set = (type: string) => entry.widths.map((width) => `${file(width, type)} ${width}w`).join(', ');
  return { avif: set('avif'), webp: set('webp'), src: file(entry.widths[0] as number, 'webp'), width: entry.width, height: entry.height, sizes };
}
