import { defineConfig } from 'vitest/config';

// The component specs of the connections feature (`test-components`). Each mounts real pages in jsdom; two
// files at once on a shared CI runner starved each other in the explorer (M0-54), so one file at a time.
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
