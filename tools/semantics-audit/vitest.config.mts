import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: 'semantics-audit',
    environment: 'node',
    include: ['*.spec.ts'],
  },
});
