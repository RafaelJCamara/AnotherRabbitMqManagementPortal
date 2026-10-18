import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  // Resolve the @app/* aliases of tsconfig.base.json.
  resolve: { tsconfigPaths: true },
  test: {
    name: 'adapter-amqp091',
    environment: 'node',
    // The broker-backed contract specs (`*.contract.spec.ts`) run through vitest.contract.config.mts.
    include: ['src/**/*.spec.ts', 'contract/**/*.unit.spec.ts'],
  },
});
