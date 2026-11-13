/**
 * Flipbook as a drop-in bundle, for a site that isn't this repo (gua.studio's /work/flipbook): one call mounts the
 * player with its media. Built by `pnpm run build:lib` into `dist-lib/` (an ES module and its stylesheet).
 *
 * The skin's fonts are served from `/fonts/flipbook/` (see theme.css): host `onest-latin.woff2` there, and
 * `newsreader-latin.woff2` beside it for the folio (details.css; fetched only once a folio is set).
 *
 * A film on Mux needs no HLS library: give `src` the stream and the asset's MP4, in that order, and the browser plays
 * the first it can (the stream where it has HLS of its own: Safari, Chrome and Edge since 142; the MP4 in Firefox),
 * and the next if one cannot be reached:
 *
 *   mountFlipbook(host, {
 *     title: 'Locomotion',
 *     poster: '/film/poster.webp',
 *     src: [`https://stream.mux.com/${id}.m3u8`, `https://stream.mux.com/${id}/720p.mp4`, '/film/film-720.mp4'],
 *     scrub: '/film/film-720.mp4',
 *     chapters: '/film/chapters.vtt',
 *     captions: '/film/captions.vtt',
 *     storyboard: '/film/storyboard.vtt',
 *   });
 *
 * `scrub` is what makes a streamed film a flipbook: a silent copy of the same film that seeks at once (encode it with
 * a keyframe every second, `-g <fps>`; 720p is plenty). A stream has a keyframe every few seconds, so a frame asked
 * of it arrives in a third of a second to three; the hand flips the copy instead, and the paused page's strip and
 * plate are read from it (stand.ts). Without it the player still works on a stream, and the flip is as quick as the
 * stream's seeks.
 *
 * A stream on Mux also gets Quality in Settings: Auto, and each height the stream offers, read from its own playlist
 * (quality.ts). Nothing to set for a `stream.mux.com` address; for Mux behind a domain of your own, say so with
 * `muxLimits: true`.
 *
 * `storyboard` can be left out for a `stream.mux.com` source: the skin then takes Mux's own storyboard and
 * thumbnails for the pages (image.mux.com), whatever their number.
 */
import '@videojs/html/i18n';
import '@videojs/html/video/player';
import { type Feature, formatFeatures, type Preset } from './features';
import './skin';
import template from './skin.html?raw';
import { playFrom } from './sources';

export { FEATURES, type Feature, isOn, need, type Preset } from './features';
export { playFrom } from './sources';

export interface FlipbookMedia {
  /** The film's name, on the cover and in the system's media controls. */
  title: string;
  /** The first frame shown, before anything plays. */
  poster: string;
  /**
   * What plays: a file the browser plays itself, or several to try in order (a stream, `.m3u8`, is passed over where
   * the browser has no HLS of its own; a source that cannot be reached gives way to the next).
   */
  src: string | readonly string[];
  /** A silent copy that seeks at once, for the hand to flip when `src` is a stream. Fetched when a hand first needs it. */
  scrub?: string;
  /**
   * The stream takes Mux's `max_resolution` and `min_resolution` on its address although it is not on
   * `stream.mux.com` (a custom domain): Settings then offers its heights as it does for Mux's own host.
   */
  muxLimits?: boolean;
  chapters?: string;
  captions?: string;
  /** A storyboard VTT (`kind="metadata" label="thumbnails"`); not needed for a stream.mux.com source. */
  storyboard?: string;
}

export interface FlipbookOptions {
  /**
   * Which of the book's extras the player has: `'essential'` (the core alone), `'book'` (every extra, the default),
   * or a list of extras (`['plate', 'ribbons']`, with the core). Sets `features` on the player; change the attribute
   * later to switch them live. Extras load on first use, or on idle once the page has settled.
   */
  features?: Preset | readonly Feature[];
}

const MEDIA_PLACEHOLDER = '<!-- Add a compatible media component here. -->';

const attribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Mounts a Flipbook player into `host` and returns its `video-player` element. */
export function mountFlipbook(host: HTMLElement, media: FlipbookMedia, options: FlipbookOptions = {}): HTMLElement {
  const player = document.createElement('video-player');
  if (options.features) player.setAttribute('features', typeof options.features === 'string' ? options.features : formatFeatures(options.features));
  player.setAttribute('content-title', media.title);
  player.setAttribute('poster', media.poster);
  const tracks = [
    media.chapters && `<track kind="chapters" label="Chapters" srclang="en" src="${attribute(media.chapters)}" default>`,
    media.captions && `<track kind="captions" label="English" srclang="en" src="${attribute(media.captions)}">`,
    media.storyboard && `<track kind="metadata" label="thumbnails" src="${attribute(media.storyboard)}" default>`,
  ]
    .filter(Boolean)
    .join('');
  if (media.scrub) player.setAttribute('scrub', media.scrub);
  if (media.muxLimits) player.toggleAttribute('mux-limits', true);
  player.innerHTML = template.replace(MEDIA_PLACEHOLDER, `<video playsinline crossorigin="anonymous" preload="metadata">${tracks}</video>`);
  const video = player.querySelector('video');
  if (video) playFrom(video, typeof media.src === 'string' ? [media.src] : media.src, { within: host, limits: media.muxLimits });
  host.append(player);
  return player;
}
