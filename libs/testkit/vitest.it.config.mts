import { defineConfig } from 'vitest/config';

// Integration tests against real lab brokers (run through src/it/run-it.ts, for example
// "pnpm nx run net-dialer:it --versions=4.3.6"). They are not part of "nx test": they need a
// Docker daemon.
export default defineConfig({
  root: import.meta.dirname,
  // Resolve the @app/* aliases of tsconfig.base.json.
  resolve: { tsconfigPaths: true },
  test: {
    name: 'testkit-it',
    environment: 'node',
    include: ['src/it/**/*.it.ts'],
    testTimeout: 120_000,
    hookTimeout: 600_000,
  },
});
