/**
 * The film as the page's scenes count it: the book's 52 pages (the storyboard's, a page every 1.92 s of the 98 s
 * film, scripts/film-assets.mjs) and its six chapters, each with the first page that shows it (the skin's own rule,
 * `pageFrom` in src/skins/flipbook/book.ts: the page starting at the chapter's start, or the next one).
 */
export const CHAPTERS = [
  { n: 1, name: 'The Book', page: 0, t: '0:00' },
  { n: 2, name: 'One Gallop', page: 7, t: '0:12' },
  { n: 3, name: 'The Herd', page: 20, t: '0:36' },
  { n: 4, name: 'Flight', page: 36, t: '1:09' },
  { n: 5, name: 'Torn Out', page: 41, t: '1:18' },
  { n: 6, name: 'Colophon', page: 46, t: '1:28' },
] as const;

export const chapterOf = (page: number) => [...CHAPTERS].reverse().find((c) => page >= c.page) ?? CHAPTERS[0];

export const pageSrc = (i: number) => `./book/pages/p-${String(i).padStart(2, '0')}.webp`;
