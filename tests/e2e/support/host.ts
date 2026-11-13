import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page } from '@playwright/test';
import { featured, open, revealControls, settle, startAndHold } from './player';

/**
 * Someone else's page (apps/preview/host.html): the player mounted with the drop-in call into a page that is not
 * ours. `clean` is a quiet page; `hostile` adds the ordinary global CSS real sites ship (public/host/hostile.css).
 */
export interface Host {
  host: 'clean' | 'hostile';
  dir?: 'rtl';
  /** The root font size, px. */
  root?: number;
  zoom?: number;
  /** The `!important` snippets (public/host/important.css). */
  important?: boolean;
  /** The host's stylesheet arrives after the skin's. */
  late?: boolean;
  noskin?: boolean;
  /**
   * The page is built with Tailwind CSS 4 (support/tailwind-host.css: its four layers, preflight, the element rules
   * and the reaching utilities a project adds), its stylesheet before the skin's or after it.
   */
  tailwind?: 'before' | 'after';
  /** The Tailwind page in its dark scheme (`.dark` on the root). */
  dark?: boolean;
}

const TAILWIND = readFileSync(fileURLToPath(new URL('./tailwind-host.css', import.meta.url)), 'utf8');
/** The utilities the page's wrapper carries: each reaches inside whatever the wrapper holds, the player included. */
const TAILWIND_CLASSES = ['*:rounded-full', '[&_button]:opacity-50', '[&_svg]:size-8', '[&_*]:tracking-widest'];

export function hostUrl(options: Host): string {
  const query = new URLSearchParams({ host: options.host });
  if (options.dir) query.set('dir', options.dir);
  if (options.root) query.set('root', String(options.root));
  if (options.zoom) query.set('zoom', String(options.zoom));
  if (options.important) query.set('important', '');
  if (options.late) query.set('late', '');
  if (options.noskin) query.set('noskin', '');
  return `/host.html?${query}`;
}

/** Opens the host page with the player mounted and the host's stylesheet in. */
export async function openHost(page: Page, options: Host): Promise<void> {
  if (options.tailwind) {
    // Before the page's first byte is parsed: the sheet goes into the head as soon as there is one (ahead of the
    // skin's, which arrives with its module), and the wrapper takes its classes as soon as it exists.
    await page.addInitScript(({ css, classes, before, dark }) => {
      const style = document.createElement('style');
      style.textContent = css;
      style.dataset.tailwind = '';
      const settle = () => {
        if (dark) document.documentElement?.classList.add('dark');
        if (before && document.head && !style.isConnected) document.head.prepend(style);
        const wrapper = document.getElementById('content');
        if (wrapper && !wrapper.classList.contains(classes[0])) wrapper.classList.add(...classes);
        return !!wrapper && (style.isConnected || !before);
      };
      const watch = new MutationObserver(() => settle() && watch.disconnect());
      watch.observe(document, { childList: true, subtree: true });
      // (After the skin's: once the page is ready, see below.)
      (window as unknown as { __tailwind: HTMLStyleElement }).__tailwind = style;
    }, { css: TAILWIND, classes: TAILWIND_CLASSES, before: options.tailwind === 'before', dark: !!options.dark });
  }
  if (options.noskin) {
    await page.goto(featured(hostUrl(options)));
  } else {
    await open(page, hostUrl(options));
  }
  await expect(page.locator('html')).toHaveAttribute('data-host-ready', '');
  if (options.tailwind) {
    if (options.tailwind === 'after') await page.evaluate(() => document.head.append((window as unknown as { __tailwind: HTMLStyleElement }).__tailwind));
    // The guard's own guard: Tailwind's sheet is really in, and reaches the page (its `kbd` rule shows).
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('#outside kbd') as Element).boxShadow)).not.toBe('none');
  }
  if (options.host === 'hostile') {
    // The guard's own guard: the host's stylesheet is really in (a 404 would make every comparison pass).
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.querySelector('#outside kbd') as Element).boxShadow))
      .not.toBe('none');
  }
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

/** The states the comparison visits, each reached the way a viewer reaches it. */
export const STATES = ['rest', 'paused', 'hover', 'menu', 'shortcuts', 'contents'] as const;
export type State = (typeof STATES)[number];

/**
 * Nothing mid-flight, and nothing still arriving: the book's extras, its details, a hint and the storyboard come in
 * on idle after the page has settled, each changing a style or two. Still is three looks at every style, 400 ms
 * apart, alike.
 */
export async function calm(page: Page): Promise<void> {
  await settle(page);
  const looks: string[] = [];
  await expect
    .poll(
      async () => {
        looks.push((await census(page)).hashes.join());
        return looks.length >= 3 && looks.slice(-3).every((look) => look === looks.at(-1));
      },
      { intervals: [400], timeout: 15_000 },
    )
    .toBe(true);
}

/**
 * Brings the page to a state. States follow one another in STATES' order (each closes what the last opened), so both
 * pages take the same road.
 */
export async function reach(page: Page, state: State): Promise<void> {
  const container = page.locator('media-container');
  switch (state) {
    case 'rest':
      await page.mouse.move(2, 2);
      break;
    case 'paused':
      await container.evaluate((el: HTMLElement) => el.focus({ preventScroll: true }));
      await startAndHold(page, 20);
      await revealControls(page);
      break;
    case 'hover': {
      // A key under the pointer: its plate raised, its tooltip slip out.
      const key = page.locator('.fb-captions').first();
      await key.hover();
      await expect(page.locator('media-tooltip[data-open]').first()).toBeVisible();
      break;
    }
    case 'menu':
      await page.locator('.fb-settings').click();
      await expect(page.locator('#flipbook-settings')).toBeVisible();
      break;
    case 'shortcuts':
      await page.keyboard.press('Escape');
      await expect(page.locator('#flipbook-settings')).toBeHidden();
      await page.keyboard.press('?');
      await expect(page.locator('fb-keymap [role="dialog"]')).toBeVisible();
      break;
    case 'contents':
      await page.keyboard.press('Escape');
      await expect(page.locator('fb-keymap [role="dialog"]')).toBeHidden();
      await page.keyboard.press('t');
      await expect(page.locator('.fb-contents-page')).toBeVisible();
      break;
  }
  await calm(page);
}

/**
 * On the player's root, the properties (and their longhands) that are the skin's: the inherited ones, which run down
 * into it, and how it sizes, outlines and animates. The rest of the root's box is the host's (armour.css).
 */
const ROOT_OWNED = [
  'font', 'letter-spacing', 'word-spacing', 'text-transform', 'text-align', 'text-indent', 'text-shadow', 'text-rendering',
  'text-wrap', 'white-space', 'word-break', 'overflow-wrap', 'hyphens', 'line-break', 'line-height', 'tab-size', 'text-size-adjust',
  '-webkit-text-fill-color', '-webkit-text-stroke', '-webkit-font-smoothing', 'color', 'cursor', 'list-style', 'quotes',
  'caret-color', 'accent-color', 'color-scheme', 'writing-mode', 'text-orientation', 'image-rendering', 'scrollbar-color',
  'box-sizing', 'margin', 'overflow', 'clip-path', 'outline', 'transition', 'animation', 'direction', 'display', 'position', 'container',
];

export interface Census {
  /** One entry per element, in document order: its signature, and a hash for itself, its ::before and its ::after. */
  signatures: string[];
  hashes: number[];
  properties: number;
}

/**
 * Every element of the skin (and of its parts that stand in the page: the mini player's keys, the waiting page; not
 * the mini player's slot, an empty box that holds the player's place in the host's own flow),
 * each with a hash of every computed property and its box, and the same for its ::before and ::after.
 */
export const census = (page: Page): Promise<Census> =>
  page.evaluate((OWNED) => {
    const names = Array.from(getComputedStyle(document.documentElement)).filter((name) => !name.startsWith('--'));
    // The player's own box is the host's to style (a border, a shadow, a margin): on the root, what is the skin's is
    // what runs down into it, and its box as laid out.
    const inherited = names.filter((name) => OWNED.some((own) => name === own || name.startsWith(`${own}-`)));
    const hash = (text: string) => {
      let h = 2166136261;
      for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
      return h >>> 0;
    };
    const roots = [...document.querySelectorAll<HTMLElement>('.media-skin[data-preset], .fb-float-bar, .fb-pip-page')];
    const elements = roots.flatMap((root) => [root, ...root.querySelectorAll<HTMLElement>('*')]);
    // Not the page's state: how much of the film has loaded (the network's), and the announcer's line, said to a
    // screen reader and cleared on a timer.
    // Nor the hidden preview's chapter title, shown or not by whether the pointer has yet crossed the slider.
    const network = (el: Element) =>
      el.matches('.fb-edge-buffer, media-slider-buffer, media-status-announcer, media-status-announcer *, media-time-slider-chapter-title');
    // Nor the cursor of an element with no box (inside something not displayed): there is nothing of it for a pointer
    // to be over, and WebKit answers a value it inherited some time ago (seen twice, 0 pixels apart: `grab` for
    // `auto`, and `not-allowed`, from before the film had its length, for `pointer`, under a parent that read right).
    const boxed = names.filter((name) => name !== 'cursor');
    const signatures: string[] = [];
    const hashes: number[] = [];
    for (const el of elements) {
      const classes = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
      signatures.push(`${el.tagName.toLowerCase()}${classes}`);
      for (const pseudo of [null, '::before', '::after']) {
        const style = getComputedStyle(el, pseudo);
        if (network(el) || (pseudo && (style.content === 'none' || style.content === 'normal'))) {
          hashes.push(0);
          continue;
        }
        const rect = pseudo ? null : el.getBoundingClientRect();
        const box = rect ? [rect.x, rect.y, rect.width, rect.height].map((n) => Math.round(n * 100) / 100).join(',') : '';
        const list = !pseudo && el.matches('.media-skin[data-preset]') ? inherited : el.checkVisibility() ? names : boxed;
        hashes.push(hash(`${list.map((name) => style.getPropertyValue(name)).join('|')}#${box}`));
      }
    }
    return { signatures, hashes, properties: names.length };
  }, ROOT_OWNED);

/** Every computed property and the box of the elements at these census positions (index * 3 + pseudo). */
const details = (page: Page, slots: number[]): Promise<Record<string, string>[]> =>
  page.evaluate(({ wanted, OWNED }) => {
    const names = Array.from(getComputedStyle(document.documentElement)).filter((name) => !name.startsWith('--'));
    const roots = [...document.querySelectorAll<HTMLElement>('.media-skin[data-preset], .fb-float-bar, .fb-pip-page')];
    const elements = roots.flatMap((root) => [root, ...root.querySelectorAll<HTMLElement>('*')]);
    return wanted.map((slot) => {
      const el = elements[Math.floor(slot / 3)];
      const pseudo = [null, '::before', '::after'][slot % 3];
      const style = getComputedStyle(el, pseudo);
      const out: Record<string, string> = {};
      const root = !pseudo && el.matches('.media-skin[data-preset]');
      const unboxed = !el.checkVisibility();
      for (const name of names) {
        if (unboxed && name === 'cursor') continue;
        if (!root || OWNED.some((own) => name === own || name.startsWith(`${own}-`))) out[name] = style.getPropertyValue(name);
      }
      if (!pseudo) {
        const rect = el.getBoundingClientRect();
        out['(box)'] = [rect.x, rect.y, rect.width, rect.height].map((n) => Math.round(n * 100) / 100).join(',');
      }
      return out;
    });
  }, { wanted: slots, OWNED: ROOT_OWNED });

export interface Difference {
  element: string;
  property: string;
  clean: string;
  hostile: string;
}

export interface Comparison {
  elements: number;
  properties: number;
  /** Elements (or pseudo-elements) whose computed style or box differs. */
  differing: number;
  /** The first differences, one per element signature and property. */
  differences: Difference[];
  /** How many differing elements per signature. */
  bySignature: Record<string, number>;
}

/**
 * The same value but for a pixel: the deck places its cards, the curl sizes its page and the jacket sets its plate
 * from boxes measured in script, and two loads of one page measure them a fraction of a pixel apart, which a rounded
 * value turns into a whole one.
 */
function close(one: string, two: string): boolean {
  const number = /-?\d*\.?\d+(?:e-?\d+)?/g;
  if (one.replace(number, '#') !== two.replace(number, '#')) return false;
  const [x, y] = [one.match(number) ?? [], two.match(number) ?? []];
  return x.every((value, index) => Math.abs(Number(value) - Number(y[index])) <= 1);
}

/** Compares every computed style and box of the skin on two pages standing in the same state. */
export async function compareStyles(clean: Page, hostile: Page, limit = 40): Promise<Comparison> {
  let [a, b] = await Promise.all([census(clean), census(hostile)]);
  let slots: number[] = [];
  // A difference that is real is still there a moment later; one caught mid-frame (a canvas repainting, a class on
  // its way) is not. Three looks, 250 ms apart.
  for (let look = 0; look < 3; look++) {
    const same = a.signatures.length === b.signatures.length && a.signatures.every((signature, index) => signature === b.signatures[index]);
    slots = [];
    if (same) for (let i = 0; i < a.hashes.length; i++) if (a.hashes[i] !== b.hashes[i]) slots.push(i);
    if ((same && !slots.length) || look === 2) break;
    await clean.waitForTimeout(250);
    [a, b] = await Promise.all([census(clean), census(hostile)]);
  }
  expect(b.signatures, 'the two pages hold the same elements, in the same order').toEqual(a.signatures);
  const bySignature: Record<string, number> = {};
  const name = (slot: number) => `${a.signatures[Math.floor(slot / 3)]}${['', '::before', '::after'][slot % 3]}`;
  // Past this many, the page is plainly broken: one of each signature is enough to say how.
  const DETAILED = 400;
  let sample = slots;
  if (slots.length > DETAILED) {
    const seen = new Set<string>();
    sample = slots.filter((slot) => !seen.has(name(slot)) && seen.add(name(slot))).slice(0, limit);
    for (const slot of slots) bySignature[name(slot)] = (bySignature[name(slot)] ?? 0) + 1;
  }
  const [da, db] = await Promise.all([details(clean, sample), details(hostile, sample)]);
  const differences: Difference[] = [];
  let differing = slots.length > DETAILED ? slots.length : 0;
  sample.forEach((slot, index) => {
    let own = 0;
    for (const property of Object.keys(da[index])) {
      if (da[index][property] !== db[index][property] && !close(da[index][property], db[index][property])) {
        own++;
        differences.push({ element: name(slot), property, clean: da[index][property], hostile: db[index][property] });
      }
    }
    if (own && slots.length <= DETAILED) {
      differing++;
      bySignature[name(slot)] = (bySignature[name(slot)] ?? 0) + 1;
    }
  });
  return { elements: a.signatures.length, properties: a.properties, differing, differences, bySignature };
}

/** A line per difference, for a failure's message and the report. */
export const describe = (comparison: Comparison, lines = 60): string =>
  [
    `${comparison.differing} of ${comparison.elements * 3} element and pseudo-element styles differ (${comparison.properties} properties each)`,
    ...Object.entries(comparison.bySignature)
      .sort((x, y) => y[1] - x[1])
      .slice(0, 25)
      .map(([signature, count]) => `  ${count} × ${signature}`),
    ...comparison.differences.slice(0, lines).map((d) => `  ${d.element} { ${d.property}: ${d.clean} → ${d.hostile} }`),
  ].join('\n');

export interface PixelDiff {
  width: number;
  height: number;
  /** Pixels where any channel differs by more than the tolerance. */
  differing: number;
  share: number;
  /** The differing pixels' bounding box, or null. */
  box: { x: number; y: number; width: number; height: number } | null;
}

export interface Mask {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * What is left out of a comparison of pixels, within the player's box: where the fore-edge draws how much of the film
 * has loaded (the network's state, as it is left out of the comparison of styles), and the page showing outside the
 * frame's rounded corners.
 */
export const networkMasks = (page: Page, capture: Buffer): Promise<Mask[]> =>
  page.evaluate((width) => {
    const container = document.querySelector('media-container') as HTMLElement;
    const frame = container.getBoundingClientRect();
    // The capture's pixels per unit of the page's boxes: 1, or the page's zoom.
    const k = width / frame.width;
    const buffers = [...document.querySelectorAll('.fb-edge-buffer, media-slider-buffer')].map((el) => {
      const rect = el.getBoundingClientRect();
      return { x: Math.floor((rect.x - frame.x) * k) - 4, y: Math.floor((rect.y - frame.y) * k) - 4, width: Math.ceil(rect.width * k) + 8, height: Math.ceil(rect.height * k) + 8 };
    });
    // Outside the frame's rounded corners is the page, not the player (a host's focus glow around it shows there).
    const r = Math.ceil((parseFloat(getComputedStyle(container).borderTopLeftRadius) || 0) * Math.max(k, 1)) + 1;
    const [w, h] = [Math.round(frame.width * k), Math.round(frame.height * k)];
    const corners = [
      { x: 0, y: 0, width: r, height: r },
      { x: w - r, y: 0, width: r, height: r },
      { x: 0, y: h - r, width: r, height: r },
      { x: w - r, y: h - r, width: r, height: r },
    ];
    // Zoomed, the frame's edges fall between device pixels: the outermost row and column are half the page's.
    const edges =
      k === 1
        ? []
        : [
            { x: 0, y: 0, width: w + 1, height: 1 },
            { x: 0, y: h - 1, width: w + 1, height: 2 },
            { x: 0, y: 0, width: 1, height: h + 1 },
            { x: w - 1, y: 0, width: 2, height: h + 1 },
          ];
    return [...buffers, ...corners, ...edges];
  }, capture.readUInt32BE(16));

/**
 * Where the cover's title plate and play disc stand, with a pixel around them, when the two pages placed them a
 * pixel apart. The jacket sets both by `translate` from boxes it measures in script, and one page lands the plate on
 * 163 px or 164 px from one load to the next (8 loads: 5 and 3; open, the cover's): the same picture a pixel up is
 * not something the host did. The styles' comparison allows that pixel too (`close`).
 */
export async function jacketMasks(one: Page, two: Page, capture: Buffer): Promise<Mask[]> {
  const read = (page: Page) =>
    page.evaluate((width) => {
      const container = document.querySelector('media-container') as HTMLElement;
      const frame = container.getBoundingClientRect();
      const k = width / frame.width;
      const parts = [...container.querySelectorAll<HTMLElement>('.fb-jacket-plate, .fb-cover-play')].filter((el) => el.getClientRects().length);
      return {
        placed: parts.map((el) => el.style.translate).join('|'),
        boxes: parts.map((el) => {
          const rect = el.getBoundingClientRect();
          return { x: Math.floor((rect.x - frame.x) * k) - 3, y: Math.floor((rect.y - frame.y) * k) - 3, width: Math.ceil(rect.width * k) + 6, height: Math.ceil(rect.height * k) + 6 };
        }),
      };
    }, capture.readUInt32BE(16));
  const [a, b] = [await read(one), await read(two)];
  return a.placed === b.placed ? [] : [...a.boxes, ...b.boxes];
}

/** The player's box as a PNG, the caret and any running transition out of the picture. */
export const shoot = (player: Locator): Promise<Buffer> => player.screenshot({ animations: 'disabled', caret: 'hide', scale: 'css' });

/**
 * Counts the pixels that differ between two captures of the player. Decoded and compared in a page (no image library
 * in the repo). `tolerance` is per channel, of 255: decoders dither a video frame by a level or two.
 */
export const pixelDiff = (page: Page, a: Buffer, b: Buffer, masks: Mask[] = [], tolerance = 8): Promise<PixelDiff> =>
  page.evaluate(
    async ({ one, two, masks, tolerance }) => {
      const decode = async (base64: string) => {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, bitmap.width, bitmap.height);
      };
      const [x, y] = [await decode(one), await decode(two)];
      if (x.width !== y.width || x.height !== y.height) {
        return { width: x.width, height: x.height, differing: x.width * x.height, share: 1, box: { x: 0, y: 0, width: y.width, height: y.height } };
      }
      let differing = 0;
      let [left, top, right, bottom] = [x.width, x.height, -1, -1];
      for (let i = 0; i < x.data.length; i += 4) {
        const col = (i / 4) % x.width;
        const row = Math.floor(i / 4 / x.width);
        if (masks.some((m) => col >= m.x && col < m.x + m.width && row >= m.y && row < m.y + m.height)) continue;
        if (
          Math.abs(x.data[i] - y.data[i]) > tolerance ||
          Math.abs(x.data[i + 1] - y.data[i + 1]) > tolerance ||
          Math.abs(x.data[i + 2] - y.data[i + 2]) > tolerance
        ) {
          differing++;
          const px = (i / 4) % x.width;
          const py = Math.floor(i / 4 / x.width);
          left = Math.min(left, px);
          right = Math.max(right, px);
          top = Math.min(top, py);
          bottom = Math.max(bottom, py);
        }
      }
      return {
        width: x.width,
        height: x.height,
        differing,
        share: differing / (x.width * x.height),
        box: differing ? { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } : null,
      };
    },
    { one: a.toString('base64'), two: b.toString('base64'), masks, tolerance },
  );
