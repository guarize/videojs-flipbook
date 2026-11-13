import { type Page } from '@playwright/test';
import { container, NO_PLATE, pausedAt } from './support/book-features';
import { BARE, ESSENTIAL, FRAME, focusPlayer, media, open, pointerOnPlayer, seekPainted, tabKey, tabTo } from './support/player';
import { expect, test } from './support/test';

/**
 * The paused page and its strip of frames (src/skins/flipbook/plate.ts, plate.css).
 *
 * - Pausing shows the frame that was paused, as the printed page: the plate never lays itself over it. The picture is
 *   exactly as large as it is without the plate's extra at all.
 * - The twelve frames around the moment stand in the page's foot as one row: six before, the one you're on (marked,
 *   numbered, `aria-current`), five after. Each is a whole target of its own and shares no pixel with the controls,
 *   the stamp, the keys on the page, the dog-ear or the corner.
 * - A frame chosen: the film is there, the row comes round by exactly that many frames as one thing (220 ms, a
 *   transform), and the pictures it had go with it. No long task.
 * - One Tab stop: arrows along it, Home and End, Enter goes; a frame key still steps the film with focus in it.
 * - P and the Plate key lay the same twelve out large; Escape puts the plate away and focus goes back.
 * - It leaves on play, and focus that was in it is the player's. Reduced motion: it is simply there.
 * - A caption stands over the foot, never on it, and stepping back in the strip does not switch captions on.
 *
 * Every check reads the running page: the film's clock, computed rects and styles, real clicks and key presses.
 */

const strip = (page: Page) => page.locator('fb-plate[data-strip]');
const frames = (page: Page) => page.locator('.fb-strip-cell');
const sheet = (page: Page) => page.locator('.fb-plate-sheet');

/** Paused by hand (a real K, the pointer on the picture) at `time`: what used to lay the plate out 1.1 s later. */
async function pauseByHand(page: Page, time: number) {
  await pointerOnPlayer(page);
  await page.keyboard.press('k');
  await page.waitForFunction(() => (document.querySelector('video') as HTMLVideoElement).currentTime > 1.2);
  await seekPainted(page, time);
  await page.keyboard.press('k');
  await page.waitForFunction(() => (document.querySelector('video') as HTMLVideoElement).paused);
}

/** The strip up, all twelve frames read. */
async function stripReady(page: Page) {
  await expect(strip(page)).toHaveCount(1);
  await expect(page.locator('.fb-strip-cell[data-ready]')).toHaveCount(12);
  // Arrived: the foot's fade is over.
  await expect.poll(() => page.locator('.fb-strip-window').evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
}

/** What the strip says of itself: each frame's name, which one is current, and the picture each one shows. */
const read = (page: Page) =>
  page.evaluate(() => {
    const cells = [...document.querySelectorAll<HTMLButtonElement>('.fb-strip-cell')];
    return {
      names: cells.map((c) => c.getAttribute('aria-label') ?? ''),
      current: cells.findIndex((c) => c.getAttribute('aria-current') === 'true'),
      marked: cells.filter((c) => c.hasAttribute('data-current')).length,
      stops: cells.filter((c) => c.tabIndex === 0).length,
      pictures: cells.map((c) => (c.querySelector('canvas') as HTMLCanvasElement).toDataURL().length),
      focus: cells.indexOf(document.activeElement as HTMLButtonElement),
    };
  });

/** A frame's time, from its name ("Frame 4 of 12, 0:19.9"), in seconds. */
const timeOf = (name: string) => {
  const match = /(\d+):(\d+)\.(\d)$/.exec(name);
  if (!match) throw new Error(`no time in "${name}"`);
  return Number(match[1]) * 60 + Number(match[2]) + Number(match[3]) / 10;
};

type Box = { x: number; y: number; w: number; h: number };
const boxes = (page: Page, selector: string): Promise<Box[]> =>
  page.evaluate((sel) => {
    const solid = (el: Element) => {
      let opacity = 1;
      for (let node: Element | null = el; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
      return opacity > 0.5;
    };
    return [...document.querySelectorAll<HTMLElement>(sel)]
      .filter((el) => el.getClientRects().length > 0 && el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && solid(el))
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      })
      .filter((r) => r.w > 1 && r.h > 1);
  }, selector);
const overlap = (a: Box, b: Box) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5;

/** The film's picture as it stands on the page. */
const picture = (page: Page) =>
  page.evaluate(() => {
    const r = (document.querySelector('video') as HTMLVideoElement).getBoundingClientRect();
    return { w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100 };
  });

test.describe('the paused page and its strip', () => {
  test.skip(ESSENTIAL, 'the book’s plate');

  test('a pause by hand shows the paused frame: the plate never lays itself over it, and the strip stands in the foot', async ({ page }) => {
    await open(page, BARE);
    await pauseByHand(page, 20.4);
    await stripReady(page);
    // Well past the 1.1 s after which the plate used to lay itself out.
    await page.waitForTimeout(1700);
    await expect(sheet(page)).toBeHidden();
    await expect(container(page)).not.toHaveAttribute('data-fb-plate', /.*/);
    await expect(container(page)).toHaveAttribute('data-fb-print', '');
    await expect(frames(page)).toHaveCount(12);
    const state = await read(page);
    expect(state.current, 'six before the frame you’re on, five after').toBe(6);
    expect(state.marked).toBe(1);
    expect(state.stops, 'one Tab stop').toBe(1);
    expect(state.names[6]).toMatch(/^Frame 7 of 12, 0:20\.\d$/);
    // A sixth of a second apart.
    const at = (await media(page)).time;
    expect(Math.abs(timeOf(state.names[6]) - Math.floor(at * 10) / 10)).toBeLessThan(0.11);
    expect(timeOf(state.names[11]) - timeOf(state.names[0])).toBeCloseTo(1.8, 0);
    // The title at its head, in the mono, quietly.
    await expect(page.locator('.fb-plate-toggle')).toHaveText(/^Plate · 0:\d\d\.\d – 0:\d\d\.\dP$/);
  });

  test('the strip costs the picture nothing: it is exactly as large as without the plate’s extra', async ({ page, browser }) => {
    await open(page, BARE);
    await pauseByHand(page, 20.4);
    await stripReady(page);
    const withStrip = await picture(page);
    const other = await browser.newPage();
    try {
      await open(other, NO_PLATE);
      await pausedAt(other, 20.4);
      await expect.poll(async () => (await picture(other)).w).toBeLessThan(1280);
      await other.waitForTimeout(400);
      const without = await picture(other);
      expect(withStrip.w, 'the picture’s width').toBeGreaterThanOrEqual(without.w);
      expect(withStrip.h, 'the picture’s height').toBeGreaterThanOrEqual(without.h);
    } finally {
      await other.close();
    }
  });

  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 700], [880, 700]] as const) {
    test(`${width} px: the strip shares no pixel with the controls, the stamp, the keys on the page, the dog-ear or the corner; each frame is a whole target`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await open(page, BARE);
      await pauseByHand(page, 20.4);
      await stripReady(page);
      const row = [...(await boxes(page, '.fb-strip-window')), ...(await boxes(page, '.fb-plate-toggle'))];
      expect(row.length).toBe(2);
      for (const other of ['.fb-bar', '.fb-tab', '.fb-stamp', '.fb-keep', 'fb-ear button', '.fb-curl-button', '.video-controls-top > .media-button', '.media-title', '.fb-next-button']) {
        const theirs = await boxes(page, other);
        expect(row.filter((a) => theirs.some((b) => overlap(a, b))), `the strip against ${other}`).toEqual([]);
      }
      expect(overlap(row[0], row[1]), 'the row against its own title').toBe(false);
      // Each frame in sight owns a whole target: every corner of its 44 px box is its own.
      const owned = await page.evaluate(() => {
        const view = (document.querySelector('.fb-strip-window') as HTMLElement).getBoundingClientRect();
        return [...document.querySelectorAll<HTMLElement>('.fb-strip-cell')]
          .map((cell) => ({ cell, r: cell.getBoundingClientRect() }))
          .filter(({ r }) => r.left >= view.left - 0.5 && r.right <= view.right + 0.5)
          .map(({ cell, r }) => ({
            w: r.width,
            h: r.height,
            own: [[r.left + 1, r.top + 1], [r.right - 1, r.top + 1], [r.left + 1, r.bottom - 1], [r.right - 1, r.bottom - 1], [r.left + r.width / 2, r.top + r.height / 2]].every(([x, y]) => {
              const hit = document.elementFromPoint(x, y);
              return !!hit && cell.contains(hit);
            }),
          }));
      });
      expect(owned.length, 'frames in sight').toBeGreaterThanOrEqual(4);
      for (const frame of owned) {
        expect(frame.w, 'a frame’s target, across').toBeGreaterThanOrEqual(44);
        expect(frame.h, 'a frame’s target, down').toBeGreaterThanOrEqual(44);
        expect(frame.own, 'a frame’s target is its own to every corner').toBe(true);
      }
      // The picture keeps most of its height in sight over the foot (plate.ts, PICTURE_KEEPS).
      const foot = (await boxes(page, '.fb-strip'))[0];
      const film = await page.evaluate(() => {
        const r = (document.querySelector('video') as HTMLVideoElement).getBoundingClientRect();
        return { y: r.y, h: r.height };
      });
      expect(foot.y - film.y, 'picture in sight over the foot').toBeGreaterThanOrEqual(film.h * 0.56);
    });
  }

  test('768 px: the foot would take too much of the picture, so there is no strip; the Plate key stands and P still lays the plate out', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 700 });
    await open(page, BARE);
    await pauseByHand(page, 20.4);
    await expect(container(page)).toHaveAttribute('data-fb-print', '');
    await page.waitForTimeout(700);
    await expect(strip(page)).toHaveCount(0);
    await expect(page.locator('.fb-strip-window')).toBeHidden();
    await expect(page.locator('.fb-plate-toggle')).toBeVisible();
    await expect(page.locator('.fb-plate-toggle')).toHaveText('PlateP');
    const key = (await boxes(page, '.fb-plate-toggle'))[0];
    for (const other of ['.fb-bar', '.fb-tab', '.fb-stamp', '.fb-keep']) {
      const theirs = await boxes(page, other);
      expect(theirs.some((b) => overlap(key, b)), `the Plate key against ${other}`).toBe(false);
    }
    await page.keyboard.press('p');
    await expect(sheet(page)).toBeVisible();
  });

  test('the frame you’re on is marked in the accent, numbered, and the others are not', async ({ page }) => {
    await open(page, BARE);
    await pauseByHand(page, 20.4);
    await stripReady(page);
    const marks = await page.evaluate(() => {
      const accent = (() => {
        const probe = document.createElement('i');
        probe.style.color = 'var(--fb-accent)';
        document.querySelector('media-container')?.append(probe);
        const value = getComputedStyle(probe).color;
        probe.remove();
        return value;
      })();
      return [...document.querySelectorAll('.fb-strip-cell')].map((cell) => ({
        ring: getComputedStyle(cell.querySelector('.fb-strip-thumb') as Element).boxShadow.includes(accent),
        number: getComputedStyle(cell.querySelector('.fb-strip-number') as Element).display !== 'none',
        text: cell.querySelector('.fb-strip-number')?.textContent,
      }));
    });
    expect(marks.map((m) => m.ring)).toEqual([false, false, false, false, false, false, true, false, false, false, false, false]);
    expect(marks.map((m) => m.number)).toEqual(marks.map((m) => m.ring));
    expect(marks[6].text).toBe('7');
  });

  test('a neighbour chosen: the film is on that frame, and the row comes round to it as one thing, its pictures with it', async ({ page }) => {
    await open(page, BARE);
    await pauseByHand(page, 20.4);
    await stripReady(page);
    const before = await read(page);
    const from = (await media(page)).time;
    // Three frames on: half a second.
    const tasks = await page.evaluate(() => {
      const seen: number[] = [];
      try {
        new PerformanceObserver((list) => seen.push(...list.getEntries().map((e) => e.duration))).observe({ type: 'longtask', buffered: false });
      } catch {
        // No long-task timing in this engine.
      }
      (window as unknown as { __long: number[] }).__long = seen;
      return true;
    });
    expect(tasks).toBe(true);
    await frames(page).nth(9).click();
    // The row travels: one transform, 220 ms, on the row itself.
    const travel = await page.evaluate(() => {
      const row = document.querySelector('.fb-strip-row') as HTMLElement;
      return row.getAnimations().map((a) => ({ duration: a.effect?.getTiming().duration, from: (a.effect as KeyframeEffect).getKeyframes()[0].transform }));
    });
    expect(travel).toEqual([{ duration: 220, from: expect.stringMatching(/^translateX\((156|204)px\)$/) }]);
    await expect.poll(async () => (await media(page)).time).toBeCloseTo(from + 0.5, 1);
    await expect.poll(async () => (await read(page)).names[6]).toBe(before.names[9].replace('Frame 10', 'Frame 7'));
    await expect(page.locator('.fb-strip-cell[data-ready]')).toHaveCount(12);
    const after = await read(page);
    expect(after.current).toBe(6);
    expect(after.marked).toBe(1);
    // The pictures went with the row: what was the tenth is the seventh, and so on down the row.
    expect(after.pictures.slice(0, 9)).toEqual(before.pictures.slice(3, 12));
    // The page is still the paused print, the plate still away.
    await expect(container(page)).toHaveAttribute('data-fb-print', '');
    await expect(sheet(page)).toBeHidden();
    expect((await media(page)).paused).toBe(true);
    await page.waitForTimeout(600);
    const long = await page.evaluate(() => (window as unknown as { __long: number[] }).__long);
    expect(long.filter((ms) => ms > 50), 'long tasks over the turn').toEqual([]);
    // And back: two frames before.
    await frames(page).nth(4).click();
    await expect.poll(async () => (await media(page)).time).toBeCloseTo(from + 0.5 - 1 / 3, 1);
  });

  test('one Tab stop: arrows along it, Home and End, Enter goes to the frame and focus stays on it; a frame key still steps the film', async ({ page, browserName }) => {
    await open(page, BARE);
    await pauseByHand(page, 20.4);
    await stripReady(page);
    await focusPlayer(page);
    await tabTo(page, browserName, '.fb-strip-cell');
    expect((await read(page)).focus, 'Tab lands on the frame you’re on').toBe(6);
    // The focus ring: the skin's 2 px, on the frame's picture.
    const ring = await page.evaluate(() => {
      const style = getComputedStyle(document.activeElement?.querySelector('.fb-strip-thumb') as Element);
      return { width: style.outlineWidth, style: style.outlineStyle };
    });
    expect(ring).toEqual({ width: '2px', style: 'solid' });
    // Its name is over it while the keyboard is on it.
    await expect(page.locator('.fb-strip-tip[data-open]')).toHaveText(/^7 · 0:20\.\d$/);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    expect((await read(page)).focus).toBe(8);
    const still = (await media(page)).time;
    await page.keyboard.press('ArrowLeft');
    expect((await read(page)).focus).toBe(7);
    expect((await media(page)).time, 'the arrows move along the strip, not the film').toBe(still);
    await page.keyboard.press('End');
    expect((await read(page)).focus).toBe(11);
    await page.keyboard.press('Home');
    expect((await read(page)).focus).toBe(0);
    expect((await read(page)).stops).toBe(1);
    // Tab leaves it in one press, and comes back to it in one.
    await page.keyboard.press(tabKey(browserName));
    expect((await read(page)).focus).toBe(-1);
    await page.keyboard.press(`Shift+${tabKey(browserName)}`);
    expect((await read(page)).focus).toBe(0);
    // Enter: the film goes a second back (six frames), the row comes round, and focus is on the frame you're on.
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await media(page)).time).toBeCloseTo(still - 1, 1);
    await expect.poll(async () => (await read(page)).focus).toBe(6);
    expect((await read(page)).current).toBe(6);
    // A frame key with focus in the strip is still the film's: one frame on, and the strip follows.
    const here = (await media(page)).time;
    await page.keyboard.press('.');
    // (To the middle of the next frame of a 24 fps film: between half a frame and a frame and a half on.)
    await expect.poll(async () => (await media(page)).time).toBeGreaterThan(here + FRAME * 0.5 - 0.005);
    expect((await media(page)).time).toBeLessThan(here + FRAME * 1.5 + 0.005);
    await expect.poll(async () => (await read(page)).focus).toBe(6);
  });

  test('P lays the same twelve frames out large; Escape puts the plate away, focus goes back and the strip is there again', async ({ page, browserName }) => {
    await open(page, BARE);
    await pauseByHand(page, 20.4);
    await stripReady(page);
    const row = await read(page);
    await focusPlayer(page);
    await tabTo(page, browserName, '.fb-strip-cell');
    await page.keyboard.press('p');
    await expect(sheet(page)).toBeVisible();
    await expect(strip(page)).toHaveCount(0);
    const plate = await page.evaluate(() => [...document.querySelectorAll('.fb-plate-cell')].map((c) => c.getAttribute('aria-label')));
    // The same twelve, the same numbers and times. A frame of the plate prints its number and its time, so its name
    // starts with them (WCAG 2.5.3): "Frame 4 of 12, 0:19.9" in the strip is "4 0:19.9, frame 4 of 12" here.
    const enlarged = row.names.map((name) => name.replace(/^Frame (\d+) of (\d+), (.+)$/, '$1 $3, frame $1 of $2'));
    expect(plate, 'the plate is the strip, enlarged').toEqual(enlarged);
    await expect(page.locator('.fb-plate-cell[aria-current="true"]')).toHaveAttribute('aria-label', enlarged[6]);
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe(enlarged[6]);
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toBeHidden();
    await expect(strip(page)).toHaveCount(1);
    await expect.poll(async () => (await read(page)).focus, 'focus back on the strip’s frame').toBe(6);
    // The key at the strip's head does the same, and takes focus back.
    await page.locator('.fb-plate-toggle').click();
    await expect(sheet(page)).toBeVisible();
    await page.locator('.fb-plate-close').click();
    await expect(sheet(page)).toBeHidden();
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.matches('.fb-plate-toggle'))).toBe(true);
  });

  test('on play the strip leaves, and focus that was in it is the player’s: K still pauses', async ({ page, browserName }) => {
    await open(page, BARE);
    await pauseByHand(page, 20.4);
    await stripReady(page);
    await page.mouse.move(2, 2);
    await focusPlayer(page);
    await tabTo(page, browserName, '.fb-strip-cell');
    await page.keyboard.press('k');
    await expect.poll(async () => (await media(page)).paused).toBe(false);
    await expect(strip(page)).toHaveCount(0);
    await expect(container(page)).not.toHaveAttribute('data-fb-strip', /.*/);
    await expect.poll(() => page.locator('.fb-strip-window').evaluate((el) => getComputedStyle(el).visibility)).toBe('hidden');
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName.toLowerCase())).toBe('media-container');
    await page.keyboard.press('k');
    await expect.poll(async () => (await media(page)).paused).toBe(true);
    await expect(strip(page)).toHaveCount(1);
  });

  test('it arrives and leaves by opacity alone, inside the 150–250 ms band', async ({ page }) => {
    await open(page, BARE);
    await pauseByHand(page, 20.4);
    await stripReady(page);
    const shown = await page.locator('.fb-strip-window').evaluate((el) => {
      const style = getComputedStyle(el);
      return { property: style.transitionProperty, duration: style.transitionDuration };
    });
    expect(shown).toEqual({ property: 'opacity, visibility', duration: '0.25s, 0s' });
    await page.keyboard.press('k');
    await expect(strip(page)).toHaveCount(0);
    const gone = await page.locator('.fb-strip-window').evaluate((el) => {
      const style = getComputedStyle(el);
      return { property: style.transitionProperty, duration: style.transitionDuration, delay: style.transitionDelay };
    });
    expect(gone).toEqual({ property: 'opacity, visibility', duration: '0.2s, 0s', delay: '0s, 0.2s' });
  });

  test('a caption stands over the foot, never on it, and a step back in the strip does not switch captions on', async ({ page }) => {
    await open(page, BARE);
    await pauseByHand(page, 28);
    await stripReady(page);
    // Captions off: six frames back is a second back, which once switched them on for ten seconds.
    expect((await media(page)).captions).not.toBe('showing');
    const from = (await media(page)).time;
    await frames(page).nth(0).click();
    await expect.poll(async () => Math.abs((await media(page)).time - (from - 1))).toBeLessThan(0.02);
    await page.waitForTimeout(400);
    expect((await media(page)).captions, 'reading back a frame is not “what did they say?”').not.toBe('showing');
    // On, by the viewer's key: the line is drawn, on the picture, clear of the foot.
    await pointerOnPlayer(page);
    await page.keyboard.press('c');
    await seekPainted(page, 28);
    await expect(page.locator('fb-captions[data-open]')).toHaveCount(1);
    await stripReady(page);
    await expect.poll(() => page.locator('fb-captions').evaluate((el) => getComputedStyle(el).visibility)).toBe('visible');
    await expect
      .poll(async () => {
        const lines = await boxes(page, '.fb-captions-line');
        const foot = await boxes(page, '.fb-strip');
        return lines.length > 0 && foot.length === 1 && !lines.some((line) => overlap(line, foot[0])) && lines.every((line) => line.y + line.h <= foot[0].y);
      })
      .toBe(true);
  });

  test('with intertitles the band under the picture is the cue’s: no strip, and the Plate key stands', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('fb-caption-style', JSON.stringify({ mode: 'intertitle' })));
    await open(page, BARE);
    await pointerOnPlayer(page);
    await page.keyboard.press('c');
    await pauseByHand(page, 28);
    await expect(container(page)).toHaveAttribute('data-fb-intertitle', '');
    await page.waitForTimeout(600);
    await expect(strip(page)).toHaveCount(0);
    await focusPlayer(page);
    await page.keyboard.press('p');
    await expect(sheet(page)).toBeVisible();
  });
});

/** The sheet as it is drawn now, and what the player says of the plate. */
const exitState = (page: Page) =>
  page.evaluate(() => {
    const plate = document.querySelector('fb-plate') as HTMLElement;
    const sheet = plate.querySelector('.fb-plate-sheet') as HTMLElement;
    const style = getComputedStyle(sheet);
    return {
      hidden: sheet.hidden,
      leaving: sheet.hasAttribute('data-away'),
      opacity: Number(style.opacity),
      scale: style.scale === 'none' ? 1 : Number(style.scale),
      pointer: style.pointerEvents,
      plate: !!document.querySelector('media-container')?.hasAttribute('data-fb-plate'),
      open: plate.hasAttribute('data-open'),
      full: plate.hasAttribute('data-full'),
      strip: plate.hasAttribute('data-strip'),
      ready: plate.querySelectorAll('.fb-plate-cell[data-ready]').length,
    };
  });

/** Holds the sheet's running transitions still, `at` ms into them: a moment of the exit (or the opening) to act in. */
const holdSheet = (page: Page, at: number) =>
  page.evaluate((time) => {
    const sheet = document.querySelector('.fb-plate-sheet') as HTMLElement;
    const running = sheet.getAnimations();
    for (const animation of running) {
      animation.pause();
      animation.currentTime = time;
    }
    return running.map((animation) => (animation as CSSTransition).transitionProperty).sort();
  }, at);

async function plateOut(page: Page) {
  await page.keyboard.press('p');
  await expect(page.locator('.fb-plate-cell[data-ready]')).toHaveCount(12);
  await expect.poll(async () => (await exitState(page)).opacity).toBe(1);
}

test.describe('the plate leaves as it came', () => {
  test.skip(ESSENTIAL, 'the book’s plate');

  test('put away, it is closed at once and the sheet fades and steps back in 200 ms, then is hidden', async ({ page }) => {
    await open(page, BARE);
    await pauseByHand(page, 20.4);
    await stripReady(page);
    await plateOut(page);
    expect(await sheet(page).evaluate((el) => {
      const style = getComputedStyle(el);
      return { property: style.transitionProperty, duration: style.transitionDuration, origin: style.transformOrigin.split(' ')[1] === `${el.offsetHeight}px` };
    }), 'the opening’s own transition, from the foot').toEqual({ property: 'opacity, scale', duration: '0.2s, 0.2s', origin: true });

    // Sampled every frame from the key press: closed to everything from the first, the sheet on its way out.
    const samples = await page.evaluate(() => new Promise<{ t: number; opacity: number; scale: number; hidden: boolean; plate: boolean; pointer: string }[]>((resolve) => {
      const sheet = document.querySelector('.fb-plate-sheet') as HTMLElement;
      const container = document.querySelector('media-container') as HTMLElement;
      const out: { t: number; opacity: number; scale: number; hidden: boolean; plate: boolean; pointer: string }[] = [];
      const from = performance.now();
      const read = () => {
        const style = getComputedStyle(sheet);
        out.push({ t: performance.now() - from, opacity: Number(style.opacity), scale: style.scale === 'none' ? 1 : Number(style.scale), hidden: sheet.hidden, plate: container.hasAttribute('data-fb-plate'), pointer: style.pointerEvents });
        if (sheet.hidden) resolve(out);
        else requestAnimationFrame(read);
      };
      sheet.querySelector<HTMLElement>('.fb-plate-close')?.click();
      read();
    }));
    const [first] = samples;
    const last = samples[samples.length - 1];
    const during = samples.filter((sample) => !sample.hidden);
    expect(first, 'closed at once, the sheet still whole').toMatchObject({ plate: false, hidden: false, pointer: 'none' });
    expect(first.opacity).toBeGreaterThan(0.9);
    expect(during.length, 'frames of the exit').toBeGreaterThan(3);
    for (let i = 1; i < during.length; i++) {
      expect(during[i].opacity, 'fading, never back').toBeLessThanOrEqual(during[i - 1].opacity + 0.001);
      expect(during[i].scale, 'stepping back, never forward').toBeLessThanOrEqual(during[i - 1].scale + 0.0005);
    }
    expect(Math.min(...during.map((sample) => sample.scale)), 'no further back than it came from').toBeGreaterThanOrEqual(0.9599);
    expect(during[during.length - 1].opacity, 'gone before it is hidden').toBeLessThan(0.05);
    expect(last.t, 'hidden when the 200 ms have run').toBeGreaterThanOrEqual(150);
    expect(last.t).toBeLessThan(400);
    await expect(strip(page)).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.matches('.fb-plate-toggle')), { message: 'focus back on the Plate key' }).toBe(true);
    expect(await exitState(page)).toMatchObject({ hidden: true, leaving: false, full: false, plate: false, open: false });
  });

  test('asked for again on its way out, it comes back from where it is, its frames still printed', async ({ page }) => {
    await open(page, BARE);
    await pauseByHand(page, 20.4);
    await stripReady(page);
    await plateOut(page);
    await page.keyboard.press('Escape');
    expect(await holdSheet(page, 60), 'the exit runs on opacity and scale').toEqual(['opacity', 'scale']);
    const mid = await exitState(page);
    expect(mid).toMatchObject({ hidden: false, leaving: true, plate: false, ready: 12 });
    expect(mid.opacity, 'part of the way out').toBeGreaterThan(0.05);
    expect(mid.opacity).toBeLessThan(0.95);

    await pointerOnPlayer(page);
    await page.keyboard.press('p');
    const back = await exitState(page);
    expect(back, 'open again').toMatchObject({ hidden: false, leaving: false, plate: true, open: true, ready: 12 });
    expect(back.opacity, 'from where it was: no jump to nothing, none to whole').toBeGreaterThanOrEqual(mid.opacity - 0.02);
    expect(back.opacity).toBeLessThan(1);
    await expect.poll(async () => (await exitState(page)).opacity).toBe(1);
    expect(await exitState(page)).toMatchObject({ hidden: false, leaving: false, plate: true, scale: 1, ready: 12, pointer: 'auto' });
  });

  test('put away while it is still coming, it turns back from where it is', async ({ page }) => {
    await open(page, BARE);
    await pauseByHand(page, 20.4);
    await stripReady(page);
    // The Plate key clicked and the opening held in one task: by the next, a quick machine has finished it.
    const opening = await page.evaluate(() => {
      (document.querySelector('.fb-plate-toggle') as HTMLElement).click();
      const running = (document.querySelector('.fb-plate-sheet') as HTMLElement).getAnimations();
      for (const animation of running) {
        animation.pause();
        animation.currentTime = 40;
      }
      return running.length;
    });
    expect(opening, 'the opening runs on opacity and scale').toBe(2);
    const mid = await exitState(page);
    expect(mid.opacity, 'part of the way in').toBeGreaterThan(0.05);
    expect(mid.opacity).toBeLessThan(0.99);
    await page.keyboard.press('Escape');
    const leaving = await exitState(page);
    expect(leaving).toMatchObject({ hidden: false, leaving: true, plate: false });
    expect(leaving.opacity, 'from where it was').toBeLessThanOrEqual(mid.opacity + 0.02);
    await expect(sheet(page)).toBeHidden();
    await expect(strip(page)).toHaveCount(1);
  });

  test('on a small player it keeps its place over the bar until it is gone; then the strip is back and the bar is the bar’s', async ({ page }) => {
    await page.setViewportSize({ width: 440, height: 800 });
    await open(page, BARE);
    await pauseByHand(page, 20.4);
    await stripReady(page);
    await plateOut(page);
    expect(await exitState(page)).toMatchObject({ full: true, strip: false });
    await page.keyboard.press('Escape');
    await holdSheet(page, 60);
    expect(await exitState(page), 'leaving: still over the bar, and no strip under it').toMatchObject({ hidden: false, leaving: true, full: true, strip: false, plate: false, pointer: 'none' });
    await page.evaluate(() => {
      for (const animation of (document.querySelector('.fb-plate-sheet') as HTMLElement).getAnimations()) animation.play();
    });
    await expect(sheet(page)).toBeHidden();
    expect(await exitState(page)).toMatchObject({ full: false, leaving: false });
    await expect(strip(page)).toHaveCount(1);
    // Nothing of the plate lies over the slab: its Settings key takes a click.
    await page.locator('#flipbook-settings-trigger').click();
    await expect(page.locator('#flipbook-settings-trigger')).toHaveAttribute('aria-expanded', 'true');
  });
});

test.describe('the strip under reduced motion', () => {
  test.skip(ESSENTIAL, 'the book’s plate');
  test.use({ reducedMotion: 'reduce' });

  test('it is simply there, and a frame chosen simply changes the row', async ({ page }) => {
    await open(page, BARE);
    await pauseByHand(page, 20.4);
    await expect(strip(page)).toHaveCount(1);
    const durations = await page.evaluate(() =>
      ['.fb-strip-window', '.fb-strip-thumb', '.fb-strip-thumb canvas', '.fb-strip-tip'].map((sel) => getComputedStyle(document.querySelector(sel) as Element).transitionDuration),
    );
    for (const duration of durations) expect(duration.split(', ').every((d) => Number.parseFloat(d) === 0), `no transition (${duration})`).toBe(true);
    await expect(page.locator('.fb-strip-cell[data-ready]')).toHaveCount(12);
    await frames(page).nth(9).click();
    expect(await page.evaluate(() => (document.querySelector('.fb-strip-row') as HTMLElement).getAnimations().length), 'the row does not travel').toBe(0);
    await expect.poll(async () => (await read(page)).current).toBe(6);
  });

  test('the plate has no exit: put away, it is hidden in the same frame', async ({ page }) => {
    await open(page, BARE);
    await pauseByHand(page, 20.4);
    await expect(strip(page)).toHaveCount(1);
    await page.keyboard.press('p');
    await expect(sheet(page)).toBeVisible();
    // Its close key, clicked in the page, and the sheet read in the same task: nothing has been drawn between.
    const after = await page.evaluate(() => {
      const sheet = document.querySelector('.fb-plate-sheet') as HTMLElement;
      sheet.querySelector<HTMLElement>('.fb-plate-close')?.click();
      return { hidden: sheet.hidden, leaving: sheet.hasAttribute('data-away'), display: getComputedStyle(sheet).display, running: sheet.getAnimations().length };
    });
    expect(after).toEqual({ hidden: true, leaving: false, display: 'none', running: 0 });
    await expect(strip(page)).toHaveCount(1);
  });
});

test.describe('the strip on a phone', () => {
  test.skip(ESSENTIAL, 'the book’s plate');
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('it stands in the picture’s foot over the pad, alone on the paused picture, scrolls with the frame you’re on in the middle, and a tap goes; the Plate key is Settings’ “Plate”', async ({ page }) => {
    await open(page, BARE);
    const box = await container(page).boundingBox();
    if (!box) throw new Error('no player');
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height * 0.4);
    // (Past its first second: a second tap sooner than a double tap's gap would fill the screen instead of pausing.)
    await expect.poll(async () => (await media(page)).time).toBeGreaterThan(1.2);
    await seekPainted(page, 20.4);
    // The pause follows at once, while the player still counts the hand as there. (Left a few seconds, a phone's
    // first tap only wakes the controls, though its pad never hides: the phone layout's to settle, noted in the report.)
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height * 0.4);
    await expect.poll(async () => (await media(page)).paused, { timeout: 4000 }).toBe(true);
    expect((await media(page)).time, 'paused mid-film').toBeLessThan(30);
    await stripReady(page);
    await expect(sheet(page)).toBeHidden();
    const layout = await page.evaluate(() => {
      const view = (document.querySelector('.fb-strip-window') as HTMLElement).getBoundingClientRect();
      const player = (document.querySelector('media-container') as HTMLElement).getBoundingClientRect();
      const cells = [...document.querySelectorAll<HTMLElement>('.fb-strip-cell')].map((c) => c.getBoundingClientRect());
      const current = (document.querySelector('.fb-strip-cell[data-current]') as HTMLElement).getBoundingClientRect();
      return {
        inPicture: view.top >= player.top && view.bottom <= player.bottom + 0.5,
        whole: cells.filter((r) => r.left >= view.left - 0.5 && r.right <= view.right + 0.5).length,
        off: Math.abs(current.left + current.width / 2 - (view.left + view.width / 2)),
        target: Math.min(...cells.map((r) => Math.min(r.width, r.height))),
        sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    expect(layout.inPicture, 'in the picture’s foot').toBe(true);
    expect(layout.whole, 'whole frames in sight').toBeGreaterThanOrEqual(4);
    expect(layout.off, 'the frame you’re on, in the middle').toBeLessThanOrEqual(1);
    expect(layout.target).toBeGreaterThanOrEqual(44);
    expect(layout.sideways, 'no sideways scroll of the page').toBeLessThanOrEqual(0);
    // A phone's paused picture carries the print alone: its margin and the strip. No Plate key, no Keep key, no
    // corner to fold or to lift (they are in the sheet, below).
    const frame = await container(page).boundingBox();
    if (!frame) throw new Error('no player');
    const onPicture: string[] = [];
    for (const selector of ['.fb-plate-toggle', '.fb-keep', '.fb-ear-button', '.fb-curl-button', '.media-button:not(.fb-cover-play)']) {
      for (const drawn of await boxes(page, selector)) if (overlap(drawn, { x: frame.x, y: frame.y, w: frame.width, h: frame.height })) onPicture.push(selector);
    }
    expect(onPicture, 'keys on the paused picture').toEqual([]);
    const row = await boxes(page, '.fb-strip-window');
    expect(row[0].w, 'the strip has the foot’s whole width, less the margins').toBeGreaterThanOrEqual(frame.width - 2 * 12 - 1);
    for (const other of ['.fb-bar', '.fb-tab', '.fb-stamp']) {
      const theirs = await boxes(page, other);
      expect(row.filter((a) => theirs.some((b) => overlap(a, b))), `the strip against ${other}`).toEqual([]);
    }
    // A tap on the next frame: the film goes a sixth of a second on and stays paused (a tap on the picture would play).
    const from = (await media(page)).time;
    await frames(page).nth(7).tap();
    await expect.poll(async () => (await media(page)).time).toBeCloseTo(from + 1 / 6, 1);
    expect((await media(page)).paused).toBe(true);
    await expect.poll(async () => (await read(page)).current).toBe(6);

    // The sheet has what left the picture: Bookmark, Keep this page, and Plate, which lays the twelve out and gives
    // focus back to the Settings key when it is put away.
    await page.locator('.fb-settings').tap();
    const item = page.locator('.media-menu-item[data-fb-menu="plate"]');
    await expect(item).toBeVisible();
    await expect(item).toHaveAccessibleName('Plate');
    await expect(page.locator('.media-menu-item[data-fb-menu="keep"]'), 'Settings has “Keep this page”').toBeVisible();
    // (Bookmark is a key of the pad itself now, by name, and is not offered here again: phone.spec.ts.)
    await expect(page.locator('.media-menu-item[data-fb-menu="bookmark"]')).toBeHidden();
    expect(await page.locator('#flipbook-bookmark-pad').evaluate((el) => el.checkVisibility()), 'Bookmark is on the pad').toBe(true);
    expect((await item.boundingBox())?.height, 'a whole target, px').toBeGreaterThanOrEqual(48);
    await item.scrollIntoViewIfNeeded();
    await item.tap();
    await expect(sheet(page)).toBeVisible();
    await expect(container(page)).toHaveAttribute('data-fb-plate', '');
    await expect(page.locator('.fb-plate-cell[data-current]')).toBeFocused();
    expect((await media(page)).paused, 'still paused, on the same frame').toBe(true);
    await page.locator('.fb-plate-close').tap();
    await expect(sheet(page)).toBeHidden();
    await expect(page.locator('.fb-settings')).toBeFocused();
    await stripReady(page);
  });

  test('going back, by a frame of the strip or to another page of the film, the frame you’re on is still in the middle', async ({ page }) => {
    await open(page, BARE);
    const box = await container(page).boundingBox();
    if (!box) throw new Error('no player');
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height * 0.4);
    // (Past its first second: a second tap sooner than a double tap's gap would fill the screen instead of pausing.)
    await expect.poll(async () => (await media(page)).time).toBeGreaterThan(1.2);
    await seekPainted(page, 20.4);
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height * 0.4);
    await expect.poll(async () => (await media(page)).paused, { timeout: 4000 }).toBe(true);
    await stripReady(page);
    /** How far the frame you're on stands from the middle of the row's window, px, once the row is still. */
    const off = async () => {
      await expect.poll(() => page.evaluate(() => (document.querySelector('.fb-strip-row') as HTMLElement).getAnimations().length), 'the row is still').toBe(0);
      return page.evaluate(() => {
        const view = (document.querySelector('.fb-strip-window') as HTMLElement).getBoundingClientRect();
        const current = (document.querySelector('.fb-strip-cell[data-current]') as HTMLElement).getBoundingClientRect();
        return Math.abs(current.left + current.width / 2 - (view.left + view.width / 2));
      });
    };
    expect(await off(), 'in the middle at first, px').toBeLessThanOrEqual(1);
    // Three frames back, by the frame itself (the row travels the other way: its window must not be scrolled with it).
    const from = (await media(page)).time;
    await frames(page).nth(3).tap();
    await expect.poll(async () => (await media(page)).time).toBeCloseTo(from - 3 / 6, 1);
    await expect.poll(async () => (await read(page)).current).toBe(6);
    expect(await off(), 'three frames back, px').toBeLessThanOrEqual(1);
    // And to a page eight seconds earlier (a whole number of frames away: the row is simply set there).
    await seekPainted(page, from - 3 / 6 - 8);
    // (A frame's name carries its time to a tenth of a second.)
    await expect.poll(async () => Math.abs(timeOf((await read(page)).names[6]) - (from - 3 / 6 - 8)), { message: 'the strip is set around the new page' }).toBeLessThan(0.11);
    expect(await off(), 'another page of the film, px').toBeLessThanOrEqual(1);
  });
});
