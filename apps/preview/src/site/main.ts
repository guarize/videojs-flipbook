/**
 * The showcase's own script: the frame's width, the player's features, and the player, fetched after the
 * page has painted. The page's text and the poster need nothing from here.
 */

const MIN = 320;

/**
 * The frame's width, set by dragging its corner, by the arrow keys on the corner, or by a preset. The frame is
 * centred, so the corner moves half as far as the width changes: a drag moves the width by twice the pointer.
 */
function resizable(frame: HTMLElement, handle: HTMLElement, seg: HTMLElement, readout: HTMLElement | null) {
  const canvas = frame.parentElement as HTMLElement;
  const presets = [...seg.querySelectorAll<HTMLButtonElement>('button')];
  let frameId = 0;
  let next = 0;

  const set = (width: number | 'fill') => {
    if (width === 'fill') frame.style.removeProperty('--frame-w');
    else frame.style.setProperty('--frame-w', `${Math.round(Math.max(MIN, Math.min(width, canvas.clientWidth)))}px`);
    // The indicator rests on the preset in use; between presets (a drag) it leaves.
    const index = presets.findIndex((button) => button.dataset.width === String(width));
    seg.style.setProperty('--i', String(index));
    seg.toggleAttribute('data-free', index < 0);
    presets.forEach((button, i) => button.setAttribute('aria-pressed', String(i === index)));
  };

  new ResizeObserver(([entry]) => {
    const width = Math.round(entry?.borderBoxSize?.[0]?.inlineSize ?? frame.offsetWidth);
    handle.setAttribute('aria-valuenow', String(width));
    handle.setAttribute('aria-valuetext', `${width} pixels`);
    handle.setAttribute('aria-valuemax', String(Math.round(canvas.clientWidth)));
    if (readout) readout.textContent = `${width} px`;
  }).observe(frame);

  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    handle.toggleAttribute('data-dragging', true);
    const startX = event.clientX;
    const startWidth = frame.offsetWidth;
    const move = (e: PointerEvent) => {
      next = startWidth + (e.clientX - startX) * 2;
      if (frameId) return;
      frameId = requestAnimationFrame(() => {
        frameId = 0;
        set(next);
      });
    };
    const end = () => {
      handle.toggleAttribute('data-dragging', false);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });

  handle.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 64 : 16;
    const width = frame.offsetWidth;
    const target = {
      ArrowLeft: width - step,
      ArrowDown: width - step,
      ArrowRight: width + step,
      ArrowUp: width + step,
      Home: MIN,
      End: 'fill' as const,
    }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    set(target);
  });

  for (const button of presets) {
    button.addEventListener('click', () => {
      const value = button.dataset.width;
      set(value === 'fill' ? 'fill' : Number(value));
    });
  }
}

/**
 * A choice of a few, as a radio group drawn like the width presets: one indicator travels to the choice, the group is
 * one Tab stop, and the arrow keys (or Home and End) move the choice and the focus together. `onChange` hears a new
 * choice; `select` sets one from outside (the URL) without telling it.
 */
function choice(group: HTMLElement, onChange: (value: string) => void) {
  const seg = group.querySelector<HTMLElement>('.seg');
  const radios = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  const select = (value: string, focus = false) => {
    const index = Math.max(0, radios.findIndex((radio) => radio.dataset.value === value));
    seg?.style.setProperty('--i', String(index));
    radios.forEach((radio, i) => {
      radio.setAttribute('aria-checked', String(i === index));
      radio.tabIndex = i === index ? 0 : -1;
    });
    if (focus) radios[index].focus();
    return radios[index].dataset.value ?? value;
  };
  const choose = (index: number, focus: boolean) => {
    const radio = radios[index];
    if (!radio || radio.getAttribute('aria-checked') === 'true') {
      if (focus) radio?.focus();
      return;
    }
    onChange(select(radio.dataset.value ?? '', focus));
  };
  radios.forEach((radio, i) => {
    radio.addEventListener('click', () => choose(i, false));
    radio.addEventListener('keydown', (event) => {
      const last = radios.length - 1;
      const rtl = getComputedStyle(group).direction === 'rtl';
      const next = {
        ArrowRight: rtl ? i - 1 : i + 1,
        ArrowDown: i + 1,
        ArrowLeft: rtl ? i + 1 : i - 1,
        ArrowUp: i - 1,
        Home: 0,
        End: last,
      }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      choose(next < 0 ? last : next > last ? 0 : next, true);
    });
  });
  return { select: (value: string) => void select(value) };
}

/** The view in the address, so a link opens the player as it was shown: `?features=essential`. */
const params = new URLSearchParams(location.search);
let features = params.get('features') === 'essential' ? 'essential' : 'book';
let player: HTMLElement | null = null;

/** Sets the choice on the player (live: nothing reloads) and in the address; the default, the full book, leaves both unset. */
function apply(value: string) {
  features = value;
  if (player) {
    if (value === 'book') player.removeAttribute('features');
    else player.setAttribute('features', value);
  }
  const url = new URL(location.href);
  if (value === 'book') url.searchParams.delete('features');
  else url.searchParams.set('features', value);
  history.replaceState(history.state, '', url);
}

/**
 * The details on trial, each a switch (`details` on the player, read by the skin's details.ts). Nothing is kept:
 * a reload has the default again. `?details=cloth+type` opens the page with just those.
 */
const detailKeys = [...document.querySelectorAll<HTMLButtonElement>('#details [data-detail]')];
const asked = params.get('details');
if (asked !== null) {
  const on = new Set(asked.split(/[\s,+]+/));
  for (const key of detailKeys) key.setAttribute('aria-pressed', String(on.has(key.dataset.detail ?? '')));
}
/** The switches as the attribute's value. The page's markup has them as the player's default (details.ts). */
const details = () => detailKeys.filter((key) => key.getAttribute('aria-pressed') === 'true').map((key) => key.dataset.detail).join(' ');
const defaults = details();
function applyDetails() {
  if (!player) return;
  const value = details();
  if (value === defaults && asked === null) player.removeAttribute('details');
  else player.setAttribute('details', value);
}
for (const key of detailKeys) {
  key.addEventListener('click', () => {
    key.setAttribute('aria-pressed', String(key.getAttribute('aria-pressed') !== 'true'));
    applyDetails();
  });
}

const host = document.getElementById('player');
const frame = document.getElementById('frame');
const handle = document.getElementById('frame-handle');
const seg = document.getElementById('seg');
if (frame && handle && seg) resizable(frame, handle, seg, document.getElementById('readout'));
const switcher = document.getElementById('features');
if (switcher) choice(switcher, apply).select(features);
if (host) {
  void import('./player').then(async ({ mount }) => {
    player = await mount(host, { features: features === 'book' ? undefined : features });
    applyDetails();
  });
}
