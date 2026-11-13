import { attach } from './companion';
import { featuresOf } from './features';

/**
 * The book's details: small touches on the controls, each one switchable on its own (a trial: every token can go
 * without a trace, and with all of them off the controls are exactly as they were).
 *
 * `data-fb-details` on the container is the one switch: space-separated tokens, read by details.css and by the
 * details' own script (extras/details.ts). Take a token out and that detail is off.
 *
 *   cloth   the slab as a bound cover: a bookcloth weave and a gilt hairline along its top edge
 *   type    the keycaps as type sorts, sinking when their key is pressed
 *   folio   the page number set as a folio, in the serif
 *   icons   the book's own glyphs for fullscreen, volume and settings; or one at a time:
 *           `icon-fullscreen`, `icon-volume`, `icon-settings`
 *   sheaf   the volume fader as the cut edge of a sheaf of pages
 *   lift    a key's plate lifts two pixels under the pointer
 *   states  the error as a missing page with a retry, and the captions page when the film has none
 *
 * Unless the page says otherwise the full book has `DEFAULT_DETAILS`, every one of them (Pedro, 11 Nov 2026: the
 * book's own volume and settings glyphs too; each key keeps its exact name and tooltip, "Volume" and "Settings", so a
 * glyph nobody has seen before is still told), and a player with no extras (`features="essential"`) has none: the
 * core carries this resolver and nothing else of them. The page says
 * otherwise with `details` on `<video-player>` (the same tokens; empty for none), or by writing `data-fb-details` on
 * the container itself.
 */
export const DETAILS = ['cloth', 'type', 'folio', 'icons', 'sheaf', 'lift', 'states'] as const;
export const DEFAULT_DETAILS = DETAILS.join(' ');

type Sync = (container: HTMLElement) => void;
let sync: Sync | null = null;
let loading: Promise<void> | null = null;

class FbDetailsElement extends HTMLElement {
  #watch: MutationObserver | null = null;
  /** What this element last wrote, so a value written by the page (or by hand) is told apart and left alone. */
  #wrote: string | null = null;

  connectedCallback() {
    this.hidden = true;
    const container = this.closest<HTMLElement>('media-container');
    if (!container) return;
    const player = container.closest('video-player');
    this.#watch = new MutationObserver((records) => {
      if (records.some((record) => record.target !== container)) this.#resolve(container, true);
      this.#apply(container);
    });
    // (`data-fb-phone`, room.ts: a phone's fullscreen and volume keys keep the conventional glyphs, details-ui.ts.)
    this.#watch.observe(container, { attributes: true, attributeFilter: ['data-fb-details', 'data-fb-phone'] });
    if (player) this.#watch.observe(player, { attributes: true, attributeFilter: ['details', 'features'] });
    this.#resolve(container, false);
    this.#apply(container);
  }

  disconnectedCallback() {
    this.#watch?.disconnect();
  }

  /** The player's `details`, or the preset's default. A value somebody else put on the container stands until the player's attributes change. */
  #resolve(container: HTMLElement, changed: boolean) {
    const current = container.getAttribute('data-fb-details');
    if (!changed && current !== null && current !== this.#wrote) return;
    const asked = container.closest('video-player')?.getAttribute('details');
    const value = asked ?? (featuresOf(container).size ? DEFAULT_DETAILS : '');
    this.#wrote = value;
    if (current !== value) container.setAttribute('data-fb-details', value);
  }

  #apply(container: HTMLElement) {
    if (sync) return sync(container);
    if (!container.getAttribute('data-fb-details')?.trim()) return;
    loading ??= import('./extras/details').then((extra) => {
      sync = extra.sync;
    });
    void loading.then(() => {
      if (container.isConnected) sync?.(container);
    });
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('fb-details')) customElements.define('fb-details', FbDetailsElement);
attach('fb-details');
