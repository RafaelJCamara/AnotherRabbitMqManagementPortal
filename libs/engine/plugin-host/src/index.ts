// @app/plugin-host: the tier-1 worker pool (M1-10, blueprint 11). Tier 3 (the QuickJS sandbox) is
// a later work package and lives here too.
export { createWorkerPool } from './pool.ts';
export { REJECT_REASONS } from './types.ts';
export type {
  PoolEvent,
  PoolOutcome,
  PoolStats,
  RejectReason,
  RunOptions,
  WorkerPool,
  WorkerPoolOptions,
} from './types.ts';
