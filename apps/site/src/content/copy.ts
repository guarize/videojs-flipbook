/**
 * Every word on the page. Strings typed `Html` carry trusted inline markup (em, cite, kbd, a, and &nbsp; where a
 * break would split a number from its unit); they are written here, never taken from a visitor.
 */
type Html = string;

/** A headline whose last phrase is set in the display italic (Newsreader's own, in the same paper): `lead` then `em`. */
export interface Title {
  lead: string;
  em?: string;
  /** A whole sentence, not a phrase: set a step smaller, the italic on its own line (book.css, `h2.long`). */
  long?: boolean;
}

const site = {
  title: 'Flipbook · a Video.js skin by Gua',
  description:
    'A Video.js 10 skin that plays a film like a flipbook. Drag the book’s fore-edge and the film moves under your hand, as fast or as slow as you go.',
  share: 'Your hand is the frame rate. A Video.js 10 skin that plays a film like a flipbook.',
  /** The share picture (scripts/film-assets.mjs): the film's poster, 1200 × 630. */
  image: { path: 'media/film/share.jpg', width: 1200, height: 630, alt: 'An open book on a dark desk, its page a Muybridge photograph of a horse at a gallop. The poster of the film Locomotion.' },
  desk: '#0d0b09',
};

const masthead = {
  brand: { label: 'Gua, gua.studio', name: 'Gua', href: 'https://gua.studio' },
  nav: 'Elsewhere',
  links: [
    { label: 'Source', href: 'https://github.com/guarize/videojs-flipbook' },
    { label: 'gua.studio', href: 'https://gua.studio' },
  ],
};

const hero = {
  skip: 'Skip to the player',
  eyebrow: '<span>Flipbook</span> · a skin for Video.js&nbsp;10',
  // What only this player does, and the first thing read (the riffle chapter below shows it and says where it comes from).
  title: { lead: 'Your hand is ', em: 'the frame rate.' } satisfies Title,
  /** The one thing to do first. On a phone the line names the thumb, and asks for Play first: there the edge may wait for it. */
  try: {
    label: 'Try it.',
    wide: 'Drag along the fore-edge and the film moves at your hand’s speed.',
    phone: 'Press play, then run a thumb along the fore-edge. The film moves at your hand’s speed.',
  },
  /** The live choice of `features` on the player above; each weight is read from the audit at build time. */
  preset: {
    label: 'What the player loads',
    unit: 'kB',
    essential: { name: 'Essential', line: (kB: string) => `${kB} kB gzipped: the core alone, Video.js 10 included.` },
    book: { name: 'Full book', line: (kB: string) => `${kB} kB gzipped: the core and every extra of the book.` },
  },
  cue: 'Scroll to see how it’s made',
};

const riffle = {
  kicker: 'Flipping is playing',
  // "Moving pictures" is one noun, never split.
  title: { lead: 'The first moving\u00a0pictures were flipbooks. ', em: 'This player is one.', long: true } satisfies Title,
  body: [
    'Drag along the fore-edge and the film itself moves under your hand, forwards and back, as fast as you go. Flick forwards, and the pages fly on, slow to normal speed and play. Hold <kbd>←</kbd> or <kbd>→</kbd> and they riffle.',
    'On this page the scroll is the hand, and the horse gallops as fast as you scroll.',
  ] as Html[],
  folio: { page: '1', of: ' / 11', chapter: '2 One Gallop', note: 'One stride, in eleven photographs' },
  scrub: { scroll: 'Scroll to riffle', touch: 'Scroll to riffle' },
};

const edge = {
  kicker: 'Fore-edge',
  title: { lead: 'The fore-edge is ', em: 'the timeline.' } satisfies Title,
  body: 'Fifty-two pages, one sharp frame each, a page every 1.9 seconds of film. Each page’s edge carries a sliver of its frame, and the six chapters are cut into it as a thumb index, the way a dictionary’s letters are.',
  player: 'In the player the same edge runs along the foot. The chapters stand on it as tabs, and the pages you’ve watched turn red.',
  folio: { big: '6', of: ' chapters', chapter: '1 The Book', meta: 'p. 1, 0:00' },
  real: 'The player, paused at 0:20',
};

const plate = {
  kicker: 'The plate',
  title: { lead: 'Pause, and the film ', em: 'is print again.' } satisfies Title,
  body: [
    'Paused, you see the frame you paused on, set as a page: a paper margin, its page number, and nothing over it. In the page’s foot, one thin row: the twelve frames around the moment, a sixth of a second apart, the one you’re on marked. Click a frame and the page turns to it. <kbd>←</kbd> and <kbd>→</kbd> turn exactly one page.',
    '<kbd>P</kbd> lays the same twelve out large, four by three, numbered and timed, as Muybridge printed a horse’s gallop. It opens only when you ask.',
    '<kbd>S</kbd> keeps the page: a PNG of the frame set as a page, and a link that opens the film there.',
  ] as Html[],
  folio: { range: '0:19.0', of: ' – 0:20.8', label: 'Paused at 0:20', meta: 'frame 7 of 12' },
};

const corner = {
  kicker: 'The corner',
  title: { lead: 'Paused, the corner ', em: 'lifts on the next chapter.' } satisfies Title,
  body: [
    'The page’s top corner lifts on the next chapter’s first frame. Pull it, or click it, to turn there. <kbd>N</kbd> turns to the next chapter at any time.',
    'The other top corner is the bookmark: <kbd>B</kbd> folds it down, and a ribbon marks the page on the fore-edge.',
  ] as Html[],
  folio: { page: '11', of: ' / 52', chapter: '2 One Gallop', time: '0:20', duration: ' of 1:38' },
};

const pip = {
  kicker: 'Picture-in-picture',
  title: { lead: 'The whole book goes ', em: 'into the window.' } satisfies Title,
  body: [
    'In Chrome and Edge the whole book goes into the window: fore-edge, chapter tabs, captions and keys. Its place on the page turns over to a waiting page that keeps following the film. Press <kbd>I</kbd>.',
    'In Safari the same key opens the browser’s own video window.',
  ] as Html[],
  waiting: 'Playing in picture-in-picture',
  window: 'Picture in picture',
};

/** The measured values the page prints (src/lib/audit.ts): the copy below words them, and types none. */
export interface Measured {
  weights: { measured: string; core: string; coreJs: string; coreCss: string; book: string; extras: string; chunks: number; smallest: string; largest: string };
  ready: { desktop: string; mobile: string; runs: number };
  measured: string;
  browsers: string;
  bars: { text: number; marks: number };
  bright: { clock: string; text: string; marks: string };
  dark: { clock: string; text: string; marks: string };
  text: string;
  target: { smallest: number; widths: string };
  axe: { violations: number; scans: number; nodes: string };
  keyboard: { stops: number; ringless: number };
  shift: number;
  overflow: { clean: boolean; from: number; to: number };
  /** The page's own Lighthouse run, when one has been written (scripts/site-lighthouse.mjs). */
  lighthouse?: { mobile: number; desktop: number; runs: number; lcp: string; tbt: number; measured: string };
}

export interface Evidence {
  figure: string;
  unit?: string;
  what: string;
  detail: Html;
  /** Where the number comes from: the file, and the day it was measured. */
  source: string;
}

export interface Preference {
  /** The key the page's script reads the setting by (src/scripts/proof.ts). */
  id: 'motion' | 'contrast' | 'forced' | 'pointer' | 'data' | 'scheme';
  name: string;
  does: string;
}

export interface State {
  /** The still's file name (scripts/site-states.mjs writes it). */
  id: string;
  name: string;
  line: Html;
  alt: string;
  /** A phone's screen, upright. */
  tall?: boolean;
}

const holds = {
  kicker: 'Evidence',
  title: { lead: 'How it ', em: 'holds up.' } satisfies Title,
  items: (m: Measured): Evidence[] => [
    {
      figure: m.weights.core,
      unit: 'kB',
      what: 'Essential: the core, gzipped',
      detail: `Video.js 10 itself included: the controls, the fore-edge with its tabs and preview card, captions and every accessibility fix. Script ${m.weights.coreJs}&nbsp;kB, styles ${m.weights.coreCss}&nbsp;kB.`,
      source: `weights.json · ${m.weights.measured}`,
    },
    {
      figure: m.weights.book,
      unit: 'kB',
      what: 'The full book, gzipped',
      detail: `The core and the book’s extras: ${m.weights.extras}&nbsp;kB more, in ${m.weights.chunks} chunks of ${m.weights.smallest} to ${m.weights.largest}&nbsp;kB, each fetched the first time it’s used or while the page is idle. Essential never fetches them.`,
      source: `weights.json · ${m.weights.measured}`,
    },
    {
      figure: m.ready.desktop,
      unit: 's',
      what: 'Until the player is ready',
      detail: `On a fast connection; ${m.ready.mobile}&nbsp;s on slow 4G with a processor four times slower. The full book on the bench page, median of ${m.ready.runs} loads.`,
      source: `weights.json · ${m.weights.measured}`,
    },
    {
      figure: `${m.text}:1`,
      what: 'Lowest text contrast',
      detail: `Read from the pixels behind each label, with the film paused on its brightest frame and on its darkest, at 1280&nbsp;px and on a 390&nbsp;px phone. The bar is ${m.bars.text}:1.`,
      source: `measurements.json · ${m.measured}`,
    },
    {
      figure: String(m.target.smallest),
      unit: 'px',
      what: 'Smallest target',
      detail: `The shorter side of the smallest control, measured on the element that takes the tap, with a coarse pointer, at ${m.target.widths}&nbsp;px.`,
      source: `measurements.json · ${m.measured}`,
    },
    {
      figure: String(m.axe.violations),
      what: 'axe violations',
      detail: `In ${m.axe.scans} scans of the player’s states, ${m.axe.nodes} nodes checked against WCAG 2.1, A and AA, in ${m.browsers}.`,
      source: `measurements.json · ${m.measured}`,
    },
    {
      figure: String(m.keyboard.stops),
      what: 'Tab stops in the player',
      detail: `Tab reaches every control in the order you see it. Stops without a focus ring: ${m.keyboard.ringless}. The chapter tabs, the ribbons and the plate’s frames are one stop each, with the arrow keys inside.`,
      source: `measurements.json · ${m.measured}`,
    },
    {
      figure: String(m.shift),
      what: 'Layout shift',
      detail: `Through load and first play, in Chromium.${m.overflow.clean ? ` No sideways scroll from ${m.overflow.from} to ${m.overflow.to}&nbsp;px.` : ''}`,
      source: `measurements.json · ${m.measured}`,
    },
    ...(m.lighthouse
      ? [
          {
            figure: `${m.lighthouse.mobile} / ${m.lighthouse.desktop}`,
            what: 'Lighthouse performance, this page',
            detail: `On a phone (slow 4G, a processor four times slower; median of ${m.lighthouse.runs} runs) and on a desktop, on this build served from this machine. On the phone: largest paint ${m.lighthouse.lcp}&nbsp;s, blocking time ${m.lighthouse.tbt}&nbsp;ms.`,
            source: `site-lighthouse.json · ${m.lighthouse.measured}`,
          },
        ]
      : []),
  ],
  frames: {
    title: 'Over the brightest frame, and the darkest',
    lead: 'Each key pauses the player on that frame and takes you to it. The ratios are the lowest measured there, on the pixels behind each label.',
    bright: 'The brightest frame',
    dark: 'The darkest frame',
    meta: (f: { text: string; marks: string }) => [`text ${f.text}:1`, `icons and edges ${f.marks}:1`],
  },
  states: {
    title: 'Every state',
    lead: 'Stills of the player on this page, taken by a script from this build.',
    items: [
      { id: 'cover', name: 'Cover', line: 'Before the first play: the jacket, the title and one Play disc.', alt: 'The player before playing: a title card and a round Play key over the first frame.' },
      { id: 'playing', name: 'Playing', line: 'The controls on their own board, the chapters as tabs on the fore-edge.', alt: 'The film playing, the control bar and the fore-edge with six chapter tabs under it.' },
      { id: 'phone-sheet', name: 'Settings, on a phone', line: 'A sheet from the foot of the screen, with the book’s keys in it.', alt: 'A phone screen: the player at the top, and the Settings sheet open over the rest.', tall: true },
      { id: 'paused', name: 'Paused', line: 'The frame prints as a page: a paper margin, its page number, and the twelve frames around it in the foot.', alt: 'The paused film inside a paper margin, stamped p. 11, its top corner lifted, with a row of twelve small frames under the picture.' },
      { id: 'edge-drag', name: 'A hand on the edge', line: 'The film follows the hand, and a chip over the ribbon says how fast.', alt: 'The fore-edge fanned open under the pointer, a chip over the playhead showing the speed.' },
      { id: 'contents', name: 'Contents', line: 'The six chapters as a contents page. <kbd>T</kbd> opens it.', alt: 'A contents page over the film, listing six chapters with their times.' },
      { id: 'intertitle', name: 'Intertitle', line: 'Captions set in ink on the page under the picture, a choice in Caption style.', alt: 'The film with its caption printed in ink on a paper page under the picture.' },
      { id: 'dog-ear', name: 'Dog-ear', line: 'A bookmarked page’s corner folds down. <kbd>B</kbd> folds and unfolds it.', alt: 'The paused page with its top-left corner folded down.' },
      { id: 'torn-page', name: 'A kept page', line: '<kbd>S</kbd> tears the page out as a PNG, with a link that opens the film there.', alt: 'The paused page lifted off the player, and a slip saying the page was saved.' },
      { id: 'missing-page', name: 'Missing page', line: 'When the film fails to load: what happened, and Try again.', alt: 'A page with a torn edge over the dimmed player: The film can’t play, with Try again and OK.' },
      { id: 'back-cover', name: 'Back cover', line: 'At the end: the title again, and one key, Watch again.', alt: 'The back cover after the film ends: the title, its length and a Watch again key.' },
    ] satisfies State[],
  },
  prefs: {
    title: 'Your settings',
    lead: 'Read live from this browser. Change one in your system and its line follows.',
    waiting: 'not read',
    unknown: 'not reported here',
    items: [
      { id: 'motion', name: 'Reduced motion', does: 'When it’s on, nothing travels: no page turn, no glide after a flick, no riffle on first play. Every change still shows.' },
      { id: 'contrast', name: 'Contrast', does: 'One palette at every setting. The controls sit on their own board, never on the picture, so they read the same over any frame.' },
      { id: 'forced', name: 'Forced colours', does: 'When they’re active, each part takes the system’s colours by what it is: a control, a keycap, a surface, a selection or a focus ring.' },
      { id: 'pointer', name: 'Pointer', does: 'With a finger, a tap on the picture plays and pauses, a tap on a chapter tab goes there, and a swipe across the picture flips the film under the thumb: right is on, left is back. With a mouse, hover names a tab and shows the page under the pointer before the click.' },
      { id: 'data', name: 'Save-Data', does: 'When it’s on, nothing is fetched ahead: each of the book’s extras loads the first time it’s used.' },
      { id: 'scheme', name: 'Colour scheme', does: 'The book keeps its own materials in light and dark: a dark board, paper pages.' },
    ] satisfies Preference[],
    /** The value's words, by what the browser reports. */
    values: {
      motion: { on: 'reduce', off: 'no preference' },
      contrast: { more: 'more', less: 'less', custom: 'custom', off: 'no preference' },
      forced: { on: 'active', off: 'none' },
      pointer: { coarse: 'finger', fine: 'mouse or trackpad', none: 'none' },
      data: { on: 'on', off: 'off' },
      scheme: { dark: 'dark', light: 'light' },
    },
  },
};

export interface Chapter {
  name: string;
  /** What the chapter shows, and the photographs it is made from. */
  shows: Html;
}

const film = {
  kicker: 'Locomotion',
  title: { lead: 'The film' } satisfies Title,
  lead: '<cite>Locomotion</cite>, 98 seconds in six chapters. A book of Eadweard Muybridge’s motion photographs lies on a desk. Its pages are turned one at a time, then riffled, and the animals run.',
  chapters: [
    { name: 'The Book', shows: 'A book on a dark desk, opened at its title page.' },
    { name: 'One Gallop', shows: 'Muybridge, <cite>The Horse in Motion</cite>, 1878: Sallie Gardner at a gallop, turned a page at a time, then riffled.' },
    { name: 'The Herd', shows: 'Muybridge, <cite>Animal Locomotion</cite>, 1887: plate 700, a buffalo; plate 683, a Virginia deer; plate 720, a cat.' },
    { name: 'Flight', shows: '<cite>Animal Locomotion</cite>, plate 759: a cockatoo in flight.' },
    { name: 'Torn Out', shows: 'One page, the horse with all four hooves off the ground, comes out of the book.' },
    { name: 'Colophon', shows: 'The last page: the credits.' },
  ] satisfies Chapter[],
  /** Where the film plays from, and what a hand flips (apps/preview/src/site/media.ts): said plainly. */
  source: 'The film plays from Mux. While you drag the fore-edge, a 720p copy of the same film, served with this page, shows the pages under your hand, and the stream picks up where your hand lands.',
  credits: { label: 'Every source, with its page and licence', href: 'https://github.com/guarize/videojs-flipbook/blob/main/media-src/film/CREDITS.md' },
};

const colophon = {
  title: 'Colophon',
  body: 'Built on <a href="https://videojs.org">Video.js 10</a> by Pedro Guarize for the Video.js Skins Design Challenge. Set in Newsreader and Familjen Grotesk; the player in Onest. The book on this page is drawn in CSS from the film’s own frames, and its galloping horse from the 1878 photograph the film prints. Apache 2.0.',
  /** The film's credits, word for word from media-src/film/CREDITS.md ("Text for the site and the README"). */
  film: 'Film: “Locomotion”, made for Flipbook. Photographs by Eadweard Muybridge: <cite>The Horse in Motion</cite> (1878), Library of Congress, and <cite>Animal Locomotion</cite> (1887), plates 683, 700, 720 and 759, University of Southern California Digital Library; public domain, via Wikimedia Commons. Music: “Origami” by Scott Buckley, released under <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>, <a href="https://www.scottbuckley.com.au">www.scottbuckley.com.au</a>. Set in Newsreader and Familjen Grotesk. Rendered with three.js. Music edited and mixed with page sounds.' as Html,
};

export const copy = { site, masthead, hero, riffle, edge, plate, corner, pip, holds, film, colophon };
