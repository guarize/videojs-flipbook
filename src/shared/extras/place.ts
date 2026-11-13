/**
 * The place a viewer stopped at, as <x-resume> keeps it (resume.ts): pure, so it can be tested without a browser.
 */

/** Positions this close to either end aren't worth offering. */
export const EDGE = 5;
/** A place belongs to the film it was saved for: one of the same length, within a frame (at 24 a second, and a hair). */
const SAME_LENGTH = 0.05;

/** A place as it is kept: the second they stopped at, and the length of the film it was in. */
export interface Place {
  t: number;
  d: number;
}

/** A kept place, or null for anything else (a bare number from before the length was kept, or someone else's value). */
export function readPlace(raw: string | null): Place | null {
  if (!raw?.startsWith('{')) return null;
  try {
    const { t, d } = JSON.parse(raw) as Partial<Place>;
    return typeof t === 'number' && typeof d === 'number' && t > 0 && d > 0 ? { t, d } : null;
  } catch {
    return null;
  }
}

/** Whether a kept place is a place in this film: the same length, and far enough from both ends to be worth offering. */
export function placeFits(place: Place, duration: number): boolean {
  return Math.abs(place.d - duration) <= SAME_LENGTH && place.t >= EDGE && place.t <= duration - EDGE;
}
