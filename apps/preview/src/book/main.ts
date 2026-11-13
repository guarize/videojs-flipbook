/**
 * The book page's script. The headline and the player's poster paint from the HTML alone; the player is fetched and
 * mounted once the page is loaded and idle (load-player.ts), and each chapter's 3D scene is built as its section
 * comes near. Scroll drives the scenes: a frame is drawn only when the page scrolls and only for sections on screen,
 * so nothing runs off-screen or at rest.
 */
import { corner, edge, pip, plate, riffle, type Scene } from './scenes';
import { loadPlayerOnIntent, painted } from './load-player';

const reduce = matchMedia('(prefers-reduced-motion: reduce)');

interface Live {
  scene: Scene;
  stage: HTMLElement;
  top: number;
  len: number;
  on: boolean;
}

const live: Live[] = [];
let frame = 0;

const measure = (l: Live) => {
  l.top = l.scene.section.getBoundingClientRect().top + scrollY;
  l.len = Math.max(1, l.scene.section.offsetHeight - l.stage.offsetHeight);
};

const progress = (l: Live) => (reduce.matches ? l.scene.still : Math.min(1, Math.max(0, (scrollY - l.top) / l.len)));

function draw() {
  frame = 0;
  for (const l of live) if (l.on) l.scene.update(progress(l));
}

const request = () => {
  if (!frame) frame = requestAnimationFrame(draw);
};

const visible = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const l = live.find((x) => x.scene.section === entry.target);
      if (!l) continue;
      l.on = entry.isIntersecting;
      if (l.on) l.scene.update(progress(l));
    }
  },
  { rootMargin: '10% 0px' },
);

function add(scene: Scene) {
  const l: Live = { scene, stage: scene.section.querySelector('.stage') as HTMLElement, top: 0, len: 1, on: false };
  live.push(l);
  measure(l);
  scene.layout();
  scene.update(progress(l));
  visible.observe(scene.section);
  return scene;
}

function relayout() {
  for (const l of live) measure(l);
  for (const l of live) l.scene.layout();
  request();
}

addEventListener('scroll', request, { passive: true });
new ResizeObserver(() => relayout()).observe(document.body);
reduce.addEventListener('change', relayout);
// Measures taken on the fallback faces are taken again on the real ones.
void document.fonts.ready.then(relayout);

/** Builds a scene when its section is within a screen of view. */
function soon(id: string, make: (s: HTMLElement) => Scene, then?: () => void) {
  const section = document.getElementById(id);
  if (!section) return;
  const io = new IntersectionObserver(
    ([entry]) => {
      if (!entry?.isIntersecting) return;
      io.disconnect();
      add(make(section));
      then?.();
    },
    { rootMargin: '100% 0px' },
  );
  io.observe(section);
}

const idle = (fn: () => void) => ('requestIdleCallback' in window ? requestIdleCallback(fn, { timeout: 2000 }) : setTimeout(fn, 300));

/** Save-Data, or a 2G connection: nothing is fetched ahead of the visitor's own move towards it. */
const frugal = () => {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  return !!connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType ?? '');
};

/** The visitor's first move down the page. */
const moved = new Promise<void>((resolve) => {
  if (scrollY > 0) return resolve();
  const types = ['scroll', 'wheel', 'touchmove', 'keydown'] as const;
  const done = () => {
    for (const type of types) removeEventListener(type, done);
    resolve();
  };
  for (const type of types) addEventListener(type, done, { passive: true });
});

// The hero is the headline and the player, laid out by the stylesheet alone: no scene to build. The player's first
// key and first press are held from this moment, not from the first frame: a key that came before that frame was
// left to the page (Space scrolled it, and the film never started). Starting the player still waits for its poster.
const host = document.getElementById('player');
const player = host ? loadPlayerOnIntent(host, idle) : Promise.resolve();

requestAnimationFrame(() => {

  // The chapters are below the first screen: their scenes are built once the first screen has painted (on a phone the
  // Riffle starts within a screen of the top, and built at once its pictures were fetched ahead of the poster), or at
  // the visitor's first move if that comes sooner. The Riffle's sheet of photographs, the page's heaviest picture,
  // waits for the player to stand, so the two never share a slow connection; on a frugal one, for the first move.
  const sheet = frugal() ? moved : Promise.race([moved, player.then(() => new Promise<void>((resolve) => idle(resolve)))]);
  const scenes = () => {
    soon('riffle', (section) => riffle(section, sheet));
    soon('edge', edge);
    soon('plate', plate);
    soon('corner', corner);
    soon('pip', pip);
  };
  void Promise.race([moved, host ? painted(host) : Promise.resolve()]).then(scenes);
});
