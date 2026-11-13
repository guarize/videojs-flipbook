import { registerIcons } from '@videojs/html/icons';

/*
 * Flipbook's own set: drawn at the size it renders (20 px, so every stroke lands on the pixel grid), on a 20-unit grid
 * with a 2-unit margin, one 1.5 line with round caps and joins. Outline is the resting state; a control that is on
 * (captions shown, the page bookmarked, the film in its own window) fills. Pen on paper, as the cards are printed.
 *
 * Where the meaning is the book's, the glyph is the book's: the ten-second skips are a page with its corner turning
 * back or on, the bookmark a ribbon, the contents a contents page, picture-in-picture a page lifting out of the page.
 * Play, pause, volume, captions, settings and fullscreen stay the shapes everyone knows, drawn with the same pen.
 */
export const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const speaker = '<path d="M3.75 7.75h2.5l3.75-3.25v11l-3.75-3.25h-2.5z"/>';
// The two Cs of a caption block, as one line each.
const cc = 'M8.75 8.1a2 2 0 1 0 0 2.8M14.25 8.1a2 2 0 1 0 0 2.8';

/*
 * The skips: the corner of a page curling over, and "10" beside it. Forward curls the top right corner, where the
 * reader's corner lifts on the picture (curl.css); back curls the top left, as you turn back to the page before. The
 * page is drawn by the two edges that meet at the corner, so the figures stand in the open, 8 units tall and drawn
 * rather than set, keeping the pen's weight: a 1 with its flag, and a 0 as a tall round box.
 */
const tenForward = 'M3.5 9.75 4.75 8.75v8M7.25 11a2.25 2.25 0 0 1 4.5 0v3.5a2.25 2.25 0 0 1-4.5 0z';
const tenBack = 'M8.25 9.75 9.5 8.75v8M12 11a2.25 2.25 0 0 1 4.5 0v3.5a2.25 2.25 0 0 1-4.5 0z';

/*
 * Picture-in-picture: the page, with a smaller page lifting out over its lower right corner, its edge standing proud of
 * the page beneath. The big page breaks where the small one covers it. In the window, the small page is filled.
 */
const pipPage = '<path d="M9.25 15.75h-4.5a2 2 0 0 1-2-2v-7.5a2 2 0 0 1 2-2h10.5a2 2 0 0 1 2 2v2.5"/>';
const pipLift = 'M11.75 10.75h5.5a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-5.5a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z';

const icons = {
  // The triangle's box sits a little right of the grid's centre, so its weight (on the flat side) reads centred.
  play: svg('<path d="M6.75 4.85v10.3a.75.75 0 0 0 1.15.64l8.2-5.15a.75.75 0 0 0 0-1.28L7.9 4.21a.75.75 0 0 0-1.15.64z"/>'),
  pause: svg('<rect x="5.25" y="4.25" width="3" height="11.5" rx="1"/><rect x="11.75" y="4.25" width="3" height="11.5" rx="1"/>'),
  restart: svg('<path d="M4.4 11.5a5.75 5.75 0 1 0 1.3-5.2"/><path d="M4.75 3.25v3.5h3.5"/>'),
  'volume-high': svg(`${speaker}<path d="M13 7.6a3.4 3.4 0 0 1 0 4.8"/><path d="M15.1 5.4a6.5 6.5 0 0 1 0 9.2"/>`),
  'volume-low': svg(`${speaker}<path d="M13 7.6a3.4 3.4 0 0 1 0 4.8"/>`),
  'volume-off': svg(`${speaker}<path d="m13 8 4 4M17 8l-4 4"/>`),
  // Captions: the block outlined while they're off; on, it fills and the Cs are cut out of it.
  'captions-off': svg(`<rect x="2.75" y="4.25" width="14.5" height="11.5" rx="2"/><path d="${cc}"/>`),
  'captions-on': svg(
    `<mask id="fb-icon-cc-on" maskUnits="userSpaceOnUse" x="0" y="0" width="20" height="20"><rect x="2" y="3.5" width="16" height="13" rx="2.75" fill="#fff" stroke="none"/><path d="${cc}" stroke="#000"/></mask><rect x="2" y="3.5" width="16" height="13" rx="2.75" fill="currentColor" stroke="none" mask="url(#fb-icon-cc-on)"/>`,
  ),
  // Crop marks: they open outward to enter, and turn in to leave.
  'fullscreen-enter': svg('<path d="M3.75 7.25v-3.5h3.5M12.75 3.75h3.5v3.5M16.25 12.75v3.5h-3.5M7.25 16.25h-3.5v-3.5"/>'),
  'fullscreen-exit': svg('<path d="M7.25 3.75v3.5h-3.5M16.25 7.25h-3.5v-3.5M12.75 16.25v-3.5h3.5M3.75 12.75h3.5v3.5"/>'),
  'pip-enter': svg(`${pipPage}<path d="${pipLift}"/>`),
  'pip-exit': svg(`${pipPage}<path d="${pipLift}" fill="currentColor"/>`),
  gear: svg(
    '<path d="M8.81 2.85h2.38l.16 1.72 1.54.63 1.33-1.1 1.68 1.68-1.1 1.33.63 1.54 1.72.16v2.38l-1.72.16-.63 1.54 1.1 1.33-1.68 1.68-1.33-1.1-1.54.63-.16 1.72H8.81l-.16-1.72-1.54-.63-1.33 1.1-1.68-1.68 1.1-1.33-.63-1.54-1.72-.16V8.81l1.72-.16.63-1.54-1.1-1.33 1.68-1.68 1.33 1.1 1.54-.63z"/><circle cx="10" cy="10" r="2.25"/>',
  ),
  chevron: svg('<path d="m8 5.5 4.5 4.5L8 14.5"/>'),
  check: svg('<path d="m4.75 10.25 3.5 3.5 7-7.5"/>'),
  'seek-back': svg(`<path d="M16.75 2.75H9.25l-6 6v8.5"/><path d="M9.25 2.75c0 3.5-2 6-6 6"/><path d="${tenBack}"/>`),
  'seek-forward': svg(`<path d="M3.25 2.75h7.5l6 6v8.5"/><path d="M10.75 2.75c0 3.5 2 6 6 6"/><path d="${tenForward}"/>`),
  // Two pages turning: the seek indicator's mark.
  seek: svg('<path d="m4.5 5.5 4.5 4.5-4.5 4.5M10.5 5.5 15 10l-4.5 4.5"/>'),
  spinner: svg('<path d="M10 3.25A6.75 6.75 0 1 1 3.25 10" />'),
  speed: svg('<path d="M3.6 13.75a6.75 6.75 0 1 1 12.8 0"/><path d="m10 11 3-3.25"/>'),
  switches: svg('<path d="M3.75 6.75h2M9.75 6.75h6.5M3.75 13.25h6.5M14.25 13.25h2"/><circle cx="7.75" cy="6.75" r="2"/><circle cx="12.25" cy="13.25" r="2"/>'),
  speech: svg('<path d="M3.75 5.25a1.5 1.5 0 0 1 1.5-1.5h9.5a1.5 1.5 0 0 1 1.5 1.5v6.5a1.5 1.5 0 0 1-1.5 1.5H9.5l-3.25 3v-3h-1a1.5 1.5 0 0 1-1.5-1.5z"/>'),
  'airplay-enter': svg('<path d="M5.25 13.75h-.5a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2h10.5a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-.5"/><path d="m10 11.5 3.25 4.75h-6.5z"/>'),
  'airplay-exit': svg('<path d="M5.25 13.75h-.5a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2h10.5a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-.5"/><path d="m10 11.5 3.25 4.75h-6.5z" fill="currentColor"/>'),
  'cast-enter': svg('<path d="M2.75 7.25v-1.5a2 2 0 0 1 2-2h10.5a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-4"/><path d="M2.75 10.25a6 6 0 0 1 6 6M2.75 13.25a3 3 0 0 1 3 3"/>'),
  'cast-exit': svg('<path d="M2.75 7.25v-1.5a2 2 0 0 1 2-2h10.5a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-4"/><path d="M2.75 10.25a6 6 0 0 1 6 6M2.75 13.25a3 3 0 0 1 3 3"/><path d="M6.25 6.75h7.5v6"/>'),
};

registerIcons('flipbook', icons);
