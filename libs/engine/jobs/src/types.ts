// The types of the job layer (ADR-015, core-interfaces.md "Jobs"). Where this file differs from
// core-interfaces.md, the open questions OQ-310 to OQ-319 say why.
import type { JobId, WarningRef } from '@app/contracts';
import type { ExecutorWrite } from '@app/kernel';
import type { JobRecord, JobState, Principal, ReplayJournal } from '@app/ports';
import type { z } from 'zod';

export type { JobRecord, JobState };

export type JobEvent =
  | { kind: 'progress'; done: number; total?: number; note?: string }
  | { kind: 'warning'; warning: WarningRef }
  /** The job asks to be paused (a broker alarm, a person's decision): the runner parks and stops it. */
  | { kind: 'paused'; reason: string }
  | { kind: 'checkpoint' };

/** Why a running job is asked to stop (a pause asks with `suspend`). */
export type JobStopReason = 'cancel' | 'shutdown' | 'suspend' | 'emergency';

/** A token bucket: `perSec` tokens a second, up to `burst` at once. */
export interface JobThrottle {
  perSec: number;
  /** Default: `perSec`, at least 1. */
  burst?: number;
}

export interface JobContext<I, C> {
  readonly jobId: JobId;
  readonly input: I;
  /** The last checkpoint the job saved, when it is resuming. */
  readonly checkpoint?: C;
  /** The job's own principal: kind `job`, acting for whoever submitted it. */
  readonly principal: Principal;
  /** Aborted when the job is asked to stop, or when it loses its lease. */
  readonly signal: AbortSignal;
  /** Stores a checkpoint. Rejects once the job has lost its lease or has been settled. */
  save(checkpoint: C): Promise<void>;
  readonly journal: ReplayJournal;
  /** Waits for `n` tokens (default 1); rejects when `signal` aborts. */
  readonly throttle: {
    take(n?: number, signal?: AbortSignal): Promise<void>;
  };
  /** The role-typed connection leases (I-2: reached from a job body only). */
  readonly leases: ExecutorWrite['connections'];
  /** The write-capable ports, handed to a job and to nothing else (I-2). */
  readonly executorWrite: ExecutorWrite;
}

/** What `preflight` sees: no write capability, because it runs before a resume is allowed. */
export interface JobPreflightContext<I, C> {
  readonly jobId: JobId;
  readonly input: I;
  readonly checkpoint?: C;
  readonly principal: Principal;
  readonly signal: AbortSignal;
}

export type JobPreflight = { ok: true } | { ok: false; reason: string };

export interface JobDef<I = unknown, C = unknown, O = unknown> {
  /** `module.verb`, lower case: `replay.run`. */
  readonly type: string;
  /** A stored job of another version is failed, not guessed at. */
  readonly version: number;
  readonly input: z.ZodType<I>;
  readonly checkpoint: z.ZodType<C>;
  readonly output: z.ZodType<O>;
  /** May a team server resume it by itself after an interruption (idempotent semantics)? */
  readonly resumable: boolean;
  concurrencyKey?(input: I): string;
  throttle?(input: I): JobThrottle;
  /** Runs before every resume, by a person or by the runner. A throw or `ok: false` blocks it. */
  preflight?(ctx: JobPreflightContext<I, C>): Promise<JobPreflight>;
  run(ctx: JobContext<I, C>): AsyncGenerator<JobEvent, O, void>;
  /**
   * Called when the job is asked to stop, while `run` may still be going. It MUST park or flush
   * what the job holds (settle deliveries, wait for confirms) and checkpoint, within `deadlineMs`
   * milliseconds. `pause` calls it with `suspend`.
   */
  onDrain(
    ctx: JobContext<I, C>,
    reason: JobStopReason,
    deadlineMs: number,
  ): Promise<void>;
}

export type JobCommand = 'pause' | 'resume' | 'cancel';

/** How a job's `onDrain` ended; `skipped` when the job had not started or had already finished. */
export type OnDrainOutcome = 'ok' | 'timeout' | 'error' | 'skipped';

export interface JobDrainEntry {
  readonly jobId: JobId;
  readonly type: string;
  /** The state the job was left in. */
  readonly state: JobState;
  readonly onDrain: OnDrainOutcome;
  readonly ms: number;
}

export interface JobRecoveryReport {
  /** Running jobs that became `paused-interrupted`. */
  readonly interrupted: number;
  /** Interrupted jobs the runner queued again by itself. */
  readonly resumed: number;
  /** Interrupted jobs a preflight blocked. */
  readonly blocked: number;
}

export interface JobRunnerStats {
  readonly running: number;
  readonly accepting: boolean;
  readonly draining: boolean;
}
