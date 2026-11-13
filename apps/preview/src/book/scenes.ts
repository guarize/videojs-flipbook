/**
 * The page's scenes. Each pinned section holds a stage while its scene plays out over the section's scroll length:
 * `update(p)` receives progress 0–1 and writes transforms and opacity only. `layout()` measures, on resize alone.
 * Under reduced motion each scene is set once to its `still`.
 */
import { CHAPTERS, chapterOf, pageSrc } from './object';

export interface Scene {
  section: HTMLElement;
  /** Progress shown under reduced motion. */
  still: number;
  layout(): void;
  update(p: number): void;
}

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const span = (p: number, a: number, b: number) => clamp((p - a) / (b - a));
const inOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const out = (t: number) => 1 - (1 - t) ** 3;
const q = <E extends Element = HTMLElement>(root: ParentNode, sel: string) => root.querySelector(sel) as E;
const narrow = () => innerWidth <= 700;
const reduce = matchMedia('(prefers-reduced-motion: reduce)');
const mid = () => innerWidth <= 960;

/**
 * Tablet and phone set the copy above the scene: the scene starts under the copy's last line, whatever its length at
 * this width, so the folio never sits on the picture. Wide screens keep the stylesheet's placing.
 */
const belowCopy = (section: HTMLElement, scene: HTMLElement) => {
  const copy = q(section, '.copy');
  scene.style.top = mid() ? `${Math.round(copy.offsetTop + copy.offsetHeight + 12)}px` : '';
};

const ruler = document.createElement('canvas').getContext('2d');

/**
 * Holds a folio's column at the width of its widest number, so the chapter beside it never moves as the page number
 * changes (the display face's figures are not all one width). Measured on a canvas: no layout is forced per number.
 */
const holdFolio = (num: HTMLElement, numbers: number[]) => {
  const column = num.parentElement;
  if (!ruler || !column) return;
  column.style.minWidth = '';
  const cs = getComputedStyle(num);
  ruler.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const wide = (n: string) => ruler.measureText(n).width + n.length * (parseFloat(cs.letterSpacing) || 0);
  const most = Math.max(...numbers.map((n) => wide(String(n))));
  column.style.minWidth = `${Math.ceil(column.offsetWidth - wide(num.textContent ?? '') + most + 1)}px`;
};

/** Writes text only when it changes. */
const text = (el: Element | null, value: string) => {
  if (el && el.textContent !== value) el.textContent = value;
};

/* ─── Riffle: a flipbook of Muybridge's gallop; each page that falls is the next photograph ─── */

/**
 * The flipbook's own measures, in its units. A page carries one photograph of the stride, in the same place on every
 * page (the sprite's cells are cut to one card, scripts/gallop.mjs), so flipped they read as one horse running.
 */
const FLIP = {
  /** Photographs in one stride, and the sprite's grid. */
  frames: 11,
  cols: 4,
  rows: 3,
  /** One photograph, and where it is printed on the page. */
  cw: 720,
  ch: 462,
  px: 40,
  py: 58,
  /** The page, the cloth tape that binds it at the head, the pad's thickness. */
  w: 800,
  d: 574,
  tape: 30,
  thick: 44,
  /** Strides over the chapter's scroll. */
  strides: 3,
  /** A falling page starts this far through its frame, lifted this many degrees at its foot. */
  from: 0.5,
  lift: 14,
} as const;

const GALLOP = './book/gallop/';

/** `wanted`: when the photographs may be fetched (main.ts: after the player, or at the visitor's first move). */
export function riffle(section: HTMLElement, wanted: Promise<unknown> = Promise.resolve()): Scene {
  const stage = q(section, '.stage');
  const anchor = q(section, '[data-book="riffle"]');
  const fPage = q(section, '[data-f-page]');
  const bar = q(section, '[data-f-bar]');
  const copy = q(section, '.copy');
  const F = FLIP;
  const total = F.frames * F.strides;

  // The pad: a still block with one page on top; over it a single leaf, the page in the air. Each has one canvas, and
  // a new photograph is one drawImage of a bitmap decoded beforehand: no element is added, laid out or painted.
  const sheet = () =>
    `<div class="fk-pic" style="left:${F.px}px;width:${F.cw}px;height:${F.ch}px"><canvas class="fk-frame" width="${F.cw}" height="${F.ch}"></canvas></div><span class="fk-print">2 One Gallop</span>`;
  const book = document.createElement('div');
  book.className = 'fk-book';
  book.style.cssText = `width:${F.w}px;height:${F.d}px;left:${-F.w / 2}px;top:${-F.d / 2}px`;
  book.innerHTML =
    `<div class="fk-shadow" style="left:-10px;top:26px;width:${F.w + 44}px;height:${F.d + 26}px"></div>` +
    `<div class="fk-edge fk-edge-foot" style="top:${F.d}px;width:${F.w}px;height:${F.thick}px;transform:translateZ(${F.thick}px) rotateX(-90deg)"></div>` +
    `<div class="fk-edge fk-edge-side" style="left:${F.w}px;width:${F.thick}px;height:${F.d}px;transform:translateZ(${F.thick}px) rotateY(90deg)"></div>` +
    `<div class="fk-edge fk-edge-side fk-edge-left" style="left:0;width:${F.thick}px;height:${F.d}px;transform:translateZ(${F.thick}px) rotateY(-90deg)"></div>` +
    `<div class="fk-page" style="width:${F.w}px;height:${F.d}px;transform:translateZ(${F.thick}px)">${sheet()}<div class="fk-tape" style="height:${F.tape}px"><span style="left:22%"></span><span style="left:78%"></span></div></div>` +
    `<div class="fk-leaf" style="top:${F.tape}px;width:${F.w}px;height:${F.d - F.tape}px">${sheet()}</div>`;
  anchor.append(book);
  const leaf = q(book, '.fk-leaf');
  const [pagePic, leafPic] = [...book.querySelectorAll<HTMLElement>('.fk-pic')];
  const [pageCanvas, leafCanvas] = [...book.querySelectorAll<HTMLCanvasElement>('.fk-frame')];
  const pageCtx = pageCanvas.getContext('2d');
  const leafCtx = leafCanvas.getContext('2d');
  pagePic.style.top = `${F.py}px`;
  leafPic.style.top = `${F.py - F.tape}px`;
  // Until the photographs are decoded the page shows the first one, a file of its own: a still page, never a blank.
  pagePic.style.backgroundImage = `url(${GALLOP}still.webp)`;

  // The folio's number, as a column that rolls: a transform, where new text would be laid out and painted per page.
  const roll = document.createElement('span');
  roll.className = 'fk-roll';
  roll.innerHTML = `<span class="fk-roll-col">${Array.from({ length: F.frames }, (_, i) => `<span>${i + 1}</span>`).join('')}</span>`;
  fPage.replaceChildren(roll);
  const column = roll.firstElementChild as HTMLElement;

  let ready = false;
  let last = 0;
  let shownPage = -1;
  let shownLeaf = -1;
  let leafOn = true;

  // The eleven photographs, each a bitmap of its own, decoded before the first flip: the sheet is fetched and decoded
  // once, off the main thread, then cut a cell per task.
  const frames: ImageBitmap[] = [];
  const draw = (ctx: CanvasRenderingContext2D | null, k: number) => {
    if (ctx && frames[k]) ctx.drawImage(frames[k], 0, 0, ctx.canvas.width, ctx.canvas.height);
  };
  const load = async () => {
    const response = await fetch(`${GALLOP}sprite.webp`, { priority: 'low' } as RequestInit);
    const whole = await createImageBitmap(await response.blob());
    for (let i = 0; i < F.frames; i++) {
      frames.push(await createImageBitmap(whole, (i % F.cols) * F.cw, Math.floor(i / F.cols) * F.ch, F.cw, F.ch));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    whole.close();
    ready = true;
    shownPage = shownLeaf = -1;
    update(last);
  };
  // Without them the still page stays: nothing to report.
  if (!reduce.matches) void wanted.then(load).catch(() => {});

  const layout = () => {
    const vw = stage.clientWidth;
    const vh = stage.clientHeight;
    let s: number;
    let ax: number;
    let ay: number;
    if (mid()) {
      // Under the copy, in the room that's left.
      const top = copy.offsetTop + copy.offsetHeight + 12;
      const room = Math.max(140, vh - top - 20);
      s = Math.min((vw - 28) / (F.w * 1.2), room / (F.d * 0.98), 0.9);
      ax = vw * 0.5;
      ay = top + room * 0.48;
    } else {
      // Beside the copy, in the middle of the room to its right.
      const edge = copy.offsetLeft + copy.offsetWidth + 40;
      s = Math.min((vw - 32 - edge) / (F.w * 1.14), (vh * 0.7) / F.d, 1);
      ax = edge + (vw - 16 - edge) * 0.5;
      ay = vh * 0.53;
    }
    anchor.style.transform = `translate3d(${ax.toFixed(1)}px, ${ay.toFixed(1)}px, 0)`;
    book.style.transform = `scale3d(${s.toFixed(4)}, ${s.toFixed(4)}, ${s.toFixed(4)}) rotateX(40deg) rotateZ(-9deg)`;
    // The canvases hold as many pixels as the photograph covers on this screen, never more than it has, and never
    // fewer than 480 across: under about 256 × 256 pixels Chromium draws a canvas in software, and each new photograph
    // then waits a frame for its raster (measured at 390 px wide, 1×: 32 of 142 flips a frame late).
    const cw = Math.min(F.cw, Math.max(480, Math.ceil(F.cw * s * Math.min(2, devicePixelRatio || 1))));
    if (pageCanvas.width !== cw) {
      for (const canvas of [pageCanvas, leafCanvas]) {
        canvas.width = cw;
        canvas.height = Math.round((cw * F.ch) / F.cw);
      }
      for (const ctx of [pageCtx, leafCtx]) if (ctx) ctx.imageSmoothingQuality = 'high';
      shownPage = shownLeaf = -1;
    }
    update(last);
  };

  // Before the photographs are in, and under reduced motion (main.ts holds p at `still`): the first one, lying flat.
  const at = (p: number) => (ready && !reduce.matches ? clamp(p / 0.94) * total : 0);

  /** Draws the pad at `f` photographs into the chapter: the page, and the page in the air over it. */
  const show = (f: number) => {
    const whole = Math.min(total, Math.floor(f));
    const k = whole % F.frames;
    if (k !== shownPage) {
      shownPage = k;
      draw(pageCtx, k);
      column.style.transform = `translate3d(0, ${((-k / F.frames) * 100).toFixed(4)}%, 0)`;
    }
    // The page in the air carries the next photograph. It drops from a little above the pad, gathering speed, and
    // comes out of nothing as it does (the blur of a page going by); landed, it is the page, and the next one starts.
    const t = f - whole;
    const e = span(t, F.from, 1);
    const on = e > 0;
    if (on) {
      const next = (k + 1) % F.frames;
      if (next !== shownLeaf) {
        shownLeaf = next;
        draw(leafCtx, next);
      }
      leaf.style.transform = `translateZ(${F.thick + 0.6}px) rotateX(${(F.lift * (1 - e) ** 2).toFixed(2)}deg)`;
      leaf.style.opacity = Math.min(1, e / 0.5).toFixed(3);
    } else if (leafOn) {
      leaf.style.opacity = '0';
    }
    leafOn = on;
  };

  // No page hangs in the air once the scroll rests: a page caught falling was two photographs at once, one of them
  // faint, for as long as the visitor stopped there. It lands (LAND ms, after REST ms without a scroll), and the pad
  // holds that photograph until the scroll has passed it, or gone back to before the fall.
  const REST = 90;
  const LAND = 140;
  let held: number | null = null;
  let landing = 0;
  let resting = 0;

  const rest = () => {
    resting = 0;
    const from = at(last);
    const to = Math.floor(from) + 1;
    if (held !== null || landing || to > total || from - Math.floor(from) <= F.from) return;
    const start = performance.now();
    const step = (now: number) => {
      const x = clamp((now - start) / LAND);
      show(lerp(from, to, x));
      if (x < 1) {
        landing = requestAnimationFrame(step);
      } else {
        landing = 0;
        held = to;
      }
    };
    landing = requestAnimationFrame(step);
  };

  const update = (p: number) => {
    const moved = p !== last;
    last = p;
    bar.style.transform = `scaleX(${Math.max(0.02, clamp(p / 0.94)).toFixed(4)})`;
    const f = at(p);
    if (landing) {
      // A layout pass in the middle of a landing leaves it be; a scroll finishes it at once.
      if (!moved) return;
      cancelAnimationFrame(landing);
      landing = 0;
      held = Math.floor(f) + 1;
    }
    if (held !== null && (f > held || f <= held - (1 - F.from))) held = null;
    show(held ?? f);
    clearTimeout(resting);
    if (held === null) resting = window.setTimeout(rest, REST);
  };

  return { section, still: 0, layout, update };
}

/* ─── Fore-edge: the thumb index in macro, then the same edge in the player ─── */

export function edge(section: HTMLElement): Scene {
  const scene = q(section, '.edge-scene');
  const img = q<HTMLImageElement>(section, '[data-macro] img');
  const macro = q(section, '[data-macro]');
  const real = q(section, '[data-real-edge]');
  const body2 = q(section, '[data-edge-2]');
  const eChapter = q(section, '[data-e-chapter]');
  const eMeta = q(section, '[data-e-meta]');
  // Where each notch's label sits in the macro image, as a fraction of its width.
  const NOTCH = [0.0, 0.14, 0.29, 0.445, 0.6, 0.765];
  let iw = 0;
  let ih = 0;
  let sw = 0;
  let last = 0;
  let shown = -1;

  const layout = () => {
    belowCopy(section, scene);
    sw = scene.clientWidth;
    const sh = scene.clientHeight;
    ih = Math.min(sh * 0.9, 640);
    iw = (ih * 2300) / 1140;
    img.style.width = `${iw}px`;
    update(last);
  };

  const update = (p: number) => {
    last = p;
    const pan = inOut(span(p, 0.0, 0.62));
    const x = lerp(-iw * 0.02, -(iw - sw) - iw * 0.0, pan);
    // One picture at a time: the macro goes, then the player's own edge comes. Never the two through each other.
    const gone = span(p, 0.62, 0.72);
    const swap = span(p, 0.72, 0.84);
    img.style.transform = `translate3d(${x.toFixed(1)}px, ${(-ih / 2).toFixed(1)}px, 0)`;
    macro.style.opacity = (1 - gone).toFixed(3);
    macro.style.visibility = gone >= 1 ? 'hidden' : '';
    real.style.opacity = swap.toFixed(3);
    real.style.transform = `translateY(calc(-50% + ${(16 * (1 - out(swap))).toFixed(1)}px))`;
    body2.style.opacity = swap.toFixed(3);
    // The chapter whose notch is nearest the middle of the view.
    const centre = (-x + sw / 2) / iw;
    let k = 0;
    for (let i = 0; i < NOTCH.length; i++) if (Math.abs(NOTCH[i] - centre) < Math.abs(NOTCH[k] - centre)) k = i;
    // The player's own edge is shown paused at 0:20, in the second chapter.
    if (swap > 0) k = 1;
    if (k !== shown) {
      shown = k;
      const c = CHAPTERS[k];
      text(eChapter, `${c.n} ${c.name}`);
      text(eMeta, `p. ${c.page + 1}, ${c.t}`);
    }
  };
  return { section, still: 0.3, layout, update };
}

/* ─── The plate: the paused page as the player prints it, the twelve frames round the moment in its foot ─── */

export function plate(section: HTMLElement): Scene {
  const scene = q(section, '.plate-scene');
  // The player's own paused page, taken from it (scripts/site-states.mjs): nothing of it is drawn again here.
  const card = q(section, '[data-plate-card]');
  let k = 1;
  let lift = 0;
  let last = 0;
  const layout = () => {
    belowCopy(section, scene);
    k = Math.min(1, (scene.clientWidth - 32) / 800, (scene.clientHeight - 24) / 400);
    // It is scaled from its foot, so a small page is lifted by half of what it lost: it stays in the scene's middle.
    lift = ((1 - k) * card.offsetHeight) / 2;
    update(last);
  };
  const update = (p: number) => {
    last = p;
    const e = out(span(p, 0.05, 0.6));
    card.style.transform = `translateY(${(lerp(170, 0, e) - lift).toFixed(1)}px) scale(${(k * lerp(0.92, 1, e)).toFixed(4)}) rotateX(${lerp(58, 6, e).toFixed(2)}deg)`;
    card.style.opacity = span(p, 0.03, 0.22).toFixed(3);
  };
  return { section, still: 1, layout, update };
}

/* ─── The corner: paused, the top corner lifts on the next chapter; pulled, the page turns there ─── */

export function corner(section: HTMLElement): Scene {
  const stage = q(section, '.stage');
  const anchor = q(section, '[data-corner]');
  const cPage = q(section, '[data-c-page]');
  const cChapter = q(section, '[data-c-chapter]');
  const cTime = q(section, '[data-c-time]');
  // Paused at 0:20: page 11, in the second chapter; the corner lifts on the third.
  const CUR = 10;
  const UPCOMING = CHAPTERS[2];
  const NEXT = UPCOMING.page;
  const PW = 720;
  const PHt = 405;
  const C = 190;
  const wrap = document.createElement('div');
  wrap.className = 'bk-book';
  wrap.style.cssText = `width:${PW}px;height:${PHt}px;left:${-PW / 2}px;top:${-PHt / 2}px`;
  wrap.innerHTML = `
    <div class="bk-shadow" style="left:8px;top:24px;width:${PW + 24}px;height:${PHt + 20}px"></div>
    <div class="cn-under" style="width:${PW}px;height:${PHt}px;background-image:url(${pageSrc(NEXT)})"></div>
    <div class="cn-page" style="width:${PW}px;height:${PHt}px">
      <div class="cn-face" style="background-image:url(${pageSrc(CUR)});clip-path:polygon(0 0, ${PW - C}px 0, ${PW}px ${C}px, ${PW}px ${PHt}px, 0 ${PHt}px)"><div class="cn-shadow" style="left:${PW - C * 1.6}px;width:${C * 1.6}px;height:${C * 1.6}px;inset:0 0 auto auto"></div></div>
      <div class="cn-back"></div>
      <div class="cn-flap" style="width:${C}px;height:${C}px">
        <div class="cn-flap-f" style="background-image:url(${pageSrc(CUR)});background-size:${PW}px ${PHt}px;background-position:${-(PW - C)}px 0"></div>
        <div class="cn-flap-b"><p class="cn-label">Next<b>${UPCOMING.name}</b></p></div>
      </div>
    </div>`;
  anchor.append(wrap);
  const page = q(wrap, '.cn-page');
  const flap = q(wrap, '.cn-flap');
  const shadow = q(wrap, '.cn-shadow');
  const face = q(wrap, '.cn-face');
  const back = q(wrap, '.cn-back');
  const flapFront = q(wrap, '.cn-flap-f');
  const flapBack = q(wrap, '.cn-flap-b');
  let last = 0;
  let shown = -1;

  const layout = () => {
    const vw = stage.clientWidth;
    const vh = stage.clientHeight;
    let s: number;
    let ax: number;
    let ay: number;
    if (mid()) {
      s = Math.min((vw - (narrow() ? 72 : 96)) / PW, (vh * 0.42) / PHt);
      ax = vw * 0.5;
      ay = vh * 0.74;
    } else {
      s = Math.min((vw * 0.5) / PW, (vh * 0.62) / PHt, 1);
      ax = vw * 0.67;
      ay = vh * 0.52;
    }
    holdFolio(cPage, [CUR + 1, NEXT + 1]);
    anchor.style.transform = `translate3d(${ax}px, ${ay}px, 0)`;
    wrap.style.transform = `scale3d(${s}, ${s}, ${s}) rotateX(14deg) rotateY(-10deg)`;
    update(last);
  };

  const update = (p: number) => {
    last = p;
    // The corner folds over its diagonal, showing the next chapter's name on its back.
    const lift = out(span(p, 0.04, 0.38));
    flap.style.transform = `rotate3d(1, 1, 0, ${(-158 * lift).toFixed(2)}deg)`;
    // Faces by angle, as in the riffle: never left to backface culling alone.
    flapFront.style.visibility = 158 * lift < 90 ? '' : 'hidden';
    flapBack.style.visibility = 158 * lift < 90 ? 'hidden' : '';
    shadow.style.opacity = lift.toFixed(3);
    // Pulled: the page turns up over the tape, onto the next chapter.
    const turn = inOut(span(p, 0.52, 0.9));
    page.style.transform = `rotateX(${(150 * turn).toFixed(2)}deg)`;
    // The camera leans 14° over the page, so its back shows past 76°.
    face.style.visibility = 150 * turn < 76 ? '' : 'hidden';
    back.style.visibility = 150 * turn < 76 ? 'hidden' : '';
    page.style.opacity = (1 - span(turn, 0.55, 0.85)).toFixed(3);
    // The folded corner goes into the turn: edge-on, the page would otherwise leave it hanging over the book.
    flap.style.opacity = (1 - span(turn, 0.25, 0.45)).toFixed(3);
    const after = turn > 0.5;
    const pg = after ? NEXT : CUR;
    if (pg !== shown) {
      shown = pg;
      const c = chapterOf(pg);
      text(cPage, String(pg + 1));
      text(cChapter, `${c.n} ${c.name}`);
      text(cTime, after ? c.t : '0:20');
    }
  };
  return { section, still: 0.38, layout, update };
}

/* ─── Picture-in-picture: the book leaves for its window; its place turns to a waiting page ─── */

export function pip(section: HTMLElement): Scene {
  const scene = q(section, '.pip-scene');
  const place = q(section, '[data-pip-place]');
  const win = q(section, '[data-pip-window]');
  const waiting = q(section, '.waiting');
  let g = { dx: 0, dy: 0, k: 0.4 };
  let last = 0;
  const layout = () => {
    belowCopy(section, scene);
    const sr = scene.getBoundingClientRect();
    win.style.transform = '';
    const wr = win.getBoundingClientRect();
    const margin = narrow() ? 12 : 28;
    const k = narrow() ? 0.5 : 0.4;
    g = { dx: sr.right - margin - wr.right, dy: sr.bottom - margin - wr.bottom, k };
    win.style.transform = `translateY(-58%)`;
    void place;
    update(last);
  };
  const update = (p: number) => {
    last = p;
    const e = inOut(span(p, 0.06, 0.62));
    const k = lerp(1, g.k, e);
    // translateY(-58%) centres it as the place is; the move takes it to the corner of the screen.
    win.style.transform = `translate(${(g.dx * e).toFixed(1)}px, calc(${(g.dy * e).toFixed(1)}px - ${(58 * (1 - e)).toFixed(2)}%)) scale(${k.toFixed(4)})`;
    waiting.style.opacity = span(p, 0.2, 0.5).toFixed(3);
  };
  return { section, still: 0.75, layout, update };
}
