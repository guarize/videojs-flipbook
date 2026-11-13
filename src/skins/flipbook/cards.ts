/**
 * A long intertitle set as consecutive cards (intertitle.ts): which words go on which card, and for how long each
 * stands. Pure, so it can be tested without a browser: whether a run of words fits a card is asked of the caller,
 * who measures it on the page.
 */

/** A card ends on a phrase where it can: a word that closes with one of these (and any quote or bracket after it), or a dash. */
const PHRASE_END = /(?:[,.;:!?…]+["'”’»)\]]*|[—–])$/;
/** A phrase break is taken only if the card it leaves holds at least this share of what would have fitted. */
const WORTH = 1 / 3;

const words = (text: string) => text.split(/\s+/).filter(Boolean);
const size = (run: string[]) => run.join(' ').length;

/**
 * A sentence as cards of whole words: each card is as much as `fits` takes, ended at the last phrase boundary in it
 * (punctuation) where that leaves a card worth reading, at a space otherwise. A word is never broken: one that fits
 * no card by itself still gets a card of its own. The last card is never a single word the card before had room to
 * keep company.
 */
export function splitText(text: string, fits: (candidate: string) => boolean): string[] {
  const all = words(text);
  const cards: string[] = [];
  let from = 0;
  while (from < all.length) {
    // The most words from here that fit (more words never fit better, so the reach is found by halving).
    let low = from + 1;
    let high = all.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(all.slice(from, mid).join(' '))) low = mid;
      else high = mid - 1;
    }
    let to = low;
    if (to < all.length) {
      const reach = size(all.slice(from, to));
      let phrase = -1;
      for (let k = to; k > from; k--) {
        if (!PHRASE_END.test(all[k - 1])) continue;
        if (size(all.slice(from, k)) >= reach * WORTH) phrase = k;
        break;
      }
      if (phrase > 0) to = phrase;
      else if (all.length - to === 1 && to - from > 2) to -= 1;
    }
    cards.push(all.slice(from, to).join(' '));
    from = to;
  }
  return cards;
}

/**
 * A cue's lines dealt onto cards. Whole lines share a card while they fit; a line that fits no card by itself is
 * split (splitText), each piece on its own card with everything else the line carries (its speaker, its kind).
 */
export function deal<T extends { text: string }>(lines: T[], fits: (card: T[]) => boolean): T[][] {
  const cards: T[][] = [];
  let current: T[] = [];
  for (const line of lines) {
    if (fits([...current, line])) {
      current.push(line);
      continue;
    }
    if (current.length) cards.push(current);
    current = [];
    if (fits([line])) {
      current = [line];
      continue;
    }
    for (const text of splitText(line.text, (candidate) => fits([{ ...line, text: candidate }]))) cards.push([{ ...line, text }]);
  }
  if (current.length) cards.push(current);
  return cards;
}

/**
 * How long each card stands: its share of the cue's time by its characters, and never under `floor` seconds (what
 * the short ones gain, the others give up in proportion). Null when the cue is too short to give every card the
 * floor: the caller sets fewer cards.
 */
export function shareTime(lengths: number[], duration: number, floor: number): number[] | null {
  const count = lengths.length;
  if (!count || duration <= 0) return null;
  if (count === 1) return [duration];
  if (count * floor > duration + 1e-9) return null;
  const shares = new Array<number>(count).fill(0);
  const held = new Set<number>();
  // Each pass holds the cards that came out short at the floor and deals the rest of the time again.
  for (let pass = 0; pass < count; pass++) {
    const left = duration - held.size * floor;
    const weight = lengths.reduce((sum, length, i) => (held.has(i) ? sum : sum + Math.max(1, length)), 0);
    let short = false;
    lengths.forEach((length, i) => {
      if (held.has(i)) {
        shares[i] = floor;
        return;
      }
      shares[i] = (left * Math.max(1, length)) / weight;
      if (shares[i] < floor - 1e-9) {
        held.add(i);
        short = true;
      }
    });
    if (!short) break;
  }
  return shares;
}

/** The card standing `elapsed` seconds into the cue. */
export function cardAt(shares: number[], elapsed: number): number {
  let end = 0;
  for (let i = 0; i < shares.length - 1; i++) {
    end += shares[i];
    if (elapsed < end - 1e-6) return i;
  }
  return Math.max(0, shares.length - 1);
}
