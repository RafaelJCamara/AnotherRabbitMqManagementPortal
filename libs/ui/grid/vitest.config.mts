import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  // Resolve the @app/* aliases of tsconfig.base.json.
  resolve: { tsconfigPaths: true },
  test: {
    name: 'ui-grid',
    environment: 'jsdom',
    include: ['src/**/*.spec.ts'],
  },
});
