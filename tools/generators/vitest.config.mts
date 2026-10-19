import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: 'generators',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // Every test builds a workspace tree and formats what it writes with Prettier; the first one
    // in a file loads the Nx and TypeScript machinery, which takes several seconds on a slow runner.
    testTimeout: 30_000,
  },
});
