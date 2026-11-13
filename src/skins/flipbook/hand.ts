import { PlayerController, playerContext, selectControls, selectFullscreen, selectPlayback, selectTime, UIElement } from '@videojs/html';
import { I18nController, i18nContext } from '@videojs/html/i18n';
import { reducedMotion, videoIn } from './book';
import { attach } from './companion';
import { say } from './i18n';

/** A touch that travels further than this is a swipe or a scroll, not a tap or a hold. */
export const TOUCH_SLOP = 10;
/** A tap is over this soon; a still touch this long is a hold. */
const TAP_MAX = 300;
const HOLD_AFTER = 420;
/** A second tap this soon after the first, this near it, makes a double tap; each one after that adds to it. */
const DOUBLE_WINDOW = 250;
const DOUBLE_REACH = 48;
/** A double tap on a side third skips this far. */
const SKIP = 10;
/** The film runs this fast while a finger holds the picture. */
const HOLD_RATE = 2;
/** The skip's mark stays this long after the last tap. */
const MARK_HOLD = 950;

/** What a touch on the picture must not start on: a control, a panel, a page of the book laid over it. */
export const NOT_PICTURE =
  '.fb-bar, .video-controls-top, .media-popup, fb-curl, fb-ear, fb-plate, fb-contents, fb-tear button, .fb-tear-slip, .fb-resume, .fb-cover-play, media-error-dialog, [data-fb-overlay], button, a[href], input';

interface Touch {
  id: number;
  x: number;
  y: number;
  at: number;
  moved: boolean;
  held: boolean;
  timer: number;
}

interface Tap {
  x: number;
  y: number;
  at: number;
  /** What the tap did, so a second tap that turns it into a double tap can take it back. */
  undo: (() => void) | null;
  /** Skips so far in this run of taps, signed. */
  run: number;
}

/**
 * The picture under a finger. A phone taught everyone four things, and the picture does all four:
 *
 * - **A tap plays and pauses.** In the page, where the controls are a pad under the picture and never hide, every tap
 *   does. Where the controls lie over the film (filling the screen, a wide player on a tablet) a tap on a bare
 *   picture brings them back first, as it does everywhere, and a tap with them up plays or pauses.
 * - **A double tap on the left or right third skips ten seconds** back or on, and each tap after that ten more. The
 *   first tap has already acted by then, and the second takes it back (only a pause from a side third waits a
 *   quarter of a second, see #act). In the middle third it opens and leaves fullscreen.
 * - **A hold runs the film at twice its speed** for as long as the finger stays, and puts the viewer's own rate
 *   back when it lifts. Only while the film plays: on a paused page a hold tears the page out (tear.ts).
 * - **A swipe across flips the pages** (flip.ts, with the book's deck). Up and down is the page's scroll.
 *
 * Touch only. A mouse, a pen and the keyboard keep Video.js's own gestures and keys, which this turns off for
 * touch alone (it leaves the tap gesture registered and disabled, so the controls' own tap toggle stays out too).
 */
export class FbHandElement extends UIElement {
  #playback = new PlayerController(this, playerContext, selectPlayback);
  #time = new PlayerController(this, playerContext, selectTime);
  #controls = new PlayerController(this, playerContext, selectControls);
  #fullscreen = new PlayerController(this, playerContext, selectFullscreen);
  #i18n = new I18nController(this, i18nContext);
  #abort: AbortController | null = null;
  #container: HTMLElement | null = null;
  #touch: Touch | null = null;
  #last: Tap | null = null;
  #rate = 1;
  #mark: HTMLElement | null = null;
  #chip: HTMLElement | null = null;
  #markTimer = 0;

  connectedCallback() {
    super.connectedCallback();
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    // Placed by companion.ts, which hides what it places; this one draws (the skip's mark, the hold's chip).
    this.hidden = false;
    this.setAttribute('aria-hidden', 'true');
    this.innerHTML =
      '<span class="fb-hand-mark"><span class="fb-hand-leaves"><i></i><i></i><i></i></span><span class="fb-hand-count"></span></span><span class="fb-hand-chip"></span>';
    this.#mark = this.querySelector('.fb-hand-mark');
    this.#chip = this.querySelector('.fb-hand-chip');
    const container = this.closest<HTMLElement>('media-container');
    this.#container = container;
    if (!container) return;

    // Video.js's gestures stay the mouse's: a touch is read here.
    for (const gesture of container.querySelectorAll('media-gesture')) {
      if (gesture.getAttribute('type') === 'doubletap' && !gesture.hasAttribute('pointer')) gesture.setAttribute('pointer', 'mouse');
      if (gesture.getAttribute('type') === 'tap' && gesture.getAttribute('pointer') === 'touch') gesture.toggleAttribute('disabled', true);
    }

    container.addEventListener('pointerdown', (event) => this.#down(event), { signal });
    container.addEventListener('pointermove', (event) => this.#move(event), { passive: true, signal });
    container.addEventListener('pointerup', (event) => this.#up(event), { signal });
    container.addEventListener('pointercancel', (event) => this.#drop(event.pointerId), { signal });
    // A touch leaves no keyboard ring on the player (CSS reads the mark); the next key brings rings back.
    container.addEventListener('pointerdown', (event) => {
      container.toggleAttribute('data-fb-touch', event.pointerType === 'touch');
    }, { capture: true, signal });
    container.addEventListener('keydown', () => container.toggleAttribute('data-fb-touch', false), { capture: true, signal });
    // A long press on the picture is the hold, not the browser's menu for a video or an image.
    container.addEventListener('contextmenu', (event) => {
      if (this.#touch?.held || container.hasAttribute('data-fb-touch')) event.preventDefault();
    }, { signal });
    signal.addEventListener('abort', () => this.#drop());
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort?.abort();
    clearTimeout(this.#markTimer);
  }

  #onPicture(event: Event): boolean {
    const target = event.target as Element | null;
    return !!target && !target.closest?.(NOT_PICTURE);
  }

  #down(event: PointerEvent) {
    if (event.pointerType !== 'touch') return;
    // A second finger is a pinch: nothing here is a two-finger gesture.
    if (!event.isPrimary) {
      this.#drop();
      return;
    }
    // (A touch whose lift never came here, taken by the tear or a panel, is forgotten.)
    this.#drop();
    if (!this.#onPicture(event)) return;
    const container = this.#container;
    const video = container ? videoIn(container) : null;
    const touch: Touch = { id: event.pointerId, x: event.clientX, y: event.clientY, at: event.timeStamp, moved: false, held: false, timer: 0 };
    this.#touch = touch;
    // Only a playing film is hurried: a paused page's hold is the tear's.
    if (video && !video.paused && !video.ended) touch.timer = window.setTimeout(() => this.#hold(touch), HOLD_AFTER);
  }

  #move(event: PointerEvent) {
    const touch = this.#touch;
    if (!touch || event.pointerId !== touch.id || touch.moved) return;
    if (Math.hypot(event.clientX - touch.x, event.clientY - touch.y) <= TOUCH_SLOP) return;
    touch.moved = true;
    clearTimeout(touch.timer);
    // Moved off its place while held: the hold ends as the finger's lift would end it.
    if (touch.held) this.#release(touch);
  }

  #up(event: PointerEvent) {
    const touch = this.#touch;
    if (!touch || event.pointerId !== touch.id) return;
    this.#touch = null;
    clearTimeout(touch.timer);
    if (touch.held) {
      this.#release(touch);
      return;
    }
    if (touch.moved || event.timeStamp - touch.at > TAP_MAX || !this.#onPicture(event)) return;
    this.#tap(event);
  }

  #drop(id?: number) {
    const touch = this.#touch;
    if (!touch || (id != null && id !== touch.id)) return;
    this.#touch = null;
    clearTimeout(touch.timer);
    if (touch.held) this.#release(touch);
  }

  // ─── A tap, and a second ───────────────────────────────────────────────────

  #tap(event: PointerEvent) {
    const container = this.#container;
    const box = container?.getBoundingClientRect();
    if (!container || !box) return;
    const last = this.#last;
    const again = !!last && event.timeStamp - last.at < DOUBLE_WINDOW && Math.hypot(event.clientX - last.x, event.clientY - last.y) < DOUBLE_REACH;
    if (again && last) {
      const share = (event.clientX - box.left) / box.width;
      const rtl = getComputedStyle(container).direction === 'rtl';
      const side = share < 1 / 3 ? -1 : share > 2 / 3 ? 1 : 0;
      // The first tap played, paused or showed the controls: a double tap means none of that.
      last.undo?.();
      last.undo = null;
      last.at = event.timeStamp;
      if (side === 0) {
        if (!last.run) this.#toggleFullscreen();
        this.#last = null;
        return;
      }
      const direction = (rtl ? -side : side) as 1 | -1;
      last.run = Math.sign(last.run) === direction ? last.run + direction : direction;
      this.#skip(direction, side as 1 | -1, last.run);
      return;
    }
    const share = (event.clientX - box.left) / box.width;
    this.#last = { x: event.clientX, y: event.clientY, at: event.timeStamp, undo: this.#act(share < 1 / 3 || share > 2 / 3), run: 0 };
  }

  /**
   * What one tap does, and how to take it back. Everything is done at once but one thing: a pause from a side third,
   * where a second tap would make it a skip. Pausing prints the page, and a page that printed and unprinted under a
   * double tap would flash; so that pause waits out the double tap's window, and a second tap simply cancels it.
   */
  #act(side: boolean): (() => void) | null {
    const container = this.#container;
    const playback = this.#playback.value;
    const controls = this.#controls.value;
    if (!container || !playback) return null;
    // Chrome over the film that has gone away comes back first; only a tap with it up reaches the film. (A paused
    // film always has its controls; in the pad they are not over the film at all.)
    const over = !container.hasAttribute('data-fb-pad');
    if (over && controls && !controls.controlsVisible && !playback.paused) {
      controls.toggleControls(true);
      return () => controls.toggleControls(false);
    }
    if (playback.paused || playback.ended) {
      void playback.play();
      return () => playback.pause();
    }
    if (!side) {
      playback.pause();
      return () => void playback.play();
    }
    const timer = window.setTimeout(() => playback.pause(), DOUBLE_WINDOW);
    return () => clearTimeout(timer);
  }

  #toggleFullscreen() {
    const container = this.#container;
    const key = container?.querySelector<HTMLElement>('media-fullscreen-button');
    // The key itself: where a page can't ask for fullscreen, its press is what fills the screen (screen.ts).
    if (key) key.click();
    else {
      const fullscreen = this.#fullscreen.value;
      if (fullscreen?.isFullscreen) void fullscreen.exitFullscreen();
      else void fullscreen?.requestFullscreen();
    }
  }

  #skip(direction: 1 | -1, side: 1 | -1, run: number) {
    const time = this.#time.value;
    const mark = this.#mark;
    if (!time) return;
    const duration = Number.isFinite(time.duration) ? time.duration : 0;
    const to = Math.max(0, Math.min(time.currentTime + direction * SKIP, duration ? duration - 0.05 : time.currentTime + direction * SKIP));
    void time.seek(to);
    if (!mark) return;
    const count = mark.querySelector<HTMLElement>('.fb-hand-count');
    const seconds = Math.abs(run) * SKIP;
    if (count) count.textContent = say(this.#i18n, direction > 0 ? 'flipbook.forward' : 'flipbook.backward', { seconds });
    mark.dataset.side = side > 0 ? 'end' : 'start';
    mark.dataset.direction = direction > 0 ? 'forward' : 'back';
    mark.toggleAttribute('data-open', true);
    // The leaves riffle once per tap; under reduced motion the mark is simply there.
    if (!reducedMotion.matches) {
      for (const [i, leaf] of [...mark.querySelectorAll<HTMLElement>('.fb-hand-leaves > i')].entries()) {
        leaf.getAnimations().forEach((animation) => animation.cancel());
        leaf.animate(
          [
            { transform: 'rotateY(0deg)', opacity: 1 },
            { transform: `rotateY(${direction > 0 ? -150 : 150}deg)`, opacity: 0 },
          ],
          { duration: 220, delay: i * 45, easing: 'cubic-bezier(0.23, 1, 0.32, 1)', fill: 'backwards' },
        );
      }
    }
    navigator.vibrate?.(4);
    clearTimeout(this.#markTimer);
    this.#markTimer = window.setTimeout(() => mark.toggleAttribute('data-open', false), MARK_HOLD);
  }

  // ─── A hold ────────────────────────────────────────────────────────────────

  #hold(touch: Touch) {
    const container = this.#container;
    const video = container ? videoIn(container) : null;
    if (!container || !video || this.#touch !== touch || touch.moved || video.paused) return;
    // A swipe that has taken the film (flip.ts) is not a hold.
    if (container.getAttribute('data-fb-deck') === 'flip') return;
    touch.held = true;
    this.#last = null;
    this.#rate = video.playbackRate || 1;
    const fast = Math.max(HOLD_RATE, this.#rate);
    video.playbackRate = fast;
    container.toggleAttribute('data-fb-hold', true);
    const chip = this.#chip;
    if (chip) {
      chip.textContent = say(this.#i18n, 'flipbook.flipRate', { rate: String(fast) });
      chip.toggleAttribute('data-open', true);
    }
    navigator.vibrate?.(8);
  }

  #release(touch: Touch) {
    const container = this.#container;
    const video = container ? videoIn(container) : null;
    touch.held = false;
    container?.toggleAttribute('data-fb-hold', false);
    this.#chip?.toggleAttribute('data-open', false);
    // Only if the rate is still the hold's: a rate chosen meanwhile (the menu, a key) is the viewer's own.
    if (video && Math.abs(video.playbackRate - Math.max(HOLD_RATE, this.#rate)) < 0.001) video.playbackRate = this.#rate;
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('fb-hand')) customElements.define('fb-hand', FbHandElement);
attach('fb-hand');
