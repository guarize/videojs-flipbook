import { describe, expect, it } from 'vitest';
import { isStream, standing } from '../../src/skins/flipbook/standing';

const STREAM = 'https://stream.mux.com/abc123.m3u8';
const COPY = 'https://example.com/film/film-720.mp4';

describe('what a source is', () => {
  it('a stream is an HLS address, with or without a query, or a streaming library’s blob', () => {
    expect(isStream(STREAM)).toBe(true);
    expect(isStream(`${STREAM}?max_resolution=720p`)).toBe(true);
    expect(isStream('blob:https://example.com/5c1b')).toBe(true);
  });

  it('a file is not', () => {
    expect(isStream(COPY)).toBe(false);
    expect(isStream('https://stream.mux.com/abc123/720p.mp4')).toBe(false);
    expect(isStream('https://example.com/m3u8/film.mp4')).toBe(false);
  });
});

describe('what stands in for the picture under a hand', () => {
  it('the copy, when the page gave one', () => {
    expect(standing({ src: STREAM, scrub: COPY })).toBe('copy');
    expect(standing({ src: 'https://stream.mux.com/abc123/720p.mp4', scrub: COPY })).toBe('copy');
  });

  it('the film itself, when it plays from the very file given as its copy (the stream could not be reached)', () => {
    expect(standing({ src: COPY, scrub: COPY })).toBe('film');
    expect(standing({ src: COPY, scrub: COPY, slow: true })).toBe('film');
  });

  it('the storyboard’s pages, for a stream with no copy', () => {
    expect(standing({ src: STREAM, scrub: '' })).toBe('stills');
    expect(standing({ src: 'blob:https://example.com/5c1b', scrub: '' })).toBe('stills');
  });

  it('the storyboard’s pages, when the copy could not be fetched', () => {
    expect(standing({ src: STREAM, scrub: COPY, failed: true })).toBe('stills');
  });

  it('the film itself, for a file beside the page', () => {
    expect(standing({ src: COPY, scrub: '' })).toBe('film');
  });

  it('the storyboard’s pages, for a file whose seeks have proved slow (a stream’s MP4, a keyframe every fifteen seconds)', () => {
    expect(standing({ src: 'https://stream.mux.com/abc123/720p.mp4', scrub: '', slow: true })).toBe('stills');
    expect(standing({ src: 'https://stream.mux.com/abc123/720p.mp4', scrub: COPY, failed: true, slow: true })).toBe('stills');
  });
});
