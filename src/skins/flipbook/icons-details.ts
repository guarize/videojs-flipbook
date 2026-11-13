import { registerIcons } from '@videojs/html/icons';
import { svg } from './icons';

/*
 * The details' glyphs (details.ts, `icons`): three controls drawn from the book's own alphabet, on the set's grid
 * (20 units, a 2-unit margin, one 1.5 line, outline at rest). They live beside the set, not in it, so the core never
 * carries them, and each stands in for one conventional glyph by name: take its token out and that key shows the shape
 * everyone knows again. Names, tooltips and accessible names are the keys' own and don't change.
 *
 * - Fullscreen: the book opened flat, a full spread; leaving it, the book closed.
 * - Volume: sheets in a stack, seen from a corner. Three sheets loud, two quiet; muted, one sheet struck through.
 * - Settings: a composing stick, the tray type is set in, with its sliding knee and the clamp that holds the measure.
 */
const sheet = (y: number) => `M10 ${y} 16.5 ${y + 3.25} 10 ${y + 6.5} 3.5 ${y + 3.25}z`;
const under = (y: number) => `M3.5 ${y} 10 ${y + 3.25} 16.5 ${y}`;

/** Each conventional glyph's name, and the book's glyph that stands in for it, by token. */
export const STAND_INS: Record<'icon-fullscreen' | 'icon-volume' | 'icon-settings', Record<string, string>> = {
  'icon-fullscreen': { 'fullscreen-enter': 'spread-open', 'fullscreen-exit': 'spread-closed' },
  'icon-volume': { 'volume-high': 'sheets-high', 'volume-low': 'sheets-low', 'volume-off': 'sheets-off' },
  'icon-settings': { gear: 'stick' },
};

registerIcons('flipbook', {
  // Two pages falling away from the gutter, as wide as the grid allows.
  'spread-open': svg(
    '<path d="M10 5.5C8.4 4.4 6 4.05 2.75 4.4v10.85c3.25-.35 5.65 0 7.25 1.1 1.6-1.1 4-1.45 7.25-1.1V4.4C14 4.05 11.6 4.4 10 5.5z"/><path d="M10 5.5v10.85"/>',
  ),
  // The same book shut: its board, the spine, and the page block showing at the foot.
  'spread-closed': svg('<path d="M5.25 14.5V5.25a1.5 1.5 0 0 1 1.5-1.5h8v9.25h-8a1.5 1.5 0 0 0 0 3h8V13"/><path d="M8.25 3.75V13"/>'),
  'sheets-high': svg(`<path d="${sheet(2.75)}"/><path d="${under(9.75)}"/><path d="${under(13.5)}"/>`),
  'sheets-low': svg(`<path d="${sheet(2.75)}"/><path d="${under(9.75)}"/>`),
  'sheets-off': svg(`<path d="${sheet(6.75)}"/><path d="M4.25 15.75 15.75 4.25"/>`),
  stick: svg('<path d="M3.25 4.75v10.5h13.5"/><path d="M6.25 15.25v-2.5M9.25 15.25v-4M12.25 15.25v-2.5"/><path d="M15.25 15.25V9.5"/><circle cx="15.25" cy="7.25" r="2"/>'),
});
