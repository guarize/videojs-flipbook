import { tileAt } from '@/shared/storyboard';
import { type Book, reducedMotion, spritePosition } from './book';

/** Leaves in the fan: the page under the hand, and three either side of it. */
const LEAVES = 7;
const HALF = (LEAVES - 1) / 2;
/** Each leaf stands this far round from the next (degrees), about a pivot under the finger. */
const STEP = 13;
/** A leaf is this much smaller for each place it stands from the middle. */
const SHRINK = 0.045;
/** The leaves' feet stand this far above the finger at the least (px). */
const CLEAR = 10;
/** Open and closed in about this long (the time constant of its ease, seconds). */
const EASE = 0.07;
/** Under a pointer the leaves are this share of the picture's height, between these (px): nothing hides them. */
const FINE_SHARE = 0.14;
const FINE_MIN = 56;
const FINE_MAX = 84;
/** And the whole fan stands this far over what the pointer reads beside the edge (the readout, the tabs). */
const FINE_CLEAR = 6;
/** The outermost leaf still in sight stands this many places from the middle (it is clear glass at 3.5). */
const FAR = 3.5;

/**
 * The fan under the thumb. While a finger flips the film (across the picture, or along the edge) a handful of the
 * film's own pages stand up from under it and splay like the leaves of the book it is holding open: the page the
 * film is on in the middle, the three before and the three after it to either side, turning through the fan as the
 * film follows. Let go and the fan falls shut.
 *
 * A mouse held and dragged along the edge gets the same fan (`fine`), made for a pointer: a thumb hides what is
 * under it, so its fan is large and stands up from under the finger; a pointer hides nothing, so its fan is smaller,
 * stays whole inside the player, and stands wholly over what the pointer reads beside the edge (the readout, the
 * chapter tabs), covering neither.
 *
 * Seven layers, made once: each is one tile of the storyboard's sprite, already decoded for the edge and the deck
 * (nothing is decoded while the hand moves), and only its transform and opacity change, once a frame, while the fan
 * is up. The pointer's own handlers just leave a point and a time here. Never under reduced motion: the picture
 * simply follows the finger.
 */
export class Fan {
  #root: HTMLElement;
  #leaves: HTMLElement[] = [];
  #pages: number[] = [];
  #book: () => Book | null;
  #frame = 0;
  #last = 0;
  #open = 0;
  #want = 0;
  #x = 0;
  #y = 0;
  #time = 0;
  #box: DOMRect | null = null;
  #width = 0;
  #height = 0;
  #clear = CLEAR;
  /** How far the fan's pivot keeps from the player's sides (px). */
  #side = 0;

  constructor(host: HTMLElement, private container: HTMLElement, book: () => Book | null) {
    this.#book = book;
    this.#root = document.createElement('div');
    this.#root.className = 'fb-fan';
    this.#root.hidden = true;
    for (let i = 0; i < LEAVES; i++) {
      const leaf = document.createElement('i');
      leaf.className = 'fb-fan-leaf';
      this.#root.append(leaf);
      this.#leaves.push(leaf);
      this.#pages.push(-1);
    }
    host.append(this.#root);
  }

  /**
   * The hand has the film: the fan stands up from under it. `x`, `y` in the window: the finger's point, or, for a
   * pointer (`fine`), the pointer's place along the edge and the top of what the fan must stand clear over.
   */
  open(x: number, y: number, time: number, fine = false) {
    if (reducedMotion.matches || !this.#book()?.tiles.length) return;
    this.#box = this.container.getBoundingClientRect();
    this.#x = x;
    this.#y = y;
    this.#time = time;
    this.#want = 1;
    // Sized once, as the hand takes the film. (Nothing but transforms and opacity changes after this.)
    const box = this.#box;
    const fy = Math.min(box.height, Math.max(0, y - box.top));
    const ratio = this.#book()?.ratio || 16 / 9;
    // How far the fan reaches under its middle leaf's foot, and to either side of its pivot, for a leaf this tall: the
    // outermost leaf in sight, turned about a pivot `reach` under its foot, at its size there.
    const turn = (FAR * STEP * Math.PI) / 180;
    const small = 1 - FAR * SHRINK;
    const reachOf = (height: number) => height * 0.9;
    const dip = (height: number) => reachOf(height) * (1 - small * Math.cos(turn)) + small * ((height * ratio) / 2) * Math.sin(turn);
    if (fine) {
      // A leaf a seventh of the picture tall, and smaller where the room over the edge is short: the whole fan,
      // its lowest corner to its top, between the player's top and what it stands over.
      let height = Math.min(Math.max(FINE_MIN, box.height * FINE_SHARE), FINE_MAX);
      while (height > 36 && fy - FINE_CLEAR - dip(height) - height < 8) height -= 4;
      this.#height = Math.round(height);
    } else {
      // A leaf about a third of the picture tall, and never taller than the room above the finger.
      this.#height = Math.round(Math.min(Math.max(44, box.height * 0.3), 112, Math.max(44, fy - 14)));
    }
    this.#width = Math.round(this.#height * ratio);
    this.#root.style.setProperty('--fb-fan-w', `${this.#width}px`);
    this.#root.style.setProperty('--fb-fan-h', `${this.#height}px`);
    const reach = reachOf(this.#height);
    this.#root.style.setProperty('--fb-fan-reach', `${reach.toFixed(1)}px`);
    if (fine) {
      this.#clear = FINE_CLEAR + dip(this.#height);
      this.#side = Math.min(box.width / 2, 4 + small * ((this.#width / 2) * Math.cos(turn) + (this.#height + reach) * Math.sin(turn)));
    } else {
      // As the film runs through a page the middle leaf swings a whole step about a pivot `reach` under its foot, and
      // its lower corner comes down by this much: the fan stands that much higher, so no leaf dips under the finger's
      // line at any moment of a page (how long a page lasts is the film's, and decides which moment a hand meets).
      const swing = (STEP * Math.PI) / 180;
      this.#clear = CLEAR + reach - (1 - SHRINK) * (reach * Math.cos(swing) - (this.#width / 2) * Math.sin(swing));
      this.#side = this.#width * 0.3;
    }
    this.#root.hidden = false;
    this.container.toggleAttribute('data-fb-fan', true);
    this.#kick();
  }

  at(x: number, y: number) {
    this.#x = x;
    this.#y = y;
  }

  time(time: number) {
    this.#time = time;
  }

  close() {
    if (!this.#want) return;
    this.#want = 0;
    this.#kick();
  }

  destroy() {
    cancelAnimationFrame(this.#frame);
    this.#root.remove();
    this.container.removeAttribute('data-fb-fan');
  }

  #kick() {
    if (this.#frame) return;
    this.#last = performance.now();
    this.#frame = requestAnimationFrame((now) => this.#draw(now));
  }

  #draw(now: number) {
    this.#frame = 0;
    const book = this.#book();
    const box = this.#box;
    if (!book || !box) return;
    // (A long frame opens the fan no further than a short one would; falling shut, it counts whole, so the fan is
    // gone in the same 300 ms however few frames the page gets.)
    const elapsed = Math.max(0.001, (now - this.#last) / 1000);
    const dt = this.#want ? Math.min(0.05, elapsed) : elapsed;
    this.#last = now;
    this.#open = this.#want + (this.#open - this.#want) * Math.exp(-dt / EASE);
    if (!this.#want && this.#open < 0.02) {
      this.#open = 0;
      this.#root.hidden = true;
      this.container.removeAttribute('data-fb-fan');
      return;
    }
    const tiles = book.tiles;
    const index = tileAt(tiles, this.#time);
    const tile = tiles[index];
    const along = tile && tile.end > tile.start ? Math.min(1, Math.max(0, (this.#time - tile.start) / (tile.end - tile.start))) : 0;
    const fy = Math.min(box.height, Math.max(0, this.#y - box.top));
    const height = this.#height;
    const width = this.#width;
    const fx = Math.min(box.width - this.#side, Math.max(this.#side, this.#x - box.left));
    const root = this.#root;
    // The pivot is under the finger; the leaves stand over it, clear of the fingertip.
    root.style.transform = `translate3d(${fx.toFixed(1)}px, ${Math.max(height + 6, fy - this.#clear).toFixed(1)}px, 0)`;
    root.style.opacity = Math.min(1, this.#open * 1.4).toFixed(3);
    for (let i = 0; i < LEAVES; i++) {
      const leaf = this.#leaves[i];
      const page = index + i - HALF;
      if (page < 0 || page >= tiles.length) {
        if (this.#pages[i] !== -2) {
          this.#pages[i] = -2;
          leaf.style.visibility = 'hidden';
        }
        continue;
      }
      if (this.#pages[i] !== page) {
        if (this.#pages[i] === -2) leaf.style.visibility = '';
        this.#pages[i] = page;
        leaf.style.backgroundPosition = spritePosition(book, page);
      }
      // Its place in the fan, a page being a whole step: as the film runs through a page every leaf comes round by one.
      const place = i - HALF - along;
      const far = Math.abs(place);
      const angle = place * STEP * this.#open;
      // (Which leaf lies over which is fixed, the middle one on top: flip.css. The page in the middle lifts off to
      // the side as the next comes under it, as a page does.)
      const scale = (1 - far * SHRINK) * (0.86 + 0.14 * this.#open);
      leaf.style.transform = `rotate(${angle.toFixed(2)}deg) scale(${scale.toFixed(3)})`;
      // Whole out to the second leaf either side; the outermost come and go at the fan's ends.
      leaf.style.opacity = Math.max(0, Math.min(1, 3.5 - far)).toFixed(3);
    }
    this.#frame = requestAnimationFrame((t) => this.#draw(t));
  }
}
