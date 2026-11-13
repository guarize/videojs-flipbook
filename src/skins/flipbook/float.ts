import { PlayerController, playerContext, type PropertyValues, selectFullscreen, selectPiP, selectPlayback, UIElement } from '@videojs/html';
import { I18nController, i18nContext, registerI18n } from '@videojs/html/i18n';
import { reducedMotion } from './book';
import { attach } from './companion';
import { shouldDock } from './steps';

/*
 * The mini player's strings, in Video.js's registry so a locale pack can translate them.
 * They are kept here, beside the one module that says them, so the extra carries its own words.
 */
const TEXT = {
  group: 'Mini player',
  back: 'Back to the player',
  close: 'Close the mini player',
} as const;
registerI18n('en', { flipbookFloat: { ...TEXT } } as unknown as Parameters<typeof registerI18n>[1]);

/** As long as the way out takes (float.css, `--fb-float-out`), and a little over, for when no transition runs. */
const OUT = 240;
/** A player within this distance of the screen counts as in view: it's back in place before it shows. */
const MARGIN = '48px 0px';
/** The skin's tokens the bar needs: it sits beside the player, outside the skin's scope. */
const TOKENS = [
  '--fb-cover-raised',
  '--fb-cover-solid',
  '--fb-cover-line',
  '--fb-on-cover',
  '--fb-ring',
  '--fb-ease-out',
  '--fb-font',
  '--fb-radius-control',
  '--fb-target',
  '--fb-shadow-card',
  '--fb-fast',
];

// Drawn to the skin's set (icons.ts): a 20-unit grid, one 1.5 line, round caps and joins.
const svg = (body: string) =>
  `<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON_BACK = svg('<path d="M10 15.25V4.75M5.75 9 10 4.75 14.25 9"/>');
const ICON_CLOSE = svg('<path d="m5.75 5.75 8.5 8.5M14.25 5.75l-8.5 8.5"/>');

type Phase = 'inline' | 'set' | 'in' | 'out' | 'gone';

/**
 * A mini player when the page scrolls it away. On a page that asks for it (`data-fb-float` on the player, its
 * container or a parent), a playing film whose place scrolls out of view moves to the bottom-right corner as a small
 * book, and comes back when its place does. Its space on the page is held while it's away, so nothing below moves.
 *
 * Above the small book, two keys: back to the player (scrolls the page to it) and close (puts it back in its place,
 * still playing). Escape closes it too. It doesn't float in fullscreen, in a picture-in-picture window, or before the
 * film has been played; once afloat, pausing leaves it there.
 *
 * It moves in and out by opacity and transform alone, and a change of mind midway turns it around from where it is.
 * Under reduced motion it fades, without travel.
 */
export class FbFloatElement extends UIElement {
  #playback = new PlayerController(this, playerContext, selectPlayback);
  #fullscreen = new PlayerController(this, playerContext, selectFullscreen);
  #pip = new PlayerController(this, playerContext, selectPiP);
  #i18n = new I18nController(this, i18nContext);
  #abort: AbortController | null = null;
  #container: HTMLElement | null = null;
  #slot: HTMLElement | null = null;
  #bar: HTMLElement | null = null;
  #observer: IntersectionObserver | null = null;
  #phase: Phase = 'inline';
  #outOfView = false;
  #dismissed = false;
  #timer = 0;
  #frame = 0;
  /** Where focus goes once it's back in its place: at once (closed), or once the page has scrolled to it (back). */
  #focusAfter: false | 'now' | 'settled' = false;

  connectedCallback() {
    super.connectedCallback();
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    const container = this.closest<HTMLElement>('media-container');
    this.#container = container;
    if (!container || typeof IntersectionObserver === 'undefined') return;

    const slot = document.createElement('div');
    slot.className = 'fb-float-slot';
    slot.setAttribute('aria-hidden', 'true');
    this.#slot = slot;

    const bar = document.createElement('div');
    bar.className = 'fb-float-bar';
    bar.setAttribute('role', 'group');
    bar.hidden = true;
    bar.innerHTML = `<button type="button" class="fb-float-key fb-float-back">${ICON_BACK}<span class="fb-float-name"></span></button><button type="button" class="fb-float-key fb-float-close">${ICON_CLOSE}</button>`;
    bar.querySelector('.fb-float-back')?.addEventListener('click', () => this.back(), { signal });
    bar.querySelector('.fb-float-close')?.addEventListener('click', () => this.close(), { signal });
    bar.addEventListener('keydown', (event) => this.#escape(event), { signal });
    this.#bar = bar;
    this.#label();

    container.addEventListener('keydown', (event) => this.#escape(event), { signal });
    container.addEventListener('fb-pip-enter', () => this.#decide(), { signal });
    container.addEventListener('fb-pip-leave', () => this.#decide(), { signal });

    this.#observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        this.#outOfView = !entry.isIntersecting;
        if (!this.#outOfView) this.#dismissed = false;
        this.#decide();
      },
      { rootMargin: MARGIN, threshold: 0 },
    );
    this.#observer.observe(container);
    signal.addEventListener('abort', () => {
      this.#observer?.disconnect();
      this.#observer = null;
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort?.abort();
    // Moved into a Document picture-in-picture window, or gone: either way it's no longer floating.
    this.#finish();
    this.#bar?.remove();
  }

  override update(changed: PropertyValues) {
    super.update(changed);
    this.#label();
    this.#decide();
  }

  get docked() {
    return this.#phase === 'set' || this.#phase === 'in';
  }

  /** Puts the player back in its place, still playing, and keeps it there until its place has been in view again. */
  close() {
    if (this.#phase === 'inline') return;
    this.#dismissed = true;
    this.#focusAfter = this.#bar?.contains(document.activeElement) ? 'now' : false;
    this.#decide();
  }

  /** Scrolls the page back to the player; it settles into its place as that comes into view. */
  back() {
    const slot = this.#slot;
    const container = this.#container;
    if (!slot || !container || this.#phase === 'inline') return;
    // Focus follows the player once it's back in its place, not while it's still afloat.
    this.#focusAfter = this.#bar?.contains(document.activeElement) ? 'settled' : false;
    slot.scrollIntoView({ block: 'center', behavior: reducedMotion.matches ? 'instant' : 'smooth' });
  }

  #escape(event: KeyboardEvent) {
    if (event.key !== 'Escape' || event.defaultPrevented || !this.docked) return;
    const target = event.target instanceof Element ? event.target : null;
    // Escape belongs first to whatever is open inside the player: a menu, a dialog, the deck.
    if (target?.closest('[role="dialog"], [role="menu"], [role="listbox"], [data-open].media-popup')) return;
    if (this.#container?.hasAttribute('data-fb-deck')) return;
    event.preventDefault();
    this.close();
  }

  #label() {
    const bar = this.#bar;
    if (!bar) return;
    const t = (key: keyof typeof TEXT) => {
      try {
        return this.#i18n.value?.(`flipbookFloat.${key}`, { default: TEXT[key] }) ?? TEXT[key];
      } catch {
        return TEXT[key];
      }
    };
    bar.setAttribute('aria-label', t('group'));
    const name = bar.querySelector('.fb-float-name');
    if (name) name.textContent = t('back');
    bar.querySelector('.fb-float-close')?.setAttribute('aria-label', t('close'));
  }

  #decide() {
    const container = this.#container;
    if (!container) return;
    const pip = container.hasAttribute('data-fb-pip') || !!this.#pip.value?.isPictureInPicture;
    const dock = shouldDock(this.docked, {
      optedIn: !!container.closest('[data-fb-float]'),
      outOfView: this.#outOfView,
      playing: this.#playback.value ? !this.#playback.value.paused : false,
      pip,
      fullscreen: !!this.#fullscreen.value?.isFullscreen || !!document.fullscreenElement,
      dismissed: this.#dismissed,
    });
    if (dock && !this.docked) this.#dock();
    else if (!dock && this.docked) this.#undock(pip || !!document.fullscreenElement);
  }

  /** Into the corner. The switch is made while it can't be seen; then it arrives. */
  #dock() {
    const container = this.#container;
    const slot = this.#slot;
    const bar = this.#bar;
    if (!container || !slot || !bar) return;
    clearTimeout(this.#timer);
    if (this.#phase === 'out') {
      // Turned around on the way out: it comes back from where it is.
      this.#set('in');
      return;
    }
    if (this.#phase === 'gone') this.#finish();
    const box = container.getBoundingClientRect();
    slot.style.width = `${box.width}px`;
    slot.style.aspectRatio = `${box.width} / ${box.height}`;
    const style = getComputedStyle(container);
    slot.style.borderRadius = style.borderTopLeftRadius;
    container.style.setProperty('--fb-float-ratio', `${box.width} / ${box.height}`);
    // The number too, for the corner's height bound (float.css).
    container.style.setProperty('--fb-float-ratio-n', String(box.width / box.height));
    for (const token of TOKENS) bar.style.setProperty(token, style.getPropertyValue(token));
    bar.style.setProperty('--fb-float-ratio-n', String(box.width / box.height));
    container.before(slot);
    container.before(bar);
    bar.hidden = false;
    this.#set('set');
    this.#watch(slot);
    // Two frames: the placement lands unseen, then the arrival runs from it.
    cancelAnimationFrame(this.#frame);
    this.#frame = requestAnimationFrame(() => {
      this.#frame = requestAnimationFrame(() => {
        if (this.#phase === 'set') this.#set('in');
        this.#keepClear(bar);
      });
    });
  }

  #scrollPadding: string | null = null;

  /**
   * While afloat, the page scrolls what gets focus clear of the corner (WCAG 2.4.11): its scroll padding at the
   * bottom is the height the small book and its keys take, from the bottom of the window. The page's own value
   * comes back when it lands.
   */
  #keepClear(bar: HTMLElement) {
    const root = document.documentElement;
    if (this.#scrollPadding === null) this.#scrollPadding = root.style.scrollPaddingBlockEnd;
    // Measured as it starts to arrive, up to 12 px below where it rests (--fb-float-travel): 20 px covers that and air.
    const top = bar.getBoundingClientRect().top;
    root.style.scrollPaddingBlockEnd = `${Math.max(0, Math.ceil(window.innerHeight - top + 20))}px`;
  }

  /** Out of the corner, then back in its place once it can't be seen. Into fullscreen or a window: at once. */
  #undock(now: boolean) {
    cancelAnimationFrame(this.#frame);
    clearTimeout(this.#timer);
    if (now || this.#phase === 'set') {
      this.#finish();
      return;
    }
    this.#set('out');
    this.#timer = window.setTimeout(() => this.#settle(), OUT);
  }

  /**
   * Back into the page without a jump: for one frame the player isn't drawn at all (its place still held by the
   * slot), so it reappears in its place rather than moving there, and nothing on the page registers a shift.
   */
  #settle() {
    this.#set('gone');
    cancelAnimationFrame(this.#frame);
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      if (this.#phase === 'gone') this.#finish();
    });
  }

  #finish() {
    cancelAnimationFrame(this.#frame);
    clearTimeout(this.#timer);
    const container = this.#container;
    const wasDocked = this.#phase !== 'inline';
    this.#set('inline');
    if (this.#bar) this.#bar.hidden = true;
    this.#bar?.remove();
    this.#slot?.remove();
    container?.style.removeProperty('--fb-float-ratio');
    container?.style.removeProperty('--fb-float-ratio-n');
    if (this.#scrollPadding !== null) {
      document.documentElement.style.scrollPaddingBlockEnd = this.#scrollPadding;
      this.#scrollPadding = null;
    }
    if (container && wasDocked) this.#watch(container);
    const after = this.#focusAfter;
    this.#focusAfter = false;
    if (after && container) {
      // After the move has painted, and after the page's scroll to it has settled: focus landing in the same frame
      // as the move reads as the player jumping into place.
      const focus = () => requestAnimationFrame(() => requestAnimationFrame(() => container.focus({ preventScroll: true })));
      if (after === 'settled' && 'onscrollend' in window) {
        const timer = window.setTimeout(() => {
          window.removeEventListener('scrollend', settle);
          focus();
        }, 1000);
        const settle = () => {
          clearTimeout(timer);
          focus();
        };
        window.addEventListener('scrollend', settle, { once: true });
      } else focus();
    }
  }

  #watch(target: Element) {
    const observer = this.#observer;
    if (!observer) return;
    observer.disconnect();
    observer.observe(target);
  }

  #set(phase: Phase) {
    this.#phase = phase;
    const value = phase === 'inline' ? null : phase;
    for (const el of [this.#container, this.#bar]) {
      if (!el) continue;
      if (value) el.setAttribute('data-fb-dock', value);
      else el.removeAttribute('data-fb-dock');
    }
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('fb-float')) customElements.define('fb-float', FbFloatElement);
attach('fb-float', 'float');
