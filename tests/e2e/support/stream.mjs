/**
 * The film as a stream, for the battery: a local HLS copy of the silent film (test-fixtures/stream/, git-ignored with
 * the rest of the fixtures), so the tests of a streamed source run offline, on every engine's own HLS, and ask Mux
 * for nothing.
 *
 * It is made the way a streaming service makes one, and for the same effect: a keyframe every five seconds, in
 * five-second fMP4 segments, so a seek lands as slowly as it does on the real thing and the stand-in has something to
 * stand in for (src/skins/flipbook/stand.ts). 360p, no audio track: about 2 MB. The dev and preview servers answer it
 * at `media/stream/` (build/silent-film.mjs); no build carries it. The bench mounts it with `?source=stream`
 * (apps/preview/src/pages/mount.ts).
 *
 * Beside it, the same film at 180p and a master playlist of the two (`ladder.m3u8`, `?source=ladder`): a stream with
 * renditions to choose from, for the Quality page (src/skins/flipbook/quality.ts). The servers answer it as Mux
 * answers a stream asked with `min_resolution` and `max_resolution`: only the renditions between them.
 *
 * `ensureStream()` makes it once, and again when the silent film is newer (a new delivery of the film).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SILENT_FILM } from './silence.mjs';

export const STREAM_DIR = fileURLToPath(new URL('../../../test-fixtures/stream/', import.meta.url));
export const STREAM = `${STREAM_DIR}film.m3u8`;
export const LADDER = `${STREAM_DIR}ladder.m3u8`;
/** Seconds between keyframes, and a segment's length: Mux's own. */
const GOP = 5;
/** The renditions: the playlist's name, its picture and how hard it is pressed. */
const RENDITIONS = [
  { name: 'film', width: 640, height: 360, crf: 30, bandwidth: 420_000 },
  { name: 'low', width: 320, height: 180, crf: 34, bandwidth: 140_000 },
];

export function ensureStream() {
  if (!existsSync(SILENT_FILM)) throw new Error(`No silent film at ${SILENT_FILM}: see tests/e2e/support/silence.mjs.`);
  if (existsSync(LADDER) && statSync(LADDER).mtimeMs >= statSync(SILENT_FILM).mtimeMs) return;
  rmSync(STREAM_DIR, { recursive: true, force: true });
  mkdirSync(STREAM_DIR, { recursive: true });
  const probe = (entries) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', `stream=${entries}`, '-of', 'csv=p=0', SILENT_FILM]).toString().trim();
  const [n, d] = probe('r_frame_rate').split('/').map(Number);
  const frames = Math.round((n / (d || 1)) * GOP);
  const variants = [];
  for (const { name, width, height, crf, bandwidth } of RENDITIONS) {
    // (The first keeps the names it always had: `film.m3u8` is also played by itself, as a stream of one rendition.)
    const prefix = name === 'film' ? '' : `${name}-`;
    execFileSync(
      'ffmpeg',
      [
        '-v', 'error', '-y', '-i', SILENT_FILM, '-an',
        '-vf', `scale=${width}:${height}:flags=bicubic`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p',
        '-profile:v', 'high', '-level', '3.0',
        '-g', String(frames), '-keyint_min', String(frames), '-sc_threshold', '0',
        '-f', 'hls', '-hls_time', String(GOP), '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4',
        '-hls_fmp4_init_filename', `${prefix}init.mp4`, '-hls_segment_filename', `${STREAM_DIR}${prefix}seg-%03d.m4s`, `${STREAM_DIR}${name}.m3u8`,
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
    // High profile, level 3.0, as asked above.
    variants.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},AVERAGE-BANDWIDTH=${bandwidth},CODECS="avc1.64001e",RESOLUTION=${width}x${height},CLOSED-CAPTIONS=NONE\n${name}.m3u8`);
  }
  // Written last: its date is the fixture's.
  writeFileSync(LADDER, ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS', '', ...variants, ''].join('\n'));
}

// `node tests/e2e/support/stream.mjs` makes it by hand.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  ensureStream();
  console.log(LADDER);
}
