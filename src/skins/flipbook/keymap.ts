import { type Feature, isOn } from './features';
import type { PagesKey } from './pages';
import { FbSheetElement } from './sheet';

/** Each row: the keys, as printed on keycaps, and what they do. Keys are symbols, not words, so they aren't translated. */
const KEYS: [string[], PagesKey][] = [
  [['Space', 'K'], 'fbPages.kPlay'],
  [['J', 'L'], 'fbPages.kSkip'],
  [['←', '→'], 'fbPages.kStep'],
  [['←', '→'], 'fbPages.kRiffle'],
  [['←', '→'], 'fbPages.kLeaf'],
  [[',', '.'], 'fbPages.kFrame'],
  [['↑', '↓'], 'fbPages.kVolume'],
  [['M'], 'fbPages.kMute'],
  [['0–9'], 'fbPages.kPercent'],
  [['<', '>'], 'fbPages.kSpeed'],
  [['C'], 'fbPages.kCaptions'],
  [['⇧ C'], 'fbPages.kCaptionStyle'],
  [['F'], 'fbPages.kFullscreen'],
  [['I'], 'fbPages.kPip'],
  [['T'], 'fbPages.kContents'],
  [['B'], 'fbPages.kBookmark'],
  [['[', ']'], 'fbPages.kRibbons'],
  [['N'], 'fbPages.kNext'],
  [['P'], 'fbPages.kPlate'],
  [['S'], 'fbPages.kKeep'],
  [['?'], 'fbPages.kShortcuts'],
];

function canPip(): boolean {
  return 'documentPictureInPicture' in window || ('pictureInPictureEnabled' in document && document.pictureInPictureEnabled);
}

const GESTURES: PagesKey[] = ['fbPages.gFine', 'fbPages.gFlick', 'fbPages.gWheel', 'fbPages.gSwipe', 'fbPages.gStrip', 'fbPages.gDouble', 'fbPages.gCorner', 'fbPages.gEar', 'fbPages.gTear', 'fbPages.gTime'];

/** The rows that belong to one of the book's extras: with it off, the key does nothing, so its row isn't printed. */
const BELONGS: Partial<Record<PagesKey, Feature>> = {
  'fbPages.kContents': 'contents',
  'fbPages.kBookmark': 'ribbons',
  'fbPages.kRibbons': 'ribbons',
  'fbPages.kPlate': 'plate',
  'fbPages.gStrip': 'plate',
  'fbPages.gFlick': 'deck',
  'fbPages.gWheel': 'deck',
  'fbPages.gSwipe': 'deck',
  'fbPages.kRiffle': 'deck',
  'fbPages.kLeaf': 'deck',
  'fbPages.kFrame': 'deck',
  'fbPages.gCorner': 'curl',
  'fbPages.kKeep': 'tear',
  'fbPages.gTear': 'tear',
  'fbPages.gEar': 'ear',
};

/**
 * The keymap card: every shortcut on one card, set as keycaps beside what they do, and the gestures nothing on screen
 * announces. `?` opens it anywhere in the player; on a phone-sized player a "Shortcuts" key in the top bar does too,
 * and the contents page links to it.
 */
export class FbKeymapElement extends FbSheetElement {
  protected action = 'keymap';
  protected overline: PagesKey | null = null;
  protected heading: PagesKey = 'fbPages.shortcuts';

  protected matchesKey(event: KeyboardEvent) {
    return event.key === '?';
  }

  protected body(): HTMLElement {
    const body = document.createElement('div');
    body.className = 'fb-keymap';
    // The card scrolls when the player is small or the text is large: the keyboard has to be able to scroll it too
    // (WCAG 2.1.1, 1.4.10), so it is a named Tab stop of its own.
    body.tabIndex = 0;
    body.setAttribute('role', 'region');
    body.setAttribute('aria-labelledby', `${this.sheetId}-title`);
    return body;
  }

  connectedCallback() {
    super.connectedCallback();
    // Extras turned on or off while the card is open: its rows follow, and focus stays where it is.
    this.container?.addEventListener('fb-features', () => {
      if (!this.hidden) this.#rows();
    }, { signal: this.abort?.signal });
  }

  #shows(key: PagesKey) {
    const feature = BELONGS[key];
    return !feature || isOn(this.container, feature);
  }

  /** A heading set in capitals by CSS keeps its name as written, so a screen reader says a word, not its letters. */
  #heading(section: HTMLElement, id: string, key: PagesKey) {
    const heading = section.firstElementChild as HTMLElement;
    const text = this.t(key);
    heading.textContent = text;
    heading.setAttribute('aria-label', text);
    section.setAttribute('aria-labelledby', id);
  }

  /** The keys and the gestures, for the extras that are on. */
  #sections(): HTMLElement[] {
    const id = this.sheetId;
    const keys = document.createElement('section');
    keys.innerHTML = `<h3 class="fb-keymap-heading" id="${id}-keys"></h3>`;
    this.#heading(keys, `${id}-keys`, 'fbPages.keysHeading');
    const list = document.createElement('dl');
    list.className = 'fb-keymap-list';
    for (const [caps, key] of KEYS) {
      // No row for a key that can't work here: Firefox has no picture-in-picture API, so I does nothing there.
      if (key === 'fbPages.kPip' && !canPip()) continue;
      if (!this.#shows(key)) continue;
      const row = document.createElement('div');
      row.className = 'fb-keymap-row';
      const term = document.createElement('dt');
      caps.forEach((cap, i) => {
        // Two keys in a row are alternatives: heard as "Space or K", seen as two keycaps.
        if (i) {
          const or = document.createElement('span');
          or.className = 'fb-sr-only';
          or.textContent = this.t('fbPages.or');
          term.append(' ', or, ' ');
        }
        const kbd = document.createElement('kbd');
        kbd.className = 'fb-keycap';
        kbd.textContent = cap;
        term.append(kbd);
      });
      const what = document.createElement('dd');
      what.textContent = this.t(key);
      row.append(term, what);
      list.append(row);
    }
    keys.append(list);

    const gestures = document.createElement('section');
    gestures.innerHTML = `<h3 class="fb-keymap-heading" id="${id}-gestures"></h3>`;
    this.#heading(gestures, `${id}-gestures`, 'fbPages.gesturesHeading');
    const moves = document.createElement('ul');
    moves.className = 'fb-keymap-gestures';
    for (const key of GESTURES.filter((g) => this.#shows(g))) {
      const item = document.createElement('li');
      item.textContent = this.t(key);
      moves.append(item);
    }
    gestures.append(moves);
    return [keys, gestures];
  }

  #rows() {
    const body = this.querySelector('.fb-keymap');
    const sections = body?.querySelectorAll(':scope > section');
    if (!body || !sections?.length) return;
    const [keys, gestures] = this.#sections();
    sections[0].replaceWith(keys);
    sections[1]?.replaceWith(gestures);
  }

  protected onOpen() {
    const body = this.querySelector('.fb-keymap');
    if (!body) return;
    const [keys, gestures] = this.#sections();

    // When the character keys answer (WCAG 2.1.4): said on the card, since nothing else on screen says it.
    const note = document.createElement('p');
    note.className = 'fb-keymap-note';
    note.textContent = this.t('fbPages.pageKeysNote');

    body.replaceChildren(keys, gestures, note);
  }
}

customElements.define('fb-keymap', FbKeymapElement);
