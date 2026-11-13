import { measureContrast, type Result } from './support/contrast';
import { BARE, BRIGHT, DARK, measure, media, open, pointerOnPlayer, settle, startAndHold } from './support/player';
import { arrive, receivers } from './support/receivers';
import { expect, test } from './support/test';

/**
 * Every visible label, time, tab, keycap, caption and icon in the player, measured against the composited pixels
 * behind it, with the film paused on its brightest frame (1:28.56, the colophon's paper page) and its darkest (0:00.50,
 * the opening before the light comes up); support/player.ts has how they were found.
 * The bar: 4.9:1 for text under 24 px (18.66 px bold), 3.4:1 for large text, icons and the playhead's edge
 * (WCAG AA plus the standard's 0.4 margin). Twice: as shipped, and rebranded as the README shows a site doing it, by
 * setting the accent's tokens (theme.css) in its own stylesheet. A rebrand passes only if every pair it moves holds
 * over both frames.
 */
const REBRAND = `.media-skin[data-theme="flipbook"] {
  --fb-accent: #3d7bf2;
  --fb-accent-edge: #3a6fd8;
  --fb-accent-mid: #2457c5;
  --fb-accent-deep: #1d469e;
  --fb-accent-glow: rgb(215 228 255);
  --fb-accent-shade: rgb(4 18 60);
  --fb-accent-shade-deep: rgb(2 12 44);
  --fb-cloth: linear-gradient(90deg, #0e2350, #183a82 38%, #1d469e 56%, #10295c);
  --fb-cloth-playhead: linear-gradient(90deg, #2a5cc4, var(--fb-accent) 45%, #6d9cf7 60%, #2e63cf);
  --fb-page-read: linear-gradient(180deg, #7aa4f5, var(--fb-accent-edge) 40%, #1f4ba6);
}`;
const THEMES = [
  { theme: 'flipbook', css: '' },
  { theme: 'rebranded', css: REBRAND },
] as const;
const FRAMES = [
  { frame: 'bright', time: BRIGHT },
  { frame: 'dark', time: DARK },
];
const MIN = { text: 4.9, large: 3.4, graphics: 3.4, boundary: 3.4 } as const;
/** An audit that measured almost nothing would pass too; it has to have seen the bar. */
const FLOOR = { text: 12, graphics: 8 };

const worst = (results: Result[]) =>
  results.length ? results.reduce((a, b) => (b.ratio < a.ratio ? b : a)) : undefined;

const summary = (r: Result | undefined) =>
  r && { ratio: r.ratio, element: r.label, size: r.size, color: r.color, ground: r.ground };

for (const { theme, css } of THEMES) {
  for (const { frame, time } of FRAMES) {
    test(`${theme}, ${frame} frame (${time}s): text, keycaps, captions and icons hold their contrast`, async ({ page }, testInfo) => {
      await open(page, BARE);
      if (css) {
        await page.addStyleTag({ content: css });
        const accent = await page.locator('media-container').evaluate((el) => getComputedStyle(el).getPropertyValue('--fb-accent').trim());
        expect(accent, 'the rebrand took').toBe('#3d7bf2');
      }
      // Captions on (the C key, the pointer on the picture: a character key is the player's only then), so the
      // caption over this frame is measured with the rest.
      await pointerOnPlayer(page);
      await page.keyboard.press('c');
      await expect.poll(async () => (await media(page)).captions).toBe('showing');
      await startAndHold(page, time);
      await settle(page);

      const shot = await page.screenshot({ animations: 'disabled', caret: 'hide' });
      await testInfo.attach(`${theme}-${frame}-frame`, { body: shot, contentType: 'image/png' });
      const { results, skipped, ground } = await measureContrast(page);
      await testInfo.attach(`${theme}-${frame}-ground`, { body: ground, contentType: 'image/png' });

      const by = (kind: Result['kind']) => results.filter((r) => r.kind === kind);
      const captions = results.filter((r) => r.caption);
      await measure(testInfo, {
        theme,
        frame,
        time,
        text: summary(worst(by('text'))),
        large: summary(worst(by('large'))),
        graphics: summary(worst(by('graphics'))),
        boundary: summary(worst(by('boundary'))),
        captions: summary(worst(captions)),
        counts: { text: by('text').length + by('large').length, graphics: by('graphics').length, captions: captions.length },
        skipped,
        all: results,
      });

      // Sanity floor: the audit saw the bar, its keys and their icons.
      expect(by('text').length + by('large').length, 'text runs measured').toBeGreaterThanOrEqual(FLOOR.text);
      expect(by('graphics').length, 'icons measured').toBeGreaterThanOrEqual(FLOOR.graphics);
      expect(by('boundary').length, 'playhead measured').toBe(1);
      // A caption is up at both moments (cue 13 over the paper, cue 1 over the dark).
      expect(captions.length, 'caption measured').toBeGreaterThan(0);

      const failures = results
        .filter((r) => r.ratio < MIN[r.kind])
        .map((r) => `${r.kind} ${r.ratio}:1 < ${MIN[r.kind]} — ${r.label} (${r.color} on ${r.ground}, ${r.size}px)`);
      expect(failures, `contrast below the bar in ${theme} over the ${frame} frame`).toEqual([]);
    });
  }
}

/**
 * A phone's player (390 px: the picture, and under it the pad with the tabs, the fore-edge and one row of keys),
 * over the same two frames. The captions stand on the picture; the tabs' numbers, the time, the running foot and the
 * keys' icons stand on the pad's cloth.
 */
test.describe('a phone, the pad under the picture', () => {
  test.use({ viewport: { width: 390, height: 780 }, hasTouch: true });
  for (const { frame, time } of FRAMES) {
    test(`${frame} frame (${time}s): tabs, time, title, captions and icons hold their contrast`, async ({ page }, testInfo) => {
      await open(page, BARE);
      await expect(page.locator('media-container')).toHaveAttribute('data-fb-pad', '');
      await page.evaluate(() => (document.querySelector('media-container') as HTMLElement).focus({ preventScroll: true }));
      await page.keyboard.press('c');
      await expect.poll(async () => (await media(page)).captions).toBe('showing');
      await startAndHold(page, time);
      await settle(page);

      const shot = await page.screenshot({ animations: 'disabled', caret: 'hide' });
      await testInfo.attach(`phone-${frame}-frame`, { body: shot, contentType: 'image/png' });
      const { results, skipped } = await measureContrast(page);
      const by = (kind: Result['kind']) => results.filter((r) => r.kind === kind);
      const tabs = results.filter((r) => /fb-tab/.test(r.label));
      await measure(testInfo, {
        theme: 'flipbook, 390 px',
        frame,
        time,
        text: summary(worst(by('text'))),
        large: summary(worst(by('large'))),
        graphics: summary(worst(by('graphics'))),
        boundary: summary(worst(by('boundary'))),
        tabs: summary(worst(tabs)),
        counts: { text: by('text').length + by('large').length, graphics: by('graphics').length, tabs: tabs.length },
        skipped,
        all: results,
      });

      // Sanity floor: the six tabs, the time and the title; the slab's icons; the ribbon.
      // (Six numbers, and the names of the tabs that have room to print theirs.)
      expect(tabs.length, 'tab numbers and names measured').toBeGreaterThanOrEqual(6);
      expect(by('text').length + by('large').length, 'text runs measured').toBeGreaterThanOrEqual(8);
      expect(by('graphics').length, 'icons measured').toBeGreaterThanOrEqual(3);
      expect(by('boundary').length, 'playhead measured').toBe(1);

      const failures = results
        .filter((r) => r.ratio < MIN[r.kind])
        .map((r) => `${r.kind} ${r.ratio}:1 < ${MIN[r.kind]} — ${r.label} (${r.color} on ${r.ground}, ${r.size}px)`);
      expect(failures, `contrast below the bar on a phone over the ${frame} frame`).toEqual([]);
    });
  }
});

test('AirPlay and Cast, when there is a receiver to offer: their icons hold over the brightest frame', async ({ page, browserName }, testInfo) => {
  test.skip(browserName === 'firefox', 'Firefox has neither AirPlay nor the Remote Playback API: no receiver’s key ever comes');
  // Neither key shows without a receiver on the network (which a test machine may or may not have), and each browser
  // has one of the two: here the browser is one that has both, and says a receiver has come (support/receivers.ts).
  await receivers(page, { both: true });
  await open(page, BARE);
  await arrive(page, true);
  await startAndHold(page, BRIGHT);
  await settle(page);
  await expect(page.locator('.media-airplay-button')).toBeVisible();
  await expect(page.locator('.media-cast-button')).toBeVisible();
  const { results } = await measureContrast(page);
  const keys = results.filter((r) => r.kind === 'graphics' && /airplay|cast/i.test(r.label));
  await measure(testInfo, { kind: 'airplay-cast', keys: keys.map(summary) });
  expect(keys.length, 'both icons measured').toBe(2);
  const failures = keys.filter((r) => r.ratio < MIN.graphics).map((r) => `${r.ratio}:1 < ${MIN.graphics} — ${r.label} (${r.color} on ${r.ground})`);
  expect(failures, 'AirPlay and Cast over the bright frame').toEqual([]);
});
