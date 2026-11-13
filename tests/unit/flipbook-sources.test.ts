import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { playable, playsItself } from '../../src/skins/flipbook/sources';

const STREAM = 'https://stream.mux.com/abc123.m3u8';
const MP4 = 'https://stream.mux.com/abc123/720p.mp4';
const LOCAL = '/film/film-720.mp4';

/** A browser with HLS of its own (Safari; Chrome and Edge since 142), and one without (Firefox). */
const withHls = { canPlayType: (type: string) => (type === 'application/vnd.apple.mpegurl' ? 'maybe' : '') } as unknown as HTMLVideoElement;
const without = { canPlayType: () => '' } as unknown as HTMLVideoElement;

describe('what a browser plays itself', () => {
  it('a stream, only where the browser has HLS of its own', () => {
    expect(playsItself(withHls, STREAM)).toBe(true);
    expect(playsItself(withHls, `${STREAM}?max_resolution=720p`)).toBe(true);
    expect(playsItself(without, STREAM)).toBe(false);
  });

  it('a file, everywhere', () => {
    expect(playsItself(without, MP4)).toBe(true);
    expect(playsItself(without, LOCAL)).toBe(true);
  });
});

describe('the sources tried, in order', () => {
  it('the stream first where it plays, then the files', () => {
    expect(playable(withHls, [STREAM, MP4, LOCAL])).toEqual([STREAM, MP4, LOCAL]);
  });

  it('the files alone where no stream plays (Firefox takes the stream’s MP4)', () => {
    expect(playable(without, [STREAM, MP4, LOCAL])).toEqual([MP4, LOCAL]);
  });

  it('nothing for an empty address', () => {
    expect(playable(withHls, ['', LOCAL])).toEqual([LOCAL]);
  });
});

/**
 * Safari 27 on a real iPhone refuses a film's source when the film holds a caption or description track as its
 * address is set or `load()` is called (sources.ts, `open`). So the film's address is given in one place, and
 * nothing else sets `src` on it or reloads it. This reads the sources: every line that sets a `src` or calls
 * `load()` is either `open` itself or one of the lines below, each of which is not the film (a helper video that
 * has no tracks, or a picture). A new line fails here until it is looked at: the film's goes through `open`.
 */
describe('the film’s address is given in one place', () => {
  const ROOT = join(__dirname, '../..');
  const DIRS = ['src/skins/flipbook', 'src/shared', 'apps/preview/src/site', 'apps/preview/src/pages', 'apps/site/src/scripts'];
  const SETS = /setAttribute\(\s*['"]src['"]|\.src\s*=(?!=)|\.load\(\)|\.srcObject\s*=/;
  const NOT_THE_FILM = [
    // The one place: `open`.
    'src/skins/flipbook/sources.ts: if (src) video.setAttribute(\'src\', src);',
    'src/skins/flipbook/sources.ts: else video.load();',
    // Helper videos, made here with no tracks: the scanner's, the hand's copy, the plate's reader.
    'src/skins/flipbook/scan.ts: helper.src = src;',
    'src/skins/flipbook/scan.ts: helper.load();',
    'src/skins/flipbook/stand.ts: video.src = this.#src;',
    'src/skins/flipbook/stand.ts: video.load();',
    'src/skins/flipbook/plate.ts: helper.src = src;',
    'src/skins/flipbook/plate.ts: helper.load();',
    // Pictures.
    'src/skins/flipbook/peek.ts: if (sharp.src !== url) sharp.src = url;',
    'src/skins/flipbook/frames.ts: image.src = url;',
    'src/skins/flipbook/tear.ts: image.src = tile.src;',
    'src/skins/flipbook/tear.ts: if (blob) thumb.src = this.#thumbUrl;',
    'src/skins/flipbook/stand.ts: sheet.src = book.sprite;',
    'src/skins/flipbook/edge.ts: sprite.src = book.sprite;',
    'src/skins/flipbook/edge.ts: image.src = url;',
    'src/skins/flipbook/turn.ts: image.src = src;',
    'src/skins/flipbook/contents.ts: image.src = url;',
  ];

  it('nothing but `open` sets the film’s `src` or calls `load()` on it', () => {
    const found: string[] = [];
    for (const dir of DIRS) {
      for (const name of readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })) {
        if (!name.endsWith('.ts')) continue;
        const lines = readFileSync(join(ROOT, dir, name), 'utf8').split('\n');
        for (const line of lines) {
          const code = line.trim();
          if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*') || !SETS.test(code)) continue;
          // (A data: picture, a page's own probe of what the browser decodes, is no address of anything.)
          if (/\.src = 'data:image\//.test(code)) continue;
          found.push(`${dir}/${name}: ${code}`);
        }
      }
    }
    expect(found.length, 'lines that set an address or reload were found').toBeGreaterThan(10);
    expect(found.filter((line) => !NOT_THE_FILM.includes(line)), 'new places that set a `src` or call `load()`: is it the film? then through open()').toEqual([]);
    expect(NOT_THE_FILM.filter((line) => !found.includes(line)), 'lines listed here that are gone').toEqual([]);
  });
});
