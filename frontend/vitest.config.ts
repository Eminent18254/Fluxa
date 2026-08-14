/**
 * Vitest, kept separate from `vite.config.ts`.
 *
 * The app's build config has no business importing from `vitest/config` — that
 * would make a production build depend on the test runner being installed. The
 * only thing the two files must agree on is the `@/` alias, since every module
 * under test imports through it.
 *
 * `environment: 'node'` because the data layer is the part of this app that has no
 * DOM in it. When component tests arrive they get their own project entry with
 * jsdom; making everything jsdom now would slow down the suite that exists to pay
 * for the suite that does not.
 */
import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
