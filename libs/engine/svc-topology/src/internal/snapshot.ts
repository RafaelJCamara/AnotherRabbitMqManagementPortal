// One vhost of a broker, read once and kept for a short time (spec R3). Queues, exchanges and bindings
// fail the whole read closed: a graph without its bindings would be a wrong answer. Policies and
// consumers do not: a policy list the principal may not read, or a provider that switched operator
// policies off, is a reported gap (A-2), and the consumers only refine `rejectable`. Every bound cuts
// and counts (I-6, I-13); nothing here holds a body whole beyond what the port already did.
import type { ConnectionId } from '@app/contracts';
import { AppError, systemClock, type Clock } from '@app/kernel';
import type { Lane, MgmtQuery, MgmtReadPort } from '@app/ports';
import type { z } from 'zod';

import { DEFAULT_TOPOLOGY_LIMITS, type TopologyLimits } from '../deps';

import {
  BindingListSchema,
  ConsumerListSchema,
  ExchangePageSchema,
  PolicyListSchema,
  QueuePageSchema,
  type BindingRow,
  type ExchangeRow,
  type PolicyRow,
  type QueueRow,
} from './rows';

const LANE: Lane = 'interactive';

/** The queue fields this service uses; the broker then leaves the statistics of each queue out. */
const QUEUE_COLUMNS =
  'name,type,arguments,policy,operator_policy,delivery_limit';
const EXCHANGE_COLUMNS = 'name,type,internal,arguments';

/** A policy list: `unreadable` is a gap, not an error (the principal may lack the tag, A-2). */
export type PolicyList =
  | { readonly state: 'read'; readonly policies: readonly PolicyRow[] }
  | { readonly state: 'unreadable' };

export type ConsumersState = 'read' | 'unreadable' | 'truncated';

/** What each bound cut. For a figure the broker did not give, a minimum (at least 1). */
export interface SnapshotTruncation {
  readonly queues: number;
  readonly exchanges: number;
  readonly bindings: number;
  readonly consumers: number;
  readonly policies: number;
  readonly operatorPolicies: number;
}

export interface Snapshot {
  readonly vhost: string;
  /** Milliseconds since the epoch, when the read ended. */
  readonly takenAt: number;
  readonly queues: readonly QueueRow[];
  readonly exchanges: readonly ExchangeRow[];
  readonly bindings: readonly BindingRow[];
  readonly policies: PolicyList;
  readonly operatorPolicies: PolicyList;
  readonly consumers: ConsumersState;
  /** Names of the queues with at least one consumer that acknowledges (it may reject). */
  readonly ackingQueues: ReadonlySet<string>;
  readonly truncation: SnapshotTruncation;
}

export interface SnapshotReader {
  read(
    cid: ConnectionId,
    vhost: string,
    signal: AbortSignal,
    options?: { readonly refresh?: boolean },
  ): Promise<Snapshot>;
  /** For specs and the module's drain: how many snapshots are held and how many were evicted. */
  stats(): { readonly held: number; readonly evicted: number };
  /** Drops every held snapshot. */
  stop(): void;
}

export interface SnapshotReaderDeps {
  readonly mgmt: MgmtReadPort;
  readonly clock?: Clock | undefined;
  readonly limits?: Partial<TopologyLimits> | undefined;
}

type Items<T> = readonly T[] | { readonly items: readonly T[] };

interface Pager<T> {
  readonly items: readonly T[];
  readonly page_count: number;
  readonly total_count?: number | undefined;
}

const itemsOf = <T>(answer: Items<T>): readonly T[] =>
  Array.isArray(answer) ? answer : (answer as { items: readonly T[] }).items;

/** The listed objects the principal may not read: reported as a gap, never thrown. */
export function isUnreadable(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  return (
    error.code === 'FORBIDDEN_BROKER' ||
    error.code === 'NOT_FOUND' ||
    (error.code === 'BROKER_ERROR' && error.broker?.code === 405)
  );
}

/** Pages of one list up to `max` rows; what is left is counted (a minimum when the broker gave no total). */
async function readPaged<T>(
  readPage: (page: number) => Promise<Pager<T>>,
  max: number,
): Promise<{ rows: T[]; dropped: number }> {
  const rows: T[] = [];
  let dropped = 0;
  for (let n = 1; ; n++) {
    const answer = await readPage(n);
    for (const item of answer.items) {
      if (rows.length < max) rows.push(item);
      else dropped += 1;
    }
    const more = n < answer.page_count && answer.items.length > 0;
    if (rows.length >= max && (more || dropped > 0)) {
      const known =
        answer.total_count === undefined ? 0 : answer.total_count - rows.length;
      return { rows, dropped: Math.max(1, dropped, known) };
    }
    if (!more) return { rows, dropped };
  }
}

export function createSnapshotReader(deps: SnapshotReaderDeps): SnapshotReader {
  const limits = { ...DEFAULT_TOPOLOGY_LIMITS, ...deps.limits };
  const clock = deps.clock ?? systemClock;
  const held = new Map<string, Snapshot>();
  let evicted = 0;

  const get = <T>(
    cid: ConnectionId,
    path: string,
    query: MgmtQuery,
    schema: z.ZodType<T>,
    signal: AbortSignal,
  ): Promise<T> =>
    deps.mgmt.get(
      { connectionId: cid, path, query, schema, lane: LANE },
      signal,
    );

  async function build(
    cid: ConnectionId,
    vhost: string,
    outer: AbortSignal,
  ): Promise<Snapshot> {
    // A failed read stops its siblings (they would only waste the broker's time).
    const inner = new AbortController();
    const signal = AbortSignal.any([outer, inner.signal]);
    const enc = encodeURIComponent(vhost);
    const pageSize = Math.min(limits.pageSize, 500);
    const queryOf = (page: number, columns: string): MgmtQuery => ({
      page,
      page_size: pageSize,
      pagination: true,
      columns,
    });
    const policyList = async (
      path: string,
    ): Promise<{ list: PolicyList; cut: number }> => {
      try {
        const policies = await get(cid, path, {}, PolicyListSchema, signal);
        // A list cut at the bound could hide the policy that decides, so it is unreadable and counted.
        return policies.length > limits.maxPolicies
          ? {
              list: { state: 'unreadable' },
              cut: policies.length - limits.maxPolicies,
            }
          : { list: { state: 'read', policies }, cut: 0 };
      } catch (error) {
        if (outer.aborted || !isUnreadable(error)) throw error;
        return { list: { state: 'unreadable' }, cut: 0 };
      }
    };

    try {
      const [queues, exchanges, bindings, policies, operators, consumers] =
        await Promise.all([
          readPaged(
            (page) =>
              get(
                cid,
                `/api/queues/${enc}`,
                queryOf(page, QUEUE_COLUMNS),
                QueuePageSchema,
                signal,
              ),
            limits.maxQueues,
          ),
          readPaged(
            (page) =>
              get(
                cid,
                `/api/exchanges/${enc}`,
                queryOf(page, EXCHANGE_COLUMNS),
                ExchangePageSchema,
                signal,
              ),
            limits.maxExchanges,
          ),
          get(cid, `/api/bindings/${enc}`, {}, BindingListSchema, signal),
          policyList(`/api/policies/${enc}`),
          policyList(`/api/operator-policies/${enc}`),
          get(
            cid,
            `/api/consumers/${enc}`,
            {},
            ConsumerListSchema,
            signal,
          ).catch((error: unknown): null => {
            // Best effort: the consumers only refine `rejectable`.
            if (outer.aborted || !(error instanceof AppError)) throw error;
            if (error.code === 'ENGINE_SHUTTING_DOWN') throw error;
            return null;
          }),
        ]);
      const bindingItems = itemsOf(bindings);
      const consumerItems = consumers === null ? [] : itemsOf(consumers);
      const acking = new Set<string>();
      for (const consumer of consumerItems.slice(0, limits.maxConsumers)) {
        if (consumer.ack_required === true) acking.add(consumer.queue.name);
      }
      return {
        vhost,
        takenAt: clock.now(),
        queues: queues.rows,
        exchanges: exchanges.rows,
        bindings: bindingItems.slice(0, limits.maxBindings),
        policies: policies.list,
        operatorPolicies: operators.list,
        consumers:
          consumers === null
            ? 'unreadable'
            : consumerItems.length > limits.maxConsumers
              ? 'truncated'
              : 'read',
        ackingQueues: acking,
        truncation: {
          queues: queues.dropped,
          exchanges: exchanges.dropped,
          bindings: Math.max(0, bindingItems.length - limits.maxBindings),
          consumers: Math.max(0, consumerItems.length - limits.maxConsumers),
          policies: policies.cut,
          operatorPolicies: operators.cut,
        },
      };
    } catch (error) {
      inner.abort();
      // Policies and consumers are read apart, so a missing object here is the vhost (or a broker
      // without the endpoint): one fixed text, never the broker's own.
      if (error instanceof AppError && error.code === 'NOT_FOUND') {
        throw new AppError('NOT_FOUND', { detail: 'There is no such vhost.' });
      }
      throw error;
    }
  }

  return {
    async read(cid, vhost, signal, options) {
      const key = `${cid}\u0000${vhost}`;
      const found = held.get(key);
      if (
        options?.refresh !== true &&
        found !== undefined &&
        clock.now() - found.takenAt < limits.snapshotTtlMs
      ) {
        return found;
      }
      const snapshot = await build(cid, vhost, signal);
      held.delete(key);
      held.set(key, snapshot);
      while (held.size > limits.maxSnapshots) {
        const oldest = held.keys().next();
        if (oldest.done === true) break;
        held.delete(oldest.value);
        evicted += 1;
      }
      return snapshot;
    },
    stats: () => ({ held: held.size, evicted }),
    stop: () => {
      held.clear();
    },
  };
}
