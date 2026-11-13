import type { Plugin } from 'postcss';

/** The skin's cascade layers under names of its own (see layers.mjs). */
export function layersPlugin(options?: { within?: string | null }): Plugin;
export function layersCss(css: string, file?: string): string;
export const PREFIX: string;
export const UNDER: string[];
export const ORDER: string[];
