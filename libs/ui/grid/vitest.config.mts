import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  // Resolve the @app/* aliases of tsconfig.base.json.
  resolve: { tsconfigPaths: true },
  test: {
    name: 'ui-grid',
    environment: 'jsdom',
    // Components are tested by the Angular builder (the test-components target): signal inputs
    // need its AOT compile. Everything else runs here.
    setupFiles: ['src/test-setup.ts'],
    include: ['src/**/*.spec.ts'],
    exclude: ['src/**/*.component.spec.ts', '**/node_modules/**'],
  },
});
