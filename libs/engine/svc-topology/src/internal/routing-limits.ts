// The limits the routing actions hand to @app/routing. They keep every list of an answer inside the
// maximum its contract states (I-7), and the library counts what each one cut (I-13). The defaults of
// the library are larger, because a library has no contract to fit.
import type { DlxLimitOptions } from '@app/routing';

/** Queues and paths of one simulation: at most 1,000 queues and 2 paths to each. */
export const SIMULATION_LIMITS = {
  maxQueues: 1_000,
  maxPathsPerQueue: 2,
} as const satisfies DlxLimitOptions;

/** The dead-letter walk: 64 paths, 500 steps, 200 candidates of a hash or random exchange, 16 loops. */
export const DEAD_LETTER_LIMITS = {
  ...SIMULATION_LIMITS,
  maxDlxPaths: 64,
  maxDlxSteps: 500,
  maxDlxCandidates: 200,
  maxDlxLoops: 16,
} as const satisfies DlxLimitOptions;

/** The scan for sources: up to 10,000 queues examined as sources. */
export const SOURCES_LIMITS = {
  ...SIMULATION_LIMITS,
  maxDlxSourcesScanned: 10_000,
  maxDlxCandidates: 200,
} as const satisfies DlxLimitOptions;
