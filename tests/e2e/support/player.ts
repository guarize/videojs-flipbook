import { expect, type Page, type TestInfo } from '@playwright/test';

/** The player alone, without the review page's notes. */
export const BARE = '/flipbook.html?bare';
/** The public showcase. */
export const SHOWCASE = '/';

/** The film's chapter starts, from apps/preview/public/media/film/chapters.vtt. */
export const CHAPTERS = [0, 12.583, 36.583, 69, 78.583, 88.167];
/** Their titles, in order. */
export const TITLES = ['The Book', 'One Gallop', 'The Herd', 'Flight', 'Torn Out', 'Colophon'];
export const DURATION = 98;
/** The storyboard's pages (storyboard.vtt): 52, one every 1.92 s. */
export const PAGES = 52;
export const PER_PAGE = 1.92;
/** One frame of the film: 24 a second. */
export const FRAME = 1 / 24;
/**
 * The two frames contrast is measured over (mean luma of every frame of the 720p, ffmpeg signalstats, 16–235; film
 * v1.3, 11 Nov):
 * - bright: the colophon's paper page, which holds 160.2–160.35 from 1:28.167 to 1:28.833 (the film's own notes name
 *   1:28.292 the brightest, this measure 1:28.375 at 160.35). This frame, 1:28.542 (160.26), is the first of them with
 *   a caption up, so the caption is measured over the paper too;
 * - dark: the opening, before the light comes up (15.15; frame 0 is 14.74, and there the player shows its cover).
 */
export const BRIGHT = 88.56;
export const DARK = 0.5;

/**
 * WebKit's Tab only reaches text fields unless the user turns on full keyboard access; Option-Tab reaches every
 * control, which is what a keyboard user on a Mac presses. Chromium's Tab reaches everything.
 */
export const tabKey = (browserName: string) => (browserName === 'webkit' ? 'Alt+Tab' : 'Tab');

/**
 * The preset the battery runs under: `FB_FEATURES=essential pnpm run test:e2e` runs every page with the core alone
 * (`?features=essential`); unset, pages keep their default, the full book. Tests that exercise one of the book's
 * extras skip themselves under essential (`skipWithout`).
 */
export const FEATURES = process.env.FB_FEATURES ?? '';
export const ESSENTIAL = FEATURES === 'essential';

/** Skips a test under a preset that doesn't have the extras it exercises. */
export function skipWithout(test: { skip: (condition: boolean, reason: string) => void }, ...extras: string[]): void {
  test.skip(ESSENTIAL, `needs the book's ${extras.join(', ')} (off with features=essential)`);
}

/** The path with the battery's preset, if one is set and the path doesn't name its own. */
export function featured(path: string): string {
  if (!FEATURES) return path;
  const url = new URL(path, 'http://x');
  if (url.searchParams.has('features')) return path;
  url.searchParams.set('features', FEATURES);
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Opens a page and waits until the skin is mounted, every extra it has on has arrived (they load on idle after the
 * page has settled; the mini player's only on a play), the film's metadata is in, and the fonts have settled.
 */
export async function open(page: Page, path: string): Promise<void> {
  await page.goto(featured(path));
  await expect(page.locator('fb-edge[data-ready]')).toHaveCount(1);
  await page.waitForFunction(() => {
    const container = document.querySelector('media-container');
    const loaded = new Set((container?.getAttribute('data-fb-loaded') ?? '').split(' ').filter(Boolean));
    const wanted = (container?.getAttribute('data-fb-features') ?? '').split(' ').filter((name) => name && name !== 'float');
    return !!container?.hasAttribute('data-fb-features') && wanted.every((name) => loaded.has(name));
  }, undefined, { timeout: 15_000 });
  // The deck has measured the player. On the narrowest phones the two-row slab leaves no room for a card above it, and
  // the deck stands down (no data-fb-ready) for the core's preview: measured, not necessarily ready.
  if (await page.locator('media-container[data-fb-features~="deck"]').count()) {
    await page.waitForFunction(() => !!document.querySelector<HTMLElement>('fb-deck [data-part="stage"]')?.style.getPropertyValue('--fb-cw'));
  }
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    return !!video && video.readyState >= 1 && video.duration > 0;
  });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

export interface MediaState {
  time: number;
  paused: boolean;
  muted: boolean;
  volume: number;
  rate: number;
  captions: string;
}

export const media = (page: Page): Promise<MediaState> =>
  page.evaluate(() => {
    const video = document.querySelector('video') as HTMLVideoElement;
    const captions = [...video.textTracks].find((t) => t.kind === 'captions' || t.kind === 'subtitles');
    return {
      time: video.currentTime,
      paused: video.paused,
      muted: video.muted,
      volume: video.volume,
      rate: video.playbackRate,
      captions: captions?.mode ?? 'none',
    };
  });

/** Describes the focused element for messages and file names. */
export const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return { tag: 'none', id: '', cls: '', name: '' };
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id,
      cls: typeof el.className === 'string' ? el.className : '',
      name: (el.getAttribute('aria-label') ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
    };
  });

/** Presses Tab (real key presses) until the focused element matches the selector. */
export async function tabTo(page: Page, browserName: string, selector: string, max = 60): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (await page.evaluate((s) => !!document.activeElement?.matches(s), selector)) return;
    await page.keyboard.press(tabKey(browserName));
    // From the page's last stop Chromium and WebKit go round to its first. Firefox goes to its own toolbar, and with
    // none (headless) stays where it was: the walk is then taken up from the top of the page.
    if (browserName === 'firefox') {
      await page.evaluate(() => {
        const seen = window as unknown as { __tabAt?: Element | null };
        const at = document.activeElement as HTMLElement | null;
        if (at && at !== document.body && at === seen.__tabAt) {
          document.body.tabIndex = -1;
          document.body.focus({ preventScroll: true });
          document.body.removeAttribute('tabindex');
        }
        seen.__tabAt = document.activeElement;
      });
    }
  }
  throw new Error(`Tab never reached ${selector} in ${max} presses`);
}

/**
 * Puts the pointer on the picture and leaves it there: a character key (K, C, T, ?) typed on the page reaches the
 * player only with the pointer over it or focus in it (page-keys.ts, WCAG 2.1.4). A third of the way down and a
 * quarter in, clear of the keys and the play disc.
 */
export async function pointerOnPlayer(page: Page): Promise<void> {
  const box = await page.locator('media-container').first().boundingBox();
  if (!box) throw new Error('no player');
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.36);
  await expect.poll(() => page.locator('media-container').first().evaluate((el) => el.matches(':hover'))).toBe(true);
}

/**
 * Focus on the player itself, for a test that can't leave the pointer on it (a touch screen, or two frames that must
 * be identical): with focus in the player its character keys are its own.
 */
export async function focusPlayer(page: Page): Promise<void> {
  await page.evaluate(() => (document.querySelector('media-container') as HTMLElement).focus({ preventScroll: true }));
}

/** Moves the pointer over the picture, as a viewer does, so the controls show. */
export async function revealControls(page: Page): Promise<void> {
  const box = await page.locator('media-container').boundingBox();
  if (!box) throw new Error('no player');
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.3);
  await page.mouse.move(box.x + box.width * 0.52, box.y + box.height * 0.32);
  await expect(page.locator('media-container')).toHaveAttribute('data-controls-visible', '');
}

/**
 * Starts the film with the K key (a real gesture), lets it run a moment, then pauses it from script and seeks to
 * `time` with the frame painted.
 */
export async function startAndHold(page: Page, time: number): Promise<void> {
  // K is the player's while focus is in it or the pointer is over it (page-keys.ts); from the page, with neither,
  // Space is the key that still plays.
  const own = await page.evaluate(() => {
    const container = document.querySelector('media-container');
    return !!container && (container.matches(':hover') || container.contains(document.activeElement));
  });
  await page.keyboard.press(own ? 'k' : 'Space');
  await page.waitForFunction(() => {
    const video = document.querySelector('video') as HTMLVideoElement;
    return !video.paused && video.currentTime > 1.2;
  });
  await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).pause());
  await seekPainted(page, time);
  await expect(page.locator('media-container')).not.toHaveAttribute('data-fb-plate', /.*/);
  await expect(page.locator('media-container')).toHaveAttribute('data-controls-visible', '');
}

/** Seeks from script and waits until the new frame has been presented. */
export async function seekPainted(page: Page, time: number): Promise<void> {
  await page.evaluate(
    (t) =>
      new Promise<void>((resolve) => {
        const video = document.querySelector('video') as HTMLVideoElement & {
          requestVideoFrameCallback?: (cb: () => void) => number;
        };
        const done = () => requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        video.addEventListener(
          'seeked',
          () => {
            if (video.requestVideoFrameCallback) {
              let settled = false;
              video.requestVideoFrameCallback(() => {
                settled = true;
                done();
              });
              // A paused video may already show the frame and never call back.
              setTimeout(() => !settled && done(), 400);
            } else done();
          },
          { once: true },
        );
        video.currentTime = t;
      }),
    time,
  );
}

/** Attaches a measurement for the measure reporter (tests/e2e/support/measure-reporter.ts). */
export async function measure(testInfo: TestInfo, data: Record<string, unknown>): Promise<void> {
  await testInfo.attach('measure', { body: JSON.stringify(data), contentType: 'application/json' });
}

/** Records fullscreen requests instead of handing them to the OS (installed before the page loads). */
export const recordFullscreen = () => {
  const calls: string[] = [];
  (window as unknown as { __fullscreen: string[] }).__fullscreen = calls;
  const record = (name: string) =>
    function (this: Element) {
      calls.push(`${name}:${this.tagName.toLowerCase()}`);
      return Promise.resolve();
    };
  for (const name of ['requestFullscreen', 'webkitRequestFullscreen'] as const) {
    if (name in Element.prototype) Object.defineProperty(Element.prototype, name, { value: record(name), configurable: true });
  }
  const video = HTMLVideoElement.prototype as unknown as Record<string, unknown>;
  for (const name of ['webkitEnterFullscreen', 'webkitSetPresentationMode']) {
    if (name in video) Object.defineProperty(video, name, { value: record(name), configurable: true });
  }
};

/**
 * Waits until nothing in the page is mid-transition: the seek chip has folded away and every finite animation has
 * finished (the buffering spinner's infinite one doesn't count). Measurements taken mid-fade measure nothing real.
 */
export async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() => !document.querySelector('.fb-edge-chip[data-open]'));
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity),
  );
}
