/**
 * What the players play: "Locomotion", a book of Eadweard Muybridge's motion photographs (public domain) opened, turned
 * and riffled on a desk, to "Origami" by Scott Buckley (CC BY 4.0; sources and attribution in
 * media-src/film/CREDITS.md).
 *
 * The film plays from Mux. The playback ID is this one value; nothing else in the tree names it. A browser with HLS of
 * its own (Safari; Chrome and Edge since 142) plays the stream, one without (Firefox) plays the asset's MP4, and if
 * Mux cannot be reached at all the film plays from the 720p file beside the page (src/skins/flipbook/sources.ts).
 * Set the ID to '' and the film plays from that file alone.
 *
 * The pages (storyboard, stills), the poster and the tracks are the page's own files, made from the same film by
 * scripts/film-assets.mjs. So is the scrub copy: the 720p file, which has a keyframe every second where the stream
 * has one every five and its MP4 one every fifteen. It is what a hand flips (src/skins/flipbook/stand.ts); it is
 * never heard.
 */
export const MUX_PLAYBACK_ID = 'bDlKpxwX002hGaml02oux7YwW8k46MI00Ny02isftbAbcnA';
/** The asset's static MP4, for a browser that plays no HLS itself (an asset names it by its height, or `highest.mp4`). */
const MUX_MP4 = '720p.mp4';

const LOCAL = './media/film/film-720.mp4';
const mux = (path: string) => `https://stream.mux.com/${MUX_PLAYBACK_ID}${path}`;

export const MEDIA = {
  title: 'Locomotion',
  poster: './media/film/poster.webp',
  mp4: LOCAL,
  /** Where the film plays from, in the order tried. */
  sources: MUX_PLAYBACK_ID ? [mux('.m3u8'), mux(`/${MUX_MP4}`), LOCAL] : [LOCAL],
  /** The copy a hand flips, where the film plays from a stream. */
  scrub: MUX_PLAYBACK_ID ? LOCAL : '',
  chapters: './media/film/chapters.vtt',
  captions: './media/film/captions.vtt',
  descriptions: './media/film/descriptions.vtt',
  storyboard: './media/film/storyboard.vtt',
};
