/**
 * The page sound: whether the soft tick of pages under a hand (flutter.ts) may be heard. On unless the viewer turns
 * it off ("Page sound" in Settings, kept with the skin's other preferences in this browser); the viewer's choice
 * holds either way. A page takes the sound, and its setting, away altogether with `data-fb-flutter="off"` on the
 * player or anything around it.
 *
 * Kept in the core so Settings can show the choice before the book's deck (which makes the sound) has arrived.
 */
const STORE = 'fb-page-sound';

/** The rule, alone: what is stored (`on`, `off` or nothing) against what the page says (`off` or nothing). */
export function resolveSound(stored: string | null, host: string | null): boolean {
  if (host === 'off') return false;
  return stored !== 'off';
}

const hostOf = (scope: Element) => scope.closest('[data-fb-flutter]')?.getAttribute('data-fb-flutter') ?? null;

/** Whether the page lets the viewer have the sound at all. */
export function soundOffered(scope: Element): boolean {
  return hostOf(scope) !== 'off';
}

export function pageSound(scope: Element): boolean {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORE);
  } catch {
    // No storage here: the page's default stands.
  }
  return resolveSound(stored, hostOf(scope));
}

export function setPageSound(on: boolean): void {
  try {
    localStorage.setItem(STORE, on ? 'on' : 'off');
  } catch {
    // Not kept, then; it still holds for this visit's players through the event below.
  }
  window.dispatchEvent(new CustomEvent('fb-page-sound', { detail: { on } }));
}
