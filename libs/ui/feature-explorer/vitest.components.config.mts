import { defineConfig } from 'vitest/config';

// The component specs of the explorer (`test-components`). Each file mounts the real grid in jsdom, which has no
// layout and renders every row it holds, so two of them at once on a shared CI runner (macOS arm64 has three
// cores) starve each other: the 20,000-row page spec and the views spec both timed out there while passing alone.
// One file at a time costs a few seconds on a developer machine and removes that contention.
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
