import { type PropertyValues, PlayerController, playerContext, selectPlayback, selectTime, UIElement } from '@videojs/html';
import { I18nController, i18nContext } from '@videojs/html/i18n';
import { onFontsLoaded } from '@/shared/tasks';
import { type Book, clock, loadBook } from './book';
import { say } from './i18n';

/** Which opening the book uses: the cover turning over (`riffle`, the default), or the scanimation cover (`?opening=scan`). */
export type Opening = 'riffle' | 'scan';

/** Under this width the player is a phone's (skin.css, "Phone: two rows"; 30rem). */
const PHONE = 480;

export function openingOf(container: Element): Opening {
  return container.getAttribute('data-fb-opening') === 'scan' ? 'scan' : 'riffle';
}

/**
 * The dust jacket: the player before anything has played, designed as a book's cover, because that still is all a
 * first glance sees. A printed frame around the picture, a title plate with the film's name, its chapters and its
 * length, and the fore-edge fanned so the film painted on it shows. It lifts away on first play.
 *
 * It also records which opening this player uses, from the page's `?opening=` (or an authored `data-fb-opening`).
 */
export class FbJacketElement extends UIElement {
  #time = new PlayerController(this, playerContext, selectTime);
  #playback = new PlayerController(this, playerContext, selectPlayback);
  #i18n = new I18nController(this, i18nContext);
  #abort: AbortController | null = null;
  #container: HTMLElement | null = null;
  #book: Book | null = null;
  #title: HTMLElement | null = null;
  #meta: HTMLElement | null = null;
  #hint: HTMLElement | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    this.setAttribute('aria-hidden', 'true');
    this.#container = this.closest('media-container');
    const container = this.#container;
    if (!container) return;
    if (!container.hasAttribute('data-fb-opening')) {
      const asked = new URLSearchParams(location.search).get('opening');
      container.setAttribute('data-fb-opening', asked === 'scan' ? 'scan' : 'riffle');
    }
    this.innerHTML = [
      '<div class="fb-jacket-frame"></div>',
      '<div class="fb-jacket-plate">',
      '<span class="fb-jacket-rule"></span>',
      '<span class="fb-jacket-title"></span>',
      '<span class="fb-jacket-meta"></span>',
      '<span class="fb-jacket-rule"></span>',
      '</div>',
      '<span class="fb-jacket-hint"></span>',
    ].join('');
    this.#title = this.querySelector('.fb-jacket-title');
    this.#meta = this.querySelector('.fb-jacket-meta');
    this.#hint = this.querySelector('.fb-jacket-hint');
    queueMicrotask(async () => {
      this.#book = await loadBook(container, signal);
      if (!signal.aborted) this.requestUpdate();
    });
    // The cover lays itself out in whatever room the player leaves it (see #arrange): on every size change, once the
    // type has loaded, and whenever its text changes.
    const resize = new ResizeObserver(() => this.#arrange());
    resize.observe(container);
    signal.addEventListener('abort', () => resize.disconnect());
    onFontsLoaded(() => this.#arrange(), signal);
  }

  /**
   * Places the title plate and the play disc in the free room of the cover, between the top keys and the chapter
   * tabs, so neither touches the keys, the tabs or each other: stacked in the middle when there's height for both,
   * otherwise side by side, the plate low on the left as a cover's label and the disc in the middle of what's left.
   * A phone's cover (a player under 480 px) is always side by side, and set as one line: the plate and the disc
   * centred together, on one axis, in the room above the slab.
   */
  #arrange() {
    const container = this.#container;
    const plate = this.querySelector<HTMLElement>('.fb-jacket-plate');
    const disc = container?.querySelector<HTMLElement>('.fb-cover-play');
    if (!container || !plate || !disc) return;
    // The disc is a second "Play" beside the slab's: the pointer's, not another Tab stop.
    if (disc.getAttribute('tabindex') !== '-1') disc.setAttribute('tabindex', '-1');
    if (!container.hasAttribute('data-fb-jacket')) {
      this.toggleAttribute('data-no-disc', false);
      disc.style.removeProperty('translate');
      return;
    }
    const box = this.getBoundingClientRect();
    const shown = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const keys = [...container.querySelectorAll('.video-controls-top > .media-button')].filter(shown);
    // The tabs' hit boxes, not just their faces: the disc never sits where a tap would take a tab.
    // (On a phone the controls are the pad under the picture: nothing of theirs stands on the cover.)
    const pad = container.hasAttribute('data-fb-pad');
    const tabs = pad ? [] : [...container.querySelectorAll('.fb-tab')].filter(shown);
    const bar = pad ? undefined : container.querySelector('.fb-bar')?.getBoundingClientRect();
    // Inside the printed frame, too: the plate sits within the cover's border, never across it.
    const frame = this.querySelector('.fb-jacket-frame')?.getBoundingClientRect();
    // A small cover (a phone's, a docked or windowed one) keeps less air, so the plate still fits between.
    const air = box.height < 240 ? 6 : 0;
    const ceiling = Math.max(box.top + 8, ...keys.map((k) => k.getBoundingClientRect().bottom)) + 10 - air;
    const floor = Math.min(bar?.top ?? box.bottom, frame ? frame.bottom : box.bottom, ...tabs.map((t) => t.getBoundingClientRect().top)) - 12 + air;
    const left = (frame?.left ?? box.left) + 10;
    const size = disc.offsetWidth || 68;
    const gap = 16;

    // Stacked first; if that doesn't fit, side by side.
    this.toggleAttribute('data-side', false);
    this.toggleAttribute('data-tight', false);
    this.toggleAttribute('data-tiny', false);
    let ph = plate.offsetHeight;
    let pw = plate.offsetWidth;
    let plateTop: number;
    let plateLeft: number;
    let discX: number;
    let discY: number;
    const phone = box.width < PHONE;
    this.toggleAttribute('data-phone', phone);
    if (!phone && ph + gap + size <= floor - ceiling) {
      plateTop = ceiling + (floor - ceiling - (ph + gap + size)) / 2;
      plateLeft = box.left + (box.width - pw) / 2;
      discX = box.left + box.width / 2;
      discY = plateTop + ph + gap + size / 2;
    } else {
      this.toggleAttribute('data-side', true);
      ph = plate.offsetHeight;
      // Still too tall for the room: the plate keeps the title and drops the line under it (the bar shows the length).
      this.toggleAttribute('data-tight', ph > floor - ceiling);
      ph = plate.offsetHeight;
      // And on the smallest covers, the title alone on one line, set small.
      this.toggleAttribute('data-tiny', ph > floor - ceiling);
      ph = plate.offsetHeight;
      pw = plate.offsetWidth;
      if (phone) {
        const middle = ceiling + (floor - ceiling) / 2;
        plateTop = Math.max(ceiling, middle - ph / 2);
        // Centred in the printed frame (which keeps clear of an edge down the side).
        const room = frame ?? box;
        plateLeft = Math.max(left, room.left + (room.width - (pw + gap + size)) / 2);
        discX = plateLeft + pw + gap + size / 2;
        discY = middle;
      } else {
        plateTop = Math.max(ceiling, floor - ph);
        plateLeft = left;
        discX = plateLeft + pw + (box.right - (plateLeft + pw)) / 2;
        discY = ceiling + (floor - ceiling) / 2;
      }
    }
    // No room for the disc between the keys and the slab: it steps aside (the slab's play key is right there).
    this.toggleAttribute('data-no-disc', size > floor - ceiling + 2 * air);
    // Placed by `translate`, from boxes that never move in the layout (the plate's at the cover's corner, the disc's
    // at the picture's middle): arriving, and settling again when the type loads, shifts no layout (0.09 of layout
    // shift at 768 px when these were top and left). The plate shows once it has its place.
    plate.style.translate = `${Math.round(plateLeft - box.left)}px ${Math.round(plateTop - box.top)}px`;
    const parent = (disc.offsetParent as HTMLElement | null)?.getBoundingClientRect() ?? box;
    disc.style.translate = `${Math.round(discX - (parent.left + parent.width / 2))}px ${Math.round(discY - (parent.top + parent.height / 2))}px`;
    this.toggleAttribute('data-arranged', true);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort?.abort();
    this.#container?.toggleAttribute('data-fb-jacket', false);
  }

  update(changed: PropertyValues) {
    super.update(changed);
    const container = this.#container;
    const playback = this.#playback.value;
    const time = this.#time.value;
    if (!container || !playback) return;
    // On until the film first plays (or anything moves it off the start).
    const on = !playback.started && !playback.ended && (time?.currentTime ?? 0) < 0.05;
    if (on !== container.hasAttribute('data-fb-jacket')) {
      container.toggleAttribute('data-fb-jacket', on);
      requestAnimationFrame(() => this.#arrange());
    }
    this.toggleAttribute('data-on', on);

    const player = container.closest('video-player');
    const name = player?.getAttribute('content-title') ?? container.querySelector('.media-title')?.textContent?.trim() ?? '';
    let changedText = false;
    if (this.#title && this.#title.textContent !== name) {
      this.#title.textContent = name;
      changedText = true;
    }
    // A film given with no title (and no chapters to count) has nothing to print on the plate: no plate, then, and
    // the play disc alone on the picture.
    const plain = !name && !this.#book?.chapters.length;
    if (this.hasAttribute('data-plain') !== plain) this.toggleAttribute('data-plain', plain);
    const book = this.#book;
    // Until the film's length is known, the chapters' end stands in for it, so the line is there from the start and
    // the plate doesn't grow when the length arrives.
    const length = time?.duration || (book?.chapters.at(-1)?.endTime ?? 0);
    if (book && length && this.#meta) {
      const meta = say(this.#i18n, 'flipbook.jacketMeta', { count: book.chapters.length, length: clock(length) });
      if (this.#meta.textContent !== meta) {
        this.#meta.textContent = meta;
        changedText = true;
      }
    }
    if (changedText) this.#arrange();
    if (this.#hint) {
      const hint = container.getAttribute('data-fb-opening') === 'scan' ? say(this.#i18n, 'flipbook.scanHint') : '';
      if (this.#hint.textContent !== hint) this.#hint.textContent = hint;
    }
  }
}

customElements.define('fb-jacket', FbJacketElement);
