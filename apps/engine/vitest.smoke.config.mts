import { defineConfig } from 'vitest/config';

// `engine:smoke`: the built bundle, run as a process (it needs `nx build engine` first, which the
// target depends on). One file per bundle, not per module, so the specs run one after another.
export default defineConfig({
  root: import.meta.dirname,
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
