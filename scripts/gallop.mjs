/**
 * The riffle chapter's flipbook: Muybridge's gallop, cut from the photograph itself. The source is the cabinet card
 * "The Horse in Motion" (1878, public domain; the Library of Congress's scan from Wikimedia Commons, 5694 × 3510),
 * kept in `media-src/gallop/`: the JPEG is git-ignored, its record `horse-in-motion.meta.json` is tracked. The card
 * prints twelve photographs four by three. The first eleven are one stride; the twelfth, the horse standing, is not
 * used.
 *
 * Each photograph is found between the card's black gutters, then laid on the others by measurement, at the card's
 * full resolution:
 *
 * - Up and down, turn and size, on its ruled ground. The line over the numbers and the track's first three lines are
 *   found in eight strips across the photograph, each to a fraction of a pixel, and a rotation, one scale and a shift
 *   put them where the eleven have them in common. As printed the photographs differ by up to 0.8° and 0.9 %.
 * - Left and right, on the horse: each silhouette goes where it covers the other ten most. The vertical lines cannot
 *   place it: measured against them the horse stands up to 52 px (of the sprite's 720) further on or back from one
 *   photograph to the next, so holding them still would make the horse lurch. They are left to pass behind it.
 *
 * One window, the largest all eleven fill under the line over the numbers, is then drawn at 720 × 462 with a Lanczos
 * filter. Measured on the sprite, from one frame to the next the track's lines move 0.1 px at most at their middle
 * and under 1 px at the worst place along them, and the horse's centre moves 8 px sideways at most. On the sprite
 * this replaces, cut from a film of the card, those were 5.6 px, 6.3 px and 20 px. The script prints each
 * photograph's turn, scale and shift, and what is left on its track.
 *
 * Exposure, then tone. Each frame's ink and paper (the medians of its dark and of its light pixels) are put on the
 * same two levels. Then its paper, in 8 × 5 zones, is put on the eleven's mean for each zone: the paper of a twelfth of
 * the frame then differs by 6 levels of 255 at most across the eleven (31 without this), and what the photographs
 * share stays. Ink and paper take the colours of the film's second chapter, which prints these photographs in sepia:
 * paper 197 181 155 and ink 38 31 24 (sRGB), the medians of a patch of each in seven of its frames, 0:22.5 to 0:30.5.
 * The grain is the photograph's: no step sharpens or smooths it.
 *
 * Written once, as assets, so the page neither crops nor decodes per frame:
 *
 * - `book/gallop/sprite.webp`: 4 × 3 cells of 720 × 462, photographs 1–11 in reading order (the twelfth cell is the
 *   first again, so the sheet has no empty cell);
 * - `book/gallop/still.webp`: the first alone, shown until the sprite has decoded and under reduced motion.
 *
 * Usage (needs ffmpeg, ffprobe and cwebp on the PATH):
 *   node scripts/gallop.mjs                 both files, from media-src/gallop/horse-in-motion.jpg
 *   node scripts/gallop.mjs --from <folder> the same, after copying the photograph and its record in from there
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const src = (name) => repo(`media-src/gallop/${name}`);
const out = (name) => repo(`apps/preview/public/book/gallop/${name}`);
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 26 });

const CARD = 'horse-in-motion.jpg';
const COMMONS = 'https://commons.wikimedia.org/wiki/File:The_Horse_in_Motion_high_res.jpg';
/** The card's grid, the photographs used, and the sprite's cell (scenes.ts: FLIP). */
const GRID = { cols: 4, rows: 3, frames: 11 };
const CELL = { w: 720, h: 462 };
/** The film's sepia: its paper and its ink, sRGB. */
const PAPER = [197, 181, 155];
const INK = [38, 31, 24];
/** Card pixels left out round each photograph, where the gutter's edge shades it. */
const EDGE = 14;
/** The strips a photograph's ruled lines are measured in. */
const STRIPS = 8;
/**
 * Card pixels from the line over the numbers: the window starts `under` it (the gutter cuts through it in the first
 * photograph, so it is left out of all); the horse is looked for from `top` below it to `bottom` above the track.
 */
const BAND = { under: 9, top: 60, bottom: 8 };
/** The zones a frame's paper is levelled in. */
const ZONES = { cols: 8, rows: 5 };

const from = process.argv.includes('--from') ? process.argv[process.argv.indexOf('--from') + 1] : undefined;
if (from) {
  for (const name of [CARD, 'horse-in-motion.meta.json']) copyFileSync(`${from.replace(/\/$/, '')}/${name}`, src(name));
}
if (!existsSync(src(CARD))) {
  console.error(`${src(CARD)} is missing.\nIt is the original file of ${COMMONS} (5694 × 3510).\nSave it there, or pass --from <folder>.`);
  process.exit(1);
}

const probe = ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', src(CARD)];
const [W, H] = run('ffprobe', probe).toString().trim().split(',').map(Number);
const card = run('ffmpeg', ['-v', 'error', '-i', src(CARD), '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);

const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;
const median = (values) => {
  const sorted = Float64Array.from(values).sort();
  return sorted[sorted.length >> 1];
};

/** The n spaces between the n + 1 dark bands of a profile: the photographs between the card's gutters. */
function between(profile, n) {
  const bands = [];
  for (let i = 0, start = -1; i <= profile.length; i++) {
    const dark = i < profile.length && profile[i] < 60;
    if (dark && start < 0) start = i;
    if (!dark && start >= 0) {
      if (i - start >= 20) bands.push([start, i]);
      start = -1;
    }
  }
  if (bands.length !== n + 1) throw new Error(`Expected ${n + 1} gutters on the card, found ${bands.length}.`);
  return bands.slice(1).map(([start], i) => [bands[i][1], start]);
}

/** The eleven photographs: each one's edges on the card, and its centre. */
function photographs() {
  const rowMeans = Float64Array.from({ length: H }, (_, y) => mean(card.subarray(y * W, (y + 1) * W)));
  const rows = between(rowMeans, GRID.rows);
  const [top, bottom] = [rows[0][0], rows[GRID.rows - 1][1]];
  const colMeans = new Float64Array(W);
  for (let y = top; y < bottom; y++) for (let x = 0; x < W; x++) colMeans[x] += card[y * W + x] / (bottom - top);
  const cols = between(colMeans, GRID.cols);
  return Array.from({ length: GRID.frames }, (_, i) => {
    const [x0, x1] = cols[i % GRID.cols];
    const [y0, y1] = rows[Math.floor(i / GRID.cols)];
    return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  });
}

/**
 * Where a profile dips under its own running median, as a ruled line does across paper: each dip's centre, to a
 * fraction of a sample, and its depth.
 */
function dips(profile) {
  const depth = profile.map((v, i) => Math.max(0, median(profile.subarray(Math.max(0, i - 30), i + 31)) - v));
  const found = [];
  for (let i = 8; i < profile.length - 8; i++) {
    const around = depth.subarray(i - 8, i + 9);
    if (depth[i] < 20 || around.some((v, k) => v > depth[i] || (v === depth[i] && k < 8))) continue;
    let weight = 0;
    let at = 0;
    around.forEach((v, k) => {
      const w = Math.max(0, v - 0.3 * depth[i]);
      weight += w;
      at += w * (i - 8 + k);
    });
    found.push({ at: at / weight, depth: depth[i] });
  }
  return found;
}

/** The median of each row of a photograph between two columns: the horse's legs cross few of them. */
function rowsOf(photo, x0, x1) {
  return Float64Array.from({ length: photo.y1 - photo.y0 }, (_, y) => {
    const row = (photo.y0 + y) * W;
    return median(card.subarray(row + x0, row + x1));
  });
}

/**
 * A photograph's ruled ground: the line over the numbers (0) and the track's first three lines (1–3), each measured
 * in every strip it shows in. Points are in card pixels from the photograph's centre.
 */
function rulings(photo) {
  const height = photo.y1 - photo.y0;
  const whole = dips(rowsOf(photo, photo.x0 + EDGE, photo.x1 - EDGE));
  const over = whole.filter((d) => d.at < height * 0.08).sort((a, b) => b.depth - a.depth)[0];
  const track = whole.filter((d) => d.at > height * 0.7).slice(0, 3);
  if (!over || track.length < 3) throw new Error('A photograph’s ruled lines were not found.');
  const width = Math.floor((photo.x1 - photo.x0 - 2 * EDGE) / STRIPS);
  const points = [];
  for (let strip = 0; strip < STRIPS; strip++) {
    const x0 = photo.x0 + EDGE + strip * width;
    const found = dips(rowsOf(photo, x0, x0 + width));
    [over, ...track].forEach((line, n) => {
      const near = found.find((d) => Math.abs(d.at - line.at) < 12);
      if (near) points.push({ line: n, strip, x: x0 + width / 2 - photo.cx, y: photo.y0 + near.at - photo.cy });
    });
  }
  return points;
}

/**
 * Least squares for value ≈ a·x + b·y + c. Points further than `cut` from the fit are left out and it is fitted
 * again, twice: a hoof on a line pulls that line's reading off.
 */
function fit(points, values, cut) {
  let kept = points.map((_, i) => i);
  let solution;
  for (let pass = 0; pass < 3; pass++) {
    const m = [0, 1, 2].map(() => [0, 0, 0, 0]);
    for (const i of kept) {
      const row = [points[i].x, points[i].y, 1];
      for (let a = 0; a < 3; a++) {
        for (let b = 0; b < 3; b++) m[a][b] += row[a] * row[b];
        m[a][3] += row[a] * values[i];
      }
    }
    for (let c = 0; c < 3; c++) {
      for (let r = 0; r < 3; r++) {
        if (r === c) continue;
        const f = m[r][c] / m[c][c];
        for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k];
      }
    }
    solution = m.map((row, i) => row[3] / row[i]);
    const [a, b, c] = solution;
    kept = points.map((_, i) => i).filter((i) => Math.abs(a * points[i].x + b * points[i].y + c - values[i]) < cut);
  }
  return solution;
}

const LOBES = 3;
const lanczos = (x) => {
  if (x === 0) return 1;
  if (Math.abs(x) >= LOBES) return 0;
  return (LOBES * Math.sin(Math.PI * x) * Math.sin((Math.PI * x) / LOBES)) / (Math.PI * x) ** 2;
};

/**
 * A window of the common frame, from (x0, y0), drawn from one photograph at `w` × `h`: grey levels as floats. `step`
 * is the common frame's pixels per output pixel; the Lanczos filter is as wide as the card pixels one output pixel
 * covers, so nothing aliases.
 */
function draw({ photo, d, e, tx, ty }, x0, y0, step, w, h) {
  const size = d * d + e * e;
  const wide = Math.max(1, step / Math.sqrt(size));
  const reach = Math.ceil(LOBES * wide);
  const image = new Float32Array(w * h);
  const wx = new Float64Array(2 * reach + 1);
  const wy = new Float64Array(2 * reach + 1);
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      // Back through the photograph's shift, rotation and scale, to the card.
      const X = x0 + (u + 0.5) * step - tx;
      const Y = y0 + (v + 0.5) * step - ty;
      const sx = photo.cx + (e * X + d * Y) / size;
      const sy = photo.cy + (e * Y - d * X) / size;
      const ix = Math.round(sx);
      const iy = Math.round(sy);
      let sumX = 0;
      let sumY = 0;
      for (let k = -reach; k <= reach; k++) {
        sumX += wx[k + reach] = lanczos((ix + k - sx) / wide);
        sumY += wy[k + reach] = lanczos((iy + k - sy) / wide);
      }
      let value = 0;
      for (let j = -reach; j <= reach; j++) {
        const row = (iy + j) * W + ix;
        let line = 0;
        for (let k = -reach; k <= reach; k++) line += wx[k + reach] * card[row + k];
        value += wy[j + reach] * line;
      }
      image[v * w + u] = value / (sumX * sumY);
    }
  }
  return image;
}

/** A picture's ink and its paper: the medians of its dark and of its light pixels, to a quarter of a level. */
function levels(image) {
  const counts = new Uint32Array(1024);
  for (const v of image) counts[Math.min(1023, Math.max(0, Math.round(v * 4)))]++;
  const middle = (first, end) => {
    let total = 0;
    for (let i = first; i < end; i++) total += counts[i];
    for (let i = first, seen = 0; i < end; i++) {
      seen += counts[i];
      if (seen * 2 >= total) return i / 4;
    }
  };
  let split = 400;
  for (let pass = 0; pass < 3; pass++) split = Math.round((middle(0, split) + middle(split, 1024)) * 2);
  return { ink: middle(0, split), paper: middle(split, 1024) };
}

// 1. Each photograph's rotation, scale and height, from its ruled lines. In the common frame the track's second line
//    is y = 0 and a photograph's centre is x = 0 until the horse places it.
const frames = photographs().map((photo) => ({ photo, points: rulings(photo), tx: 0 }));
/** Where the eleven have each line, from the track's second, at the photograph's middle. */
const common = [0, 1, 2, 3].map((line) =>
  median(
    frames.map(({ points }) => {
      const middle = (n) => mean(points.filter((p) => p.line === n && Math.abs(p.x) < 330).map((p) => p.y));
      return middle(line) - middle(2);
    }),
  ),
);
for (const frame of frames) {
  const [d, e, ty] = fit(
    frame.points,
    frame.points.map((p) => common[p.line]),
    4,
  );
  Object.assign(frame, { d, e, ty });
}

// 2. Left and right, on the horse. Every pair of silhouettes is slid to where the two cover each other most; a
//    photograph's shift is the mean of its slides against the others.
const COARSE = 4;
const band = { x: -624, y: common[0] + BAND.top, w: 312, h: Math.floor((common[1] - BAND.bottom - common[0] - BAND.top) / COARSE) };
const silhouettes = frames.map((frame) => {
  const image = draw(frame, band.x, band.y, COARSE, band.w, band.h);
  const { ink, paper } = levels(image);
  return image.map((v) => Math.min(1, Math.max(0, (paper - v) / (paper - ink))));
});
/** How far right, in coarse pixels and to a fraction, silhouette b covers silhouette a most. */
function slide(a, b) {
  const REACH = 40;
  const cover = new Float64Array(2 * REACH + 1);
  for (let s = -REACH; s <= REACH; s++) {
    for (let y = 0; y < band.h; y++) {
      const row = y * band.w;
      for (let x = Math.max(0, s); x < Math.min(band.w, band.w + s); x++) cover[s + REACH] += a[row + x] * b[row + x - s];
    }
  }
  const best = cover.indexOf(Math.max(...cover));
  const [l, c, r] = [cover[best - 1], cover[best], cover[best + 1]];
  return best - REACH + (l - r) / (2 * (l - 2 * c + r));
}
frames.forEach((frame, i) => {
  frame.tx = COARSE * mean(silhouettes.map((other, j) => (i === j ? 0 : slide(other, silhouettes[i]))));
});

// 3. The largest window every photograph fills, at the sprite's proportions.
const corner = ({ photo, d, e, tx, ty }, x, y) => {
  const [dx, dy] = [x - photo.cx, y - photo.cy];
  return [e * dx - d * dy + tx, d * dx + e * dy + ty];
};
const sides = frames.map((frame) => {
  const { x0, y0, x1, y1 } = frame.photo;
  const [a, b] = [corner(frame, x0 + EDGE, y0 + EDGE), corner(frame, x1 - EDGE, y0 + EDGE)];
  const [c, f] = [corner(frame, x0 + EDGE, y1 - EDGE), corner(frame, x1 - EDGE, y1 - EDGE)];
  return { left: Math.max(a[0], c[0]), right: Math.min(b[0], f[0]), top: Math.max(a[1], b[1]), bottom: Math.min(c[1], f[1]) };
});
const left = Math.max(...sides.map((s) => s.left));
const right = Math.min(...sides.map((s) => s.right));
const top = Math.max(common[0] + BAND.under, ...sides.map((s) => s.top));
const bottom = Math.min(...sides.map((s) => s.bottom));
const step = Math.min((right - left) / CELL.w, (bottom - top) / CELL.h);
const windowX = (left + right - CELL.w * step) / 2;
const windowY = (top + bottom - CELL.h * step) / 2;

// 4. Each frame drawn, from its ink (0) to its paper (1).
const drawn = frames.map((frame) => {
  const grey = draw(frame, windowX, windowY, step, CELL.w, CELL.h);
  Object.assign(frame, levels(grey));
  return grey.map((v) => (v - frame.ink) / (frame.paper - frame.ink));
});

/** The zone a pixel is in, across and down, as fractions: zone n's middle is at n. */
const zoneOf = (i) => [
  (((i % CELL.w) + 0.5) * ZONES.cols) / CELL.w - 0.5,
  ((Math.floor(i / CELL.w) + 0.5) * ZONES.rows) / CELL.h - 0.5,
];

/** A frame's paper zone by zone: the median of each zone's light pixels. A zone the horse fills takes its neighbours'. */
function paperOf(tones) {
  const { cols, rows } = ZONES;
  const light = Array.from({ length: cols * rows }, () => []);
  tones.forEach((t, i) => {
    const [zx, zy] = zoneOf(i);
    if (t > 0.5) light[Math.round(zy) * cols + Math.round(zx)].push(t);
  });
  const least = (CELL.w * CELL.h) / (cols * rows) / 4;
  const paper = light.map((values) => (values.length < least ? NaN : median(values)));
  while (paper.some(Number.isNaN)) {
    const before = [...paper];
    before.forEach((value, k) => {
      if (!Number.isNaN(value)) return;
      const beside = [k % cols > 0 ? k - 1 : -1, k % cols < cols - 1 ? k + 1 : -1, k - cols, k + cols];
      const known = beside.map((n) => before[n]).filter((v) => v !== undefined && !Number.isNaN(v));
      if (known.length) paper[k] = mean(known);
    });
  }
  return paper;
}

// 5. Flicker, then tone: each frame's paper is put, zone by zone and smoothly between zones, on the eleven's mean
//    there; ink and paper then take the film's colours.
const papers = drawn.map(paperOf);
const shared = papers[0].map((_, k) => mean(papers.map((paper) => paper[k])));
const pictures = drawn.map((tones, n) => {
  const gain = papers[n].map((paper, k) => shared[k] / paper);
  const at = (x, y) => gain[y * ZONES.cols + x];
  const rgb = Buffer.alloc(CELL.w * CELL.h * 3);
  tones.forEach((t, i) => {
    const [zx, zy] = zoneOf(i);
    const x0 = Math.min(ZONES.cols - 2, Math.max(0, Math.floor(zx)));
    const y0 = Math.min(ZONES.rows - 2, Math.max(0, Math.floor(zy)));
    const fx = Math.min(1, Math.max(0, zx - x0));
    const fy = Math.min(1, Math.max(0, zy - y0));
    const level = (1 - fy) * ((1 - fx) * at(x0, y0) + fx * at(x0 + 1, y0)) + fy * ((1 - fx) * at(x0, y0 + 1) + fx * at(x0 + 1, y0 + 1));
    for (let c = 0; c < 3; c++) rgb[i * 3 + c] = Math.min(255, Math.max(0, Math.round(INK[c] + t * level * (PAPER[c] - INK[c]))));
  });
  return rgb;
});

/** Pictures side by side as one WebP, through a PPM: this ffmpeg build has no WebP encoder, and cwebp reads PPM. */
function write(name, tiles, cols) {
  const rows = Math.ceil(tiles.length / cols);
  const sheet = Buffer.alloc(cols * CELL.w * rows * CELL.h * 3);
  tiles.forEach((tile, i) => {
    const [x, y] = [(i % cols) * CELL.w, Math.floor(i / cols) * CELL.h];
    for (let row = 0; row < CELL.h; row++) tile.copy(sheet, ((y + row) * cols * CELL.w + x) * 3, row * CELL.w * 3, (row + 1) * CELL.w * 3);
  });
  const ppm = out(`${name}.ppm`);
  writeFileSync(ppm, Buffer.concat([Buffer.from(`P6\n${cols * CELL.w} ${rows * CELL.h}\n255\n`), sheet]));
  run('cwebp', ['-quiet', '-q', '50', '-m', '6', ppm, '-o', out(`${name}.webp`)]);
  rmSync(ppm);
  return `${name}.webp ${(statSync(out(`${name}.webp`)).size / 1000).toFixed(1)} kB`;
}

mkdirSync(out(''), { recursive: true });
const written = [write('sprite', [...pictures, pictures[0]], GRID.cols), write('still', [pictures[0]], 1)];

// What was measured. A strip's reading is the median of the track's three lines there (a hoof stands on one at most),
// taken from the median of the eleven in that strip: the bow the lines share is not movement.
const strips = frames.map(({ points, d, e, ty }) =>
  Array.from({ length: STRIPS }, (_, strip) =>
    median(points.filter((p) => p.strip === strip && p.line > 0).map((p) => d * p.x + e * p.y + ty - common[p.line])),
  ),
);
const bow = strips[0].map((_, strip) => median(strips.map((readings) => readings[strip])));
const px = (cardPixels) => (cardPixels / step).toFixed(2);
const size = `${(CELL.w * step).toFixed(0)} × ${(CELL.h * step).toFixed(0)}`;
console.log(`The window is ${size} card pixels, ${step.toFixed(3)} to a sprite pixel. Below, lengths are sprite pixels.\n`);
console.log('photograph   turned    scale   track off, worst strip   moved from the card’s centring   ink → paper on the card');
frames.forEach(({ d, e, tx, ink, paper }, i) => {
  const worst = Math.max(...strips[i].map((v, strip) => Math.abs(v - bow[strip])));
  const turned = `${((Math.atan2(d, e) * 180) / Math.PI).toFixed(2)}°`;
  const scale = Math.hypot(d, e).toFixed(4);
  const tones = `${ink.toFixed(0)} → ${paper.toFixed(0)}`;
  console.log(`${String(i + 1).padStart(10)} ${turned.padStart(8)} ${scale.padStart(8)} ${px(worst).padStart(24)} ${px(tx).padStart(32)} ${tones.padStart(25)}`);
});
console.log(`\n${written.join(', ')}`);
