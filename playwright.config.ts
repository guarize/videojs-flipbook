import { defineConfig, devices } from '@playwright/test';

/**
 * The browser battery runs against a production build: `pnpm run build` first (its own step, never inside the
 * server's timer), then `pnpm run test:e2e`, which only previews dist/ on PORT. BASE_URL points it at a deployed copy
 * instead, with no local server.
 *
 * Chromium and WebKit, and Firefox when asked for (`FB_FIREFOX=1`): off by default, so the gate's budget is what
 * it was. Firefox makes no sound whatever a page does (its own volume at nothing).
 *
 * On Pedro's Mac Firefox will not start as it is: the Mac refuses the folder Firefox keeps its list of profiles in
 * (`~/Library/Application Support/Firefox`: "Operation not permitted"), and Firefox answers "Could not find profile
 * folder". Give it a home of its own for the run: `CFFIXED_USER_HOME=<an empty folder> FB_FIREFOX=1 pnpm exec
 * playwright test --project=firefox`.
 *
 * Two workers, one browser each, no video (recording took the Mac down for RAM once), traces kept only on failure.
 */
const PORT = 4410;
const LOCAL = `http://127.0.0.1:${PORT}`;
const viewport = { width: 1280, height: 800 };

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results',
  globalSetup: './tests/e2e/support/global-setup.ts',
  fullyParallel: true,
  workers: 2,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 60_000,
  reporter: [['list'], ['./tests/e2e/support/measure-reporter.ts']],
  use: {
    baseURL: process.env.BASE_URL ?? LOCAL,
    viewport,
    deviceScaleFactor: 1,
    trace: 'retain-on-failure',
    video: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport,
        deviceScaleFactor: 1,
        // Never play sound from an automated browser, headed or not.
        launchOptions: { args: ['--mute-audio'] },
      },
    },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport, deviceScaleFactor: 1 } },
    ...(process.env.FB_FIREFOX === '1'
      ? [
          {
            name: 'firefox',
            use: {
              ...devices['Desktop Firefox'],
              viewport,
              deviceScaleFactor: 1,
              // No sound, and none of Firefox's own "Pop out this video" button: it comes over the film under a
              // pointer, 189 px wide at first use, and is no part of the skin's pixels (hostile.spec.ts compares them).
              launchOptions: { firefoxUserPrefs: { 'media.volume_scale': '0.0', 'media.videocontrols.picture-in-picture.video-toggle.enabled': false } },
            },
          },
        ]
      : []),
  ],
  webServer: process.env.BASE_URL
    ? undefined
    : {
        command: `pnpm exec vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
        url: LOCAL,
        reuseExistingServer: !process.env.CI,
        timeout: 15_000,
      },
});
