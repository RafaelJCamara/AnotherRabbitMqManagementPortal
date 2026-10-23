import { defineConfig } from 'vitest/config';

// `engine:smoke`: the built bundle, run as a process (it needs `nx build engine` first, which the
// target depends on). One file per bundle, not per module, so the specs run one after another.
export default defineConfig({
  root: import.meta.dirname,
  // The capture worker smoke spec wires real libraries (the testkit's capture stack) to the built worker.
  resolve: { tsconfigPaths: true },
  test: {
    name: 'engine-smoke',
    environment: 'node',
    globals: true,
    include: ['src/**/*.smoke.spec.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
