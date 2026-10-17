import { defineConfig } from 'vitest/config';

// The end-to-end proof copies the workspace, runs `nx g` for every generator and then lints,
// typechecks and tests what they made, so it needs far more time than a unit test.
export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: 'generators-e2e',
    environment: 'node',
    include: ['e2e/**/*.spec.ts'],
    testTimeout: 900_000,
    hookTimeout: 600_000,
  },
});
