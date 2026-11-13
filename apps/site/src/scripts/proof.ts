/**
 * The page's own controls on the hero's player, and the visitor's settings read live.
 *
 * - The switch under the player sets `features` on it: `essential` (the core alone) or the full book. The skin takes
 *   the change live (src/skins/flipbook/features.ts): nothing reloads, the film keeps its time and goes on playing or
 *   stays paused. Before the player stands, the choice waits on the host (`data-features`, read by load-player.ts),
 *   and the address keeps it (`?features=essential`), so a link opens the player as it was shown.
 * - The two frame keys pause the film on the brightest and the darkest frame the contrast was measured over, and take
 *   the visitor to the player.
 * - "Your settings" reads six preferences from the browser and follows each as it changes.
 *
 * Nothing here runs before the first frame has painted, and nothing moves on its own.
 */

type Preset = 'essential' | 'book';

const host = document.getElementById('player');
const address = () => new URL(location.href);

// Read now, ahead of the player's own start (main.ts starts it a frame from here).
if (host && address().searchParams.get('features') === 'essential') host.dataset.features = 'essential';

/** The player's video, once the player stands; asking for it starts the player if it hasn't started. */
function film(): Promise<HTMLVideoElement | null> {
  return new Promise((resolve) => {
    if (!host) return resolve(null);
    host.dispatchEvent(new Event('fb-want'));
    const started = performance.now();
    const look = () => {
      const video = host.querySelector('media-container')?.querySelector('video');
      if (video) resolve(video);
      else if (performance.now() - started > 8000) resolve(null);
      else requestAnimationFrame(look);
    };
    look();
  });
}

/* ─── Essential or the full book ───────────────────────────────────────── */

function preset(group: HTMLElement) {
  const radios = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];

  const show = (value: Preset, focus = false) => {
    const index = Math.max(0, radios.findIndex((radio) => radio.dataset.value === value));
    group.style.setProperty('--i', String(index));
    group.dataset.value = value;
    radios.forEach((radio, i) => {
      radio.setAttribute('aria-checked', String(i === index));
      radio.tabIndex = i === index ? 0 : -1;
    });
    if (focus) radios[index]?.focus();
  };

  const apply = (value: Preset) => {
    if (!host) return;
    if (value === 'book') delete host.dataset.features;
    else host.dataset.features = value;
    const player = host.querySelector('video-player');
    if (player) {
      if (value === 'book') player.removeAttribute('features');
      else player.setAttribute('features', value);
    } else host.dispatchEvent(new Event('fb-want'));
    const url = address();
    if (value === 'book') url.searchParams.delete('features');
    else url.searchParams.set('features', value);
    history.replaceState(history.state, '', url);
  };

  const choose = (index: number, focus: boolean) => {
    const radio = radios[index];
    if (!radio) return;
    const value = radio.dataset.value as Preset;
    const changed = radio.getAttribute('aria-checked') !== 'true';
    show(value, focus);
    if (changed) apply(value);
  };

  radios.forEach((radio, i) => {
    radio.addEventListener('click', () => choose(i, false));
    radio.addEventListener('keydown', (event) => {
      const last = radios.length - 1;
      const next = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: last }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      choose(next < 0 ? last : next > last ? 0 : next, true);
    });
  });

  // The address's choice, shown without travel: the thumb is where it belongs from the first frame it's looked at.
  if (host?.dataset.features === 'essential') {
    group.dataset.still = '';
    show('essential');
    requestAnimationFrame(() => requestAnimationFrame(() => delete group.dataset.still));
  }
}

/* ─── The brightest frame, and the darkest ─────────────────────────────── */

/**
 * A frame key pauses the film on its frame at once: nothing lays itself over a paused frame (the skin's plate opens
 * only on P or its key), so there is nothing to wait out. (scripts/site-check.mjs presses the keys for real.)
 */
function frameKeys(keys: HTMLButtonElement[]) {
  for (const key of keys) {
    key.addEventListener('click', async () => {
      const time = Number(key.dataset.frame);
      if (!host || !Number.isFinite(time)) return;
      // Where the visitor is going first: the player's box is on the page from the start, whatever stands in it.
      host.scrollIntoView({ block: 'center' });
      host.focus({ preventScroll: true });
      const video = await film();
      if (!video) return;
      if (video.readyState < HTMLMediaElement.HAVE_METADATA) await new Promise((resolve) => video.addEventListener('loadedmetadata', resolve, { once: true }));
      video.pause();
      video.currentTime = time;
    });
  }
}

/* ─── Your settings ────────────────────────────────────────────────────── */

type Words = Record<string, Record<string, string>>;

function settings(list: HTMLElement) {
  const words = JSON.parse(list.dataset.values ?? '{}') as Words;
  const unknown = list.dataset.unknown ?? '';
  const query = (text: string) => matchMedia(text);
  const queries = {
    motion: query('(prefers-reduced-motion: reduce)'),
    more: query('(prefers-contrast: more)'),
    less: query('(prefers-contrast: less)'),
    custom: query('(prefers-contrast: custom)'),
    forced: query('(forced-colors: active)'),
    coarse: query('(pointer: coarse)'),
    fine: query('(pointer: fine)'),
    light: query('(prefers-color-scheme: light)'),
  };
  const connection = (navigator as Navigator & { connection?: EventTarget & { saveData?: boolean } }).connection;

  /** Each setting as [the word to show, whether it is set away from the default]. */
  const read = (): Record<string, [string | undefined, boolean]> => ({
    motion: [queries.motion.matches ? words.motion?.on : words.motion?.off, queries.motion.matches],
    contrast: [
      queries.more.matches ? words.contrast?.more : queries.less.matches ? words.contrast?.less : queries.custom.matches ? words.contrast?.custom : words.contrast?.off,
      queries.more.matches || queries.less.matches || queries.custom.matches,
    ],
    forced: [queries.forced.matches ? words.forced?.on : words.forced?.off, queries.forced.matches],
    pointer: [queries.coarse.matches ? words.pointer?.coarse : queries.fine.matches ? words.pointer?.fine : words.pointer?.none, queries.coarse.matches],
    data: [typeof connection?.saveData === 'boolean' ? (connection.saveData ? words.data?.on : words.data?.off) : unknown, connection?.saveData === true],
    scheme: [queries.light.matches ? words.scheme?.light : words.scheme?.dark, false],
  });

  const draw = () => {
    const now = read();
    for (const row of list.querySelectorAll<HTMLElement>('[data-pref]')) {
      const [word, set] = now[row.dataset.pref ?? ''] ?? [];
      const value = row.querySelector<HTMLElement>('[data-pref-value]');
      if (!value || !word) continue;
      if (value.textContent !== word) value.textContent = word;
      row.toggleAttribute('data-set', set);
    }
  };

  for (const q of Object.values(queries)) q.addEventListener('change', draw);
  connection?.addEventListener('change', draw);
  draw();
}

/* ─── The states, as a strip on a phone ────────────────────────────────── */

/** A strip that scrolls sideways is reached and scrolled by keyboard; a grid that doesn't is no Tab stop. */
function strip(list: HTMLElement) {
  const narrow = matchMedia('(max-width: 700px)');
  const set = () => {
    if (narrow.matches) list.tabIndex = 0;
    else list.removeAttribute('tabindex');
  };
  narrow.addEventListener('change', set);
  set();
}

requestAnimationFrame(() => {
  const group = document.querySelector<HTMLElement>('[data-loads]');
  if (group) preset(group);
  frameKeys([...document.querySelectorAll<HTMLButtonElement>('[data-frame]')]);
  const list = document.querySelector<HTMLElement>('[data-prefs]');
  if (list) settings(list);
  const states = document.querySelector<HTMLElement>('[data-states]');
  if (states) strip(states);
});

export {};
