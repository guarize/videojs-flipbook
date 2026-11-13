import { type PropertyValues, UIElement } from '@videojs/html';
import { I18nController, i18nContext } from '@videojs/html/i18n';
import { type PagesKey, tell } from './pages';
import './labels.css';

/**
 * Names printed where they're used. The time plate says it takes a typed time. The keys in the top bar, on the
 * slab and on a phone's pad get their translated names. (The chapter tabs letter themselves: edge.ts; their type is in labels.css.)
 * Nothing here moves; it only writes words.
 */
export class FbLabelsElement extends UIElement {
  #i18n = new I18nController(this, i18nContext);
  #container: HTMLElement | null = null;
  #row: ResizeObserver | null = null;
  #typeIn = false;

  connectedCallback() {
    super.connectedCallback();
    this.hidden = true;
    this.#container = this.closest<HTMLElement>('media-container');
    // The pad's row of the book's keys (phone.css): its names are fitted by the pad's width in the stylesheet, from
    // the first frame. What a stylesheet cannot know (a longer language, wider letter spacing) is measured here, and
    // only once the type is in: measured in the fallback face, a row that fits would be marked and then unmarked,
    // and its keys would move twice as the page loads.
    const row = this.#container?.querySelector<HTMLElement>('.fb-book-row');
    this.#row?.disconnect();
    this.#row = row ? new ResizeObserver(() => this.#fit()) : null;
    void document.fonts.ready.then(() => {
      if (!row?.isConnected) return;
      this.#typeIn = true;
      this.#row?.observe(row);
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#row?.disconnect();
    this.#row = null;
  }

  update(changed: PropertyValues) {
    super.update(changed);
    this.#words();
  }

  #t(key: PagesKey) {
    return tell(this.#i18n, key);
  }

  /** The keys' printed names, and the time plate's affordance, in the player's language. */
  #words() {
    const container = this.#container;
    if (!container) return;
    const words: [string, PagesKey][] = [
      ['bookmark-short', 'fbPages.bookmarkShort'],
      ['caption-style', 'fbPages.captionStyle'],
      ['shortcuts', 'fbPages.shortcuts'],
    ];
    for (const [name, key] of words) {
      const text = this.#t(key);
      for (const node of container.querySelectorAll<HTMLElement>(`[data-fb-label="${name}"]`)) {
        if (node.textContent !== text) node.textContent = text;
      }
    }
    this.#fit();
    const typeTime = this.#t('fbPages.typeTime');
    const display = container.querySelector<HTMLElement>('.fb-time-display');
    if (display && display.dataset.fbHint !== typeTime) display.dataset.fbHint = typeTime;
  }

  /**
   * The pad's row of the book's keys: every key with its name where the names fit beside each other; if not, the
   * caption key as its "Aa" alone; if not even then, every key its icon alone (`data-fb-bare`: `style`, `all`).
   * Measured with the names in: the keys do not shrink, so a row too narrow for them is wider inside than out.
   */
  #fit() {
    const row = this.#container?.querySelector<HTMLElement>('.fb-book-row');
    if (!row || !row.clientWidth || !this.#typeIn) return;
    for (const step of ['', 'style', 'all']) {
      if (step) row.setAttribute('data-fb-bare', step);
      else row.removeAttribute('data-fb-bare');
      if (row.scrollWidth <= row.clientWidth) break;
    }
  }
}

customElements.define('fb-labels', FbLabelsElement);
