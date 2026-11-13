import { loadBook, videoIn } from './book';
import { FEATURES, type Feature, parseFeatures } from './feature-list';

/**
 * The book's features. Flipbook is a small core that loads at once, and the book's extras, each opt-in, loaded on
 * first use (or on idle once the page has settled) and never required.
 *
 * `features` on `<video-player>` chooses them: a space-separated list of names, or a preset. `essential` is the core
 * alone; `book` is every extra, and the default when the attribute is missing. `features="essential plate ribbons"`
 * is the core and those two. The attribute can change at any time: an extra turned off closes, leaves the DOM and
 * gives focus back sensibly; one turned on loads. Nothing reloads the player or interrupts playback.
 *
 * Loading:
 * - The core imports nothing from the extras. Each is a dynamic `import()` of `extras/<name>.ts`, which brings its
 *   modules and its CSS (adopted as a stylesheet) and defines its elements as it evaluates.
 * - After the page's `load` and its first paint, each enabled extra is fetched on idle, one per idle period, so first
 *   use is instant. Under Save-Data or a 2G connection nothing is fetched ahead: extras load on first use only.
 * - The cover is on screen from the start, so its extra loads at once.
 * - A trigger that fires before its extra has arrived (T, B, `[`, `]`, P, a click on its key, the PiP key, hovering
 *   the fore-edge, a pause) waits for it and then runs, as it would have: nothing pressed is dropped.
 * - A disabled extra is never fetched, its keys do nothing and leave the shortcuts card, and its elements aren't in
 *   the DOM.
 *
 * The container carries what's on and what has arrived, for styles and tests: `data-fb-features` and
 * `data-fb-loaded`. It hears `fb-features` after a change and `fb-feature-load` when an extra has arrived.
 */

export { FEATURES, type Feature, formatFeatures, PRESETS, type Preset, parseFeatures } from './feature-list';

/** The element `features` is read from: the player around the container (or the container, outside a player). */
function holder(container: Element): Element {
  return container.closest('video-player') ?? container;
}

const parsed = new WeakMap<Element, { value: string | null; pageless: boolean; on: Set<Feature> }>();

/**
 * The extras that are made of the book's pages: its turns, the deck and the flip, the contents, the plate and its
 * strip, the corner and the prompt that lead to the next chapter, and the hints for those gestures. A film given with
 * no storyboard has no pages, so on it they are off, whatever `features` asks: their keys leave the bar and the
 * shortcuts card, and nothing of them is fetched. What is left is the whole player, and the extras that need no
 * pages (the cover, bookmarks, a kept page, picture-in-picture, intertitles).
 */
const PAGES: readonly Feature[] = ['turns', 'deck', 'contents', 'plate', 'curl', 'next', 'hints'];

/** Players whose film has no pages (`data-fb-pageless`, set below as soon as that is known). */
function pageless(container: Element): boolean {
  return (container.closest('media-container') ?? container).hasAttribute('data-fb-pageless');
}

export function featuresOf(container: Element): Set<Feature> {
  const host = holder(container);
  const value = host.getAttribute('features');
  const bare = pageless(container);
  const hit = parsed.get(host);
  if (hit && hit.value === value && hit.pageless === bare) return hit.on;
  const on = parseFeatures(value);
  if (bare) for (const name of PAGES) on.delete(name);
  parsed.set(host, { value, pageless: bare, on });
  return on;
}

/** Whether an extra is on for this player. Anything outside a Flipbook player counts as the default, every extra. */
export function isOn(container: Element | null | undefined, name: Feature): boolean {
  const root = container?.closest?.('media-container') ?? container;
  return root ? featuresOf(root).has(name) : true;
}

/* ─── Loading ───────────────────────────────────────────────────────────── */

const LOAD: Record<Feature, () => Promise<unknown>> = {
  turns: () => import('./extras/turns'),
  deck: () => import('./extras/deck'),
  contents: () => import('./extras/contents'),
  ribbons: () => import('./extras/ribbons'),
  plate: () => import('./extras/plate'),
  curl: () => import('./extras/curl'),
  cover: () => import('./extras/cover'),
  pip: () => import('./extras/pip'),
  hints: () => import('./extras/hints'),
  next: () => import('./extras/next'),
  float: () => import('./extras/float'),
  ear: () => import('./extras/ear'),
  tear: () => import('./extras/tear'),
  intertitle: () => import('./extras/intertitle'),
};

const pending = new Map<Feature, Promise<void>>();
const arrived = new Set<Feature>();

/** Whether an extra's module has arrived and defined its elements. */
export function loaded(name: Feature): boolean {
  return arrived.has(name);
}

/**
 * Loads an extra (its modules and its CSS), once per page; the elements it defines upgrade as it evaluates. A failed
 * fetch is forgotten, so the next use tries again.
 */
export function need(name: Feature): Promise<void> {
  let load = pending.get(name);
  if (!load) {
    load = LOAD[name]().then(
      () => {
        arrived.add(name);
        for (const container of containers()) {
          mark(container);
          container.dispatchEvent(new CustomEvent('fb-feature-load', { detail: { name } }));
        }
      },
      (error: unknown) => {
        pending.delete(name);
        throw error;
      },
    );
    pending.set(name, load);
  }
  return load;
}

/**
 * Once an extra has arrived, a moment for its elements to finish connecting: most read the book (cached by then) in a
 * microtask and are ready a task later.
 */
export async function settled(container: Element): Promise<void> {
  await loadBook(container, new AbortController().signal).catch(() => null);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** An extra's stylesheet, adopted after the core's (so it wins ties, as it did when it came later in one bundle). */
export function adopt(css: string): void {
  if (typeof document === 'undefined' || !css) return;
  if ('adoptedStyleSheets' in Document.prototype && 'replaceSync' in CSSStyleSheet.prototype) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    // A Document picture-in-picture window open now copies it too (pip.ts).
    document.dispatchEvent(new CustomEvent('fb-sheet', { detail: sheet }));
    return;
  }
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
}

/** Save-Data, or a 2G connection: nothing is fetched ahead of use. */
function frugal(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  return !!connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType ?? '');
}

/** The order extras are fetched ahead in: the likeliest first use first. */
const AHEAD: Feature[] = ['deck', 'turns', 'contents', 'ribbons', 'plate', 'curl', 'pip', 'next', 'hints', 'float', 'ear', 'tear', 'intertitle'];

let afterLoad: Promise<void> | null = null;

/** After the page's `load` and the paint that follows it. */
function pageSettled(): Promise<void> {
  afterLoad ??= new Promise<void>((resolve) => {
    const painted = () => requestAnimationFrame(() => setTimeout(resolve, 0));
    if (document.readyState === 'complete') painted();
    else window.addEventListener('load', painted, { once: true });
  });
  return afterLoad;
}

function idle(): Promise<void> {
  return new Promise((resolve) => {
    if ('requestIdleCallback' in window) requestIdleCallback(() => resolve(), { timeout: 2000 });
    else setTimeout(resolve, 120);
  });
}

async function prefetch(container: HTMLElement) {
  if (frugal()) return;
  await pageSettled();
  for (const name of AHEAD) {
    if (!isOn(container, name) || loaded(name)) continue;
    // The mini player only docks on a page that asks for it.
    if (name === 'float' && !container.closest('[data-fb-float]')) continue;
    await idle();
    if (!container.isConnected || !isOn(container, name)) continue;
    await need(name).catch(() => undefined);
  }
}

/* ─── The parts of each extra in the player ─────────────────────────────── */

interface Part {
  selector: string;
  /** Every one of these must be on for the part to be in the DOM. */
  needs: Feature[];
}

const PARTS: Part[] = [
  { selector: 'fb-turn', needs: ['turns'] },
  { selector: 'fb-riffle', needs: ['cover', 'turns'] },
  { selector: 'fb-deck', needs: ['deck'] },
  { selector: 'fb-flip', needs: ['deck'] },
  { selector: 'fb-curl', needs: ['curl'] },
  { selector: 'fb-jacket, fb-scan, fb-cover', needs: ['cover'] },
  { selector: 'fb-plate, [data-fb-menu="plate"]', needs: ['plate'] },
  { selector: 'fb-contents, [data-fb-action="contents"]', needs: ['contents'] },
  { selector: 'fb-ribbons, [data-fb-action="bookmark"]', needs: ['ribbons'] },
  { selector: 'fb-hints', needs: ['hints'] },
  { selector: 'fb-next', needs: ['next'] },
  { selector: 'fb-pip', needs: ['pip'] },
  { selector: 'fb-float', needs: ['float'] },
  // The dog-ear is the bookmarks' mark on the page: it needs them.
  { selector: 'fb-ear', needs: ['ribbons', 'ear'] },
  { selector: 'fb-tear, [data-fb-action="keep"], [data-fb-menu="keep"]', needs: ['tear'] },
  { selector: 'fb-intertitle', needs: ['intertitle'] },
];

/** What each extra leaves on the container while it's working, cleared when it's turned off. */
const STATES: Partial<Record<Feature, string[]>> = {
  turns: ['data-fb-turning', 'data-fb-riffle'],
  deck: ['data-fb-deck', 'data-fb-ready'],
  contents: ['data-fb-contents'],
  plate: ['data-fb-plate', 'data-fb-plate-leaving', 'data-fb-strip'],
  cover: ['data-fb-cover', 'data-fb-jacket', 'data-fb-scan', 'data-fb-riffle'],
  float: ['data-fb-dock'],
  tear: ['data-fb-tearing'],
  intertitle: ['data-fb-intertitle'],
};

interface Stashed {
  part: Part;
  element: Element;
  placeholder: Comment;
}

const stashes = new WeakMap<HTMLElement, Stashed[]>();
/** Players whose page wrote `data-fb-opening` itself: the cover leaving doesn't take it away. */
const authored = new WeakSet<HTMLElement>();
const applied = new WeakMap<HTMLElement, Set<Feature>>();

type Closable = HTMLElement & { close?: (returnFocus?: boolean, quietly?: boolean) => void; leave?: () => void };

/** Puts away what an extra has open before it leaves: its own close returns focus where its page said it would. */
function closeOut(element: Element) {
  const part = element as Closable;
  // Focus goes back only if it was in there: a switch clicked outside the player keeps it.
  const inside = part.contains(part.ownerDocument.activeElement);
  try {
    if (part.matches('fb-pip')) part.leave?.();
    else if (part.matches('fb-contents')) part.close?.(inside, true);
    else if (part.matches('fb-plate')) part.close?.(inside);
    else if (part.matches('fb-float')) part.close?.();
  } catch {
    // An extra that can't close cleanly still leaves; focus is handled below.
  }
}

function tooltipsFor(container: HTMLElement, element: Element): Element[] {
  const ids = [element.id, ...Array.from(element.querySelectorAll('[id]'), (el) => el.id)].filter(Boolean);
  return ids.flatMap((id) => Array.from(container.querySelectorAll(`media-tooltip[trigger="${CSS.escape(id)}"]`)));
}

/** Takes the parts of disabled extras out (leaving a marker where each was) and puts back those of enabled ones. */
function apply(container: HTMLElement) {
  const on = featuresOf(container);
  const before = applied.get(container);
  const stash = stashes.get(container) ?? [];
  stashes.set(container, stash);
  const doc = container.ownerDocument;
  const active = doc.activeElement;
  let lostFocus = false;

  // Back in: everything whose extras are all on again, where it was. A fresh copy, not the element that left: a
  // Video.js element taken out and put back keeps its player controllers unsubscribed (PlayerController drops its
  // store on disconnect and doesn't take it up again), so it would never hear the player. A copy starts as a fresh
  // load's does, at the player's current state.
  // In the markup's order, so a part that looks for another on connecting (the hints for the deck) finds it.
  for (const entry of [...stash]) {
    if (!entry.part.needs.every((name) => on.has(name))) continue;
    if (entry.placeholder.isConnected) entry.placeholder.replaceWith(entry.element.cloneNode(true));
    stash.splice(stash.indexOf(entry), 1);
  }

  // Out: the parts of anything turned off.
  for (const part of PARTS) {
    if (part.needs.every((name) => on.has(name))) continue;
    for (const element of Array.from(container.querySelectorAll(part.selector))) {
      if (!element.isConnected) continue;
      closeOut(element);
      for (const leaving of [element, ...tooltipsFor(container, element)]) {
        if (!leaving.isConnected) continue;
        if (active && (leaving.contains(active) || leaving.contains(doc.activeElement))) lostFocus = true;
        const placeholder = doc.createComment(` ${part.needs.join(' + ')} `);
        leaving.replaceWith(placeholder);
        stash.push({ part, element: leaving, placeholder });
      }
    }
  }

  if (before) {
    for (const name of before) {
      if (on.has(name)) continue;
      for (const state of STATES[name] ?? []) container.removeAttribute(state);
      if (name === 'cover') {
        // The jacket placed the play disc in its free room; on a plain poster it sits in the middle again.
        const disc = container.querySelector<HTMLElement>('.fb-cover-play');
        disc?.style.removeProperty('top');
        disc?.style.removeProperty('left');
        // And the opening it chose goes with it, unless the page wrote one itself (it comes back with the cover).
        if (!authored.has(container)) container.removeAttribute('data-fb-opening');
      }
    }
  }

  // Focus that was in something that left, and that its own close didn't put back (a panel returns it to its opener),
  // goes to the play key, where the film is controlled.
  const now = doc.activeElement;
  if (lostFocus && (!now || now === doc.body || !now.isConnected || !container.contains(now))) {
    const play = container.querySelector<HTMLElement>('.fb-play');
    (play ?? container).focus({ preventScroll: true });
  }

  applied.set(container, new Set(on));
  mark(container);
  container.dispatchEvent(new CustomEvent('fb-features', { bubbles: true, detail: { on: [...on] } }));

  // Turned on while the page is up: it loads now.
  if (before) for (const name of on) if (!before.has(name)) void need(name).catch(() => undefined);
}

function mark(container: HTMLElement) {
  const on = featuresOf(container);
  const list = FEATURES.filter((name) => on.has(name));
  const enabled = list.join(' ');
  const ready = list.filter((name) => arrived.has(name)).join(' ');
  if (container.getAttribute('data-fb-features') !== enabled) container.setAttribute('data-fb-features', enabled);
  if (container.getAttribute('data-fb-loaded') !== ready) container.setAttribute('data-fb-loaded', ready);
}

/* ─── Triggers that arrive before their extra ───────────────────────────── */

const FIELD = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

function documentPiP(): boolean {
  return typeof window !== 'undefined' && 'documentPictureInPicture' in window;
}

/** The extra a key belongs to, if it's one of the book's. N and `?` are the core's. */
function keyFeature(event: KeyboardEvent): Feature | null {
  const key = event.key;
  if (key === 't' || key === 'T') return 'contents';
  if (key === 'b' || key === 'B' || key === '[' || key === ']') return 'ribbons';
  if (key === 'p' || key === 'P') return 'plate';
  if (key === 's' || key === 'S') return 'tear';
  if ((key === 'i' || key === 'I') && !event.shiftKey && documentPiP()) return 'pip';
  return null;
}

function clickFeature(target: Element | null): { feature: Feature; trigger: Element } | null {
  const action = target?.closest('[data-fb-action]');
  const name = action?.getAttribute('data-fb-action');
  if (action && name === 'contents') return { feature: 'contents', trigger: action };
  if (action && name === 'bookmark') return { feature: 'ribbons', trigger: action };
  if (action && name === 'keep') return { feature: 'tear', trigger: action };
  const pip = target?.closest('media-pip-button');
  if (pip && documentPiP()) return { feature: 'pip', trigger: pip };
  return null;
}

/** Fetches an extra the moment it's wanted, once its player has it on. */
function want(container: HTMLElement, name: Feature) {
  if (isOn(container, name) && !loaded(name)) void need(name).catch(() => undefined);
}

/** Waits for an extra, then runs what was asked for, unless it was turned off meanwhile. */
function later(container: HTMLElement, name: Feature, run: () => void) {
  need(name)
    .then(() => settled(container))
    .then(() => {
      if (isOn(container, name)) run();
    })
    .catch(() => undefined);
}

function arm(container: HTMLElement) {
  const options = { capture: true } as const;

  container.addEventListener('keydown', (event) => {
    const name = keyFeature(event);
    if (!name || !isOn(container, name) || loaded(name)) return;
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(FIELD)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.repeat) return;
    const init: KeyboardEventInit = {
      key: event.key,
      code: event.code,
      location: event.location,
      shiftKey: event.shiftKey,
      bubbles: true,
      cancelable: true,
      composed: true,
    };
    later(container, name, () => {
      const into = target?.isConnected && container.contains(target) ? target : container;
      into.dispatchEvent(new KeyboardEvent('keydown', init));
    });
  }, options);

  container.addEventListener('click', (event) => {
    const hit = clickFeature(event.target instanceof Element ? event.target : null);
    if (!hit || !isOn(container, hit.feature) || loaded(hit.feature)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const detail = event.detail;
    later(container, hit.feature, () => {
      if (!hit.trigger.isConnected) return;
      hit.trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, detail }));
    });
  }, options);

  // The fore-edge: the deck is wanted the moment a pointer or the keyboard reaches it. A mouse still resting on the
  // edge when it arrives opens it, as its next move would have; a drag already under way stays the slider's own.
  let rest: { x: number; y: number } | null = null;
  const edge = (event: Event) => (event.target instanceof Element ? event.target.closest('media-time-slider') : null);
  container.addEventListener('pointermove', (event) => {
    rest = edge(event) && event.pointerType === 'mouse' ? { x: event.clientX, y: event.clientY } : null;
  }, { passive: true });
  container.addEventListener('pointerover', (event) => {
    const slider = edge(event);
    if (!slider || !isOn(container, 'deck') || loaded('deck')) return;
    if (event.pointerType === 'mouse') rest = { x: event.clientX, y: event.clientY };
    later(container, 'deck', () => {
      const at = rest;
      if (!at || !slider.matches(':hover') || slider.hasAttribute('data-dragging')) return;
      const init = { clientX: at.x, clientY: at.y, pointerType: 'mouse', isPrimary: true, composed: true };
      slider.dispatchEvent(new PointerEvent('pointerenter', init));
      slider.dispatchEvent(new PointerEvent('pointermove', { ...init, bubbles: true }));
    });
  }, { passive: true });
  container.addEventListener('focusin', (event) => {
    if (edge(event)) want(container, 'deck');
    if (event.target instanceof Element && event.target.closest('media-pip-button')) want(container, 'pip');
  });
  container.addEventListener('pointerover', (event) => {
    if (event.target instanceof Element && event.target.closest('media-pip-button')) want(container, 'pip');
  }, { passive: true });

  // Settings' "Keep this page" and "Plate" (a menu item says `select`, not `click`), before their extra has arrived.
  container.addEventListener('select', (event) => {
    const item = event.target instanceof Element ? event.target.closest('[data-fb-menu="keep"], [data-fb-menu="plate"]') : null;
    if (!item) return;
    const [name, ask] = item.matches('[data-fb-menu="plate"]') ? (['plate', 'fb-plate-ask'] as const) : (['tear', 'fb-keep'] as const);
    if (!isOn(container, name) || loaded(name)) return;
    later(container, name, () => container.dispatchEvent(new CustomEvent(ask)));
  });
  // A press on the paused page may be the start of a pull (tear.ts): its extra is wanted by then. So is the dog-ear,
  // the moment the controls are asked for.
  container.addEventListener('pointerdown', () => {
    if (container.hasAttribute('data-fb-print')) want(container, 'tear');
    want(container, 'ear');
  }, { passive: true, capture: true });
  // A link to a page of this film (`#p=31`): the extra that reads it is wanted at once.
  if (/[#&](p|t)=\d/.test(location.hash)) want(container, 'tear');

  // Any hand on the player: the hints are for the gestures that follow.
  container.addEventListener('pointerdown', () => want(container, 'hints'), { passive: true, capture: true });
  container.addEventListener('keydown', () => want(container, 'hints'), options);

  queueMicrotask(() => {
    const media = videoIn(container);
    if (!media) return;
    media.addEventListener('pause', () => {
      want(container, 'curl');
      want(container, 'ear');
      want(container, 'tear');
      // The paused page prints its strip of frames: the plate's extra is wanted with the print.
      want(container, 'plate');
    });
    media.addEventListener('play', () => {
      if (container.closest('[data-fb-float]')) want(container, 'float');
      want(container, 'next');
    });
  });
}

/* ─── Players on the page ───────────────────────────────────────────────── */

const SKIN = 'media-container[data-theme="flipbook"]';
const known = new Set<WeakRef<HTMLElement>>();
const seen = new WeakSet<HTMLElement>();

function containers(): HTMLElement[] {
  const live: HTMLElement[] = [];
  for (const ref of known) {
    const container = ref.deref();
    if (container) live.push(container);
    else known.delete(ref);
  }
  return live;
}

function setup(container: HTMLElement) {
  if (seen.has(container)) return;
  seen.add(container);
  known.add(new WeakRef(container));
  if (container.hasAttribute('data-fb-opening')) authored.add(container);
  // A film with no storyboard has no pages. Known at once from the markup where it can be (no thumbnails track, and
  // not a Mux film, which brings its own), so nothing of the pages' extras is ever in the player; and again when the
  // book has been read (a track that names no page; or one added after all).
  const media = container.querySelector('mux-video, hls-video, hlsjs-video, video');
  const named = !!media?.querySelector('track[kind="metadata"][label="thumbnails"]') || /stream\.mux\.com\//.test(media?.getAttribute('src') ?? '');
  if (media && !named) container.toggleAttribute('data-fb-pageless', true);
  apply(container);
  void loadBook(container, new AbortController().signal).then((book) => {
    if (container.hasAttribute('data-fb-pageless') === !book) return;
    container.toggleAttribute('data-fb-pageless', !book);
    apply(container);
  }, () => undefined);
  new MutationObserver(() => apply(container)).observe(holder(container), { attributes: true, attributeFilter: ['features'] });
  arm(container);
  // The cover is the player at rest: it's in view from the start, so it's wanted now.
  want(container, 'cover');
  void prefetch(container);
}

function scan(root: ParentNode) {
  if (root instanceof HTMLElement && root.matches(SKIN)) setup(root);
  for (const container of root.querySelectorAll<HTMLElement>(SKIN)) setup(container);
}

if (typeof document !== 'undefined') {
  scan(document);
  new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) if (node instanceof Element) scan(node);
  }).observe(document.documentElement, { childList: true, subtree: true });
}
