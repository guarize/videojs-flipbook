import { describe, expect, it } from 'vitest';
import { cardAt, deal, shareTime, splitText } from '../../src/skins/flipbook/cards';

const CUE = 'Palo Alto, 19 June 1878: Sallie Gardner at a gallop, a photograph every 27 inches.';
/** A card that takes so many characters, as a card of a width takes so many words. */
const upTo = (characters: number) => (candidate: string) => candidate.length <= characters;

describe('a sentence set as cards', () => {
  it('ends each card on a phrase where one is there to end on', () => {
    expect(splitText(CUE, upTo(40))).toEqual(['Palo Alto, 19 June 1878:', 'Sallie Gardner at a gallop,', 'a photograph every 27 inches.']);
    expect(splitText(CUE, upTo(56))).toEqual(['Palo Alto, 19 June 1878: Sallie Gardner at a gallop,', 'a photograph every 27 inches.']);
  });

  it('ends on a space where no phrase ends, or the phrase would leave a card not worth reading', () => {
    expect(splitText('one two three four five six seven eight nine', upTo(19))).toEqual(['one two three four', 'five six seven', 'eight nine']);
    // "Yes," is a phrase, but a card of four characters where thirty fit is no card.
    expect(splitText('Yes, the horse leaves the ground altogether in its stride.', upTo(30))).toEqual(['Yes, the horse leaves the', 'ground altogether in', 'its stride.']);
  });

  it('never breaks a word, even one no card has room for', () => {
    const cards = splitText('a photographically-impossible instant', upTo(10));
    expect(cards).toEqual(['a', 'photographically-impossible', 'instant']);
    expect(cards.join(' ')).toBe('a photographically-impossible instant');
  });

  it('does not leave one word alone on the last card when the card before can spare one', () => {
    // "…of one" fits, and would leave "forty" by itself.
    expect(splitText('the mare was running at a gait of one forty', upTo(40))).toEqual(['the mare was running at a gait of', 'one forty']);
    // Two words on the card before are not enough to spare one.
    expect(splitText('galloping onward now', upTo(18))).toEqual(['galloping onward', 'now']);
  });

  it('shows every word once, in order, whatever fits', () => {
    for (const room of [8, 12, 20, 33, 47, 60, 200]) expect(splitText(CUE, upTo(room)).join(' '), `${room} characters`).toBe(CUE);
  });

  it('is one card when the whole fits', () => {
    expect(splitText(CUE, () => true)).toEqual([CUE]);
  });
});

describe('a cue dealt onto cards', () => {
  const line = (text: string, speaker = '') => ({ kind: 'speech', speaker, text });
  const fits = (room: number) => (card: { text: string }[]) => card.reduce((sum, l) => sum + l.text.length, 0) <= room && card.length <= 2;

  it('keeps whole lines together while they fit', () => {
    const lines = [line('Is she off the ground?', 'STANFORD'), line('She is.', 'MUYBRIDGE')];
    expect(deal(lines, fits(40))).toEqual([lines]);
  });

  it('gives a line that fits no card its own cards, each with its speaker', () => {
    const lines = [line('Plate 700.'), line(CUE, 'NARRATOR')];
    const cards = deal(lines, fits(56));
    expect(cards).toEqual([[line('Plate 700.')], [line('Palo Alto, 19 June 1878: Sallie Gardner at a gallop,', 'NARRATOR')], [line('a photograph every 27 inches.', 'NARRATOR')]]);
  });
});

describe('how long each card stands', () => {
  it('is its share of the cue by its characters, and adds up to the cue', () => {
    const shares = shareTime([24, 27, 29], 5.4, 1.2);
    expect(shares?.map((s) => Number(s.toFixed(3)))).toEqual([1.62, 1.823, 1.958]);
    expect(shares?.reduce((sum, s) => sum + s, 0)).toBeCloseTo(5.4, 9);
  });

  it('is never under the floor: the short card is held at it and the others give the time up', () => {
    const shares = shareTime([4, 40, 40], 6, 1.2);
    expect(shares?.[0]).toBeCloseTo(1.2, 9);
    expect(shares?.[1]).toBeCloseTo(2.4, 9);
    expect(shares?.reduce((sum, s) => sum + s, 0)).toBeCloseTo(6, 9);
    for (const share of shareTime([1, 2, 3, 60], 5, 1.2) ?? []) expect(share).toBeGreaterThanOrEqual(1.2 - 1e-9);
  });

  it('says so when the cue is too short to give every card the floor', () => {
    expect(shareTime([24, 27, 29], 3.5, 1.2)).toBeNull();
    expect(shareTime([24, 27, 29], 3.6, 1.2)).not.toBeNull();
  });

  it('gives one card the whole cue', () => {
    expect(shareTime([82], 0.8, 1.2)).toEqual([0.8]);
  });

  it('names the card for a moment of the cue', () => {
    const shares = [1.62, 1.823, 1.957];
    expect(cardAt(shares, 0)).toBe(0);
    expect(cardAt(shares, 1.61)).toBe(0);
    expect(cardAt(shares, 1.62)).toBe(1);
    expect(cardAt(shares, 3.44)).toBe(1);
    expect(cardAt(shares, 3.45)).toBe(2);
    expect(cardAt(shares, 99)).toBe(2);
    expect(cardAt([5.4], 3)).toBe(0);
  });
});
