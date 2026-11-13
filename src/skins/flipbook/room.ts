import { UIElement } from '@videojs/html';
import { onFontsLoaded } from '@/shared/tasks';
import { attach } from './companion';

/** Under this width (30rem) the player is a phone's: its controls are the book's lower cover, under the picture. */
export const PHONE = 480;

/** Players shorter than this get the one-row slab (a phone on its side): two rows and the top bar would cover half.
 *  From this width only: a narrower short player keeps two rows, or its fore-edge would have no room for the tabs. */
const SHORT = 420;
const SHORT_FROM_WIDTH = 600;
/** The title chip needs this much room to show a word or two; with less it would read "T…". */
const TITLE_MIN = 72;

/**
 * The title's room in the top bar: up to the first key, wherever the keys are. While the book's corner is lifted the
 * keys slide over to make room for it (a translate, so the layout doesn't see it), and the title gives up the same.
 * Called again by the corner (curl.ts) whenever it lifts or folds.
 */
export function measureRoom(container: HTMLElement) {
  const title = container.querySelector<HTMLElement>('.media-title');
  // The first key actually shown: some keys only appear at some widths, and some only with their extra on.
  const key = [...container.querySelectorAll<HTMLElement>('.video-controls-top > .media-button')].find(
    (k) => k.getClientRects().length > 0 && getComputedStyle(k).display !== 'none',
  );
  if (!title) return;
  const curl = container.querySelector<HTMLElement>('fb-curl[data-open]');
  const lifted = !!curl && !container.hasAttribute('data-fb-plate');
  const shift = lifted && curl ? Math.max(0, curl.getBoundingClientRect().width - 4) : 0;
  // With no key up there (a phone: the book's keys are in the sheet), the title has the bar to itself, up to the corner.
  const end = key ? key.offsetLeft : container.clientWidth - title.offsetLeft;
  const room = end - shift - title.offsetLeft - 8;
  container.style.setProperty('--fb-title-room', `${Math.max(0, Math.round(room))}px`);
  // Too little room to say anything ("T…"): the title steps aside; the cover and the contents carry it.
  container.toggleAttribute('data-fb-title-cramped', room < TITLE_MIN);
}

/**
 * Whether the page keeps the room the pad takes under the player (phone.css hangs it there on a margin). It doesn't
 * when an ancestor clips at the picture's foot, or when what follows the player in the page starts inside the pad.
 * Measured with the pad's margin applied.
 */
function hasRoomUnder(container: HTMLElement): boolean {
  const box = container.getBoundingClientRect();
  const pad = Number.parseFloat(getComputedStyle(container).marginBottom) || 0;
  if (pad < 1) return false;
  const foot = box.bottom + pad;
  for (let parent = container.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.display === 'contents') continue;
    if (/hidden|clip|auto|scroll/.test(style.overflowY) && parent.getBoundingClientRect().bottom < foot - 1) return false;
  }
  // What comes next in the page, in the flow: the first few boxes after the player.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  walker.currentNode = container;
  let seen = 0;
  for (let node = walker.nextSibling() ?? next(walker); node && seen < 24; node = walker.nextNode()) {
    const el = node as HTMLElement;
    if (el.contains(container)) continue;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.display === 'contents' || style.position === 'absolute' || style.position === 'fixed' || style.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    seen++;
    const beside = r.right <= box.left + 1 || r.left >= box.right - 1;
    // (Into the pad's upper half: a page may tuck something a little way under the player's foot on purpose.)
    if (!beside && r.top < foot - pad / 2 && r.bottom > box.bottom + 1 && r.top >= box.top) return false;
  }
  return true;
}

/** The next element after the walker's current one that is not inside it. */
function next(walker: TreeWalker): Node | null {
  for (let node: Node | null = walker.currentNode; node; node = walker.parentNode()) {
    const sibling = walker.nextSibling();
    if (sibling) return sibling;
  }
  return null;
}

/**
 * The player's own shape, for what CSS can't query: a container query reads the player's width, not its height, so
 * a short player (a phone on its side) is marked `data-fb-short` here, for the one-row slab (skin.css, "Short"). And
 * the title's room in the top bar. Measured on resize, when the type has loaded, and when extras come and go.
 *
 * It also says when the player is a phone's (phone.css has the layout): `data-fb-phone` under 480 px wide;
 * `data-fb-screen` while it fills the screen (fullscreen, or the fill a phone without element fullscreen gets,
 * screen.ts); `data-fb-pad` on a phone's player in the page, where the controls are the book's lower cover, under the
 * picture and never on it (only where the page keeps the pad's room, `hasRoomUnder`); and `data-fb-hand` wherever the
 * controls are laid out for a thumb (the pad, and a phone's player filling the screen upright). And `data-fb-posterless`
 * where the poster has no picture to show (none given, or one that failed). The docked mini
 * player, and a narrow player in a box the page fixed, are none of these: they keep the small slab.
 */
export class FbRoomElement extends UIElement {
  #abort: AbortController | null = null;
  #measure: (() => void) | null = null;

  /**
   * Measures now. For a page that connects the player undisplayed and shows it later (apps/preview/src/site/player.ts):
   * connected with no box there was nothing to measure, and the resize observer answers a frame after the player is
   * shown, so a phone's player painted one frame as a wide one. Called as it is shown, the first frame is right.
   */
  measure() {
    this.#measure?.();
  }

  connectedCallback() {
    super.connectedCallback();
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    this.hidden = true;
    const container = this.closest<HTMLElement>('media-container');
    if (!container) return;
    const mark = (name: string, on: boolean) => {
      if (container.hasAttribute(name) !== on) container.toggleAttribute(name, on);
    };
    let roomy = true;
    let roomFor = -1;
    const measure = () => {
      const box = container.getBoundingClientRect();
      if (box.height > 0) {
        const short = box.height < SHORT && box.width >= SHORT_FROM_WIDTH;
        if (container.hasAttribute('data-fb-short') !== short) container.toggleAttribute('data-fb-short', short);
      }
      if (box.width > 0) {
        const phone = box.width < PHONE;
        const screen = container.hasAttribute('data-fb-fill') || container.matches(':fullscreen');
        const docked = container.hasAttribute('data-fb-dock');
        mark('data-fb-phone', phone);
        mark('data-fb-screen', screen);
        let pad = phone && !screen && !docked;
        if (pad) {
          // The pad hangs under the player's box on a margin. A page that holds the player in a box of fixed height
          // gives that margin no room: there the controls stay the small slab over the film, rather than lie on
          // whatever the page puts next. Asked again only when the player's width changes.
          if (roomFor !== Math.round(box.width)) {
            mark('data-fb-pad', true);
            mark('data-fb-hand', true);
            roomy = hasRoomUnder(container);
            roomFor = Math.round(box.width);
          }
          pad = roomy;
        } else roomFor = -1;
        mark('data-fb-pad', pad);
        mark('data-fb-hand', phone && !docked && (pad || screen));
      }
      measureRoom(container);
    };
    this.#measure = measure;
    // Before the first frame, so a phone's player never shows the row it doesn't have.
    measure();
    // Filling the screen and docking change the layout without always changing the player's width.
    const state = new MutationObserver(measure);
    state.observe(container, { attributes: true, attributeFilter: ['data-fb-fill', 'data-fb-dock'] });
    signal.addEventListener('abort', () => state.disconnect());
    for (const type of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(type, measure, { signal });
    const resize = new ResizeObserver(measure);
    resize.observe(container);
    const slab = container.querySelector('.fb-bar');
    if (slab) resize.observe(slab);
    signal.addEventListener('abort', () => resize.disconnect());
    // A receiver's key comes and goes with the network (AirPlay, Cast). It stands first of the top bar's keys, where
    // the title's room ends.
    const receivers = new MutationObserver(measure);
    for (const key of container.querySelectorAll('.media-airplay-button, .media-cast-button')) {
      receivers.observe(key, { attributes: true, attributeFilter: ['hidden', 'data-availability'] });
    }
    signal.addEventListener('abort', () => receivers.disconnect());
    // Extras come and go (their keys in the top bar, their sheets): measured again once each has settled.
    for (const type of ['fb-features', 'fb-feature-load']) container.addEventListener(type, () => requestAnimationFrame(measure), { signal });
    onFontsLoaded(measure, signal);
    // While the poster stands, the film under it is not painted (skin.css). Unless the poster has no picture to
    // show, none given or one that failed: there the film's own first frame is the picture, and the player says so.
    // (A poster still loading is a poster: the film waits under it.)
    const poster = container.querySelector<HTMLImageElement>('.media-poster-image');
    if (poster) {
      const pictureless = () => mark('data-fb-posterless', !poster.getAttribute('src') || (poster.complete && poster.naturalWidth === 0));
      for (const type of ['load', 'error']) poster.addEventListener(type, pictureless, { signal });
      const given = new MutationObserver(pictureless);
      given.observe(poster, { attributes: true, attributeFilter: ['src'] });
      signal.addEventListener('abort', () => given.disconnect());
      // (Video.js gives the image its address as the player connects: looked at once that has happened.)
      queueMicrotask(pictureless);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort?.abort();
    this.#measure = null;
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('fb-room')) customElements.define('fb-room', FbRoomElement);
attach('fb-room');
