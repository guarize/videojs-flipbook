import { type Cue, findMedia, loadChapters, loadStoryboard, type Tile, videoOf } from '@/shared/storyboard';

/**
 * The book every part of Flipbook reads: the storyboard's pages and the chapters, loaded once per player, and a
 * little shared state so the parts don't trip over each other (a scrub in the deck is not a page turn).
 */
export interface Book {
  tiles: Tile[];
  chapters: Cue[];
  cols: number;
  rows: number;
  sprite: string;
  ratio: number;
}

const books = new WeakMap<Element, Promise<Book | null>>();
const quiet = new WeakMap<Element, { since: number; until: number }>();

export function loadBook(container: Element, signal: AbortSignal): Promise<Book | null> {
  let pending = books.get(container);
  if (!pending) {
    pending = Promise.all([loadStoryboard(container, signal), loadChapters(container, signal)]).then(([tiles, chapters]) => {
      if (!tiles.length) return null;
      const first = tiles[0];
      const cols = Math.round(Math.max(...tiles.map((t) => t.x + t.w)) / first.w);
      const rows = Math.round(Math.max(...tiles.map((t) => t.y + t.h)) / first.h);
      return { tiles, chapters, cols, rows, sprite: first.src, ratio: first.w / first.h };
    });
    books.set(container, pending);
  }
  return pending;
}

/** Where a page sits in the sprite, as a `background-position` for an element sized `cols × rows` times the page. */
export function spritePosition(book: Book, index: number): string {
  const tile = book.tiles[index];
  if (!tile) return '0 0';
  const col = Math.round(tile.x / tile.w);
  const row = Math.round(tile.y / tile.h);
  const x = book.cols > 1 ? (col / (book.cols - 1)) * 100 : 0;
  const y = book.rows > 1 ? (row / (book.rows - 1)) * 100 : 0;
  return `${x.toFixed(4)}% ${y.toFixed(4)}%`;
}

/** The page's column and row, for placing a crop of it in pixels. */
export function spriteCell(book: Book, index: number): { col: number; row: number } {
  const tile = book.tiles[index];
  return tile ? { col: Math.round(tile.x / tile.w), row: Math.round(tile.y / tile.h) } : { col: 0, row: 0 };
}

/**
 * The first page that shows a moment: the page starting at it, or the next one. A chapter can begin partway through
 * a page that still shows the chapter before; its first frame is on the page after.
 */
export function pageFrom(book: Book, time: number): number {
  const index = book.tiles.findIndex((t) => t.start >= time - 0.05);
  return index < 0 ? book.tiles.length - 1 : index;
}

export function chapterAt(book: Book, time: number): number {
  return book.chapters.findIndex((c) => time >= c.startTime && time < c.endTime);
}

/** Seeks the deck, the riffle or the curl make themselves: the page turn stays out of the way of these. */
export function hush(container: Element, ms = 700) {
  const now = performance.now();
  quiet.set(container, { since: now, until: now + ms });
}

export function hushed(container: Element) {
  return performance.now() < (quiet.get(container)?.until ?? 0);
}

/** Hushed by something that began at or after `time`: a key's own turn, when the book answers that key itself. */
export function hushedSince(container: Element, time: number) {
  return hushed(container) && (quiet.get(container)?.since ?? 0) >= time;
}

export function videoIn(container: Element) {
  return videoOf(findMedia(container));
}

/**
 * The picture in sight. A film that plays from a stream may have a stand-in over it (stand.ts): a silent copy that
 * shows the exact frame before the film does, or the storyboard's page while a hand drives. The copy, while it is up
 * with a frame of its own, is the picture; a page is not a frame, so `whenTheFilmShows` waits for it to leave first.
 */
export function pictureIn(container: Element): HTMLVideoElement | null {
  return container.querySelector<HTMLVideoElement>(':scope > video.fb-stand[data-on]:not([data-still])') ?? videoIn(container);
}

/** Resolves once no page stands in for the picture (the film shows its own frame), or after `patience` ms. */
export function whenTheFilmShows(container: Element, patience = 4000): Promise<void> {
  const pages = container.querySelector(':scope > canvas.fb-stand[data-on], :scope > video.fb-stand[data-still]');
  if (!pages) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      watch.disconnect();
      clearTimeout(timer);
      resolve();
    };
    const watch = new MutationObserver(() => {
      if (!pages.hasAttribute('data-on') || (pages instanceof HTMLVideoElement && !pages.hasAttribute('data-still'))) done();
    });
    watch.observe(pages, { attributes: true, attributeFilter: ['data-on', 'data-still'] });
    const timer = setTimeout(done, patience);
  });
}

export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
