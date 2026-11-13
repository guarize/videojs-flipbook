/**
 * A stream's renditions, and its address with one of them asked for: pure, so it is tested without a browser
 * (tests/unit/flipbook-renditions.test.ts). quality.ts builds the Settings page and does the switching.
 *
 * A browser that plays HLS itself chooses the rendition and tells the page nothing of the others, so a viewer could
 * not ask for the 4K a film has. Mux takes two limits on a stream's address, `max_resolution` and `min_resolution`,
 * and answers with a playlist of the renditions between them (asked of a film with 360p to 2160p: every height pins
 * to itself, 1080p to its two bitrates). So the renditions are read once from the stream's own master playlist, and
 * a choice is the same address with both limits at that height.
 */

/** A Mux stream, on Mux's own host. (A stream on a domain of the page's own says so: `mux-limits`, quality.ts.) */
const MUX = /^https:\/\/stream\.mux\.com\/[A-Za-z0-9]+\.m3u8(?:[?#]|$)/;
const LIMITS = ['min_resolution', 'max_resolution'];

export function isMuxStream(src: string): boolean {
  return MUX.test(src);
}

/**
 * Whether a film's address takes the limits: a Mux stream, or a stream the page says does (`mux-limits` on the
 * player: Mux behind a domain of the page's own).
 */
export function takesLimits(src: string, declared = false): boolean {
  return isMuxStream(src) || (declared && /\.m3u8(?:[?#]|$)/i.test(src));
}

/** The heights a master playlist offers, tallest first, each once (two bitrates of one height are one choice). */
export function heightsIn(master: string): number[] {
  const heights = new Set<number>();
  for (const line of master.split(/\r?\n/)) {
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const height = Number(/[:,]RESOLUTION=\d+x(\d+)/.exec(line)?.[1]);
    if (height > 0) heights.add(height);
  }
  return [...heights].sort((a, b) => b - a);
}

/** An address with these limits in place of any it had. Nothing else in it changes. */
function limited(src: string, limits: string[]): string {
  const [rest, hash = ''] = src.split(/(?=#)/);
  const [path, query = ''] = rest.split(/\?(.*)/s);
  const kept = query.split('&').filter((pair) => pair && !LIMITS.includes(pair.split('=')[0]));
  kept.push(...limits);
  return `${path}${kept.length ? `?${kept.join('&')}` : ''}${hash}`;
}

/** The stream's address asking for one height, or for all of them (`null`: the limits taken off). */
export function atHeight(src: string, height: number | null): string {
  return limited(src, height ? [`min_resolution=${height}p`, `max_resolution=${height}p`] : []);
}

/**
 * The stream's address for something that only reads small pictures from it (the paused page's strip): no taller than
 * `height`, whatever the viewer chose to watch. An address that takes no limits is left as it is.
 */
export function atMost(src: string, height: number, declared = false): string {
  return takesLimits(src, declared) ? limited(src, [`max_resolution=${height}p`]) : src;
}

/** The heights Mux makes of a film, lowest first. */
const LADDER = [360, 540, 720, 1080, 1440, 2160];

/** The lowest of Mux's heights that covers a picture this many pixels tall. Null where that is the tallest there is (no limit). */
function rung(picture: number): number | null {
  const cap = LADDER.find((height) => height >= Math.round(picture)) ?? null;
  return cap === LADDER[LADDER.length - 1] ? null : cap;
}

/**
 * The tallest rendition worth asking for on a screen: the lowest of Mux's heights that is at least as tall as the
 * largest 16:9 picture the screen can show, in its own pixels. Null where that is the tallest there is (no limit).
 *
 * A browser's own HLS picks by the connection alone: on a fast one Chromium played the 2160p rendition into a 720 px
 * player on a 720 px screen (measured, 12 Nov 2026), four times the pixels the screen has, for nothing but the wait.
 */
export function screenCap(width: number, height: number, ratio: number): number | null {
  return rung(Math.min(Math.min(width, height), Math.max(width, height) * (9 / 16)) * (ratio || 1));
}

/**
 * The tallest rendition a film needs in the box it is shown in: the lowest of Mux's heights that covers the picture
 * the box has room for (a film of this `shape`, width over height, fitted inside it), in the screen's own pixels.
 * Null where that is the tallest there is. (Where a stream is asked by its box, and why: fit.ts.)
 */
export function boxCap(width: number, height: number, ratio: number, shape = 16 / 9): number | null {
  return rung(Math.min(height || Infinity, width / shape) * (ratio || 1));
}

/** Whether one ceiling asks for more than another (null: no ceiling at all). */
export function taller(cap: number | null, than: number | null): boolean {
  return than != null && (cap == null || cap > than);
}

/** The lower of two ceilings. */
export function lower(a: number | null, b: number | null): number | null {
  return taller(a, b) ? b : a;
}

/**
 * Whether Auto's ceiling on a stream is the skin's to set: a stream whose address takes the limits (a Mux stream, or
 * one the page says does) and that the page has put no limits of its own on. A file, another host's stream and the
 * page's own limits are left as they are.
 */
export function fits(src: string, declared = false): boolean {
  return takesLimits(src, declared) && !/[?&](?:min|max)_resolution=/.test(src);
}

/** A stream's address asked no taller than a ceiling (null: with no limit). */
export function under(src: string, cap: number | null): string {
  return limited(src, cap ? [`max_resolution=${cap}p`] : []);
}

/** The ceiling an address asks under, where that is all it asks (null: none, or one height pinned). */
export function capOf(src: string): number | null {
  const query = /\?([^#]*)/.exec(src)?.[1] ?? '';
  if (/(?:^|&)min_resolution=/.test(query)) return null;
  const cap = Number(/(?:^|&)max_resolution=(\d+)p(?:&|$)/.exec(query)?.[1]);
  return cap > 0 ? cap : null;
}

/** The one height an address asks for, or null where it asks for none (or for a range). */
export function heightAt(src: string): number | null {
  const query = /\?([^#]*)/.exec(src)?.[1] ?? '';
  const limits = new Map(query.split('&').map((pair) => pair.split('=') as [string, string | undefined]));
  const [min, max] = LIMITS.map((name) => Number(/^(\d+)p$/.exec(limits.get(name) ?? '')?.[1]));
  return min > 0 && min === max ? min : null;
}

/** A rendition's name on the page: "2160p", and what people call it. */
export function nameOf(height: number): { label: string; tier: string } {
  return { label: `${height}p`, tier: height >= 2160 ? '4K' : height >= 720 ? 'HD' : '' };
}

/** The choice kept for a film, held against what the film offers now: a height it has, or null (Auto). */
export function keptChoice(stored: string | null, heights: readonly number[]): number | null {
  const height = Number(stored);
  return heights.includes(height) ? height : null;
}
