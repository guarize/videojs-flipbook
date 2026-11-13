/**
 * What stands in for the picture while a hand drives the film (stand.ts, flip.ts): a choice, kept apart so it can be
 * tested without a browser.
 *
 * - `copy`: a silent copy of the film the page gave (`scrub` on the player), which seeks at once. The hand flips the
 *   copy, frame by frame; the strip and the plate are read from it; the film is sought when the hand rests.
 * - `stills`: no copy, and the film seeks slowly (it is a stream, or its seeks have proved slow). The hand flips the
 *   storyboard's pages, drawn at the picture's size: the page's still, not the exact frame, and counted as a page.
 *   The exact frame is the film's own, when the hand rests.
 * - `film`: the film itself is chased with exact seeks, as a file beside the page can be.
 *
 * (A film with no storyboard at all has no fore-edge of pages to flip: its timeline is Video.js's own slider.)
 */
export type Standing = 'copy' | 'stills' | 'film';

/** A stream: an HLS address, or the object a streaming library gives the video. */
export function isStream(src: string): boolean {
  return /\.m3u8(?:[?#]|$)/i.test(src) || src.startsWith('blob:');
}

export interface Film {
  /** What the film is playing from (`currentSrc`). */
  src: string;
  /** The page's scrub copy, as an absolute address; '' where it gave none. */
  scrub: string;
  /** The copy could not be fetched. */
  failed?: boolean;
  /** The film's own seeks have proved slow under the hand. */
  slow?: boolean;
}

export function standing({ src, scrub, failed = false, slow = false }: Film): Standing {
  // (A film that plays from the very file given as its copy needs no stand-in: it is the copy.)
  if (scrub && !failed && src !== scrub) return 'copy';
  if (scrub && src === scrub) return 'film';
  return isStream(src) || slow ? 'stills' : 'film';
}

/** A seek under the hand that takes longer than this has not kept up; twice running, the film is `slow`. */
export const SLOW_SEEK = 300;
