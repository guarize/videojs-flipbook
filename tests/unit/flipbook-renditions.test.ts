import { describe, expect, it } from 'vitest';
import { atHeight, atMost, boxCap, capOf, fits, heightAt, heightsIn, isMuxStream, keptChoice, lower, nameOf, screenCap, taller, takesLimits, under } from '../../src/skins/flipbook/renditions';

/** A master playlist as Mux writes one (abridged from a film with 360p to 2160p): audio groups, then the variants. */
const MASTER = `#EXTM3U
#EXT-X-VERSION:5
#EXT-X-INDEPENDENT-SEGMENTS

#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-hi-0",NAME="Default",CHANNELS="2",AUTOSELECT=YES,DEFAULT=YES,LANGUAGE="und",URI="https://manifest.example/a/rendition.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=3051400,AVERAGE-BANDWIDTH=3051400,CODECS="mp4a.40.2,avc1.640020",AUDIO="audio-med-0",RESOLUTION=960x540,CLOSED-CAPTIONS=NONE
https://manifest.example/1/rendition.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1596100,CODECS="mp4a.40.2,avc1.64001f",AUDIO="audio-lo-0",RESOLUTION=640x360,CLOSED-CAPTIONS=NONE
https://manifest.example/2/rendition.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=4834500,RESOLUTION=1280x720,CODECS="mp4a.40.2,avc1.640020"
https://manifest.example/3/rendition.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=9248800,CODECS="mp4a.40.2,avc1.64002a",RESOLUTION=1920x1080
https://manifest.example/4/rendition.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=12332100,CODECS="mp4a.40.2,avc1.64002a",RESOLUTION=1920x1080
https://manifest.example/5/rendition.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=18082900,RESOLUTION=2560x1440
https://manifest.example/6/rendition.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=30137800,RESOLUTION=3840x2160
https://manifest.example/7/rendition.m3u8
`;
const STREAM = 'https://stream.mux.com/abc123DEF.m3u8';

describe('a stream’s renditions', () => {
  it('are read from the master playlist: each height once, tallest first', () => {
    expect(heightsIn(MASTER)).toEqual([2160, 1440, 1080, 720, 540, 360]);
    expect(heightsIn(MASTER.replaceAll('\n', '\r\n'))).toEqual([2160, 1440, 1080, 720, 540, 360]);
  });

  it('are none where the playlist names none: a media playlist, an error page, nothing', () => {
    expect(heightsIn('#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\nseg-000.m4s\n')).toEqual([]);
    expect(heightsIn('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS="mp4a.40.2"\naudio.m3u8\n')).toEqual([]);
    expect(heightsIn('<html>Not found</html>')).toEqual([]);
    expect(heightsIn('')).toEqual([]);
  });
});

describe('a stream’s address', () => {
  it('asks for one height with both of Mux’s limits', () => {
    expect(atHeight(STREAM, 2160)).toBe(`${STREAM}?min_resolution=2160p&max_resolution=2160p`);
    expect(atHeight(STREAM, 360)).toBe(`${STREAM}?min_resolution=360p&max_resolution=360p`);
  });

  it('keeps what else it carried, and replaces a limit it already had', () => {
    expect(atHeight(`${STREAM}?token=x.y&max_resolution=720p#t=5`, 1080)).toBe(`${STREAM}?token=x.y&min_resolution=1080p&max_resolution=1080p#t=5`);
    expect(atHeight('./media/stream/ladder.m3u8', 180)).toBe('./media/stream/ladder.m3u8?min_resolution=180p&max_resolution=180p');
  });

  it('asks for all of them with the limits taken off', () => {
    expect(atHeight(`${STREAM}?min_resolution=1080p&max_resolution=1080p`, null)).toBe(STREAM);
    expect(atHeight(`${STREAM}?token=x&min_resolution=1080p&max_resolution=1080p`, null)).toBe(`${STREAM}?token=x`);
    expect(atHeight(STREAM, null)).toBe(STREAM);
  });

  it('says which height it asks for, and none for a range or for no limit', () => {
    expect(heightAt(atHeight(STREAM, 1440))).toBe(1440);
    expect(heightAt(`${STREAM}?max_resolution=1080p`)).toBeNull();
    expect(heightAt(`${STREAM}?min_resolution=540p&max_resolution=720p`)).toBeNull();
    expect(heightAt(STREAM)).toBeNull();
    for (const height of heightsIn(MASTER)) expect(heightAt(atHeight(atHeight(STREAM, 360), height))).toBe(height);
  });

  it('takes the limits where it is Mux’s, or where the page says its stream does', () => {
    expect(takesLimits(STREAM)).toBe(true);
    expect(takesLimits('https://video.example.com/abc.m3u8')).toBe(false);
    expect(takesLimits('https://video.example.com/abc.m3u8?token=x', true)).toBe(true);
    expect(takesLimits('https://video.example.com/abc.mp4', true)).toBe(false);
  });

  it('is capped for what only reads small pictures from it, whatever the viewer chose', () => {
    expect(atMost(atHeight(STREAM, 2160), 720)).toBe(`${STREAM}?max_resolution=720p`);
    expect(atMost(`${STREAM}?token=x`, 720)).toBe(`${STREAM}?token=x&max_resolution=720p`);
    expect(atMost('./media/film/film-720.mp4', 720)).toBe('./media/film/film-720.mp4');
    expect(atMost('./media/stream/ladder.m3u8', 180, true)).toBe('./media/stream/ladder.m3u8?max_resolution=180p');
  });

  it('is Mux’s only on Mux’s own host', () => {
    expect(isMuxStream(STREAM)).toBe(true);
    expect(isMuxStream(`${STREAM}?max_resolution=720p`)).toBe(true);
    expect(isMuxStream('https://stream.mux.com/abc123DEF/720p.mp4')).toBe(false);
    expect(isMuxStream('https://example.com/stream.mux.com/abc.m3u8')).toBe(false);
    expect(isMuxStream('./media/stream/film.m3u8')).toBe(false);
  });
});

describe('a viewer’s choice', () => {
  it('is named by its height, and by what people call it', () => {
    expect(nameOf(2160)).toEqual({ label: '2160p', tier: '4K' });
    expect(nameOf(1080)).toEqual({ label: '1080p', tier: 'HD' });
    expect(nameOf(720)).toEqual({ label: '720p', tier: 'HD' });
    expect(nameOf(540)).toEqual({ label: '540p', tier: '' });
  });

  it('is ignored where the film no longer has it: Auto', () => {
    expect(keptChoice('1080', [2160, 1080, 720])).toBe(1080);
    expect(keptChoice('1440', [1080, 720])).toBeNull();
    expect(keptChoice(null, [1080, 720])).toBeNull();
    expect(keptChoice('auto', [1080, 720])).toBeNull();
    expect(keptChoice('0', [1080, 720])).toBeNull();
  });
});

describe('what a screen is asked to play on Auto', () => {
  it('is no taller than the largest 16:9 picture the screen can show, in its own pixels', () => {
    expect(screenCap(1280, 720, 1), 'a 720p screen').toBe(720);
    expect(screenCap(1920, 1080, 1), 'a 1080p screen').toBe(1080);
    expect(screenCap(2560, 1440, 1), 'a 1440p screen').toBe(1440);
    // A phone, whichever way it is held: 1170 px across its short side at 3x, so 1440p.
    expect(screenCap(390, 844, 3)).toBe(1440);
    expect(screenCap(844, 390, 3)).toBe(1440);
    expect(screenCap(360, 740, 2), 'a small Android: 720 px across').toBe(720);
  });

  it('is not limited where the screen shows the tallest rendition', () => {
    expect(screenCap(3840, 2160, 1)).toBeNull();
    expect(screenCap(1512, 982, 2), 'a laptop at 2x: 1701 px of picture').toBeNull();
    expect(screenCap(5120, 2880, 1)).toBeNull();
  });

  it('limits a Mux stream’s address, and nothing else', () => {
    const phone = screenCap(390, 844, 3);
    expect(fits(STREAM)).toBe(true);
    expect(under(STREAM, phone)).toBe(`${STREAM}?max_resolution=1440p`);
    expect(under(`${STREAM}?token=x`, phone)).toBe(`${STREAM}?token=x&max_resolution=1440p`);
    expect(under(STREAM, screenCap(3840, 2160, 1)), 'no ceiling: the address as it was').toBe(STREAM);
    expect(under(`${STREAM}?max_resolution=540p`, 1080), 'a ceiling lifted: one limit, the new one').toBe(`${STREAM}?max_resolution=1080p`);
    expect(under(`${STREAM}?token=x&max_resolution=540p`, null), 'and taken off').toBe(`${STREAM}?token=x`);
    // The page's own limits stand, and a file or another host's stream is left alone.
    expect(fits(`${STREAM}?max_resolution=720p`)).toBe(false);
    expect(fits(`${STREAM}?token=x&min_resolution=1080p`)).toBe(false);
    expect(fits('https://stream.mux.com/abc123DEF/720p.mp4')).toBe(false);
    expect(fits('./media/stream/ladder.m3u8')).toBe(false);
    // A stream the page says takes the limits (Mux behind a domain of its own) is fitted as Mux's own is.
    expect(fits('./media/stream/ladder.m3u8', true)).toBe(true);
    expect(fits('./media/stream/ladder.m3u8?max_resolution=720p', true)).toBe(false);
    expect(fits('./media/film/film-720.mp4', true)).toBe(false);
  });

  it('is still Auto to the Quality page: one limit is no chosen height, and the choices are made from the open address', () => {
    const capped = under(STREAM, screenCap(1280, 720, 1));
    expect(capped).toBe(`${STREAM}?max_resolution=720p`);
    expect(heightAt(capped)).toBeNull();
    expect(capOf(capped)).toBe(720);
    expect(atHeight(atHeight(capped, null), 2160)).toBe(`${STREAM}?min_resolution=2160p&max_resolution=2160p`);
  });
});

describe('what a film is asked to play on Auto in the box it has', () => {
  it('is the lowest height that covers the picture the box has room for, in the screen’s own pixels', () => {
    expect(boxCap(412, 232, 1.75), 'a phone upright: 406 px of picture').toBe(540);
    expect(boxCap(390, 219, 3), 'an iPhone-sized box at 3x: 657 px').toBe(720);
    expect(boxCap(873, 491, 1), 'the showcase in a 1280 px window').toBe(540);
    expect(boxCap(873, 491, 2), 'and at 2x: 982 px').toBe(1080);
    expect(boxCap(1280, 720, 1)).toBe(720);
    expect(boxCap(1280, 721, 1), 'a picture one pixel over 720 is still 720: the box is wider than the film needs').toBe(720);
    expect(boxCap(1284, 800, 1), 'a pixel over a rendition takes the next').toBe(1080);
    expect(boxCap(160, 90, 1), 'a mini player').toBe(360);
  });

  it('goes by the picture, not the box: a film fitted inside a box of another shape', () => {
    expect(boxCap(412, 823, 1.75), 'a 16:9 film in an upright box: as wide as the box, 232 px tall').toBe(540);
    expect(boxCap(1280, 400, 1), 'in a short one: as tall as the box').toBe(540);
    expect(boxCap(1280, 0, 1), 'a box with no height yet: by its width').toBe(720);
    expect(boxCap(600, 1000, 2, 9 / 16), 'an upright film: 600 across, 1067 tall, capped by the box at 1000').toBeNull();
    expect(boxCap(300, 600, 2, 9 / 16), '300 across, 533 tall, at 2x').toBe(1080);
  });

  it('has no ceiling where the box shows the tallest rendition', () => {
    expect(boxCap(3840, 2160, 1)).toBeNull();
    expect(boxCap(1512, 851, 2)).toBeNull();
  });

  it('compares ceilings, where none at all is the tallest', () => {
    expect(taller(1080, 540)).toBe(true);
    expect(taller(540, 540)).toBe(false);
    expect(taller(540, 1080)).toBe(false);
    expect(taller(null, 1080), 'no ceiling asks for more than any').toBe(true);
    expect(taller(1080, null), 'and nothing asks for more than none').toBe(false);
    expect(taller(null, null)).toBe(false);
    expect(lower(540, 1080)).toBe(540);
    expect(lower(null, 1080), 'a box that could show 4K on a 1080p screen: the screen’s').toBe(1080);
    expect(lower(720, null)).toBe(720);
    expect(lower(null, null)).toBeNull();
  });

  it('reads the ceiling an address asks under, and none from a chosen height', () => {
    expect(capOf(`${STREAM}?max_resolution=540p`)).toBe(540);
    expect(capOf(`${STREAM}?token=x&max_resolution=1440p#t=3`)).toBe(1440);
    expect(capOf(STREAM)).toBeNull();
    expect(capOf(`${STREAM}?min_resolution=720p&max_resolution=720p`)).toBeNull();
  });
});
