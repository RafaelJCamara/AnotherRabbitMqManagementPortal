import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: 'api-docs',
    environment: 'node',
    include: ['*.spec.ts'],
  },
});
