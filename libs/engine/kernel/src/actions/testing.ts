// Test support for the action layer: in-memory repositories, an audit sink that can fail, a
// cipher, write ports that throw, and the plan-purity check (blueprint 2.2, "Plan purity").
// Exported from @app/kernel so the testkit (M0-35), the architecture tests and service specs share
// one set. None of it belongs in a production composition root.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { ActionId, PlanId, ReceiptId } from '@app/contracts';
import type {
  AuditRepository,
  AuditRow,
  IdempotencyRepository,
  PlanPatch,
  PlanRecord,
  PlanRepository,
  Principal,
  ReceiptRecord,
  ReceiptRepository,
} from '@app/ports';

import { createAuditChain, type AuditChain } from '../audit/chain.ts';
import { createManualClock, type ManualClock } from '../clock/clock.ts';
import {
  createGuardrails,
  type ArmingControl,
  type Guardrails,
} from '../guardrails/policy.ts';
import { createIdGenerator } from '../ids/ids.ts';
import { createReceiptStore, type ReceiptStore } from '../receipts/store.ts';
import { allowUiPrincipals } from './authorizer.ts';
import {
  createActionExecutor,
  type ActionExecutor,
  type ActionExecutorOptions,
} from './executor.ts';
import type {
  AuditEntry,
  AuditOutcome,
  AuditSink,
  ExecutionRecord,
  ReceiptSink,
} from './hooks.ts';
import {
  createPlanStore,
  type PayloadCipher,
  type PlanStore,
  type PlanStoreOptions,
} from './plan-store.ts';
import type {
  ActionContext,
  ActionImpl,
  ExecutorContext,
  ExecutorWrite,
} from './types.ts';

// ---------------------------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------------------------

const LIVE_STATES = new Set(['open', 'awaiting-approval', 'approved']);
const FINISHED_STATES = new Set(['executed', 'failed', 'expired', 'rejected']);

export function createMemoryPlanRepository(): PlanRepository {
  const rows = new Map<PlanId, PlanRecord>();
  return {
    insert(record) {
      if (rows.has(record.id))
        return Promise.reject(new Error('Duplicate plan id.'));
      rows.set(record.id, record);
      return Promise.resolve();
    },
    get: (id) => Promise.resolve(rows.get(id)),
    update(id, expectedVersion, patch: PlanPatch, now) {
      const current = rows.get(id);
      if (current?.version !== expectedVersion)
        return Promise.resolve(undefined);
      const next: PlanRecord = {
        ...current,
        ...(patch.state === undefined ? {} : { state: patch.state }),
        ...(patch.approvals === undefined
          ? {}
          : { approvals: patch.approvals }),
        ...(patch.payload === undefined ? {} : { payload: patch.payload }),
        ...(patch.expiresAt === undefined
          ? {}
          : { expiresAt: patch.expiresAt }),
        updatedAt: now,
        version: current.version + 1,
      };
      rows.set(id, next);
      return Promise.resolve(next);
    },
    countActive(principalId, now) {
      let count = 0;
      for (const row of rows.values()) {
        if (
          row.principalId === principalId &&
          row.expiresAt > now &&
          (LIVE_STATES.has(row.state) || row.state === 'executing')
        ) {
          count += 1;
        }
      }
      return Promise.resolve(count);
    },
    expireDue(now, limit) {
      let changed = 0;
      for (const [id, row] of rows) {
        if (changed >= limit) break;
        if (LIVE_STATES.has(row.state) && row.expiresAt <= now) {
          rows.set(id, {
            ...row,
            state: 'expired',
            payload: null,
            updatedAt: now,
            version: row.version + 1,
          });
          changed += 1;
        }
      }
      return Promise.resolve(changed);
    },
    purgeBefore(cutoff, limit) {
      let removed = 0;
      for (const [id, row] of rows) {
        if (removed >= limit) break;
        if (FINISHED_STATES.has(row.state) && row.updatedAt < cutoff) {
          rows.delete(id);
          removed += 1;
        }
      }
      return Promise.resolve(removed);
    },
  };
}

export function createMemoryIdempotencyRepository(): IdempotencyRepository {
  const rows = new Map<string, { at: number; actionId: ActionId }>();
  const keyOf = (principalId: string, key: string): string =>
    `${principalId}\u0000${key}`;
  return {
    claim(principalId, key, info) {
      const id = keyOf(principalId, key);
      if (rows.has(id)) return Promise.resolve(false);
      rows.set(id, { at: info.at, actionId: info.actionId });
      return Promise.resolve(true);
    },
    has: (principalId, key) =>
      Promise.resolve(rows.has(keyOf(principalId, key))),
    purgeBefore(cutoff) {
      let removed = 0;
      for (const [id, row] of rows) {
        if (row.at < cutoff) {
          rows.delete(id);
          removed += 1;
        }
      }
      return Promise.resolve(removed);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------------------------

export interface MemoryAuditSink extends AuditSink {
  readonly attempts: readonly AuditEntry[];
  readonly outcomes: readonly AuditOutcome[];
  /** Makes `attempt` (and so every audited action) fail from now on. */
  failAttempts(on: boolean): void;
  failOutcomes(on: boolean): void;
}

export function createMemoryAuditSink(): MemoryAuditSink {
  const attempts: AuditEntry[] = [];
  const outcomes: AuditOutcome[] = [];
  let failAttempt = false;
  let failOutcome = false;
  let seq = 0;
  return {
    attempts,
    outcomes,
    failAttempts: (on) => {
      failAttempt = on;
    },
    failOutcomes: (on) => {
      failOutcome = on;
    },
    attempt(entry) {
      if (failAttempt) return Promise.reject(new Error('audit store is down'));
      attempts.push(entry);
      seq += 1;
      return Promise.resolve(seq);
    },
    outcome(entry) {
      if (failOutcome) return Promise.reject(new Error('audit store is down'));
      outcomes.push(entry);
      return Promise.resolve();
    },
  };
}

/**
 * An audit repository in memory. `rows` is the live store, so a spec can edit, drop or reorder a
 * row behind the chain's back; `failAppends` makes the next appends reject, as a dead disk would.
 */
export interface MemoryAuditRepository extends AuditRepository {
  readonly rows: AuditRow[];
  failAppends(on: boolean): void;
  /** Runs before every `append`, for specs that race two writers. */
  beforeAppend: (() => Promise<void>) | undefined;
}

export function createMemoryAuditRepository(): MemoryAuditRepository {
  const rows: AuditRow[] = [];
  let failing = false;
  const repository: MemoryAuditRepository = {
    rows,
    beforeAppend: undefined,
    failAppends(on) {
      failing = on;
    },
    head() {
      const last = rows.at(-1);
      return Promise.resolve(
        last === undefined ? undefined : { seq: last.seq, hash: last.hash },
      );
    },
    async append(row) {
      await repository.beforeAppend?.();
      if (failing) throw new Error('audit store is down');
      if (
        rows.some(
          (have) => have.seq === row.seq || have.prevHash === row.prevHash,
        )
      ) {
        return false;
      }
      rows.push(row);
      return true;
    },
    window(afterSeq, limit) {
      return Promise.resolve(
        [...rows]
          .sort((a, b) => a.seq - b.seq)
          .filter((row) => row.seq > afterSeq)
          .slice(0, Math.max(1, Math.min(limit, 1000))),
      );
    },
  };
  return repository;
}

export interface MemoryReceiptRepository extends ReceiptRepository {
  readonly rows: Map<string, ReceiptRecord>;
  failInserts(on: boolean): void;
}

export function createMemoryReceiptRepository(): MemoryReceiptRepository {
  const rows = new Map<string, ReceiptRecord>();
  let failing = false;
  return {
    rows,
    failInserts(on) {
      failing = on;
    },
    insert(record) {
      if (failing) return Promise.reject(new Error('receipt store is down'));
      if (rows.has(record.id))
        return Promise.reject(new Error('Duplicate receipt id.'));
      rows.set(record.id, record);
      return Promise.resolve();
    },
    get: (id) => Promise.resolve(rows.get(id)),
    purgeBefore(cutoff, limit) {
      let removed = 0;
      for (const [id, row] of rows) {
        if (removed >= limit) break;
        if (row.createdAt < cutoff) {
          rows.delete(id);
          removed += 1;
        }
      }
      return Promise.resolve(removed);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Cipher
// ---------------------------------------------------------------------------------------------

/** Real AES-256-GCM under a random key that lives and dies with the process. Tests only. */
export function createAesGcmTestCipher(
  key: Uint8Array = randomBytes(32),
): PayloadCipher {
  return {
    encrypt(plaintext, aad) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(aad, 'utf8'));
      const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Promise.resolve(
        new Uint8Array(Buffer.concat([iv, cipher.getAuthTag(), body])),
      );
    },
    decrypt(ciphertext, aad) {
      try {
        const buffer = Buffer.from(ciphertext);
        const decipher = createDecipheriv(
          'aes-256-gcm',
          key,
          buffer.subarray(0, 12),
        );
        decipher.setAAD(Buffer.from(aad, 'utf8'));
        decipher.setAuthTag(buffer.subarray(12, 28));
        return Promise.resolve(
          new Uint8Array(
            Buffer.concat([
              decipher.update(buffer.subarray(28)),
              decipher.final(),
            ]),
          ),
        );
      } catch (cause) {
        return Promise.reject(
          cause instanceof Error ? cause : new Error('decryption failed'),
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Write ports that throw
// ---------------------------------------------------------------------------------------------

export class WriteDuringPlanError extends Error {
  constructor(port: string) {
    super(`${port} was called while planning; plan() reads only.`);
    this.name = 'WriteDuringPlanError';
  }
}

export interface WriteTrap {
  /** Write ports in which every method call throws `WriteDuringPlanError` and is recorded. */
  readonly writes: ExecutorWrite;
  /** Every `port.method` that was called, even when the caller swallowed the error. */
  readonly calls: readonly string[];
}

function trapped(port: string, calls: string[]): object {
  return new Proxy(
    {},
    {
      get(_target, property) {
        // `await`, JSON and inspection probe these; they are not calls on the port.
        if (typeof property === 'symbol' || property === 'then')
          return undefined;
        return () => {
          calls.push(`${port}.${property}`);
          throw new WriteDuringPlanError(`${port}.${property}`);
        };
      },
    },
  );
}

export function createWriteTrap(): WriteTrap {
  const calls: string[] = [];
  return {
    calls,
    writes: {
      mgmt: trapped('mgmt', calls) as ExecutorWrite['mgmt'],
      connections: trapped(
        'connections',
        calls,
      ) as ExecutorWrite['connections'],
    },
  };
}

/** Write ports that succeed and remember what was asked, for specs that need an action to run. */
export function createRecordingWrites(): {
  writes: ExecutorWrite;
  calls: readonly string[];
} {
  const calls: string[] = [];
  const recording = (port: string): object =>
    new Proxy(
      {},
      {
        get(_target, property) {
          if (typeof property === 'symbol' || property === 'then') {
            return undefined;
          }
          return () => {
            calls.push(`${port}.${property}`);
            return Promise.resolve({});
          };
        },
      },
    );
  return {
    calls,
    writes: {
      mgmt: recording('mgmt') as ExecutorWrite['mgmt'],
      connections: recording('connections') as ExecutorWrite['connections'],
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Principals, contexts and a ready-made executor
// ---------------------------------------------------------------------------------------------

/** A person at the desktop UI: the one principal allow-all authorisation applies to. */
export function createTestPrincipal(
  overrides: Partial<Principal> = {},
): Principal {
  return {
    kind: 'desktop-user',
    id: 'user-1',
    display: 'Test User',
    roles: [],
    surface: 'ui',
    unattended: false,
    ...overrides,
  };
}

export function createTestContext(
  overrides: Partial<ExecutorContext> = {},
): ExecutorContext {
  return {
    principal: createTestPrincipal(),
    mode: 'desktop',
    env: 'dev',
    ...overrides,
  };
}

/** A receipt sink in memory: it numbers receipts `rcpt-1`, ... and can be made to fail. */
export interface MemoryReceiptSink extends ReceiptSink {
  readonly records: readonly ExecutionRecord[];
  failRecords(on: boolean): void;
}

export function createMemoryReceiptSink(): MemoryReceiptSink {
  const records: ExecutionRecord[] = [];
  let failing = false;
  return {
    records,
    failRecords(on) {
      failing = on;
    },
    record(execution) {
      if (failing) return Promise.reject(new Error('receipt store is down'));
      records.push(execution);
      return Promise.resolve(`rcpt-${String(records.length)}` as ReceiptId);
    },
  };
}

export interface TestExecutor {
  executor: ActionExecutor;
  plans: PlanStore;
  audit: MemoryAuditSink;
  receipts: MemoryReceiptSink;
  /** The write side of the prod lock; specs arm a connection with it. */
  arming: ArmingControl;
  clock: ManualClock;
  /** Calls the actions made on the write ports. */
  writeCalls: readonly string[];
  planRepository: PlanRepository;
  idempotencyRepository: IdempotencyRepository;
  cipher: PayloadCipher;
}

export interface TestExecutorParts {
  planRepository?: PlanRepository;
  idempotencyRepository?: IdempotencyRepository;
  cipher?: PayloadCipher;
  /** Overrides for the PlanStore (TTLs, limits). */
  store?: Partial<
    Omit<PlanStoreOptions, 'repository' | 'cipher' | 'clock' | 'ids'>
  >;
  /** Overrides for the executor (authorizer, guardrails, profiles, receipts, writes). */
  executor?: Partial<ActionExecutorOptions>;
}

/** An executor over in-memory parts; the write ports record what actions ask of them. */
export function createTestExecutor(
  parts: TestExecutorParts = {},
): TestExecutor {
  const clock = createManualClock(1_700_000_000_000);
  const ids = createIdGenerator({ clock });
  const planRepository = parts.planRepository ?? createMemoryPlanRepository();
  const idempotencyRepository =
    parts.idempotencyRepository ?? createMemoryIdempotencyRepository();
  const cipher = parts.cipher ?? createAesGcmTestCipher();
  const plans = createPlanStore({
    repository: planRepository,
    cipher,
    clock,
    ids,
    ...parts.store,
  });
  const audit = createMemoryAuditSink();
  const receipts = createMemoryReceiptSink();
  const guardrails = createGuardrails({ clock });
  const recording = createRecordingWrites();
  const executor = createActionExecutor({
    plans,
    idempotency: idempotencyRepository,
    authorizer: allowUiPrincipals(),
    audit,
    guardrails: guardrails.policy,
    receipts,
    writes: recording.writes,
    clock,
    ids,
    ...parts.executor,
  });
  return {
    executor,
    plans,
    audit,
    receipts,
    arming: guardrails.arming,
    clock,
    writeCalls: recording.calls,
    planRepository,
    idempotencyRepository,
    cipher,
  };
}
// ---------------------------------------------------------------------------------------------
// The real audit chain, receipt store and guardrails over memory stores
// ---------------------------------------------------------------------------------------------

export interface WiredExecutor extends Omit<
  TestExecutor,
  'audit' | 'receipts'
> {
  /** The real hash chain; its rows are in `auditRows`. */
  chain: AuditChain;
  auditRows: MemoryAuditRepository;
  /** The real receipt store; its rows are in `receiptRows`. */
  receipts: ReceiptStore;
  receiptRows: MemoryReceiptRepository;
  guardrails: Guardrails;
}

export interface WiredExecutorParts extends Omit<
  TestExecutorParts,
  'executor'
> {
  /** Shorter than 15 minutes for specs that need the lock to close before a plan expires. */
  armWindowMs?: number;
  executor?: Partial<ActionExecutorOptions>;
}

/**
 * The executor with the parts a production root wires: the hash-chained audit, the receipt store
 * and the prod lock, over memory repositories that a spec can read and tamper with.
 */
export function createWiredExecutor(
  parts: WiredExecutorParts = {},
): WiredExecutor {
  const base = createTestExecutor({
    ...(parts.planRepository === undefined
      ? {}
      : { planRepository: parts.planRepository }),
    ...(parts.idempotencyRepository === undefined
      ? {}
      : { idempotencyRepository: parts.idempotencyRepository }),
    ...(parts.cipher === undefined ? {} : { cipher: parts.cipher }),
    ...(parts.store === undefined ? {} : { store: parts.store }),
  });
  const { clock } = base;
  const ids = createIdGenerator({ clock });
  const guardrails = createGuardrails({
    clock,
    ...(parts.armWindowMs === undefined
      ? {}
      : { armWindowMs: parts.armWindowMs }),
  });
  const auditRows = createMemoryAuditRepository();
  const receiptRows = createMemoryReceiptRepository();
  const chain = createAuditChain({ repository: auditRows });
  const receipts = createReceiptStore({ repository: receiptRows, clock, ids });
  const recording = createRecordingWrites();
  const executor = createActionExecutor({
    plans: base.plans,
    idempotency: base.idempotencyRepository,
    authorizer: allowUiPrincipals(),
    audit: chain,
    guardrails: guardrails.policy,
    receipts,
    writes: recording.writes,
    clock,
    ids,
    ...parts.executor,
  });
  return {
    executor,
    plans: base.plans,
    clock,
    writeCalls: recording.calls,
    planRepository: base.planRepository,
    idempotencyRepository: base.idempotencyRepository,
    cipher: base.cipher,
    arming: guardrails.arming,
    chain,
    auditRows,
    receipts,
    receiptRows,
    guardrails,
  };
}

// ---------------------------------------------------------------------------------------------
// Plan purity (blueprint 2.2): plan() of every registered action runs against write ports that throw
// ---------------------------------------------------------------------------------------------

export interface PlanPuritySample {
  impl: ActionImpl;
  /** An input that passes `impl.def.input`. */
  input: unknown;
}

export interface PlanPurityFailure {
  actionId: ActionId;
  reason: string;
}

/**
 * Runs `plan()` of each sample with trapped write ports reachable from the context. A plan fails
 * when it throws, or when it touched a write port, even if it swallowed the error. Actions without
 * a `plan()` have nothing to violate and pass.
 */
export async function checkPlanPurity(
  samples: readonly PlanPuritySample[],
): Promise<PlanPurityFailure[]> {
  const failures: PlanPurityFailure[] = [];
  for (const { impl, input } of samples) {
    if (impl.plan === undefined) continue;
    const trap = createWriteTrap();
    // A plan() that casts its context to reach `writes` finds the trap, not a real port.
    const ctx = {
      principal: createTestPrincipal(),
      mode: 'desktop',
      env: 'dev',
      correlationId: 'plan-purity',
      signal: new AbortController().signal,
      now: () => 0,
      writes: trap.writes,
    } as ActionContext;
    try {
      await impl.plan(input, ctx);
    } catch (error) {
      failures.push({
        actionId: impl.def.id,
        reason: error instanceof Error ? error.message : 'plan() threw',
      });
      continue;
    }
    if (trap.calls.length > 0) {
      failures.push({
        actionId: impl.def.id,
        reason: `plan() called ${trap.calls.join(', ')} and swallowed the error`,
      });
    }
  }
  return failures;
}
