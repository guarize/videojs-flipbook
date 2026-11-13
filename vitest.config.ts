import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests run from the project root, not the workbench's Vite root.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { include: ['tests/unit/**/*.test.ts'] },
});
