import { UIElement } from '@videojs/html';
import { I18nController, i18nContext } from '@videojs/html/i18n';
import { tileAt } from '@/shared/storyboard';
import { type Book, chapterAt, clock, hush, loadBook, reducedMotion, videoIn } from './book';
import { attach } from './companion';
import { clamp, LANES } from './deck';
import { Fan } from './fan';
import { Flutter } from './flutter';
import { NOT_PICTURE, TOUCH_SLOP } from './hand';
import { say } from './i18n';
import { voiceFor } from './pages';
import { Print } from './print';
import { frameClock, type FrameClock } from './shown';
import { Stand } from './stand';
import { SLOW_SEEK } from './standing';

/** The most the picture gives at the film's ends (px), and the pull that brings it to about two thirds of that. */
const BAND_REACH = 28;
const BAND_PULL = 120;

/*
 * Flipping is playing. In a flipbook the hand makes the motion; here it does too. Run a finger, the mouse or the
 * wheel along the fore-edge and the film itself moves in the picture at the speed of the hand, frame by frame,
 * forwards and backwards. Let go with the hand still moving and the pages keep going at that speed and settle to
 * 1×: the film is simply playing. Let go still and it rests there. Holding ← or → riffles the same way, faster the
 * longer it's held. Paused, the picture is a printed page (print.ts) and ← and → turn exactly one.
 *
 * A finger across the picture does the same as a thumb along the edge, at a finer gear (the picture's width is
 * sixteen seconds of film, not all of it): the film follows it, to the right is on, and a flick plays. Up and down
 * stays the page's scroll: the browser keeps vertical pans (`touch-action: pan-y`), and nothing here moves the film
 * until a touch has gone sideways.
 *
 * How the picture keeps up (measured, design/previews/flip-r1 and the report): while a hand drives, the film is
 * paused and chased with exact seeks, one in flight at a time, the next one asked the moment the last has landed
 * (asking on every pointer move starves the decoder: fewer frames, and holes of a third of a second). After a flick
 * the film plays for real, its `playbackRate` eased from the hand's speed down to the viewer's own rate; faster than
 * 4×, or backwards, it is chased the same way until it has slowed into that range.
 *
 * A film that cannot be sought that fast (a stream: its keyframes are seconds apart) is given a stand-in, a silent
 * copy that can (stand.ts, `scrub` on the player). Then the hand chases the stand-in, which shows over the picture,
 * and the film is only told where the hand is a few times a second, so its clock and the fore-edge follow; when the
 * hand rests the film is sought there once and the stand-in leaves when the film shows the same frame. Thrown
 * forwards, the stand-in carries the pages on while the film is sought to where they will be a moment later, and the
 * film plays from there as they arrive.
 *
 * Everything here is the book's (it loads with `deck`): without it the fore-edge is Video.js's own seek slider,
 * whose role, value text and keys this never changes.
 *
 * ── Who has the film ──────────────────────────────────────────────────────────────────────────────────────────────
 *
 * One owner at a time, and it is `#mode` here (`fb-flip[data-mode]`). The deck's hover (deck.ts) is not an owner: it
 * only shows a moment, and it is told when to stand down (`fb-flip`, with who took the film and where) and from where
 * it may look again (`fb-flip-end`).
 *
 *   idle ──hover (a mouse resting on the edge)──▶ deck open (deck.ts; the film is untouched)
 *     │                                            └─ leaves the edge ─▶ closes, calmly
 *     │ press on the edge (primary button)
 *     ▼
 *   press   The film goes to the press point and the deck is shut, both at once; nothing else changes.
 *     ├─ lifted within SLOP px and CLICK_HOLD ms ─▶ idle: A CLICK. Playing stays playing at its rate, paused stays
 *     │     paused; the pointer still on the edge opens nothing until it has moved on (12 px) or left and come back.
 *     └─ moved SLOP px, or held CLICK_HOLD ms ─▶ hand
 *   hand    (`data-mode="drag"`, container `data-fb-deck="flip"`) The film is paused by the hand, not by the viewer
 *           (no print, no plate), and chased to the pointer with exact seeks.
 *     ├─ lifted still ─▶ idle, at rest there: playing if it was playing before the press, paused if it was paused
 *     ├─ lifted moving (a flick) ─▶ glide
 *     ├─ Escape ─▶ idle, back where the press began, as it was
 *     └─ the pointer is lost (pointercancel, lostpointercapture, the window's blur, the page hidden, a context
 *        menu, another button, a button the page never saw lifted) ─▶ idle, at rest there, as lifted still
 *   glide   (`data-mode="coast"`) The hand's speed, never more than THROW either way, eases to the viewer's own rate
 *           if the film is to play (forwards: real playback from the first frame, `playbackRate` falling to exactly
 *           that rate), or to rest. Backwards it is chased until it has turned.
 *     ├─ settled ─▶ idle (playing at exactly the viewer's rate, or at rest)
 *     ├─ a press on the edge ─▶ hand (the catch)
 *     └─ a key, a press anywhere else, the play key, a rate from the menu, the film's end ─▶ idle, at once
 *   keys, wheel   A held arrow and the wheel over the edge take the film the same way and let go into glide or idle.
 *
 * Every way out of an owner ends in `#idle()`, which is the one place that puts things back: the mark on the
 * container, the readout, the lifted pages, the fan, the announcer. A press is dropped in one place too (`#drop`),
 * which gives the pointer back and tells the deck where it was let go.
 */

/** The film's rates a browser plays with sound and without dropping frames; outside them the film is chased. */
const RATE_MIN = 0.25;
const RATE_MAX = 4;
/** Pages settling: the hand's speed falls towards the film's own with this time constant (seconds). No bounce. */
const SETTLE = 0.4;
/** Within this of the rate it is settling to, it is that rate, exactly. */
const SETTLED = 0.05;
/** A glide to rest is over below this (film seconds per second). */
const REST = 0.35;
/** A flick: the hand still moving this fast along the edge (px per ms) within FRESH ms of letting go. */
const FLICK = 0.3;
const FRESH = 100;
/** The hand's speed is read over its last moves, this far back. */
const WINDOW = 100;
/** A press that hasn't moved this far, or lasted this long, is a click on the edge: it goes there and changes nothing else. */
const SLOP = 4;
/** A mouse's click: a hand takes its time on a button, and a click that paused the film for a blink would be a bug. */
const CLICK_HOLD = 250;
/** A thumb on an edge the page can scroll past: how long it stays put before the film is its. */
const PRESS_HOLD = 140;
/**
 * The fastest a flick of the edge throws the film, either way (film seconds per second). The edge is the whole film
 * in a hand's width, so a hand's own speed along it is tens of times the film's: thrown at that, a short film is at
 * its last page before the eye has followed. At the fastest a film plays, the throw is real playback from its first
 * frame, and it lands a few seconds from where the hand let go.
 */
const THROW = RATE_MAX;
/** An arrow held this long (or its first repeat, if that comes sooner) starts to riffle. */
const HOLD = 320;
/** The riffle by key: a page at a time, then pages, then flying. Pages per second, and how long the climb takes. */
const KEY_SLOW = 5;
const KEY_FAST_MIN = 12;
const KEY_FAST_MAX = 40;
const KEY_CLIMB = 2.2;
/** The wheel over the edge: pages per pixel of scroll, and how long after the last tick the hand has left. */
const WHEEL_PAGES = 1 / 50;
const WHEEL_IDLE = 140;
/** A scroll that was already under way when it reached the edge is the page's, until it pauses this long. */
const WHEEL_FOREIGN = 180;
/** The film's last moment is never driven onto: that would end it under the hand. */
const END_GUARD = 0.05;
/** The readout changes at most this often, from a smoothed speed, so its digits don't flicker. */
const READ_EVERY = 110;
/** Resting on a page is said once, this long after the hand has gone. */
const SAY_AFTER = 320;
/** A finger across the picture: its whole width is this much film (or all of it, if the film is shorter). */
const PICTURE_SPAN = 16;
/** The fastest a flick of the picture throws the film, either way (film seconds per second). */
const PICTURE_THROW = 8;
/** A touch's pages are felt as well as seen where the phone can (Android): one short tick a page, no more often than this. */
const TICK_EVERY = 45;
/** A seek that never reports back is forgotten after this, so the chase can't stall. */
const SEEK_LOST = 600;
/** A step back lands this far inside the frame before the one on screen: any frame is longer than that. */
const STEP_BACK = 0.008;
/** A step on, before one frame's length is known: this far past the start of the frame on screen (a sixtieth and a half), then twice as far, until the frame changes. */
const STEP_PROBE = 0.025;
const STEP_TRIES = 8;
/** A step's frame is waited for this long after its seek has landed, before the picture is taken not to have changed. */
const STEP_PATIENCE = 250;
/** With a stand-in under the hand, the film itself is told where the hand is this often (its clock, the fore-edge, the captions). */
const TELL_EVERY = 100;
/** A film still on its way to where it was last told is told again only after this. */
const TELL_AT_LEAST = 400;
/** Thrown with a stand-in: the film is sought to where the pages will be this much later, at first; then by how long its seeks take. */
const LEAD = 0.6;
const LEAD_MIN = 0.3;
const LEAD_MAX = 3;

type Mode = 'idle' | 'hand' | 'keys' | 'wheel' | 'glide';

interface Sample {
  at: number;
  time: number;
  along: number;
}

interface Press {
  id: number;
  box: DOMRect;
  rtl: boolean;
  startAlong: number;
  anchorAlong: number;
  anchorTime: number;
  lane: number;
  armed: boolean;
  timer: number;
  samples: Sample[];
  /** A finger on the picture, not on the edge. */
  picture: boolean;
  /** A touch on an edge that lets the page scroll (`touch-action: pan-y`): the film waits to see which it is, and
   *  goes back to `from` if the browser takes the touch for a scroll after all. */
  waits: boolean;
  /** The film as the press found it: where Escape, or a scroll the browser took, puts it back. */
  from: { time: number; playing: boolean };
  /** Where the pointer was last seen (client px): the deck's hover waits until it has moved on from there. */
  x: number;
  y: number;
  /** The fan is up under this touch (fan.ts). */
  fanned?: boolean;
  /** For a pointer's fan: the top of what it stands over (window px), read as it opened. */
  fanTop?: number;
}

interface Hold {
  key: string;
  direction: 1 | -1;
  timer: number;
  riffling: boolean;
  since: number;
  last: number;
  frame: number;
}

type Edge = HTMLElement & { readout?: (text: string | null) => void; thumb?: (share: number | null) => void };

/** Where an arrow, comma or full stop belongs to something else: a field, a menu, another slider, a page of the book. */
const OWN_KEYS =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="menu"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="listbox"], [role="option"], [role="radiogroup"], [role="radio"], [role="dialog"], [aria-modal="true"], .media-popup, .fb-tabs, fb-plate, fb-contents, fb-keymap, fb-caption-style, fb-ribbons, media-volume-slider';
/** While one of these is up the picture is theirs, not the hand's: a swipe across it flips nothing. */
const SWIPE_BLOCKED = '[data-fb-cover], [data-fb-contents], [data-fb-pip], [data-fb-sheet], [data-fb-scan], [data-fb-turning], [data-fb-riffle]';
/** The shows a page turn stands back for (the plate is not one: turning a page puts it away, see #leaf). */
const BIGGER = '[data-fb-turning], [data-fb-jacket], [data-fb-cover], [data-fb-riffle], [data-fb-contents], [data-fb-pip], [data-fb-sheet], [data-fb-scan]';


export class FbFlipElement extends UIElement {
  #i18n = new I18nController(this, i18nContext);
  #abort: AbortController | null = null;
  #container: HTMLElement | null = null;
  #slider: HTMLElement | null = null;
  #edge: Edge | null = null;
  #video: HTMLVideoElement | null = null;
  #book: Book | null = null;
  #print: Print | null = null;
  #flutter = new Flutter();
  #voice: ((message: string) => void) | null = null;

  #mode: Mode = 'idle';
  /** Where the hand has the film, the last place asked of the video, and whether that seek is still in flight. */
  #target = 0;
  #asked = -1;
  #busy = false;
  #askedAt = 0;
  /** The film was playing when the hand took it (or a flick has set it playing): it plays again when the hand goes. */
  #resume = false;
  /** The viewer's own rate: what a glide settles to, and what is put back if anything interrupts one. */
  #base = 1;
  #rate = 1;
  #page = -1;
  #readLate = 0;
  /** The frame the step under way began on (#step). */
  #steppedFrom: number | null = null;
  /** The film's speed under the hand, in film seconds per second: smoothed, for the readout and the sound. */
  #speed = 0;
  #readAt = 0;

  #frame = 0;
  #last = 0;
  #velocity = 0;
  #to = 0;
  /** A glide's phases: chased by seeks; chased by the stand-in towards where the film waits (`hand`); playing itself (`rate`). */
  #phase: 'chase' | 'hand' | 'rate' = 'chase';
  /** The stand-in for a film that seeks slowly, if the page gave one (stand.ts). */
  #stand: Stand | null = null;
  #toldAt = 0;
  /** Where the film waits for the thrown pages, and how far ahead of them it is sought (seconds of wall time). */
  #handAt = 0;
  #lead = LEAD;
  #filmAskedAt = 0;
  /** Seeks under the hand, running, that the film itself was slow to land. */
  #late = 0;
  #snap = false;

  #press: Press | null = null;
  /** The hand is (or was, for the glide after it) a finger on the picture: its speed reads on the picture. */
  #onPicture = false;
  #chip: HTMLElement | null = null;
  #fan: Fan | null = null;
  /** A touch drives: pages tick under it. */
  #touching = false;
  #tickAt = 0;
  #hold: Hold | null = null;
  #wheelTimer = 0;
  #wheelAt = 0;
  #foreignWheel = -Infinity;
  #sayTimer = 0;
  #quietTimer = 0;
  /** The film's frames as they are shown (shown.ts): what a step of one frame goes by. */
  #clock: FrameClock | null = null;
  /** Frames still to step, signed, and whether a step is on its way. */
  #steps = 0;
  #stepping = false;

  connectedCallback() {
    super.connectedCallback();
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    // Placed by companion.ts, which hides what it places; this one draws (the print's paper and its turning pages).
    this.hidden = false;
    this.setAttribute('aria-hidden', 'true');
    this.dataset.mode = 'idle';
    this.replaceChildren();
    const container = this.closest<HTMLElement>('media-container');
    const slider = container?.querySelector<HTMLElement>('media-time-slider') ?? null;
    this.#container = container;
    this.#slider = slider;
    if (!container || !slider) return;
    this.#edge = slider.querySelector<Edge>('fb-edge');
    this.#print = new Print(this, container, () => this.#video);
    this.#chip = document.createElement('span');
    this.#chip.className = 'fb-pace-chip';
    this.append(this.#chip);
    this.#fan = new Fan(this, container, () => this.#book);
    this.#voice = voiceFor(container);

    queueMicrotask(async () => {
      const book = await loadBook(container, signal);
      const video = videoIn(container);
      if (signal.aborted || !book || !video) return;
      this.#book = book;
      this.#video = video;
      this.#clock = frameClock(video);
      this.#stand = new Stand(container, video, () => this.#book);
      this.#listen(container, slider, video, signal);
      this.#print?.measure();
      this.#chapter();
      // From here the edge's drag, the wheel on it and the page keys are this module's (deck.ts stands back for it).
      container.toggleAttribute('data-fb-flip', true);
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort?.abort();
    this.#stop();
    this.#print?.destroy();
    this.#print = null;
    this.#fan?.destroy();
    this.#fan = null;
    this.#stand?.destroy();
    this.#stand = null;
    this.#flutter.close();
    this.#container?.removeAttribute('data-fb-flip');
    clearTimeout(this.#sayTimer);
    clearTimeout(this.#quietTimer);
    this.#speak(true);
  }

  #listen(container: HTMLElement, slider: HTMLElement, video: HTMLVideoElement, signal: AbortSignal) {
    // The edge: a press, a drag, a flick. Before Video.js's slider and the deck hear it.
    slider.addEventListener('pointerdown', (event) => this.#down(event), { capture: true, signal });
    slider.addEventListener('pointermove', (event) => this.#move(event), { signal });
    slider.addEventListener('pointerup', (event) => this.#up(event, false), { signal });
    slider.addEventListener('pointercancel', (event) => this.#up(event, true), { signal });
    slider.addEventListener('wheel', (event) => this.#wheel(event), { passive: false, signal });
    // A wheel that was turning somewhere else just now is a scroll passing over the edge, not a hand on it.
    document.addEventListener('wheel', (event) => {
      if (!(event.target instanceof Node && slider.contains(event.target))) this.#foreignWheel = event.timeStamp;
    }, { capture: true, passive: true, signal });

    container.addEventListener('keydown', (event) => this.#keydown(event), { capture: true, signal });
    container.addEventListener('keyup', (event) => this.#keyup(event), { capture: true, signal });
    window.addEventListener('blur', () => {
      this.#letGo();
      this.#lose();
    }, { signal });
    // The ways a held pointer is lost without a pointerup the edge hears: each ends the drag at rest where it is.
    slider.addEventListener('lostpointercapture', (event) => {
      if (this.#press && !this.#press.picture && event.pointerId === this.#press.id) this.#lose();
    }, { signal });
    document.addEventListener('contextmenu', () => this.#lose(), { capture: true, signal });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.#lose();
    }, { signal });
    // Escape while a hand has the film: back where the press began, as it was. Before anything else hears the key.
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !this.#press) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.#abandon();
    }, { capture: true, signal });
    // A new touch anywhere in the player stops a glide where it is. A finger across the picture flips its pages.
    container.addEventListener('pointerdown', (event) => {
      this.#flutter.arm(container);
      if (this.#mode === 'glide' && !(event.target instanceof Node && slider.contains(event.target))) this.#settleNow();
    }, { capture: true, signal });
    container.addEventListener('pointerdown', (event) => this.#picture(event), { signal });
    // A swipe the picture has taken stays the film's until the finger lifts. `touch-action: pan-y` leaves Safari free
    // to turn it into the page's scroll as soon as the finger drifts up or down, and it does: on an iPhone the
    // pointer was cancelled 21 px off the line, mid-swipe (iOS 27.2.1, 12 Nov 2026). Before the swipe is taken, a
    // touch that goes up or down is still the page's.
    container.addEventListener('touchmove', (event) => {
      if (this.#onPicture && event.cancelable) event.preventDefault();
    }, { passive: false, signal });
    // The page sound may only start from the visitor's own act, and on a phone that is the lift, not the touch.
    for (const type of ['pointerup', 'touchend', 'click'] as const) {
      container.addEventListener(type, () => this.#flutter.wake(container), { capture: true, passive: true, signal });
    }
    // A frame chosen on the plate's strip (plate.ts): the page turns to it. Taken here, so it turns as any page does.
    container.addEventListener('fb-turn-to', (event) => {
      const { time, direction } = (event as CustomEvent<{ time: number; direction: 1 | -1 }>).detail;
      if (this.#turnTo(time, direction)) event.preventDefault();
    }, { signal });

    video.addEventListener('seeked', () => {
      this.#busy = false;
      // How long the film takes to land where it is asked: how far ahead of thrown pages it is sought next time.
      if (this.#filmAskedAt) {
        const took = (performance.now() - this.#filmAskedAt) / 1000;
        this.#filmAskedAt = 0;
        this.#lead = clamp(this.#lead * 0.5 + took * 1.3 * 0.5, LEAD_MIN, LEAD_MAX);
      }
      // Chased itself, and not keeping up (a file with its keyframes far apart): twice running, and from the next
      // seek on the pages stand in for it (stand.ts).
      if (this.#chasing() && this.#askedAt && this.#stand?.kind === 'film') {
        this.#late = performance.now() - this.#askedAt > SLOW_SEEK ? this.#late + 1 : 0;
        if (this.#late >= 2) this.#stand.slow = true;
      }
      if (this.#chasing()) this.#pump();
    }, { signal });
    // The stand-in is fetched at the first sign of a hand: the pointer on the edge or its tabs, or a film held still
    // (its frames are stepped, its strip is read).
    const warm = () => this.#standing()?.warm();
    (slider.closest('.fb-seek') ?? slider).addEventListener('pointerenter', warm, { passive: true, signal });
    video.addEventListener('pause', warm, { signal });
    // The play key, the viewer's own rate, the film ending: none of them is argued with.
    video.addEventListener('play', () => {
      if (this.#chasing() && !video.paused) this.#yield();
    }, { signal });
    video.addEventListener('pause', () => {
      if (this.#mode === 'glide' && this.#phase === 'rate') this.#yield();
    }, { signal });
    video.addEventListener('ratechange', () => {
      if (this.#mode === 'glide' && Math.abs(video.playbackRate - this.#rate) > 0.001) {
        this.#base = video.playbackRate;
        this.#yield();
      }
    }, { signal });
    for (const type of ['ended', 'emptied']) video.addEventListener(type, () => this.#yield(), { signal });
    video.addEventListener('loadedmetadata', () => this.#print?.measure(), { signal });
    // The film loaded anew at the moment it was on (another quality, quality.ts): the stand-in holds the picture
    // there until the film's own frame is back.
    container.addEventListener('fb-hold', (event) => {
      this.#standing()?.land((event as CustomEvent<{ time: number }>).detail.time);
    }, { signal });
    video.addEventListener('timeupdate', () => this.#chapter(), { signal });
  }

  // ─── The film under the hand ──────────────────────────────────────────────

  #duration(): number {
    const duration = this.#video?.duration ?? 0;
    return Number.isFinite(duration) ? duration : 0;
  }

  #started(): boolean {
    const video = this.#video;
    return !!video && (video.currentTime > 0 || video.played.length > 0);
  }

  #span(): number {
    const tiles = this.#book?.tiles ?? [];
    return tiles.length ? this.#duration() / tiles.length || 1 : 1;
  }

  /** While a hand, a held key, the wheel or a fast glide has the film (not while it plays itself down to 1×). */
  #chasing(): boolean {
    return this.#mode !== 'idle' && !(this.#mode === 'glide' && this.#phase === 'rate');
  }

  /** The hand takes the film: it holds still under it, and the bigger shows stand back as they do for a scrub. */
  #take(mode: 'hand' | 'keys' | 'wheel') {
    const container = this.#container;
    const video = this.#video;
    if (!container || !video) return;
    if (this.#mode === 'glide') {
      this.#resume = this.#to > 0;
      this.#halt();
    } else if (this.#mode === 'idle') {
      this.#resume = !video.paused && !video.ended;
      this.#base = video.playbackRate || 1;
      this.#target = video.currentTime;
      this.#asked = this.#target;
    }
    this.#mode = mode;
    this.#phase = 'chase';
    this.dataset.mode = mode === 'hand' ? 'drag' : mode;
    clearTimeout(this.#sayTimer);
    const press = this.#press;
    container.dispatchEvent(new CustomEvent('fb-flip', { detail: mode === 'hand' && press ? { by: 'hand', x: press.x, y: press.y } : { by: mode } }));
    container.setAttribute('data-fb-deck', 'flip');
    this.#speak(false);
    if (!video.paused) video.pause();
    this.#page = tileAt(this.#book?.tiles ?? [], this.#target);
    this.#speed = 0;
  }

  /** Where the hand has the film now. The picture follows by the chase; a page crossed is a tick of the flutter. */
  #want(time: number, speed: number) {
    const tiles = this.#book?.tiles ?? [];
    this.#target = clamp(time, 0, Math.max(0, this.#duration() - END_GUARD));
    this.#speed = this.#speed * 0.6 + speed * 0.4;
    const page = tileAt(tiles, this.#target);
    if (page !== this.#page) {
      this.#page = page;
      this.#flutter.tick(this.#video, Math.abs(this.#speed) / this.#span());
      this.#tick();
      this.#says(this.#target);
      // (And the readout with it, at once: where it reads a page, it is this one.)
      this.#readAt = 0;
    }
    this.#fan?.time(this.#target);
    this.#pump();
    this.#read();
  }

  /** The top of what stands over the edge for a pointer to read: the readout and the chapter tabs (window px). */
  #readTop(edgeTop: number): number {
    let top = edgeTop;
    for (const el of this.#container?.querySelectorAll<HTMLElement>('.fb-edge-chip, .fb-tab') ?? []) {
      const box = el.getBoundingClientRect();
      if (box.width > 0 && box.height > 0 && box.bottom > edgeTop - 80) top = Math.min(top, box.top);
    }
    return top;
  }

  /**
   * Where the hand has the film, for whatever prints a page beside the readout over the edge (the page count,
   * edge.ts): the hand is ahead of the film's clock, and the two must read the same moment. Null once the hand has
   * let go, or the film plays the pages itself.
   */
  #says(time: number | null) {
    this.#container?.dispatchEvent(new CustomEvent('fb-hand', { detail: { time } }));
  }

  /** A page under a finger, felt: one short tick, where the device has a motor a page may use. Never under reduced motion. */
  #tick() {
    if (!this.#touching || reducedMotion.matches) return;
    const now = performance.now();
    if (now - this.#tickAt < TICK_EVERY) return;
    this.#tickAt = now;
    try {
      navigator.vibrate?.(3);
    } catch {
      // Not allowed here: the pages are still seen.
    }
  }

  /** The hand's speed, over the ribbon for a thumb on the edge, at the picture's head for a finger on the picture. */
  #readout(text: string | null) {
    if (this.#onPicture) {
      const chip = this.#chip;
      if (!chip) return;
      if (text != null && chip.textContent !== text) chip.textContent = text;
      chip.toggleAttribute('data-open', text != null);
      return;
    }
    this.#chip?.toggleAttribute('data-open', false);
    this.#edge?.readout?.(text);
  }

  /** The stand-in, where this film needs one under a hand (stand.ts): a copy of it, or its pages. Null for a film that keeps up itself. */
  #standing(): Stand | null {
    const stand = this.#stand;
    return stand && stand.kind !== 'film' ? stand : null;
  }

  /**
   * Sends the film itself somewhere, and the stand-in with it: it shows that moment at once, until the film does.
   * `exact` is a place chosen as a frame (a frame of the strip): the pages' still is not that, so only a copy stands in.
   */
  #go(time: number, exact = false) {
    const video = this.#video;
    const container = this.#container;
    if (!video || !container) return;
    hush(container);
    this.#filmAskedAt = performance.now();
    video.currentTime = time;
    const stand = this.#standing();
    if (stand && !(exact && stand.kind === 'stills')) stand.land(time);
  }

  /** One exact seek in flight at a time; the next is asked when it lands (`seeked`), for wherever the hand is by then. */
  #pump() {
    const video = this.#video;
    const container = this.#container;
    if (!video || !container) return;
    const now = performance.now();
    const stand = this.#standing();
    if (stand) {
      // The stand-in is chased (it keeps one seek in flight itself). The fore-edge's ribbon goes with the hand at
      // once: it is drawn from the film's clock, and the film's clock is only as quick as the film's seeks.
      stand.to(this.#target);
      const duration = this.#duration();
      if (duration) this.#slider?.style.setProperty('--media-slider-fill', `${((this.#target / duration) * 100).toFixed(3)}%`);
      // The film is told where the hand is, now and then: when its last seek has landed, or has been a while (a
      // stream's seek can take seconds, and each one asked over another costs it more).
      const waited = now - this.#toldAt;
      if (this.#phase === 'hand' || waited < TELL_EVERY || (video.seeking && waited < TELL_AT_LEAST) || Math.abs(this.#target - this.#asked) < 0.004) return;
      this.#toldAt = now;
      this.#asked = this.#target;
      hush(container);
      video.currentTime = this.#target;
      return;
    }
    if (this.#busy && now - this.#askedAt < SEEK_LOST) return;
    if (Math.abs(this.#target - this.#asked) < 0.004) return;
    this.#busy = true;
    this.#askedAt = now;
    this.#asked = this.#target;
    // The chip's count and the page turn are for seeks by key and chapter jumps; this is neither.
    hush(container);
    video.currentTime = this.#target;
  }

  /**
   * Over the ribbon, what the hand is doing in words a person can use. While it moves the film at a speed a film can
   * be watched at (up to 4×, either way) the chip reads that speed, "1.6×" or "−2.0×"; faster than that a number
   * like "55×" means nothing, and what helps is where you are: the page going by, "p. 31".
   */
  #read() {
    const now = performance.now();
    clearTimeout(this.#readLate);
    if (now - this.#readAt < READ_EVERY) {
      // (The last word is the true one: a hand that stops between two readings is read once more, where it stopped.
      // The page read at rest was the page before, beside a page count that had moved on.)
      this.#readLate = window.setTimeout(() => {
        if (this.#mode !== 'idle') this.#read();
      }, READ_EVERY - (now - this.#readAt));
      return;
    }
    this.#readAt = now;
    const speed = this.#speed;
    const size = Math.abs(speed);
    // With the pages standing in, what is on the picture is a page: the page is what is read.
    if (size > RATE_MAX + 0.05 || this.#standing()?.kind === 'stills') {
      const page = tileAt(this.#book?.tiles ?? [], this.#target) + 1;
      this.#readout(say(this.#i18n, 'flipbook.pageShort', { page }));
      return;
    }
    const rate = `${speed < -0.05 ? '−' : ''}${size.toFixed(1)}`;
    this.#readout(say(this.#i18n, 'flipbook.flipRate', { rate }));
  }

  /** The hand lets go, the film moving at `velocity` (film seconds per second). `snap` rests it on a page's start. */
  #release(velocity: number, snap = false) {
    const to = this.#resume ? this.#base : 0;
    // Reduced motion: no glide. It stops where it was let go (and plays on from there if it was playing).
    if (reducedMotion.matches || Math.abs(velocity - to) < REST) {
      this.#rest(snap);
      return;
    }
    this.#mode = 'glide';
    this.dataset.mode = 'coast';
    this.#velocity = velocity;
    this.#to = to;
    this.#snap = snap;
    this.#phase = 'chase';
    this.#last = performance.now();
    if (to > 0 && velocity >= RATE_MIN && velocity <= RATE_MAX) this.#play();
    cancelAnimationFrame(this.#frame);
    this.#frame = requestAnimationFrame((now) => this.#glide(now));
  }

  #glide(now: number) {
    this.#frame = 0;
    const video = this.#video;
    if (!video || this.#mode !== 'glide') return;
    const dt = clamp((now - this.#last) / 1000, 0.001, 0.05);
    this.#last = now;
    const to = this.#to;
    this.#velocity = to + (this.#velocity - to) * Math.exp(-dt / SETTLE);
    const velocity = this.#velocity;

    if (this.#phase === 'rate') {
      if (Math.abs(velocity - to) < SETTLED) {
        this.#finish();
        return;
      }
      this.#setRate(Math.round(clamp(velocity, RATE_MIN, RATE_MAX) * 20) / 20);
      this.#speed = velocity;
      this.#read();
      const page = tileAt(this.#book?.tiles ?? [], video.currentTime);
      if (page !== this.#page) {
        this.#page = page;
        if (velocity > 1.5) this.#flutter.tick(video, velocity / this.#span());
      }
    } else {
      const end = Math.max(0, this.#duration() - END_GUARD);
      let time = clamp(this.#target + velocity * dt, 0, end);
      if (this.#phase === 'hand') {
        // The pages run on, on the stand-in, to where the film waits; from there the film plays them itself.
        time = Math.min(time, this.#handAt);
        this.#want(time, velocity);
        if (time >= this.#handAt - 0.004 && !video.seeking && video.readyState >= 2) this.#play();
        this.#frame = requestAnimationFrame((t) => this.#glide(t));
        return;
      }
      this.#want(time, velocity);
      this.#edge?.thumb?.(this.#duration() ? time / this.#duration() : 0);
      if (time <= 0 || time >= end) {
        // The first page or the last: there is nowhere further to go. The last page is rested on, never played off.
        if (time >= end) this.#resume = false;
        this.#rest(false);
        return;
      }
      if (to > 0 && velocity >= RATE_MIN && velocity <= RATE_MAX) this.#play();
      else if (to === 0 && Math.abs(velocity) < REST) {
        this.#rest(this.#snap);
        return;
      }
    }
    this.#frame = requestAnimationFrame((t) => this.#glide(t));
  }

  /** Slow enough to be played: from here the film runs itself, its rate easing down to the viewer's own. */
  #play() {
    const video = this.#video;
    const container = this.#container;
    if (!video || !container) return;
    const stand = this.#standing();
    if (stand && this.#phase === 'chase') {
      // A film that lands slowly: it is sought to where the pages will be a moment from now, and the stand-in carries
      // them there meanwhile (#glide). Where the glide is after `lead` seconds: its speed falls towards `to` as e^(-t/SETTLE).
      const lead = this.#lead;
      const ahead = this.#to * lead + (this.#velocity - this.#to) * SETTLE * (1 - Math.exp(-lead / SETTLE));
      this.#handAt = clamp(this.#target + ahead, 0, Math.max(0, this.#duration() - END_GUARD));
      this.#phase = 'hand';
      this.#asked = this.#handAt;
      hush(container);
      this.#filmAskedAt = performance.now();
      video.currentTime = this.#handAt;
      return;
    }
    this.#phase = 'rate';
    // (From here the film plays the pages itself: the page count is its clock's again.)
    this.#says(null);
    this.#edge?.thumb?.(null);
    if (container.getAttribute('data-fb-deck') === 'flip') container.removeAttribute('data-fb-deck');
    if (Math.abs(this.#target - this.#asked) >= 0.004) {
      this.#asked = this.#target;
      hush(container);
      video.currentTime = this.#target;
    }
    // The film has the pages from here: the stand-in leaves as it shows them.
    stand?.land(this.#target);
    this.#setRate(Math.round(clamp(this.#velocity, RATE_MIN, RATE_MAX) * 20) / 20);
    // Refused (or cut short by something else) while the glide still has the film: let it go. Cut short by a hand
    // that took the film back before it had started is that hand's own pause, and its press is not to be dropped.
    void video.play().catch(() => {
      if (this.#mode === 'glide' && this.#phase === 'rate') this.#yield();
    });
    this.#speakLater();
  }

  #setRate(rate: number) {
    const video = this.#video;
    if (!video || Math.abs(video.playbackRate - rate) < 0.001) return;
    this.#rate = rate;
    video.playbackRate = rate;
  }

  /** The glide has settled: the film is simply playing, at exactly the viewer's rate. */
  #finish() {
    this.#setRate(this.#base);
    this.#idle();
  }

  /** At rest where the hand left it: paused there, or playing on from there if it was playing before. */
  #rest(snap: boolean) {
    const video = this.#video;
    const container = this.#container;
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    if (!video || !container) return;
    let time = this.#target;
    const tiles = this.#book?.tiles ?? [];
    if (snap && !this.#resume && tiles.length) {
      const page = tiles[tileAt(tiles, time)];
      if (page) time = Math.min(page.start + 0.04, Math.max(0, this.#duration() - END_GUARD));
    }
    const stand = this.#standing();
    // (With a stand-in, a film already told this very place and landed is asked once more: its last seek landed
    // while the hand still had it, and whether it shows that frame is only looked at for a seek made at rest, goto.ts.)
    if (Math.abs(time - this.#asked) >= 0.004 || (stand && !video.seeking)) {
      this.#target = this.#asked = time;
      hush(container);
      this.#filmAskedAt = performance.now();
      video.currentTime = time;
    }
    // The stand-in holds that frame until the film shows it.
    stand?.land(time);
    const resume = this.#resume;
    // It plays on before the hand's mark comes off the player: the film is never seen paused by a hand that has gone
    // (a paused film prints, edge.ts; this pause was never the viewer's).
    if (resume) void video.play().catch(() => undefined);
    this.#idle();
    if (resume) return;
    // Resting on a page: said once, after a moment, never while the hand is still on its way.
    clearTimeout(this.#sayTimer);
    this.#sayTimer = window.setTimeout(() => this.#sayPage(), SAY_AFTER);
  }

  /** Back to nothing going on: the film's rate is its own, the readout folds away, the shows may come back. */
  #idle() {
    const container = this.#container;
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    this.#mode = 'idle';
    this.dataset.mode = 'idle';
    this.toggleAttribute('data-fine', false);
    this.#resume = false;
    this.#busy = false;
    clearTimeout(this.#readLate);
    this.#readout(null);
    this.#says(null);
    this.#onPicture = false;
    this.#touching = false;
    if (!this.#press) this.#fan?.close();
    this.toggleAttribute('data-picture', false);
    this.#edge?.readout?.(null);
    this.#edge?.thumb?.(null);
    if (container?.getAttribute('data-fb-deck') === 'flip') container.removeAttribute('data-fb-deck');
    this.#speakLater();
  }

  /** A glide cut short by a new hand: the rate goes back at once; where the film goes next is the new hand's. */
  #halt() {
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    if (this.#phase === 'rate') {
      this.#setRate(this.#base);
      this.#target = this.#asked = this.#video?.currentTime ?? this.#target;
    }
    this.#phase = 'chase';
  }

  /** Something else has the film now (the play key, the rate menu, its end): let it, and put the rate back. */
  #yield() {
    if (this.#mode === 'idle') return;
    this.#drop();
    this.#dropHold();
    clearTimeout(this.#wheelTimer);
    if (this.#video && Math.abs(this.#video.playbackRate - this.#rate) < 0.001) this.#setRate(this.#base);
    // The film is its own again from wherever it is: a stand-in still up leaves as the film shows that.
    if (this.#video && this.#stand?.shown) this.#stand.land(this.#video.currentTime);
    this.#idle();
  }

  /** A key or a touch during a glide: it ends here, as it would have ended (playing at 1×, or at rest). */
  #settleNow() {
    if (this.#mode !== 'glide') return;
    if (this.#phase === 'rate') this.#finish();
    else this.#rest(false);
  }

  #stop() {
    const video = this.#video;
    if (this.#mode !== 'idle' && video && Math.abs(video.playbackRate - this.#rate) < 0.001 && this.#rate !== this.#base) video.playbackRate = this.#base;
    this.#dropHold();
    clearTimeout(this.#wheelTimer);
    this.#drop();
    this.#idle();
  }

  /**
   * The press is over, however it ended: its timer is forgotten, the pointer is given back, the fan falls shut, and
   * the deck is told where the pointer was let go (its hover waits until the pointer has moved on from there).
   */
  #drop(): Press | null {
    const press = this.#press;
    if (!press) return null;
    this.#press = null;
    clearTimeout(press.timer);
    this.#fan?.close();
    const holder = press.picture ? this.#container : this.#slider;
    try {
      if (holder?.hasPointerCapture(press.id)) holder.releasePointerCapture(press.id);
    } catch {
      // A pointer the browser has already taken back.
    }
    this.#container?.dispatchEvent(new CustomEvent('fb-flip-end', { detail: { x: press.x, y: press.y } }));
    return press;
  }

  /** The pointer is lost mid-press (see #listen): the drag ends at rest where it is, as if let go still. */
  #lose() {
    const press = this.#press;
    if (press) this.#end(press, true, performance.now());
  }

  /** Escape mid-press: the film goes back where the press found it, playing or paused as it was. */
  #abandon() {
    const press = this.#press;
    const video = this.#video;
    const container = this.#container;
    if (!press || !video || !container) return;
    if (press.armed && this.#mode === 'hand') {
      this.#target = press.from.time;
      this.#resume = press.from.playing;
      this.#end(press, true, performance.now());
      return;
    }
    // Not yet a drag: the press had only gone to its point.
    this.#drop();
    this.#edge?.thumb?.(null);
    this.#touching = false;
    if (!press.waits && Math.abs(video.currentTime - press.from.time) >= 0.004) this.#go(press.from.time);
  }

  // ─── The pointer on the edge ──────────────────────────────────────────────

  #along(press: Press, event: PointerEvent): number {
    return press.rtl ? press.box.right - event.clientX : event.clientX - press.box.left;
  }

  /** How far the pointer has gone out from the edge, towards the picture: the further, the finer. */
  #lift(press: Press, event: PointerEvent): number {
    return press.box.top - event.clientY;
  }

  #down(event: PointerEvent) {
    const slider = this.#slider;
    const video = this.#video;
    const container = this.#container;
    const duration = this.#duration();
    // From the cover too: a film that has never played is still a book to flip (the press moves it off its start, and
    // the cover leaves as it does for any seek). A phone's side edge takes no pointer until the first play (skin.css).
    if (!slider || !video || !container || event.button !== 0 || !event.isPrimary || !duration || this.#press) return;
    const box = slider.getBoundingClientRect();
    const length = box.width;
    if (!length) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      slider.setPointerCapture(event.pointerId);
    } catch {
      // A pointer the browser no longer has (or never had: one made by script): its moves still come here.
    }
    this.#flutter.arm(container);
    // A thumb on an edge that lets the page scroll past it (a phone's, phone.css): the browser hasn't yet said
    // whether this touch is a scroll, so the film doesn't move until the touch has (sideways, or lifted in place).
    const waits = event.pointerType === 'touch' && getComputedStyle(slider).touchAction.includes('pan-y');
    const press: Press = {
      id: event.pointerId,
      box,
      rtl: getComputedStyle(slider).direction === 'rtl',
      startAlong: 0,
      anchorAlong: 0,
      anchorTime: 0,
      lane: 0,
      armed: false,
      timer: 0,
      samples: [],
      picture: false,
      waits,
      from: this.#mode === 'idle' ? { time: video.currentTime, playing: !video.paused && !video.ended } : { time: this.#target, playing: this.#mode === 'glide' ? this.#to > 0 : this.#resume },
      x: event.clientX,
      y: event.clientY,
    };
    press.startAlong = press.anchorAlong = this.#along(press, event);
    press.anchorTime = clamp(press.startAlong / length, 0, 1) * duration;
    this.#press = press;
    this.#touching = event.pointerType === 'touch';
    const time = clamp(press.anchorTime, 0, duration - END_GUARD);
    if (waits) {
      // The pages lift under the thumb at once (it has landed); the film waits.
      if (!reducedMotion.matches) this.#edge?.thumb?.(clamp(press.startAlong / length, 0, 1));
      press.timer = window.setTimeout(() => this.#arm(), PRESS_HOLD);
      return;
    }
    if (this.#mode === 'idle') {
      // A press goes there at once, whatever comes of it, and the deck's hover is put away at once with it: a click
      // is back in the film. Held or moved, the hand has the film.
      container.dispatchEvent(new CustomEvent('fb-flip', { detail: { by: 'press', x: press.x, y: press.y } }));
      this.#go(time);
      this.#target = this.#asked = time;
      press.timer = window.setTimeout(() => this.#arm(), CLICK_HOLD);
    } else {
      this.#arm();
      this.#want(time, 0);
    }
  }

  #arm() {
    const press = this.#press;
    if (!press || press.armed) return;
    clearTimeout(press.timer);
    press.armed = true;
    this.#take('hand');
    // A touch that waited goes to where it landed now that it has stayed, or gone sideways.
    if (press.waits && !press.picture) this.#want(clamp(press.anchorTime, 0, this.#duration() - END_GUARD), 0);
    // A thumb on the edge: the fan stands up from the edge, over the picture's foot.
    if (this.#touching && !press.picture && this.#mode === 'hand') {
      const x = press.rtl ? press.box.right - press.startAlong : press.box.left + press.startAlong;
      this.#fan?.open(x, press.box.top, this.#target);
      press.fanned = true;
    }
  }

  #move(event: PointerEvent) {
    const press = this.#press;
    if (!press || event.pointerId !== press.id || press.picture) return;
    press.x = event.clientX;
    press.y = event.clientY;
    // A mouse whose button the page never saw lifted, or with another button down now: the drag is over.
    if (event.pointerType === 'mouse' && event.buttons !== 1) {
      this.#lose();
      return;
    }
    const along = this.#along(press, event);
    if (!press.armed) {
      if (Math.abs(along - press.startAlong) < SLOP) return;
      this.#arm();
    }
    const duration = this.#duration();
    const length = press.box.width;
    // A mouse held and dragged along the edge gets the same fan a thumb gets, standing up beside the edge, once the
    // drag has really moved: a click alone opens nothing (Pedro, 12 Nov 2026).
    // (A pointer's fan stands over what the pointer reads beside the edge, the readout and the tabs, never on them.)
    if (!press.fanned && event.pointerType === 'mouse' && this.#mode === 'hand' && Math.abs(along - press.startAlong) >= SLOP) {
      press.fanTop = this.#readTop(press.box.top);
      this.#fan?.open(event.clientX, press.fanTop, this.#target, true);
      press.fanned = true;
    }
    if (press.fanned) this.#fan?.at(event.clientX, press.fanTop ?? press.box.top);
    const lift = this.#lift(press, event);
    let lane = 0;
    for (let i = LANES.length - 1; i > 0; i--) {
      if (lift >= LANES[i].from) {
        lane = i;
        break;
      }
    }
    if (lane !== press.lane) {
      // Re-anchored where the rate changes, so the film never jumps.
      press.anchorAlong = along;
      press.anchorTime = this.#target;
      press.lane = lane;
      this.toggleAttribute('data-fine', lane > 0);
    }
    const time = clamp(press.anchorTime + ((along - press.anchorAlong) / length) * duration * LANES[lane].rate, 0, duration - END_GUARD);
    const samples = press.samples;
    samples.push({ at: event.timeStamp, time, along });
    while (samples.length > 2 && event.timeStamp - samples[0].at > WINDOW) samples.shift();
    const first = samples[0];
    const span = (event.timeStamp - first.at) / 1000;
    this.#want(time, span > 0.012 ? (time - first.time) / span : this.#speed);
  }

  #up(event: PointerEvent, cancelled: boolean) {
    const press = this.#press;
    if (!press || event.pointerId !== press.id) return;
    press.x = event.clientX;
    press.y = event.clientY;
    this.#end(press, cancelled, event.timeStamp);
  }

  /** The press ends: lifted (`cancelled` false) or lost. What the film does next is decided here and nowhere else. */
  #end(press: Press, cancelled: boolean, at: number) {
    if (this.#press !== press) return;
    this.#drop();
    if (press.waits && cancelled) {
      // The browser took the touch for a scroll: the film is where it was, doing what it was doing.
      this.#edge?.thumb?.(null);
      if (press.armed) {
        this.#target = press.from.time;
        this.#resume = press.from.playing;
        this.#rest(false);
      } else this.#touching = false;
      return;
    }
    if (!press.armed) {
      if (press.waits) {
        // A tap on the edge: it goes there now.
        const container = this.#container;
        const video = this.#video;
        this.#edge?.thumb?.(null);
        this.#touching = false;
        if (container && video) this.#go(clamp(press.anchorTime, 0, this.#duration() - END_GUARD));
      }
      // A click on the edge: it went there. Paused, the page it landed on is said.
      if (this.#video?.paused) {
        clearTimeout(this.#sayTimer);
        this.#speak(false);
        this.#sayTimer = window.setTimeout(() => this.#sayPage(), SAY_AFTER);
        this.#speakLater();
      }
      return;
    }
    if (this.#mode !== 'hand') return;
    const samples = press.samples;
    const last = samples[samples.length - 1];
    const first = samples[0];
    const span = last && first ? last.at - first.at : 0;
    const fresh = !!last && at - last.at < FRESH;
    // (Not under reduced motion: there is no glide, and a paused film stays paused where it was let go.)
    if (!cancelled && !reducedMotion.matches && fresh && span > 8 && Math.abs(last.along - first.along) / span >= FLICK) {
      let velocity = ((last.time - first.time) / span) * 1000;
      // A throw carries a speed a film can still be followed at, on the picture and along the edge.
      const most = press.picture ? PICTURE_THROW : THROW;
      velocity = clamp(velocity, -most, most);
      // Flipping is playing: thrown forwards, a film that was paused plays.
      if (velocity > 0) this.#resume = true;
      this.#release(velocity);
      return;
    }
    this.#rest(false);
  }

  // ─── The wheel on the edge ────────────────────────────────────────────────

  #wheel(event: WheelEvent) {
    const duration = this.#duration();
    if (!duration || event.ctrlKey || !this.#started()) return;
    if (this.#mode !== 'wheel' && event.timeStamp - this.#foreignWheel < WHEEL_FOREIGN) {
      this.#foreignWheel = event.timeStamp;
      return;
    }
    if (this.#mode !== 'wheel' && this.#mode !== 'idle' && this.#mode !== 'glide') return;
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
    const delta = (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) * scale;
    if (!delta) return;
    event.preventDefault();
    if (this.#mode !== 'wheel') {
      this.#take('wheel');
      this.#wheelAt = event.timeStamp;
    }
    const step = delta * WHEEL_PAGES * this.#span();
    const since = Math.max(0.008, (event.timeStamp - this.#wheelAt) / 1000);
    this.#wheelAt = event.timeStamp;
    const time = this.#target + step;
    this.#want(time, step / since);
    if (!reducedMotion.matches) this.#edge?.thumb?.(clamp(time / duration, 0, 1));
    clearTimeout(this.#wheelTimer);
    // A trackpad carries its own momentum in its events; when they stop, the hand has gone.
    this.#wheelTimer = window.setTimeout(() => {
      if (this.#mode === 'wheel') this.#rest(false);
    }, WHEEL_IDLE);
  }

  // ─── Keys ─────────────────────────────────────────────────────────────────

  #keydown(event: KeyboardEvent) {
    const container = this.#container;
    const video = this.#video;
    if (!container || !video || event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key;
    if (key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta') return;
    this.#flutter.arm(container);
    const arrow = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0;
    const hold = this.#hold;
    // The held arrow, repeating: it has been heard.
    if (hold && arrow && key === hold.key) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat && !hold.riffling) this.#riffle();
      return;
    }
    // Any other key ends a riffle or a glide where it is; the key then does what it does.
    if (hold) this.#letGo();
    this.#settleNow();
    const frame = key === '.' ? 1 : key === ',' ? -1 : 0;
    if (!arrow && !frame) return;
    const target = event.target instanceof Element ? event.target : null;
    // (A frame key pressed with focus in the plate's strip is still the film's: the strip has no use of its own for it.)
    if (target?.closest(OWN_KEYS) && !(frame && target.closest('.fb-strip'))) return;
    const other = target?.closest('[role="slider"]');
    if (other && !other.closest('media-time-slider')) return;
    if (!this.#started() || video.ended || !this.#duration() || container.matches(BIGGER)) return;

    if (frame) {
      // One frame, back or on: for a film held still.
      if (!video.paused) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.#leaf(frame, 'frame', event.repeat);
      return;
    }
    const direction = arrow as 1 | -1;
    if (video.paused) {
      // Paused, an arrow turns exactly one page; with Shift, one frame.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) this.#leaf(direction, event.shiftKey ? 'frame' : 'page');
    } else if (event.shiftKey) {
      // Playing, Shift and an arrow go a page on or back, and the film plays on.
      event.preventDefault();
      event.stopImmediatePropagation();
      this.#leaf(direction, 'page');
      return;
    }
    // Held, it riffles. (Playing, the first press is still Video.js's own five seconds.)
    if (event.shiftKey) return;
    const next: Hold = { key, direction, timer: 0, riffling: false, since: 0, last: 0, frame: 0 };
    this.#hold = next;
    if (event.repeat) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.#riffle();
    } else {
      next.timer = window.setTimeout(() => this.#riffle(), HOLD);
    }
  }

  #keyup(event: KeyboardEvent) {
    if (this.#hold && event.key === this.#hold.key) this.#letGo();
  }

  /** The arrow has been held: the pages riffle, a page at a time, then pages, then flying. */
  #riffle() {
    const hold = this.#hold;
    if (!hold || hold.riffling || !this.#video) return;
    clearTimeout(hold.timer);
    hold.riffling = true;
    this.#take('keys');
    hold.since = hold.last = performance.now();
    const step = (now: number) => {
      if (this.#hold !== hold || this.#mode !== 'keys') return;
      const dt = clamp((now - hold.last) / 1000, 0.001, 0.05);
      hold.last = now;
      const velocity = this.#keySpeed(hold, now);
      const end = Math.max(0, this.#duration() - END_GUARD);
      const time = clamp(this.#target + velocity * dt, 0, end);
      this.#want(time, velocity);
      if (!reducedMotion.matches) this.#edge?.thumb?.(end ? time / end : 0);
      if (time <= 0 || time >= end) {
        if (time >= end) this.#resume = false;
        this.#hold = null;
        this.#rest(false);
        return;
      }
      hold.frame = requestAnimationFrame(step);
    };
    hold.frame = requestAnimationFrame(step);
  }

  /** Film seconds per second under a held arrow. Reduced motion keeps the first, slow pace: nothing takes off. */
  #keySpeed(hold: Hold, now: number): number {
    const pages = this.#book?.tiles.length ?? 0;
    const fast = clamp(pages / 4, KEY_FAST_MIN, KEY_FAST_MAX);
    const climb = reducedMotion.matches ? 0 : clamp((now - hold.since) / 1000 / KEY_CLIMB, 0, 1);
    return hold.direction * (KEY_SLOW + (fast - KEY_SLOW) * climb * climb) * this.#span();
  }

  /** The held arrow is released (or the window lost it): the pages settle. */
  #letGo() {
    const hold = this.#hold;
    if (!hold) return;
    this.#hold = null;
    clearTimeout(hold.timer);
    cancelAnimationFrame(hold.frame);
    if (hold.riffling && this.#mode === 'keys') this.#release(this.#keySpeed(hold, performance.now()), true);
  }

  #dropHold() {
    const hold = this.#hold;
    if (!hold) return;
    this.#hold = null;
    clearTimeout(hold.timer);
    cancelAnimationFrame(hold.frame);
  }

  // ─── One page, one frame ──────────────────────────────────────────────────

  /**
   * Exactly one page (the book's own page: one storyboard frame) or one frame of the film, on or back. Paused, the
   * page that was showing turns over (print.ts) and the plate, if it had laid itself out, is put away: the viewer is
   * reading page by page.
   *
   * A frame is stepped by the frame on screen, not by arithmetic on the clock (#step): every press shows another
   * frame, and as many presses back return to the same one. Presses made while a step is on its way are kept and
   * taken in turn; a key held down (`held`) steps as fast as the film can show them, and no faster.
   */
  #leaf(direction: 1 | -1, unit: 'page' | 'frame', held = false) {
    const video = this.#video;
    const container = this.#container;
    const tiles = this.#book?.tiles ?? [];
    const duration = this.#duration();
    if (!video || !container || !duration) return;
    if (unit === 'frame' && video.paused && this.#clock) {
      if (this.#stepping) {
        if (!held) this.#steps += direction;
        return;
      }
      this.#steps = direction;
      void this.#walk();
      return;
    }
    const now = video.currentTime;
    let time = now;
    if (unit === 'page') {
      if (!tiles.length) return;
      const page = clamp(tileAt(tiles, now) + direction, 0, tiles.length - 1);
      time = tiles[page].start + 0.04;
    } else {
      // (A browser that names no frames: a thirtieth of a second, on the clock's own grid.)
      const span = 1 / 30;
      time = (Math.floor(now / span + 0.001) + direction + 0.5) * span;
    }
    time = clamp(time, 0, duration - END_GUARD);
    if (Math.abs(time - now) < 0.001) return;
    this.#turned(direction, unit);
    this.#go(time);
    if (!video.paused) return;
    this.#said();
  }

  /** A paused page turned: the plate is put away, the sheet goes over (a whole page only), the paper is heard. */
  #turned(direction: 1 | -1, unit: 'page' | 'frame') {
    const video = this.#video;
    if (!video?.paused) return;
    this.#container?.dispatchEvent(new CustomEvent('fb-leaf'));
    if (unit === 'page') this.#print?.turn(direction);
    this.#flutter.tick(video, 2);
  }

  /** Where it came to rest is said once, a moment after the last step. */
  #said() {
    this.#speak(false);
    clearTimeout(this.#sayTimer);
    this.#sayTimer = window.setTimeout(() => this.#sayPage(), SAY_AFTER);
    this.#speakLater();
  }

  /** Takes the frames asked for, one at a time, for as long as the film is held still and nothing else has it. */
  async #walk() {
    this.#stepping = true;
    try {
      while (this.#steps && this.#video?.paused && this.#mode === 'idle' && this.isConnected) {
        const direction = this.#steps > 0 ? 1 : -1;
        this.#steps -= direction;
        let taken = await this.#step(direction);
        // A seek the browser lost (a busy machine) is asked again; a press is not dropped for it. (Nor taken twice:
        // asked again, the step is from the frame it first started on, and a seek that landed late after all is it.)
        for (let again = 0; taken === 'lost' && again < 2 && this.#video?.paused && this.#mode === 'idle'; again++) taken = await this.#step(direction, this.#steppedFrom);
        // A step that cannot be taken (the film's first frame, or its last) ends the presses that way; the other way still counts.
        if (taken !== 'taken' && Math.sign(this.#steps) === direction) this.#steps = 0;
      }
    } finally {
      this.#stepping = false;
      this.#steps = 0;
    }
  }

  /**
   * One frame on or back from the frame on screen. The browser names each frame it shows by its own time (shown.ts),
   * so the step is checked: it is not over until the frame on screen is another one.
   *
   * Back needs no knowledge of the film: a moment just before the frame on screen is in the frame before it, and the
   * distance between the two is one frame's length, exactly. On, the next frame begins one frame's length further:
   * known once the film has played a few frames at its own speed or a step has measured it. Until then it is found:
   * a little past the frame's start, then twice as far, until the picture changes. A try that changed nothing proves
   * the frame lasts at least that long, so the first change after it is the very next frame, and the distance is
   * learned for good. (A film stepped before it has ever played costs one or two tries more on its first step on.)
   *
   * With a stand-in (a streamed film), the stand-in is stepped and shows the frame at once; the film is sent to the
   * same frame and takes the picture back when it shows it.
   */
  async #step(direction: 1 | -1, origin: number | null = null): Promise<'taken' | 'end' | 'lost'> {
    const video = this.#video;
    const film = this.#clock;
    const duration = this.#duration();
    if (!video || !film || !duration) return 'end';
    const stand = this.#standing();
    const standing = stand?.clock ? stand : null;
    const clock = standing?.clock ?? film;
    const seek = (time: number) => (standing ? standing.seek(time) : film.seek(time, STEP_PATIENCE));
    // The film on its way somewhere: the frame on screen is the one it lands on.
    if (!standing && video.seeking) await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        video.removeEventListener('seeked', done);
        resolve();
      };
      const timer = window.setTimeout(done, SEEK_LOST);
      video.addEventListener('seeked', done);
    });
    // The frame on screen: the stand-in's while it is up, the film's otherwise; the clock's own word where no frame
    // has been named yet (a film opened on a moment and stepped before anything else).
    const clocked = Math.floor(video.currentTime / film.span + 0.001) * film.span;
    let from = (standing?.shown ? clock.time : film.time) ?? clocked;
    // The frame last named may not be this place's: a seek has just landed and its frame is named a moment after
    // (a frame key pressed straight after a jump stepped from the place before: seen in the battery), or none will
    // be (Safari names none for some paused seeks). It is given a moment; then the clock's own frame is the start.
    const near = film.span * 1.5 + 0.002;
    if (!standing?.shown && Math.abs(from - video.currentTime) > near) {
      const named = await film.next(STEP_PATIENCE);
      from = named != null && Math.abs(named - video.currentTime) <= near ? named : clocked;
    }
    const end = Math.max(0, duration - END_GUARD);
    const sure = film.sure || clock.sure;
    const span = clock.sure ? clock.span : film.span;
    // Asked again after a seek that seemed lost: if the picture has moved on from where that step began, it landed.
    if (origin != null && (from - origin) * direction > 0.002) {
      if (standing) this.#go(clamp(from + Math.min(span / 2, 0.012), 0, end));
      this.#said();
      return 'taken';
    }
    this.#steppedFrom = from;
    let reach = direction < 0 ? STEP_BACK : sure ? span * 1.5 : STEP_PROBE;
    let proved = 0;
    this.#turned(direction, 'frame');
    hush(this.#container ?? video);
    for (let tries = 0; tries < STEP_TRIES; tries++) {
      const target = clamp(from + direction * reach, 0, end);
      let to = await seek(target);
      // The same frame still, by the browser's word: asked once more, a millisecond on, before it is believed (Safari
      // may leave a paused stream on the frame from the seek before, and shows this one at the next seek).
      if (to != null && Math.abs(to - from) <= 0.002 && target > 0 && target < end) to = await seek(target + 0.001);
      if (!video.paused || this.#mode !== 'idle') return 'end';
      if (to == null) return 'lost';
      // A step on that landed two frames away (a frame named late read as "the same frame still", and the next try
      // reached further: seen on a busy machine, 2 runs in 24): the frame before that one is the step.
      if (direction > 0 && sure && to - from > span * 1.5 + 0.002) {
        const one = await seek(to - STEP_BACK);
        if (one != null && one > from + 0.002 && one < to - 0.002) to = one;
      }
      const moved = Math.abs(to - from);
      if (moved > 0.002) {
        // Another frame. One frame's length, where this step measured it: any step back, or a step on that a try proved.
        // (Not from a frame named by the seek itself and not by its own time: Firefox, before the film has played.)
        if (clock.own && (direction < 0 || (proved > 0 && moved < proved * 2 + 0.002))) {
          film.learn(moved);
          clock.learn(moved);
        }
        // The film itself to the same frame (it is there already unless a stand-in was stepped).
        const inside = to + Math.min((clock.sure ? clock.span : moved) / 2, 0.012);
        if (standing) this.#go(clamp(inside, 0, end));
        this.#said();
        return 'taken';
      }
      // The same frame still: the film's first or last, or a frame longer than was reached for.
      if (direction < 0 || target >= end) return 'end';
      proved = reach;
      reach = sure ? reach + span / 2 : reach * 2;
    }
    return 'end';
  }

  /** The paused page turns to a chosen moment near it: the sheet turns over once, whatever the number of frames. */
  #turnTo(time: number, direction: 1 | -1): boolean {
    const video = this.#video;
    const container = this.#container;
    const duration = this.#duration();
    if (!video || !container || !duration || !video.paused) return false;
    this.#settleNow();
    this.#print?.turn(direction);
    this.#flutter.tick(video, 2);
    this.#go(clamp(time, 0, duration - END_GUARD), true);
    this.#speak(false);
    clearTimeout(this.#sayTimer);
    this.#sayTimer = window.setTimeout(() => this.#sayPage(), SAY_AFTER);
    this.#speakLater();
    return true;
  }

  /** How far past the film's first or last page the finger has pulled, in pixels along the picture (signed). */
  #over = 0;

  /**
   * The picture gives a little at the film's two ends, and comes back: a pull past the first or the last page moves
   * the picture with the finger, less and less (28 px at the very most), so a hand that has run out of film is
   * answered instead of ignored. `0` lets it go: it settles in 200 ms. Nothing moves under reduced motion.
   */
  #band(pulled: number) {
    const container = this.#container;
    if (!container) return;
    const was = this.#over;
    this.#over = pulled;
    if (reducedMotion.matches || (!was && !pulled)) return;
    const reach = (over: number) => Math.sign(over) * BAND_REACH * (1 - Math.exp(-Math.abs(over) / BAND_PULL));
    const to = reach(pulled);
    for (const part of container.querySelectorAll<HTMLElement>('video, canvas.fb-stand')) {
      if (pulled) {
        part.style.translate = `${to.toFixed(1)}px 0`;
        continue;
      }
      part.style.translate = '';
      part.animate([{ translate: `${reach(was).toFixed(1)}px 0` }, { translate: '0px 0' }], { duration: 200, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' });
    }
  }

  /**
   * A finger across the picture. Nothing happens until it has gone sideways further than a tap's slop and more
   * sideways than up or down; a touch that goes up or down first is the page's scroll, and is left to it. From there
   * the film is under the finger exactly as it is under a thumb on the edge (the same take, chase, flick and rest),
   * at the picture's own gear: its width is PICTURE_SPAN seconds. To the right is on, as along the edge; the ribbon
   * on the edge goes with it.
   */
  #picture(event: PointerEvent) {
    const container = this.#container;
    const video = this.#video;
    const duration = this.#duration();
    if (!container || !video || !duration || event.pointerType !== 'touch' || !event.isPrimary || this.#press) return;
    if ((event.target as Element | null)?.closest?.(NOT_PICTURE) || container.matches(SWIPE_BLOCKED)) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const local = new AbortController();
    let press: Press | null = null;
    const sign = getComputedStyle(container).direction === 'rtl' ? -1 : 1;
    const span = Math.min(PICTURE_SPAN, duration);

    const move = (e: PointerEvent) => {
      if (e.pointerId !== event.pointerId) return;
      // The press was ended from elsewhere (Escape, the pointer lost, something else took the film): nothing follows.
      if (press && this.#press !== press) {
        local.abort();
        return;
      }
      const along = (e.clientX - startX) * sign;
      if (!press) {
        const dx = Math.abs(e.clientX - startX);
        const dy = Math.abs(e.clientY - startY);
        // A hold has the film (hand.ts), or the paused page is being torn out (tear.ts): this touch is theirs.
        if (this.#press || container.hasAttribute('data-fb-hold') || container.hasAttribute('data-fb-tearing') || (dy > TOUCH_SLOP && dy >= dx)) {
          local.abort();
          return;
        }
        if (dx <= TOUCH_SLOP || dx < dy * 1.2) return;
        const box = container.getBoundingClientRect();
        press = { id: e.pointerId, box, rtl: sign < 0, startAlong: along, anchorAlong: along, anchorTime: 0, lane: 0, armed: false, timer: 0, samples: [], picture: true, waits: false, from: { time: this.#mode === 'idle' ? video.currentTime : this.#target, playing: this.#mode === 'idle' ? !video.paused && !video.ended : this.#mode === 'glide' ? this.#to > 0 : this.#resume }, x: e.clientX, y: e.clientY };
        this.#press = press;
        try {
          container.setPointerCapture(e.pointerId);
        } catch {
          // The pointer has already gone: its lift ends this below.
        }
        this.#flutter.arm(container);
        this.#arm();
        if (this.#mode !== 'hand') {
          this.#press = null;
          local.abort();
          return;
        }
        this.#onPicture = true;
        this.#touching = true;
        this.toggleAttribute('data-picture', true);
        press.anchorTime = this.#target;
        press.fanned = true;
        this.#fan?.open(e.clientX, e.clientY, this.#target);
      }
      press.x = e.clientX;
      press.y = e.clientY;
      const last = duration - END_GUARD;
      const asked = press.anchorTime + ((along - press.anchorAlong) / press.box.width) * span;
      // A pull past the film's first or last page takes the anchor with it: the stroke back moves the film at once,
      // from that end, and does not first undo the part that had nowhere to go. (On a phone a first swipe to the left
      // at 0:01 read as a swipe that did nothing: Pedro, iOS 27.2.1, 12 Nov 2026.)
      if (asked < 0 || asked > last) {
        // (How far past the end, as pixels of the finger's own travel; the picture gives by a part of it.)
        const past = ((asked < 0 ? asked : asked - last) / span) * press.box.width * sign;
        this.#band(Math.sign(past) === Math.sign(this.#over) || !this.#over ? this.#over + past : past);
        press.anchorTime = asked < 0 ? 0 : last;
        press.anchorAlong = along;
      } else if (this.#over) this.#band(0);
      const time = clamp(asked, 0, last);
      this.#fan?.at(e.clientX, e.clientY);
      const samples = press.samples;
      samples.push({ at: e.timeStamp, time, along });
      while (samples.length > 2 && e.timeStamp - samples[0].at > WINDOW) samples.shift();
      const first = samples[0];
      const took = (e.timeStamp - first.at) / 1000;
      this.#want(time, took > 0.012 ? (time - first.time) / took : this.#speed);
      if (!reducedMotion.matches) this.#edge?.thumb?.(time / duration);
    };
    const end = (cancelled: boolean) => (e: PointerEvent) => {
      if (e.pointerId !== event.pointerId) return;
      local.abort();
      if (!press) return;
      this.#band(0);
      this.#up(e, cancelled);
    };
    container.addEventListener('pointermove', move, { passive: true, signal: local.signal });
    container.addEventListener('pointerup', end(false), { signal: local.signal });
    container.addEventListener('pointercancel', end(true), { signal: local.signal });
  }

  // ─── What is said, and printed ────────────────────────────────────────────

  /** The status announcer's "Seeked to…" would be a stream under a hand: held back, and let speak again after. */
  #speak(on: boolean) {
    clearTimeout(this.#quietTimer);
    const announcer = this.#container?.querySelector<HTMLElement>('media-status-announcer');
    if (!announcer) return;
    if (on) announcer.removeAttribute('aria-live');
    else announcer.setAttribute('aria-live', 'off');
  }

  #speakLater() {
    clearTimeout(this.#quietTimer);
    this.#quietTimer = window.setTimeout(() => this.#speak(true), SAY_AFTER + 500);
  }

  /** "Page 19 of 52, One Gallop, 0:36": where the hand came to rest, once. */
  #sayPage() {
    const book = this.#book;
    const video = this.#video;
    if (!book || !video || !video.paused || this.#mode !== 'idle') return;
    const time = video.currentTime;
    const chapter = book.chapters[chapterAt(book, time)]?.text;
    const values = { page: tileAt(book.tiles, time) + 1, total: book.tiles.length, chapter: chapter ?? '', time: clock(time) };
    this.#voice?.(say(this.#i18n, chapter ? 'flipbook.rested' : 'flipbook.restedPlain', values));
  }

  /** The chapter the film is in, for the print's margin. */
  #chapter() {
    const book = this.#book;
    const video = this.#video;
    if (!book || !video) return;
    this.#print?.chapter(book.chapters[chapterAt(book, video.currentTime)]?.text ?? '');
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('fb-flip')) customElements.define('fb-flip', FbFlipElement);
attach('fb-flip', 'deck');
