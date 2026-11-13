import { findMedia, videoOf } from '../storyboard';
import { text } from './i18n';

/**
 * Fine scrubbing, as iOS has had for years and web players don't: while dragging the seek bar, move up away from it
 * and the scrub slows (full, half, quarter, fine), so a long video can be placed to the second. Pressing on the bar
 * still jumps to that point; moving up only changes how far a sideways move travels.
 *
 * It takes over pointer drags on a `media-time-slider[data-x-fine-scrub]` (keyboard seeking is untouched) and pauses
 * the picture and its sound while the bar is held, so scrubbing never stutters. It reports to the skin through
 * `data-x-scrubbing`, `data-x-scrub-rate`, `--x-scrub-y` and any `[data-x-part="scrub-rate"]` label inside.
 */

/** Rates by distance above the bar, in CSS pixels. */
const LANES = [
  { from: 0, rate: 1, label: 'scrubFull' },
  { from: 48, rate: 0.5, label: 'scrubHalf' },
  { from: 96, rate: 0.25, label: 'scrubQuarter' },
  { from: 144, rate: 0.1, label: 'scrubFine' },
] as const;

/** Seeks while dragging are throttled: the bar follows the pointer every frame, the picture catches up. */
const SEEK_EVERY = 50;

const attached = new WeakSet<HTMLElement>();

function attach(slider: HTMLElement) {
  if (attached.has(slider)) return;
  attached.add(slider);

  slider.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !event.isPrimary) return;
    const container = slider.closest('media-container');
    const video = videoOf(container ? findMedia(container) : null);
    if (!video || !Number.isFinite(video.duration) || !video.duration) return;

    // The slider would start its own drag; this one replaces it.
    event.preventDefault();
    event.stopImmediatePropagation();
    slider.setPointerCapture(event.pointerId);

    const box = slider.getBoundingClientRect();
    const duration = video.duration;
    const resume = !video.paused;
    if (resume) video.pause();

    const clamp = (t: number) => Math.max(0, Math.min(duration, t));
    let anchorX = event.clientX;
    let anchorTime = clamp(((event.clientX - box.left) / box.width) * duration);
    let rate = 1;
    let target = anchorTime;
    let lastSeek = 0;
    let frame = 0;
    const labels = slider.querySelectorAll<HTMLElement>('[data-x-part="scrub-rate"]');

    const seek = (force = false) => {
      const now = performance.now();
      if (!force && now - lastSeek < SEEK_EVERY) return;
      lastSeek = now;
      video.currentTime = target;
    };

    const report = (y: number) => {
      slider.style.setProperty('--x-scrub-y', `${Math.max(0, y)}px`);
      const lane = [...LANES].reverse().find((l) => y >= l.from) ?? LANES[0];
      if (lane.rate !== rate) {
        // Re-anchor where the rate changes, so the playhead never jumps.
        anchorX = lastX;
        anchorTime = target;
        rate = lane.rate;
      }
      slider.dataset.xScrubRate = String(rate);
      const label = text(lane.label);
      for (const node of labels) if (node.textContent !== label) node.textContent = label;
    };

    let lastX = event.clientX;
    slider.toggleAttribute('data-x-scrubbing', true);
    report(0);
    seek(true);

    const move = (e: PointerEvent) => {
      lastX = e.clientX;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        report(box.top - e.clientY);
        target = clamp(anchorTime + ((lastX - anchorX) / box.width) * duration * rate);
        seek();
      });
    };

    const end = () => {
      cancelAnimationFrame(frame);
      slider.removeEventListener('pointermove', move);
      slider.removeEventListener('pointerup', end);
      slider.removeEventListener('pointercancel', end);
      seek(true);
      slider.toggleAttribute('data-x-scrubbing', false);
      delete slider.dataset.xScrubRate;
      slider.style.removeProperty('--x-scrub-y');
      if (resume) video.addEventListener('seeked', () => void video.play(), { once: true });
    };

    slider.addEventListener('pointermove', move);
    slider.addEventListener('pointerup', end);
    slider.addEventListener('pointercancel', end);
  }, { capture: true });
}

function scan(root: ParentNode) {
  for (const slider of root.querySelectorAll<HTMLElement>('media-time-slider[data-x-fine-scrub]')) attach(slider);
}

// Skins render their template after this module loads: watch for sliders as they arrive.
scan(document);
new MutationObserver((records) => {
  for (const record of records) {
    for (const node of record.addedNodes) if (node instanceof Element) scan(node.parentNode ?? node);
  }
}).observe(document.documentElement, { childList: true, subtree: true });
