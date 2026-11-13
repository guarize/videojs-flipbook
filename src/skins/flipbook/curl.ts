import { type PropertyValues, PlayerController, playerContext, selectPlayback, selectTime, UIElement } from '@videojs/html';
import { I18nController, i18nContext } from '@videojs/html/i18n';
import { type Book, loadBook, pageFrom, reducedMotion, spriteCell } from './book';
import { frameUrls, sharpFrame, wanted } from './frames';
import { say } from './i18n';
import { measureRoom } from './room';

/** A pull this many times the corner's size, let go, turns the page; less springs back. */
const COMMIT = 1.8;
const MAX_PULL = 4.2;

/**
 * Paused, the page lifts at its top corner: the corner curls back, and underneath is the first frame of the next
 * chapter. Pull the corner (or click it) to turn to that chapter; it's a real button, so Enter and Space do the same.
 * Under reduced motion the corner is simply folded, with no lift.
 */
export class FbCurlElement extends UIElement {
  #time = new PlayerController(this, playerContext, selectTime);
  #playback = new PlayerController(this, playerContext, selectPlayback);
  #i18n = new I18nController(this, i18nContext);
  #abort: AbortController | null = null;
  #container: HTMLElement | null = null;
  #book: Book | null = null;
  #button: HTMLButtonElement | null = null;
  #under: HTMLElement | null = null;
  #label: HTMLElement | null = null;
  #next = -1;
  #size = 0;
  /** The player's box as laid out (a docked player is scaled as it comes in: a rect read then is short). */
  #box = { width: 0, height: 0 };
  #dragged = false;

  connectedCallback() {
    super.connectedCallback();
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    this.#container = this.closest('media-container');
    this.innerHTML = [
      '<button type="button" class="fb-curl-button">',
      '<span class="fb-curl-under"><span class="fb-curl-image"></span></span>',
      '<span class="fb-curl-fold"><span class="fb-curl-flap"><span class="fb-curl-label" aria-hidden="true"><span class="fb-curl-next"></span> <span class="fb-curl-title"></span></span></span></span>',
      '</button>',
    ].join('');
    this.#button = this.querySelector('button');
    this.#under = this.querySelector('.fb-curl-image');
    this.#label = this.querySelector('.fb-curl-title');
    const container = this.#container;
    const button = this.#button;
    if (!container || !button) return;

    queueMicrotask(async () => {
      this.#book = await loadBook(container, signal);
      if (!signal.aborted) {
        this.#measure();
        this.requestUpdate();
      }
    });
    new ResizeObserver(([entry]) => {
      const size = entry?.borderBoxSize?.[0];
      this.#box = size ? { width: size.inlineSize, height: size.blockSize } : { width: container.offsetWidth, height: container.offsetHeight };
      this.#measure();
    }).observe(container);
    // The plate folds the corner away, and the keys (and the title's room) come back while it's out.
    const plate = new MutationObserver(() => this.#room());
    plate.observe(container, { attributes: true, attributeFilter: ['data-fb-plate'] });
    signal.addEventListener('abort', () => plate.disconnect());
    button.addEventListener('click', () => {
      if (this.#dragged) {
        this.#dragged = false;
        return;
      }
      this.#commit();
    }, { signal });
    button.addEventListener('pointerdown', (event) => this.#pull(event), { signal });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort?.abort();
  }

  update(changed: PropertyValues) {
    super.update(changed);
    const book = this.#book;
    const time = this.#time.value;
    const playback = this.#playback.value;
    if (!book || !time || !playback) return;
    const next = book.chapters.findIndex((c) => c.startTime > time.currentTime + 0.25);
    const open = playback.started && playback.paused && !playback.ended && next >= 0;
    if (open !== this.hasAttribute('data-open')) {
      this.toggleAttribute('data-open', open);
      this.#room();
    }
    if (this.#button) {
      this.#button.tabIndex = open ? 0 : -1;
      this.#button.setAttribute('aria-hidden', String(!open));
    }
    if (next !== this.#next) {
      this.#next = next;
      this.#paint();
    }
  }

  /** The corner's size, and the frame underneath laid out at the picture's own scale. */
  #measure() {
    const container = this.#container;
    if (!container) return;
    if (!this.#box.width) this.#box = { width: container.offsetWidth, height: container.offsetHeight };
    const box = this.#box;
    this.style.setProperty('--fb-fw', `${box.width.toFixed(1)}px`);
    this.style.setProperty('--fb-fh', `${box.height.toFixed(1)}px`);
    // (Laid out, too: the corner is scaled while it opens and under a pointer.)
    this.#size = this.#button?.offsetWidth ?? 0;
    this.#paint();
    this.#room();
  }

  /** The title gives up the corner's room while it's lifted (room.ts measures it, for the core). */
  #room() {
    if (this.#container) measureRoom(this.#container);
  }

  #paint() {
    const book = this.#book;
    const under = this.#under;
    const chapter = book?.chapters[this.#next];
    const button = this.#button;
    if (!book || !under || !chapter || !button || !this.#container) return;
    const box = this.#box;
    const size = this.#size || 120;
    const index = pageFrom(book, chapter.startTime);
    const { col, row } = spriteCell(book, Math.max(0, index));
    // The next page's top-right corner, where this page's corner lifts away from it.
    // Big enough for the furthest pull: the corner can grow to MAX_PULL times its size.
    const reach = Math.min(box.width, size * MAX_PULL);
    under.style.width = `${reach.toFixed(1)}px`;
    under.style.height = `${Math.min(box.height, reach).toFixed(1)}px`;
    under.style.backgroundSize = `${(box.width * book.cols).toFixed(1)}px ${(box.height * book.rows).toFixed(1)}px`;
    under.style.backgroundPosition = `${(-(col * box.width) - (box.width - reach)).toFixed(1)}px ${(-row * box.height).toFixed(1)}px`;
    // Then the sharp frame, at the picture's own scale, once it has decoded (the tile holds the place until then).
    const asked = index;
    const container = this.#container;
    void wanted(container).then(() => frameUrls(container, book)).then(async (urls) => {
      const url = urls[asked];
      if (!url || !(await sharpFrame(url)) || pageFrom(book, book.chapters[this.#next]?.startTime ?? -1) !== asked) return;
      under.style.backgroundImage = `url("${url}")`;
      under.style.backgroundSize = `${box.width.toFixed(1)}px ${box.height.toFixed(1)}px`;
      under.style.backgroundPosition = 'right top';
    });
    under.style.backgroundImage = '';
    if (this.#label) this.#label.textContent = chapter.text;
    const next = this.querySelector<HTMLElement>('.fb-curl-next');
    if (next) next.textContent = say(this.#i18n, 'flipbook.next');
    // The name starts with what the corner prints ("Next Desert"), then says what it does.
    button.setAttribute('aria-label', say(this.#i18n, 'flipbook.nextChapter', { next: say(this.#i18n, 'flipbook.next'), title: chapter.text }));
  }

  #commit(reach = 0) {
    const chapter = this.#book?.chapters[this.#next];
    if (!chapter) return;
    this.toggleAttribute('data-open', false);
    // The corner was lifted: the page turns over, forward, to that chapter, from the corner as far as it was pulled.
    this.dispatchEvent(new CustomEvent('fb-turn', { bubbles: true, detail: { time: chapter.startTime, direction: 1, corner: 'top', reach } }));
  }

  /** Pull the corner: it follows the pointer, and turns the page if let go far enough out. */
  #pull(event: PointerEvent) {
    const button = this.#button;
    if (!button || event.button !== 0 || reducedMotion.matches) return;
    const box = button.getBoundingClientRect();
    const corner = { x: box.right, y: box.top };
    const size = box.width;
    let scale = 1;
    let moved = false;
    button.setPointerCapture(event.pointerId);

    const move = (e: PointerEvent) => {
      const pull = Math.hypot(corner.x - e.clientX, e.clientY - corner.y) / (size * Math.SQRT1_2);
      if (!moved && Math.abs(pull - 1) < 0.15) return;
      moved = true;
      this.toggleAttribute('data-pulling', true);
      scale = Math.max(1, Math.min(MAX_PULL, pull));
      this.#setScale(scale);
    };
    const up = () => {
      button.removeEventListener('pointermove', move);
      button.removeEventListener('pointerup', up);
      button.removeEventListener('pointercancel', up);
      this.toggleAttribute('data-pulling', false);
      if (!moved) return this.#setScale(1);
      this.#dragged = true;
      if (scale < COMMIT) return this.#setScale(1);
      // Let go far enough out: the corner fades where it is while the page turn takes over from the same fold.
      const height = this.#container?.getBoundingClientRect().height || 1;
      this.#commit((size * scale) / height);
      window.setTimeout(() => this.#setScale(1), 400);
    };
    button.addEventListener('pointermove', move);
    button.addEventListener('pointerup', up);
    button.addEventListener('pointercancel', up);
  }

  /** The corner grows from its tip; the frame underneath stays at the picture's scale. */
  #setScale(scale: number) {
    const fold = this.querySelector<HTMLElement>('.fb-curl-button');
    if (!fold || !this.#under) return;
    fold.style.setProperty('--fb-pull', scale.toFixed(3));
  }
}

customElements.define('fb-curl', FbCurlElement);
