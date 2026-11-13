import { type Page } from '@playwright/test';
import { container, contrast, NO_PLATE, pausedAt } from './support/book-features';
import { measure, media, open, seekPainted } from './support/player';
import { expect, test } from './support/test';

/**
 * Captions as intertitles (src/skins/flipbook/intertitle.ts): the cue set in ink on the page, under the picture.
 * Measured on the running page at four widths, with the controls up and away: where the card stands against every
 * control, its type against the size floors, its ink against its ground, and the player's box, which must not move.
 */

const FLOORS = { s: 14, m: 16, l: 19, xl: 22 } as const;
const WIDTHS: [number, number][] = [
  [320, 640],
  [390, 780],
  [768, 900],
  [1280, 800],
];

/** Everything about the card and what it must stay clear of, read from the page. */
const read = (page: Page) =>
  page.evaluate(() => {
    const root = document.querySelector('media-container') as HTMLElement;
    const card = root.querySelector('.fb-intertitle-card') as HTMLElement;
    const lines = root.querySelector('.fb-intertitle-lines') as HTMLElement;
    const video = root.querySelector('video') as HTMLVideoElement;
    const box = root.getBoundingClientRect();
    const at = card.getBoundingClientRect();
    const seen = (el: Element) =>
      el.getClientRects().length > 0 &&
      (el as HTMLElement & { checkVisibility: (options: object) => boolean }).checkVisibility({ opacityProperty: true, visibilityProperty: true });
    // Every control a viewer can reach, wherever the layout has it. A chapter tab is measured by its face: its hit
    // box reaches up over the picture by design (targets.spec), and the skin's caption layer clears the face too.
    const controls = [
      ...root.querySelectorAll('button:not(.fb-tab), [role="button"], [role="slider"], [role="menuitem"], media-time-slider, input, a[href], .fb-tab-face, .fb-ribbon, .fb-bar'),
    ].filter((el) => seen(el) && !card.contains(el));
    const hits = controls
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.left < at.right && r.right > at.left && r.top < at.bottom && r.bottom > at.top;
      })
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`);
    // The picture as shown: the video's box, less any letterbox.
    const v = video.getBoundingClientRect();
    const fitted = Math.min(v.width / video.videoWidth, v.height / video.videoHeight);
    const pictureBottom = v.top + (v.height + video.videoHeight * fitted) / 2;
    const text = lines.querySelector('.fb-intertitle-text') as HTMLElement | null;
    const over = root.querySelector('fb-intertitle')?.hasAttribute('data-over') ?? false;
    const cardGround = getComputedStyle(card).backgroundColor;
    return {
      on: root.hasAttribute('data-fb-intertitle'),
      open: root.querySelector('fb-intertitle')?.hasAttribute('data-open') ?? false,
      text: lines.textContent ?? '',
      controls: controls.length,
      hits,
      over,
      inside: at.left >= box.left - 0.5 && at.right <= box.right + 0.5 && at.top >= box.top - 0.5 && at.bottom <= box.bottom + 0.5,
      under: at.top - pictureBottom,
      fontSize: Number.parseFloat(getComputedStyle(lines).fontSize),
      ink: text ? getComputedStyle(text).color : '',
      ground: /rgba?\(0, 0, 0, 0\)|transparent/.test(cardGround) ? getComputedStyle(root).backgroundColor : cardGround,
      box: [box.left, box.top, box.width, box.height].map((n) => Math.round(n * 10) / 10),
      controlsShown: root.hasAttribute('data-controls-visible'),
      plate: Number(root.style.getPropertyValue('--fb-it-scale')),
    };
  });

/** Two frames after the last change: the card places itself on the frame after a mutation. */
const placed = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));

test.describe('intertitle captions', () => {
  for (const [width, height] of WIDTHS) {
    test(`${width} px: under the picture, clear of every control, at its size, in ink on paper`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await open(page, NO_PLATE);
      const before = await container(page).boundingBox();
      await page.evaluate(() => localStorage.setItem('fb-caption-style', JSON.stringify({ mode: 'intertitle' })));
      await page.reload();
      await open(page, NO_PLATE);
      await expect(container(page)).toHaveAttribute('data-fb-cap-mode', 'intertitle');

      // Captions off: nothing changes, the picture is whole.
      await pausedAt(page, 28);
      await expect(container(page)).not.toHaveAttribute('data-fb-intertitle', /.*/);
      await page.keyboard.press('c');
      await expect.poll(async () => (await media(page)).captions).toBe('showing');
      await expect(container(page)).toHaveAttribute('data-fb-intertitle', '');
      await expect.poll(async () => (await read(page)).text).toContain('Palo Alto, 19 June 1878');

      // The controls are up (paused). At each size: clear of them all, inside the player, at or over its floor.
      for (const [size, floor] of Object.entries(FLOORS)) {
        await container(page).evaluate((el, value) => el.setAttribute('data-fb-cap-size', value), size);
        await placed(page);
        await page.waitForTimeout(300);
        const state = await read(page);
        expect(state.controlsShown, 'controls up').toBe(true);
        expect(state.controls, 'controls were measured').toBeGreaterThan(4);
        expect(state.hits, `${size}: the card on a control`).toEqual([]);
        expect(state.inside, `${size}: the card inside the player`).toBe(true);
        expect(state.fontSize, `${size}: font size`).toBeGreaterThanOrEqual(floor);
        expect(contrast(state.ink, state.ground), `${size}: ink on its ground`).toBeGreaterThanOrEqual(4.9);
        // With room to make over the controls, it is under the picture even then.
        if (!state.over) expect(state.under, `${size}: under the picture`).toBeGreaterThanOrEqual(-1);
        // Standing on the plate's foot (no room under it: the controls are up, or the cue runs to more lines than
        // the band keeps), the plate still has the size the band leaves it: it is never shrunk to its floor (0.3).
        else expect(state.plate, `${size}: the plate under the card`).toBeGreaterThan(0.35);
        const now = await container(page).boundingBox();
        expect(now, `${size}: the player's box`).toEqual(before);
      }
      await container(page).evaluate((el) => el.setAttribute('data-fb-cap-size', 'm'));

      // Music keeps its notes, in the page's second ink, still over 4.9:1.
      await page.evaluate(() => ((document.querySelector('video') as HTMLVideoElement).currentTime = 1));
      await expect.poll(async () => (await read(page)).text).toContain('♪');
      const music = await read(page);
      expect(await page.locator('.fb-intertitle-line').first().getAttribute('data-kind')).toBe('music');
      expect(contrast(music.ink, music.ground)).toBeGreaterThanOrEqual(4.9);
      expect(music.hits).toEqual([]);

      // Playing, the controls away: the card is in the band under the picture, never on it.
      await page.evaluate(() => {
        const video = document.querySelector('video') as HTMLVideoElement;
        video.currentTime = 42.05;
        void video.play();
      });
      await page.mouse.move(width / 2, height - 4);
      await expect(container(page)).not.toHaveAttribute('data-controls-visible', /.*/, { timeout: 8000 });
      await page.evaluate(() => ((document.querySelector('video') as HTMLVideoElement).currentTime = 42.1));
      await expect.poll(async () => (await read(page)).text).toContain('Plate 700');
      await placed(page);
      await page.waitForTimeout(350);
      const playing = await read(page);
      expect(playing.controlsShown).toBe(false);
      expect(playing.over, 'on the page, not on the picture').toBe(false);
      expect(playing.under, 'under the picture').toBeGreaterThanOrEqual(-1);
      expect(playing.inside).toBe(true);
      expect(playing.hits).toEqual([]);
      expect(playing.fontSize).toBeGreaterThanOrEqual(FLOORS.m);
      expect(contrast(playing.ink, playing.ground)).toBeGreaterThanOrEqual(4.9);
      expect(await container(page).boundingBox()).toEqual(before);

      // Captions off again (the viewer's own switch): the page is film again, whole.
      await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).pause());
      await page.mouse.move(width / 2, (before?.y ?? 0) + (before?.height ?? 0) * 0.4);
      await page.keyboard.press('c');
      await expect.poll(async () => (await media(page)).captions).not.toBe('showing');
      await expect(container(page)).not.toHaveAttribute('data-fb-intertitle', /.*/);
    });
  }

  /*
   * A long cue on a narrow player: consecutive cards of the band's two lines, at the viewer's own size, each for its
   * share of the cue's time. The film's longest cue is the subject (82 characters, 0:26.0 to 0:31.4).
   */
  const LONG = 'Palo Alto, 19 June 1878: Sallie Gardner at a gallop, a photograph every 27 inches.';
  const LONG_AT = [26, 31.4] as const;
  const FLOOR = 1.2;
  const PHONES: [number, number][] = [
    [320, 640],
    [390, 780],
  ];

  /** The card showing, and the cue's cards as the element reports them. */
  const card = (page: Page) =>
    page.evaluate(() => {
      const root = document.querySelector('media-container') as HTMLElement;
      const it = root.querySelector('fb-intertitle') as HTMLElement;
      const box = it.querySelector('.fb-intertitle-card') as HTMLElement;
      const lines = it.querySelector('.fb-intertitle-lines') as HTMLElement;
      const leading = Number.parseFloat(getComputedStyle(lines).lineHeight);
      const at = box.getBoundingClientRect();
      return {
        count: Number(it.getAttribute('data-cards') ?? 1),
        index: Number(it.getAttribute('data-card') ?? 1),
        shares: (it.getAttribute('data-shares') ?? '').split(' ').filter(Boolean).map(Number),
        step: it.getAttribute('data-step'),
        text: [...lines.querySelectorAll('.fb-intertitle-text')].map((el) => el.textContent ?? '').join(' '),
        lines: [...lines.children].reduce((sum, p) => sum + Math.round(p.getBoundingClientRect().height / leading), 0),
        over: it.hasAttribute('data-over'),
        // How far the card reaches up over the picture as drawn (the plate, scaled).
        covers: Math.max(0, (root.querySelector('video') as HTMLVideoElement).getBoundingClientRect().bottom - at.top),
        height: Math.round(at.height),
        fontSize: Number.parseFloat(getComputedStyle(lines).fontSize),
        plate: Number(root.style.getPropertyValue('--fb-it-scale')),
      };
    });

  /** The player at a width with intertitles on, paused at a moment with its cue up. `captions` swaps the film's track. */
  async function intertitled(page: Page, width: number, height: number, at: number, captions?: string) {
    await page.setViewportSize({ width, height });
    await page.addInitScript(() => localStorage.setItem('fb-caption-style', JSON.stringify({ mode: 'intertitle' })));
    if (captions) await page.route('**/media/film/captions.vtt', (route) => route.fulfill({ contentType: 'text/vtt', body: captions }));
    await open(page, NO_PLATE);
    await pausedAt(page, at);
    await page.keyboard.press('c');
    await expect(container(page)).toHaveAttribute('data-fb-intertitle', '');
    await placed(page);
  }

  /** A size chosen, and the plate and the card arrived where that size puts them (they travel there, 250 ms). */
  const sized = async (page: Page, size: string) => {
    await container(page).evaluate((el, value) => el.setAttribute('data-fb-cap-size', value), size);
    await placed(page);
    await page.waitForFunction(() =>
      [document.querySelector('.fb-intertitle-card'), document.querySelector('media-container video')].every((el) => el?.getAnimations().every((animation) => animation.playState !== 'running')),
    );
  };

  const at = async (page: Page, time: number) => {
    await seekPainted(page, time);
    await placed(page);
  };

  for (const [width, height] of PHONES) {
    test(`${width} px: a cue of more lines than the band is set as cards of two lines, every word once, for the cue's time`, async ({ page }) => {
      await intertitled(page, width, height, 42.1);
      for (const [size, floor] of Object.entries(FLOORS)) {
        await sized(page, size);
        // A short cue first: the plate's size with the band's two lines under it.
        await at(page, 42.1);
        await expect.poll(async () => (await card(page)).text).toBe('Plate 700: a buffalo, galloping.');
        const short = await card(page);
        expect(short.count, `${size}: a short cue is one card`).toBe(1);
        expect(short.over, `${size}: the short cue under the picture`).toBe(false);

        await at(page, LONG_AT[0] + 0.1);
        await expect.poll(async () => (await card(page)).text).toContain('Palo Alto');
        const first = await card(page);
        if (first.count === 1) {
          // The whole cue has its two lines here: nothing to deal.
          expect(first.text, `${size}: the cue whole`).toBe(LONG);
          expect(first.lines, `${size}: lines`).toBeLessThanOrEqual(2);
          expect(first.over, `${size}: under the picture`).toBe(false);
          continue;
        }
        expect(first.step, `${size}: at the viewer's own size`).toBeNull();
        expect(first.fontSize, `${size}: font size`).toBeGreaterThanOrEqual(floor);
        expect(first.shares.length, `${size}: a time for every card`).toBe(first.count);
        expect(first.shares.reduce((sum, share) => sum + share, 0), `${size}: the cards' times add up to the cue's`).toBeCloseTo(LONG_AT[1] - LONG_AT[0], 2);
        for (const share of first.shares) expect(share, `${size}: no card under the floor`).toBeGreaterThanOrEqual(FLOOR);

        const shown: string[] = [];
        let begins = LONG_AT[0];
        for (let i = 0; i < first.count; i++) {
          const share = first.shares[i];
          await at(page, begins + share / 2);
          const now = await card(page);
          expect(now.index, `${size}: the card at ${(begins + share / 2).toFixed(2)} s`).toBe(i + 1);
          expect(now.lines, `${size}, card ${i + 1}: lines`).toBeLessThanOrEqual(2);
          expect(now.over, `${size}, card ${i + 1}: under the picture, not on it`).toBe(false);
          expect(now.covers, `${size}, card ${i + 1}: px of the picture under the card`).toBeLessThanOrEqual(1);
          expect(now.plate, `${size}, card ${i + 1}: the plate keeps the two-line band's size`).toBe(short.plate);
          expect(now.height, `${size}, card ${i + 1}: the card keeps the band's height`).toBe(short.height);
          expect(now.fontSize, `${size}, card ${i + 1}: font size`).toBe(first.fontSize);
          shown.push(now.text);
          // Either side of where the next card is due.
          if (i < first.count - 1) {
            await at(page, begins + share - 0.08);
            expect((await card(page)).index, `${size}: just before card ${i + 2} is due`).toBe(i + 1);
            await at(page, begins + share + 0.08);
            expect((await card(page)).index, `${size}: just after card ${i + 2} is due`).toBe(i + 2);
          }
          begins += share;
        }
        expect(shown.join(' '), `${size}: every word once, in order`).toBe(LONG);
        for (const text of shown) expect(/^\S.*\S$/.test(text), `${size}: "${text}" is whole words`).toBe(true);
        // Stepping back lands on the card for that moment.
        await at(page, LONG_AT[0] + 0.2);
        expect((await card(page)).index, `${size}: back at the cue's start`).toBe(1);
        await measure(test.info(), { kind: 'intertitle-cards', width, size, cards: first.count, shares: first.shares, plate: first.plate, texts: shown });
      }
    });
  }

  test('320 px, XL: playing, each card arrives when it is due, at twice the speed too; the track still holds the whole cue', async ({ page }) => {
    await intertitled(page, 320, 640, LONG_AT[0] - 0.4);
    await sized(page, 'xl');
    await at(page, LONG_AT[0] + 0.1);
    const { shares, count } = await card(page);
    expect(count).toBeGreaterThan(1);
    const due = shares.slice(0, -1).map((_, i) => LONG_AT[0] + shares.slice(0, i + 1).reduce((sum, share) => sum + share, 0));
    for (const rate of [1, 2]) {
      await at(page, LONG_AT[0] - 0.3);
      const arrivals = await page.evaluate(
        ([end, speed]) =>
          new Promise<number[]>((resolve) => {
            const video = document.querySelector('video') as HTMLVideoElement;
            const it = document.querySelector('fb-intertitle') as HTMLElement;
            const seen: number[] = [];
            let last = it.getAttribute('data-card');
            const watch = new MutationObserver(() => {
              const now = it.getAttribute('data-card');
              if (now === last) return;
              last = now;
              if (now && now !== '1') seen.push(video.currentTime);
            });
            watch.observe(it, { attributes: true, attributeFilter: ['data-card'] });
            const done = () => {
              if (video.currentTime < end) return;
              video.removeEventListener('timeupdate', done);
              video.pause();
              video.playbackRate = 1;
              watch.disconnect();
              resolve(seen);
            };
            video.addEventListener('timeupdate', done);
            video.playbackRate = speed;
            void video.play();
          }),
        [LONG_AT[1] - 0.2, rate] as const,
      );
      expect(arrivals.length, `at ${rate}×: a card for each time due`).toBe(due.length);
      // (A frame of the film, and a frame or two of the screen at that speed.)
      arrivals.forEach((time, i) => expect(Math.abs(time - due[i]), `at ${rate}×: card ${i + 2} arrived ${time.toFixed(3)}, due ${due[i].toFixed(3)}`).toBeLessThan(0.1 * rate));
    }

    // Still a caption: the track's cue is the whole sentence, untouched; what is drawn is out of the accessibility tree.
    await at(page, LONG_AT[0] + 0.1);
    const track = await page.evaluate(() => {
      const video = document.querySelector('video') as HTMLVideoElement;
      const showing = [...video.textTracks].find((t) => t.mode === 'showing' && (t.kind === 'captions' || t.kind === 'subtitles'));
      const it = document.querySelector('fb-intertitle') as HTMLElement;
      return {
        active: [...(showing?.activeCues ?? [])].map((cue) => (cue as VTTCue).text),
        cues: showing?.cues?.length,
        hidden: it.getAttribute('aria-hidden'),
        live: !!it.querySelector('[aria-live], [role="status"], [role="alert"]'),
      };
    });
    expect(track.active, 'the active cue').toEqual([LONG]);
    expect(track.cues, 'the track keeps its fourteen cues').toBe(14);
    expect(track.hidden).toBe('true');
    expect(track.live, 'nothing in the cards speaks').toBe(false);
  });

  /** Goes from the first card to the second in the page, and says what moved on the frame after. */
  const nextCard = (page: Page, time: number) =>
    page.evaluate(
      (t) =>
        new Promise<{ index: string | null; fades: { duration: number; easing: string; properties: string[] }[]; opacity: number; travels: string[]; moving: boolean }>((resolve) => {
          const root = document.querySelector('media-container') as HTMLElement;
          const video = root.querySelector('video') as HTMLVideoElement;
          const it = root.querySelector('fb-intertitle') as HTMLElement;
          const lines = it.querySelector('.fb-intertitle-lines') as HTMLElement;
          video.addEventListener(
            'seeked',
            () =>
              requestAnimationFrame(() => {
                const fades = lines.getAnimations().map((animation) => ({
                  duration: Number(animation.effect?.getComputedTiming().duration),
                  easing: String(animation.effect?.getTiming().easing),
                  properties: [...new Set((animation.effect as KeyframeEffect).getKeyframes().flatMap((frame) => Object.keys(frame)))].filter((name) => !['offset', 'easing', 'composite', 'computedOffset'].includes(name)),
                }));
                // Anything of the card or the plate on its way somewhere.
                const travels = [it.querySelector('.fb-intertitle-card') as HTMLElement, video]
                  .flatMap((el) => el.getAnimations())
                  .filter((animation) => animation.playState === 'running')
                  .map((animation) => (animation as CSSTransition).transitionProperty ?? 'animation');
                resolve({ index: it.getAttribute('data-card'), fades, opacity: Number(getComputedStyle(lines).opacity), travels, moving: it.hasAttribute('data-moving') });
              }),
            { once: true },
          );
          video.currentTime = t;
        }),
      time,
    );

  test('320 px, XL: the next card arrives by opacity alone, in 200 ms; nothing travels', async ({ page }) => {
    await intertitled(page, 320, 640, LONG_AT[0] + 0.1);
    await sized(page, 'xl');
    await at(page, LONG_AT[0] + 0.2);
    const { shares, count } = await card(page);
    expect(count).toBeGreaterThan(1);
    const change = await nextCard(page, LONG_AT[0] + shares[0] + 0.3);
    expect(change.index).toBe('2');
    expect(change.fades, 'one fade on the words').toHaveLength(1);
    expect(change.fades[0].duration).toBe(200);
    expect(change.fades[0].easing).toBe('cubic-bezier(0.2, 0.7, 0.2, 1)');
    expect(change.fades[0].properties).toEqual(['opacity']);
    expect(change.opacity, 'the words on their way in').toBeLessThan(1);
    expect(change.travels, 'the card and the plate hold still').toEqual([]);
    expect(change.moving).toBe(false);
    await expect.poll(() => page.evaluate(() => Number(getComputedStyle(document.querySelector('.fb-intertitle-lines') as HTMLElement).opacity))).toBe(1);
  });

  test('320 px, XL, reduced motion: one card replaces the other, with no fade and no travel', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await intertitled(page, 320, 640, LONG_AT[0] + 0.1);
    await sized(page, 'xl');
    await at(page, LONG_AT[0] + 0.2);
    const before = await card(page);
    expect(before.count).toBeGreaterThan(1);
    const change = await nextCard(page, LONG_AT[0] + before.shares[0] + 0.3);
    expect(change.index).toBe('2');
    expect(change.fades, 'no fade').toEqual([]);
    expect(change.opacity).toBe(1);
    expect(change.travels).toEqual([]);
    expect(change.moving).toBe(false);
    const after = await card(page);
    expect(after.text).not.toBe(before.text);
    expect(after.plate).toBe(before.plate);
  });

  test('320 px, XL: a cue too short for its cards steps the type down a size; one too short at every size stands whole', async ({ page }) => {
    // The film's long sentence, given 3 s (three cards at XL want 3.6 s; two at L want 2.4), then given 2 s.
    const track = ['WEBVTT', '', '00:00:26.000 --> 00:00:29.000', LONG, '', '00:00:40.000 --> 00:00:42.000', LONG, ''].join('\n');
    await intertitled(page, 320, 640, 26.2, track);
    await sized(page, 'xl');
    await expect.poll(async () => (await card(page)).text).toContain('Palo Alto');
    const stepped = await card(page);
    expect(stepped.step, 'a size down, and only one').toBe('l');
    expect(stepped.fontSize).toBe(FLOORS.l);
    expect(stepped.count).toBe(2);
    for (const share of stepped.shares) expect(share).toBeGreaterThanOrEqual(FLOOR);
    expect(stepped.shares.reduce((sum, share) => sum + share, 0)).toBeCloseTo(3, 2);
    expect(stepped.lines).toBeLessThanOrEqual(2);
    expect(stepped.over).toBe(false);

    await at(page, 40.2);
    await expect.poll(async () => (await card(page)).step).toBe('s');
    const whole = await card(page);
    expect(whole.count, 'no cards: the whole cue').toBe(1);
    expect(whole.text).toBe(LONG);
    expect(whole.fontSize).toBe(FLOORS.s);
    // (As a cue of three lines stood before there were cards: on the plate's foot, the plate at the band's size.)
    expect(whole.over).toBe(true);
    expect(whole.plate).toBeGreaterThan(0.35);

    // The next cue is back at the viewer's size.
    await sized(page, 'm');
    await at(page, 26.2);
    await expect.poll(async () => (await card(page)).step).toBeNull();
    expect((await card(page)).fontSize).toBe(FLOORS.m);
  });

  test('1280 px: the long cue is one card under the picture, as it was', async ({ page }) => {
    await intertitled(page, 1280, 800, LONG_AT[0] + 2);
    for (const [size, floor] of Object.entries(FLOORS)) {
      await sized(page, size);
      await expect.poll(async () => (await card(page)).text).toBe(LONG);
      const state = await card(page);
      expect(state.count, `${size}: one card`).toBe(1);
      expect(state.step, `${size}: no step`).toBeNull();
      expect(state.lines, `${size}: lines`).toBeLessThanOrEqual(2);
      expect(state.fontSize, `${size}: font size`).toBeGreaterThanOrEqual(floor);
      expect(await page.locator('fb-intertitle').getAttribute('data-shares'), `${size}: no shares`).toBeNull();
    }
  });

  test('the Caption style page offers it, and sets aside what the page decides itself', async ({ page }) => {
    await open(page, NO_PLATE);
    await pausedAt(page, 28);
    await page.keyboard.press('Shift+C');
    const sheet = page.locator('fb-caption-style');
    await expect(sheet.getByRole('radio', { name: 'Intertitle' })).toBeVisible();
    await expect(sheet.locator('fieldset[data-group="bg"] input').first()).toBeEnabled();
    await sheet.getByRole('radio', { name: 'Intertitle' }).check({ force: true });
    await expect(container(page)).toHaveAttribute('data-fb-cap-mode', 'intertitle');
    for (const group of ['bg', 'color', 'position']) {
      await expect(sheet.locator(`fieldset[data-group="${group}"]`)).toHaveAttribute('disabled', '');
      await expect(sheet.locator(`fieldset[data-group="${group}"] input`).first()).toBeDisabled();
    }
    await expect(sheet.locator('fieldset[data-group="size"] input').first()).toBeEnabled();
    await expect(sheet.locator('.fb-captype-note')).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('fb-caption-style') ?? '{}').mode)).toBe('intertitle');
    await sheet.getByRole('radio', { name: 'On the picture' }).check({ force: true });
    await expect(sheet.locator('fieldset[data-group="bg"] input').first()).toBeEnabled();
    await expect(sheet.locator('.fb-captype-note')).toBeHidden();
    await expect(container(page)).toHaveAttribute('data-fb-cap-mode', 'picture');
  });
});
