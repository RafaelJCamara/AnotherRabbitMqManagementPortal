import { defineConfig } from 'vitest/config';

// The perf harnesses (`pnpm nx run perf:explorer-20k`). They measure time, so they are not part of
// `nx test` (a loaded CI machine would make a unit-test run flaky): each has its own target.
export default defineConfig({
  root: import.meta.dirname,
  // Resolve the @app/* aliases of tsconfig.base.json.
  resolve: { tsconfigPaths: true },
  test: {
    name: 'perf-harness',
    environment: 'node',
    include: ['src/**/*.perf.ts'],
    testTimeout: 900_000,
    // One file at a time and no worker threads sharing the CPU with the measurement.
    fileParallelism: false,
  },
});
