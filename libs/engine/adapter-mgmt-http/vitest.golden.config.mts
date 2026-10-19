import { defineConfig } from 'vitest/config';

// The golden-fixture specs (M0-25, `pnpm nx run adapter-mgmt-http:test-golden`): the committed
// answers of real brokers (testing/fixtures) are replayed through the real client. They need no
// Docker daemon; only recording them does (`record-golden`).
export default defineConfig({
  root: import.meta.dirname,
  // Resolve the @app/* aliases of tsconfig.base.json.
  resolve: { tsconfigPaths: true },
  test: {
    name: 'adapter-mgmt-http-golden',
    environment: 'node',
    include: ['golden/**/*.spec.ts'],
    // Each recording replays about fifty requests over real sockets.
    testTimeout: 120_000,
  },
});
