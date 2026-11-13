import type { BrowserContext } from '@playwright/test';

export const SILENT_FILM: string;
export const MARK: string;
export function silence(context: BrowserContext): Promise<void>;
export const REAL_STREAM: boolean;
export function mute(context: BrowserContext): Promise<void>;
