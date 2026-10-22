import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  // Resolve the @app/* aliases of tsconfig.base.json: the specs here wire real libraries together.
  resolve: { tsconfigPaths: true },
  test: {
    name: 'engine',
    environment: 'node',
    globals: true,
    include: ['src/**/*.spec.ts'],
    // Most specs here compose a whole engine (a SQLite file, a vault, a router, a listener). That takes
    // under a second on a developer machine and more than five on a Windows runner that is also
    // running the other projects' tests, so the default 5 s limit made them fail on load, not on
    // behaviour. Nothing asserts on these durations; the limit only stops a hung test.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The bundle smoke runs as the target engine:smoke, against dist/.
    exclude: ['src/**/*.smoke.spec.ts'],
  },
});
