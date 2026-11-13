/**
 * The battery's fixtures, answered by the dev and preview servers only. They are never in `public/`, so no build
 * carries them.
 *
 * - The silent copy of the film (test-fixtures/film-720-silent.mp4), beside the film: the silence helper
 *   (tests/e2e/support/silence.mjs) sends every request for the film to this sibling, and a server that answers it
 *   by byte range lets the film be sought.
 * - The film as a local HLS stream (test-fixtures/stream/, tests/e2e/support/stream.mjs), at `media/stream/`. Its
 *   master playlist is answered as Mux answers one asked with `min_resolution` and `max_resolution` (`720p`): only
 *   the renditions between the two.
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SILENT = fileURLToPath(new URL('../test-fixtures/film-720-silent.mp4', import.meta.url));
const STREAM = fileURLToPath(new URL('../test-fixtures/stream/', import.meta.url));
const SILENT_PATH = /\/media\/film\/film-720-silent\.mp4$/;
const STREAM_PATH = /\/media\/stream\/([\w.-]+\.(m3u8|m4s|mp4))$/;
const TYPES = { m3u8: 'application/vnd.apple.mpegurl', m4s: 'video/iso.segment', mp4: 'video/mp4' };

/** A master playlist with only the renditions whose height is between two limits (each variant is two lines). */
function between(master, min, max) {
  const lines = master.split('\n');
  return lines
    .filter((line, i) => {
      const variant = line.startsWith('#EXT-X-STREAM-INF:') ? line : lines[i - 1]?.startsWith('#EXT-X-STREAM-INF:') ? lines[i - 1] : '';
      const height = Number(/RESOLUTION=\d+x(\d+)/.exec(variant)?.[1]);
      return !variant || (height >= min && height <= max);
    })
    .join('\n');
}

/** @type {import('vite').Connect.NextHandleFunction} */
function serve(req, res, next) {
  const path = (req.url ?? '').split('?')[0];
  const part = STREAM_PATH.exec(path);
  const file = part ? `${STREAM}${part[1]}` : SILENT_PATH.test(path) ? SILENT : '';
  if (!file || !existsSync(file)) return next();
  const limits = part?.[2] === 'm3u8' ? new URLSearchParams((req.url ?? '').split('?')[1] ?? '') : null;
  if (limits?.has('min_resolution') || limits?.has('max_resolution')) {
    const body = between(readFileSync(file, 'utf8'), parseInt(limits.get('min_resolution') ?? '', 10) || 0, parseInt(limits.get('max_resolution') ?? '', 10) || Infinity);
    res.writeHead(200, { 'Content-Type': TYPES.m3u8, 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
  const { size } = statSync(file);
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
  const headers = { 'Content-Type': part ? TYPES[part[2]] : 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  const start = range ? (range[1] ? Number(range[1]) : size - Number(range[2])) : 0;
  const end = range?.[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (range) res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
  else res.writeHead(200, { ...headers, 'Content-Length': size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file, { start, end }).pipe(res);
}

/** @returns {import('vite').Plugin} */
export function silentFilm() {
  return {
    name: 'silent-film',
    configureServer: (server) => void server.middlewares.use(serve),
    configurePreviewServer: (server) => void server.middlewares.use(serve),
  };
}
