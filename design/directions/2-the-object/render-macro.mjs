// The fore-edge macro the site ships (apps/preview/public/book/macro.webp): the CSS book of index.html#macrosrc
// rendered at 3× (a 4500 × 3000 picture), cropped to 3450 × 1710 from (900, 750) and scaled to 2300 × 1140.
// `python3 make-assets.py` first (the edge and the cover, from the film's frames and poster), then
// `node design/directions/2-the-object/render-macro.mjs` from the repo's root (needs ffmpeg and cwebp on the PATH).
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../../package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const out = fileURLToPath(new URL('../../../apps/preview/public/book/macro.webp', import.meta.url));

const browser = await chromium.launch({ args: ['--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 3 });
await page.goto(`${new URL('index.html', import.meta.url).href}#macrosrc`);
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(400);
await page.locator('.macro-src').screenshot({ path: here('assets/macro.png') });
await browser.close();

execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', here('assets/macro.png'), '-vf', 'crop=3450:1710:900:750,scale=2300:1140:flags=lanczos', '-frames:v', '1', here('assets/macro-crop.png')], { stdio: 'inherit' });
execFileSync('cwebp', ['-quiet', '-q', '80', '-m', '6', here('assets/macro-crop.png'), '-o', out], { stdio: 'inherit' });
rmSync(here('assets/macro-crop.png'));
