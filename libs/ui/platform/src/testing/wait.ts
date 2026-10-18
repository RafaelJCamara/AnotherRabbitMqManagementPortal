// Waiting helpers for specs that cross a real MessagePort or a promise chain.
export const tick = (ms = 0): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `condition` between macrotasks; fails the spec with `what` after `limit` rounds. */
export async function waitFor(
  condition: () => boolean,
  what = 'the condition',
  limit = 200,
): Promise<void> {
  for (let round = 0; round < limit; round += 1) {
    if (condition()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${what}`);
}
