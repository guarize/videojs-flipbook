import { type PropertyValues, PlayerController, playerContext, selectPiP, UIElement } from '@videojs/html';
import { I18nController, i18nContext } from '@videojs/html/i18n';
import { type Book, chapterAt, clock, loadBook, videoIn } from './book';
import { isOn } from './features';
import { type FlipbookKey, say } from './i18n';
import { isPlainKey, voiceFor } from './pages';
import { canCurl, PAGE, Paper, pose, turnCurve } from './paper';

/*
 * Picture-in-picture, as a book would do it.
 *
 * Where the browser has Document Picture-in-Picture (Chromium), the PiP key, `I`, and the waiting page's "Bring it
 * back" open a small window and move the whole player into it: fore-edge, chapter tabs, the skin's captions, page
 * turns and keys come along, and a compact layout follows from the player's own container queries. Where it hasn't
 * (Safari, Firefox), the same controls ask Video.js for the browser's own video window, as before.
 *
 * Either way, the player's place in the page turns over in real paper (paper.ts) and uncovers a waiting page of the
 * same size: the frame it left on, printed on the page, a ribbon in the gutter, and a slim fore-edge that keeps
 * following the film, its chapters a click (or Tab and Enter) away. Coming back turns the page back in. Under
 * reduced motion, or without WebGL, the waiting page simply appears and goes.
 *
 * For the parts that need to know (session.ts, autopip.ts, float.ts): while in picture-in-picture the container and
 * the element it was placed in carry `data-fb-pip="document|video"`, and the container dispatches bubbling
 * `fb-pip-enter` / `fb-pip-leave` events with `{ mode }`. Enter is dispatched before the player leaves the page and
 * leave once it is back, so both are heard from the page's own document.
 */

export type PipMode = 'document' | 'video';
export interface PipEventDetail {
  mode: PipMode;
}

type PiPState = NonNullable<ReturnType<typeof selectPiP>>;

interface DocumentPictureInPicture {
  readonly window: Window | null;
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}

/** The parts of Video.js's PiP button this file wraps: its core's media input, and what activating it does. */
interface PiPButton extends HTMLElement {
  core: { setMedia(media: PiPState): void };
  activate(...args: unknown[]): unknown;
  requestUpdate(): void;
}

/** Turning the player's page over, or back in: a chapter turn's length, since it was asked for at once. */
const TURN = 620;
/** The window opens this wide, at the film's own shape: small enough to sit beside work, the player's compact size. */
const WINDOW_WIDTH = 432;
/** On the way back the turning page is the film, playing: a fresh picture of it every few frames. */
const REFRESH_EVERY = 6;
/** The frame printed on the waiting page, at most this wide. */
const STILL_WIDTH = 960;

function documentPiP(): DocumentPictureInPicture | null {
  if (typeof window === 'undefined') return null;
  return (window as Window & { documentPictureInPicture?: DocumentPictureInPicture }).documentPictureInPicture ?? null;
}

/* ─── Pictures ──────────────────────────────────────────────────────────── */

/** What the player shows: the film's frame (or, before it has one, the poster), set in the box on the desk. */
function pictureSource(container: HTMLElement, video: HTMLVideoElement | null): { source: CanvasImageSource; w: number; h: number } | null {
  if (video && video.readyState >= 2 && video.videoWidth) return { source: video, w: video.videoWidth, h: video.videoHeight };
  const poster = container.querySelector<HTMLImageElement>('.media-poster-image');
  if (poster?.complete && poster.naturalWidth) return { source: poster, w: poster.naturalWidth, h: poster.naturalHeight };
  return null;
}

/** The player as it looks, for the page that turns: the picture contained in the player's box, on its desk colour. */
function capture(container: HTMLElement, video: HTMLVideoElement | null, box: DOMRect, into?: HTMLCanvasElement): HTMLCanvasElement {
  const scale = Math.min(2, window.devicePixelRatio || 1);
  const canvas = into ?? document.createElement('canvas');
  const w = Math.max(2, Math.round(box.width * scale));
  const h = Math.max(2, Math.round(box.height * scale));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.fillStyle = getComputedStyle(container).backgroundColor || '#0d0b09';
  ctx.fillRect(0, 0, w, h);
  const picture = pictureSource(container, video);
  if (picture) {
    const fit = Math.min(w / picture.w, h / picture.h);
    const dw = picture.w * fit;
    const dh = picture.h * fit;
    try {
      ctx.drawImage(picture.source, (w - dw) / 2, (h - dh) / 2, dw, dh);
    } catch {
      // A picture the page can't read (no CORS): the desk alone.
    }
  }
  return canvas;
}

/** The frame the film left on, at its own shape, for printing on the waiting page. Null when there's no picture. */
function still(container: HTMLElement, video: HTMLVideoElement | null): HTMLCanvasElement | null {
  const picture = pictureSource(container, video);
  if (!picture) return null;
  const fit = Math.min(1, STILL_WIDTH / picture.w);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(picture.w * fit);
  canvas.height = Math.round(picture.h * fit);
  try {
    canvas.getContext('2d')?.drawImage(picture.source, 0, 0, canvas.width, canvas.height);
  } catch {
    return null;
  }
  return canvas;
}

/* ─── The window ────────────────────────────────────────────────────────── */

/**
 * Dresses the Document PiP window like the page: its root's attributes, every stylesheet (the `<style>`s Vite
 * injects, the built `<link>`s, constructed sheets), and any added later while it's open. A `<base>` first, so the
 * copies' relative URLs (the fonts above all) resolve as they do in the page.
 */
function dress(win: Window, signal: AbortSignal) {
  const doc = win.document;
  for (const attr of Array.from(document.documentElement.attributes)) doc.documentElement.setAttribute(attr.name, attr.value);
  doc.documentElement.classList.add('fb-pip-window');
  doc.title = document.title;
  const base = doc.createElement('base');
  base.href = document.baseURI;
  doc.head.append(base);
  const meta = doc.createElement('meta');
  meta.name = 'viewport';
  meta.content = 'width=device-width, initial-scale=1';
  doc.head.append(meta);

  const isSheet = (node: Node): node is HTMLStyleElement | HTMLLinkElement =>
    node instanceof HTMLStyleElement || (node instanceof HTMLLinkElement && node.relList.contains('stylesheet'));
  for (const node of document.querySelectorAll('style, link[rel~="stylesheet"]')) {
    if (isSheet(node)) doc.head.append(doc.importNode(node, true));
  }
  const later = new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) if (isSheet(node)) doc.head.append(doc.importNode(node, true));
  });
  later.observe(document.head, { childList: true });
  signal.addEventListener('abort', () => later.disconnect());

  // An extra that arrives while the window is open brings its sheet (features.ts adopts it): the window takes a copy.
  document.addEventListener('fb-sheet', (event) => {
    const sheet = (event as CustomEvent<CSSStyleSheet>).detail;
    const copy = new (win as typeof window).CSSStyleSheet();
    copy.replaceSync(Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n'));
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, copy];
  }, { signal });
  if (document.adoptedStyleSheets.length) {
    const Sheet = (win as typeof window).CSSStyleSheet;
    doc.adoptedStyleSheets = document.adoptedStyleSheets.map((sheet) => {
      const copy = new Sheet();
      copy.replaceSync(Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n'));
      return copy;
    });
  }
  // Faces added from script rather than from a stylesheet; the stylesheets' own come with their copies.
  for (const face of document.fonts) {
    try {
      doc.fonts.add(face);
    } catch {
      // A stylesheet's face, already on its way with the copied sheet.
    }
  }
}

/**
 * Keys pressed in the window with nothing in it focused go to the player, as the page's own keys do (page-keys.ts
 * does this for the page's document; the window is a document of its own). A key that did something stops the window
 * doing it too.
 */
function forwardKeys(doc: Document, container: HTMLElement, signal: AbortSignal) {
  const forward = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
    const target = event.target;
    if (target && target !== doc.body && target !== doc.documentElement && target !== doc) return;
    const copy = new KeyboardEvent(event.type, {
      key: event.key,
      code: event.code,
      location: event.location,
      repeat: event.repeat,
      shiftKey: event.shiftKey,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    container.dispatchEvent(copy);
    if (copy.defaultPrevented) event.preventDefault();
  };
  doc.addEventListener('keydown', forward, { signal });
  doc.addEventListener('keyup', forward, { signal });
}

/** The chapter you're in, on a tab standing on the fore-edge: the compact window's chapter name (pip-page.css). */
function chapterTab(container: HTMLElement, video: HTMLVideoElement | null, signal: AbortSignal) {
  const seek = container.querySelector('.fb-seek');
  if (!seek || !video) return;
  const tab = document.createElement('span');
  tab.className = 'fb-pip-now';
  tab.setAttribute('aria-hidden', 'true');
  seek.append(tab);
  signal.addEventListener('abort', () => tab.remove());
  let book: Book | null = null;
  const render = () => {
    const index = book ? chapterAt(book, video.currentTime) : -1;
    const text = book && index >= 0 ? `${index + 1} ${book.chapters[index].text}` : '';
    if (tab.textContent !== text) tab.textContent = text;
    tab.hidden = !text;
  };
  loadBook(container, signal).then((loaded) => {
    book = loaded;
    if (!signal.aborted) render();
  }, () => {});
  for (const type of ['timeupdate', 'seeked']) video.addEventListener(type, render, { signal });
  render();
}

/* ─── The waiting page ──────────────────────────────────────────────────── */

let pages = 0;

interface Segment {
  button: HTMLButtonElement;
  read: HTMLElement;
  start: number;
  end: number;
}

/**
 * The page under the player's: the frame it left on, printed; what's happening and the way back; a ribbon in the
 * gutter; and a fore-edge that follows the film, one segment per chapter, each segment a way to that chapter.
 */
class WaitingPage {
  readonly root: HTMLElement;
  readonly back: HTMLButtonElement;
  readonly leaf: HTMLElement;
  #voice: HTMLElement;
  #edge: HTMLElement;
  #where: HTMLElement;
  #segments: Segment[] = [];
  #abort = new AbortController();
  #video: HTMLVideoElement | null;
  #book: Book | null = null;
  #timer = 0;

  constructor(
    container: HTMLElement,
    video: HTMLVideoElement | null,
    picture: HTMLCanvasElement | null,
    t: (key: FlipbookKey, values?: Record<string, string | number>) => string,
    actions: { back(): void; seek(time: number): void },
  ) {
    this.#video = video;
    const id = `fb-pip-${++pages}`;
    const root = document.createElement('section');
    root.className = 'media-skin fb-pip-page';
    root.dataset.theme = 'flipbook';
    root.setAttribute('aria-labelledby', `${id}-title`);
    root.innerHTML = `
      <span class="fb-pip-ribbon" aria-hidden="true"></span>
      <div class="fb-pip-body">
        <div class="fb-pip-plate" aria-hidden="true"></div>
        <div class="fb-pip-copy">
          <span class="fb-pip-rule" aria-hidden="true"></span>
          <p class="fb-pip-title" id="${id}-title"></p>
          <p class="fb-pip-where"></p>
          <button type="button" class="fb-pip-back" aria-describedby="${id}-title" aria-keyshortcuts="I">
            <media-icon family="flipbook" name="pip-exit" class="fb-pip-back-icon" aria-hidden="true"></media-icon>
            <span class="fb-pip-back-name"></span>
            <kbd class="fb-pip-keycap" aria-hidden="true">I</kbd>
          </button>
        </div>
        <div class="fb-pip-edge" role="group"></div>
      </div>
      <div class="fb-pip-voice" role="status" aria-live="polite" aria-atomic="true"></div>
      <div class="fb-pip-leaf" aria-hidden="true"></div>`;
    this.root = root;
    const $ = <T extends HTMLElement>(selector: string) => root.querySelector(selector) as T;
    this.back = $<HTMLButtonElement>('.fb-pip-back');
    this.leaf = $('.fb-pip-leaf');
    this.#voice = $('.fb-pip-voice');
    this.#edge = $('.fb-pip-edge');
    this.#where = $('.fb-pip-where');
    // A compound like "picture-in-picture" stays whole: each hyphenated word is kept from breaking by CSS, so the
    // text itself (and what a screen reader reads) keeps its plain hyphens.
    const title = $('.fb-pip-title');
    title.replaceChildren(
      ...t('flipbook.pipPlaying')
        .split(/(\S+-\S+)/)
        .filter(Boolean)
        .map((part) => {
          if (!/-/.test(part)) return document.createTextNode(part);
          const word = document.createElement('span');
          word.style.whiteSpace = 'nowrap';
          word.textContent = part;
          return word;
        }),
    );
    $('.fb-pip-back-name').textContent = t('flipbook.pipBack');
    this.#edge.setAttribute('aria-label', t('flipbook.chapters'));
    const plate = $('.fb-pip-plate');
    if (picture) {
      picture.className = 'fb-pip-still';
      plate.append(picture);
    } else {
      root.toggleAttribute('data-fb-blank', true);
    }

    const { signal } = this.#abort;
    this.back.addEventListener('click', () => actions.back(), { signal });
    // `I` brings it back from the page too, as it sent it away.
    root.addEventListener('keydown', (event) => {
      if (event.key.toLowerCase() !== 'i' || event.shiftKey || event.repeat || !isPlainKey(event)) return;
      event.preventDefault();
      actions.back();
    }, { signal });

    loadBook(container, signal).then((book) => {
      if (signal.aborted) return;
      this.#book = book;
      this.#build(t, actions.seek);
      this.#render();
    }, () => {});
    if (video) {
      for (const type of ['timeupdate', 'seeked', 'seeking', 'durationchange', 'loadedmetadata']) {
        video.addEventListener(type, () => this.#render(), { signal });
      }
    }
    this.#build(t, actions.seek);
    this.#render();
  }

  /** One segment per chapter, as wide as its share of the film (never narrower than a finger), or one for the whole film. */
  #build(t: (key: FlipbookKey, values?: Record<string, string | number>) => string, seek: (time: number) => void) {
    const { signal } = this.#abort;
    const duration = this.#video?.duration;
    const chapters = this.#book?.chapters.length
      ? this.#book.chapters.map((c) => ({ start: c.startTime, end: c.endTime, text: c.text }))
      : Number.isFinite(duration) && duration
        ? [{ start: 0, end: duration as number, text: '' }]
        : [];
    if (!chapters.length || chapters.length === this.#segments.length) return;
    this.#segments = [];
    const buttons = chapters.map((chapter, i) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'fb-pip-seg';
      button.innerHTML = '<span class="fb-pip-seg-name" aria-hidden="true"><b></b> <span></span></span><span class="fb-pip-seg-pages" aria-hidden="true"><span class="fb-pip-seg-read"></span></span>';
      const number = String(i + 1);
      (button.querySelector('b') as HTMLElement).textContent = number;
      (button.querySelector('.fb-pip-seg-name > span') as HTMLElement).textContent = chapter.text;
      if (chapter.text) button.setAttribute('aria-label', t('flipbook.chapter', { number, title: chapter.text }));
      else button.setAttribute('aria-label', clock(chapter.start));
      button.addEventListener('click', () => seek(chapter.start), { signal });
      this.#segments.push({ button, read: button.querySelector('.fb-pip-seg-read') as HTMLElement, start: chapter.start, end: chapter.end });
      return button;
    });
    // Each track takes its share of the film, with a 44 px floor; the grid hands what a short chapter needs from the rest.
    this.#edge.style.gridTemplateColumns = chapters.map((c) => `minmax(44px, ${Math.max(0.001, c.end - c.start).toFixed(3)}fr)`).join(' ');
    this.#edge.replaceChildren(...buttons);
  }

  #render() {
    const video = this.#video;
    if (!video) return;
    const time = video.currentTime;
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    let current = -1;
    this.#segments.forEach((segment, i) => {
      const span = Math.max(0.001, segment.end - segment.start);
      const read = Math.min(1, Math.max(0, (time - segment.start) / span));
      segment.read.style.transform = `scaleX(${read.toFixed(4)})`;
      const here = time >= segment.start && (time < segment.end || i === this.#segments.length - 1);
      if (here && current < 0) current = i;
    });
    this.#segments.forEach((segment, i) => {
      if (i === current) segment.button.setAttribute('aria-current', 'true');
      else segment.button.removeAttribute('aria-current');
    });
    const book = this.#book;
    const index = book ? chapterAt(book, time) : -1;
    const chapter = index >= 0 && book ? book.chapters[index] : null;
    const timing = `${clock(time)} / ${clock(duration)}`;
    const text = chapter ? `${index + 1} ${chapter.text} · ${timing}` : timing;
    if (this.#where.textContent !== text) this.#where.textContent = text;
  }

  /** Says something politely; the region is in the page from the start, empty, so the first message is heard. */
  say(message: string) {
    clearTimeout(this.#timer);
    this.#voice.textContent = '';
    this.#timer = window.setTimeout(() => {
      this.#voice.textContent = message;
    }, 80);
  }

  /** Over the player, inside its frame (video mode, and the turn back in): everything under it is out of reach. */
  cover(container: HTMLElement, inerted: HTMLElement[]) {
    this.root.toggleAttribute('data-fb-over', true);
    this.root.style.removeProperty('width');
    this.root.style.removeProperty('aspect-ratio');
    this.root.style.removeProperty('border-radius');
    for (const child of Array.from(container.children)) {
      if (child === this.root || !(child instanceof HTMLElement) || child.inert) continue;
      child.inert = true;
      inerted.push(child);
    }
    container.append(this.root);
  }

  /** In the page's flow, in the player's place, at the player's size and corners. */
  place(before: Element, box: DOMRect, radius: string) {
    this.root.toggleAttribute('data-fb-over', false);
    const host = before.parentElement;
    const fills = host ? Math.abs(host.clientWidth - box.width) < 1 : false;
    this.root.style.width = fills ? '100%' : `${box.width}px`;
    this.root.style.aspectRatio = `${box.width} / ${box.height}`;
    this.root.style.borderRadius = radius;
    before.before(this.root);
  }

  dispose() {
    this.#abort.abort();
    clearTimeout(this.#timer);
    this.root.remove();
  }
}

/* ─── A player's picture-in-picture ─────────────────────────────────────── */

const sessions = new WeakMap<HTMLElement, PipSession>();

class PipSession {
  readonly container: HTMLElement;
  mode: PipMode | null = null;
  pip: PiPState | null = null;
  t: (key: FlipbookKey, values?: Record<string, string | number>) => string = (key, values) => say(null, key, values);
  #page: WaitingPage | null = null;
  #window: Window | null = null;
  #windowAbort: AbortController | null = null;
  #player: HTMLElement | null = null;
  #host: HTMLElement | null = null;
  #opening = false;
  #inVideo = false;
  #inerted: HTMLElement[] = [];
  #run = 0;
  #frame = 0;
  #paper: Paper | null = null;
  #button: PiPButton | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    // `I` is Video.js's hotkey (it stays, so the key shows in the PiP key's tooltip and aria-keyshortcuts); with
    // Document PiP in reach it's answered here first, so it opens the book's window rather than the video's.
    container.addEventListener('keydown', (event) => {
      if (event.key.toLowerCase() !== 'i' || event.shiftKey || !isPlainKey(event)) return;
      // With the book's PiP turned off, `I` is Video.js's own again: the browser's video window.
      if (!isOn(container, 'pip')) return;
      if (!documentPiP() && this.mode !== 'document') return;
      event.preventDefault();
      if (!event.repeat) this.toggle();
    }, { capture: true });
  }

  /** Wraps Video.js's PiP button once: its state reads the Document window as picture-in-picture, and it opens it. */
  wrapButton() {
    const button = this.container.querySelector<HTMLElement>('media-pip-button') as PiPButton | null;
    if (!button || button === this.#button || !button.core || typeof button.activate !== 'function') return;
    this.#button = button;
    const core = button.core;
    const setMedia = core.setMedia.bind(core);
    core.setMedia = (media) => setMedia(this.mode === 'document' && media ? { ...media, isPictureInPicture: true } : media);
    const activate = button.activate.bind(button);
    button.activate = (...args: unknown[]) =>
      isOn(this.container, 'pip') && (documentPiP() || this.mode === 'document') ? this.toggle() : activate(...args);
    button.requestUpdate();
  }

  /** The PiP key, `I`, and "Bring it back": in if out, out if in. */
  toggle(): Promise<void> | void {
    if (this.#opening) return;
    if (this.mode === 'document') {
      this.#window?.close();
      return;
    }
    if (this.mode === 'video' || this.pip?.isPictureInPicture) {
      this.pip?.exitPictureInPicture().catch(() => {});
      return;
    }
    if (this.pip?.pictureInPictureAvailability !== 'available') return;
    if (documentPiP()) return this.#open();
    this.pip.requestPictureInPicture().catch(() => {});
  }

  /** Video.js's PiP state, from the element: the browser's own window, whichever way it was entered or left. */
  sync(pip: PiPState | null | undefined) {
    this.pip = pip ?? null;
    const on = Boolean(pip?.isPictureInPicture);
    if (on === this.#inVideo) return;
    this.#inVideo = on;
    if (on && !this.mode) this.#enterVideo();
    else if (!on && this.mode === 'video') this.#leaveVideo();
  }

  /* The book's window. */

  async #open() {
    const api = documentPiP();
    const container = this.container;
    const video = videoIn(container);
    if (!api) return;
    const player = (container.closest('video-player') as HTMLElement | null) ?? container;
    const host = player.parentElement;
    if (!host) return;
    const box = container.getBoundingClientRect();
    const ratio = video?.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : box.width / Math.max(1, box.height) || 16 / 9;
    // Before anything moves: the player as it looks, and the frame to print.
    const sheet = capture(container, video, box);
    const picture = still(container, video);
    let win: Window;
    this.#opening = true;
    try {
      win = await api.requestWindow({ width: WINDOW_WIDTH, height: Math.round(WINDOW_WIDTH / ratio) });
    } catch {
      this.#opening = false;
      // Refused (no user activation left, or a policy): the browser's own window, if it will still open.
      this.pip?.requestPictureInPicture().catch(() => {});
      return;
    }
    this.#opening = false;
    if (this.mode || !player.isConnected) {
      win.close();
      return;
    }

    const abort = new AbortController();
    this.#windowAbort = abort;
    this.#window = win;
    this.#player = player;
    this.#host = host;
    dress(win, abort.signal);

    const page = this.#makePage(video, picture);
    this.#page = page;
    // Heard in the page's document, before the player leaves it.
    this.#setMode('document');
    page.place(player, box, getComputedStyle(container).borderRadius);
    // The first frame is drawn now, flat, while the player is still under it: nothing blinks as it leaves.
    const turning = this.#turn(page, sheet, 'away');
    win.document.body.append(player);
    forwardKeys(win.document, container, abort.signal);
    chapterTab(container, video, abort.signal);
    win.addEventListener('pagehide', () => this.#comeHome(), { once: true });
    // The window's close button, "back to tab", `I`, or "Bring it back": all of them close the window.
    page.back.focus({ preventScroll: true });
    page.say(this.t('flipbook.pipPlaying'));
    // With nothing focused in the page, `I` still brings it back while the pointer is over the page the player left
    // behind: a character key typed anywhere else on the page is the page's (page-keys.ts, WCAG 2.1.4).
    document.addEventListener('keydown', (event) => {
      const target = event.target;
      if (target !== document.body && target !== document.documentElement) return;
      if (!page.root.matches(':hover')) return;
      if (event.key.toLowerCase() !== 'i' || event.shiftKey || event.repeat || !isPlainKey(event)) return;
      event.preventDefault();
      this.toggle();
    }, { signal: abort.signal });
    await turning;
  }

  /** The window is closing (whichever way): the player goes home in this same task, then the page turns back in. */
  async #comeHome() {
    if (this.mode !== 'document') return;
    const page = this.#page;
    const player = this.#player;
    const container = this.container;
    this.#windowAbort?.abort();
    this.#windowAbort = null;
    this.#window = null;
    if (player) {
      if (page?.root.isConnected) page.root.after(player);
      else this.#host?.append(player);
    }
    const focused = !document.activeElement || document.activeElement === document.body || Boolean(page?.root.contains(document.activeElement));
    this.#setMode(null);
    this.#player = null;
    if (!page) return;
    page.cover(container, this.#inerted);
    const box = container.getBoundingClientRect();
    const video = videoIn(container);
    const sheet = capture(container, video, box);
    const done = await this.#turn(page, sheet, 'back', () => capture(container, video, box, sheet));
    if (!done) return;
    this.#finish(page, focused);
  }

  /* The browser's own window. */

  #enterVideo() {
    const container = this.container;
    const video = videoIn(container);
    const box = container.getBoundingClientRect();
    const sheet = capture(container, video, box);
    const picture = still(container, video);
    this.#host = ((container.closest('video-player') as HTMLElement | null) ?? container).parentElement;
    this.#setMode('video');
    const page = this.#makePage(video, picture);
    this.#page = page;
    page.cover(container, this.#inerted);
    void this.#turn(page, sheet, 'away');
    page.back.focus({ preventScroll: true });
    page.say(this.t('flipbook.pipPlaying'));
  }

  async #leaveVideo() {
    const container = this.container;
    const page = this.#page;
    const focused = !document.activeElement || document.activeElement === document.body || Boolean(page?.root.contains(document.activeElement));
    this.#setMode(null);
    if (!page) return;
    const box = container.getBoundingClientRect();
    const video = videoIn(container);
    const sheet = capture(container, video, box);
    const done = await this.#turn(page, sheet, 'back', () => capture(container, video, box, sheet));
    if (!done) return;
    this.#finish(page, focused);
  }

  /* Shared. */

  #makePage(video: HTMLVideoElement | null, picture: HTMLCanvasElement | null) {
    this.#page?.dispose();
    return new WaitingPage(this.container, video, picture, this.t, {
      back: () => this.toggle(),
      seek: (time) => this.#seek(time),
    });
  }

  /** A chapter chosen on the waiting page: in the book's window it turns there, as the chapter tabs do. */
  #seek(time: number) {
    const container = this.container;
    if (this.mode === 'document') {
      container.dispatchEvent(new CustomEvent('fb-turn', { detail: { time } }));
      return;
    }
    const video = videoIn(container);
    if (video) video.currentTime = time;
  }

  #finish(page: WaitingPage, refocus: boolean) {
    page.dispose();
    if (this.#page === page) this.#page = null;
    for (const element of this.#inerted) element.inert = false;
    this.#inerted = [];
    if (refocus) {
      const button = this.#button;
      const target = button && button.checkVisibility?.() !== false && !button.hidden ? button : this.container;
      target.focus({ preventScroll: true });
    }
    voiceFor(this.container)(this.t('flipbook.pipReturned'));
  }

  #setMode(mode: PipMode | null) {
    const was = this.mode;
    this.mode = mode;
    for (const element of [this.container, this.#host]) {
      if (!element) continue;
      if (mode) element.setAttribute('data-fb-pip', mode);
      else element.removeAttribute('data-fb-pip');
    }
    this.#button?.requestUpdate();
    if (mode) this.container.dispatchEvent(new CustomEvent<PipEventDetail>('fb-pip-enter', { bubbles: true, composed: true, detail: { mode } }));
    else if (was) this.container.dispatchEvent(new CustomEvent<PipEventDetail>('fb-pip-leave', { bubbles: true, composed: true, detail: { mode: was } }));
    if (!mode) this.#host = null;
  }

  /**
   * The player's page in real paper: turning over and away (`away`, uncovering the waiting page), or turning back in
   * over it (`back`). Drawn once, flat or gone, before the clock starts, so the shaders and the upload land first.
   * Resolves true when it ran to the end (or there was nothing to run), false when a newer turn cut it short.
   */
  #turn(page: WaitingPage, picture: HTMLCanvasElement, way: 'away' | 'back', refresh?: () => HTMLCanvasElement): Promise<boolean> {
    this.#stop();
    const run = ++this.#run;
    if (!canCurl()) return Promise.resolve(true);
    const paper = Paper.create(page.leaf);
    const first = paper?.texture(picture);
    if (!paper || !first) {
      paper?.dispose();
      return Promise.resolve(true);
    }
    this.#paper = paper;
    page.root.toggleAttribute('data-fb-turning', true);
    const at = (t: number) => (way === 'away' ? turnCurve(t) : turnCurve(1 - t));
    let sheet = first;
    paper.draw('shadow', [pose(sheet, at(0), 1, PAGE)]);
    return new Promise((resolve) => {
      let start = -1;
      let frames = 0;
      const tick = (now: number) => {
        if (run !== this.#run) {
          resolve(false);
          return;
        }
        if (start < 0) start = now;
        const t = Math.min(1, (now - start) / TURN);
        frames += 1;
        if (refresh && (frames % REFRESH_EVERY === 0 || t === 1)) sheet = paper.texture(refresh()) ?? sheet;
        paper.draw('shadow', [pose(sheet, at(t), 1, PAGE)]);
        if (t < 1) {
          this.#frame = requestAnimationFrame(tick);
          return;
        }
        this.#stop();
        page.root.toggleAttribute('data-fb-turning', false);
        resolve(true);
      };
      this.#frame = requestAnimationFrame(tick);
    });
  }

  #stop() {
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    this.#paper?.dispose();
    this.#paper = null;
  }
}

/**
 * The element in the skin's markup (beside the PiP key) that ties a player to its picture-in-picture. It renders
 * nothing: it reads Video.js's PiP state for the session, which outlives it moving between the page and the window.
 */
export class FbPipElement extends UIElement {
  #pip = new PlayerController(this, playerContext, selectPiP);
  #i18n = new I18nController(this, i18nContext);
  #session: PipSession | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.hidden = true;
    this.setAttribute('aria-hidden', 'true');
    const container = this.closest<HTMLElement>('media-container');
    if (!container) return;
    let session = sessions.get(container);
    if (!session) {
      session = new PipSession(container);
      sessions.set(container, session);
    }
    this.#session = session;
    session.t = (key, values) => say(this.#i18n, key, values);
    // The PiP button upgrades with the rest of the markup; wrap it once it has.
    queueMicrotask(() => session.wrapButton());
  }

  update(changed: PropertyValues) {
    super.update(changed);
    this.#session?.wrapButton();
    this.#session?.sync(this.#pip.value);
  }

  /** The book's PiP is being turned off: its window closes (the player comes home), and the key is the browser's again. */
  leave() {
    const session = this.#session;
    if (session?.mode === 'document') void session.toggle();
  }
}

customElements.define('fb-pip', FbPipElement);
