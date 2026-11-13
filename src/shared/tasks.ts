/**
 * Keeping work out of one long task. A player connected in a single task costs tens of milliseconds of script before
 * the page can draw again; these let each part of that work have a task of its own.
 */

/** Resolves in a new task, ahead of other queued work where the browser can (`scheduler.yield`). */
export const nextTask = (): Promise<void> => {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
};

/**
 * Runs `run` each time fonts finish loading, for whatever measured text set in a fallback face. In place of
 * `document.fonts.ready`: that getter brings style and layout up to date before it answers, so asked for while a tree
 * is being connected it lays the whole new tree out inside that task (28 ms for the Flipbook player, measured), and
 * it answers once, for the fonts wanted at that moment only. The event costs nothing until a font arrives.
 */
export const onFontsLoaded = (run: () => void, signal?: AbortSignal): void => {
  if (typeof document === 'undefined' || !document.fonts) return;
  document.fonts.addEventListener('loadingdone', run, { signal });
};
