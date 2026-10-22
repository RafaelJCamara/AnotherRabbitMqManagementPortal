import { defineConfig } from 'vitest/config';

// The component specs of the command palette (`test-components`), one file at a time: each mounts real
// components in jsdom, and parallel mounts on a shared CI runner starve each other (see the explorer's
// `vitest.components.config.mts`).
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
