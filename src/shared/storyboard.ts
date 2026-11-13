/** One frame of the storyboard: when it covers, and where it sits in the sprite. */
export interface Tile {
  start: number;
  end: number;
  src: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

type MediaHost = HTMLElement & { target?: HTMLVideoElement; textTracks?: TextTrackList };

/** The media element the player plays, or the custom element (such as `<mux-video>`) that speaks its API. */
export function findMedia(container: Element): MediaHost | null {
  return container.querySelector<MediaHost>('mux-video, hls-video, hlsjs-video, video');
}

/** The real `<video>`: the element itself, or the one a custom media element wraps. */
export function videoOf(host: MediaHost | null): HTMLVideoElement | null {
  if (!host) return null;
  return host instanceof HTMLVideoElement ? host : (host.target ?? null);
}

function parse(cues: ArrayLike<VTTCue | TextTrackCue>, base: string): Tile[] {
  const tiles: Tile[] = [];
  for (const cue of Array.from(cues)) {
    const text = (cue as VTTCue).text?.trim();
    if (!text) continue;
    const [path, hash] = text.split('#');
    const match = /xywh=(\d+),(\d+),(\d+),(\d+)/.exec(hash ?? '');
    if (!path || !match) continue;
    tiles.push({
      start: cue.startTime,
      end: cue.endTime,
      src: new URL(path, base).href,
      x: Number(match[1]),
      y: Number(match[2]),
      w: Number(match[3]),
      h: Number(match[4]),
    });
  }
  return tiles;
}

export interface Cue {
  startTime: number;
  endTime: number;
  text: string;
}

/** WebVTT cues: their timing and their text, enough for chapters and storyboards. */
export function parseVtt(text: string): Cue[] {
  const cues: Cue[] = [];
  const time = (value: string) => {
    const parts = value.trim().split(':').map(Number);
    return parts.reduce((total, part) => total * 60 + part, 0);
  };
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter(Boolean);
    const timing = lines.findIndex((line) => line.includes('-->'));
    if (timing < 0 || !lines[timing + 1]) continue;
    const [from, to] = lines[timing].split('-->');
    cues.push({ startTime: time(from), endTime: time(to.trim().split(' ')[0]), text: lines.slice(timing + 1).join('\n') });
  }
  return cues;
}

function fromVtt(text: string, base: string): Tile[] {
  return parse(parseVtt(text) as unknown as VTTCue[], base);
}

/** The chapters track's cues, fetched from its `<track>`: the contact sheet marks where each begins. */
export async function loadChapters(container: Element, signal: AbortSignal): Promise<Cue[]> {
  const track = findMedia(container)?.querySelector<HTMLTrackElement>('track[kind="chapters"]');
  if (!track?.src) return [];
  try {
    const response = await fetch(track.src, { signal });
    return response.ok ? parseVtt(await response.text()) : [];
  } catch {
    return [];
  }
}

const cache = new Map<string, Promise<Tile[]>>();

/**
 * The storyboard's tiles, from the media's `thumbnails` metadata track: a `<track>` in the page, or the one a Mux
 * element adds itself. The track's file is fetched once and shared by every part that draws frames.
 */
export async function loadStoryboard(container: Element, signal: AbortSignal): Promise<Tile[]> {
  const host = findMedia(container);
  if (!host) return [];

  const authored = host.querySelector<HTMLTrackElement>('track[kind="metadata"][label="thumbnails"]');
  let src = authored?.src ?? '';

  if (!src) {
    // Mux: the element adds the storyboard track itself once the source resolves.
    const playback = /stream\.mux\.com\/([A-Za-z0-9]+)/.exec(host.getAttribute('src') ?? '')?.[1];
    if (playback) src = `https://image.mux.com/${playback}/storyboard.vtt`;
  }
  if (!src) return [];

  let pending = cache.get(src);
  if (!pending) {
    pending = fetch(src, { signal })
      .then((response) => (response.ok ? response.text() : ''))
      .then((text) => fromVtt(text, src))
      .catch(() => []);
    cache.set(src, pending);
  }
  return pending;
}

/** The tile on screen at a time. Tiles are in order, so a binary search finds it in a few steps. */
export function tileAt(tiles: Tile[], time: number): number {
  let low = 0;
  let high = tiles.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (tiles[mid].start <= time) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** `00:26:14`: minutes, seconds and frames, as an editor reads time. Hours appear when there are any. */
export function timecode(seconds: number, fps = 30): string {
  const total = Math.max(0, seconds);
  const frames = Math.floor((total % 1) * fps);
  const s = Math.floor(total) % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const two = (n: number) => String(n).padStart(2, '0');
  return h ? `${two(h)}:${two(m)}:${two(s)}:${two(frames)}` : `${two(m)}:${two(s)}:${two(frames)}`;
}
