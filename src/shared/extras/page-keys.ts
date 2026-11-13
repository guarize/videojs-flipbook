/**
 * Shortcuts without clicking the player first. Video.js listens for its hotkeys on the player's container (so two
 * players on a page don't both answer), which means nothing happens until the player has focus. Here a key pressed
 * on the page itself (nothing focused, or plain text focused) is handed to one player. Every shortcut follows,
 * Video.js's own and the skin's.
 *
 * Which keys, and when (WCAG 2.1.4, Character Key Shortcuts):
 * - A character key (a letter, a digit, punctuation: K, M, 5, ?) typed on the page reaches a player only while the
 *   pointer is over that player. Typed anywhere else it is the page's: speech input spelling a word, or a stray press,
 *   never plays, mutes or bookmarks. With focus in the player its keys work as always; that's the exception the
 *   criterion allows, and there is nothing to switch off.
 * - Every other key (Space, the arrows, Home, End, Page Up, Page Down) goes to the player the pointer is over, else
 *   the one you last used if it is still in view, else the one most in view.
 *
 * Keys are left alone when they belong to something else: typing in a field, Space or Enter on a focused button or
 * link, anything inside another player, browser shortcuts with Ctrl, Alt or Cmd, and a key already handled.
 */

/** A key that types a character. Space is a key of its own here: it scrolls or presses, it doesn't spell. */
export function isCharacterKey(event: KeyboardEvent): boolean {
  return event.key.length === 1 && event.key !== ' ';
}

/** The player under the pointer, if there is one. */
export function playerUnderPointer(): HTMLElement | null {
  return document.querySelector<HTMLElement>('media-container:hover');
}

/** How much of a player must be on screen for the page's keys to reach it. */
const IN_VIEW = 0.25;

const INTERACTIVE = 'a[href], button, input, select, textarea, summary, [contenteditable], [role="button"], [role="link"], [role="slider"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="textbox"], [role="combobox"]';

let last: HTMLElement | null = null;

function shown(container: HTMLElement): number {
  const r = container.getBoundingClientRect();
  if (!r.width || !r.height) return 0;
  const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
  const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
  return (w * h) / (r.width * r.height);
}

function owner(): HTMLElement | null {
  if (last?.isConnected && shown(last) >= IN_VIEW) return last;
  let best: HTMLElement | null = null;
  let most = IN_VIEW;
  for (const container of document.querySelectorAll<HTMLElement>('media-container')) {
    const share = shown(container);
    if (share >= most) {
      most = share;
      best = container;
    }
  }
  return best;
}

function claims(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return false;
  const target = event.target instanceof Element ? event.target : null;
  if (!target || target === document.body || target === document.documentElement) return true;
  if (target.closest('media-container')) return false;
  // Something on the page has focus: it keeps its own keys (Space and Enter on a button, anything in a field).
  if (target.closest(INTERACTIVE) || (target as HTMLElement).isContentEditable) return false;
  return true;
}

function remember(event: Event) {
  const container = (event.target as Element | null)?.closest?.('media-container');
  if (container instanceof HTMLElement) last = container;
}

function forward(event: KeyboardEvent) {
  if (!claims(event)) return;
  const hovered = playerUnderPointer();
  const container = isCharacterKey(event) ? hovered : (hovered ?? owner());
  if (!container) return;
  const copy = new KeyboardEvent(event.type, {
    key: event.key,
    code: event.code,
    location: event.location,
    repeat: event.repeat,
    shiftKey: event.shiftKey,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  container.dispatchEvent(copy);
  // A shortcut that did something stops the page doing it too (Space scrolling, arrows moving the page).
  if (copy.defaultPrevented) event.preventDefault();
}

if (typeof document !== 'undefined' && !(window as { __xPageKeys?: boolean }).__xPageKeys) {
  (window as { __xPageKeys?: boolean }).__xPageKeys = true;
  document.addEventListener('pointerdown', remember, { capture: true, passive: true });
  document.addEventListener('focusin', remember, { capture: true });
  document.addEventListener('keydown', forward);
  document.addEventListener('keyup', forward);
}
