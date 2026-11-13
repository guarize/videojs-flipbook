import { tileAt } from '@/shared/storyboard';
import { loadBook, spritePosition, videoIn } from './book';
import { isOn, need } from './features';
import { frameFor, type PagesKey } from './pages';
import { FbSheetElement } from './sheet';
import './captype.css';

/** The choices, in the order they're offered; the first of each is the skin's own look. */
const GROUPS = [
  {
    // Where the cue is set: over the picture, or as an intertitle on the page under it (the `intertitle` extra).
    name: 'mode',
    legend: 'fbPages.capsMode',
    options: [
      ['picture', 'fbPages.capsOnPicture'],
      ['intertitle', 'fbPages.capsIntertitle'],
    ],
  },
  {
    name: 'size',
    legend: 'fbPages.capsSize',
    options: [
      ['m', 'fbPages.capsMedium'],
      ['s', 'fbPages.capsSmall'],
      ['l', 'fbPages.capsLarge'],
      ['xl', 'fbPages.capsLargest'],
    ],
  },
  {
    name: 'bg',
    legend: 'fbPages.capsBackground',
    options: [
      ['solid', 'fbPages.capsSolid'],
      ['translucent', 'fbPages.capsTranslucent'],
      ['outline', 'fbPages.capsOutline'],
    ],
  },
  {
    name: 'color',
    legend: 'fbPages.capsColour',
    options: [
      ['white', 'fbPages.capsWhite'],
      ['yellow', 'fbPages.capsYellow'],
    ],
  },
  {
    name: 'position',
    legend: 'fbPages.capsPosition',
    options: [
      ['auto', 'fbPages.capsAuto'],
      ['top', 'fbPages.capsTop'],
    ],
  },
] as const satisfies readonly { name: string; legend: PagesKey; options: readonly (readonly [string, PagesKey])[] }[];

type Style = Record<(typeof GROUPS)[number]['name'], string>;
const STORE = 'fb-caption-style';
/** Sizes in the order the size control shows them: smallest first, as a reader expects. */
const SIZE_ORDER = ['s', 'm', 'l', 'xl'];

const defaults = (): Style => ({ mode: 'picture', size: 'm', bg: 'solid', color: 'white', position: 'auto' });
/** The choices an intertitle makes itself: it is ink on the page, under the picture. */
const PAGE_OWN = ['bg', 'color', 'position'];

function load(): Style {
  const style = defaults();
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? '{}') as Partial<Style>;
    for (const group of GROUPS) {
      const value = saved[group.name];
      if (value && group.options.some(([v]) => v === value)) style[group.name] = value;
    }
  } catch {
    // Storage blocked or unreadable: the skin's own look.
  }
  return style;
}

/** Puts a style on the player: the caption layer (captions.ts) reads these attributes through captype.css. */
export function applyCaptionStyle(container: HTMLElement, style: Style) {
  // An intertitle is one of the book's extras: without it the cue stays on the picture, and the choice is kept.
  const intertitle = style.mode === 'intertitle' && isOn(container, 'intertitle');
  container.setAttribute('data-fb-cap-mode', intertitle ? 'intertitle' : 'picture');
  if (intertitle) void need('intertitle').catch(() => undefined);
  container.setAttribute('data-fb-cap-size', style.size);
  container.setAttribute('data-fb-cap-bg', style.bg);
  container.setAttribute('data-fb-cap-color', style.color);
  container.setAttribute('data-fb-cap-position', style.position);
}

/**
 * Caption style: a CVAA-style page Video.js doesn't have. Size, background, colour and position, each a native radio
 * group (one Tab stop, arrows choose), applied at once to the skin's own caption layer and to a preview line set on
 * the frame you're watching. Kept in this browser. One step from the captions key: the key beside it, or Shift+C.
 */
export class FbCaptionStyleElement extends FbSheetElement {
  protected action = 'caption-style';
  protected overline: PagesKey | null = 'fbPages.capsOverline';
  protected heading: PagesKey = 'fbPages.captionStyle';
  #style: Style = defaults();

  connectedCallback() {
    super.connectedCallback();
    const container = this.container;
    if (!container) return;
    this.#style = load();
    applyCaptionStyle(container, this.#style);
    // The intertitle comes and goes with its extra.
    container.addEventListener('fb-features', () => {
      applyCaptionStyle(container, this.#style);
      if (!this.hidden) this.#sync();
    }, { signal: this.abort?.signal });
    this.addEventListener('change', (event) => {
      const input = event.target as HTMLInputElement;
      if (input.type !== 'radio' || !(input.name in this.#style)) return;
      this.#style[input.name as keyof Style] = input.value;
      this.#commit();
      if (input.name === 'mode') this.#sync();
    }, { signal: this.abort?.signal });
  }

  protected matchesKey(event: KeyboardEvent) {
    return event.key === 'C' && event.shiftKey;
  }

  protected body(): HTMLElement {
    const id = this.sheetId;
    const body = document.createElement('div');
    body.className = 'fb-captype';
    body.innerHTML = [
      '<div class="fb-captype-preview" aria-hidden="true"><span class="fb-captype-frame"></span>',
      '<div class="fb-captions-lines fb-captype-lines"><span class="fb-captions-line"></span></div></div>',
      '<p class="fb-captype-off" hidden></p>',
      '<div class="fb-captype-groups"></div>',
      `<p class="fb-captype-note" id="${id}-note" hidden></p>`,
      `<div class="fb-captype-foot"><p class="fb-captype-saved" id="${id}-saved"></p>`,
      '<button type="button" class="fb-captype-reset"></button>',
      '<button type="button" class="fb-captype-done" data-fb-done></button></div>',
    ].join('');
    const groups = body.querySelector('.fb-captype-groups') as HTMLElement;
    for (const group of GROUPS) {
      const set = document.createElement('fieldset');
      set.className = 'fb-captype-group';
      set.dataset.group = group.name;
      const legend = document.createElement('legend');
      legend.dataset.key = group.legend;
      const row = document.createElement('div');
      row.className = 'fb-captype-options';
      const options = group.name === 'size' ? SIZE_ORDER.map((v) => group.options.find(([o]) => o === v) ?? group.options[0]) : group.options;
      for (const [value, key] of options) {
        const label = document.createElement('label');
        label.className = 'fb-captype-option';
        label.dataset.value = value;
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = group.name;
        input.value = value;
        input.className = 'fb-captype-input';
        const text = document.createElement('span');
        text.className = 'fb-captype-text';
        text.dataset.key = key;
        label.append(input, text);
        row.append(label);
      }
      set.append(legend, row);
      groups.append(set);
    }
    body.querySelector('.fb-captype-reset')?.addEventListener('click', () => {
      this.#style = defaults();
      this.#sync();
      this.#commit();
    });
    body.querySelector('.fb-captype-done')?.addEventListener('click', () => this.close());
    return body;
  }

  protected onOpen() {
    for (const node of this.querySelectorAll<HTMLElement>('[data-key]')) node.textContent = this.t(node.dataset.key as PagesKey);
    const set = (selector: string, key: PagesKey) => {
      const node = this.querySelector<HTMLElement>(selector);
      if (node) node.textContent = this.t(key);
    };
    set('.fb-captype-preview .fb-captions-line', 'fbPages.capsPreview');
    set('.fb-captype-saved', 'fbPages.capsSaved');
    set('.fb-captype-reset', 'fbPages.capsReset');
    set('.fb-captype-done', 'fbPages.done');
    set('.fb-captype-note', 'fbPages.capsIntertitleNote');
    // Captions are off: say so, and how to turn them on, so the changes aren't made into the void.
    const video = this.container ? videoIn(this.container) : null;
    const showing = Array.from(video?.textTracks ?? []).some((t) => t.mode === 'showing' && (t.kind === 'captions' || t.kind === 'subtitles'));
    const off = this.querySelector<HTMLElement>('.fb-captype-off');
    if (off) {
      off.hidden = showing;
      off.textContent = this.t('fbPages.capsOff');
    }
    this.#sync();
    // The first group's checked choice takes focus: the dialog opens ready to change something.
    this.querySelector<HTMLElement>('.fb-captype-input:checked')?.setAttribute('data-autofocus', '');
    void this.#frame();
  }

  /** The preview is set on the picture you're watching, sharp, so the choice is judged where it will be read. */
  async #frame() {
    const container = this.container;
    const frame = this.querySelector<HTMLElement>('.fb-captype-frame');
    if (!container || !frame) return;
    const book = await loadBook(container, new AbortController().signal);
    if (!book) return;
    const time = videoIn(container)?.currentTime ?? 0;
    frame.style.backgroundImage = 'var(--fb-sprite)';
    frame.style.backgroundSize = 'var(--fb-sprite-size)';
    frame.style.backgroundPosition = spritePosition(book, tileAt(book.tiles, time));
    const url = await frameFor(container, book, time);
    if (url) {
      frame.style.backgroundImage = `url("${url}")`;
      frame.style.backgroundSize = 'cover';
      frame.style.backgroundPosition = 'center';
    }
  }

  #sync() {
    for (const input of this.querySelectorAll<HTMLInputElement>('.fb-captype-input')) {
      input.checked = this.#style[input.name as keyof Style] === input.value;
      input.removeAttribute('data-autofocus');
    }
    // The Style group is offered only while the intertitle extra is on; with an intertitle chosen, the choices the
    // page makes itself are set aside (disabled, and said why).
    const offered = isOn(this.container, 'intertitle');
    const paged = offered && this.#style.mode === 'intertitle';
    for (const set of this.querySelectorAll<HTMLFieldSetElement>('.fb-captype-group')) {
      const name = set.dataset.group ?? '';
      if (name === 'mode') set.hidden = !offered;
      if (PAGE_OWN.includes(name)) {
        set.disabled = paged;
        if (paged) set.setAttribute('aria-describedby', `${this.sheetId}-note`);
        else set.removeAttribute('aria-describedby');
      }
    }
    const note = this.querySelector<HTMLElement>('.fb-captype-note');
    if (note) note.hidden = !paged;
  }

  #commit() {
    if (this.container) applyCaptionStyle(this.container, this.#style);
    try {
      localStorage.setItem(STORE, JSON.stringify(this.#style));
    } catch {
      // Storage blocked: the style holds for this visit.
    }
  }
}

customElements.define('fb-caption-style', FbCaptionStyleElement);
