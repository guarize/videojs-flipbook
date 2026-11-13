import '@videojs/html/i18n';
import '@videojs/html/video/player';
import { playFrom } from '@/skins/flipbook/sources';
import { MEDIA } from '../site/media';
import './page.css';

const MEDIA_PLACEHOLDER = '<!-- Add a compatible media component here. -->';

/**
 * Mounts the skin on the film for the workbench's pages. Unless the address says otherwise the media is the local
 * 720p file with its chapters, English captions and storyboard.
 *
 * `?source=` plays the film from somewhere else, for Flipbook's own checks of a streamed film:
 * - `stream`: a local HLS copy of the film (tests/e2e/support/stream.mjs makes it; the dev and preview servers answer
 *   it, no build carries it), with the 720p file as the scrub copy;
 * - `ladder`: the same stream with two renditions, answered as Mux answers one asked for a height (the Quality page);
 * - `mux`: what the showcase plays (site/media.ts), from Mux.
 * With `&scrub=none`, either is mounted with no scrub copy; with `&tracks=none`, with none of the page's tracks.
 * `?film=bare` is the local file and nothing else: no title, poster, chapters, captions or storyboard.
 */
const STREAM = './media/stream/film.m3u8';
const LADDER = './media/stream/ladder.m3u8';

export function mount(template: string, name: string): void {
  const host = document.getElementById('player');
  if (!host) return;
  document.documentElement.dataset.skin = name;
  const params = new URLSearchParams(location.search);
  if (params.has('bare')) document.documentElement.dataset.bare = '';

  const player = document.createElement('video-player');
  // `?film=bare`: a film and nothing else (no title, poster, chapters, captions or storyboard), as a host may give it.
  const bare = params.get('film') === 'bare';
  if (!bare) {
    player.setAttribute('content-title', MEDIA.title);
    player.setAttribute('poster', MEDIA.poster);
  }
  // `?features=essential` (the core alone), `book` (the default) or a list (`essential plate ribbons`): Flipbook's
  // extras (src/skins/flipbook/features.ts).
  const features = params.get('features');
  if (features) player.setAttribute('features', features);
  const source = params.get('source');
  const sources = source === 'stream' ? [STREAM] : source === 'ladder' ? [LADDER, MEDIA.mp4] : source === 'mux' ? MEDIA.sources : [MEDIA.mp4];
  // (The local ladder takes Mux's limits on its address, as a Mux stream behind a domain of one's own does.)
  if (source === 'ladder') player.toggleAttribute('mux-limits', true);
  // (`&scrub=none` leaves the copy out: the storyboard's pages then stand in under the hand, stand.ts.)
  if (params.get('scrub') !== 'none' && (source === 'stream' || source === 'ladder' || (source === 'mux' && MEDIA.scrub))) player.setAttribute('scrub', MEDIA.mp4);
  // `&tracks=none`: the film with none of the page's tracks (a Mux film then takes Mux's own storyboard).
  const tracks = bare || params.get('tracks') === 'none'
    ? []
    : [
        `<track kind="chapters" label="Chapters" srclang="en" src="${MEDIA.chapters}" default>`,
        `<track kind="captions" label="English" srclang="en" src="${MEDIA.captions}">`,
        `<track kind="descriptions" label="Audio description" srclang="en" src="${MEDIA.descriptions}">`,
        `<track kind="metadata" label="thumbnails" src="${MEDIA.storyboard}" default>`,
      ];
  const media = ['<video playsinline crossorigin="anonymous" preload="metadata">', ...tracks, '</video>'].join('');
  player.innerHTML = template.replace(MEDIA_PLACEHOLDER, media);
  const video = player.querySelector('video');
  if (video) playFrom(video, sources, { within: host, limits: source === 'ladder' });
  host.append(player);
}
