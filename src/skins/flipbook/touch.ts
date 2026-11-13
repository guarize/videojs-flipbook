/** A shown name stays up this long without a second tap, then folds away. */
const HOLD = 4000;

const kinds = new WeakMap<HTMLElement, string>();
const timers = new WeakMap<HTMLElement, number>();

function fold(key: HTMLElement) {
  clearTimeout(timers.get(key));
  if (!key.hasAttribute('data-fb-tap')) return;
  key.removeAttribute('data-fb-tap');
  key.dispatchEvent(new CustomEvent('fb-tap', { detail: { shown: false } }));
}

/**
 * Names that a mouse finds by hovering, for a finger: on a touch screen the first tap on a key (a chapter tab, a
 * ribbon) shows its name on its slip, and a second tap on the same key goes. A tap anywhere else, or a few seconds,
 * folds the name away. A mouse, a pen with hover, the keyboard and a screen reader's activation go at once, as before:
 * the name is already theirs (on hover, on focus, in the accessible name).
 *
 * The key carries `data-fb-tap` while its name is shown (the slip's CSS reads it) and hears `fb-tap` on each change.
 */
export function tapToName(key: HTMLElement, go: () => void, signal?: AbortSignal): void {
  key.addEventListener('pointerdown', (event) => kinds.set(key, event.pointerType), { signal });
  key.addEventListener('click', (event) => {
    const touch = kinds.get(key) === 'touch' && event.detail > 0;
    kinds.delete(key);
    // Where the name is already in sight a first tap has nothing to show, and goes: a tab that prints its whole name,
    // and every tab of a phone's pad, which sets the chapter's name in its running foot (phone.css).
    const named = key.hasAttribute('data-fb-full') || (key.classList.contains('fb-tab') && !!key.closest('media-container[data-fb-hand]'));
    if (touch && !named && !key.hasAttribute('data-fb-tap')) {
      // Another key's name in the same row folds: one slip at a time.
      for (const other of key.parentElement?.querySelectorAll<HTMLElement>('[data-fb-tap]') ?? []) if (other !== key) fold(other);
      key.setAttribute('data-fb-tap', '');
      key.dispatchEvent(new CustomEvent('fb-tap', { detail: { shown: true } }));
      clearTimeout(timers.get(key));
      timers.set(key, window.setTimeout(() => fold(key), HOLD));
      const away = (down: Event) => {
        if (!(down.target instanceof Node) || !key.contains(down.target)) fold(key);
      };
      key.ownerDocument.addEventListener('pointerdown', away, { capture: true, once: true, signal });
      return;
    }
    fold(key);
    go();
  }, { signal });
  key.addEventListener('blur', () => fold(key), { signal });
}
