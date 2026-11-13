/**
 * The first screen's pictures, at the sizes screens ask for.
 *
 * The player's poster is the page's largest paint. One 1920 px file (128 kB) for every screen made a phone on a slow
 * connection wait for six times the pixels it can show; these are the same picture at 480, 768, 1280, 1920 and 2560 px,
 * as AVIF and WebP, for the `<picture>` in Hero.astro. (2560: the player is up to 1160 px wide, 2320 device pixels on
 * a screen of two to the pixel. It is made only from the poster at 3840 px; without that file the old copy is removed.) `media/film/posters.json`
 * lists the widths made, and Hero.astro offers exactly those. The loose pages under the player are 800 px files shown 130 to
 * 240 px wide: each gets a 400 px copy for screens that need no more.
 *
 * - `media/film/poster-<w>.avif`, `media/film/poster-<w>.webp` from `media-src/film/poster-2160.jpg` (3840 × 2160)
 *   where the film's delivery has it, else from `media-src/film/poster.jpg` (1920 × 1080): the still
 *   scripts/film-assets.mjs picked;
 * - `book/pages/p-<n>-400.webp` from `book/pages/p-<n>.webp`, for the pages Hero.astro lays out.
 *
 * `media/film/poster.webp` (1920, scripts/film-assets.mjs) is the share image, and the player's poster where no page
 * lays one.
 *
 * Usage: `node scripts/hero-images.mjs` (needs ffmpeg, cwebp and avifenc on the PATH); scripts/film-assets.mjs runs it
 * after it has written the poster and the pages.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const pub = (path) => repo(`apps/preview/public/${path}`);
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] });

/** The widths of the poster, and the loose pages (0-based, as Hero.astro names them). */
const POSTER_WIDTHS = [480, 768, 1280, 1920];
/** Wider than the 1920 px still: made from the 3840 px one alone. */
const POSTER_WIDE = 2560;
const LEAVES = [9, 23, 28, 32, 39, 45];

const scaled = (from, width, png) => run('ffmpeg', ['-v', 'error', '-y', '-i', from, '-vf', `scale=${width}:-2:flags=lanczos`, '-frames:v', '1', png]);
const kb = (file) => `${(statSync(file).size / 1000).toFixed(1)} kB`;

const large = repo('media-src/film/poster-2160.jpg');
const source = existsSync(large) ? large : repo('media-src/film/poster.jpg');
if (source !== large) for (const type of ['avif', 'webp']) rmSync(pub(`media/film/poster-${POSTER_WIDE}.${type}`), { force: true });
const widths = source === large ? [...POSTER_WIDTHS, POSTER_WIDE] : POSTER_WIDTHS;
writeFileSync(pub('media/film/posters.json'), `${JSON.stringify({ widths })}\n`);
for (const width of widths) {
  const png = pub(`media/film/poster-${width}.png`);
  scaled(source, width, png);
  const avif = pub(`media/film/poster-${width}.avif`);
  const webp = pub(`media/film/poster-${width}.webp`);
  run('avifenc', ['-q', '55', '-s', '3', '-y', '420', png, avif]);
  run('cwebp', ['-quiet', '-q', '72', '-m', '6', png, '-o', webp]);
  rmSync(png);
  console.log(`poster ${width}: avif ${kb(avif)}, webp ${kb(webp)}`);
}

for (const n of LEAVES) {
  const name = `book/pages/p-${String(n).padStart(2, '0')}`;
  const png = pub(`${name}-400.png`);
  scaled(pub(`${name}.webp`), 400, png);
  run('cwebp', ['-quiet', '-q', '70', '-m', '6', png, '-o', pub(`${name}-400.webp`)]);
  rmSync(png);
  console.log(`page ${n}: ${kb(pub(`${name}.webp`))} at 800, ${kb(pub(`${name}-400.webp`))} at 400`);
}
