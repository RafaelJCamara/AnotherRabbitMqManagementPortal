import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: 'engine',
    environment: 'node',
    globals: true,
    include: ['src/**/*.spec.ts'],
  },
});
