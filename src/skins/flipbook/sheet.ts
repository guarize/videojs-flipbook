import { UIElement } from '@videojs/html';
import { I18nController, i18nContext } from '@videojs/html/i18n';
import { reducedMotion } from './book';
import { isPlainKey, type PagesKey, tell } from './pages';
import './sheet.css';

let uid = 0;

/**
 * A small page laid over the player as a modal dialog: the keymap card and the caption style page. The rest of the
 * player sleeps (inert) while it's open; Tab goes round its own stops; its keys never reach the player's shortcuts;
 * Escape, the close key or a click on the dimmed picture close it and put focus back where it was. It settles in from
 * a slight lift in 200 ms, and simply appears under reduced motion.
 */
export abstract class FbSheetElement extends UIElement {
  protected i18n = new I18nController(this, i18nContext);
  protected container: HTMLElement | null = null;
  protected page: HTMLElement | null = null;
  protected abort: AbortController | null = null;
  protected sheetId = `fb-sheet-${++uid}`;
  #opener: HTMLElement | null = null;
  #inerted: HTMLElement[] = [];

  /** The action name its keys carry (`data-fb-action`), and the key that opens it anywhere in the player. */
  protected abstract action: string;
  protected abstract matchesKey(event: KeyboardEvent): boolean;
  protected abstract overline: PagesKey | null;
  protected abstract heading: PagesKey;
  /** The page's body, built once. */
  protected abstract body(): HTMLElement;
  /** Called on each open, to refresh what the page shows. */
  protected onOpen() {}

  protected t(key: PagesKey, values: Record<string, string | number> = {}) {
    return tell(this.i18n, key, values);
  }

  connectedCallback() {
    super.connectedCallback();
    this.abort?.abort();
    this.abort = new AbortController();
    const { signal } = this.abort;
    this.hidden = true;
    this.setAttribute('data-fb-overlay', '');
    this.classList.add('fb-sheet');
    const container = this.closest<HTMLElement>('media-container');
    this.container = container;
    if (!container) return;

    const id = this.sheetId;
    const scrim = document.createElement('div');
    scrim.className = 'fb-sheet-scrim';
    const page = document.createElement('div');
    page.className = 'fb-sheet-page';
    page.setAttribute('role', 'dialog');
    page.setAttribute('aria-modal', 'true');
    page.setAttribute('aria-labelledby', `${id}-title`);
    page.innerHTML = [
      '<div class="fb-sheet-head">',
      // The overline is a printer's kicker, set in capitals; the title already says what the page is.
      `<p class="fb-sheet-overline" aria-hidden="true"></p>`,
      `<h2 class="fb-sheet-title" id="${id}-title"></h2>`,
      '<button type="button" class="fb-sheet-close"><media-icon family="flipbook" name="close"></media-icon></button>',
      '</div>',
    ].join('');
    const body = this.body();
    body.classList.add('fb-sheet-body');
    page.append(body);
    this.page = page;
    this.replaceChildren(scrim, page);

    this.addEventListener('keydown', (event) => this.#key(event), { signal });
    for (const type of ['pointerdown', 'pointerup', 'click', 'dblclick']) {
      this.addEventListener(type, (event) => event.stopPropagation(), { signal });
    }
    scrim.addEventListener('click', () => this.close(), { signal });
    page.querySelector('.fb-sheet-close')?.addEventListener('click', () => this.close(), { signal });

    container.addEventListener('click', (event) => {
      const trigger = (event.target as Element | null)?.closest<HTMLElement>(`[data-fb-action="${this.action}"]`);
      if (trigger && container.contains(trigger) && !this.contains(trigger)) this.open(trigger);
    }, { signal });
    container.addEventListener('keydown', (event) => {
      if (!this.hidden || event.repeat || !this.matchesKey(event)) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
      if ((event.target as Element | null)?.closest('[aria-modal="true"]')) return;
      event.preventDefault();
      this.open(document.activeElement as HTMLElement | null);
    }, { signal });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.abort?.abort();
    this.#release();
  }

  #text() {
    const set = (selector: string, text: string) => {
      const node = this.querySelector<HTMLElement>(selector);
      if (node && node.textContent !== text) node.textContent = text;
    };
    set('.fb-sheet-overline', this.overline ? this.t(this.overline) : '');
    this.querySelector('.fb-sheet-overline')?.toggleAttribute('hidden', !this.overline);
    set('.fb-sheet-title', this.t(this.heading));
    this.querySelector('.fb-sheet-close')?.setAttribute('aria-label', this.t('fbPages.close'));
  }

  #names() {
    // A group's legend is set in capitals by CSS, which a screen reader may spell out letter by letter: the group is
    // named with the legend as written.
    for (const legend of this.querySelectorAll('fieldset > legend')) {
      const text = legend.textContent?.trim();
      if (text) legend.parentElement?.setAttribute('aria-label', text);
    }
  }

  open(opener: HTMLElement | null) {
    const container = this.container;
    if (!container || !this.hidden) return;
    // One page at a time: another one open closes first.
    for (const other of container.querySelectorAll<HTMLElement & { close?: () => void }>('[data-fb-overlay][data-open]')) {
      if (other !== this && typeof other.close === 'function') other.close();
    }
    this.#opener = opener && container.contains(opener) && opener !== document.body ? opener : container;
    // Opened from Settings on a phone (menu.ts presses the key, which isn't shown there): focus goes back to the
    // Settings key, the one that was pressed.
    if (this.#opener !== container && this.#opener.getClientRects().length === 0) {
      const settings = container.querySelector<HTMLElement>('.fb-settings');
      this.#opener = settings?.getClientRects().length ? settings : container;
    }
    this.#text();
    this.onOpen();
    this.#names();
    this.hidden = false;
    this.toggleAttribute('data-open', true);
    container.toggleAttribute('data-fb-sheet', true);
    this.#inerted = Array.from(container.children).filter(
      (el): el is HTMLElement => el !== this && el instanceof HTMLElement && !el.inert && !el.matches('.fb-voice, [role="status"]'),
    );
    for (const el of this.#inerted) el.inert = true;
    const first = this.querySelector<HTMLElement>('[data-autofocus]') ?? this.#stops()[0];
    first?.focus({ preventScroll: true });
    // Opened on a small player, the focused control may sit below the panel's fold: bring it into view, inside the panel.
    first?.scrollIntoView({ block: 'nearest' });
    if (!reducedMotion.matches) {
      this.page?.animate(
        [
          { transform: 'translateY(8px) scale(0.985)', opacity: 0 },
          { transform: 'none', opacity: 1 },
        ],
        { duration: 200, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' },
      );
    }
  }

  close() {
    if (this.hidden) return;
    this.#release();
    this.container?.toggleAttribute('data-fb-sheet', false);
    this.toggleAttribute('data-open', false);
    this.#opener?.focus({ preventScroll: true });
    this.#opener = null;
    if (reducedMotion.matches || !this.page) {
      this.hidden = true;
      return;
    }
    this.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' }).finished.then(
      () => {
        if (!this.hasAttribute('data-open')) this.hidden = true;
      },
      () => {},
    );
  }

  #release() {
    for (const el of this.#inerted) el.inert = false;
    this.#inerted = [];
  }

  #stops(): HTMLElement[] {
    return Array.from(
      this.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([type="radio"]), input[type="radio"]:checked, [tabindex="0"], a[href]'),
    ).filter((el) => !el.closest('[hidden]') && el.getClientRects().length > 0);
  }

  #key(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.close();
      return;
    }
    if (event.key === 'Tab') {
      const stops = this.#stops();
      if (stops.length) {
        const at = stops.indexOf(document.activeElement as HTMLElement);
        const next = event.shiftKey ? (at <= 0 ? stops.length - 1 : at - 1) : at === stops.length - 1 ? 0 : at + 1;
        event.preventDefault();
        stops[next].focus();
      }
    } else if (this.matchesKey(event) && isPlainKey(event)) {
      // The key that opened it closes it again.
      event.preventDefault();
      this.close();
    }
    event.stopPropagation();
  }
}
