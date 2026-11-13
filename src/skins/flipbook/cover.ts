import { type PropertyValues, PlayerController, playerContext, selectPlayback, selectTime, UIElement } from '@videojs/html';
import { I18nController, i18nContext } from '@videojs/html/i18n';
import { type Book, clock, loadBook, reducedMotion, videoIn } from './book';
import { frameFor, tell, voiceFor } from './pages';
import { canCurl, Paper, pose, RIFFLE, turnCurve } from './paper';
import { isOn } from './features';
import { turnTo } from './goto';
import { chapterName, ribbonsOf } from './marks';

/** The closing riffle: the last page, then a few blank leaves, then the back cover. */
const LEAVES = 4;
const LEAF_TURN = 420;
const LEAF_GAP = 105;
/** On paper each leaf rolls over rather than swinging stiffly, so it takes a little longer. */
const PAPER_LEAF_TURN = 560;
const PAPER_LEAF_GAP = 125;
/** Opening the book again: the cover swings away, a scene change, not a control. */
const OPEN = 520;

let uid = 0;

/**
 * The back cover. When the film ends the book closes: the last page and the few blank leaves after it riffle over,
 * and underneath is the back cover, bound in the slab's cloth: the title, the length, the chapters as small entries,
 * the bookmarks if there are any, and Watch again. Watching again, or choosing a chapter or a bookmark, opens the book:
 * the cover swings away and the film plays. Under reduced motion there's no riffle and no swing; the cover is simply
 * there, and simply goes.
 */
export class FbCoverElement extends UIElement {
  #time = new PlayerController(this, playerContext, selectTime);
  #playback = new PlayerController(this, playerContext, selectPlayback);
  #i18n = new I18nController(this, i18nContext);
  #abort: AbortController | null = null;
  #container: HTMLElement | null = null;
  #book: Book | null = null;
  #say: ((message: string) => void) | null = null;
  #ended = false;
  #animations: Animation[] = [];
  #paper: Paper | null = null;
  #frame = 0;
  #id = `fb-cover-${++uid}`;

  connectedCallback() {
    super.connectedCallback();
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    this.hidden = true;
    this.setAttribute('data-fb-overlay', '');
    const container = this.closest<HTMLElement>('media-container');
    this.#container = container;
    if (!container) return;
    this.#say = voiceFor(container);
    const id = this.#id;
    this.innerHTML = [
      `<section class="fb-cover-board" aria-labelledby="${id}-title">`,
      '<span class="fb-cover-tooling" aria-hidden="true"></span>',
      '<div class="fb-cover-inner">',
      `<h2 class="fb-cover-title" id="${id}-title"></h2>`,
      '<p class="fb-cover-meta"><span class="fb-sr-only" data-part="length-label"></span><span class="fb-cover-length"></span><span class="fb-cover-dot" aria-hidden="true">·</span><span class="fb-cover-count"></span></p>',
      '<button type="button" class="fb-cover-again"><media-icon family="flipbook" name="restart"></media-icon><span data-part="again"></span></button>',
      `<h3 class="fb-sr-only" id="${id}-chapters"></h3>`,
      `<ol class="fb-cover-chapters" aria-labelledby="${id}-chapters"></ol>`,
      `<h3 class="fb-sr-only" id="${id}-marks" hidden></h3>`,
      `<ul class="fb-cover-marks" aria-labelledby="${id}-marks"></ul>`,
      '</div>',
      '</section>',
      '<div class="fb-cover-leaves" aria-hidden="true"></div>',
    ].join('');

    queueMicrotask(async () => {
      this.#book = await loadBook(container, signal);
      if (signal.aborted) return;
      this.#build();
      ribbonsOf(container).addEventListener('change', () => this.#buildMarks(), { signal });
    });

    this.addEventListener('click', (event) => {
      const target = (event.target as Element | null)?.closest<HTMLElement>('button');
      if (!target || !this.contains(target)) return;
      if (target.classList.contains('fb-cover-again')) this.#play(0);
      else if (target.dataset.time) this.#play(Number(target.dataset.time));
    }, { signal });
    // The cover's own clicks don't reach the player's tap gestures underneath.
    for (const type of ['pointerdown', 'pointerup', 'click', 'dblclick']) {
      this.addEventListener(type, (event) => event.stopPropagation(), { signal });
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort?.abort();
    this.#cancel();
  }

  update(changed: PropertyValues) {
    super.update(changed);
    const playback = this.#playback.value;
    if (!playback) return;
    const ended = Boolean(playback.ended);
    if (ended === this.#ended) return;
    this.#ended = ended;
    if (ended) this.#close();
    else this.#open();
  }

  #text() {
    const i18n = this.#i18n;
    const container = this.#container;
    const set = (selector: string, text: string) => {
      const node = this.querySelector<HTMLElement>(selector);
      if (node && node.textContent !== text) node.textContent = text;
    };
    const title =
      container?.querySelector('.media-title')?.textContent?.trim() || container?.closest('video-player')?.getAttribute('content-title') || '';
    set('.fb-cover-title', title || tell(i18n, 'fbPages.backCover'));
    set('[data-part="length-label"]', `${tell(i18n, 'fbPages.length')} `);
    set('.fb-cover-length', clock(this.#time.value?.duration ?? 0));
    const count = this.#book?.chapters.length ?? 0;
    set('.fb-cover-count', count ? tell(i18n, 'fbPages.chapterCount', { count }) : '');
    this.querySelector('.fb-cover-dot')?.toggleAttribute('hidden', !count);
    set('[data-part="again"]', tell(i18n, 'fbPages.watchAgain'));
    set(`#${this.#id}-chapters`, tell(i18n, 'fbPages.chapters'));
    set(`#${this.#id}-marks`, tell(i18n, 'fbPages.bookmarks'));
  }

  #build() {
    const book = this.#book;
    const list = this.querySelector('.fb-cover-chapters');
    if (!book || !list) return;
    list.replaceChildren(
      ...book.chapters.map((chapter, i) => {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'fb-cover-entry';
        button.dataset.time = String(chapter.startTime);
        button.innerHTML = '<span class="fb-cover-number"></span> <span class="fb-cover-name"></span> <span class="fb-cover-time"></span>';
        (button.querySelector('.fb-cover-number') as HTMLElement).textContent = String(i + 1);
        (button.querySelector('.fb-cover-name') as HTMLElement).textContent = chapter.text;
        (button.querySelector('.fb-cover-time') as HTMLElement).textContent = clock(chapter.startTime);
        item.append(button);
        return item;
      }),
    );
    this.#buildMarks();
  }

  #buildMarks() {
    const container = this.#container;
    const list = this.querySelector<HTMLElement>('.fb-cover-marks');
    if (!container || !list) return;
    const times = ribbonsOf(container).times;
    list.replaceChildren(
      ...times.map((time) => {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'fb-cover-entry fb-cover-mark';
        button.dataset.time = String(time);
        button.innerHTML = '<span class="fb-cover-ribbon" aria-hidden="true"></span><span class="fb-cover-time"></span> <span class="fb-cover-name"></span>';
        const chapter = chapterName(this.#book, time);
        (button.querySelector('.fb-cover-time') as HTMLElement).textContent = clock(time);
        (button.querySelector('.fb-cover-name') as HTMLElement).textContent = chapter;
        item.append(button);
        return item;
      }),
    );
    list.hidden = times.length === 0;
    // Each heading comes before its list, and the bookmarks' heading goes with its list when there are none.
    this.querySelector(`#${this.#id}-marks`)?.toggleAttribute('hidden', times.length === 0);
    this.toggleAttribute('data-marks', times.length > 0);
  }

  /** The film ended: the last pages riffle over onto the back cover. */
  #close() {
    const container = this.#container;
    if (!container) return;
    this.#cancel();
    this.#text();
    this.#buildMarks();
    const hadFocus = container.contains(document.activeElement) && document.activeElement !== container;
    this.hidden = false;
    this.toggleAttribute('data-open', true);
    container.toggleAttribute('data-fb-cover', true);
    this.#say?.(tell(this.#i18n, 'fbPages.finished'));
    const settle = () => {
      if (hadFocus) this.querySelector<HTMLElement>('.fb-cover-again')?.focus({ preventScroll: true });
    };
    if (reducedMotion.matches || !isOn(container, 'turns')) {
      settle();
      return;
    }
    void this.#riffle().then(settle);
  }

  async #riffle() {
    const container = this.#container;
    const book = this.#book;
    const host = this.querySelector<HTMLElement>('.fb-cover-leaves');
    if (!container || !host) return;
    this.toggleAttribute('data-riffling', true);
    const box = this.getBoundingClientRect();
    // Where paper can be drawn the leaves are real paper, rolling over like every other page in the book.
    if (canCurl() && (await this.#riffleOnPaper(host, box, book))) {
      this.#clearLeaves();
      return;
    }
    host.style.perspective = `${Math.round(box.width * 1.4)}px`;

    // The top leaf is the last picture, exactly as it ended; the rest are the blank leaves at the back of a book.
    const leaves: HTMLElement[] = [];
    for (let i = 0; i < LEAVES; i++) {
      const leaf = document.createElement('div');
      leaf.className = 'fb-cover-leaf';
      leaf.style.zIndex = String(LEAVES - i);
      const front = document.createElement('div');
      front.className = 'fb-cover-leaf-front';
      if (i === 0) front.append(this.#still(box, book));
      else front.classList.add('fb-cover-leaf-blank');
      const shade = document.createElement('span');
      shade.className = 'fb-cover-leaf-shade';
      front.append(shade);
      const back = document.createElement('div');
      back.className = 'fb-cover-leaf-back';
      leaf.append(front, back);
      leaves.push(leaf);
    }
    host.replaceChildren(...leaves);

    const easing = 'cubic-bezier(0.55, 0.06, 0.32, 1)';
    leaves.forEach((leaf, i) => {
      const delay = i * LEAF_GAP;
      this.#animations.push(
        leaf.animate(
          [
            { transform: 'rotate3d(-0.22, 0.975, 0, 0deg)' },
            { transform: 'rotate3d(-0.22, 0.975, 0, -96deg)', offset: 0.55 },
            { transform: 'rotate3d(-0.22, 0.975, 0, -178deg)' },
          ],
          { duration: LEAF_TURN, delay, easing, fill: 'both' },
        ),
      );
      const below = leaves[i + 1]?.querySelector('.fb-cover-leaf-shade');
      if (below) {
        this.#animations.push(
          below.animate([{ opacity: 0.5 }, { opacity: 0.25, offset: 0.4 }, { opacity: 0 }], { duration: LEAF_TURN, delay, easing: 'ease-out', fill: 'both' }),
        );
      }
    });
    // The cover takes the last leaf's shadow as it's uncovered.
    const board = this.querySelector<HTMLElement>('.fb-cover-board');
    const shade = board?.animate([{ filter: 'brightness(0.6)' }, { filter: 'brightness(1)' }], {
      duration: LEAF_TURN,
      delay: (LEAVES - 1) * LEAF_GAP,
      easing: 'ease-out',
      fill: 'both',
    });
    if (shade) this.#animations.push(shade);
    const last = this.#animations[this.#animations.length - 1];
    await last?.finished.catch(() => {});
    this.#clearLeaves();
  }

  /**
   * The closing riffle on paper: the last picture, then the blank leaves, each rolling over from the bottom corner,
   * a beat apart, and the cover underneath taking their shadow. Resolves false if paper couldn't be drawn (the CSS
   * leaves run instead), true when the last leaf has gone or the riffle was cut short.
   */
  #riffleOnPaper(host: HTMLElement, box: DOMRect, book: Book | null): Promise<boolean> {
    const still = this.#still(box, book);
    if (!(still instanceof HTMLCanvasElement) || still.dataset.drawn !== 'true') return Promise.resolve(false);
    const paper = Paper.create(host);
    if (!paper) return Promise.resolve(false);
    const blank = document.createElement('canvas');
    blank.width = 512;
    blank.height = Math.max(2, Math.round((512 * box.height) / Math.max(1, box.width)));
    const ctx = blank.getContext('2d');
    if (ctx) {
      // The blank leaves at the back of the book: plain paper, a shade warmer toward the fore-edge.
      const grain = ctx.createLinearGradient(0, 0, blank.width, 0);
      grain.addColorStop(0, '#d8ccb7');
      grain.addColorStop(0.07, '#f2ebde');
      grain.addColorStop(0.82, '#efe7d6');
      grain.addColorStop(1, '#e0d5c1');
      ctx.fillStyle = grain;
      ctx.fillRect(0, 0, blank.width, blank.height);
    }
    const first = paper.texture(still);
    const rest = paper.texture(blank);
    if (!first || !rest) {
      paper.dispose();
      return Promise.resolve(false);
    }
    this.#paper = paper;
    const textures = [first, ...Array.from({ length: LEAVES - 1 }, () => rest)];
    // The cover takes the last leaf's shadow as it's uncovered.
    const board = this.querySelector<HTMLElement>('.fb-cover-board');
    const shade = board?.animate([{ filter: 'brightness(0.6)' }, { filter: 'brightness(1)' }], {
      duration: PAPER_LEAF_TURN,
      delay: (LEAVES - 1) * PAPER_LEAF_GAP,
      easing: 'ease-out',
      fill: 'both',
    });
    if (shade) this.#animations.push(shade);
    const total = (LEAVES - 1) * PAPER_LEAF_GAP + PAPER_LEAF_TURN;
    return new Promise((resolve) => {
      let start = -1;
      const tick = (now: number) => {
        if (this.#paper !== paper) return resolve(true);
        if (start < 0) start = now;
        const elapsed = now - start;
        const sheets = [];
        let under: WebGLTexture | null = null;
        for (let i = 0; i < textures.length; i++) {
          const p = (elapsed - i * PAPER_LEAF_GAP) / PAPER_LEAF_TURN;
          if (p >= 1) continue;
          if (p <= 0) {
            // The first leaf still waiting lies flat, uncovered by the ones turning above it.
            under = textures[i];
            break;
          }
          sheets.push(pose(textures[i], turnCurve(p), 1, RIFFLE));
        }
        paper.draw(under, sheets);
        if (elapsed < total) {
          this.#frame = requestAnimationFrame(tick);
          return;
        }
        this.#disposePaper();
        resolve(true);
      };
      paper.draw(textures[0], []);
      this.#frame = requestAnimationFrame(tick);
    });
  }

  #disposePaper() {
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    this.#paper?.dispose();
    this.#paper = null;
  }

  /** The last frame, sharp: drawn from the video as it stopped, or the storyboard's last sharp still. */
  #still(box: DOMRect, book: Book | null): HTMLElement {
    const container = this.#container;
    const video = container ? videoIn(container) : null;
    const canvas = document.createElement('canvas');
    const scale = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(box.width * scale);
    canvas.height = Math.round(box.height * scale);
    const ctx = canvas.getContext('2d');
    let drawn = false;
    if (ctx && video?.videoWidth) {
      const ratio = video.videoWidth / video.videoHeight;
      const w = canvas.width / canvas.height > ratio ? canvas.height * ratio : canvas.width;
      const h = w / ratio;
      ctx.fillStyle = '#0d0b09';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      try {
        ctx.drawImage(video, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
        drawn = true;
      } catch {
        drawn = false;
      }
    }
    canvas.dataset.drawn = String(drawn);
    if (!drawn && container && book) {
      void frameFor(container, book, (this.#time.value?.duration ?? 0) - 0.1).then((url) => {
        if (url) canvas.style.backgroundImage = `url("${url}")`;
      });
    }
    return canvas;
  }

  /** Watch again, or a chapter or a bookmark: the cover swings open and the film plays from there. */
  #play(time: number) {
    const store = this.#time.value;
    const playback = this.#playback.value;
    if (!store || !playback) return;
    const container = this.#container;
    const hadFocus = this.contains(document.activeElement);
    // The cover swings open and, under it, the last page turns to the one you chose (turn.ts).
    // Play once the turn has landed on its time; playing an ended film first would start it from the top.
    const video = container ? videoIn(container) : null;
    let started = false;
    const go = () => {
      if (started) return;
      started = true;
      void playback.play();
    };
    video?.addEventListener('seeked', go, { once: true });
    window.setTimeout(go, 700);
    if (container) turnTo(container.querySelector('fb-turn') ?? container, time);
    else void store.seek(time);
    // Focus would otherwise fall to the page: it goes to the play key, which is where the film is now controlled.
    if (hadFocus) container?.querySelector<HTMLElement>('.fb-play')?.focus({ preventScroll: true });
  }

  /** The film plays again: the cover opens away from the spine and the picture is there. */
  #open() {
    const container = this.#container;
    if (this.hidden) return;
    this.#cancel();
    container?.toggleAttribute('data-fb-cover', false);
    this.toggleAttribute('data-open', false);
    if (this.contains(document.activeElement)) container?.querySelector<HTMLElement>('.fb-play')?.focus({ preventScroll: true });
    const board = this.querySelector<HTMLElement>('.fb-cover-board');
    if (!board || reducedMotion.matches) {
      this.hidden = true;
      return;
    }
    const box = this.getBoundingClientRect();
    const depth = Math.round(box.width * 1.6);
    // A stiff board on its hinge: it swings toward you from the spine, catching the light as it turns, darkening as it
    // goes edge-on, and is gone once it passes square (its back is never seen). No fade: it leaves by turning.
    const swing = board.animate(
      [
        { transform: `perspective(${depth}px) rotateY(0deg)`, filter: 'brightness(1)', opacity: 1 },
        { transform: `perspective(${depth}px) rotateY(-38deg)`, filter: 'brightness(1.07)', opacity: 1, offset: 0.4 },
        { transform: `perspective(${depth}px) rotateY(-82deg)`, filter: 'brightness(0.62)', opacity: 1, offset: 0.9 },
        { transform: `perspective(${depth}px) rotateY(-90deg)`, filter: 'brightness(0.5)', opacity: 0 },
      ],
      { duration: OPEN, easing: 'cubic-bezier(0.3, 0.12, 0.4, 1)' },
    );
    this.#animations.push(swing);
    swing.finished.then(() => {
      if (!this.hasAttribute('data-open')) this.hidden = true;
    }, () => {});
  }

  #clearLeaves() {
    this.toggleAttribute('data-riffling', false);
    this.querySelector('.fb-cover-leaves')?.replaceChildren();
  }

  #cancel() {
    for (const animation of this.#animations) animation.cancel();
    this.#animations = [];
    this.#disposePaper();
    this.#clearLeaves();
  }
}

customElements.define('fb-cover', FbCoverElement);
