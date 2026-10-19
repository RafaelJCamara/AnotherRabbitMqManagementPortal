// The ConnectionManager (M0-43, DC-11/12, A-10): role-separated AMQP connections, budgeted against
// the probed and provider limits of each broker.
//
// - One lease is one connection of one role, and a lease belongs to one holder until it is
//   released (the adapter closes the connection on release), so "one job in flight per connection"
//   holds by construction. Connections open lazily, when a lease is asked for; nothing is kept warm.
// - Budgets are keyed by (connection, vhost, role) and capped for the tool as a whole per broker.
//   When a budget is spent the call waits in a bounded queue; a full queue or a wait that runs out
//   is `RATE_LIMITED` (429) with an estimated wait.
// - Waiting calls are served fairly: of those that fit, the principal with the fewest connections
//   in use goes first, then the one that has waited longest (team pools, blueprint 5.3).
// - The lease a caller gets is a wrapper with only its role's methods (`role-leases.ts`).
import { AppError, systemClock, systemTimers } from '@app/kernel';
import type { Clock, Timers } from '@app/kernel';
import type { ConnectionId } from '@app/contracts';
import type {
  Amqp091Connector,
  ConnectionManager,
  ConnectionUsage,
  ConnectorRequest,
  ObserveLease,
  OpenedConnection,
  PeekLease,
  Principal,
  PublishLease,
  RoleBudget,
  SourceLease,
} from '@app/ports';

import {
  deriveBudget,
  LEASE_ROLES,
  type BrokerBudgetInput,
  type LeaseRole,
  type ResolvedBudget,
} from './budget.ts';
import {
  wrapObserve,
  wrapPeek,
  wrapPublish,
  wrapSource,
} from './role-leases.ts';

/** Where the manager learns a broker's limits; the composition root reads the probe and the preset. */
export interface BudgetSource {
  resolve(
    connectionId: ConnectionId,
    signal: AbortSignal,
  ): Promise<BrokerBudgetInput>;
}

export interface ConnectionManagerOptions {
  readonly connector: Amqp091Connector;
  readonly budgets: BudgetSource;
  /** `connection_name` parts: the product name (a placeholder until ADR-029) and the engine mode. */
  readonly product: string;
  readonly mode: string;
  /** Most calls waiting per broker (default 64). Past it a call fails at once (I-6). */
  readonly maxQueued?: number;
  /** Longest a call waits for a connection (default 120 s). */
  readonly maxWaitMs?: number;
  readonly clock?: Clock;
  readonly timers?: Timers;
}

export interface ManagedConnectionManager extends ConnectionManager {
  /**
   * Reads the broker's limits now, so `budget` and `usage` answer with them before the first lease
   * (the capability card, A-10). Every lease call reads them again anyway.
   */
  refreshBudget(connectionId: ConnectionId, signal: AbortSignal): Promise<void>;
  /** Fails every waiting call with `ENGINE_SHUTTING_DOWN` and refuses new ones. */
  close(): void;
}

export const DEFAULT_MAX_QUEUED = 64;
export const DEFAULT_MAX_WAIT_MS = 120_000;
/** Until a role has been held and released once, a lease is assumed to be held this long. */
export const DEFAULT_HOLD_MS = 30_000;
/** Brokers remembered with nothing in use; the oldest idle ones are forgotten past this. */
const MAX_IDLE_BROKERS = 256;
const HOLD_SMOOTHING = 0.3;
const MAX_VHOST_LENGTH = 255;

interface Slot {
  readonly id: number;
  readonly role: LeaseRole;
  readonly vhost: string;
  readonly principalId: string;
  /** Monotonic time of the grant. */
  readonly since: number;
  unsubscribe: (() => void) | undefined;
}

interface Waiter {
  readonly seq: number;
  readonly role: LeaseRole;
  readonly vhost: string;
  readonly principal: Principal;
  readonly signal: AbortSignal;
  /** Called with the connection that was opened for it, or with the reason it was not. */
  readonly grant: (slot: Slot) => void;
  readonly fail: (error: unknown) => void;
  readonly detach: () => void;
}

interface BrokerState {
  readonly connectionId: ConnectionId;
  budget: ResolvedBudget;
  readonly slots: Map<number, Slot>;
  waiting: Waiter[];
  readonly holdMs: Map<LeaseRole, number>;
}

function sessionSegment(principal: Principal): string {
  const cleaned = principal.id
    .replace(/[^A-Za-z0-9._:@+=<>-]/g, '-')
    .replace(/^[^A-Za-z0-9<]+/, '')
    .slice(0, 63);
  return cleaned === '' ? 'session' : cleaned;
}

/** An abort reason is any value; a rejection should be an Error. */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new DOMException('The operation was aborted.', 'AbortError');
}

function validVhost(vhost: string): boolean {
  return (
    typeof vhost === 'string' &&
    vhost.length <= MAX_VHOST_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(vhost)
  );
}

export function createConnectionManager(
  options: ConnectionManagerOptions,
): ManagedConnectionManager {
  const clock = options.clock ?? systemClock;
  const timers = options.timers ?? systemTimers;
  const maxQueued = Math.max(1, options.maxQueued ?? DEFAULT_MAX_QUEUED);
  const maxWaitMs = Math.max(1, options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
  const brokers = new Map<ConnectionId, BrokerState>();
  let nextSeq = 0;
  let closed = false;
  const assertOpen = (): void => {
    if (closed) {
      throw new AppError('ENGINE_SHUTTING_DOWN', {
        detail: 'the connection manager is closed',
      });
    }
  };

  const expectedHold = (state: BrokerState, role: LeaseRole): number =>
    state.holdMs.get(role) ?? DEFAULT_HOLD_MS;

  const inUse = (
    state: BrokerState,
    role: LeaseRole,
    vhost: string,
  ): number => {
    let count = 0;
    for (const slot of state.slots.values()) {
      if (slot.role === role && slot.vhost === vhost) count += 1;
    }
    return count;
  };

  const fits = (state: BrokerState, role: LeaseRole, vhost: string): boolean =>
    state.slots.size < state.budget.toolMax &&
    inUse(state, role, vhost) < state.budget.roleMax[role];

  /** Estimated wait for the next call of this role and vhost: until the soonest holder is due. */
  const etaMs = (
    state: BrokerState,
    role: LeaseRole,
    vhost: string,
  ): number => {
    const roleFull = inUse(state, role, vhost) >= state.budget.roleMax[role];
    const now = clock.monotonic();
    let soonest = Number.POSITIVE_INFINITY;
    for (const slot of state.slots.values()) {
      if (roleFull && (slot.role !== role || slot.vhost !== vhost)) continue;
      const due = expectedHold(state, slot.role) - (now - slot.since);
      soonest = Math.min(soonest, Math.max(0, due));
    }
    return Number.isFinite(soonest) ? Math.ceil(soonest) : 0;
  };

  const queuedFor = (state: BrokerState, role: LeaseRole, vhost: string) =>
    state.waiting.filter((w) => w.role === role && w.vhost === vhost).length;

  const forgetIdle = (): void => {
    if (brokers.size <= MAX_IDLE_BROKERS) return;
    for (const [id, state] of brokers) {
      if (brokers.size <= MAX_IDLE_BROKERS) return;
      if (state.slots.size === 0 && state.waiting.length === 0) {
        brokers.delete(id);
      }
    }
  };

  const stateFor = (
    connectionId: ConnectionId,
    input: BrokerBudgetInput,
  ): BrokerState => {
    const budget = deriveBudget(input);
    const known = brokers.get(connectionId);
    if (known !== undefined) {
      known.budget = budget;
      return known;
    }
    const created: BrokerState = {
      connectionId,
      budget,
      slots: new Map(),
      waiting: [],
      holdMs: new Map(),
    };
    brokers.set(connectionId, created);
    forgetIdle();
    return created;
  };

  const freeSlot = (state: BrokerState, slot: Slot): void => {
    if (!state.slots.delete(slot.id)) return;
    slot.unsubscribe?.();
    slot.unsubscribe = undefined;
    const held = Math.max(0, clock.monotonic() - slot.since);
    const before = state.holdMs.get(slot.role);
    state.holdMs.set(
      slot.role,
      before === undefined ? held : before + HOLD_SMOOTHING * (held - before),
    );
    pump(state);
  };

  /** Of the waiters that fit: fewest connections in use for their principal, then longest wait. */
  const pickNext = (state: BrokerState): Waiter | undefined => {
    const perPrincipal = new Map<string, number>();
    for (const slot of state.slots.values()) {
      perPrincipal.set(
        slot.principalId,
        (perPrincipal.get(slot.principalId) ?? 0) + 1,
      );
    }
    let best: Waiter | undefined;
    let bestLoad = 0;
    for (const waiter of state.waiting) {
      if (!fits(state, waiter.role, waiter.vhost)) continue;
      const load = perPrincipal.get(waiter.principal.id) ?? 0;
      if (best === undefined || load < bestLoad) {
        best = waiter;
        bestLoad = load;
      }
    }
    return best;
  };

  function pump(state: BrokerState): void {
    for (;;) {
      const waiter = pickNext(state);
      if (waiter === undefined) return;
      state.waiting = state.waiting.filter((w) => w !== waiter);
      waiter.detach();
      const slot: Slot = {
        id: nextSeq++,
        role: waiter.role,
        vhost: waiter.vhost,
        principalId: waiter.principal.id,
        since: clock.monotonic(),
        unsubscribe: undefined,
      };
      state.slots.set(slot.id, slot);
      waiter.grant(slot);
    }
  }

  const rateLimited = (
    state: BrokerState,
    role: LeaseRole,
    vhost: string,
    why: string,
  ): AppError => {
    const eta = etaMs(state, role, vhost);
    return new AppError('RATE_LIMITED', {
      detail: `${why}; a ${role} connection may free up in about ${String(
        Math.max(1, Math.ceil(eta / 1000)),
      )} s`,
    });
  };

  /** Takes a connection for `role`: waits for budget, then opens it. */
  async function acquire<L>(
    role: LeaseRole,
    connectionId: ConnectionId,
    vhost: string,
    principal: Principal,
    signal: AbortSignal,
    open: (
      request: ConnectorRequest,
      signal: AbortSignal,
    ) => Promise<OpenedConnection<L>>,
    discard: (lease: L) => Promise<void>,
    wrap: (lease: L, released: () => void) => L,
  ): Promise<L> {
    assertOpen();
    if (!validVhost(vhost)) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'the vhost is not valid',
      });
    }
    signal.throwIfAborted();
    const state = stateFor(
      connectionId,
      await options.budgets.resolve(connectionId, signal),
    );
    signal.throwIfAborted();
    assertOpen();
    if (state.waiting.length >= maxQueued) {
      throw rateLimited(
        state,
        role,
        vhost,
        `${String(maxQueued)} requests are already waiting for a connection`,
      );
    }

    const slot = await new Promise<Slot>((resolve, reject) => {
      let cancelTimer: (() => void) | undefined;
      const onAbort = (): void => {
        state.waiting = state.waiting.filter((w) => w !== waiter);
        waiter.detach();
        reject(abortReason(signal));
      };
      const waiter: Waiter = {
        seq: nextSeq++,
        role,
        vhost,
        principal,
        signal,
        grant: resolve,
        fail: reject,
        detach: () => {
          signal.removeEventListener('abort', onAbort);
          cancelTimer?.();
          cancelTimer = undefined;
        },
      };
      signal.addEventListener('abort', onAbort, { once: true });
      cancelTimer = timers.setTimer(() => {
        state.waiting = state.waiting.filter((w) => w !== waiter);
        waiter.detach();
        reject(
          rateLimited(
            state,
            role,
            vhost,
            `no ${role} connection became free within ${String(maxWaitMs)} ms`,
          ),
        );
      }, maxWaitMs);
      state.waiting.push(waiter);
      pump(state);
    });

    let opened: OpenedConnection<L>;
    try {
      opened = await open(
        {
          connectionId,
          vhost,
          name: {
            product: options.product,
            mode: options.mode,
            session: sessionSegment(principal),
          },
        },
        signal,
      );
    } catch (error) {
      freeSlot(state, slot);
      throw error;
    }
    slot.unsubscribe = opened.subscribe((event) => {
      if (event.type === 'closed') freeSlot(state, slot);
    });
    if (!state.slots.has(slot.id)) {
      // The connection ended between opening and subscribing: the lease is dead.
      await discard(opened.lease).catch(() => undefined);
      throw new AppError('BROKER_UNREACHABLE', {
        detail: 'the connection closed while it was being opened',
      });
    }
    if (signal.aborted) {
      await discard(opened.lease).catch(() => undefined);
      freeSlot(state, slot);
      throw abortReason(signal);
    }
    // The slot is freed when a release succeeds or when the connection reports `closed`. A release
    // that refuses (a source still holding deliveries) keeps the slot until the connection ends.
    return wrap(opened.lease, () => {
      freeSlot(state, slot);
    });
  }

  return {
    peek: (connectionId, vhost, principal, signal) =>
      acquire<PeekLease>(
        'peek',
        connectionId,
        vhost,
        principal,
        signal,
        (request, s) => options.connector.openPeek(request, s),
        (lease) => lease.release('healthy'),
        (lease, released) =>
          wrapPeek(lease, async (state) => {
            await lease.release(state);
            released();
          }),
      ),
    source: (connectionId, vhost, principal, signal) =>
      acquire<SourceLease>(
        'source',
        connectionId,
        vhost,
        principal,
        signal,
        (request, s) => options.connector.openSource(request, s),
        (lease) => lease.release('healthy'),
        (lease, released) =>
          wrapSource(lease, async (state) => {
            await lease.release(state);
            released();
          }),
      ),
    publish: (connectionId, vhost, principal, signal) =>
      acquire<PublishLease>(
        'publish',
        connectionId,
        vhost,
        principal,
        signal,
        (request, s) => options.connector.openPublish(request, s),
        (lease) => lease.release(),
        (lease, released) =>
          wrapPublish(lease, async () => {
            await lease.release();
            released();
          }),
      ),
    observe: (connectionId, vhost, principal, signal) =>
      acquire<ObserveLease>(
        'observe',
        connectionId,
        vhost,
        principal,
        signal,
        (request, s) => options.connector.openObserve(request, s),
        (lease) => lease.release(),
        (lease, released) =>
          wrapObserve(lease, async () => {
            await lease.release();
            released();
          }),
      ),

    budget(connectionId, vhost): RoleBudget[] {
      const state = brokers.get(connectionId);
      const budget = state?.budget ?? deriveBudget({ limits: {} });
      return LEASE_ROLES.map((role) => {
        const queued = state === undefined ? 0 : queuedFor(state, role, vhost);
        return {
          role,
          vhost,
          inUse: state === undefined ? 0 : inUse(state, role, vhost),
          max: budget.roleMax[role],
          queued,
          etaMs:
            state === undefined || queued === 0
              ? null
              : etaMs(state, role, vhost),
        };
      });
    },

    usage(connectionId): ConnectionUsage {
      const state = brokers.get(connectionId);
      const budget = state?.budget ?? deriveBudget({ limits: {} });
      return {
        inUse: state?.slots.size ?? 0,
        max: budget.toolMax,
        queued: state?.waiting.length ?? 0,
        brokerMax: budget.brokerMax,
      };
    },

    async refreshBudget(connectionId, signal): Promise<void> {
      stateFor(
        connectionId,
        await options.budgets.resolve(connectionId, signal),
      );
    },

    close(): void {
      closed = true;
      for (const state of brokers.values()) {
        const waiting = state.waiting;
        state.waiting = [];
        for (const waiter of waiting) {
          waiter.detach();
          waiter.fail(
            new AppError('ENGINE_SHUTTING_DOWN', {
              detail: 'the connection manager is closed',
            }),
          );
        }
      }
    },
  };
}
