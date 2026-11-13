/**
 * The player, loaded after the page. It starts once the page has loaded, its poster is on screen and the main thread
 * is idle, or sooner at the first sign that it's wanted: the pointer over it, focus reaching it, a press on its
 * poster, or one of its keys. That key (or press) is held, the player starts, and the key is handed to it, so the
 * page's promise holds: keys work without clicking the player, and nothing pressed before it stands is lost.
 *
 * A scroll or a touch before that idle moment says the player will be wanted soon, not this instant. Mounting it is
 * tens of milliseconds of script, and spent mid-scroll they are a stutter in the book's turn; so then it mounts when
 * the page next comes to rest, or, if the page never rests, once the book has landed and its poster stands still in the
 * player's box (`urgent`).
 *
 * Which keys: the skin's keymap (src/skins/flipbook/keymap.ts), claimed on the same terms as its page-wide forwarding
 * (src/shared/extras/page-keys.ts): nothing focused or plain text focused, no Ctrl, Alt or Cmd, the player at least a
 * quarter in view, and page keys not turned off.
 */

/** How long the page has to hold still after a scroll before the player mounts, in milliseconds. */
const REST = 120;

const KEYS = new Set([' ', 'k', 'K', 'j', 'J', 'l', 'L', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'm', 'M', '<', '>', 'c', 'C', 'f', 'F', 'i', 'I', 't', 'T', 'b', 'B', '[', ']', 'n', 'N', 'p', 'P', '?', ...'0123456789']);
const INTERACTIVE = 'a[href], button, input, select, textarea, summary, [contenteditable], [role="button"], [role="link"], [role="slider"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="textbox"], [role="combobox"]';

const pageKeysOn = () => {
  try {
    return localStorage.getItem('x-page-keys') !== 'off';
  } catch {
    return true;
  }
};

const inView = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
  const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
  return (w * h) / (r.width * r.height) >= 0.25;
};

const claims = (event: KeyboardEvent, host: HTMLElement) => {
  if (!KEYS.has(event.key) || event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return false;
  const target = event.target instanceof Element ? event.target : null;
  if (target && target !== document.body && target !== document.documentElement) {
    if (target.closest(INTERACTIVE) || (target as HTMLElement).isContentEditable) return false;
  }
  return pageKeysOn() && inView(host);
};

/**
 * The player's chunks, as this build names them. Vite lists a dynamic import's chunks in the importing module (its
 * preload map, `__vite__mapDeps`); reading this module's own text, already in the cache, finds them without running
 * anything. Scripts are modulepreloaded (fetched and compiled), styles preloaded (fetched, not applied). In
 * development there are no hashed chunks, and nothing is prefetched.
 */
let prefetched = false;
async function prefetch() {
  if (prefetched || import.meta.env.DEV) return;
  prefetched = true;
  try {
    const source = await (await fetch(import.meta.url, { cache: 'force-cache' })).text();
    const map = source.match(/m\.f=\[([^\]]*)\]/)?.[1] ?? '';
    for (const [, file] of map.matchAll(/"([^"]+)"/g)) {
      const link = document.createElement('link');
      const css = file.endsWith('.css');
      link.rel = css ? 'preload' : 'modulepreload';
      if (css) link.as = 'style';
      link.href = new URL(file, import.meta.url).href;
      document.head.append(link);
    }
  } catch {
    // Without the prefetch the player still loads on intent, from the network.
  }
}

const whenReady = (host: HTMLElement) =>
  new Promise<HTMLElement | null>((resolve) => {
    const started = performance.now();
    const look = () => {
      const container = host.querySelector<HTMLElement>('media-container');
      if (container?.querySelector('video')) resolve(container);
      else if (performance.now() - started > 8000) resolve(null);
      else requestAnimationFrame(look);
    };
    look();
  });

/**
 * Resolves once the poster the page laid in the host has been drawn: decoded, and two frames on (the first frame
 * after a decode is the one that paints it). Without a poster, or with one that fails, two frames from now.
 */
export const painted = (host: HTMLElement) =>
  new Promise<void>((resolve) => {
    const frames = () => requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    const poster = host.querySelector<HTMLImageElement>('img.player-poster');
    if (poster) void poster.decode().then(frames, frames);
    else frames();
  });

/** Returns a promise that settles once the player stands in the host (or has failed to). */
export function loadPlayerOnIntent(host: HTMLElement, idle: (fn: () => void) => void, urgent: () => boolean = () => false): Promise<void> {
  let mounted = () => {};
  const ready = new Promise<void>((resolve) => (mounted = resolve));
  let started: Promise<HTMLElement | null> | null = null;
  /** The player stands in the host (or has failed to): from then on its keys are its own. */
  let stood = false;
  let rest = 0;
  const soon = ['scroll', 'touchstart'] as const;
  // `fb-want`: the page asks for the player now (a control of its own that acts on it was used).
  const now = ['pointerenter', 'focusin', 'fb-want'] as const;

  const start = () => {
    if (started) return started;
    clearTimeout(rest);
    for (const type of soon) removeEventListener(type, onSoon);
    for (const type of now) host.removeEventListener(type, onNow);
    started = import('@preview/site/player')
      // `data-features` on the host is the page's choice of `features` (the full book when unset).
      .then(({ mount }) => mount(host, { features: host.dataset.features || undefined }))
      .then(() => whenReady(host));
    const stand = () => {
      stood = true;
      mounted();
    };
    void started.then(stand, stand);
    return started;
  };
  const onNow = () => void start();
  // At rest: no scroll event for a while, and the page where that scroll left it two frames on. (A busy main thread
  // holds scroll events back while the page goes on moving; the position tells the two apart.)
  const settle = () => {
    const y = scrollY;
    requestAnimationFrame(() => requestAnimationFrame(() => (scrollY === y ? void start() : onSoon())));
  };
  const onSoon = () => {
    if (started) return;
    // Its chunks are fetched and compiled now if idle time hasn't got to them yet; running them waits for the rest.
    void prefetch();
    if (urgent()) return void start();
    clearTimeout(rest);
    rest = window.setTimeout(settle, REST);
  };

  // The first player key: held, the player started, then the key handed to it as the page's forwarding would. Held
  // until the player stands, not only until it starts: on a slow connection its script is seconds in coming, and a
  // key pressed in that wait was left to the page (Space scrolled it).
  const onKey = (event: KeyboardEvent) => {
    if (stood || !claims(event, host)) return;
    event.preventDefault();
    const init: KeyboardEventInit = { key: event.key, code: event.code, location: event.location, shiftKey: event.shiftKey, bubbles: true, cancelable: true, composed: true };
    const t0 = performance.now();
    document.removeEventListener('keydown', onKey);
    void start().then((container) => {
      if (!container) return;
      container.dispatchEvent(new KeyboardEvent('keydown', init));
      container.dispatchEvent(new KeyboardEvent('keyup', init));
      performance.measure('book:first-key', { start: t0, end: performance.now() });
    });
  };

  // A press on the poster before the player stands there is a press on its Play disc, the one thing the poster shows
  // to press: held like the first key, and played once the player can. Once only, and only if the film is still
  // paused; a press that lands on the player itself is the player's own.
  const onPress = (event: MouseEvent) => {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest('media-container'))) return;
    host.removeEventListener('click', onPress);
    void start().then((container) => {
      const video = container?.querySelector('video');
      if (video?.paused) container?.querySelector<HTMLElement>('media-play-button')?.click();
    });
  };

  for (const type of soon) addEventListener(type, onSoon, { passive: true });
  for (const type of now) host.addEventListener(type, onNow);
  host.addEventListener('click', onPress);
  void ready.then(() => host.removeEventListener('click', onPress));
  document.addEventListener('keydown', onKey);
  if (scrollY > 0) void start();

  // With the page loaded, its poster on screen and the main thread idle, the player starts on its own: the headline
  // and the cover have painted, nothing is moving yet, and its work is spent where no frame waits on it. (On a fast
  // connection `load` and an idle moment both come before the first paint: started there, the player's 125 kB of
  // script was fetched and run ahead of the page's largest picture.)
  const afterLoad = () => void painted(host).then(() => idle(() => void start()));
  if (document.readyState === 'complete') afterLoad();
  else addEventListener('load', afterLoad, { once: true });
  return ready;
}
