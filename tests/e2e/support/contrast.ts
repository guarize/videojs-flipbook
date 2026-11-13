import type { Page } from '@playwright/test';

/**
 * Contrast measured the way the standard asks: on the composited pixels behind each element, not on tokens. Every
 * visible text run and icon in the player is marked, a screenshot is taken with all of them made transparent (so the
 * ground is exactly what the browser composited under them: the board, a keycap, a caption's backing, the film), and
 * each element's own colour, with its alpha and its ancestors' opacity, is composited over every ground pixel in its
 * box. The worst pixel decides.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Candidate {
  kind: 'text' | 'icon';
  label: string;
  color: [number, number, number, number];
  rects: Box[];
  size: number;
  weight: number;
  large: boolean;
  caption: boolean;
}

export interface Result {
  kind: 'text' | 'large' | 'graphics' | 'boundary';
  label: string;
  ratio: number;
  p5: number;
  pixels: number;
  caption: boolean;
  size: number;
  ground: string;
  color: string;
}

/** Marks every visible text run and icon in the player and returns what to measure. Runs in the page. */
export function markCandidates(): { candidates: Candidate[]; skipped: string[] } {
  const root = document.querySelector('media-container') as HTMLElement;
  const canvas = new OffscreenCanvas(1, 1);
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
  // Any CSS colour (oklch, color-mix, …) normalised by the browser itself.
  const rgba = (css: string): [number, number, number, number] => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = 'rgba(0, 0, 0, 0)';
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const opacity = (el: Element) => {
    let o = 1;
    for (let n: Element | null = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
    return o;
  };
  const hiddenAway = (el: Element) => {
    for (let n: Element | null = el; n && n !== root; n = n.parentElement) {
      const cs = getComputedStyle(n);
      const r = n.getBoundingClientRect();
      if (cs.clip.startsWith('rect(') || /inset\(50%/.test(cs.clipPath)) return true;
      if (cs.overflow !== 'visible' && (r.width <= 2 || r.height <= 2)) return true;
    }
    return false;
  };
  const visible = (el: Element) =>
    el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && !el.closest('[inert], [hidden]') && !hiddenAway(el);
  const name = (el: Element) => {
    const control = el.closest('[aria-label], button, [role]');
    const cls = (el.closest('[class]')?.getAttribute('class') ?? '').split(/\s+/).filter((c) => c.startsWith('fb-') || c.startsWith('media-')).slice(-1)[0] ?? el.tagName.toLowerCase();
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 28);
    const owner = control?.getAttribute('aria-label');
    return `${text || owner || '(icon)'} · .${cls}${owner && text ? ` in "${owner.slice(0, 28)}"` : ''}`;
  };
  const inView = (r: DOMRect) => r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;

  const candidates: Candidate[] = [];
  const skipped: string[] = [];

  // Text: every element that holds a visible text run.
  const runs = new Map<Element, Text[]>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (!n.data.trim() || !n.parentElement) continue;
    if (n.parentElement.closest('script, style, template, video, track')) continue;
    const list = runs.get(n.parentElement) ?? [];
    list.push(n);
    runs.set(n.parentElement, list);
  }
  const range = document.createRange();
  for (const [el, nodes] of runs) {
    if (!visible(el)) continue;
    const rects: Box[] = [];
    for (const node of nodes) {
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) if (r.width >= 3 && r.height >= 6 && inView(r)) rects.push({ x: r.x, y: r.y, w: r.width, h: r.height });
    }
    if (!rects.length) continue;
    const cs = getComputedStyle(el);
    const color = rgba(cs.webkitTextFillColor || cs.color);
    color[3] *= opacity(el);
    if (color[3] < 0.05) {
      skipped.push(`${name(el)} (transparent text: gradient or clipped fill)`);
      continue;
    }
    const size = parseFloat(cs.fontSize);
    const weight = Number(cs.fontWeight) || 400;
    el.setAttribute('data-audit', 'text');
    candidates.push({
      kind: 'text',
      label: name(el),
      color,
      rects,
      size,
      weight,
      large: size >= 24 || (size >= 18.66 && weight >= 700),
      caption: !!el.closest('fb-captions, .fb-captions-lines'),
    });
  }

  // Icons: every visible stroked or filled SVG in the player.
  for (const svg of root.querySelectorAll('svg')) {
    if (!visible(svg)) continue;
    const r = svg.getBoundingClientRect();
    if (r.width < 8 || r.height < 8 || !inView(r)) continue;
    const shape = svg.querySelector('path, circle, rect, line, polyline, polygon, ellipse') ?? svg;
    const cs = getComputedStyle(shape);
    const paint = cs.stroke && cs.stroke !== 'none' ? cs.stroke : cs.fill;
    const color = rgba(paint);
    color[3] *= opacity(shape);
    if (color[3] < 0.05) continue;
    svg.setAttribute('data-audit', 'icon');
    candidates.push({ kind: 'icon', label: name(svg), color, rects: [{ x: r.x, y: r.y, w: r.width, h: r.height }], size: r.height, weight: 0, large: false, caption: false });
  }
  return { candidates, skipped };
}

/** Hides what was marked, without moving anything, so the screenshot shows only the ground. */
export const HIDE = `
[data-audit="text"], [data-audit="text"] * { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; transition: none !important; }
[data-audit="icon"] { visibility: hidden !important; transition: none !important; }
`;

/** Composites each candidate over its ground pixels and returns the ratios. Runs in the page. */
export async function analyse(args: {
  png: string;
  candidates: Candidate[];
  thumb: { box: Box; edge: string; across: boolean } | null;
}): Promise<Result[]> {
  const bytes = Uint8Array.from(atob(args.png), (c) => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
  ctx.drawImage(bitmap, 0, 0);
  const img = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
  const scale = bitmap.width / innerWidth;
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const lum = (r: number, g: number, b: number) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const ratioOf = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  const pixels = function* (box: Box) {
    // One CSS pixel in from each side, so anti-aliased box edges don't count as ground.
    const x0 = Math.max(0, Math.ceil((box.x + 1) * scale));
    const y0 = Math.max(0, Math.ceil((box.y + 1) * scale));
    const x1 = Math.min(bitmap.width, Math.floor((box.x + box.w - 1) * scale));
    const y1 = Math.min(bitmap.height, Math.floor((box.y + box.h - 1) * scale));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) yield (y * bitmap.width + x) * 4;
  };

  const results: Result[] = [];
  for (const c of args.candidates) {
    const [cr, cg, cb, a] = c.color;
    const ratios: { ratio: number; i: number; t: [number, number, number] }[] = [];
    for (const rect of c.rects) {
      for (const i of pixels(rect)) {
        const g = [img[i], img[i + 1], img[i + 2]];
        const t: [number, number, number] = [cr * a + g[0] * (1 - a), cg * a + g[1] * (1 - a), cb * a + g[2] * (1 - a)];
        ratios.push({ ratio: ratioOf(lum(...t), lum(g[0], g[1], g[2])), i, t });
      }
    }
    if (!ratios.length) continue;
    ratios.sort((p, q) => p.ratio - q.ratio);
    const worst = ratios[0];
    results.push({
      kind: c.kind === 'icon' ? 'graphics' : c.large ? 'large' : 'text',
      label: c.label,
      ratio: Math.round(worst.ratio * 100) / 100,
      p5: Math.round(ratios[Math.floor(ratios.length * 0.05)].ratio * 100) / 100,
      pixels: ratios.length,
      caption: c.caption,
      size: c.size,
      ground: hex(img[worst.i], img[worst.i + 1], img[worst.i + 2]),
      color: `${hex(cr, cg, cb)}${a < 1 ? ` @${a.toFixed(2)}` : ''}`,
    });
  }

  // The playhead's boundary: its edge (printed in the cover's lettering colour, so ink on a paper binding) against
  // the board just above the fore-edge, where it stands clear.
  //
  // On a phone the edge is a strip 30 px thick in the pad and the ribbon lies across its pages, so there is no board
  // beside it: its neighbours are the pages before it (read, the accent) and after it (gilt). There its paper is
  // measured against what is drawn right beside it, the two pixels next to each side (a line on a fractional position
  // is spread over two): the better of the two per row, the worst row deciding.
  if (args.thumb) {
    const { box, edge, across } = args.thumb;
    const m = edge.match(/\d+(\.\d+)?/g)?.map(Number) ?? [255, 255, 255];
    const lp = lum(m[0], m[1], m[2]);
    let worst = { ratio: Infinity, i: 0 };
    let n = 0;
    if (across) {
      // The ribbon is 16 px wide in the middle of its 24 px box (4 px in at each side), with an ink line down each.
      for (const side of [box.x + 4 - 2, box.x + box.w - 4]) {
        for (let y = Math.ceil(box.y + 8); y < Math.floor(box.y + box.h - 10); y++) {
          let best = { ratio: 0, i: 0 };
          for (const x of [Math.round(side), Math.round(side) + 1]) {
            const i = (Math.round(y * scale) * bitmap.width + Math.round(x * scale)) * 4;
            if (i < 0 || i + 2 >= img.length) continue;
            const r = ratioOf(lp, lum(img[i], img[i + 1], img[i + 2]));
            if (r > best.ratio) best = { ratio: r, i };
          }
          if (!best.ratio) continue;
          n++;
          if (best.ratio < worst.ratio) worst = best;
        }
      }
    } else {
      for (const i of pixels({ x: box.x, y: box.y - 4, w: box.w, h: 4 })) {
        n++;
        const r = ratioOf(lp, lum(img[i], img[i + 1], img[i + 2]));
        if (r < worst.ratio) worst = { ratio: r, i };
      }
    }
    if (n) {
      results.push({
        kind: 'boundary',
        label: 'playhead (its edge) · .media-time-slider-thumb',
        ratio: Math.round(worst.ratio * 100) / 100,
        p5: Math.round(worst.ratio * 100) / 100,
        pixels: n,
        caption: false,
        size: box.h,
        ground: hex(img[worst.i], img[worst.i + 1], img[worst.i + 2]),
        color: hex(m[0], m[1], m[2]),
      });
    }
  }
  return results;
}

/** Marks, hides, screenshots the ground, restores, and measures. */
export async function measureContrast(page: Page) {
  const { candidates, skipped } = await page.evaluate(markCandidates);
  const thumb = await page.evaluate(() => {
    const el = document.querySelector('.media-time-slider-thumb');
    if (!el || !el.checkVisibility()) return null;
    const r = el.getBoundingClientRect();
    const across = !!el.closest('media-container')?.hasAttribute('data-fb-hand');
    return { box: { x: r.x, y: r.y, w: r.width, h: r.height }, edge: getComputedStyle(el, '::after').backgroundColor, across };
  });
  const style = await page.addStyleTag({ content: HIDE });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const ground = await page.screenshot({ animations: 'disabled', caret: 'hide' });
  await style.evaluate((node) => node.remove());
  await page.evaluate(() => document.querySelectorAll('[data-audit]').forEach((el) => el.removeAttribute('data-audit')));
  const results = await page.evaluate(analyse, { png: ground.toString('base64'), candidates, thumb });
  return { results, skipped, ground };
}
