import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  // Resolve the @app/* aliases of tsconfig.base.json.
  resolve: { tsconfigPaths: true },
  test: {
    name: 'ui-design',
    environment: 'jsdom',
    // Components are tested by the Angular builder (the test-components target): signal inputs
    // need its AOT compile. Everything else, including the token files read as text, runs here.
    include: ['src/{tokens,theme.service,index}.spec.ts'],
    setupFiles: ['src/test-setup.ts'],
    // The token specs read tokens.css and tailwind-preset.css as text (`?raw`); Vitest would
    // otherwise replace every CSS file with an empty string.
    css: { include: [/\/src\/(tokens|tailwind-preset)\.css/] },
  },
});
