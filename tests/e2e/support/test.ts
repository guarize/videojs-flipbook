import { test as base } from '@playwright/test';
import { silence } from './silence.mjs';

export { expect } from '@playwright/test';

/**
 * The battery's `test`: every browser context is silenced (silence.mjs) before a page can open in it, whether the
 * test takes the `page` or `context` fixture or makes its own with `browser.newContext()` or `browser.newPage()`.
 * Every spec imports `test` from here, never from `@playwright/test` (silence.spec.ts fails one that does).
 */
export const test = base.extend<object, { browser: import('@playwright/test').Browser }>({
  browser: [
    async ({ browser }, use) => {
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (options) => {
        const context = await newContext(options);
        await silence(context);
        return context;
      };
      // browser.newPage() makes a context of its own, inside Playwright: made here instead, closed with the page.
      browser.newPage = async (options) => {
        const context = await browser.newContext(options);
        const page = await context.newPage();
        page.once('close', () => void context.close().catch(() => undefined));
        return page;
      };
      await use(browser);
    },
    { scope: 'worker' },
  ],
  // Playwright's own `context` fixture makes its context inside the library, past the patch above.
  context: async ({ context }, use) => {
    await silence(context);
    await use(context);
  },
});
