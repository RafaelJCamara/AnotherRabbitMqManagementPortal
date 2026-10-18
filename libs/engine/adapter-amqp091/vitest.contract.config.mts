import { defineConfig } from 'vitest/config';

// The AMQP 0-9-1 contract suite (M0-28): every spec in contract/ runs once per client library
// against one lab broker. Started by libs/testkit/src/it/run-contract.ts
// (`pnpm nx run adapter-amqp091:contract --broker=all`), which sets CONTRACT_BROKER_VERSION; the
// global setup starts the broker, so this is not part of `nx test` (it needs a Docker daemon).
export default defineConfig({
  root: import.meta.dirname,
  // Resolve the @app/* aliases of tsconfig.base.json.
  resolve: { tsconfigPaths: true },
  test: {
    name: 'adapter-amqp091-contract',
    environment: 'node',
    include: ['contract/**/*.contract.spec.ts'],
    globalSetup: ['../../testkit/src/it/contract-broker.setup.ts'],
    // The specs share one broker and some of them raise a broker-wide alarm or close every
    // connection, so the files run one after the other.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 600_000,
  },
});
