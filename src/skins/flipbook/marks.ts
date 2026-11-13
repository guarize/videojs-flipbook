import { type Book, chapterAt } from './book';
import { isOn } from './features';
import { storageKey } from './pages';

/*
 * The bookmarks of one video, shared by the ribbons, the contents page, the back cover and the hints. Kept out of
 * ribbons.ts so that reading them never brings the ribbons themselves: with `ribbons` off, every reader sees an empty
 * list (and hears a change when it's turned on or off), while what was saved stays saved for when it's back.
 */

/** The most ribbons a book carries. */
export const RIBBON_LIMIT = 12;
/** A moment this close to a ribbon is that ribbon's moment: B there removes it rather than adding another. */
const NEAR = 1.5;

/**
 * The bookmarks of one video, kept in this browser: a sorted list of times, and an event when it changes. The
 * ribbons on the fore-edge, the contents page and the back cover all read and change the same list.
 */
export class Ribbons extends EventTarget {
  #times: number[] = [];
  #key: string;
  #container: Element;

  constructor(container: Element, key: string) {
    super();
    this.#container = container;
    this.#key = key;
    if (!key) return;
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? '[]');
      if (Array.isArray(saved)) {
        this.#times = saved
          .map(Number)
          .filter((t) => Number.isFinite(t) && t >= 0)
          .sort((a, b) => a - b)
          .slice(0, RIBBON_LIMIT);
      }
    } catch {
      // Storage blocked or unreadable: the ribbons last as long as the page.
    }
  }

  /** The bookmarks, or none while the ribbons are off for this player. */
  get times(): readonly number[] {
    return isOn(this.#container, 'ribbons') ? this.#times : [];
  }

  /** The ribbon within reach of a time, or -1. */
  near(time: number, within = NEAR): number {
    let best = -1;
    let gap = within;
    this.times.forEach((t, i) => {
      const d = Math.abs(t - time);
      if (d <= gap) {
        gap = d;
        best = i;
      }
    });
    return best;
  }

  add(time: number): 'added' | 'near' | 'full' {
    if (this.near(time) >= 0) return 'near';
    if (this.#times.length >= RIBBON_LIMIT) return 'full';
    this.#times = [...this.#times, Math.round(time * 10) / 10].sort((a, b) => a - b);
    this.#save();
    this.dispatchEvent(new CustomEvent('change', { detail: { added: time } }));
    return 'added';
  }

  remove(time: number) {
    const before = this.#times.length;
    this.#times = this.#times.filter((t) => t !== time);
    if (this.#times.length === before) return;
    this.#save();
    this.dispatchEvent(new CustomEvent('change', { detail: { removed: time } }));
  }

  #save() {
    if (!this.#key) return;
    try {
      if (this.#times.length) localStorage.setItem(this.#key, JSON.stringify(this.#times));
      else localStorage.removeItem(this.#key);
    } catch {
      // Storage blocked: nothing to do, the list still works for this visit.
    }
  }
}

const stores = new WeakMap<Element, Ribbons>();

export function ribbonsOf(container: Element): Ribbons {
  let store = stores.get(container);
  if (!store) {
    const created = new Ribbons(container, storageKey(container, 'fb-ribbons'));
    store = created;
    stores.set(container, store);
    // Ribbons turned on or off: the list every reader sees has changed.
    container.addEventListener('fb-features', () => created.dispatchEvent(new CustomEvent('change', { detail: {} })));
  }
  return store;
}

/** The chapter a time falls in, by name; empty when there are no chapters. */
export function chapterName(book: Book | null, time: number): string {
  if (!book) return '';
  const index = chapterAt(book, time);
  return index >= 0 ? book.chapters[index].text : '';
}
