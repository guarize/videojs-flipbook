import type { Plugin } from 'postcss';

/** `@scope` written out as plain selectors of the same weight (see unscope.mjs). */
export function unscopePlugin(): Plugin;
export function unscopeCss(css: string): string;
export function splitSelectors(list: string): string[];
