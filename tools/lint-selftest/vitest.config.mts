import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: 'lint-selftest',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // The first ESLint run reads the Nx project graph.
    testTimeout: 60_000,
  },
});
