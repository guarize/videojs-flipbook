import { UIElement } from '@videojs/html';
import { reducedMotion, videoIn } from './book';
import { captionsAsked } from './sources';

/** Space kept between the captions and whatever they sit above, and from the picture's edges. */
const GAP = 12;
const EDGE = 14;

/**
 * Captions that are never covered. The browser's own caption rendering is hidden, and the cues of the track that's
 * showing are drawn here instead, in a layer that measures what's on screen (the slab and its tabs, the deck, the
 * corner curl, any panel marked `[data-fb-overlay]`) and sits clear of it, moving smoothly when the controls come
 * and go. When nothing below leaves room (the deck is open, a panel fills the bottom), they move to the top.
 *
 * Video.js keeps owning which track is on: the captions button, the menu and the `c` key all work as before. (One
 * case is this layer's: a `c` pressed while the film is still opening and its tracks are out; see below.)
 */
export class FbCaptionsElement extends UIElement {
  #abort: AbortController | null = null;
  #container: HTMLElement | null = null;
  #video: HTMLVideoElement | null = null;
  #track: TextTrack | null = null;
  #lines: HTMLElement | null = null;
  #frame = 0;
  #y = Number.NaN;

  connectedCallback() {
    super.connectedCallback();
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    this.setAttribute('aria-hidden', 'true');
    this.#lines = document.createElement('div');
    this.#lines.className = 'fb-captions-lines';
    this.replaceChildren(this.#lines);
    this.#container = this.closest('media-container');
    const container = this.#container;
    if (!container) return;
    container.toggleAttribute('data-fb-captions', true);

    queueMicrotask(() => {
      const video = videoIn(container);
      if (!video || signal.aborted) return;
      this.#video = video;
      const pick = () => this.#pick();
      video.textTracks.addEventListener('change', pick, { signal });
      video.textTracks.addEventListener('addtrack', pick, { signal });
      pick();
    });

    // C pressed before the film has opened: its caption tracks are out for the opening (sources.ts), so the player
    // has nothing to turn on and the press would be lost. The choice is kept and comes back with the tracks. (Heard
    // first, and left to the player all the same: with no track in the film, its own C does nothing.)
    container.addEventListener('keydown', (event) => {
      if (event.key.toLowerCase() !== 'c' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.repeat) return;
      if ((event.target as Element | null)?.closest?.('input, textarea, select, [contenteditable]')) return;
      const video = videoIn(container);
      if (video) captionsAsked(video);
    }, { signal, capture: true });

    // Whatever might cover the captions: controls showing or hiding, the deck, panels opening, sizes changing.
    new MutationObserver(() => this.#schedule()).observe(container, {
      subtree: true,
      attributes: true,
      attributeFilter: ['data-controls-visible', 'data-visible', 'data-paused', 'data-ended', 'data-fb-deck', 'data-open', 'hidden', 'data-fb-overlay', 'data-strip', 'data-active', 'data-fb-cap-position', 'data-fb-cap-size'],
    });
    const resize = new ResizeObserver(() => this.#schedule());
    resize.observe(container);
    resize.observe(this);
    // The lines themselves: a cue that wraps to a second line after it was placed is placed again.
    resize.observe(this.#lines);
    signal.addEventListener('abort', () => resize.disconnect());
    container.addEventListener('transitionend', () => this.#schedule(), { signal });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort?.abort();
    cancelAnimationFrame(this.#frame);
    this.#container?.toggleAttribute('data-fb-captions', false);
    this.#container?.toggleAttribute('data-fb-caption-over', false);
  }

  /** The track that's showing, captions or subtitles; its cues are followed from here on. */
  #pick() {
    const video = this.#video;
    if (!video) return;
    const showing = Array.from(video.textTracks).find((t) => t.mode === 'showing' && (t.kind === 'captions' || t.kind === 'subtitles')) ?? null;
    if (showing === this.#track) return this.#render();
    this.#track?.removeEventListener('cuechange', this.#onCue);
    this.#track = showing;
    showing?.addEventListener('cuechange', this.#onCue);
    this.#render();
  }

  #onCue = () => this.#render();

  #render() {
    const lines = this.#lines;
    if (!lines) return;
    const cues = this.#track?.mode === 'showing' ? Array.from(this.#track.activeCues ?? []) : [];
    const text = cues
      .map((cue) => (cue as VTTCue).text ?? '')
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const current = Array.from(lines.children).map((child) => child.textContent);
    if (current.join('\n') !== text.join('\n')) {
      lines.replaceChildren(
        ...text.map((line) => {
          const span = document.createElement('span');
          span.className = 'fb-captions-line';
          span.textContent = line;
          return span;
        }),
      );
    }
    this.toggleAttribute('data-open', text.length > 0);
    if (!text.length) this.#container?.toggleAttribute('data-fb-caption-over', false);
    this.#schedule();
  }

  #schedule() {
    if (this.#frame) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      this.#place();
    });
  }

  /** Measures what's on screen and sets the captions just clear of it. */
  #place() {
    const container = this.#container;
    const lines = this.#lines;
    if (!container || !lines || !this.hasAttribute('data-open')) return;
    const box = container.getBoundingClientRect();
    const own = lines.getBoundingClientRect();
    const height = own.height;
    // Where the lines are drawn (centred in their layer, which keeps out of a side edge's column).
    const left = own.left;
    const right = own.right;
    const visible = (el: Element | null): el is HTMLElement => {
      if (!(el instanceof HTMLElement) || el.hidden) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.05;
    };
    const across = (r: DOMRect) => r.width > 0 && r.height > 0 && r.left < right && r.right > left;

    // What the captions must never cover: the slab (with its tabs, which stand above it), panels, the resume offer,
    // open menus, and the big play key while paused.
    const hard: DOMRect[] = [];
    const controlsShown = container.querySelector('.video-controls-content')?.hasAttribute('data-visible') ?? false;
    const bar = container.querySelector('.fb-bar');
    // The slab counts while it can be seen, not only while the player calls its controls active: going idle it
    // fades for 250 ms, and keyboard focus in it holds it up with no activity at all (skin.css). A caption that
    // took its place on the attribute alone lay over it meanwhile. (Coming back, the attribute is ahead of the fade.)
    const slabSeen = bar instanceof HTMLElement && !bar.hidden && getComputedStyle(bar).display !== 'none' && Number(getComputedStyle(bar).opacity) > 0.05;
    if (bar instanceof HTMLElement && (slabSeen || (controlsShown && visible(bar.parentElement)))) {
      const r = bar.getBoundingClientRect();
      // The tabs stand above the slab on a wide player (16 px, and 6 of air). In a phone's pad they are under the
      // picture with the rest of the controls (phone.css): nothing to clear there.
      const tabs = container.querySelector('.fb-tabs');
      const above = !container.hasAttribute('data-fb-pad') && visible(tabs);
      const face = above ? tabs.querySelector('.fb-tab-face')?.getBoundingClientRect() : null;
      const lift = face && face.height > 0 && face.top < r.top ? Math.round(r.top - face.top) + 6 : 0;
      hard.push(new DOMRect(r.left, r.top - lift, r.width, r.height + lift));
    }
    // The paused page's foot margin, where the strip of frames is printed (plate.ts): a caption stands over it, on the picture.
    for (const el of container.querySelectorAll('[data-fb-overlay], fb-plate[data-strip] .fb-strip, .fb-resume, .media-menu-popup[data-open], .media-volume-popover-popup[data-open], .fb-cover-play')) {
      if (visible(el) && !el.matches('.fb-hint')) hard.push(el.getBoundingClientRect());
    }
    // What gives way to a caption that needs its place, on a picture too small for both: the plate key (P still
    // works), the top bar (title and keys, while the controls show), the lifted corner and a passing hint. Each is
    // measured as laid out, not as visible, so its stepping aside doesn't move the caption back over it.
    const laid = (el: Element) => el.getClientRects().length > 0 && Number(getComputedStyle(el).opacity) > 0.05;
    const soft: { part: string; rect: DOMRect }[] = [];
    const toggle = container.querySelector('.fb-plate-toggle');
    if (toggle && laid(toggle)) soft.push({ part: 'plate', rect: toggle.getBoundingClientRect() });
    if (controlsShown) {
      for (const el of container.querySelectorAll('.video-controls-top > .media-button, .media-title')) {
        if (laid(el) && getComputedStyle(el).display !== 'none') soft.push({ part: 'top', rect: el.getBoundingClientRect() });
      }
    }
    const curl = container.querySelector('.fb-curl[data-open]');
    if (curl && laid(curl)) soft.push({ part: 'corner', rect: curl.getBoundingClientRect() });
    const hint = container.querySelector('fb-hints[data-open] .fb-hint');
    if (hint && laid(hint)) soft.push({ part: 'hint', rect: hint.getBoundingClientRect() });
    const all = [...hard, ...soft.map((s) => s.rect)];
    const deckOpen = container.hasAttribute('data-fb-deck');
    const hits = (t: number, list: DOMRect[]) => list.some((r) => across(r) && t < r.bottom + GAP / 2 && t + height > r.top - GAP / 2);

    // Low: as low as what's below the middle allows. High: under whatever is at the top.
    const low = (list: DOMRect[]) => {
      let bottom = box.bottom - EDGE;
      for (const r of list) if (across(r) && r.top > box.top + box.height * 0.4) bottom = Math.min(bottom, r.top - GAP);
      return bottom - height;
    };
    const high = (list: DOMRect[]) => {
      let top = box.top + EDGE;
      for (const r of list) if (across(r) && r.bottom < box.top + box.height * 0.5) top = Math.max(top, r.bottom + GAP);
      return top;
    };
    // Low unless there's no room there, the deck fills the middle, or the viewer's caption style asks for the top
    // (captype.ts sets data-fb-cap-position). Each place is checked against everything, not only what's near it: the
    // first clear of all wins; else the first clear of what must never be covered, and what it would cover steps aside.
    const atTop = container.getAttribute('data-fb-cap-position') === 'top';
    const pair = (list: DOMRect[]) => {
      const a = low(list);
      const b = high(list);
      return atTop || deckOpen || a < box.top + box.height * 0.22 ? [b, a] : [a, b];
    };
    const top = pair(all).find((t) => !hits(t, all)) ?? pair(hard).find((t) => !hits(t, hard)) ?? pair(all)[0];
    const over = [...new Set(soft.filter((s) => hits(top, [s.rect])).map((s) => s.part))].join(' ');
    if ((container.getAttribute('data-fb-caption-over') ?? '') !== over) {
      if (over) container.setAttribute('data-fb-caption-over', over);
      else container.removeAttribute('data-fb-caption-over');
    }
    const y = Math.round(top - box.top);
    if (y === this.#y) return;
    // The first placement, and any under reduced motion, is immediate; after that it moves.
    this.toggleAttribute('data-moving', !Number.isNaN(this.#y) && !reducedMotion.matches);
    this.#y = y;
    lines.style.transform = `translate3d(-50%, ${y}px, 0)`;
  }
}

customElements.define('fb-captions', FbCaptionsElement);
