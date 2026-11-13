import { findMedia, tileAt } from '@/shared/storyboard';
import type { Book } from './book';

/**
 * Sharp frames: one full-resolution still per storyboard page, so a card, a riffle page or a turning page is as
 * sharp as the video. Locally they're listed in `frames/frames.json` beside the storyboard; on Mux they come from
 * the thumbnail API. Each is decoded once and cached; callers show the storyboard tile until theirs is ready.
 */
const lists = new WeakMap<Element, Promise<(string | null)[]>>();
const wants = new WeakMap<Element, Promise<void>>();

/**
 * The first sign someone is here for the pictures: a pointer on the player, a key or focus in it, or the film playing.
 * Parts that dress themselves in sharp frames ahead of use (the corner's next page, the preview's list) wait for it,
 * so the page loads, settles and becomes interactive with none on the wire. The storyboard stands in until then.
 */
export function wanted(container: Element): Promise<void> {
  let pending = wants.get(container);
  if (pending) return pending;
  pending = new Promise<void>((resolve) => {
    const local = new AbortController();
    const done = () => {
      local.abort();
      resolve();
    };
    const options = { capture: true, once: true, passive: true, signal: local.signal };
    // Media events don't bubble; a capturing listener on the player still hears its video's play.
    for (const type of ['pointerenter', 'pointermove', 'pointerdown', 'focusin', 'keydown', 'play']) container.addEventListener(type, done, options);
    const video = container.querySelector('video');
    if (video && !video.paused) done();
  });
  wants.set(container, pending);
  return pending;
}

const decoded = new Map<string, Promise<HTMLImageElement | null>>();
const LIMIT = 40;

export function frameUrls(container: Element, book: Book): Promise<(string | null)[]> {
  let pending = lists.get(container);
  if (pending) return pending;
  pending = (async () => {
    const empty = book.tiles.map(() => null);
    const host = findMedia(container);
    // A page's own storyboard comes with its own stills (below); a Mux film with none takes Mux's thumbnails.
    const track = host?.querySelector<HTMLTrackElement>('track[kind="metadata"][label="thumbnails"]');
    const playback = /stream\.mux\.com\/([A-Za-z0-9]+)/.exec(host?.getAttribute('src') ?? '')?.[1];
    if (playback && !track?.src) {
      return book.tiles.map((tile) => `https://image.mux.com/${playback}/thumbnail.webp?time=${(tile.start + 0.05).toFixed(2)}&width=1280`);
    }
    if (!track?.src) return empty;
    const list = new URL('frames/frames.json', track.src).href;
    try {
      const response = await fetch(list);
      if (!response.ok) return empty;
      const entries = (await response.json()) as { time: number; src: string }[];
      const urls: (string | null)[] = [...empty];
      for (const entry of entries) {
        const index = tileAt(book.tiles, entry.time + 0.01);
        if (urls[index] == null) urls[index] = new URL(entry.src, list).href;
      }
      return urls;
    } catch {
      return empty;
    }
  })();
  lists.set(container, pending);
  return pending;
}

/** The decoded image for a frame's URL, from cache when it's been asked for before. Null if it fails to load. */
export function sharpFrame(url: string): Promise<HTMLImageElement | null> {
  const hit = decoded.get(url);
  if (hit) {
    // Most recently used goes to the back of the line.
    decoded.delete(url);
    decoded.set(url, hit);
    return hit;
  }
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.decoding = 'async';
  image.src = url;
  const pending = image.decode().then(() => image, () => null);
  decoded.set(url, pending);
  while (decoded.size > LIMIT) decoded.delete(decoded.keys().next().value as string);
  return pending;
}

/** The sharp frame for the storyboard page a time falls on, or null when there's none. */
export async function sharpAt(container: Element, book: Book, time: number, index = tileAt(book.tiles, time)): Promise<HTMLImageElement | null> {
  const urls = await frameUrls(container, book);
  const url = urls[index];
  return url ? sharpFrame(url) : null;
}
