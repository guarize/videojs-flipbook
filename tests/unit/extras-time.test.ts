import { describe, expect, it, vi } from 'vitest';

vi.mock('@videojs/html/i18n', () => ({ registerI18n: () => undefined }));
const { clock, parseTime } = await import('../../src/shared/extras/i18n');

describe('typing a time', () => {
  it('reads the ways people write a time', () => {
    expect(parseTime('1:23')).toBe(83);
    expect(parseTime('83')).toBe(83);
    expect(parseTime('1:02:03')).toBe(3723);
    expect(parseTime(' 0:05 ')).toBe(5);
    expect(parseTime('83s')).toBe(83);
    expect(parseTime('1m23s')).toBe(83);
    expect(parseTime('1h2m')).toBe(3720);
  });

  it('refuses what is not a time', () => {
    for (const bad of ['', 'abc', '1:2:3:4', '1::2', '-5', '1:x']) expect(parseTime(bad)).toBeNull();
  });

  it('writes a time as people say it', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(42.9)).toBe('0:42');
    expect(clock(725)).toBe('12:05');
    expect(clock(3723)).toBe('1:02:03');
    expect(clock(-3)).toBe('0:00');
  });
});
