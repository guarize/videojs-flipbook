import { type PropertyValues, PlayerController, playerContext, selectTime, UIElement } from '@videojs/html';
import { I18nController, i18nContext } from '@videojs/html/i18n';
import { type Book, clock, loadBook, reducedMotion } from './book';
import { turnTo } from './goto';
import { chapterName, RIBBON_LIMIT, type Ribbons, ribbonsOf } from './marks';
import { isPlainKey, tell, voiceFor } from './pages';
import { tapToName } from './touch';

/**
 * Bookmark ribbons hanging from the fore-edge. B, or the bookmark key on the cover, marks the moment playing: a slim
 * red ribbon drops between the pages there and settles with a small sway. Each names its moment and chapter on hover
 * and focus. The ribbons are one Tab stop: arrows move between them, Enter goes there, Delete or Backspace takes the
 * ribbon out. `[` and `]` anywhere in the player go to the previous and next ribbon. Kept per video in this browser.
 */
export class FbRibbonsElement extends UIElement {
  #time = new PlayerController(this, playerContext, selectTime);
  #i18n = new I18nController(this, i18nContext);
  #abort: AbortController | null = null;
  #container: HTMLElement | null = null;
  #store: Ribbons | null = null;
  #book: Book | null = null;
  #say: ((message: string) => void) | null = null;
  #buttons: HTMLButtonElement[] = [];
  #duration = 0;
  #roving = 0;
  #pressed: boolean | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    this.#name();
    const container = this.closest<HTMLElement>('media-container');
    this.#container = container;
    if (!container) return;
    this.#say = voiceFor(container);

    queueMicrotask(async () => {
      this.#store = ribbonsOf(container);
      this.#store.addEventListener('change', (event) => this.#changed(event as CustomEvent), { signal });
      this.#render();
      this.#book = await loadBook(container, signal);
      if (!signal.aborted) this.#render();
    });

    this.addEventListener('keydown', (event) => this.#key(event), { signal });
    // The bookmark keys, wherever they sit (the cover, or the top bar on a phone).
    container.addEventListener('click', (event) => {
      const trigger = (event.target as Element | null)?.closest('[data-fb-action="bookmark"]');
      if (trigger && container.contains(trigger)) this.toggle();
    }, { signal });
    container.addEventListener('keydown', (event) => this.#shortcut(event), { signal });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort?.abort();
  }

  update(changed: PropertyValues) {
    super.update(changed);
    this.#name();
    const time = this.#time.value;
    if (!time) return;
    if (time.duration && time.duration !== this.#duration) {
      this.#duration = time.duration;
      this.#place();
    }
    this.#syncTriggers(time.currentTime);
  }

  /** A named group only while it holds ribbons: an empty "Bookmarks" group is noise to a screen reader. */
  #name() {
    if (this.#buttons.length) {
      this.setAttribute('role', 'group');
      this.setAttribute('aria-label', tell(this.#i18n, 'fbPages.bookmarks'));
    } else {
      this.removeAttribute('role');
      this.removeAttribute('aria-label');
    }
  }

  /** B: marks the moment playing, or takes out the ribbon already there. */
  toggle() {
    const store = this.#store;
    const time = this.#time.value;
    if (!store || !time) return;
    const at = time.currentTime;
    const near = store.near(at);
    if (near >= 0) {
      store.remove(store.times[near]);
      return;
    }
    const result = store.add(at);
    if (result === 'full') this.#say?.(tell(this.#i18n, 'fbPages.full', { count: RIBBON_LIMIT }));
  }

  #changed(event: CustomEvent<{ added?: number; removed?: number }>) {
    const { added, removed } = event.detail ?? {};
    const hadFocus = this.contains(document.activeElement);
    const removedIndex = removed != null ? this.#buttons.findIndex((b) => Number(b.dataset.time) === removed) : -1;
    this.#render();
    if (added != null) {
      this.#say?.(tell(this.#i18n, 'fbPages.added', { time: clock(added) }));
      const index = this.#store?.times.indexOf(Math.round(added * 10) / 10) ?? -1;
      const button = this.#buttons[index];
      if (button) this.#settle(button);
    }
    if (removed != null) {
      this.#say?.(tell(this.#i18n, 'fbPages.removed', { time: clock(removed) }));
      if (hadFocus) {
        const next = this.#buttons[Math.min(removedIndex, this.#buttons.length - 1)];
        if (next) {
          this.#rove(this.#buttons.indexOf(next));
          next.focus();
        } else {
          // The last ribbon went: focus goes to the key that makes them, or the player itself.
          const trigger = Array.from(this.#container?.querySelectorAll<HTMLElement>('[data-fb-action="bookmark"]') ?? []).find(
            (el) => el.offsetParent !== null,
          );
          (trigger ?? this.#container)?.focus();
        }
      }
    }
    this.#pressed = null;
    const time = this.#time.value;
    if (time) this.#syncTriggers(time.currentTime);
  }

  #render() {
    const store = this.#store;
    if (!store) return;
    const times = store.times;
    // Reuse the buttons already standing, so a focused ribbon keeps its focus.
    const existing = new Map(this.#buttons.map((b) => [Number(b.dataset.time), b]));
    this.#buttons = times.map((time) => {
      let button = existing.get(time);
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'fb-ribbon';
        button.dataset.time = String(time);
        button.innerHTML =
          '<span class="fb-ribbon-cloth" aria-hidden="true"></span><span class="fb-ribbon-label" aria-hidden="true"><span class="fb-ribbon-time"></span><span class="fb-ribbon-chapter"></span></span>';
        // While its slip shows, the captions keep clear of it (captions.ts steps around any [data-fb-overlay]).
        const slip = (on: boolean) => button?.querySelector('.fb-ribbon-label')?.toggleAttribute('data-fb-overlay', on);
        button.addEventListener('pointerenter', (event) => {
          if (event.pointerType === 'mouse') slip(true);
        });
        button.addEventListener('pointerleave', () => slip(button?.matches(':focus-visible') ?? false));
        button.addEventListener('focus', () => slip(button?.matches(':focus-visible') ?? false));
        button.addEventListener('blur', () => slip(false));
        // On a touch screen the first tap shows the ribbon's moment on its slip, and the second goes there.
        button.addEventListener('fb-tap', (event) => slip((event as CustomEvent<{ shown: boolean }>).detail.shown));
        const ribbon = button;
        tapToName(ribbon, () => {
          this.#rove(this.#buttons.indexOf(ribbon));
          turnTo(this, time);
        });
      }
      const chapter = chapterName(this.#book, time);
      const timeLabel = button.querySelector<HTMLElement>('.fb-ribbon-time');
      const chapterLabel = button.querySelector<HTMLElement>('.fb-ribbon-chapter');
      if (timeLabel) timeLabel.textContent = clock(time);
      if (chapterLabel) chapterLabel.textContent = chapter;
      button.setAttribute(
        'aria-label',
        chapter ? tell(this.#i18n, 'fbPages.ribbon', { time: clock(time), chapter }) : tell(this.#i18n, 'fbPages.ribbonPlain', { time: clock(time) }),
      );
      button.setAttribute('aria-keyshortcuts', 'Delete Backspace');
      return button;
    });
    this.replaceChildren(...this.#buttons);
    this.toggleAttribute('data-empty', this.#buttons.length === 0);
    this.#name();
    this.#rove(Math.min(this.#roving, Math.max(0, this.#buttons.length - 1)));
    this.#place();
  }

  #place() {
    if (!this.#duration) return;
    for (const button of this.#buttons) {
      const at = Math.min(1, Number(button.dataset.time) / this.#duration);
      button.style.left = `${(at * 100).toFixed(3)}%`;
      // Near either end the label hangs inward, so it never runs off the player.
      button.dataset.align = at < 0.1 ? 'start' : at > 0.9 ? 'end' : 'center';
    }
  }

  /** A ribbon placed: it drops in between the pages and sways a little before it hangs still. */
  #settle(button: HTMLButtonElement) {
    const cloth = button.querySelector<HTMLElement>('.fb-ribbon-cloth');
    if (!cloth) return;
    if (reducedMotion.matches) {
      cloth.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: 'linear' });
      return;
    }
    cloth.animate(
      [
        { transform: 'translateY(-10px) rotate(0deg)', opacity: 0 },
        { transform: 'translateY(0) rotate(7deg)', opacity: 1, offset: 0.22 },
        { transform: 'rotate(-4.5deg)', offset: 0.45 },
        { transform: 'rotate(2.2deg)', offset: 0.66 },
        { transform: 'rotate(-0.9deg)', offset: 0.84 },
        { transform: 'rotate(0deg)' },
      ],
      { duration: 900, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' },
    );
  }

  /** The bookmark keys say whether this moment is marked: a tick on the ribbon, a pressed state, and a tooltip for what a press does. */
  #syncTriggers(currentTime: number) {
    const store = this.#store;
    const container = this.#container;
    if (!store || !container) return;
    const pressed = store.near(currentTime) >= 0;
    if (pressed === this.#pressed) return;
    this.#pressed = pressed;
    const label = tell(this.#i18n, pressed ? 'fbPages.unbookmark' : 'fbPages.bookmark');
    for (const trigger of container.querySelectorAll<HTMLElement>('[data-fb-action="bookmark"]')) {
      // Named by its printed word, "Bookmark"; pressed while this moment is marked. The tooltip says what a press does.
      trigger.toggleAttribute('data-bookmarked', pressed);
      trigger.setAttribute('aria-pressed', String(pressed));
      trigger.setAttribute('aria-keyshortcuts', 'B');
    }
    for (const slip of container.querySelectorAll<HTMLElement>('[data-fb-label="bookmark"]')) slip.textContent = label;
  }

  #rove(index: number) {
    this.#roving = Math.max(0, index);
    this.#buttons.forEach((button, i) => {
      button.tabIndex = i === this.#roving ? 0 : -1;
    });
  }

  #key(event: KeyboardEvent) {
    const index = this.#buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    const last = this.#buttons.length - 1;
    const rtl = getComputedStyle(this).direction === 'rtl';
    let next = -1;
    if (event.key === (rtl ? 'ArrowLeft' : 'ArrowRight') || event.key === 'ArrowDown') next = index === last ? 0 : index + 1;
    else if (event.key === (rtl ? 'ArrowRight' : 'ArrowLeft') || event.key === 'ArrowUp') next = index === 0 ? last : index - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      event.stopPropagation();
      this.#store?.remove(Number(this.#buttons[index].dataset.time));
      return;
    }
    if (next < 0) return;
    // These keys belong to the ribbons here, not to the player's shortcuts.
    event.preventDefault();
    event.stopPropagation();
    this.#rove(next);
    this.#buttons[next].focus();
  }

  /** B, `[` and `]` on the player. */
  #shortcut(event: KeyboardEvent) {
    if (!isPlainKey(event) || event.repeat) return;
    if ((event.target as Element | null)?.closest('[data-fb-overlay][aria-modal="true"]')) return;
    const key = event.key;
    if (key === 'b' || key === 'B') {
      event.preventDefault();
      this.toggle();
      return;
    }
    if (key !== '[' && key !== ']') return;
    const store = this.#store;
    const time = this.#time.value;
    if (!store || !time || !store.times.length) return;
    const now = time.currentTime;
    // Back skips the ribbon just passed, so pressing twice keeps going back rather than landing on the same one.
    const target = key === ']' ? store.times.find((t) => t > now + 0.5) : [...store.times].reverse().find((t) => t < now - 1.5);
    if (target == null) return;
    event.preventDefault();
    turnTo(this, target, true);
  }
}

customElements.define('fb-ribbons', FbRibbonsElement);
