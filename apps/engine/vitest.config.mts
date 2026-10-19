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
    // The bundle smoke runs as the target engine:smoke, against dist/.
    exclude: ['src/**/*.smoke.spec.ts'],
  },
});
