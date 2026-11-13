/**
 * What the picture-in-picture companions share (session.ts, pip-captions.ts, autopip.ts, float.ts).
 *
 * Each is a small element that renders nothing of its own inside the player. They place themselves: every Flipbook
 * container on the page, now or later, gets one of each, so the skin's markup doesn't have to list them.
 * (A host that would rather list them in its markup may: `attach` skips a container that already has the tag.)
 *
 * The system's media controls (the Media Session) are one per page, while a page may hold several players: the one
 * that last played owns them. `claim` makes a container the owner; `onOwner` hears every change.
 */

import { type Feature, isOn } from './features';

const SKIN = 'media-container[data-theme="flipbook"]';
/** Each tag, and the extra it belongs to (none for the core's). */
const wanted = new Map<string, Feature | undefined>();
let observer: MutationObserver | null = null;

function fill(root: ParentNode) {
  const containers: Element[] = [];
  if (root instanceof Element && root.matches(SKIN)) containers.push(root);
  containers.push(...root.querySelectorAll(SKIN));
  for (const container of containers) {
    for (const [tag, feature] of wanted) {
      // An extra's companion only joins players that have the extra on (features.ts takes it out again if turned off).
      if (feature && !isOn(container, feature)) continue;
      if (container.querySelector(`:scope > ${tag}`)) continue;
      const element = document.createElement(tag);
      element.hidden = true;
      container.append(element);
    }
  }
}

/** Puts one `<tag>` in every Flipbook container, including containers added later; for an extra's, only where it's on. */
export function attach(tag: string, feature?: Feature) {
  if (typeof document === 'undefined') return;
  wanted.set(tag, feature);
  fill(document);
  if (observer) return;
  // An extra turned on for a player: its companion joins it.
  document.addEventListener('fb-features', (event) => {
    if (event.target instanceof Element) fill(event.target);
  });
  observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) if (node instanceof Element) fill(node);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

let owner: HTMLElement | null = null;
const listeners = new Set<(owner: HTMLElement | null) => void>();

export function claim(container: HTMLElement) {
  if (owner === container) return;
  owner = container;
  for (const listener of listeners) listener(owner);
}

/** Gives the session up, if this container holds it (it left the page). */
export function release(container: HTMLElement) {
  if (owner !== container) return;
  owner = null;
  for (const listener of listeners) listener(null);
}

export function currentOwner() {
  return owner;
}

export function onOwner(listener: (owner: HTMLElement | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether the container's film is in a picture-in-picture window, the browser's own or the Document one (pip.ts). */
export function inPip(container: Element, video: HTMLVideoElement | null) {
  return container.hasAttribute('data-fb-pip') || (!!video && document.pictureInPictureElement === video);
}
