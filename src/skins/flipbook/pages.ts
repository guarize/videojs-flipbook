import { registerIcons } from '@videojs/html/icons';
import type { I18nController } from '@videojs/html/i18n';
import { registerI18n } from '@videojs/html/i18n';
import { findMedia, tileAt } from '@/shared/storyboard';
import type { Book } from './book';
import { frameUrls } from './frames';

/*
 * What the contents page, the bookmark ribbons and the back cover share: their strings, the sharp frames their
 * thumbnails come from, a polite voice for what they change, and their icons.
 */

export const PAGES_TEXT = {
  'fbPages.contents': 'Contents',
  'fbPages.openContents': 'Contents',
  'fbPages.close': 'Close',
  'fbPages.chapters': 'Chapters',
  'fbPages.now': 'Now',
  'fbPages.summary': '{count} chapters · {length}',
  'fbPages.chapterCount': '{count} chapters',
  'fbPages.bookmarks': 'Bookmarks',
  'fbPages.contentsHint': 'Enter goes there. Delete removes a bookmark.',
  'fbPages.bookmark': 'Bookmark this moment',
  'fbPages.unbookmark': 'Remove bookmark',
  'fbPages.ribbon': 'Bookmark at {time}, {chapter}',
  'fbPages.ribbonPlain': 'Bookmark at {time}',
  'fbPages.added': 'Bookmark added at {time}',
  'fbPages.removed': 'Bookmark at {time} removed',
  'fbPages.already': 'Already bookmarked at {time}',
  'fbPages.full': '{count} bookmarks is the most. Remove one to add another.',
  'fbPages.none': 'No bookmarks yet. Press B to add one.',
  'fbPages.backCover': 'Back cover',
  'fbPages.watchAgain': 'Watch again',
  'fbPages.length': 'Length',
  'fbPages.finished': 'Finished. Watch again, or choose a chapter.',
  // v4: labels, hints, the next chapter, shortcuts and caption style.
  'fbPages.bookmarkShort': 'Bookmark',
  'fbPages.captionStyle': 'Caption style',
  'fbPages.shortcuts': 'Shortcuts',
  'fbPages.typeTime': 'Type a time',
  'fbPages.next': 'Next: {title}',
  'fbPages.hintFine': 'Drag up for finer control',
  // The same lesson where the fore-edge runs down the picture's side: away from the edge is sideways there.
  'fbPages.hintFlick': 'Flick to throw the pages',
  'fbPages.hintSwipe': 'Swipe right to flip on, left to flip back',
  'fbPages.hintBookmarkKey': 'Press {key} to bookmark this moment',
  'fbPages.hintBookmarkTouch': 'Tap the ribbon to bookmark this moment',
  'fbPages.hintBookmarkSettings': 'Settings can bookmark this moment',
  'fbPages.hintContentsKey': 'Press {key} for the contents',
  'fbPages.hintContentsTouch': 'Contents lists every chapter',
  'fbPages.keysHeading': 'Keys',
  'fbPages.gesturesHeading': 'Pointer and touch',
  'fbPages.kPlay': 'Play or pause',
  'fbPages.kSkip': 'Back or forward 10 s',
  'fbPages.kStep': 'Back or forward 5 s',
  'fbPages.kRiffle': 'Held: riffle the pages',
  'fbPages.kLeaf': 'Paused: one page back or on',
  'fbPages.kFrame': 'Paused: one frame back or on',
  'fbPages.kVolume': 'Volume',
  'fbPages.kMute': 'Mute',
  'fbPages.kPercent': 'Go to 0–90%',
  'fbPages.kSpeed': 'Slower or faster',
  'fbPages.kCaptions': 'Captions',
  'fbPages.kCaptionStyle': 'Caption style',
  'fbPages.kFullscreen': 'Full screen',
  'fbPages.kPip': 'Picture in picture',
  'fbPages.kContents': 'Contents',
  'fbPages.kBookmark': 'Bookmark this moment',
  'fbPages.kRibbons': 'Previous or next bookmark',
  'fbPages.kNext': 'Next chapter',
  'fbPages.kPlate': 'Paused: the twelve frames around the moment, large',
  'fbPages.kShortcuts': 'This card',
  'fbPages.gFine': 'Drag the edge, then away from it: finer control',
  'fbPages.gFlick': 'Flick the edge: throw the pages',
  'fbPages.gWheel': 'Scroll on the edge: riffle the pages',
  'fbPages.gSwipe': 'Swipe the picture: right flips on, left flips back',
  'fbPages.gStrip': 'Paused: a frame in the strip under the picture goes there',
  'fbPages.gDouble': 'Double-tap left or right: 10 s back or forward',
  'fbPages.gCorner': 'Pull the corner when paused: next chapter',
  'fbPages.gTime': 'Click the time: type one',
  'fbPages.kKeep': 'Keep this page as a picture',
  'fbPages.gEar': 'Fold the top-left corner: bookmark',
  'fbPages.gTear': 'Pull the paused page out: keep it as a picture',
  'fbPages.capsMode': 'Style',
  'fbPages.capsOnPicture': 'On the picture',
  'fbPages.capsIntertitle': 'Intertitle',
  'fbPages.capsIntertitleNote': 'An intertitle is set in ink on the page, under the picture. Background, colour and position are the page’s own.',
  'fbPages.capsOverline': 'Captions',
  'fbPages.capsPreview': 'Captions will look like this.',
  'fbPages.capsSize': 'Size',
  'fbPages.capsSmall': 'Small',
  'fbPages.capsMedium': 'Medium',
  'fbPages.capsLarge': 'Large',
  'fbPages.capsLargest': 'Extra large',
  'fbPages.capsBackground': 'Background',
  'fbPages.capsSolid': 'Solid',
  'fbPages.capsTranslucent': 'See-through',
  'fbPages.capsOutline': 'None, outlined',
  'fbPages.capsColour': 'Colour',
  'fbPages.capsWhite': 'White',
  'fbPages.capsYellow': 'Yellow',
  'fbPages.capsPosition': 'Position',
  'fbPages.capsAuto': 'Above the controls',
  'fbPages.capsTop': 'Top',
  'fbPages.capsSaved': 'Kept on this device.',
  'fbPages.capsReset': 'Reset',
  'fbPages.done': 'Done',
  'fbPages.capsOff': 'Captions are off. Close this page and press C to show them.',
  'fbPages.or': 'or',
  'fbPages.pageKeysNote': 'Letter, number and symbol keys work while the player has focus or the pointer is over it.',
} as const;

export type PagesKey = keyof typeof PAGES_TEXT;

const nested: Record<string, Record<string, string>> = { fbPages: {} };
for (const [key, value] of Object.entries(PAGES_TEXT)) nested.fbPages[key.split('.')[1]] = value;
registerI18n('en', nested as unknown as Parameters<typeof registerI18n>[1]);

/** The translated text for a key, with `{name}` placeholders filled; English when no translator is in reach. */
export function tell(i18n: I18nController | null, key: PagesKey, values: Record<string, string | number> = {}): string {
  const fallback = PAGES_TEXT[key];
  let text: string = fallback;
  try {
    const translate = i18n?.value;
    if (translate) text = translate(key, { default: fallback });
  } catch {
    text = fallback;
  }
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ''));
}

/* ─── Sharp frames ──────────────────────────────────────────────────────── */

/** The sharp still (a URL) for the storyboard page a time falls on, from frames.ts; null when there's none. */
export async function frameFor(container: Element, book: Book, time: number): Promise<string | null> {
  const urls = await frameUrls(container, book);
  return urls[tileAt(book.tiles, time + 0.05)] ?? null;
}

/* ─── A polite voice ────────────────────────────────────────────────────── */

const voices = new WeakMap<Element, HTMLElement>();

/**
 * Says something politely, once. The region exists (empty) before its first message, so the first one is heard; a
 * message repeated in a row is re-set so it is heard again.
 */
export function voiceFor(container: HTMLElement): (message: string) => void {
  let region = voices.get(container);
  if (!region || !region.isConnected) {
    region = document.createElement('div');
    region.className = 'fb-voice';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    region.setAttribute('aria-atomic', 'true');
    container.append(region);
    voices.set(container, region);
  }
  const live = region;
  let timer = 0;
  return (message) => {
    clearTimeout(timer);
    live.textContent = '';
    timer = window.setTimeout(() => {
      live.textContent = message;
    }, 60);
  };
}

/* ─── Shared keys ───────────────────────────────────────────────────────── */

/**
 * A shortcut pressed on the player, not typed into a field or meant for a composite widget's own keys. Keys typed on
 * the page arrive here only when page-keys.ts hands them over (a character key only with the pointer on the player).
 */
export function isPlainKey(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return false;
  const target = event.target as HTMLElement | null;
  if (!target) return true;
  if (target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return false;
  return true;
}

/**
 * The key a video is remembered by in this browser: its address, or, for a film given several sources (sources.ts),
 * the first of them, so a film that falls back to another source today is the same film.
 */
export function storageKey(container: Element, prefix: string): string {
  const media = findMedia(container);
  const src = media?.getAttribute('data-fb-film') || media?.getAttribute('src') || '';
  if (!src) return '';
  try {
    return `${prefix}:${new URL(src, location.href).pathname}`;
  } catch {
    return '';
  }
}

/* ─── Icons ─────────────────────────────────────────────────────────────── */

// The same pen as icons.ts: a 20-unit grid, a 2-unit margin, one 1.5 line, round caps and joins; fill marks "on".
const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ribbon = 'M6.25 3.75h7.5v12.5L10 13.25l-3.75 3z';

registerIcons('flipbook', {
  // A contents page: three entries, each a title, its dotted leader, and the page it starts on.
  contents: svg(
    '<path d="M3.75 5.75h5.5M3.75 10h4M3.75 14.25h6"/><path d="M11.5 5.75h.01M13.25 5.75h.01M10.5 10h.01M12.25 10h.01M14 10h.01M12.25 14.25h.01"/><path d="M15.75 5.75h.5M15.75 10h.5M15.75 14.25h.5"/>',
  ),
  // A ribbon bookmark with its notched end: outlined to mark this moment, filled once it's marked.
  bookmark: svg(`<path d="${ribbon}"/>`),
  'bookmark-on': svg(`<path d="${ribbon}" fill="currentColor"/>`),
  // A page leaving its book: the sheet, and the row of perforations along its spine edge. "Keep this page".
  keep: svg('<path d="M7.25 3.75h6.5a1.5 1.5 0 0 1 1.5 1.5v9.5a1.5 1.5 0 0 1-1.5 1.5h-6.5"/><path d="M4.75 4.25v.01M4.75 7.1v.01M4.75 10v.01M4.75 12.9v.01M4.75 15.75v.01"/><path d="M9.5 8h3.25M9.5 11h3.25"/>'),
  // A plate of frames: the sheet, ruled into its rows and columns.
  plate: svg('<rect x="2.75" y="4.75" width="14.5" height="10.5" rx="1.5"/><path d="M7.6 4.75v10.5M12.4 4.75v10.5M2.75 10h14.5"/>'),
  close: svg('<path d="m5.5 5.5 9 9M14.5 5.5l-9 9"/>'),
  // Type set large and small: caption style.
  'caption-style': svg('<path d="M2.75 15.25 6.5 4.75l3.75 10.5M4.1 11.5h4.8"/><path d="m11.5 15.25 2.6-6.5 2.6 6.5M12.4 13h3.4"/>'),
  // A keyboard: the shortcuts card.
  keys: svg('<rect x="2.75" y="5.25" width="14.5" height="9.5" rx="2"/><path d="M5.75 8.25h.01M8.6 8.25h.01M11.4 8.25h.01M14.25 8.25h.01M6.5 11.75h7"/>'),
});
