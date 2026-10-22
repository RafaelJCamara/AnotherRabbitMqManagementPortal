import { defineConfig } from 'vitest/config';

// The specs of the web app mount the real shell: the route table, the lazy explorer and, behind some tabs, the real
// grid in jsdom (no layout, so it renders every row it holds). Twenty files at once on a shared CI runner (three or
// four cores, with other Nx tasks running beside them) starve each other: the explorer tree spec took 5.7 s against
// vitest's 5 s default there, while the same test takes about 1 s alone. One file at a time costs nothing on a
// developer machine (the suite is about 11 s either way) and removes that contention.
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
