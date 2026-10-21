import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  // Resolve the @app/* aliases of tsconfig.base.json.
  resolve: { tsconfigPaths: true },
  test: {
    name: 'semantics-evidence',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // Every test makes a real git repository in a temporary folder (several `git` processes in
    // `beforeEach`) and runs the CLI against it. On a loaded Windows runner one `git` call took
    // seconds, so the default 10 s hook limit failed the first two tests of `cli.spec.ts` while the
    // tests that set 60 s themselves passed. The limits are generous, not removed.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
