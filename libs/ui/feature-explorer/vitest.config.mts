import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  // Resolve the @app/* aliases of tsconfig.base.json.
  resolve: { tsconfigPaths: true },
  test: {
    name: 'feature-explorer',
    environment: 'jsdom',
    // Pages and components are tested by the Angular builder (the test-components target): signal
    // inputs need its AOT compile. Plain logic (columns, models) runs here.
    setupFiles: ['src/test-setup.ts'],
    include: ['src/**/*.spec.ts'],
    exclude: [
      'src/**/*.component.spec.ts',
      'src/**/{inventory-page,filter-bar,freshness-banner,views-control,overview,capability-card,explorer-requests,explorer-i18n,entity-page,entity-tabs,entity-routing,queue-charts,forecast-panel,cluster-trends}.spec.ts',
      '**/node_modules/**',
    ],
  },
});
