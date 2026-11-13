import { describe, expect, it } from 'vitest';
import { FEATURES, formatFeatures, parseFeatures } from '@/skins/flipbook/feature-list';

/** `features` on <video-player>: presets, lists, defaults (src/skins/flipbook/features.ts). */
describe('parseFeatures', () => {
  it('is the whole book when the attribute is missing', () => {
    expect([...parseFeatures(null)]).toEqual([...FEATURES]);
    expect([...parseFeatures(undefined)]).toEqual([...FEATURES]);
  });

  it('reads the presets', () => {
    expect(parseFeatures('essential').size).toBe(0);
    expect([...parseFeatures('book')]).toEqual([...FEATURES]);
  });

  it('is the core alone for an empty attribute', () => {
    expect(parseFeatures('').size).toBe(0);
    expect(parseFeatures('   ').size).toBe(0);
  });

  it('adds named extras to the core, in any case and with commas or spaces', () => {
    expect([...parseFeatures('essential plate ribbons')].sort()).toEqual(['plate', 'ribbons']);
    expect([...parseFeatures('Plate,RIBBONS')].sort()).toEqual(['plate', 'ribbons']);
    expect([...parseFeatures('deck  turns')].sort()).toEqual(['deck', 'turns']);
  });

  it('ignores words it does not know', () => {
    expect([...parseFeatures('plate sparkles')]).toEqual(['plate']);
  });

  it('lets book win over a narrower list', () => {
    expect(parseFeatures('plate book').size).toBe(FEATURES.length);
  });
});

describe('formatFeatures', () => {
  it('names a preset when the set is one', () => {
    expect(formatFeatures([])).toBe('essential');
    expect(formatFeatures(FEATURES)).toBe('book');
  });

  it('lists the extras in their order otherwise, and round-trips', () => {
    const value = formatFeatures(['ribbons', 'plate']);
    expect(value).toBe('ribbons plate');
    expect([...parseFeatures(value)].sort()).toEqual(['plate', 'ribbons']);
  });
});
