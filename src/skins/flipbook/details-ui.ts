import { UIElement } from '@videojs/html';
import { I18nController, i18nContext } from '@videojs/html/i18n';
import { say } from './i18n';
import { STAND_INS } from './icons-details';

/** What a keycap prints, as the `key` a keydown carries. Single characters are themselves. */
const NAMED: Record<string, string> = {
  space: ' ',
  esc: 'Escape',
  enter: 'Enter',
  tab: 'Tab',
  home: 'Home',
  end: 'End',
  '←': 'ArrowLeft',
  '→': 'ArrowRight',
  '↑': 'ArrowUp',
  '↓': 'ArrowDown',
};
/** A sort stays down at least this long, so a quick tap of the key still shows (the bottom of the motion band). */
const DOWN_MS = 150;

/** Whether a keycap's printed text ("T", "⇧C", "?", "Space") is the key this event carries. */
export function capMatches(text: string, event: Pick<KeyboardEvent, 'key' | 'shiftKey'>): boolean {
  const printed = text.trim();
  if (!printed) return false;
  const shifted = printed.startsWith('⇧') && printed.length > 1;
  const name = shifted ? printed.slice(1) : printed;
  if (shifted !== event.shiftKey && /^[a-z]$/i.test(name)) return false;
  const key = NAMED[name.toLowerCase()] ?? name;
  return key.length === 1 ? event.key.toLowerCase() === key.toLowerCase() : event.key === key;
}

/**
 * The script the details need (details.ts), one per player, there only while a detail is on:
 * - `icons`: each stand-in glyph takes its key's icon by name, and gives it back when its token goes;
 * - `type`: the keycap of the key being pressed sinks, while the key is the player's (focus in it or the pointer on it);
 * - `folio`: the page number's figures each get a box of one width, so the serif's own widths never move the line;
 * - `states`: Settings says so when the film has no captions.
 * Everything else is details.css.
 */
export class FbDetailsUiElement extends UIElement {
  #i18n = new I18nController(this, i18nContext);
  #abort: AbortController | null = null;
  #folio: MutationObserver | null = null;
  #tracks: MutationObserver | null = null;
  #timers = new Map<Element, number>();

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#stop();
  }

  #stop() {
    this.#abort?.abort();
    this.#abort = null;
    this.#folio?.disconnect();
    this.#folio = null;
    this.#tracks?.disconnect();
    this.#tracks = null;
  }

  apply() {
    const container = this.closest<HTMLElement>('media-container');
    if (!container) return;
    const tokens = new Set((container.getAttribute('data-fb-details') ?? '').split(/\s+/).filter(Boolean));
    this.#stop();
    this.#icons(container, tokens);
    this.#type(container, tokens.has('type'));
    this.#figures(container, tokens.has('folio'));
    this.#captions(container, tokens.has('states'));
  }

  #icons(container: HTMLElement, tokens: Set<string>) {
    // On a phone, and on any touch screen, there is no tooltip to tell a glyph nobody has seen before: fullscreen
    // and volume keep the shapes everyone knows there (an open book reads as "contents", a stack of sheets as nothing).
    const plain = container.hasAttribute('data-fb-phone') || matchMedia('(hover: none) and (pointer: coarse)').matches;
    for (const [token, pairs] of Object.entries(STAND_INS)) {
      const on = (tokens.has('icons') || tokens.has(token)) && !(plain && token !== 'icon-settings');
      for (const [plain, own] of Object.entries(pairs)) {
        if (on) {
          for (const icon of container.querySelectorAll(`media-icon[family="flipbook"][name="${plain}"]`)) {
            icon.setAttribute('data-fb-plain', plain);
            icon.setAttribute('name', own);
          }
        } else {
          for (const icon of container.querySelectorAll(`media-icon[data-fb-plain="${plain}"]`)) {
            icon.setAttribute('name', plain);
            icon.removeAttribute('data-fb-plain');
          }
        }
      }
    }
  }

  #type(container: HTMLElement, on: boolean) {
    const release = (cap: Element) => {
      window.clearTimeout(this.#timers.get(cap));
      this.#timers.delete(cap);
      cap.removeAttribute('data-fb-down');
    };
    if (!on) {
      for (const cap of container.querySelectorAll('.fb-keycap[data-fb-down]')) release(cap);
      return;
    }
    this.#abort ??= new AbortController();
    const { signal } = this.#abort;
    signal.addEventListener('abort', () => {
      for (const cap of [...this.#timers.keys()]) release(cap);
    });
    const held = new Map<string, { caps: Element[]; since: number }>();
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
        // The player's keys are its own only with focus in it or the pointer on it (page-keys.ts).
        if (!container.matches(':hover') && !container.contains(document.activeElement)) return;
        const caps = [...container.querySelectorAll('.fb-keycap')].filter((cap) => capMatches(cap.textContent ?? '', event));
        if (!caps.length) return;
        for (const cap of caps) {
          window.clearTimeout(this.#timers.get(cap));
          this.#timers.delete(cap);
          cap.setAttribute('data-fb-down', '');
        }
        held.set(event.code, { caps, since: performance.now() });
      },
      { signal, capture: true },
    );
    const up = (code: string) => {
      const press = held.get(code);
      if (!press) return;
      held.delete(code);
      const wait = Math.max(0, DOWN_MS - (performance.now() - press.since));
      for (const cap of press.caps) this.#timers.set(cap, window.setTimeout(() => release(cap), wait));
    };
    window.addEventListener('keyup', (event) => up(event.code), { signal, capture: true });
    window.addEventListener('blur', () => [...held.keys()].forEach(up), { signal });
  }

  /** "p. 38 / 52": each figure in its own box (details.css gives the boxes one width); the text reads the same. */
  #figures(container: HTMLElement, on: boolean) {
    const folio = container.querySelector<HTMLElement>('fb-folio');
    if (!folio) return;
    if (!on) {
      if (folio.querySelector('.fb-folio-line')) folio.textContent = folio.textContent;
      return;
    }
    const set = () => {
      if (folio.querySelector(':scope > .fb-folio-line') || !folio.textContent) return;
      const text = folio.textContent ?? '';
      // One line inside the folio (which is a flex row, for its rule): the figures are set in it, not beside it.
      const line = document.createElement('span');
      line.className = 'fb-folio-line';
      line.append(
        ...text.split(/(\d)/).filter(Boolean).map((part) => {
          if (!/^\d$/.test(part)) return part;
          const figure = document.createElement('span');
          figure.className = 'fb-fig';
          figure.textContent = part;
          return figure;
        }),
      );
      folio.replaceChildren(line);
    };
    this.#folio = new MutationObserver(set);
    this.#folio.observe(folio, { childList: true, characterData: true, subtree: true });
    set();
  }

  /**
   * A film with no captions: Video.js takes the Captions row out of Settings. In its place stands a line of the page
   * with nothing to open: "Captions", and "None" where the choice would be, with the plain sentence after it for a screen reader.
   * It is the skin's own row (the real one is hidden by the library, for good reason: it has no page to open), there
   * only while the film has no captions.
   */
  #captions(container: HTMLElement, on: boolean) {
    const row = container.querySelector<HTMLElement>('.media-menu-item[commandfor="flipbook-subtitles"]');
    let none = container.querySelector<HTMLElement>('.fb-menu-none');
    if (!on || !row) {
      none?.remove();
      return;
    }
    if (!none) {
      none = document.createElement('div');
      none.className = 'media-menu-item fb-menu-none';
      none.setAttribute('role', 'menuitem');
      none.setAttribute('aria-disabled', 'true');
      none.innerHTML =
        '<media-icon family="flipbook" name="captions-off" class="media-menu-trigger-icon"></media-icon><span data-part="label"></span><span class="media-menu-hint"><span class="media-menu-hint-label"></span></span><span class="fb-voice"></span>';
      row.after(none);
    }
    const set = (selector: string, text: string) => {
      const part = none?.querySelector<HTMLElement>(selector);
      if (part && part.textContent !== text) part.textContent = text;
    };
    set('[data-part="label"]', row.querySelector('media-text')?.textContent?.trim() || say(this.#i18n, 'flipbook.captions'));
    set('.media-menu-hint-label', say(this.#i18n, 'flipbook.captionsNoneShort'));
    // Read after what is printed, as part of the row's own name (so the name still starts with its visible label).
    set('.fb-voice', say(this.#i18n, 'flipbook.captionsNone'));
    const line = none;
    const show = () => {
      line.hidden = row.getAttribute('data-availability') !== 'unavailable';
    };
    this.#tracks = new MutationObserver(show);
    this.#tracks.observe(row, { attributes: true, attributeFilter: ['data-availability'] });
    show();
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('fb-details-ui')) customElements.define('fb-details-ui', FbDetailsUiElement);
