/**
 * No automated browser may make a sound (Pedro, 10 Nov 2026). Chromium takes `--mute-audio`; WebKit has no such
 * flag, so every context gets this, in both engines:
 *
 * - the film is swapped for a copy with no audio track (test-fixtures/film-720-silent.mp4; make it with
 *   `ffmpeg -i apps/preview/public/media/film/film-720.mp4 -c:v copy -an test-fixtures/film-720-silent.mp4`), so
 *   mute, volume and the keys that set them are tested as they are, on a film that has nothing to play aloud;
 * - Web Audio (the page flutter) never reaches the speakers: a connection to the destination is dropped, the graph
 *   before it untouched, so a test that wants to hear it taps the node that would have been connected;
 * - nothing is asked of Mux: every request to a mux.com host is refused. The showcase's film plays from Mux and
 *   falls back to the file beside the page when Mux cannot be reached (src/skins/flipbook/sources.ts), so the
 *   battery runs on that file, offline, and exercises the fallback on every load. A streamed film is tested on a
 *   local copy (stream.mjs). The one exception is the opt-in check of the real stream (tests/e2e/mux.spec.ts, run
 *   with FB_MUX=1): there Mux answers, and no media element can be unmuted at all (`mute`).
 *
 * The battery's contexts get it from the shared fixture (tests/e2e/support/test.ts), which a guard holds every spec
 * to (tests/e2e/silence.spec.ts). An ad-hoc script calls `await silence(context)` right after `browser.newContext()`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SILENT_FILM = fileURLToPath(new URL('../../../test-fixtures/film-720-silent.mp4', import.meta.url));
const FILM = /\/media\/film\/film-720\.mp4(\?.*)?$/;
/** Beside the film on a server that has it (the bench's dev and preview servers answer it from test-fixtures,
 *  build/silent-film.mjs; no build carries it): the server then answers range requests itself. */
const SIBLING = 'film-720-silent.mp4';

/** Set in every page of a silenced context: what the guard reads. */
export const MARK = '__fbSilenced';
/** The real stream may be asked for: only the opt-in check sets it. */
export const REAL_STREAM = process.env.FB_MUX === '1';
const MUX = /^https?:\/\/([\w-]+\.)*mux\.com\//;

/**
 * For a context that plays a source this helper cannot swap for a silent one (the real stream): no media element in
 * it can be unmuted or given a volume, whatever the page or the player asks.
 */
export async function mute(context) {
  await context.addInitScript(() => {
    const muted = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted');
    const volume = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
    const play = HTMLMediaElement.prototype.play;
    if (!muted?.set || !volume?.set) throw new Error('This browser cannot be muted from the page.');
    Object.defineProperty(HTMLMediaElement.prototype, 'muted', { configurable: true, get: muted.get, set() { muted.set.call(this, true); } });
    Object.defineProperty(HTMLMediaElement.prototype, 'volume', { configurable: true, get: volume.get, set() { volume.set.call(this, 0); } });
    HTMLMediaElement.prototype.play = function () {
      muted.set.call(this, true);
      volume.set.call(this, 0);
      return play.call(this);
    };
  });
}

/** The silent film's bytes, read once, for a server that does not have it. */
let film;

/** Contexts already silenced: asking twice changes nothing. */
const silenced = new WeakSet();

export async function silence(context) {
  if (silenced.has(context)) return;
  silenced.add(context);
  if (!existsSync(SILENT_FILM)) throw new Error(`No silent film at ${SILENT_FILM}: see tests/e2e/support/silence.mjs for the ffmpeg line.`);
  /** @type {Map<string, Promise<boolean>>} */
  const served = new Map();
  await context.route(FILM, async (route) => {
    const url = new URL(route.request().url());
    const sibling = new URL(SIBLING, url).href;
    if (!served.has(url.origin)) {
      served.set(
        url.origin,
        context.request
          .head(sibling)
          .then((response) => response.ok() && /video/.test(response.headers()['content-type'] ?? ''))
          .catch(() => false),
      );
    }
    if (await served.get(url.origin)) return route.continue({ url: sibling });
    // From disk, by byte range: a film answered whole, with no ranges, cannot be sought.
    film ??= readFileSync(SILENT_FILM);
    const range = /bytes=(\d*)-(\d*)/.exec(route.request().headers().range ?? '');
    const headers = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
    if (!range) return route.fulfill({ status: 200, headers: { ...headers, 'content-length': String(film.length) }, body: film });
    const start = range[1] ? Number(range[1]) : film.length - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), film.length - 1) : film.length - 1;
    const body = film.subarray(start, end + 1);
    return route.fulfill({ status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${film.length}`, 'content-length': String(body.length) }, body });
  });
  if (REAL_STREAM) await mute(context);
  else await context.route(MUX, (route) => route.abort());
  await context.addInitScript((mark) => {
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (target, ...rest) {
      if (target instanceof AudioDestinationNode) return target;
      return connect.call(this, target, ...rest);
    };
    Object.defineProperty(window, mark, { value: true });
  }, MARK);
}
