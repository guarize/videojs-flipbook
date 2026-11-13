/**
 * Everything the pages serve of the film, made from its delivered files in `media-src/film/` (the 720p and 1080p
 * films and the poster stills are git-ignored there; the tracks and the credits are tracked).
 *
 * Into `apps/preview/public/media/film/`:
 * - `film-720.mp4`, `captions.vtt`, `chapters.vtt`, `descriptions.vtt`: copied;
 * - `storyboard.jpg` + `storyboard.vtt`: the book's pages. Always 52 of them (the book on the page has 52 cards):
 *   a page every `duration ÷ 51` seconds, rounded to a hundredth, the last one whatever is left. Tiles of 284 × 160,
 *   five across, from the 720p;
 * - `frames/f-NN.webp` + `frames.json`: one sharp still per page (1280 × 720, from the 1080p), the frame on screen at
 *   the page's start;
 * - `poster.webp` and `poster.avif` (1920 px) and `share.jpg` (1200 × 630, the picture a link preview shows), then
 *   `scripts/hero-images.mjs` for the sizes the first screen asks for. A delivery that carries the poster at 3840 px
 *   (`poster-N-2160.jpg`) has every size made from that one, so the largest are true pixels, scaled once.
 *
 * Into `apps/preview/public/book/`: `pages/p-NN.webp` (each page at 800 px, for the page's scenes). And
 * `test-fixtures/film-720-silent.mp4`, the film with no audio track, for every automated browser.
 *
 * Usage (needs ffmpeg, ffprobe, cwebp and avifenc on the PATH):
 *   node scripts/film-assets.mjs                 everything
 *   node scripts/film-assets.mjs --from <folder> the same, after copying a new delivery of the film into media-src/film/
 *   node scripts/film-assets.mjs --poster 3      the poster alone, from media-src/film/poster-3.jpg
 *   node scripts/film-assets.mjs --from <folder> --poster 3   a new delivery, everything, with that poster
 * After a change of poster or film, the stills that picture the player: `node scripts/site-states.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const src = (name) => repo(`media-src/film/${name}`);
const film = (name) => repo(`apps/preview/public/media/film/${name}`);
const book = (name) => repo(`apps/preview/public/book/${name}`);
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] }).toString();
const ffmpeg = (...args) => run('ffmpeg', ['-v', 'error', '-y', ...args]);
const two = (n) => String(n).padStart(2, '0');
const kb = (file) => `${(statSync(file).size / 1000).toFixed(1)} kB`;

/** What the pages serve as delivered. */
const DELIVERED = ['film-720.mp4', 'captions.vtt', 'chapters.vtt', 'descriptions.vtt'];
const PAGES = 52;
const TILE = { w: 284, h: 160, cols: 5 };
/** The poster in use (the open book on the desk); `--poster <n>` picks another. */
const POSTER = 2;

function poster(n) {
  copyFileSync(src(`poster-${n}.jpg`), src('poster.jpg'));
  // The same still at 3840 px, where the delivery has it: what every size is scaled from (scripts/hero-images.mjs too).
  rmSync(src('poster-2160.jpg'), { force: true });
  if (existsSync(src(`poster-${n}-2160.jpg`))) copyFileSync(src(`poster-${n}-2160.jpg`), src('poster-2160.jpg'));
  const from = existsSync(src('poster-2160.jpg')) ? src('poster-2160.jpg') : src('poster.jpg');
  const png = film('poster.png');
  ffmpeg('-i', from, '-vf', 'scale=1920:-2:flags=lanczos', '-frames:v', '1', png);
  run('cwebp', ['-quiet', '-q', '82', '-m', '6', png, '-o', film('poster.webp')]);
  run('avifenc', ['-q', '55', '-s', '3', '-y', '420', png, film('poster.avif')]);
  rmSync(png);
  // The share picture a link preview shows: 1200 × 630, the poster's middle, a JPEG (not every preview reads WebP).
  ffmpeg('-i', from, '-vf', 'scale=1200:-2:flags=lanczos,crop=1200:630', '-frames:v', '1', '-q:v', '3', film('share.jpg'));
  console.log(`poster ${n}${from === src('poster.jpg') ? '' : ' (from 3840 px)'}: webp ${kb(film('poster.webp'))}, avif ${kb(film('poster.avif'))}`);
  execFileSync('node', [repo('scripts/hero-images.mjs')], { stdio: 'inherit' });
}

const option = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
// The poster alone, unless a new delivery comes with it: then everything is made, with that poster.
if (option('--poster') && !option('--from')) {
  poster(Number(option('--poster')));
  process.exit(0);
}
if (option('--from')) {
  mkdirSync(repo('media-src/film'), { recursive: true });
  const delivery = (name) => `${option('--from').replace(/\/$/, '')}/${name}`;
  for (const name of [...DELIVERED, ...[1, 2, 3].map((n) => `poster-${n}.jpg`), 'film-1080.mp4', 'CREDITS.md', 'measured.json']) {
    copyFileSync(delivery(name), src(name));
  }
  // The posters at 3840 px are a delivery's option: an older one's copies never stand in for a newer film's.
  for (const name of [1, 2, 3].map((n) => `poster-${n}-2160.jpg`)) {
    rmSync(src(name), { force: true });
    if (existsSync(delivery(name))) copyFileSync(delivery(name), src(name));
  }
}

const probe = (entries) => run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', entries, '-of', 'csv=p=0', src('film-720.mp4')]).trim();
const duration = Number(probe('format=duration'));
const [rateN, rateD] = probe('stream=r_frame_rate').split('/').map(Number);
const fps = rateN / rateD;
const step = Math.round((duration / (PAGES - 1)) * 100) / 100;
const starts = Array.from({ length: PAGES }, (_, i) => Math.round(i * step * 100) / 100);
/** The frame on screen at a time. */
const frameAt = (time) => Math.floor(time * fps + 1e-6);
const pick = (times) => `select='${times.map((t) => `eq(n,${frameAt(t)})`).join('+')}'`;
console.log(`film: ${duration.toFixed(3)} s at ${fps} fps; ${PAGES} pages, one every ${step} s`);

// The film and its tracks.
mkdirSync(film('frames'), { recursive: true });
for (const name of DELIVERED) copyFileSync(src(name), film(name));
mkdirSync(repo('test-fixtures'), { recursive: true });
ffmpeg('-i', src('film-720.mp4'), '-c:v', 'copy', '-an', '-movflags', '+faststart', repo('test-fixtures/film-720-silent.mp4'));

// The storyboard.
const rows = Math.ceil(PAGES / TILE.cols);
ffmpeg('-i', src('film-720.mp4'), '-an', '-vf', `${pick(starts)},scale=${TILE.w}:${TILE.h}:flags=lanczos,tile=${TILE.cols}x${rows}`, '-frames:v', '1', '-q:v', '3', film('storyboard.jpg'));
const stamp = (seconds) => {
  const ms = Math.round(seconds * 1000);
  return `${two(Math.floor(ms / 3_600_000))}:${two(Math.floor(ms / 60_000) % 60)}:${two(Math.floor(ms / 1000) % 60)}.${String(ms % 1000).padStart(3, '0')}`;
};
const cues = starts.map((start, i) => {
  const x = (i % TILE.cols) * TILE.w;
  const y = Math.floor(i / TILE.cols) * TILE.h;
  return `${stamp(start)} --> ${stamp(starts[i + 1] ?? duration)}\nstoryboard.jpg#xywh=${x},${y},${TILE.w},${TILE.h}\n`;
});
writeFileSync(film('storyboard.vtt'), `WEBVTT\n\n${cues.join('\n')}`);
console.log(`storyboard: ${TILE.w * TILE.cols} × ${TILE.h * rows}, ${kb(film('storyboard.jpg'))}`);

// One sharp still per page, and the same picture at 800 px for the page's scenes.
for (const name of readdirSync(film('frames'))) rmSync(film(`frames/${name}`));
mkdirSync(book('pages'), { recursive: true });
for (const name of readdirSync(book('pages'))) rmSync(book(`pages/${name}`));
ffmpeg('-i', src('film-1080.mp4'), '-an', '-vf', `${pick(starts)},scale=1280:720:flags=lanczos`, '-fps_mode', 'passthrough', '-start_number', '0', `${film('frames/')}tmp-%02d.png`);
let bytes = 0;
starts.forEach((_, i) => {
  const png = film(`frames/tmp-${two(i)}.png`);
  const small = book(`pages/p-${two(i)}.png`);
  run('cwebp', ['-quiet', '-q', '82', png, '-o', film(`frames/f-${two(i)}.webp`)]);
  ffmpeg('-i', png, '-vf', 'scale=800:450:flags=lanczos', '-frames:v', '1', small);
  run('cwebp', ['-quiet', '-q', '80', '-m', '6', small, '-o', book(`pages/p-${two(i)}.webp`)]);
  rmSync(png);
  rmSync(small);
  bytes += statSync(film(`frames/f-${two(i)}.webp`)).size;
});
writeFileSync(film('frames/frames.json'), `[${starts.map((time, i) => `{"time":${time.toFixed(3)},"src":"f-${two(i)}.webp"}`).join(',')}]`);
console.log(`frames: ${PAGES} stills, ${(bytes / 1000).toFixed(0)} kB`);

poster(Number(option('--poster') ?? POSTER));
