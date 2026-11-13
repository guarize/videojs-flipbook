import { type PropertyValues, PlayerController, playerContext, selectPlayback, selectTime, UIElement } from '@videojs/html';
import { I18nController, i18nContext } from '@videojs/html/i18n';
import { clock, reducedMotion } from './book';
import { need } from './features';
import { say } from './i18n';
import { RIBBON_LIMIT, type Ribbons, ribbonsOf } from './marks';
import { tell, voiceFor } from './pages';

/** The fold at rest on an unmarked page (a hint of a corner), as a share of the folded ear. */
const HINT = 0.4;
/** Let go past this much of the fold, the corner stays down; short of it, it springs back flat. */
const COMMIT = 0.72;
/** How long "Undo" stays where the ear was. */
const UNDO_MS = 6000;

/**
 * The dog-ear: a bookmark seen on the page. The page's top-left corner is a real button: tap it, press Enter, or pull
 * it down, and it folds over (a crease, the page's back showing) and the moment is bookmarked. A marked page shows
 * its ear whenever the film is on it, playing or paused; tap the ear and it unfolds, the bookmark is gone, and "Undo"
 * stands where it was for a few seconds.
 *
 * One list of bookmarks: this reads and changes the same store as the ribbons on the fore-edge, the B key, Contents
 * and the back cover (marks.ts). The ribbon is the mark seen from the edge, the ear the mark seen on the page, and B
 * toggles both because both are the same entry. The ribbons say what changed ("Bookmark added at 0:13"), so nothing
 * is announced twice. The top-right corner stays the curl's (curl.ts): turn the page there, mark it here.
 */
export class FbEarElement extends UIElement {
  #time = new PlayerController(this, playerContext, selectTime);
  #playback = new PlayerController(this, playerContext, selectPlayback);
  #i18n = new I18nController(this, i18nContext);
  #abort: AbortController | null = null;
  #container: HTMLElement | null = null;
  #store: Ribbons | null = null;
  #button: HTMLButtonElement | null = null;
  #fold: HTMLElement | null = null;
  #undo: HTMLButtonElement | null = null;
  #undoTime: number | null = null;
  #undoTimer = 0;
  #marked: number | null = null;
  #dragged = false;

  connectedCallback() {
    super.connectedCallback();
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    const container = this.closest<HTMLElement>('media-container');
    this.#container = container;
    if (!container) return;
    this.innerHTML = [
      '<button type="button" class="fb-ear-button" aria-pressed="false" aria-keyshortcuts="B">',
      '<span class="fb-ear-fold" aria-hidden="true"><span class="fb-ear-under"></span><span class="fb-ear-shade"></span><span class="fb-ear-flap"></span></span>',
      '</button>',
      '<button type="button" class="fb-ear-undo" hidden><span class="fb-ear-undo-what" aria-hidden="true"></span><span class="fb-ear-undo-do" aria-hidden="true"></span></button>',
    ].join('');
    this.#button = this.querySelector('.fb-ear-button');
    this.#fold = this.querySelector('.fb-ear-fold');
    this.#undo = this.querySelector('.fb-ear-undo');
    const button = this.#button;
    const undo = this.#undo;
    if (!button || !undo) return;

    // The ribbons render the same list on the fore-edge and say what changes: they come with the ear.
    void need('ribbons').catch(() => undefined);
    this.#store = ribbonsOf(container);
    this.#store.addEventListener('change', (event) => this.#changed(event as CustomEvent<{ added?: number; removed?: number }>), { signal });

    button.addEventListener('click', () => {
      if (this.#dragged) {
        this.#dragged = false;
        return;
      }
      this.toggle();
    }, { signal });
    button.addEventListener('pointerdown', (event) => this.#pull(event), { signal });
    undo.addEventListener('click', () => this.#putBack(), { signal });
    // The offer waits while it's being read or reached for.
    for (const type of ['pointerenter', 'focus']) undo.addEventListener(type, () => clearTimeout(this.#undoTimer), { signal });
    for (const type of ['pointerleave', 'blur']) undo.addEventListener(type, () => this.#undoTime != null && this.#arm(), { signal });
    undo.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      this.#dismiss(true);
    }, { signal });
    signal.addEventListener('abort', () => {
      clearTimeout(this.#undoTimer);
      container.removeAttribute('data-fb-ear-undo');
    });
    this.requestUpdate();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort?.abort();
  }

  update(changed: PropertyValues) {
    super.update(changed);
    const store = this.#store;
    const button = this.#button;
    const time = this.#time.value;
    const playback = this.#playback.value;
    if (!store || !button || !time || !playback) return;
    // On the page from the first play to the end: the cover and the back cover have no corner to fold.
    const on = playback.started && !playback.ended;
    if (on !== this.hasAttribute('data-on')) this.toggleAttribute('data-on', on);
    const near = on ? store.near(time.currentTime) : -1;
    const marked = near >= 0 ? store.times[near] : null;
    if (marked !== this.#marked || !button.hasAttribute('aria-label')) {
      this.#marked = marked;
      this.toggleAttribute('data-marked', marked != null);
      button.setAttribute('aria-pressed', String(marked != null));
      button.setAttribute('aria-label', tell(this.#i18n, marked != null ? 'fbPages.unbookmark' : 'fbPages.bookmark'));
    }
    button.tabIndex = on ? 0 : -1;
    if (on) button.removeAttribute('aria-hidden');
    else button.setAttribute('aria-hidden', 'true');
  }

  /** The corner folds, or unfolds: the same change B makes. */
  toggle() {
    const store = this.#store;
    const time = this.#time.value;
    if (!store || !time || !this.hasAttribute('data-on')) return;
    const near = store.near(time.currentTime);
    if (near >= 0) {
      store.remove(store.times[near]);
      return;
    }
    this.#dismiss();
    if (store.add(time.currentTime) === 'full' && this.#container) {
      voiceFor(this.#container)(tell(this.#i18n, 'fbPages.full', { count: RIBBON_LIMIT }));
    }
  }

  /** A bookmark taken off the page the film is on, by any route: undo stands where the ear was. */
  #changed(event: CustomEvent<{ added?: number; removed?: number }>) {
    const { added, removed } = event.detail ?? {};
    const time = this.#time.value;
    if (added != null) this.#dismiss();
    if (removed != null && time && this.hasAttribute('data-on') && Math.abs(removed - time.currentTime) <= 1.5) this.#offer(removed);
    this.requestUpdate();
  }

  #offer(time: number) {
    const undo = this.#undo;
    const container = this.#container;
    if (!undo || !container) return;
    this.#undoTime = time;
    const what = undo.querySelector('.fb-ear-undo-what');
    const act = undo.querySelector('.fb-ear-undo-do');
    if (what) what.textContent = say(this.#i18n, 'flipbook.earRemoved');
    if (act) act.textContent = say(this.#i18n, 'flipbook.earUndo');
    undo.setAttribute('aria-label', say(this.#i18n, 'flipbook.earUndoLabel', { time: clock(time) }));
    undo.hidden = false;
    container.toggleAttribute('data-fb-ear-undo', true);
    this.#arm();
  }

  #arm() {
    clearTimeout(this.#undoTimer);
    this.#undoTimer = window.setTimeout(() => this.#dismiss(true), UNDO_MS);
  }

  /** The offer goes; focus that was on it goes to the corner it stood beside. */
  #dismiss(refocus = false) {
    clearTimeout(this.#undoTimer);
    const undo = this.#undo;
    if (!undo || undo.hidden) return;
    const focused = undo === document.activeElement;
    this.#undoTime = null;
    undo.hidden = true;
    this.#container?.toggleAttribute('data-fb-ear-undo', false);
    if (focused && refocus) this.#button?.focus({ preventScroll: true });
  }

  #putBack() {
    const time = this.#undoTime;
    const focused = this.#undo === document.activeElement;
    this.#dismiss();
    if (time == null) return;
    // The same moment, to the tenth of a second it was kept at; the ribbons say it's back.
    this.#store?.add(time);
    if (focused) this.#button?.focus({ preventScroll: true });
  }

  /** Pull the corner: the fold follows the pointer, and holds or springs back by where it's let go. */
  #pull(event: PointerEvent) {
    const button = this.#button;
    const fold = this.#fold;
    if (!button || !fold || event.button !== 0 || reducedMotion.matches) return;
    const size = fold.offsetWidth || 36;
    const from = this.hasAttribute('data-marked') ? 1 : HINT;
    const start = { x: event.clientX, y: event.clientY };
    let amount = from;
    let moved = false;
    try {
      button.setPointerCapture(event.pointerId);
    } catch {
      // A pointer that's already gone: the click still toggles.
    }
    const move = (e: PointerEvent) => {
      // Along the fold's own direction, down and in from the corner.
      const along = (e.clientX - start.x + (e.clientY - start.y)) / 2;
      if (!moved && Math.abs(along) < 4) return;
      moved = true;
      this.toggleAttribute('data-pulling', true);
      const raw = from + along / (size * 0.6);
      // Past flat or past folded it gives a little, then no more.
      amount = raw > 1 ? 1 + Math.min(0.12, (raw - 1) * 0.25) : Math.max(HINT * 0.6, raw);
      fold.style.transform = `scale(${amount.toFixed(3)})`;
    };
    const up = () => {
      button.removeEventListener('pointermove', move);
      button.removeEventListener('pointerup', up);
      button.removeEventListener('pointercancel', up);
      this.toggleAttribute('data-pulling', false);
      fold.style.transform = '';
      if (!moved) return;
      this.#dragged = true;
      // The click that follows a drag is the drag's own: it doesn't toggle again.
      window.setTimeout(() => {
        this.#dragged = false;
      }, 0);
      const fold_ = amount >= COMMIT;
      if (fold_ !== this.hasAttribute('data-marked')) this.toggle();
    };
    button.addEventListener('pointermove', move);
    button.addEventListener('pointerup', up);
    button.addEventListener('pointercancel', up);
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('fb-ear')) customElements.define('fb-ear', FbEarElement);
