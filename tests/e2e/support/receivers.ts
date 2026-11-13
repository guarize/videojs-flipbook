import type { Page } from '@playwright/test';

/**
 * The browser's own word on receivers (AirPlay, Cast), given when a test says so: no receiver is needed, and nothing
 * is forced on the keys themselves. Call it before the page opens, and `arrive` when a receiver comes or goes.
 *
 * - WebKit says it with `webkitplaybacktargetavailabilitychanged` on the film: sent here.
 * - Chromium says it through the callback the player hands to `remote.watchAvailability`: kept here, answered first
 *   with "none" as Chrome answers it, and called again by `arrive`. (Video.js gives the Cast key only where
 *   `window.chrome` is.)
 * - `both`: a browser that offers both keys, which no real one does, for a test that looks at the two of them in each
 *   engine's own drawing. WebKit is told it is Chrome too (`window.chrome`), and Chromium that it has AirPlay
 *   (`WebKitPlaybackTargetAvailabilityEvent`, the one thing Video.js asks of a browser before it offers the key).
 */
export async function receivers(page: Page, { both = false } = {}): Promise<void> {
  await page.addInitScript((both) => {
    const w = window as unknown as {
      chrome?: object;
      WebKitPlaybackTargetAvailabilityEvent?: unknown;
      __answers: ((available: boolean) => void)[];
      __arrive: (available: boolean) => void;
    };
    w.__answers = [];
    if ('webkitShowPlaybackTargetPicker' in HTMLVideoElement.prototype) {
      if (both) w.chrome ??= {};
    } else if ('RemotePlayback' in window) {
      w.chrome ??= {};
      if (both) w.WebKitPlaybackTargetAvailabilityEvent ??= Event;
      RemotePlayback.prototype.watchAvailability = function (callback) {
        w.__answers.push(callback as (available: boolean) => void);
        queueMicrotask(() => callback(false));
        return Promise.resolve(1);
      };
    }
    w.__arrive = (available) => {
      const video = document.querySelector('video:not(.fb-stand)') as HTMLVideoElement;
      if ('webkitShowPlaybackTargetPicker' in video) video.dispatchEvent(Object.assign(new Event('webkitplaybacktargetavailabilitychanged'), { availability: available ? 'available' : 'not-available' }));
      else for (const answer of w.__answers) answer(available);
    };
  }, both);
}

/** A receiver comes (`true`) or goes. */
export const arrive = (page: Page, available: boolean) => page.evaluate((on) => (window as unknown as { __arrive: (available: boolean) => void }).__arrive(on), available);
