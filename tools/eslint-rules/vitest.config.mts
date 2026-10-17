import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: 'eslint-rules',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
