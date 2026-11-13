import { describe, expect, it } from 'vitest';
import { placeFits, readPlace } from '../../src/shared/extras/place';

describe('the place a viewer stopped at', () => {
  it('is read with the length of the film it was kept for', () => {
    expect(readPlace('{"t":30,"d":98}')).toEqual({ t: 30, d: 98 });
  });

  it('is not read from a bare number (kept before the length was), nor from anything else', () => {
    for (const raw of ['15', '', null, 'null', '{}', '{"t":15}', '{"t":"15","d":98}', '{"t":0,"d":98}', '{"t":15,"d":0}', '{oops']) expect(readPlace(raw)).toBeNull();
  });

  it('kept for the first film (62.867 s) is not a place in this one (98 s)', () => {
    const place = readPlace('{"t":15,"d":62.867}');
    expect(place).not.toBeNull();
    expect(placeFits(place!, 98)).toBe(false);
  });

  it('fits a film of the same length, to within a frame', () => {
    expect(placeFits({ t: 30, d: 98 }, 98)).toBe(true);
    expect(placeFits({ t: 30, d: 98 }, 98.04)).toBe(true);
    expect(placeFits({ t: 30, d: 98 }, 98.1)).toBe(false);
    expect(placeFits({ t: 30, d: 98 }, 97.9)).toBe(false);
  });

  it('is not offered beyond the film, nor too near either end', () => {
    expect(placeFits({ t: 97, d: 98 }, 98)).toBe(false);
    expect(placeFits({ t: 120, d: 98 }, 98)).toBe(false);
    expect(placeFits({ t: 3, d: 98 }, 98)).toBe(false);
  });
});
