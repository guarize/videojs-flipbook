import type { I18nController } from '@videojs/html/i18n';
import { registerI18n } from '@videojs/html/i18n';

/*
 * Flipbook's own strings, in Video.js's registry so a locale pack can translate them. English is the default; each
 * part asks the player's translator for these keys and falls back to the same English.
 */
export const FLIPBOOK_TEXT = {
  'flipbook.scrubHalf': 'Half speed',
  'flipbook.scrubQuarter': 'Quarter speed',
  'flipbook.scrubFine': 'Fine',
  'flipbook.chapters': 'Chapters',
  'flipbook.chapter': 'Chapter {number}: {title}',
  'flipbook.chapterTab': '{number} {title}, chapter, {time}',
  'flipbook.turnedTo': 'Chapter {number}: {title}, {time}',
  'flipbook.nextChapter': '{next} {title}, turn to this chapter',
  'flipbook.next': 'Next',
  'flipbook.page': 'p. {page} / {total}',
  'flipbook.pageShort': 'p. {page}',
  'flipbook.loading': 'Loading',
  'flipbook.pageLabel': 'Page {page} of {total}',
  // The hand on the fore-edge (flip.ts): its speed over the ribbon, and where it came to rest, said once.
  'flipbook.flipRate': '{rate}×',
  'flipbook.rested': 'Page {page} of {total}, {chapter}, {time}',
  'flipbook.restedPlain': 'Page {page} of {total}, {time}',
  'flipbook.forward': '+{seconds} s',
  'flipbook.backward': '−{seconds} s',
  'flipbook.plate': 'Plate',
  'flipbook.plateTitle': 'Plate · {from} – {to}',
  'flipbook.plateLabel': 'Frames around {time}',
  'flipbook.frame': 'Frame {number} of {total}, {time}',
  // A frame of the plate shows its number and its time: its name starts with what is printed (WCAG 2.5.3).
  'flipbook.plateFrame': '{number} {time}, frame {number} of {total}',
  'flipbook.plateClose': 'Close the plate',
  'flipbook.jacketMeta': '{count} chapters · {length}',
  'flipbook.jacketPlay': 'Open the book',
  'flipbook.scanHint': 'Drag across to open',
  'flipbook.pipPlaying': 'Playing in picture-in-picture',
  'flipbook.pipBack': 'Bring it back',
  'flipbook.pipReturned': 'Back in the page',
  // The error dialog, in the skin's own words for each media error code (errors.ts), never the browser's raw message.
  'flipbook.errorTitle': 'The film can’t play',
  'flipbook.errorAborted': 'Loading stopped before the film was ready. Close this and press Play to try again.',
  'flipbook.errorNetwork': 'The film couldn’t load over this connection. Check the connection, then press Play to try again.',
  'flipbook.errorDecode': 'Part of the film couldn’t be read. Reload the page to try again.',
  'flipbook.errorSource': 'This browser can’t open the film’s file, or the file has moved. Reload the page, or try another browser.',
  'flipbook.errorEncrypted': 'The film couldn’t be unlocked for playback in this browser.',
  'flipbook.errorUnknown': 'Something stopped the film. Reload the page to try again.',
  // The missing page (details.ts, `states`): the dialog with its retry key, and a film that has no captions.
  'flipbook.errorRetry': 'Try again',
  'flipbook.missAborted': 'Loading stopped before the film was ready. Try again to load it.',
  'flipbook.missNetwork': 'The film couldn’t load over this connection. Check the connection, then try again.',
  'flipbook.missOffline': 'This device is offline. Reconnect, then try again.',
  'flipbook.missDecode': 'Part of the film couldn’t be read. Try again. If it stops at the same place, reload the page.',
  'flipbook.missSource': 'This browser can’t open the film’s file, or the file has moved. Try again, or open the page in another browser.',
  'flipbook.missUnknown': 'Something stopped the film. Try again, or reload the page.',
  'flipbook.captionsNone': 'This film has no captions.',
  'flipbook.captionsNoneShort': 'None',
  'flipbook.captions': 'Captions',
  // Settings on a narrow player, where the slab has no room for these keys (menu.ts).
  'flipbook.menuMute': 'Mute',
  'flipbook.menuVolume': 'Volume',
  'flipbook.menuPip': 'Picture in picture',
  // An iPhone gives the whole screen to its own player only: the plain film, without the book (menu.ts, screen.ts).
  'flipbook.menuSystem': 'Full screen in the system player',
  // The page flutter under a hand on the fore-edge (flutter.ts, sound.ts): on until the viewer turns it off.
  'flipbook.menuSound': 'Page sound',
  'flipbook.soundOn': 'Page sound on',
  'flipbook.soundOff': 'Page sound off',
  // Quality in Settings (quality.ts): the stream's heights, and what is said when one is chosen or cannot be had.
  'flipbook.qualityAuto': 'Auto',
  'flipbook.qualitySet': 'Quality: {name}',
  'flipbook.qualityFailed': '{name} couldn’t be loaded. Playing on Auto.',
  // Tear out the page (tear.ts): the paused page kept as a picture, and a link that opens the film on it.
  'flipbook.keep': 'Keep this page',
  'flipbook.keepSaved': 'Page {page} saved',
  'flipbook.keepShared': 'Page {page} shared',
  'flipbook.keepLinkOnly': 'This page can’t be saved as a picture here. Copy its link instead.',
  'flipbook.keepCopy': 'Copy link to this page',
  'flipbook.keepCopied': 'Link to page {page} copied',
  'flipbook.keepLink': 'Link to page {page}',
  'flipbook.keepClose': 'Close',
  'flipbook.keepOpened': 'Opened at page {page}',
  'flipbook.sheetChapter': '{number} · {title}',
  'flipbook.colophon': 'Flipbook',
  // The dog-ear (ear.ts): the folded corner of a bookmarked page, and its undo.
  'flipbook.earRemoved': 'Bookmark removed',
  'flipbook.earUndo': 'Undo',
  'flipbook.earUndoLabel': 'Undo: put the bookmark at {time} back',
} as const;

export type FlipbookKey = keyof typeof FLIPBOOK_TEXT;

const nested: Record<string, Record<string, string>> = { flipbook: {} };
for (const [key, value] of Object.entries(FLIPBOOK_TEXT)) nested.flipbook[key.split('.')[1]] = value;
registerI18n('en', nested as unknown as Parameters<typeof registerI18n>[1]);

/** The translated text for a key, with `{name}` placeholders filled; English when no translator is in reach. */
export function say(i18n: I18nController | null, key: FlipbookKey, values: Record<string, string | number> = {}): string {
  const fallback = FLIPBOOK_TEXT[key];
  let text: string = fallback;
  try {
    const translate = i18n?.value;
    if (translate) text = translate(key, { default: fallback });
  } catch {
    text = fallback;
  }
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ''));
}
