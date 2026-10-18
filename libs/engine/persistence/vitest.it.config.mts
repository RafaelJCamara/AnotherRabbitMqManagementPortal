import { defineConfig } from 'vitest/config';

// Integration tests: real files and, for Postgres, Docker containers. Run through
// `nx run persistence:it`, which sets PERSISTENCE_IT_DIALECTS and PERSISTENCE_IT_PG_VERSIONS.
export default defineConfig({
  root: import.meta.dirname,
  resolve: { tsconfigPaths: true },
  test: {
    name: 'persistence-it',
    environment: 'node',
    include: ['src/it/**/*.it.ts'],
    // Pulling an image and booting Postgres is slow on a cold machine.
    hookTimeout: 240_000,
    testTimeout: 60_000,
    fileParallelism: false,
  },
});
