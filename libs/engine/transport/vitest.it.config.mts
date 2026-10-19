import { defineConfig } from 'vitest/config';

// Integration tests: a real listener on 127.0.0.1 and real WebSocket clients (M0-33). Run through
// `nx run transport:it`; `--testNamePattern=live` selects the live endpoint.
export default defineConfig({
  root: import.meta.dirname,
  resolve: { tsconfigPaths: true },
  test: {
    name: 'transport-it',
    environment: 'node',
    include: ['src/testing/**/*.it.ts'],
    testTimeout: 15_000,
  },
});
