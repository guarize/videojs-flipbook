import { PlayerController, playerContext, type PropertyValues, selectMetadata, UIElement } from '@videojs/html';
import { type Book, loadBook, pageFrom, videoIn } from './book';
import { attach, claim, currentOwner, inPip, onOwner, release } from './companion';
import { frameUrls, sharpFrame } from './frames';
import { chapterIndexAt, nextChapterStart, positionState, previousChapterStart } from './steps';

/** The system's skip keys move this far, as the player's own seek keys do. */
const SKIP = 5;
/** The smaller of the two artworks: enough for a lock screen or a notification, light to hand over. */
const SMALL = 512;

const ACTIONS: MediaSessionAction[] = ['play', 'pause', 'seekbackward', 'seekforward', 'seekto', 'previoustrack', 'nexttrack'];

function setHandler(action: MediaSessionAction, handler: MediaSessionActionHandler | null) {
  try {
    navigator.mediaSession.setActionHandler(action, handler);
  } catch {
    // This browser doesn't know the action: its controls just won't offer it.
  }
}

const artworks = new WeakMap<Element, Map<number, Promise<MediaImage[]>>>();

/** The chapter's first sharp frame, at two sizes: a small one drawn from it here, and the frame itself. */
function artworkFor(container: Element, book: Book, chapter: number): Promise<MediaImage[]> {
  let byChapter = artworks.get(container);
  if (!byChapter) artworks.set(container, (byChapter = new Map()));
  const hit = byChapter.get(chapter);
  if (hit) return hit;
  const pending = (async (): Promise<MediaImage[]> => {
    const start = book.chapters[chapter]?.startTime ?? 0;
    const url = (await frameUrls(container, book))[pageFrom(book, start)];
    if (!url) return [];
    const height = (width: number) => Math.round(width / book.ratio);
    // Mux renders any width: ask it for both.
    if (url.includes('image.mux.com')) {
      return [SMALL, 1280].map((width) => ({ src: url.replace(/width=\d+/, `width=${width}`), sizes: `${width}x${height(width)}`, type: 'image/webp' }));
    }
    const image = await sharpFrame(url);
    if (!image) return [{ src: url }];
    const full: MediaImage = { src: url, sizes: `${image.naturalWidth}x${image.naturalHeight}`, type: /\.webp(\?|$)/.test(url) ? 'image/webp' : 'image/jpeg' };
    try {
      const canvas = document.createElement('canvas');
      canvas.width = SMALL;
      canvas.height = Math.round((SMALL * image.naturalHeight) / image.naturalWidth);
      canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
      return [{ src: canvas.toDataURL('image/jpeg', 0.86), sizes: `${canvas.width}x${canvas.height}`, type: 'image/jpeg' }, full];
    } catch {
      return [full];
    }
  })();
  byChapter.set(chapter, pending);
  return pending;
}

/**
 * Chapters on the system's media controls: the lock screen, the notification, the keyboard's media keys, a headset.
 * They show the film's title, the chapter playing and that chapter's first frame, and their previous and next keys
 * turn to the chapter before or after, as a page turn when the page is in view. Seeking, the skip keys and the
 * position follow the film. Only the player that last played holds them.
 */
export class FbSessionElement extends UIElement {
  #metadata = new PlayerController(this, playerContext, selectMetadata);
  #abort: AbortController | null = null;
  #container: HTMLElement | null = null;
  #video: HTMLVideoElement | null = null;
  #book: Book | null = null;
  #chapter = -2;
  #title = '';

  connectedCallback() {
    super.connectedCallback();
    if (!('mediaSession' in navigator)) return;
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    const container = this.closest<HTMLElement>('media-container');
    this.#container = container;
    if (!container) return;

    const stop = onOwner((owner) => {
      if (owner === container) this.#own();
    });
    signal.addEventListener('abort', stop);

    queueMicrotask(async () => {
      const video = videoIn(container);
      if (!video || signal.aborted) return;
      this.#video = video;
      video.addEventListener('play', () => claim(container), { signal });
      const position = () => this.#position();
      for (const type of ['durationchange', 'ratechange', 'seeked', 'loadedmetadata', 'play', 'pause']) video.addEventListener(type, position, { signal });
      video.addEventListener('timeupdate', () => this.#metadataIfMoved(), { signal });
      video.addEventListener('play', () => this.#state(), { signal });
      video.addEventListener('pause', () => this.#state(), { signal });
      if (!video.paused) claim(container);
      this.#book = await loadBook(container, signal);
      if (signal.aborted) return;
      if (currentOwner() === container) this.#own();
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort?.abort();
    const container = this.#container;
    if (!container || currentOwner() !== container) return;
    // A container moved into a Document picture-in-picture window is still this player: keep the controls.
    queueMicrotask(() => {
      if (container.isConnected || currentOwner() !== container) return;
      release(container);
      for (const action of ACTIONS) setHandler(action, null);
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
    });
  }

  override update(changed: PropertyValues) {
    super.update(changed);
    const title = this.#metadata.value?.title ?? '';
    if (title === this.#title) return;
    this.#title = title;
    if (this.#owns()) this.#describe(true);
  }

  #owns() {
    return !!this.#container && currentOwner() === this.#container;
  }

  /** This player has the session now: its handlers, its film, its place. */
  #own() {
    const video = this.#video;
    if (!video || !this.#owns()) return;
    setHandler('play', () => void video.play().catch(() => undefined));
    setHandler('pause', () => video.pause());
    setHandler('seekbackward', (details) => this.#seek(video.currentTime - (details.seekOffset ?? SKIP)));
    setHandler('seekforward', (details) => this.#seek(video.currentTime + (details.seekOffset ?? SKIP)));
    setHandler('seekto', (details) => {
      if (details.seekTime == null) return;
      if (details.fastSeek && typeof video.fastSeek === 'function') video.fastSeek(details.seekTime);
      else this.#seek(details.seekTime);
    });
    const chapters = this.#book?.chapters ?? [];
    setHandler('previoustrack', chapters.length ? () => this.#turn(previousChapterStart(chapters, video.currentTime)) : null);
    setHandler(
      'nexttrack',
      chapters.length
        ? () => {
            const next = nextChapterStart(chapters, video.currentTime);
            if (next != null) this.#turn(next);
          }
        : null,
    );
    this.#describe(true);
    this.#state();
    this.#position();
  }

  #seek(time: number) {
    const video = this.#video;
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(time, Number.isFinite(video.duration) ? video.duration : time));
  }

  /**
   * A chapter from the system's keys. With the page in view it turns as a page (turn.ts); hidden, or with the film
   * in a picture-in-picture window, nobody would see the page go over, so it simply goes there.
   */
  #turn(time: number) {
    const container = this.#container;
    const video = this.#video;
    if (!container || !video) return;
    if (document.visibilityState === 'hidden' || inPip(container, video)) {
      this.#seek(time);
      return;
    }
    container.dispatchEvent(new CustomEvent('fb-turn', { bubbles: true, detail: { time, quick: true } }));
  }

  #metadataIfMoved() {
    if (!this.#owns()) return;
    const book = this.#book;
    const video = this.#video;
    if (!book || !video) return;
    if (chapterIndexAt(book.chapters, video.currentTime) !== this.#chapter) this.#describe(false);
  }

  /** Title, chapter and the chapter's frame. The frame follows once it's ready, if the chapter hasn't moved on. */
  #describe(force: boolean) {
    const container = this.#container;
    const video = this.#video;
    if (!container || !video || typeof MediaMetadata === 'undefined') return;
    const book = this.#book;
    const chapter = book ? chapterIndexAt(book.chapters, video.currentTime) : -1;
    if (!force && chapter === this.#chapter) return;
    this.#chapter = chapter;
    const title = this.#metadata.value?.title || container.closest('video-player')?.getAttribute('content-title') || document.title;
    const name = book && chapter >= 0 ? book.chapters[chapter].text.trim() : '';
    const poster = this.#metadata.value?.poster;
    const fallback: MediaImage[] = poster ? [{ src: new URL(poster, location.href).href }] : [];
    const current = navigator.mediaSession.metadata;
    // Keep the frame already showing until the new chapter's is ready, rather than flashing the poster between.
    const keep = current && current.title === title && current.artwork.length ? [...current.artwork] : fallback;
    navigator.mediaSession.metadata = new MediaMetadata({ title, artist: name, album: name, artwork: keep });
    if (!book || chapter < 0) return;
    void artworkFor(container, book, chapter).then((artwork) => {
      if (!artwork.length || !this.#owns() || this.#chapter !== chapter) return;
      navigator.mediaSession.metadata = new MediaMetadata({ title, artist: name, album: name, artwork });
    });
  }

  #state() {
    if (!this.#owns() || !this.#video) return;
    navigator.mediaSession.playbackState = this.#video.paused ? 'paused' : 'playing';
  }

  #position() {
    const video = this.#video;
    if (!video || !this.#owns() || typeof navigator.mediaSession.setPositionState !== 'function') return;
    const state = positionState(video.duration, video.currentTime, video.playbackRate);
    if (!state) return;
    try {
      navigator.mediaSession.setPositionState(state);
    } catch {
      // A position the browser refuses (a duration still settling): the next event sets it again.
    }
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('fb-session')) customElements.define('fb-session', FbSessionElement);
attach('fb-session');
