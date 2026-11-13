import { type PropertyValues, PlayerController, playerContext, selectPiP, selectTime, selectVolume, UIElement } from '@videojs/html';
import { I18nController, i18nContext } from '@videojs/html/i18n';
import { type Book, chapterAt, clock, loadBook, pageFrom, reducedMotion, spritePosition, videoIn } from './book';
import { attach } from './companion';
import { turnTo } from './goto';
import { type FlipbookKey, say } from './i18n';
import { featuresOf } from './features';
import { liftAtRest } from './fit';
import { wanted } from './frames';
import { type PagesKey, storageKey, tell, voiceFor } from './pages';
import { atHeight, takesLimits } from './renditions';
import { pageSound, setPageSound, soundOffered } from './sound';
import { fitsHere, outgrown } from './sources';

/** Below this player width the slab has no room for the mute and PiP keys (skin.css, "Narrow"). */
const NARROW = 480;
/** A short player under this width gives its mute key up too (skin.css, "Short and under 720 px"). */
const SHORT_NARROW = 720;
/** The volume page's steps, loudest first. */
const LEVELS = [1, 0.75, 0.5, 0.25];

/**
 * The book's own keys, which leave the picture on a player under 480 px: each is an item here that presses the key
 * itself (still in the top bar, not shown), so it does exactly what the key does, and is only offered while the key
 * is there (Contents and Bookmark are extras of the book).
 */
const BOOK: [name: string, key: string, label: PagesKey][] = [
  ['contents', '#flipbook-contents-top', 'fbPages.contents'],
  ['bookmark', '#flipbook-bookmark-top', 'fbPages.bookmark'],
  ['caption-style', '#flipbook-caption-style-top', 'fbPages.captionStyle'],
  ['keymap', '#flipbook-keymap-top', 'fbPages.shortcuts'],
];

/** AirPlay and Cast, whose keys are in the top bar, which a phone's pad doesn't have: each an item that presses its key. */
const SEND: [name: string, key: string][] = [
  ['airplay', 'media-airplay-button'],
  ['cast', 'media-cast-button'],
];
/** The sheet is put away by a drag down this far, or a flick down this fast (px per ms). */
const SHEET_AWAY = 72;
const SHEET_FLICK = 0.45;

type Toggle = HTMLElement & { checked?: boolean };
type Radios = HTMLElement & { value?: string };

/**
 * Settings carries what the slab can't.
 *
 * - Chapters: a page of the film's chapters, the one playing checked, each a way there (a page turn with the book's
 *   turns, a cut without). The fore-edge's tabs leave a phone-sized player, and the Contents page is one of the book's
 *   extras: here the chapters are always one menu away.
 * - On a player under 480 px the mute key, its volume fader and the picture-in-picture key leave the slab (and a short
 *   one under 720 px gives up mute), so Settings gains Mute and Picture in picture, as checkbox items, and a Volume
 *   page of four steps (WCAG 1.4.10: every control keeps a pointer route at any size). They follow the player's state, and do what the keys do: the PiP item presses the
 *   PiP key itself, so it opens the book's window where the book's PiP is on.
 * - There too the book's keys leave the picture (Contents, Bookmark, Caption style, Shortcuts), so a phone's film is
 *   never under a column of keys: each is an item here. Shortcuts is left out where there is no keyboard to use them
 *   (a touch screen with no hover); `?` still opens the card for anyone who has one. A phone's paused picture keeps
 *   only the print (its margin, its folio, the strip of frames): the Plate key is an item here too, beside Keep this
 *   page and Bookmark.
 */
export class FbMenuElement extends UIElement {
  #volume = new PlayerController(this, playerContext, selectVolume);
  #pip = new PlayerController(this, playerContext, selectPiP);
  #time = new PlayerController(this, playerContext, selectTime);
  #i18n = new I18nController(this, i18nContext);
  #abort: AbortController | null = null;
  #container: HTMLElement | null = null;
  #book: Book | null = null;
  #chapter = -2;
  #touch: MediaQueryList | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    this.hidden = true;
    const container = this.closest<HTMLElement>('media-container');
    this.#container = container;
    if (!container) return;
    const resize = new ResizeObserver(() => this.requestUpdate());
    resize.observe(container);
    signal.addEventListener('abort', () => resize.disconnect());
    // A short player is marked by room.ts, after it measures.
    const short = new MutationObserver(() => this.requestUpdate());
    short.observe(container, { attributes: true, attributeFilter: ['data-fb-short', 'data-fb-pip', 'data-fb-phone'] });
    signal.addEventListener('abort', () => short.disconnect());

    this.#item('mute')?.addEventListener('checked-change', () => {
      const volume = this.#volume.value;
      const want = Boolean(this.#item('mute')?.checked);
      if (volume && volume.muted !== want) volume.setMuted(want);
    }, { signal });
    queueMicrotask(async () => {
      this.#book = await loadBook(container, signal);
      if (!signal.aborted) this.#chapters();
    });
    this.#group()?.addEventListener('value-change', () => {
      // Chosen here (the group's own value set below says nothing new): go to that chapter.
      const index = Number(this.#group()?.value);
      const chapter = this.#book?.chapters[index];
      if (!chapter || index === this.#chapter) return;
      this.#chapter = index;
      turnTo(container.querySelector('fb-turn') ?? container, chapter.startTime);
    }, { signal });

    this.#volumeGroup()?.addEventListener('value-change', () => {
      const level = Number(this.#volumeGroup()?.value);
      const volume = this.#volume.value;
      if (!volume || !Number.isFinite(level)) return;
      if (Math.abs(volume.volume - level) > 0.01) volume.setVolume(level);
      if (volume.muted) volume.setMuted(false);
    }, { signal });
    this.#levels();

    // The page sound (sound.ts): the viewer's choice, kept, and said.
    this.#item('sound')?.addEventListener('checked-change', () => {
      const want = Boolean(this.#item('sound')?.checked);
      if (want === pageSound(container)) return;
      setPageSound(want);
      voiceFor(container)(say(this.#i18n, want ? 'flipbook.soundOn' : 'flipbook.soundOff'));
    }, { signal });
    window.addEventListener('fb-page-sound', () => this.requestUpdate(), { signal });

    this.#item('pip')?.addEventListener('checked-change', () => {
      const want = Boolean(this.#item('pip')?.checked);
      if (want !== this.#inPip()) container.querySelector<HTMLElement>('media-pip-button')?.click();
    }, { signal });

    for (const [name, key] of BOOK) {
      // `select` comes before the menu closes and hands focus back to its key: the press waits for that, so a page
      // the key opens takes focus last, and gives it back to the Settings key when it closes (sheet.ts, contents.ts).
      this.#bookItem(name)?.addEventListener('select', () => {
        requestAnimationFrame(() => container.querySelector<HTMLElement>(key)?.click());
      }, { signal });
    }
    // The system's own player takes the screen from inside the press itself: an iPhone asks for the visitor's act.
    this.#bookItem('system')?.addEventListener('select', () => {
      const film = videoIn(container) as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
      try {
        film?.webkitEnterFullscreen?.();
      } catch {
        // Refused (no metadata yet, or not allowed here): the row did nothing, and the fill is still on its key.
      }
    }, { signal });
    // The bookmark row says what a press does now (the key carries data-bookmarked, ribbons.ts), and the rows follow
    // the book's extras as they come and go.
    const marks = new MutationObserver(() => this.requestUpdate());
    marks.observe(container, { subtree: true, attributes: true, attributeFilter: ['data-bookmarked'] });
    signal.addEventListener('abort', () => marks.disconnect());
    for (const type of ['fb-features', 'fb-feature-load']) container.addEventListener(type, () => this.requestUpdate(), { signal });
    for (const [name, key] of SEND) {
      this.#bookItem(name)?.addEventListener('select', () => {
        requestAnimationFrame(() => container.querySelector<HTMLElement>(key)?.click());
      }, { signal });
    }
    // The keys say when there is a receiver to offer (Video.js hides them otherwise).
    const receivers = new MutationObserver(() => this.requestUpdate());
    for (const [, key] of SEND) {
      const button = container.querySelector(key);
      if (button) receivers.observe(button, { attributes: true, attributeFilter: ['data-hidden', 'hidden', 'data-availability'] });
    }
    signal.addEventListener('abort', () => receivers.disconnect());
    this.#sheet(container, signal);
    this.#quality(container, signal);
    const touch = matchMedia('(hover: none) and (pointer: coarse)');
    touch.addEventListener('change', () => this.requestUpdate(), { signal });
    this.#touch = touch;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort?.abort();
  }

  update(changed: PropertyValues) {
    super.update(changed);
    const container = this.#container;
    if (!container) return;
    const width = container.getBoundingClientRect().width;
    const narrow = width > 0 && width < NARROW;
    const short = container.hasAttribute('data-fb-short') && width < SHORT_NARROW;
    const volume = this.#volume.value;
    const pip = this.#pip.value;
    this.#show('mute', 'flipbook.menuMute', (narrow || short) && volume?.mutedAvailability !== 'unsupported', Boolean(volume?.muted));
    this.#show('pip', 'flipbook.menuPip', narrow && pip?.pictureInPictureAvailability === 'available', this.#inPip());
    // At every width, wherever the book's deck (whose hands make the sound) is on and the page hasn't taken it away.
    this.#show('sound', 'flipbook.menuSound', featuresOf(container).has('deck') && soundOffered(container), pageSound(container));
    this.#volumePage(narrow && volume?.volumeAvailability !== 'unsupported');
    this.#bookItems(narrow);
    // A phone's paused picture carries no keys, upright or on its side (plate.css): the Plate key is an item here
    // (plate.ts hears it).
    const plate = this.#bookItem('plate');
    if (plate) {
      const shown = container.hasAttribute('data-fb-phone') || (container.hasAttribute('data-fb-short') && !!this.#touch?.matches);
      if (plate.hidden === shown) plate.hidden = !shown;
      const label = plate.querySelector<HTMLElement>('[data-part="label"]');
      const text = say(this.#i18n, 'flipbook.plate');
      if (label && label.textContent !== text) label.textContent = text;
    }
    // An iPhone lets no element have the screen, only a video in its own player (screen.ts fills the window instead,
    // under the browser's bars). The real thing is offered here, said for what it is: the film without the book.
    const system = this.#bookItem('system');
    if (system) {
      const film = videoIn(container) as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
      const page = document as Document & { webkitFullscreenEnabled?: boolean };
      const shown = !(page.fullscreenEnabled || page.webkitFullscreenEnabled) && typeof film?.webkitEnterFullscreen === 'function';
      if (system.hidden === shown) system.hidden = !shown;
      const label = system.querySelector<HTMLElement>('[data-part="label"]');
      const text = say(this.#i18n, 'flipbook.menuSystem');
      if (label && label.textContent !== text) label.textContent = text;
    }
    // A receiver that comes or goes while Settings is open waits until it is closed: a row added under a finger moves
    // every row above it (the phone's sheet stands on the screen's foot and grows upwards: 50 px, measured).
    const open = !!container.querySelector('#flipbook-settings[data-open]');
    for (const [name, key] of SEND) {
      const item = this.#bookItem(name);
      const button = container.querySelector<HTMLElement>(key);
      const offered = !!button && !button.hasAttribute('data-hidden') && !button.hidden && button.getAttribute('data-availability') === 'available';
      const shown = container.hasAttribute('data-fb-pad') && offered;
      if (item && item.hidden === shown && !open) item.hidden = !shown;
      const label = item?.querySelector<HTMLElement>('[data-part="label"]');
      const text = button?.getAttribute('aria-label') ?? '';
      if (label && text && label.textContent !== text) label.textContent = text;
    }
    this.#current();
  }

  /**
   * The phone's sheet under a finger (skin.css, "The phone's sheet"): it follows a drag down from its handle, or from
   * anywhere on it while its rows all fit (nothing to scroll), and lets go. Past 72 px, or flicked down, it is put
   * away; short of that it comes back. Under reduced motion nothing follows: the same drag simply closes it.
   */
  #sheet(container: HTMLElement, signal: AbortSignal) {
    const menu = container.querySelector<HTMLElement & { close?: (reason?: string) => void; open?: boolean }>('media-menu.media-menu-popup');
    if (!menu) return;
    const isSheet = () => getComputedStyle(menu).position === 'fixed' && menu.getBoundingClientRect().width >= innerWidth - 1;
    let drag: { id: number; y: number; at: number; lastY: number; lastAt: number; speed: number; on: boolean } | null = null;
    const still = () => {
      const page = menu.querySelector<HTMLElement>('.media-menu-content:not([inert]):not([hidden])');
      return !page || page.scrollHeight <= page.clientHeight + 1;
    };
    const settle = (away: boolean) => {
      if (away) {
        menu.style.transition = reducedMotion.matches ? 'none' : 'transform 150ms cubic-bezier(0.23, 1, 0.32, 1)';
        menu.style.transform = 'translateY(100%)';
        if (typeof menu.close === 'function') menu.close('imperative-action');
        else menu.open = false;
        // The sheet's own leaving is this slide; its styles are its own again once it has gone.
        window.setTimeout(() => {
          menu.style.removeProperty('transition');
          menu.style.removeProperty('transform');
        }, 220);
        return;
      }
      menu.style.transition = 'transform 200ms cubic-bezier(0.23, 1, 0.32, 1)';
      menu.style.removeProperty('transform');
      window.setTimeout(() => menu.style.removeProperty('transition'), 220);
    };
    menu.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' || !event.isPrimary || !isSheet()) return;
      const top = menu.getBoundingClientRect().top;
      // From the handle's strip always; from the rows only while there is nothing for a drag to scroll.
      if (event.clientY - top > 28 && !still()) return;
      drag = { id: event.pointerId, y: event.clientY, at: event.timeStamp, lastY: event.clientY, lastAt: event.timeStamp, speed: 0, on: false };
    }, { signal });
    menu.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const dy = event.clientY - drag.y;
      if (!drag.on) {
        if (dy < 8) return;
        drag.on = true;
        try {
          menu.setPointerCapture(drag.id);
        } catch {
          // The pointer has gone: its lift ends the drag.
        }
      }
      const dt = Math.max(1, event.timeStamp - drag.lastAt);
      drag.speed = drag.speed * 0.4 + ((event.clientY - drag.lastY) / dt) * 0.6;
      drag.lastY = event.clientY;
      drag.lastAt = event.timeStamp;
      if (reducedMotion.matches) return;
      menu.style.transition = 'none';
      menu.style.transform = `translateY(${Math.max(0, dy).toFixed(1)}px)`;
    }, { signal });
    const end = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      const { on, y, speed, lastAt } = drag;
      drag = null;
      if (!on) return;
      const dy = event.clientY - y;
      const flicked = event.timeStamp - lastAt < 80 && speed > SHEET_FLICK;
      settle(event.type === 'pointerup' && (dy > SHEET_AWAY || flicked));
      // The lift of a drag is not a press on the row under it.
      const swallow = (click: Event) => {
        click.stopPropagation();
        click.preventDefault();
      };
      menu.addEventListener('click', swallow, { capture: true, once: true });
      window.setTimeout(() => menu.removeEventListener('click', swallow, { capture: true }), 60);
    };
    menu.addEventListener('pointerup', end, { signal });
    menu.addEventListener('pointercancel', end, { signal });
    // Where a drag may start anywhere, the browser is told the rows won't scroll (CSS reads the mark).
    // (Again once it has risen: its height eases to its rows'.)
    const measure = () => menu.toggleAttribute('data-fb-still', still());
    const mark = () => {
      requestAnimationFrame(measure);
      window.setTimeout(measure, 320);
    };
    // Put away by a tap on the dimmed page or by a drag, a sheet leaves focus nowhere: it goes back to the key that
    // opened it, as Escape sends it (a page an item opens takes it from there, a frame later).
    let wasOpen = false;
    const refocus = () => {
      const open = menu.hasAttribute('data-open');
      if (wasOpen && !open && (document.activeElement === document.body || menu.contains(document.activeElement))) {
        container.querySelector<HTMLElement>('#flipbook-settings-trigger, .fb-settings')?.focus({ preventScroll: true });
      }
      wasOpen = open;
    };
    const opened = new MutationObserver(() => {
      mark();
      refocus();
      // (Closed: a receiver's row that waited for this is put in or taken out, `update`.)
      if (!menu.hasAttribute('data-open')) this.requestUpdate();
    });
    opened.observe(menu, { attributes: true, attributeFilter: ['data-open'], subtree: true });
    signal.addEventListener('abort', () => opened.disconnect());
  }

  /**
   * Quality (quality.ts): for a film whose stream takes Mux's resolution limits, and fetched only then, once someone
   * is at the player (at once where this viewer chose a height for this film before: it is theirs from the start),
   * or once the film's box has grown past what its address asks for, which is Quality's to answer.
   * A film that moves on to another source (sources.ts) is asked again.
   */
  #quality(container: HTMLElement, signal: AbortSignal) {
    const video = videoIn(container);
    if (!video) return;
    liftAtRest(video, signal);
    const declared = (container.closest('video-player') ?? container).hasAttribute('mux-limits');
    let page: { destroy(): void } | null = null;
    let offered = '';
    let asked = 0;
    const offer = () => {
      const src = video.getAttribute('src') ?? '';
      const stream = takesLimits(src, declared) ? atHeight(src, null) : '';
      if (stream === offered) return;
      offered = stream;
      const run = ++asked;
      page?.destroy();
      page = null;
      if (!stream) return;
      let kept = false;
      try {
        kept = localStorage.getItem(storageKey(container, 'fb-quality')) != null;
      } catch {
        // No storage here: nothing was kept.
      }
      const grown = new Promise<void>((resolve) => {
        if (!fitsHere(video, src)) return;
        const box = new ResizeObserver(() => {
          if (!outgrown(video, video.getAttribute('src') ?? '')) return;
          box.disconnect();
          resolve();
        });
        box.observe(video);
        signal.addEventListener('abort', () => box.disconnect());
      });
      void (kept ? Promise.resolve() : Promise.race([wanted(container), grown]))
        .then(() => import('./quality'))
        .then(({ Quality }) => {
          if (!signal.aborted && run === asked) page = new Quality(container, video, src, () => this.#i18n);
        });
    };
    offer();
    for (const type of ['fb-source', 'loadedmetadata']) video.addEventListener(type, offer, { signal });
    signal.addEventListener('abort', () => page?.destroy());
  }

  #bookItem(name: string) {
    return this.#container?.querySelector<HTMLElement>(`.fb-menu-book[data-fb-menu="${name}"]`) ?? null;
  }

  /**
   * The book's keys as items, on a narrow player, while each key is there and is not on the pad itself. Bookmark says
   * what a press does now.
   */
  #bookItems(narrow: boolean) {
    const container = this.#container;
    if (!container) return;
    // On a phone's pad the book's own keys are on the pad, by name (phone.css, `.fb-book-row`): not here as well.
    const row = container.querySelector<HTMLElement>('.fb-book-row');
    const onPad = !!row && getComputedStyle(row).display !== 'none';
    for (const [name, selector, label] of BOOK) {
      const item = this.#bookItem(name);
      if (!item) continue;
      const key = container.querySelector<HTMLElement>(selector);
      const shown = narrow && !!key && !(name === 'keymap' && this.#touch?.matches) && !(onPad && name !== 'keymap');
      if (item.hidden === shown) item.hidden = !shown;
      const marked = name === 'bookmark' && !!key?.hasAttribute('data-bookmarked');
      const text = tell(this.#i18n, marked ? 'fbPages.unbookmark' : label);
      const node = item.querySelector<HTMLElement>('[data-part="label"]');
      if (node && node.textContent !== text) node.textContent = text;
      if (name === 'bookmark') item.toggleAttribute('data-bookmarked', marked);
    }
  }

  #volumeGroup() {
    return this.#container?.querySelector<Radios>('.fb-menu-volume-group') ?? null;
  }

  /** The volume page's steps, each named by its share ("75%"), a radio item as Speed's are. */
  #levels() {
    const group = this.#volumeGroup();
    if (!group) return;
    const name = say(this.#i18n, 'flipbook.menuVolume');
    for (const label of this.#container?.querySelectorAll<HTMLElement>('.fb-menu-volume [data-part="label"], #flipbook-volume-levels-back [data-part="label"]') ?? []) {
      label.textContent = name;
    }
    group.replaceChildren(
      ...LEVELS.map((level) => {
        const item = document.createElement('media-menu-radio-item');
        item.className = 'media-menu-radio-item';
        item.setAttribute('value', String(level));
        item.innerHTML =
          '<span data-part="label"></span><media-menu-item-indicator force-mount class="media-menu-indicator"><media-icon family="flipbook" name="check" class="media-menu-radio-icon"></media-icon></media-menu-item-indicator>';
        const label = item.querySelector<HTMLElement>('[data-part="label"]');
        if (label) label.textContent = `${Math.round(level * 100)}%`;
        return item;
      }),
    );
  }

  /** Volume in Settings where the fader has left the slab: the nearest step checked, the level named on the way in. */
  #volumePage(shown: boolean) {
    const trigger = this.#container?.querySelector<HTMLElement>('.fb-menu-volume');
    const group = this.#volumeGroup();
    const volume = this.#volume.value;
    if (!trigger || !group) return;
    // Not `hidden`: Video.js keeps a submenu trigger hidden for good if it was hidden when the menu set up.
    // (`data-hidden` is the mark its arrow keys and its first focus pass over.)
    trigger.toggleAttribute('data-fb-off', !shown);
    trigger.toggleAttribute('data-hidden', !shown);
    if (!shown || !volume) return;
    const level = volume.muted ? 0 : volume.volume;
    const nearest = LEVELS.reduce((a, b) => (Math.abs(b - level) < Math.abs(a - level) ? b : a));
    if (group.value !== String(nearest)) group.value = String(nearest);
    const hint = this.#container?.querySelector<HTMLElement>('[data-fb-part="volume"]');
    const text = volume.muted ? say(this.#i18n, 'flipbook.menuMute') : `${Math.round(level * 100)}%`;
    if (hint && hint.textContent !== text) hint.textContent = text;
  }

  #group() {
    return this.#container?.querySelector<Radios>('.fb-menu-chapter-group') ?? null;
  }

  /** One radio item per chapter, numbered as the tabs are, each named in full for a screen reader. */
  #chapters() {
    const group = this.#group();
    const chapters = this.#book?.chapters ?? [];
    const trigger = this.#container?.querySelector<HTMLElement>('.fb-menu-chapters');
    if (!group || !trigger) return;
    const name = tell(this.#i18n, 'fbPages.chapters');
    for (const label of this.#container?.querySelectorAll<HTMLElement>('.fb-menu-chapters [data-part="label"], #flipbook-chapters-back [data-part="label"]') ?? []) {
      label.textContent = name;
    }
    group.replaceChildren(
      ...chapters.map((chapter, i) => {
        const item = document.createElement('media-menu-radio-item');
        item.className = 'media-menu-radio-item fb-menu-chapter';
        item.setAttribute('value', String(i));
        item.setAttribute('aria-label', say(this.#i18n, 'flipbook.chapter', { number: i + 1, title: chapter.text }));
        // On the phone's sheet each chapter shows its first page and where it starts (skin.css shows them there).
        item.innerHTML =
          '<span class="fb-menu-chapter-page" aria-hidden="true"></span><span class="fb-menu-chapter-name" aria-hidden="true"><span class="fb-menu-chapter-number"></span> <span></span></span><span class="fb-menu-chapter-time" aria-hidden="true"></span><media-menu-item-indicator force-mount class="media-menu-indicator"><media-icon family="flipbook" name="check" class="media-menu-radio-icon"></media-icon></media-menu-item-indicator>';
        const [number, title] = item.querySelectorAll<HTMLElement>('.fb-menu-chapter-name > span');
        number.textContent = String(i + 1);
        title.textContent = chapter.text;
        const page = item.querySelector<HTMLElement>('.fb-menu-chapter-page');
        const book = this.#book;
        if (page && book?.tiles.length) page.style.backgroundPosition = spritePosition(book, pageFrom(book, chapter.startTime));
        const time = item.querySelector<HTMLElement>('.fb-menu-chapter-time');
        if (time) time.textContent = clock(chapter.startTime);
        return item;
      }),
    );
    // Not `hidden`: Video.js keeps a submenu trigger hidden for good if it was hidden when the menu set up.
    trigger.toggleAttribute('data-fb-empty', chapters.length < 2);
    trigger.toggleAttribute('data-hidden', chapters.length < 2);
    this.#chapter = -2;
    this.#current();
  }

  /** The chapter playing: checked on the page, and named on the way in. */
  #current() {
    const book = this.#book;
    const time = this.#time.value;
    const group = this.#group();
    if (!book || !time || !group) return;
    const index = chapterAt(book, time.currentTime);
    if (index === this.#chapter) return;
    this.#chapter = index;
    if (index >= 0 && group.value !== String(index)) group.value = String(index);
    const hint = this.#container?.querySelector<HTMLElement>('[data-fb-part="chapter"]');
    const text = book.chapters[index]?.text ?? '';
    if (hint && hint.textContent !== text) hint.textContent = text;
  }

  #item(name: 'mute' | 'pip' | 'sound') {
    return this.#container?.querySelector<Toggle>(`[data-fb-menu="${name}"]`) ?? null;
  }

  #inPip() {
    return Boolean(this.#pip.value?.isPictureInPicture) || !!this.#container?.hasAttribute('data-fb-pip');
  }

  #show(name: 'mute' | 'pip' | 'sound', key: FlipbookKey, shown: boolean, checked: boolean) {
    const item = this.#item(name);
    if (!item) return;
    if (item.hidden === shown) item.hidden = !shown;
    if (item.checked !== checked) item.checked = checked;
    const label = item.querySelector<HTMLElement>('[data-part="label"]');
    const text = say(this.#i18n, key);
    if (label && label.textContent !== text) label.textContent = text;
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('fb-menu')) customElements.define('fb-menu', FbMenuElement);
attach('fb-menu');
