import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  // Resolve the @app/* aliases of tsconfig.base.json.
  resolve: { tsconfigPaths: true },
  test: {
    name: 'ui-commands',
    environment: 'jsdom',
    // The host, the palette and the cheat sheet are tested by the Angular builder (the test-components
    // target): signal inputs need its AOT compile. The registry, keymap and plain logic run here.
    setupFiles: ['src/test-setup.ts'],
    include: ['src/**/*.spec.ts'],
    exclude: ['src/**/*.component.spec.ts', '**/node_modules/**'],
  },
});
