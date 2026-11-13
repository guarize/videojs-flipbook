import { type PropertyValues, PlayerController, playerContext, selectTime, UIElement } from '@videojs/html';
import { I18nController, i18nContext } from '@videojs/html/i18n';
import { tileAt } from '@/shared/storyboard';
import { type Book, chapterAt, clock, loadBook, reducedMotion, spritePosition, videoIn } from './book';
import { frameFor, isPlainKey, tell } from './pages';
import { canCurl, PAGE, Paper, pose, turnCurve } from './paper';
import { isOn } from './features';
import { turnTo } from './goto';
import { chapterName, ribbonsOf } from './marks';

/** Opening the contents turns the picture over like a page: a touch quicker from the keyboard. */
const TURN_POINTER = 520;
const TURN_KEY = 380;

let uid = 0;

/**
 * The picture a chapter is known by: a beat into it, past the cut (and past a fade from black), on a page that still
 * belongs to it.
 */
function faceOf(book: Book, start: number, end: number): number {
  const page = book.tiles.find((t) => t.start >= start + 0.9 && t.start < end);
  return page ? page.start : start;
}

/** The first time the contents opens on a player: its sharp thumbnails wait for it, so a page that never opens it
 * never fetches them. */
const firstOpen = new WeakMap<Element, { opened: Promise<void>; open: () => void }>();
function firstOpenOf(container: Element) {
  let entry = firstOpen.get(container);
  if (!entry) {
    let open = () => {};
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    entry = { opened, open };
    firstOpen.set(container, entry);
  }
  return entry;
}

/** Draws a list's options: the thumbnail is the storyboard tile at once, and the sharp frame over it once it loads. */
function thumb(container: Element, book: Book, time: number): HTMLElement {
  const frame = document.createElement('span');
  frame.className = 'fb-contents-thumb';
  frame.setAttribute('aria-hidden', 'true');
  frame.style.backgroundPosition = spritePosition(book, tileAt(book.tiles, time + 0.05));
  void firstOpenOf(container).opened.then(() => frameFor(container, book, time)).then((url) => {
    if (!url) return;
    const image = new Image();
    image.alt = '';
    image.decoding = 'async';
    image.width = 64;
    image.height = 36;
    image.src = url;
    image.decode().then(() => frame.append(image), () => {});
  });
  return frame;
}

/**
 * The contents page: a book's table of contents, inside the player. Each chapter is set as a contents entry, its
 * number, a sharp thumbnail, its name, a dotted leader and the time it starts on; the chapter playing is marked in red
 * with how far through it you are. The bookmarks follow, as a second list. Opening it turns the picture over like a
 * page (with real paper where WebGL is there; otherwise the page settles in flat). It's a modal dialog: each list is
 * one Tab stop, the arrows move, Enter turns to that page, Delete takes a bookmark out, Escape closes and puts focus
 * back where it was. T opens and closes it.
 */
export class FbContentsElement extends UIElement {
  #time = new PlayerController(this, playerContext, selectTime);
  #i18n = new I18nController(this, i18nContext);
  #abort: AbortController | null = null;
  #container: HTMLElement | null = null;
  #book: Book | null = null;
  #opener: HTMLElement | null = null;
  #inerted: HTMLElement[] = [];
  #page: HTMLElement | null = null;
  #chapters: HTMLElement | null = null;
  #marks: HTMLElement | null = null;
  #marksHead: HTMLElement | null = null;
  #current = -2;
  #paper: Paper | null = null;
  #frame = 0;
  #exit: Animation | null = null;
  #id = `fb-contents-${++uid}`;

  connectedCallback() {
    super.connectedCallback();
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    this.hidden = true;
    this.setAttribute('data-fb-overlay', '');
    const container = this.closest<HTMLElement>('media-container');
    this.#container = container;
    if (!container) return;

    const id = this.#id;
    this.innerHTML = [
      '<div class="fb-contents-scrim"></div>',
      `<div class="fb-contents-page" role="dialog" aria-modal="true" aria-labelledby="${id}-heading">`,
      '<div class="fb-contents-head">',
      `<h2 class="fb-contents-heading" id="${id}-heading"></h2>`,
      '<p class="fb-contents-book"></p>',
      '<button type="button" class="fb-contents-close"><media-icon family="flipbook" name="close"></media-icon></button>',
      '</div>',
      '<div class="fb-contents-body">',
      `<ol class="fb-contents-list" role="listbox" data-list="chapters" id="${id}-chapters"></ol>`,
      `<h3 class="fb-contents-subhead" id="${id}-marks-heading"></h3>`,
      `<ol class="fb-contents-list fb-contents-marks" role="listbox" data-list="marks" aria-labelledby="${id}-marks-heading" aria-describedby="${id}-hint"></ol>`,
      `<div class="fb-contents-foot"><span class="fb-contents-summary"></span><span class="fb-sr-only" id="${id}-hint"></span>`,
      '<button type="button" class="fb-contents-keys" aria-haspopup="dialog" aria-keyshortcuts="?"><media-icon family="flipbook" name="keys"></media-icon><span data-fb-label="shortcuts">Shortcuts</span><kbd class="fb-keycap" aria-hidden="true">?</kbd></button></div>',
      '</div>',
      '</div>',
    ].join('');
    this.#page = this.querySelector('.fb-contents-page');
    this.#chapters = this.querySelector('[data-list="chapters"]');
    this.#marks = this.querySelector('[data-list="marks"]');
    this.#marksHead = this.querySelector('.fb-contents-subhead');

    queueMicrotask(async () => {
      this.#book = await loadBook(container, signal);
      if (signal.aborted) return;
      this.#build();
      ribbonsOf(container).addEventListener('change', () => this.#buildMarks(), { signal });
    });

    // Its own keys and clicks stay its own: none of them reach the player's shortcuts or tap gestures.
    this.addEventListener('keydown', (event) => this.#key(event), { signal });
    for (const type of ['pointerdown', 'pointerup', 'click', 'dblclick']) {
      this.addEventListener(type, (event) => event.stopPropagation(), { signal });
    }
    this.querySelector('.fb-contents-scrim')?.addEventListener('click', () => this.close(), { signal });
    this.querySelector('.fb-contents-close')?.addEventListener('click', () => this.close(), { signal });
    this.addEventListener('click', (event) => {
      const option = (event.target as Element | null)?.closest<HTMLElement>('[role="option"]');
      if (option) this.#choose(option);
      if ((event.target as Element | null)?.closest('.fb-contents-keys')) this.#keymap();
    }, { signal });

    container.addEventListener('click', (event) => {
      const trigger = (event.target as Element | null)?.closest<HTMLElement>('[data-fb-action="contents"]');
      if (trigger && container.contains(trigger)) this.open(trigger, event.detail === 0 ? 'key' : 'pointer');
    }, { signal });
    container.addEventListener('keydown', (event) => {
      if (event.key !== 't' && event.key !== 'T') return;
      if (!isPlainKey(event) || event.repeat || !this.hidden) return;
      event.preventDefault();
      this.open(document.activeElement as HTMLElement | null, 'key');
    }, { signal });
    window.addEventListener('resize', () => this.#paper?.resize(this), { signal });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort?.abort();
    this.#stopTurn();
    this.#release();
  }

  update(changed: PropertyValues) {
    super.update(changed);
    const name = tell(this.#i18n, 'fbPages.openContents');
    for (const label of this.#container?.querySelectorAll<HTMLElement>('[data-fb-label="contents"]') ?? []) {
      if (label.textContent !== name) label.textContent = name;
    }
    const time = this.#time.value;
    if (!time || this.hidden) return;
    this.#mark(time.currentTime);
  }

  open(opener: HTMLElement | null, via: 'key' | 'pointer') {
    const container = this.#container;
    if (!container || !this.#book || !this.hidden) return;
    this.#exit?.cancel();
    this.#opener = opener && container.contains(opener) ? opener : container;
    // Opened from Settings on a phone (menu.ts presses the key, which isn't shown there): focus goes back to the
    // Settings key, the one that was pressed.
    if (this.#opener !== container && this.#opener.getClientRects().length === 0) {
      const settings = container.querySelector<HTMLElement>('.fb-settings');
      this.#opener = settings?.getClientRects().length ? settings : container;
    }
    this.#text();
    firstOpenOf(container).open();
    this.hidden = false;
    this.toggleAttribute('data-open', true);
    container.toggleAttribute('data-fb-contents', true);
    // The rest of the player sleeps while the page is open.
    this.#inerted = Array.from(container.children).filter(
      (el): el is HTMLElement => el !== this && el instanceof HTMLElement && !el.inert && !el.matches('.fb-voice, [role="status"]'),
    );
    for (const el of this.#inerted) el.inert = true;

    const time = this.#time.value?.currentTime ?? 0;
    this.#current = -2;
    this.#mark(time);
    const chapter = Math.max(0, chapterAt(this.#book, time));
    this.#rove(this.#chapters, chapter);
    const options = this.#options(this.#chapters);
    (options[chapter] ?? options[0] ?? this.querySelector<HTMLElement>('.fb-contents-close'))?.focus({ preventScroll: true });
    options[chapter]?.scrollIntoView({ block: 'nearest' });
    this.#arrive(via);
  }

  close(returnFocus = true, quietly = false) {
    if (this.hidden) return;
    const container = this.#container;
    this.#stopTurn();
    this.#release();
    container?.toggleAttribute('data-fb-contents', false);
    this.toggleAttribute('data-open', false);
    const opener = this.#opener;
    this.#opener = null;
    if (returnFocus) opener?.focus({ preventScroll: true });
    // Out in a breath: shorter and smaller than the way in.
    const page = this.#page;
    if (!page || reducedMotion.matches || quietly) {
      this.hidden = true;
      return;
    }
    this.#exit = this.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
    page.animate([{ transform: 'none' }, { transform: 'translateY(6px) scale(0.985)' }], { duration: 150, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
    this.#exit.finished.then(() => {
      if (!this.hasAttribute('data-open')) this.hidden = true;
    }, () => {});
  }

  #release() {
    for (const el of this.#inerted) el.inert = false;
    this.#inerted = [];
  }

  #text() {
    const i18n = this.#i18n;
    const set = (selector: string, text: string) => {
      const node = this.querySelector<HTMLElement>(selector);
      if (node && node.textContent !== text) node.textContent = text;
    };
    // Headings set in capitals by CSS keep their names as written, so a screen reader says the word, not its letters.
    const named = (selector: string, text: string) => {
      set(selector, text);
      this.querySelector(selector)?.setAttribute('aria-label', text);
    };
    named('.fb-contents-heading', tell(i18n, 'fbPages.contents'));
    const title = this.#container?.querySelector('.media-title')?.textContent?.trim() || this.#container?.closest('video-player')?.getAttribute('content-title') || '';
    set('.fb-contents-book', title);
    this.querySelector('.fb-contents-book')?.toggleAttribute('hidden', !title);
    this.querySelector('.fb-contents-close')?.setAttribute('aria-label', tell(i18n, 'fbPages.close'));
    this.#chapters?.setAttribute('aria-label', tell(i18n, 'fbPages.chapters'));
    named('.fb-contents-subhead', tell(i18n, 'fbPages.bookmarks'));
    set(`#${this.#id}-hint`, tell(i18n, 'fbPages.contentsHint'));
    const duration = this.#time.value?.duration ?? 0;
    set('.fb-contents-summary', tell(i18n, 'fbPages.summary', { count: this.#book?.chapters.length ?? 0, length: clock(duration) }));
  }

  #build() {
    const book = this.#book;
    const container = this.#container;
    const list = this.#chapters;
    if (!book || !container || !list) return;
    const options = book.chapters.map((chapter, i) => {
      const option = document.createElement('li');
      option.className = 'fb-contents-option';
      option.setAttribute('role', 'option');
      option.id = `${this.#id}-c${i}`;
      option.dataset.time = String(chapter.startTime);
      option.tabIndex = -1;
      const number = document.createElement('span');
      number.className = 'fb-contents-number';
      number.textContent = String(i + 1);
      option.append(number, ' ', thumb(container, book, faceOf(book, chapter.startTime, chapter.endTime)), this.#entry(chapter.text, clock(chapter.startTime)));
      const progress = document.createElement('span');
      progress.className = 'fb-contents-progress';
      progress.setAttribute('aria-hidden', 'true');
      option.append(progress);
      return option;
    });
    list.replaceChildren(...options);
    this.#rove(list, 0);
    this.#buildMarks();
    this.toggleAttribute('data-ready', options.length > 0);
  }

  /** A contents line: the name, a dotted leader running to the time, as a book runs it to the page number. */
  #entry(name: string, time: string, now = false): HTMLElement {
    const line = document.createElement('span');
    line.className = 'fb-contents-line';
    // The line is the option's name, read as it's set: "3 Forest Now 0:24". The leader is only ink.
    const title = document.createElement('span');
    title.className = 'fb-contents-name';
    title.textContent = name;
    // "Now" is set in capitals: the printed tag is hidden from screen readers, and a plain-case word is read instead.
    const tag = document.createElement('span');
    tag.className = 'fb-contents-now';
    tag.hidden = !now;
    const printed = document.createElement('span');
    printed.setAttribute('aria-hidden', 'true');
    printed.textContent = tell(this.#i18n, 'fbPages.now');
    const spoken = document.createElement('span');
    spoken.className = 'fb-sr-only';
    spoken.textContent = tell(this.#i18n, 'fbPages.now');
    tag.append(printed, spoken);
    const leader = document.createElement('span');
    leader.className = 'fb-contents-leader';
    leader.setAttribute('aria-hidden', 'true');
    const folio = document.createElement('span');
    folio.className = 'fb-contents-folio';
    folio.textContent = time;
    // Spaces between the parts, so the name reads as words; flex layout ignores them.
    line.append(title, ' ', tag, ' ', leader, folio);
    return line;
  }

  #buildMarks() {
    const book = this.#book;
    const container = this.#container;
    const list = this.#marks;
    if (!book || !container || !list) return;
    const times = ribbonsOf(container).times;
    const focused = list.contains(document.activeElement) ? this.#options(list).indexOf(document.activeElement as HTMLElement) : -1;
    const options = times.map((time, i) => {
      const option = document.createElement('li');
      option.className = 'fb-contents-option fb-contents-mark';
      option.setAttribute('role', 'option');
      option.id = `${this.#id}-m${i}`;
      option.dataset.time = String(time);
      option.dataset.mark = '';
      option.tabIndex = -1;
      const chapter = chapterName(book, time);
      const ribbon = document.createElement('span');
      ribbon.className = 'fb-contents-ribbon';
      ribbon.setAttribute('aria-hidden', 'true');
      option.append(ribbon, thumb(container, book, time), this.#entry(chapter || clock(time), clock(time)));
      return option;
    });
    list.replaceChildren(...options);
    const empty = options.length === 0;
    list.hidden = empty;
    if (this.#marksHead) this.#marksHead.hidden = empty;
    this.#rove(list, Math.max(0, Math.min(focused, options.length - 1)));
    if (focused >= 0) {
      const next = options[Math.min(focused, options.length - 1)];
      if (next) next.focus();
      else this.#options(this.#chapters)[Math.max(0, this.#current)]?.focus();
    }
  }

  /** The chapter playing: a red tab, a "Now" tag, and a hairline for how far through it you are. */
  #mark(time: number) {
    const book = this.#book;
    if (!book) return;
    const current = chapterAt(book, time);
    const options = this.#options(this.#chapters);
    if (current !== this.#current) {
      this.#current = current;
      options.forEach((option, i) => {
        const now = i === current;
        option.toggleAttribute('data-current', now);
        option.toggleAttribute('data-read', current >= 0 && i < current);
        const tag = option.querySelector<HTMLElement>('.fb-contents-now');
        if (tag) tag.hidden = !now;
      });
    }
    const chapter = book.chapters[current];
    const option = options[current];
    if (chapter && option) {
      const through = Math.min(1, Math.max(0, (time - chapter.startTime) / Math.max(0.01, chapter.endTime - chapter.startTime)));
      option.style.setProperty('--fb-through', through.toFixed(4));
    }
  }

  #options(list: HTMLElement | null): HTMLElement[] {
    return list ? Array.from(list.querySelectorAll<HTMLElement>('[role="option"]')) : [];
  }

  #rove(list: HTMLElement | null, index: number) {
    this.#options(list).forEach((option, i) => {
      option.tabIndex = i === index ? 0 : -1;
      option.setAttribute('aria-selected', String(i === index));
    });
  }

  /** The shortcuts card, from the contents' foot: this page closes and the card opens in its place. */
  #keymap() {
    const keymap = this.#container?.querySelector<HTMLElement & { open?: (opener: HTMLElement | null) => void }>('fb-keymap');
    if (!keymap?.open) return;
    this.close(true, true);
    keymap.open(document.activeElement as HTMLElement | null);
  }

  #choose(option: HTMLElement) {
    const time = Number(option.dataset.time);
    if (!Number.isFinite(time)) return;
    // The page closes at once, so the turn that follows is the thing you see.
    this.close(true, true);
    const container = this.#container;
    if (container) turnTo(container.querySelector('fb-turn') ?? container, time);
  }

  #key(event: KeyboardEvent) {
    this.#skipTurn();
    const key = event.key;
    if (key === '?' && isPlainKey(event)) {
      event.preventDefault();
      event.stopPropagation();
      this.#keymap();
      return;
    }
    if (key === 'Escape' || ((key === 't' || key === 'T') && isPlainKey(event))) {
      event.preventDefault();
      event.stopPropagation();
      this.close();
      return;
    }
    if (key === 'Tab') {
      this.#trap(event);
      event.stopPropagation();
      return;
    }
    const option = (event.target as Element | null)?.closest<HTMLElement>('[role="option"]');
    const list = option?.parentElement ?? null;
    // Every other key stays inside the page: the player's shortcuts sleep while it's open.
    event.stopPropagation();
    if (!option || !list) return;
    const options = this.#options(list);
    const index = options.indexOf(option);
    const last = options.length - 1;
    let next = -1;
    if (key === 'ArrowDown' || key === 'ArrowRight') next = Math.min(last, index + 1);
    else if (key === 'ArrowUp' || key === 'ArrowLeft') next = Math.max(0, index - 1);
    else if (key === 'Home') next = 0;
    else if (key === 'End') next = last;
    else if (key === 'PageDown') next = Math.min(last, index + 5);
    else if (key === 'PageUp') next = Math.max(0, index - 5);
    else if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      this.#choose(option);
      return;
    } else if ((key === 'Delete' || key === 'Backspace') && option.hasAttribute('data-mark') && this.#container) {
      event.preventDefault();
      ribbonsOf(this.#container).remove(Number(option.dataset.time));
      return;
    }
    if (next < 0) return;
    event.preventDefault();
    this.#rove(list, next);
    options[next].focus();
    options[next].scrollIntoView({ block: 'nearest' });
  }

  /** Tab goes round the page's stops: the close key, the chapters, the bookmarks. */
  #trap(event: KeyboardEvent) {
    const stops = Array.from(this.querySelectorAll<HTMLElement>('.fb-contents-close, [role="option"][tabindex="0"], .fb-contents-keys')).filter(
      (el) => !el.closest('[hidden]'),
    );
    if (!stops.length) return;
    const at = stops.indexOf(document.activeElement as HTMLElement);
    const next = event.shiftKey ? (at <= 0 ? stops.length - 1 : at - 1) : at === stops.length - 1 ? 0 : at + 1;
    event.preventDefault();
    stops[next].focus();
  }

  /**
   * The way in. Where paper can be drawn, the picture you were watching is the page on top, and it turns over (curling
   * round, its paper back showing) to uncover the contents beneath. Otherwise the page settles in from a slight lift.
   * Under reduced motion it simply appears.
   */
  #arrive(via: 'key' | 'pointer') {
    const page = this.#page;
    if (!page || reducedMotion.matches) return;
    const container = this.#container;
    const video = container ? videoIn(container) : null;
    const duration = via === 'key' ? TURN_KEY : TURN_POINTER;
    // Real paper only while the book's turns are on; otherwise the page settles in flat.
    if (canCurl() && isOn(container, 'turns') && video?.videoWidth && video.readyState >= 2) {
      const paper = Paper.create(this);
      const front = paper?.texture(video);
      if (paper && front) {
        this.#paper = paper;
        this.toggleAttribute('data-turning', true);
        let start = -1;
        const tick = (now: number) => {
          // The clock starts on the first frame, after the flat page below has paid for the shaders.
          if (start < 0) start = now;
          const t = Math.min(1, (now - start) / duration);
          paper.draw(null, [pose(front, turnCurve(t), 1, PAGE)]);
          if (t < 1) this.#frame = requestAnimationFrame(tick);
          else this.#stopTurn();
        };
        paper.draw(null, [pose(front, 0, 1, PAGE)]);
        this.#frame = requestAnimationFrame(tick);
        return;
      }
      paper?.dispose();
    }
    page.animate(
      [
        { transform: 'perspective(1600px) rotateY(-14deg) translateX(12px)', opacity: 0 },
        { transform: 'none', opacity: 1 },
      ],
      { duration: Math.min(260, duration), easing: 'cubic-bezier(0.23, 1, 0.32, 1)' },
    );
  }

  /** Any key while the page is still turning lands it at once. */
  #skipTurn() {
    if (this.#paper) this.#stopTurn();
  }

  #stopTurn() {
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    this.#paper?.dispose();
    this.#paper = null;
    this.toggleAttribute('data-turning', false);
  }
}

customElements.define('fb-contents', FbContentsElement);
