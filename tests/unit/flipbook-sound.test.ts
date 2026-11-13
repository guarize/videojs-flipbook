import { describe, expect, it } from 'vitest';
import { resolveSound } from '../../src/skins/flipbook/sound';

describe('the page sound (sound.ts)', () => {
  it('is on when nobody has said anything', () => {
    expect(resolveSound(null, null)).toBe(true);
    expect(resolveSound(null, 'on')).toBe(true);
  });

  it('is the viewer’s choice once made', () => {
    expect(resolveSound('on', null)).toBe(true);
    expect(resolveSound('off', null)).toBe(false);
    expect(resolveSound('off', 'on')).toBe(false);
  });

  it('is never on where the page has taken it away', () => {
    expect(resolveSound('on', 'off')).toBe(false);
    expect(resolveSound(null, 'off')).toBe(false);
  });
});
