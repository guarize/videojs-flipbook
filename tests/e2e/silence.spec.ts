/**
 * No automated browser may make a sound (Pedro, 10 Nov 2026). Every context of the battery is silenced by the shared
 * fixture (support/test.ts, support/silence.mjs); this holds the battery, and the scripts beside it, to that.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { BARE, open } from './support/player';
import { MARK, SILENT_FILM } from './support/silence.mjs';
import { expect, test } from './support/test';

const HERE = fileURLToPath(new URL('.', import.meta.url));

const marked = (page: Page) => page.evaluate((mark) => (window as unknown as Record<string, unknown>)[mark] === true, MARK);

/** What the page was given as the film, and what a Web Audio graph gets to the destination. */
const heard = (page: Page) =>
  page.evaluate(async () => {
    const video = document.querySelector('video') as HTMLVideoElement & { webkitAudioDecodedByteCount?: number; audioTracks?: { length: number }; mozHasAudio?: boolean };
    video.muted = false;
    video.volume = 1;
    await video.play();
    await new Promise<void>((resolve) => {
      const tick = () => (video.currentTime > 0.6 ? resolve() : requestAnimationFrame(tick));
      tick();
    });
    video.pause();
    // A tone wired straight to the destination, rendered offline: what comes out is what speakers would be sent.
    const context = new OfflineAudioContext(1, 4410, 44100);
    const tone = context.createOscillator();
    tone.connect(context.destination);
    tone.start();
    const rendered = (await context.startRendering()).getChannelData(0);
    let peak = 0;
    for (const sample of rendered) peak = Math.max(peak, Math.abs(sample));
    // A seek lands: the silent copy is served by byte range, as the film is (answered whole it could not be sought,
    // and every test that seeks would pass over a film standing at 0).
    const seekable = video.seekable.length ? video.seekable.end(video.seekable.length - 1) : 0;
    await new Promise<void>((resolve) => {
      video.addEventListener('seeked', () => resolve(), { once: true });
      video.currentTime = 41;
    });
    const landed = video.currentTime;
    return {
      seekable,
      landed,
      audioBytes: video.webkitAudioDecodedByteCount ?? null,
      // (Firefox says it in its own word: whether the film has audio at all.)
      audioTracks: video.audioTracks?.length ?? (typeof video.mozHasAudio === 'boolean' ? Number(video.mozHasAudio) : null),
      unmuted: !video.muted && video.volume === 1,
      peak,
    };
  });

test.describe('no automated browser makes a sound', () => {
  test('the page fixture’s context is silenced: the film has no audio track, Web Audio stops short of the speakers', async ({ page }) => {
    await open(page, BARE);
    expect(await marked(page), 'the context was silenced before the page loaded').toBe(true);
    const got = await heard(page);
    // The film plays unmuted at full volume, as a viewer's would (mute and volume are tested as they are): there is
    // nothing in it to hear.
    expect(got.unmuted, 'the film was playing unmuted, at full volume').toBe(true);
    if (got.audioBytes !== null) expect(got.audioBytes, 'audio decoded from the film').toBe(0);
    if (got.audioTracks !== null) expect(got.audioTracks, 'audio tracks in the film').toBe(0);
    expect(got.audioBytes !== null || got.audioTracks !== null, 'the engine says what the film carries').toBe(true);
    expect(got.peak, 'the level of a tone wired to the destination').toBe(0);
    expect(got.seekable, 'the film can be sought to its end').toBeGreaterThan(60);
    expect(Math.abs(got.landed - 41), 'a seek to 0:41 landed').toBeLessThan(0.5);
  });

  test('a context a test makes itself is silenced too, and so is browser.newPage()', async ({ browser }) => {
    const context = await browser.newContext();
    const own = await context.newPage();
    await open(own, BARE);
    expect(await marked(own), 'browser.newContext()').toBe(true);
    const got = await heard(own);
    expect(got.audioBytes ?? got.audioTracks, 'audio in the film').toBe(0);
    expect(Math.abs(got.landed - 41), 'a seek to 0:41 landed').toBeLessThan(0.5);
    await context.close();

    const loose = await browser.newPage();
    await open(loose, BARE);
    expect(await marked(loose), 'browser.newPage()').toBe(true);
    await loose.close();
  });

  test('every spec takes `test` from the shared fixture, and every script that opens a browser silences its contexts', () => {
    const root = join(HERE, '../..');
    expect(statSync(SILENT_FILM).size, 'the silent film is there').toBeGreaterThan(1_000_000);
    const specs = readdirSync(HERE).filter((name) => name.endsWith('.spec.ts'));
    expect(specs.length).toBeGreaterThan(15);
    const strays = specs.filter((name) => {
      const source = readFileSync(join(HERE, name), 'utf8');
      const fromPlaywright = [...source.matchAll(/import\s*\{([^}]*)\}\s*from '@playwright\/test'/g)].flatMap((match) => match[1].split(',').map((part) => part.trim()));
      return fromPlaywright.some((part) => /^(test|chromium|webkit|firefox)\b/.test(part)) || !/from '\.\/support\/test'/.test(source);
    });
    expect(strays, 'specs that could open an unsilenced context').toEqual([]);

    const scripts = readdirSync(join(root, 'scripts')).filter((name) => name.endsWith('.mjs'));
    const loud = scripts.filter((name) => {
      const source = readFileSync(join(root, 'scripts', name), 'utf8');
      if (!/\.launch\(|newContext\(/.test(source)) return false;
      const contexts = source.match(/newContext\(/g)?.length ?? 0;
      // `quiet` (scripts/quiet.mjs) is `silence` with the film served by byte range.
      const silences = source.match(/await (silence|quiet)\(/g)?.length ?? 0;
      return /\.newPage\(/.test(source.replace(/context\.newPage\(/g, '')) || silences < contexts;
    });
    expect(loud, 'scripts with a context that is not silenced').toEqual([]);
  });
});
