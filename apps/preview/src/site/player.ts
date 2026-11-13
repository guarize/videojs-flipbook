import '@videojs/html/i18n';
import '@videojs/html/video/player';
import '@/skins/flipbook/skin';
import template from '@/skins/flipbook/skin.html?raw';
import { nextTask } from '@/shared/tasks';
import type { FbRoomElement } from '@/skins/flipbook/room';
import { playFrom } from '@/skins/flipbook/sources';
import { MEDIA } from './media';

const MEDIA_PLACEHOLDER = '<!-- Add a compatible media component here. -->';

/**
 * The tracks Flipbook reads, all the page's own files: chapters for the tabs, English captions, the storyboard for
 * the pages. The descriptions track is for a browser or screen reader that speaks one; the skin has no control for it.
 */
const TRACKS = [
  `<track kind="chapters" label="Chapters" srclang="en" src="${MEDIA.chapters}" default>`,
  `<track kind="captions" label="English" srclang="en" src="${MEDIA.captions}">`,
  `<track kind="descriptions" label="Audio description" srclang="en" src="${MEDIA.descriptions}">`,
  `<track kind="metadata" label="thumbnails" src="${MEDIA.storyboard}" default>`,
].join('');

export interface Choices {
  /** `features` on the player: `essential`, or `book` (the default, left unset). */
  features?: string;
}

/**
 * Mounts Flipbook in the host, as the review page does (pages/mount.ts), over the poster the page painted while the
 * skin loaded. The host keeps its 16:9 box throughout, so nothing below it moves.
 *
 * In three tasks, so the page can draw between them (in one, they were 70–100 ms of script with the page's layout
 * forced in the middle):
 * 1. the tree is parsed and its elements constructed, off the page;
 * 2. it is connected, not displayed: every element starts and takes its first update with no boxes to lay out (the
 *    time slider's first update reads its thumb's width, which would lay the whole new tree out inside the task);
 * 3. it is displayed, and the browser lays it out once, in its own rendering step. What measures itself does so
 *    from its resize observers, as on any later resize.
 * The page's poster stays under the player until the player's own poster has decoded: no frame without a picture.
 */
export async function mount(host: HTMLElement, choices: Choices = {}): Promise<HTMLElement> {
  const player = document.createElement('video-player');
  player.setAttribute('content-title', MEDIA.title);
  // The poster the page laid in the host is the player's too: the file that screen chose from the page's sizes, already
  // fetched and decoded, so the player's cover costs no second download and shows the same pixels.
  const laid = host.querySelector<HTMLImageElement>('img.player-poster');
  player.setAttribute('poster', laid?.currentSrc || MEDIA.poster);
  if (choices.features) player.setAttribute('features', choices.features);

  if (MEDIA.scrub) player.setAttribute('scrub', MEDIA.scrub);
  player.innerHTML = template.replace(MEDIA_PLACEHOLDER, `<video playsinline crossorigin="anonymous" preload="metadata">${TRACKS}</video>`);
  // The stream where the browser plays one itself, the stream's MP4 where it does not, the file beside the page if
  // neither can be reached (sources.ts). Set before the video joins the player, so the player never hears of a
  // source that was only passed over.
  const video = player.querySelector('video');
  if (video) playFrom(video, MEDIA.sources, { within: host });
  // The time slider's first update makes unit formatters for its spoken value; the first one a page makes loads the
  // number-format data (about 5 ms, measured). Made here, that cost stays out of the task that connects the tree.
  new Intl.NumberFormat(document.documentElement.lang || undefined, { style: 'unit', unit: 'second', unitDisplay: 'long' }).format(1);
  await nextTask();

  const before = [...host.children];
  player.style.display = 'none';
  host.append(player);
  await nextTask();

  player.style.removeProperty('display');
  if (!player.getAttribute('style')) player.removeAttribute('style');
  // Connected with no box, the player could not take its own measure (which way its fore-edge runs, the title's
  // room). Taken here, in the task that shows it, the first frame it paints is the one it keeps.
  player.querySelector<FbRoomElement>('fb-room')?.measure();
  // A poster the page laid under the host's box (`.player-poster`, book.css) stays until the player's own has decoded.
  const under = before.filter((node) => node.matches('.player-poster') || node.querySelector('.player-poster'));
  for (const node of before) if (!under.includes(node)) node.remove();
  const clear = () => {
    for (const node of under) node.remove();
  };
  const poster = player.querySelector<HTMLImageElement>('.media-poster-image');
  if (under.length && poster?.src) {
    // Decoded, or not coming: either way the page's poster has done its job.
    void poster.decode().then(clear, clear);
    setTimeout(clear, 2000);
  } else clear();
  return player;
}
