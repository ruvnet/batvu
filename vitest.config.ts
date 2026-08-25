// SPDX-License-Identifier: MIT
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  // Resolve workspace packages to SOURCE, not dist: tests then exercise the
  // code as written rather than the last successful build, and a stale dist can
  // never make a broken change look green.
  resolve: {
    alias: {
      '@batvu/core': pkg('batvu-core'),
      '@batvu/sim': pkg('batvu-sim'),
      '@batvu/horizon/emission': fileURLToPath(
        new URL('./packages/batvu-horizon/src/emission.ts', import.meta.url),
      ),
      '@batvu/horizon': pkg('batvu-horizon'),
      '@batvu/flywheel': pkg('batvu-flywheel'),
      '@batvu/field': pkg('batvu-field'),
      '@batvu/memory': pkg('batvu-memory'),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    include: [
      'packages/*/__tests__/**/*.test.ts',
      '__tests__/**/*.test.ts',
    ],
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**'],
      exclude: ['packages/*/dist/**'],
    },
  },
});
