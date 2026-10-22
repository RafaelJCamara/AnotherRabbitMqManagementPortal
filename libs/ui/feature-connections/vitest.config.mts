import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  // Resolve the @app/* aliases of tsconfig.base.json.
  resolve: { tsconfigPaths: true },
  test: {
    name: 'feature-connections',
    environment: 'jsdom',
    // Components are tested by the Angular builder (the test-components target): signal inputs need its AOT
    // compile. Plain logic (the form model, the capability model, the Problem view) runs here.
    setupFiles: ['src/test-setup.ts'],
    include: ['src/**/*.spec.ts'],
    exclude: ['src/**/*.component.spec.ts', '**/node_modules/**'],
  },
});
