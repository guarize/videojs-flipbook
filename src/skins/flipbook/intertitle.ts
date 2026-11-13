import { UIElement } from '@videojs/html';
import { reducedMotion, videoIn } from './book';
import { cardAt, deal, shareTime } from './cards';
import { attach } from './companion';

/** Air under the card: from the player's foot, or from the controls when they're up. */
const FOOT = 10;
const OVER_CONTROLS = 8;
/** The page's head margin over the plate, as a share of the player's height, within these limits. */
const HEAD = 0.03;
const HEAD_MIN = 8;
const HEAD_MAX = 20;
/** The plate is never set smaller than this to make room for the controls: past it the card stands on the plate's foot. */
const SMALLEST = 0.6;
/** Room kept for this many lines, so the plate doesn't change size from one cue to the next. */
const LINES = 2;
/** A card of a cue set as several stands at least this long (seconds of film). */
const CARD_FLOOR = 1.2;
/** A card arriving after another of the same cue: opacity alone, this long. */
const CARD_FADE = 200;
/** The caption sizes, smallest first (captype.ts): a cue too short for its cards at the viewer's size steps down these. */
const SIZES = ['s', 'm', 'l', 'xl'];

interface Line {
  kind: 'speech' | 'music' | 'sound';
  speaker: string;
  text: string;
}

const isCaption = (track: TextTrack) => track.kind === 'captions' || track.kind === 'subtitles';
/** An element's height as laid out, to the fraction of a pixel. */
const heightOf = (el: Element) => el.getBoundingClientRect().height;

/** A cue's lines: who speaks (a `<v>` voice, or "NAME: …"), and whether a line is music (♪) or a described sound. */
export function readCue(raw: string): Line[] {
  const lines: Line[] = [];
  let voice = '';
  // `<v Name>` opens a voice for what follows; every other tag is formatting, and goes.
  const marked = raw.replace(/<v(?:\.[^\s>]+)*\s+([^>]+)>/g, '\u0001$1\u0002').replace(/<[^>]+>/g, '');
  for (const piece of marked.split(/\r?\n/)) {
    let text = piece;
    const named = /\u0001([^\u0002]*)\u0002/.exec(text);
    if (named) voice = named[1].trim();
    text = text.replace(/\u0001[^\u0002]*\u0002/g, '').trim();
    if (!text) continue;
    let speaker = named ? voice : '';
    const prefixed = /^([A-Z][A-Z0-9 .'’-]{1,23}):\s+(\S.*)$/.exec(text);
    if (!speaker && prefixed) {
      speaker = prefixed[1].trim();
      text = prefixed[2];
    }
    const kind = /[♪♫]/.test(text) ? 'music' : /^[[(].*[\])]$/.test(text) ? 'sound' : 'speech';
    lines.push({ kind, speaker, text });
  }
  return lines;
}

/**
 * Captions as intertitles. With the Caption style page's "Intertitle" chosen, the cue is not laid over the film: the
 * picture becomes a plate on the page, with a head margin and a band of paper under it, and the cue is set in that
 * band in the page's ink, centred and balanced, under a short rule, as a silent film's card or a book's line. A
 * speaker is named over their line, music keeps its notes and sounds their brackets, each in the page's second ink.
 *
 * Still a caption. It follows the track Video.js has showing (the captions key, the menu, C, the language), at the
 * four sizes with their floors, in ink on paper (16:1; the second ink 6.9:1). The player's own box never changes: the
 * plate is scaled inside it (a transform), and room for two lines is kept from the first cue to the last, so it holds
 * still from one cue to the next. The card stands clear of everything measured on screen: when the controls come up
 * the plate makes room above them, and on a player too small for that (a phone) the card stands on the plate's foot,
 * on its own paper, directly over the controls, for as long as they're up.
 *
 * A cue of more lines than the band keeps, on a player with no room to give it (a long sentence at a large size on
 * a phone), is set as consecutive cards instead of over the picture: each at most the band's lines, at the viewer's
 * own size, ended on a phrase (cards.ts), and each standing for its share of the cue's time by its length. The
 * cards follow the film's clock, so a seek, a pause or a step back shows the card for that moment. Only a cue too
 * short to give every card its time is set a size smaller. The track's cue is untouched: this is how it is drawn.
 *
 * In the browser's own picture-in-picture window only the browser can draw captions, so there it does
 * (pip-captions.ts), and this stands down until the film is back.
 */
export class FbIntertitleElement extends UIElement {
  #abort: AbortController | null = null;
  #container: HTMLElement | null = null;
  #video: HTMLVideoElement | null = null;
  #track: TextTrack | null = null;
  #card: HTMLElement | null = null;
  #lines: HTMLElement | null = null;
  /** Lines set out of sight at the card's width, to count how many a run of words takes. */
  #gauge: HTMLElement | null = null;
  #frame = 0;
  #placed = '';
  /** The cue showing: its lines, and the stretch of film it stands for. */
  #cue: { key: string; lines: Line[]; start: number; end: number } | null = null;
  /** The cue as cards, for the width and size they were measured at; how long each stands; the one showing. */
  #dealt = '';
  #cards: Line[][] = [];
  #shares: number[] = [];
  #index = -1;
  #shown = '';
  #timer = 0;

  connectedCallback() {
    super.connectedCallback();
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    this.hidden = false;
    this.classList.add('fb-intertitle');
    this.setAttribute('aria-hidden', 'true');
    this.innerHTML =
      '<div class="fb-intertitle-card"><span class="fb-intertitle-rule"></span><div class="fb-intertitle-lines"></div><div class="fb-intertitle-lines fb-intertitle-gauge"></div></div>';
    this.#card = this.querySelector('.fb-intertitle-card');
    this.#lines = this.querySelector('.fb-intertitle-lines');
    this.#gauge = this.querySelector('.fb-intertitle-gauge');
    const container = this.closest<HTMLElement>('media-container');
    this.#container = container;
    if (!container) return;

    queueMicrotask(() => {
      const video = videoIn(container);
      if (!video || signal.aborted) return;
      this.#video = video;
      const pick = () => this.#pick();
      video.textTracks.addEventListener('change', pick, { signal });
      video.textTracks.addEventListener('addtrack', pick, { signal });
      video.addEventListener('loadedmetadata', () => this.#schedule(), { signal });
      // The cards follow the film's clock: wherever it goes, and however fast.
      for (const type of ['timeupdate', 'seeking', 'seeked', 'play', 'pause', 'ratechange']) video.addEventListener(type, () => this.#follow(), { signal });
      pick();
    });
    // Words are measured in the page's own face: once it has arrived, they are measured again.
    void document.fonts.ready.then(() => {
      if (signal.aborted) return;
      this.#dealt = '';
      this.#schedule();
    });

    // What can change where the card may stand: the style, the controls coming and going, panels, the player's size.
    const watch = new MutationObserver(() => this.#schedule());
    watch.observe(container, {
      subtree: true,
      attributes: true,
      attributeFilter: ['data-fb-cap-mode', 'data-fb-cap-size', 'data-controls-visible', 'data-visible', 'data-fb-pip-captions', 'data-fb-pip', 'data-fb-short', 'data-fb-features', 'data-fb-pad', 'data-fb-screen', 'data-on', 'data-open'],
    });
    const resize = new ResizeObserver(() => this.#schedule());
    resize.observe(container);
    signal.addEventListener('abort', () => {
      watch.disconnect();
      resize.disconnect();
      cancelAnimationFrame(this.#frame);
      this.#frame = 0;
      clearTimeout(this.#timer);
      this.#track?.removeEventListener('cuechange', this.#onCue);
      this.#clear();
    });
    this.#schedule();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort?.abort();
  }

  #onCue = () => this.#render();

  /** The track that's showing, captions or subtitles: the one Video.js chose. */
  #pick() {
    const video = this.#video;
    if (!video) return;
    const showing = Array.from(video.textTracks).find((t) => t.mode === 'showing' && isCaption(t)) ?? null;
    if (showing !== this.#track) {
      this.#track?.removeEventListener('cuechange', this.#onCue);
      this.#track = showing;
      showing?.addEventListener('cuechange', this.#onCue);
    }
    this.#render();
  }

  /** The cue the track has active now. Its words are set on the next frame, with the player measured (#place). */
  #render() {
    const cues = this.#track?.mode === 'showing' ? (Array.from(this.#track.activeCues ?? []) as VTTCue[]) : [];
    const lines = cues.flatMap((cue) => readCue(cue.text ?? ''));
    if (lines.length) {
      // What these cues show together stands from the last of them to begin until the first to end.
      const start = Math.max(...cues.map((cue) => cue.startTime));
      const end = Math.min(...cues.map((cue) => cue.endTime));
      const key = JSON.stringify([lines, start, end]);
      if (this.#cue?.key !== key) {
        this.#cue = { key, lines, start, end };
        this.#dealt = '';
      }
    } else {
      // Its words stay on the card while it fades: the next cue takes their place.
      this.#cue = null;
      clearTimeout(this.#timer);
    }
    this.toggleAttribute('data-open', lines.length > 0);
    this.#schedule();
  }

  /** One card's lines, as elements. */
  #set(into: HTMLElement, card: Line[]) {
    into.replaceChildren(
      ...card.map((line) => {
        const p = document.createElement('p');
        p.className = 'fb-intertitle-line';
        p.dataset.kind = line.kind;
        if (line.speaker) {
          const who = document.createElement('span');
          who.className = 'fb-intertitle-speaker';
          who.textContent = line.speaker;
          p.append(who);
        }
        const said = document.createElement('span');
        said.className = 'fb-intertitle-text';
        said.textContent = line.text;
        p.append(said);
        return p;
      }),
    );
  }

  /**
   * The cue as cards, for a card `max` px wide. A cue the band has lines for is one card, as is one the plate can
   * make room for (`roomFor`, given the card's height). Any other is dealt onto cards of the band's lines; if the
   * cue is too short to give each its time, a size smaller is tried, down to the smallest, where the whole cue is
   * set as one card on the plate's foot.
   */
  #deal(max: number, roomFor: (height: number) => boolean) {
    const cue = this.#cue;
    const container = this.#container;
    const card = this.#card;
    const lines = this.#lines;
    const gauge = this.#gauge;
    if (!cue || !container || !card || !lines || !gauge) return;
    const chosen = container.getAttribute('data-fb-cap-size') ?? 'm';
    const key = [cue.key, max, chosen].join('|');
    if (key === this.#dealt) return;
    this.#dealt = key;
    this.removeAttribute('data-step');

    const style = getComputedStyle(card);
    gauge.style.width = `${max - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)}px`;
    /** How many lines a card takes, and how tall they stand. */
    const gauged = (candidate: Line[]) => {
      this.#set(gauge, candidate);
      const leading = Number.parseFloat(getComputedStyle(gauge).lineHeight) || 1;
      const count = [...gauge.children].reduce((sum, p) => sum + Math.round(heightOf(p) / leading), 0);
      return { count, height: heightOf(gauge) };
    };
    const fits = (candidate: Line[]) => gauged(candidate).count <= LINES;
    const chrome = heightOf(card) - heightOf(lines);

    let cards = [cue.lines];
    let shares = [cue.end - cue.start];
    const whole = gauged(cue.lines);
    if (whole.count > LINES && !roomFor(chrome + whole.height)) {
      const from = Math.max(0, SIZES.indexOf(chosen));
      for (let step = from; step >= 0; step--) {
        if (step < from) this.setAttribute('data-step', SIZES[step]);
        const dealt = fits(cue.lines) ? [cue.lines] : deal(cue.lines, fits);
        const times = shareTime(dealt.map((c) => c.reduce((sum, line) => sum + line.text.length, 0)), cue.end - cue.start, CARD_FLOOR);
        if (!times) continue;
        cards = dealt;
        shares = times;
        break;
      }
    }
    gauge.replaceChildren();
    this.#cards = cards;
    this.#shares = shares;
    this.#index = -1;
    if (cards.length > 1) {
      this.setAttribute('data-cards', String(cards.length));
      this.setAttribute('data-shares', shares.map((share) => share.toFixed(3)).join(' '));
    } else {
      this.removeAttribute('data-cards');
      this.removeAttribute('data-shares');
      this.removeAttribute('data-card');
    }
    this.#follow(true);
  }

  /**
   * The card for where the film is, set if it is not the one showing; and, while it plays, a look again as the next
   * is due. New words are placed on the next frame, unless this is the placing itself (`placing`).
   */
  #follow(placing = false) {
    const cue = this.#cue;
    const video = this.#video;
    const lines = this.#lines;
    clearTimeout(this.#timer);
    if (!cue || !video || !lines || !this.#cards.length || !this.#dealt) return;
    const elapsed = Math.max(0, Math.min(video.currentTime, cue.end) - cue.start);
    const index = cardAt(this.#shares, elapsed);
    if (index !== this.#index) {
      const next = `${JSON.stringify(this.#cards[index])}|${this.getAttribute('data-step') ?? ''}`;
      // (The same cue's next card arrives softly; a new cue's first comes with the card itself.)
      const within = this.#index >= 0 && this.#cards.length > 1;
      this.#index = index;
      if (this.#cards.length > 1) this.setAttribute('data-card', String(index + 1));
      if (next !== this.#shown) {
        this.#shown = next;
        this.#set(lines, this.#cards[index]);
        for (const animation of lines.getAnimations()) animation.cancel();
        if (within && !reducedMotion.matches) lines.animate([{ opacity: 0 }, { opacity: 1 }], { duration: CARD_FADE, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' });
        if (!placing) this.#schedule();
      }
    }
    if (video.paused || index >= this.#cards.length - 1) return;
    const due = cue.start + this.#shares.slice(0, index + 1).reduce((sum, share) => sum + share, 0);
    this.#timer = window.setTimeout(() => this.#follow(), Math.max(0, ((due - video.currentTime) / (video.playbackRate || 1)) * 1000) + 4);
  }

  #schedule() {
    if (this.#frame) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      this.#place();
    });
  }

  #clear() {
    const container = this.#container;
    if (!container) return;
    container.removeAttribute('data-fb-intertitle');
    container.removeAttribute('data-fb-intertitle-top');
    container.removeAttribute('data-fb-intertitle-moving');
    for (const name of ['--fb-it-scale', '--fb-it-y']) container.style.removeProperty(name);
    this.#placed = '';
  }

  /** Measures the player and what stands on it, and sets the plate and the card. */
  #place() {
    const container = this.#container;
    const card = this.#card;
    const lines = this.#lines;
    if (!container || !card || !lines) return;
    const chosen = container.getAttribute('data-fb-cap-mode') === 'intertitle';
    const elsewhere = container.hasAttribute('data-fb-pip-captions');
    if (!chosen || elsewhere || !this.#track) {
      if (container.hasAttribute('data-fb-intertitle')) this.#clear();
      return;
    }
    const box = container.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return;
    if (!container.hasAttribute('data-fb-intertitle')) container.setAttribute('data-fb-intertitle', '');

    const visible = (el: Element | null): el is HTMLElement => {
      if (!(el instanceof HTMLElement) || el.hidden || !el.getClientRects().length) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
    // The controls, wherever this layout puts them: the slab with the tabs that stand over it, and the fore-edge.
    const shown = container.querySelector('.video-controls-content')?.hasAttribute('data-visible') ?? false;
    // Along the foot they lift the band. (In a phone's pad they are under the picture and lift nothing.)
    const EDGE = '.fb-seek, media-time-slider, .fb-tab-face';
    let lift = 0;
    let left = 0;
    let right = 0;
    if (shown) {
      for (const el of container.querySelectorAll(`.fb-bar, .fb-row, ${EDGE}`)) {
        if (!visible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        if (r.top > box.top + box.height * 0.35) lift = Math.max(lift, box.bottom - r.top);
      }
    }

    // The picture as the video shows it (contained), before any scaling.
    const video = this.#video;
    const ratio = video && video.videoWidth > 0 ? video.videoWidth / video.videoHeight : box.width / box.height;
    const shownHeight = Math.min(box.height, box.width / ratio);
    const head = Math.max(HEAD_MIN, Math.min(HEAD_MAX, box.height * HEAD));
    const fits = (foot: number, under: number) => (box.height - foot - under - head) / shownHeight;

    // The card's width first (its lines wrap to it), then its height: at least the room kept for two lines.
    const style = getComputedStyle(lines);
    let natural = 0;
    let band = 0;
    const measure = () => {
      const max = Math.max(120, Math.floor(box.width - left - right - 24));
      card.style.maxWidth = `${max}px`;
      // Its natural height, without the room it was given last time.
      card.style.minHeight = '';
      // The cue's cards for this width: the plate has room for a taller card while that leaves it its size.
      this.#deal(max, (tall) => Math.min(1, fits(FOOT, tall)) >= SMALLEST);
      const size = Number.parseFloat(style.fontSize) || 16;
      const leading = Number.parseFloat(style.lineHeight) || size * 1.3;
      // (To the fraction of a pixel: rounded, a card of one line and a card of two gave bands a pixel apart, and the
      // plate changed size by that pixel from one to the next.)
      natural = heightOf(card);
      const chrome = natural - heightOf(lines);
      band = Math.ceil(chrome + leading * LINES);
      return Math.max(natural, band);
    };
    let height = measure();
    // On a small player with the controls up the card can reach the top corners, which are keys (the dog-ear on the
    // left, the corner curl on the right): it narrows to stand beside them, never on them.
    if (lift > 0) {
      const top = box.height - lift - OVER_CONTROLS - height;
      let narrowed = false;
      for (const key of container.querySelectorAll<HTMLElement>('.fb-ear[data-on] .fb-ear-button, .fb-curl[data-open] .fb-curl-button')) {
        if (!visible(key)) continue;
        const r = key.getBoundingClientRect();
        if (r.bottom - box.top + 4 <= top) continue;
        narrowed = true;
        if (r.left + r.width / 2 < box.left + box.width / 2) left = Math.max(left, r.right - box.left + 4);
        else right = Math.max(right, box.right - r.left + 4);
      }
      if (narrowed) height = measure();
    }
    const span = box.width - left - right;

    const raised = Math.min(1, fits(lift + OVER_CONTROLS, height));
    // The plate makes room, down to a size: for the controls when they are up, and for a cue of more lines than the
    // band keeps. Past that size the plate keeps the band's room and the card stands on the plate's foot (a long cue
    // is set as cards of the band's lines before it comes to that, #deal: only one too short for cards gets here).
    const long = natural > band + 0.5 && Math.min(1, fits(FOOT, height)) < SMALLEST;
    const over = long || (lift > 0 && raised < SMALLEST);
    const kept = long ? band : height;
    const scale = Math.max(0.3, lift > 0 && !over ? raised : Math.min(1, fits(FOOT, kept)));
    // On the plate's foot the card is only as tall as its lines: the room for two is the band's, not the slip's.
    const tall = over ? natural : height;
    const cardTop = box.height - (lift > 0 ? lift + OVER_CONTROLS : FOOT) - tall;
    // The plate under the head margin, or centred in the room it has when that's more than it needs.
    const plateBottom = over ? box.height - FOOT - kept : cardTop;
    const plateTop = Math.max(head, (plateBottom - scale * shownHeight) / 2);
    const y = plateTop - (scale * (box.height - shownHeight)) / 2;
    const x = left + (span - card.offsetWidth) / 2;

    // (Given back on every pass: measuring took it away, and a card left without it sets a single line at the band's
    // head instead of its middle.)
    card.style.minHeight = `${tall}px`;
    const stood = [scale.toFixed(4), y.toFixed(1), Math.round(cardTop), over].join(' ');
    const placed = `${stood} ${Math.round(x)}`;
    if (placed === this.#placed) return;
    // The first setting is immediate; after that the plate and the card move together. New words of another width
    // only centre the card again: that is set, not travelled (the words would slide sideways as they arrive).
    const moving = this.#placed !== '' && !this.#placed.startsWith(`${stood} `) && !reducedMotion.matches;
    this.toggleAttribute('data-moving', moving);
    container.toggleAttribute('data-fb-intertitle-moving', moving);
    this.#placed = placed;
    container.style.setProperty('--fb-it-scale', scale.toFixed(4));
    container.style.setProperty('--fb-it-y', `${y.toFixed(1)}px`);
    this.toggleAttribute('data-over', over);
    // The title gives its row up to a card that has had to climb into it; the cover and Contents still carry it.
    const title = container.querySelector<HTMLElement>('.media-title');
    const row = title && visible(title) ? title.getBoundingClientRect() : null;
    container.toggleAttribute('data-fb-intertitle-top', !!row && cardTop < row.bottom - box.top + 4);
    card.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(cardTop)}px, 0)`;
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('fb-intertitle')) customElements.define('fb-intertitle', FbIntertitleElement);
attach('fb-intertitle', 'intertitle');
