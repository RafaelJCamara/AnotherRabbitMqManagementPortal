// One turn of the event loop (I-5). The yield is injected where it is used, so a spec can count the
// turns instead of timing them.
import { setImmediate as nextTurn } from 'node:timers/promises';

/** Lets the event loop run once. */
export type YieldNow = () => Promise<void>;

/** One turn of the event loop (`setImmediate`): timers, I/O and other requests get to run. */
export const nextLoopTurn: YieldNow = async () => {
  await nextTurn();
};
