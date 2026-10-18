import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  // Resolve the @app/* aliases of tsconfig.base.json.
  resolve: { tsconfigPaths: true },
  test: {
    name: 'ui-platform',
    environment: 'jsdom',
    include: ['src/**/*.spec.ts'],
    setupFiles: ['src/test-setup.ts'],
  },
});
