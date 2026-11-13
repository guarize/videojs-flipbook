/**
 * What the film plays from, when a page names more than one place: a stream first, then files.
 *
 * `playFrom(video, [stream, mp4, local])` gives the film the first source this browser can play (a `.m3u8` only where
 * the browser plays HLS itself: Safari, and Chrome and Edge since 142; Firefox takes the next, an MP4), and, if that
 * source cannot be opened at all (the host is down, the address is blocked), the next one. Nothing is loaded for a
 * source that is not used, and no library is fetched: the browser plays every one of them itself.
 *
 * A source that fails before it has opened is not an error the viewer hears of while another is left to try, so this
 * listens before the player does and keeps that one event from it. A play asked of the source that failed is asked
 * again of the next. A film that fails once it has opened, or the last
 * source failing, is the player's to show (errors.ts, the missing page).
 */

import { boxCap, capOf, fits, lower, screenCap, taller, under } from './renditions';

const STREAM = /\.m3u8(?:[?#]|$)/i;

/** Whether this browser plays a source itself: any file, and a stream where it has HLS of its own. */
export function playsItself(video: HTMLVideoElement, src: string): boolean {
  return !STREAM.test(src) || video.canPlayType('application/vnd.apple.mpegurl') !== '';
}

/** The sources this browser can play, in the order given. */
export function playable(video: HTMLVideoElement, sources: readonly string[]): string[] {
  return sources.filter((src) => src && playsItself(video, src));
}

/** The tracks that are out of a film while its source opens, and how they go back. */
const waiting = new WeakMap<HTMLVideoElement, { tracks: { el: HTMLTrackElement; at: number; mode: TextTrackMode | undefined }[]; back: () => void }>();

/**
 * Gives a film its address. Every change of `src` on the film goes through here.
 *
 * Safari 27 on a real iPhone (iOS 27.2.1, measured on Pedro's phone, 12 Nov 2026; not in the iOS 26.5 simulator, not
 * in desktop WebKit) refuses any source, a stream or a file, same origin or not, with `MEDIA_ERR_SRC_NOT_SUPPORTED`
 * when the element holds a `<track>` that is not `default` (captions, descriptions) at the moment the address is
 * set. `default` tracks (chapters, the storyboard) do no harm. Taking the tracks out and putting the same elements
 * straight back fails too; putting them back once the source has opened (`loadedmetadata`) works, for a first source,
 * a change of source and a failover alike. So the tracks that are not `default` step out for the opening and return,
 * each to its place and with its mode, when the film has its metadata. They are the same elements: their cues stay.
 */
export function open(video: HTMLVideoElement, src?: string): void {
  const held = waiting.get(video);
  if (held) video.removeEventListener('loadedmetadata', held.back);
  const tracks = held?.tracks ?? [];
  if (!held) {
    const all = Array.from(video.children).filter((child): child is HTMLTrackElement => child.localName === 'track');
    all.forEach((el, at) => {
      if (!el.default) tracks.push({ el, at, mode: el.track?.mode });
    });
  }
  for (const { el } of tracks) el.remove();
  // What the film was given, said on the film itself, for good: the player's captions key keeps its place while they
  // are out and in the moment after they return (skin.css), so nothing on the bar moves as the film opens.
  if (tracks.length) video.setAttribute('data-fb-tracks', [...new Set(tracks.map(({ el }) => el.kind))].join(' '));
  // (With no address given, the one it has is asked again: a film whose sources are its own `<source>` children.)
  if (src) video.setAttribute('src', src);
  else video.load();
  if (!tracks.length) return;
  const back = () => {
    waiting.delete(video);
    const keep = () => {
      for (const { el, mode } of tracks) if (mode && el.track && el.parentNode === video && el.track.mode !== mode) el.track.mode = mode;
    };
    for (const { el, at } of tracks) {
      const now = Array.from(video.children).filter((child) => child.localName === 'track');
      video.insertBefore(el, now[at] ?? null);
    }
    keep();
    // A track added to a film that has its metadata is a new track to the browser, which then decides by itself what
    // shows: Chromium turns captions on a task later (seen in the battery, 12 Nov 2026), and WebKit turns them off
    // again when the next track is announced, some 100 ms on (captions chosen before a change of quality were gone
    // after it). So the mode each had when it stepped out is put back after each of those: a task on, and as each
    // returning track is announced (`addtrack`). Nobody could have chosen otherwise in that time.
    setTimeout(keep, 0);
    let left = tracks.length;
    const announced = () => {
      keep();
      setTimeout(keep, 0);
      if (--left <= 0) settled();
    };
    const settled = () => {
      video.textTracks.removeEventListener('addtrack', announced);
      clearTimeout(patience);
    };
    const patience = setTimeout(settled, 2000);
    video.textTracks.addEventListener('addtrack', announced);
  };
  waiting.set(video, { tracks, back });
  video.addEventListener('loadedmetadata', back, { once: true });
}

/**
 * A press of the captions key while the film's caption tracks are out for the opening (above): nothing in the film
 * could take it, and it would be lost. The choice is kept instead, and the tracks return with it: captions asked for
 * before the film has opened are on when it has. False when no caption track is waiting: the press is the player's.
 */
export function captionsAsked(video: HTMLVideoElement): boolean {
  const track = waiting.get(video)?.tracks.find(({ el }) => el.kind === 'captions' || el.kind === 'subtitles');
  if (!track) return false;
  track.mode = track.mode === 'showing' ? 'disabled' : 'showing';
  return true;
}

/**
 * The tallest rendition Auto asks a stream for, for a film shown in `box` (the film itself, or the element its
 * player is about to fill): what the box has room for, in the screen's own pixels, and never more than the screen
 * has (renditions.ts). With no box, all the screen can show. fit.ts has the reasons.
 *
 * The screen's alone, whatever the box, in two places. Where the pointer can hover: the film is then never opened a
 * second time, and a press of play followed by fullscreen is as quick as a film opened once can make it. And on an
 * iPhone: there the film can leave for the system's own player, where its box says nothing of the picture's size,
 * and Safari takes nothing of a film before a press anyway.
 */
export function ceiling(box: Element | null | undefined, shape?: number): number | null {
  const display = screenCap(screen.width, screen.height, window.devicePixelRatio);
  const page = document as Document & { webkitFullscreenEnabled?: boolean };
  const width = box?.clientWidth ?? 0;
  if (!box || !width || matchMedia('(hover: hover)').matches || !(page.fullscreenEnabled || page.webkitFullscreenEnabled)) return display;
  return lower(boxCap(width, box.clientHeight, window.devicePixelRatio, shape), display);
}

/**
 * Whether a film's box, by the film's own shape once that is known, has grown past the ceiling an address asks under.
 * (A film with no box, connected but not displayed, has outgrown nothing: the showcase mounts its player a task
 * before it shows it.)
 */
export function outgrown(video: HTMLVideoElement, src: string): boolean {
  const { clientWidth, videoWidth, videoHeight } = video;
  return clientWidth > 0 && taller(ceiling(video, videoWidth > 0 && videoHeight > 0 ? videoWidth / videoHeight : undefined), capOf(src));
}

/** What a film plays from: its sources in order, the one it is on, and the streams whose ceiling on Auto is the skin's. */
const films = new WeakMap<HTMLVideoElement, { list: string[]; at: number; fitted: Set<string> }>();

/** Whether the ceiling in a film's address is the skin's own (set here, and lifted when there is cause), not the page's. */
export function fitsHere(video: HTMLVideoElement, src: string): boolean {
  return films.get(video)?.fitted.has(under(src, null)) ?? false;
}

/** Whether a film has begun: playing, asked to play, or somewhere past its start. */
export function begun(video: HTMLVideoElement): boolean {
  return !video.paused || video.currentTime > 0;
}

/** What a reload would tell the player of, that the player must not hear: the film has not gone anywhere. */
export const HUSHED = ['emptied', 'loadstart', 'abort', 'durationchange', 'timeupdate'];
/** A film opened again that has not stood this long after is left to say so itself. */
const REOPEN_LIMIT = 15_000;

/**
 * Opens a film that has not begun again, from another address of the same stream, and nobody is the wiser. (For a
 * touch screen's browser that buffers nothing before a press: fit.ts.)
 *
 * - The player is not told: the film's `emptied`, `loadstart` and its length gone are kept from the store and the
 *   skin's parts until the film has its metadata again, as for a change of quality (quality.ts).
 * - A press of play that lands meanwhile is not lost and not doubled: the element itself carries a play asked of a
 *   film that is still opening, and starts when it can. Until it has a frame, the poster stands and the film is not
 *   painted (`data-fb-reopening`, skin.css): the press is answered at once, and the picture is never empty.
 * - If the address cannot be opened, the film moves on to its next source, as for any source that never opens.
 */
export function reopen(video: HTMLVideoElement, src: string): void {
  const film = films.get(video);
  if (film && video.getAttribute('src') === film.list[film.at]) film.list[film.at] = src;
  const local = new AbortController();
  const options = { capture: true, signal: local.signal };
  let opened = false;
  const done = () => {
    local.abort();
    clearTimeout(limit);
    video.removeAttribute('data-fb-reopening');
  };
  const limit = window.setTimeout(done, REOPEN_LIMIT);
  for (const type of HUSHED) {
    video.addEventListener(type, (event) => {
      // (Its length said again as it opens is the same length: only its going is kept back.)
      if (!opened && !(type === 'durationchange' && video.duration > 0)) event.stopImmediatePropagation();
    }, options);
  }
  // It stands once it has a frame, or once the browser has stopped loading a film nobody has asked to play (one that
  // takes no picture before a press: its poster is on its own rule again).
  const stopped = () => {
    if (opened && video.paused && video.networkState === HTMLMediaElement.NETWORK_IDLE) done();
  };
  video.addEventListener('loadedmetadata', () => {
    opened = true;
    stopped();
  }, options);
  video.addEventListener('suspend', stopped, options);
  for (const type of ['loadeddata', 'playing', 'error']) video.addEventListener(type, done, options);
  video.toggleAttribute('data-fb-reopening', true);
  open(video, src);
}

/**
 * Sets the film's `src` to the first playable source, and moves it on to the next if one never opens. Call it before
 * the video joins a player, with the element the player is going into (`within`: its box is the film's) and whether
 * the page says its streams take Mux's limits (`limits`: the player's `mux-limits`). Returns the source it started
 * with (none if the browser can play none of them).
 */
export function playFrom(video: HTMLVideoElement, sources: readonly string[], { within, limits = false }: { within?: Element | null; limits?: boolean } = {}): string {
  // What this browser keeps of the film (the place to resume from, its bookmarks, a chosen quality) is kept under
  // one name, whichever of its sources plays today: the first address the page gave (pages.ts, `storageKey`).
  const name = sources.find(Boolean);
  if (name) video.setAttribute('data-fb-film', name);
  // (A stream that takes the limits is asked under a ceiling: the screen's or its box's, fit.ts.)
  const cap = ceiling(within);
  const fitted = new Set(sources.filter((src) => fits(src, limits)));
  const film = { list: playable(video, sources).map((src) => (fitted.has(src) ? under(src, cap) : src)), at: 0, fitted };
  films.set(video, film);
  const { list } = film;
  if (!list.length) return '';
  const first = list[0];
  open(video, first);
  video.addEventListener('error', (event) => {
    // (An error with nothing left to try, or after the film has opened, is passed on untouched.)
    if (video.readyState > 0 || film.at >= list.length - 1 || video.getAttribute('src') !== list[film.at]) return;
    event.stopImmediatePropagation();
    // A film asked to play before its source had failed (an early press of play) plays from the next one: a new
    // `src` holds the element still, and the play that was asked would be lost with the source it was asked of.
    const playing = !video.paused;
    film.at++;
    open(video, list[film.at]);
    video.dispatchEvent(new CustomEvent('fb-source', { detail: { src: list[film.at], index: film.at } }));
    if (playing) void video.play().catch(() => undefined);
  });
  return first;
}
