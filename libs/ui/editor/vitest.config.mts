import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  // Resolve the @app/* aliases of tsconfig.base.json.
  resolve: { tsconfigPaths: true },
  test: {
    name: 'ui-editor',
    environment: 'jsdom',
    setupFiles: ['src/test-setup.ts'],
    // Components are tested by the Angular builder (the test-components target): signal inputs
    // need its AOT compile. Everything else runs here.
    include: ['src/**/*.spec.ts'],
    exclude: [
      'src/**/{code-editor.component,diff-editor.component,schema,theme-bridge}.spec.ts',
      '**/node_modules/**',
    ],
  },
});
