// The TokenManager (M1-23, CON-07, DC-37, blueprint 7.5): it hands out the credential of a profile,
// renews a bearer token at 75 % of its lifetime, pushes the new token to the live connections
// that use it, refuses a renewal that would change the user, and ends honestly when a token
// runs out. It holds the credentials in memory only and writes nothing.
//
// How it behaves, in the order a reader needs it:
//   - One entry per (connection, protocol). `credentialFor` resolves or reuses it; `track` says a
//     live connection depends on it, and only a tracked entry gets timers. An untracked entry (a
//     plain HTTP caller) is renewed lazily, by the next `credentialFor` after its 75 % point.
//   - Single flight. Callers that arrive while a renewal runs share it. The shared promise settles
//     when the new credential is adopted; handing it to the live connections happens after, so a
//     reconnect that asks `credentialFor` for its login (the lazy credentials of blueprint 7.5)
//     never waits on the renewal that is reconnecting it.
//   - Fail closed. A renewal whose user name differs or is missing is refused and never reaches the
//     connection; the old token goes on until its own expiry and no retry loop starts (DC-37).
//   - Bounded (I-6). Entries, listeners, concurrent provider calls, every wait, the attempts per
//     lifetime and the backoff all have a ceiling; a refusal is counted, never silent (I-13).
//   - Secrets (I-10). A failure carries a fixed text and never a `cause`; tokens are `SecretValue`s
//     and cross `ConnectionAuthPort` only as the argument of the one call that needs them.
//   - Time and timers are injected (`Clock`, `Timers`). A timer that fires early on the wall clock
//     (a clock set back, or a timer longer than the platform allows) is re-armed, not trusted.
import { AppError, toProblem, type Clock, type Timers } from '@app/kernel';
import type {
  ConnectionAuthPort,
  CredentialProtocol,
  RenewalProtocol,
} from '@app/ports';
import type { Problem } from '@app/contracts';

import { createLimiter } from './internal/limiter';
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  MAX_ATTEMPTS,
  MIN_REFRESH_INTERVAL_MS,
  backoffDelayMs,
  expiryRuleFor,
  plannedRefreshAt,
  renewalActionFor,
} from './internal/renewal-plan';
import { abortReason, raceSignal } from './internal/signals';
import { checkUsername } from './internal/username-claim';
import type { CredentialProvider, IssuedCredential } from './provider';

export interface ResolvedCredential {
  readonly credential: IssuedCredential;
  /** Goes up with each adopted renewal. A 401 handler passes the generation it used, never the token. */
  readonly generation: number;
}

export type TokenStateName =
  | 'valid'
  | 'refreshing'
  | 'failed'
  | 'expired'
  | 'username-changed';

export interface TokenState {
  readonly connectionId: string;
  readonly protocol: CredentialProtocol;
  readonly state: TokenStateName;
  readonly expiresAt: number | null;
  /** When the manager will next try to renew (a retry after a failure included), or null. */
  readonly nextRefreshAt: number | null;
  /** The engine's own consumers cancelled at expiry: counted, never silent (I-13). */
  readonly consumersCancelled: number;
  /** Why the state is `failed`, `username-changed` or `expired`; a fixed text with no secret. */
  readonly problem: Problem | null;
}

export interface TokenManagerStats {
  readonly entries: number;
  readonly listeners: number;
  readonly inflightRefreshes: number;
  /** Provider calls and pushes running now; zero when the manager is quiet. */
  readonly pendingOperations: number;
  /** Renewals, pushes and close handlers not yet finished; zero once `dispose` has returned. */
  readonly pendingTasks: number;
  readonly refusedEntries: number;
  readonly evictedEntries: number;
  readonly refusedListeners: number;
  readonly listenerErrors: number;
  /** 320 closes ignored because one was already being handled or came inside the floor. */
  readonly coalescedForcedCloses: number;
}

/** What the broker can do, asked afresh at each use (a cluster can change under a connection). */
export interface RenewalCapabilities {
  readonly amqp10TokenRenewalEndpoint: boolean;
  readonly amqp091ClosesAtCredentialExpiry: boolean;
}

export interface ProviderLookup {
  /** The provider configured for a profile and protocol, or undefined when there is none. */
  providerFor(
    connectionId: string,
    protocol: CredentialProtocol,
  ): Promise<CredentialProvider | undefined>;
}

export interface TokenManagerLimits {
  /** Distinct (connection, protocol) entries held at once. */
  readonly maxEntries: number;
  readonly maxListeners: number;
  /** Provider calls running at once. */
  readonly maxConcurrentAcquires: number;
  /** The longest one provider call, or one push to a connection, may take. */
  readonly operationTimeoutMs: number;
  readonly minRefreshIntervalMs: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  /** Attempts per token lifetime before the manager stops trying until the token expires. */
  readonly maxAttempts: number;
}

export const DEFAULT_TOKEN_MANAGER_LIMITS: TokenManagerLimits = Object.freeze({
  maxEntries: 256,
  maxListeners: 32,
  maxConcurrentAcquires: 8,
  operationTimeoutMs: 30_000,
  minRefreshIntervalMs: MIN_REFRESH_INTERVAL_MS,
  backoffBaseMs: BACKOFF_BASE_MS,
  backoffMaxMs: BACKOFF_MAX_MS,
  maxAttempts: MAX_ATTEMPTS,
});

export interface TokenManagerDeps {
  readonly providers: ProviderLookup;
  readonly auth: ConnectionAuthPort;
  readonly capabilities: (connectionId: string) => RenewalCapabilities;
  readonly clock: Clock;
  readonly timers: Timers;
  readonly limits?: Partial<TokenManagerLimits>;
}

export interface TokenManager {
  credentialFor(
    connectionId: string,
    protocol: CredentialProtocol,
    signal: AbortSignal,
  ): Promise<ResolvedCredential>;
  /**
   * Registers a live connection for renewal and returns the handle that stops it. `generation` is
   * the generation of the credential the connection logged in with, when the caller has it: a
   * connection that is behind is brought up to date at once. The entry must fit the cap.
   */
  track(target: {
    readonly connectionId: string;
    readonly protocol: RenewalProtocol;
    readonly generation?: number;
  }): { release(): void };
  /** One renewal after the broker answered 401; a no-op if `generation` is no longer current. */
  refreshAfterUnauthorized(
    connectionId: string,
    protocol: CredentialProtocol,
    generation: number,
    signal: AbortSignal,
  ): Promise<ResolvedCredential>;
  state(
    connectionId: string,
    protocol: CredentialProtocol,
  ): TokenState | undefined;
  subscribe(listener: (state: TokenState) => void): () => void;
  stats(): TokenManagerStats;
  dispose(): Promise<void>;
}

/** The platform's longest timer (2^31 - 1 ms); a longer wait is made in steps. */
const MAX_TIMER_MS = 2_147_483_647;
/** The reason the broker is told in `connection.update-secret`: fixed, never the token. */
const UPDATE_SECRET_REASON = 'token refresh';

type Why = 'scheduled' | 'demand' | 'unauthorized' | 'forced-close';

/** A renewal the manager refuses on its own: the state it leaves behind, and whether to retry. */
class Refusal extends AppError {
  readonly stateName: TokenStateName;
  readonly terminal: boolean;
  constructor(
    code: AppError['code'],
    detail: string,
    stateName: TokenStateName,
    terminal: boolean,
  ) {
    super(code, { detail });
    this.stateName = stateName;
    this.terminal = terminal;
  }
}

interface Target {
  count: number;
  /** The generation the connection holds, as far as the manager knows. */
  pushedGeneration: number;
}

interface Entry {
  readonly key: string;
  readonly connectionId: string;
  readonly protocol: CredentialProtocol;
  credential: IssuedCredential | undefined;
  generation: number;
  /** The user name of the first token; undefined until there is one. */
  expectedUsername: string | null | undefined;
  state: TokenStateName;
  problem: Problem | null;
  expiresAt: number | null;
  /** The 75 % point (floored) of the current credential. */
  plannedRefreshAt: number | null;
  /** When the next retry after a failure is due, or null. */
  retryAt: number | null;
  nextWakeAt: number | null;
  /** On-demand refreshes (a 401, an expired token) are refused before this instant. */
  retryNotBefore: number;
  lastStartedAt: number | null;
  failures: number;
  /** No automatic retry: a renewal was refused for the user name. */
  terminal: boolean;
  pushFailed: boolean;
  consumersCancelled: number;
  readonly targets: Map<RenewalProtocol, Target>;
  inflight: Promise<ResolvedCredential> | undefined;
  pushing: Promise<void> | undefined;
  cancelWake: (() => void) | undefined;
  cancelExpiry: (() => void) | undefined;
  lastForcedCloseAt: number | null;
  closing: boolean;
}

const noop = (): void => undefined;

export function createTokenManager(deps: TokenManagerDeps): TokenManager {
  const { clock, timers, auth } = deps;
  const limits: TokenManagerLimits = {
    ...DEFAULT_TOKEN_MANAGER_LIMITS,
    ...deps.limits,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new RangeError(
        `Token manager limit ${name} must be an integer of at least 1.`,
      );
    }
  }

  const entries = new Map<string, Entry>();
  const listeners = new Set<{ readonly call: (state: TokenState) => void }>();
  const controllers = new Set<AbortController>();
  const background = new Set<Promise<unknown>>();
  const limiter = createLimiter(limits.maxConcurrentAcquires);
  const shutdown = new AbortController();
  let disposed = false;
  let disposing: Promise<void> | undefined;
  let generationCounter = 0;
  const counters = {
    refusedEntries: 0,
    evictedEntries: 0,
    refusedListeners: 0,
    listenerErrors: 0,
    coalescedForcedCloses: 0,
  };

  const shuttingDown = (): AppError =>
    new AppError('ENGINE_SHUTTING_DOWN', {
      detail: 'The identity service is shutting down.',
    });
  const cancelled = (): AppError =>
    new AppError('BROKER_UNREACHABLE', {
      detail: 'The credential request was cancelled.',
    });
  // A function, so a check after an await is not narrowed away by the check before it.
  const isDisposed = (): boolean => disposed;
  const assertLive = (): void => {
    if (disposed) throw shuttingDown();
  };
  const keyOf = (connectionId: string, protocol: CredentialProtocol): string =>
    `${protocol}:${connectionId}`;
  const credentialProtocolOf = (
    protocol: RenewalProtocol,
  ): CredentialProtocol => (protocol === 'http' ? 'http' : 'amqp');

  /** Runs `work` for the manager's own sake: bounded in time, and cut off at dispose. */
  async function guarded<T>(
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    controllers.add(controller);
    const cancelTimer = timers.setTimer(() => {
      controller.abort(
        new AppError('BROKER_UNREACHABLE', {
          detail: 'The operation did not finish in time.',
        }),
      );
    }, limits.operationTimeoutMs);
    try {
      return await raceSignal(
        (async () => work(controller.signal))(),
        controller.signal,
        () => abortReason(controller.signal),
      );
    } finally {
      cancelTimer();
      controllers.delete(controller);
    }
  }

  const trackBackground = (promise: Promise<unknown>): void => {
    const settled = promise.then(noop, noop);
    background.add(settled);
    void settled.then(() => background.delete(settled));
  };

  // -- publishing -----------------------------------------------------------------------------

  const isExpired = (entry: Entry, now: number): boolean =>
    entry.expiresAt !== null && now >= entry.expiresAt;

  function snapshot(entry: Entry): TokenState {
    const now = clock.now();
    const state =
      (entry.state === 'valid' || entry.state === 'failed') &&
      isExpired(entry, now)
        ? 'expired'
        : entry.state;
    return Object.freeze({
      connectionId: entry.connectionId,
      protocol: entry.protocol,
      state,
      expiresAt: entry.expiresAt,
      nextRefreshAt:
        entry.nextWakeAt ??
        (entry.targets.size === 0 ? entry.plannedRefreshAt : null),
      consumersCancelled: entry.consumersCancelled,
      problem: entry.problem,
    });
  }

  function publish(entry: Entry): void {
    if (disposed || listeners.size === 0) return;
    const state = snapshot(entry);
    for (const slot of [...listeners]) {
      try {
        slot.call(state);
      } catch {
        counters.listenerErrors += 1;
      }
    }
  }

  // -- timers ---------------------------------------------------------------------------------

  /**
   * Calls `callback` at the wall-clock instant `at`. A timer that fires before then (a clock that
   * was set back, or a wait longer than the platform's timer) is armed again for the rest.
   */
  function armAt(at: number, callback: () => void): () => void {
    let cancel: () => void = noop;
    let stopped = false;
    const arm = (): void => {
      const remaining = at - clock.now();
      cancel = timers.setTimer(
        () => {
          if (stopped) return;
          if (clock.now() < at) arm();
          else callback();
        },
        Math.min(Math.max(remaining, 0), MAX_TIMER_MS),
      );
    };
    arm();
    return () => {
      stopped = true;
      cancel();
    };
  }

  function disarmWake(entry: Entry): void {
    entry.cancelWake?.();
    entry.cancelWake = undefined;
    entry.nextWakeAt = null;
  }

  function disarm(entry: Entry): void {
    disarmWake(entry);
    entry.cancelExpiry?.();
    entry.cancelExpiry = undefined;
  }

  function armWake(entry: Entry): void {
    disarmWake(entry);
    if (disposed || entry.targets.size === 0 || entry.terminal) return;
    if (entry.failures >= limits.maxAttempts) return;
    const now = clock.now();
    const { retryAt, plannedRefreshAt: planned } = entry;
    // After a failure the backoff decides, unless the current token's own point is still ahead
    // and sooner (a push that failed while the token is fresh).
    let at: number | null = retryAt ?? planned;
    if (
      retryAt !== null &&
      planned !== null &&
      planned > now &&
      planned < retryAt
    ) {
      at = planned;
    }
    if (at === null) return;
    // A retry that would land on or after the expiry is not made: the expiry rule takes over.
    if (at === retryAt && entry.expiresAt !== null && at >= entry.expiresAt) {
      return;
    }
    entry.nextWakeAt = at;
    entry.cancelWake = armAt(at, () => {
      onWake(entry);
    });
  }

  function armExpiry(entry: Entry): void {
    entry.cancelExpiry?.();
    entry.cancelExpiry = undefined;
    if (disposed || entry.targets.size === 0 || entry.expiresAt === null) {
      return;
    }
    entry.cancelExpiry = armAt(entry.expiresAt, () => {
      onExpiry(entry);
    });
  }

  function arm(entry: Entry): void {
    armWake(entry);
    armExpiry(entry);
  }

  // -- entries --------------------------------------------------------------------------------

  const isIdle = (entry: Entry): boolean =>
    entry.targets.size === 0 &&
    entry.inflight === undefined &&
    entry.pushing === undefined;

  /** Finds or creates the entry; a new one needs room, which an idle entry can make. */
  function entryFor(connectionId: string, protocol: CredentialProtocol): Entry {
    const key = keyOf(connectionId, protocol);
    const found = entries.get(key);
    if (found !== undefined) {
      entries.delete(key);
      entries.set(key, found); // most recently used last
      return found;
    }
    if (entries.size >= limits.maxEntries) {
      let victim: Entry | undefined;
      for (const candidate of entries.values()) {
        if (isIdle(candidate)) {
          victim = candidate;
          break;
        }
      }
      if (victim === undefined) {
        counters.refusedEntries += 1;
        throw new AppError('BUDGET_EXCEEDED', {
          detail:
            'The identity service tracks as many connections as it allows.',
        });
      }
      disarm(victim);
      entries.delete(victim.key);
      counters.evictedEntries += 1;
    }
    const entry: Entry = {
      key,
      connectionId,
      protocol,
      credential: undefined,
      generation: 0,
      expectedUsername: undefined,
      state: 'refreshing',
      problem: null,
      expiresAt: null,
      plannedRefreshAt: null,
      retryAt: null,
      nextWakeAt: null,
      retryNotBefore: 0,
      lastStartedAt: null,
      failures: 0,
      terminal: false,
      pushFailed: false,
      consumersCancelled: 0,
      targets: new Map(),
      inflight: undefined,
      pushing: undefined,
      cancelWake: undefined,
      cancelExpiry: undefined,
      lastForcedCloseAt: null,
      closing: false,
    };
    entries.set(key, entry);
    return entry;
  }

  function dropIfEmpty(entry: Entry): void {
    if (entry.credential === undefined && isIdle(entry)) {
      entries.delete(entry.key);
    }
  }

  const resolved = (entry: Entry): ResolvedCredential => {
    if (entry.credential === undefined) throw new Error('unreachable');
    return { credential: entry.credential, generation: entry.generation };
  };

  // -- the renewal ----------------------------------------------------------------------------

  /** Turns anything a provider threw into an error of fixed text; its `cause` is never kept. */
  function describeProviderError(error: unknown): AppError {
    if (error instanceof Refusal) return error;
    if (error instanceof AppError) {
      return new AppError(
        error.code,
        error.detail === undefined ? {} : { detail: error.detail },
      );
    }
    return new AppError('INTERNAL', {
      detail: 'The credential provider failed.',
    });
  }

  /** Checks a credential a provider gave and, if it may replace the current one, adopts it. */
  function adopt(
    entry: Entry,
    issued: IssuedCredential,
    why: Why,
  ): ResolvedCredential {
    const now = clock.now();
    const previous = entry.credential;
    if (issued.kind === 'bearer') {
      if (issued.expiresAt !== null && issued.expiresAt <= now) {
        throw new AppError('TOKEN_EXPIRED', {
          detail: 'The token is already expired.',
        });
      }
    }
    if (previous !== undefined) {
      if (previous.kind !== issued.kind) {
        throw new AppError('VALIDATION_FAILED', {
          detail: 'The credential provider changed the kind of credential.',
        });
      }
      if (previous.kind === 'bearer' && issued.kind === 'bearer') {
        const verdict = checkUsername(
          entry.expectedUsername ?? null,
          issued.username,
        );
        if (verdict === 'changed') {
          throw new Refusal(
            'UNAUTHENTICATED',
            'The renewed token names another user than the first one, so it was not used.',
            'username-changed',
            true,
          );
        }
        if (verdict === 'missing') {
          throw new Refusal(
            'UNAUTHENTICATED',
            'The renewed token names no user, so it was not used.',
            'failed',
            true,
          );
        }
        // A token that does not outlive the one it replaces would renew in a tight loop.
        if (
          (why === 'scheduled' || why === 'demand') &&
          previous.expiresAt !== null &&
          issued.expiresAt !== null &&
          issued.expiresAt <= previous.expiresAt
        ) {
          throw new AppError('VALIDATION_FAILED', {
            detail:
              'The renewed token does not expire later than the one it replaces.',
          });
        }
      }
    } else if (issued.kind === 'bearer') {
      entry.expectedUsername = issued.username;
    }

    const generation = ++generationCounter;
    entry.credential = issued;
    entry.generation = generation;
    entry.failures = 0;
    entry.retryAt = null;
    entry.terminal = false;
    entry.pushFailed = false;
    entry.problem = null;
    entry.state = 'valid';
    entry.retryNotBefore =
      (entry.lastStartedAt ?? now) + limits.minRefreshIntervalMs;
    if (issued.kind === 'bearer') {
      entry.expiresAt = issued.expiresAt;
      entry.plannedRefreshAt =
        issued.expiresAt === null
          ? null
          : plannedRefreshAt({
              issuedAt: issued.issuedAt,
              expiresAt: issued.expiresAt,
              now,
              lastStartedAt: entry.lastStartedAt ?? now,
              minIntervalMs: limits.minRefreshIntervalMs,
            });
    } else {
      entry.expiresAt = null;
      entry.plannedRefreshAt = null;
    }
    if (why === 'forced-close') {
      // The connection that was closed reopens with this token: nothing to push to it.
      const closed = entry.targets.get('amqp091');
      if (closed !== undefined) closed.pushedGeneration = generation;
    }
    if (previous === undefined) {
      // A connection tracked before the first credential is taken to hold it (it asks
      // `credentialFor` for its login): there is nothing to push.
      for (const target of entry.targets.values()) {
        target.pushedGeneration = generation;
      }
    }
    arm(entry);
    publish(entry);
    return { credential: issued, generation };
  }

  /** Records a failed renewal in the entry and returns the error to throw. */
  function recordFailure(entry: Entry, error: unknown): AppError {
    const failure = describeProviderError(error);
    if (disposed) return failure;
    const now = clock.now();
    const refusal = failure instanceof Refusal ? failure : undefined;
    entry.failures += 1;
    entry.terminal = refusal?.terminal ?? false;
    entry.problem = toProblem(failure);
    const delay = backoffDelayMs(
      entry.failures,
      limits.backoffBaseMs,
      limits.backoffMaxMs,
    );
    entry.retryAt = now + delay; // a terminal entry never reads it: armWake stops first
    entry.retryNotBefore = Math.max(entry.retryNotBefore, now + delay);
    entry.state = refusal?.stateName ?? 'failed';
    armWake(entry);
    publish(entry);
    return failure;
  }

  async function runFlight(
    entry: Entry,
    why: Why,
  ): Promise<ResolvedCredential> {
    if (entry.credential !== undefined) {
      entry.state = 'refreshing';
      publish(entry);
    }
    try {
      const release = await limiter.acquire(shutdown.signal);
      let issued: IssuedCredential;
      try {
        entry.lastStartedAt = clock.now();
        entry.retryNotBefore = Math.max(
          entry.retryNotBefore,
          entry.lastStartedAt + limits.minRefreshIntervalMs,
        );
        issued = await guarded(async (signal) => {
          const provider = await deps.providers.providerFor(
            entry.connectionId,
            entry.protocol,
          );
          if (provider === undefined) {
            throw new AppError('NOT_FOUND', {
              detail:
                'No credential provider is configured for this connection.',
            });
          }
          return provider.acquire(
            { connectionId: entry.connectionId, protocol: entry.protocol },
            signal,
          );
        });
      } finally {
        release();
      }
      return adopt(entry, issued, why);
    } catch (error) {
      throw recordFailure(entry, error);
    }
  }

  /** The one renewal in flight for `entry`; callers that arrive meanwhile share it. */
  function refresh(entry: Entry, why: Why): Promise<ResolvedCredential> {
    if (entry.inflight !== undefined) return entry.inflight;
    const flight = runFlight(entry, why).finally(() => {
      entry.inflight = undefined;
    });
    entry.inflight = flight;
    trackBackground(flight);
    // The push to the live connections starts only after `inflight` is clear.
    flight.then(() => {
      pushBehind(entry);
    }, noop);
    return flight;
  }

  // -- handing a renewed token to the live connections ----------------------------------------

  async function pushOne(
    entry: Entry,
    protocol: RenewalProtocol,
    credential: Extract<IssuedCredential, { kind: 'bearer' }>,
  ): Promise<void> {
    const id = entry.connectionId;
    const action = renewalActionFor(protocol, deps.capabilities(id));
    await guarded(async () => {
      switch (action) {
        case 'push-none':
          return;
        case 'update-secret':
          await auth.updateSecret(
            id,
            credential.token.reveal(),
            UPDATE_SECRET_REASON,
          );
          return;
        case 'put-auth-token':
          // No sink for the AMQP 1.0 token endpoint yet: reconnect, never "nothing".
          if (auth.putAuthToken === undefined)
            await auth.reconnect(id, protocol);
          else await auth.putAuthToken(id, credential.token.reveal());
          return;
        case 'reconnect':
          await auth.reconnect(id, protocol);
          return;
      }
    });
  }

  const behindOf = (entry: Entry): [RenewalProtocol, Target][] =>
    [...entry.targets].filter(
      ([, target]) => target.pushedGeneration < entry.generation,
    );

  /** Brings every tracked connection that holds an older token up to the current one. */
  function pushBehind(entry: Entry): void {
    if (disposed || entry.pushing !== undefined) return;
    const run = (async () => {
      for (;;) {
        const credential = entry.credential;
        const generation = entry.generation;
        if (
          credential?.kind !== 'bearer' ||
          isExpired(entry, clock.now()) ||
          isDisposed()
        ) {
          return;
        }
        const behind = behindOf(entry);
        if (behind.length === 0) {
          if (entry.pushFailed) {
            entry.pushFailed = false;
            entry.failures = 0;
            entry.retryAt = null;
            entry.problem = null;
            entry.state = 'valid';
            arm(entry);
            publish(entry);
          }
          return;
        }
        let failure: AppError | undefined;
        for (const [protocol, target] of behind) {
          try {
            await pushOne(entry, protocol, credential);
            target.pushedGeneration = Math.max(
              target.pushedGeneration,
              generation,
            );
          } catch {
            // What the connection layer said stays out of the state (I-10).
            failure = new AppError('BROKER_ERROR', {
              detail:
                'The renewed token could not be handed to the live connection.',
            });
          }
        }
        if (failure !== undefined) {
          if (isDisposed()) return;
          const now = clock.now();
          entry.pushFailed = true;
          entry.failures += 1;
          entry.problem = toProblem(failure);
          entry.state = 'failed';
          entry.retryAt =
            now +
            backoffDelayMs(
              entry.failures,
              limits.backoffBaseMs,
              limits.backoffMaxMs,
            );
          armWake(entry);
          publish(entry);
          return;
        }
      }
    })();
    const pushing = run.finally(() => {
      entry.pushing = undefined;
    });
    entry.pushing = pushing;
    trackBackground(pushing);
  }

  function onWake(entry: Entry): void {
    entry.cancelWake = undefined;
    entry.nextWakeAt = null;
    if (disposed || entry.targets.size === 0) return;
    const now = clock.now();
    entry.retryAt = null;
    if (entry.plannedRefreshAt !== null && now >= entry.plannedRefreshAt) {
      refresh(entry, 'scheduled').catch(noop);
    } else if (behindOf(entry).length > 0 || entry.pushFailed) {
      // Also when the connection that failed is gone: the push loop settles the failure.
      pushBehind(entry);
    } else {
      armWake(entry);
    }
  }

  // -- expiry ---------------------------------------------------------------------------------

  function onExpiry(entry: Entry): void {
    entry.cancelExpiry = undefined;
    if (disposed || entry.expiresAt === null) return;
    if (clock.now() < entry.expiresAt) return;
    if (entry.state !== 'username-changed') entry.state = 'expired';
    publish(entry);
    const rule = expiryRuleFor(deps.capabilities(entry.connectionId));
    const hasConnections = [...entry.targets.keys()].some(
      (protocol) => protocol !== 'http',
    );
    if (rule !== 'cancel-own-consumers' || !hasConnections) return;
    const cancelling = guarded(() =>
      auth.cancelOwnConsumers(entry.connectionId, 'token-expired'),
    ).then(
      (result) => {
        // A count that is not a whole number of at least zero is not believed.
        entry.consumersCancelled += Number.isInteger(result.cancelled)
          ? Math.max(0, result.cancelled)
          : 0;
        publish(entry);
      },
      () => {
        if (disposed) return;
        entry.problem = toProblem(
          new AppError('BROKER_ERROR', {
            detail:
              'The engine own consumers could not be cancelled at token expiry.',
          }),
        );
        publish(entry);
      },
    );
    trackBackground(cancelling);
  }

  // -- a 320 close at credential expiry -------------------------------------------------------

  async function handleForcedClose(entry: Entry): Promise<void> {
    let renewed = false;
    try {
      await refresh(entry, 'forced-close');
      renewed = true;
      // The reconnect carries the current token (it asks `credentialFor` for its login).
      const target = entry.targets.get('amqp091');
      if (target !== undefined) {
        target.pushedGeneration = Math.max(
          target.pushedGeneration,
          entry.generation,
        );
      }
      await guarded(() => auth.reconnect(entry.connectionId, 'amqp091'));
    } catch {
      // A failed renewal has recorded itself; a failed reconnect is recorded here.
      if (renewed && !disposed) {
        entry.problem = toProblem(
          new AppError('BROKER_ERROR', {
            detail:
              'The connection could not be reopened with a renewed token.',
          }),
        );
        entry.state = 'failed';
        publish(entry);
      }
    } finally {
      entry.closing = false;
    }
  }

  const stopListeningForClose = auth.onCredentialExpiredClose(
    (connectionId) => {
      if (disposed) return;
      const entry = entries.get(keyOf(connectionId, 'amqp'));
      // Only a connection this manager renews for AMQP 0-9-1 is its concern.
      if (!entry?.targets.has('amqp091')) return;
      const now = clock.now();
      if (
        entry.closing ||
        (entry.lastForcedCloseAt !== null &&
          now - entry.lastForcedCloseAt < limits.minRefreshIntervalMs)
      ) {
        counters.coalescedForcedCloses += 1;
        return;
      }
      entry.lastForcedCloseAt = now;
      entry.closing = true;
      trackBackground(handleForcedClose(entry));
    },
  );

  // -- the public calls -----------------------------------------------------------------------

  /** Waits for `promise`, but not past the caller's own cancellation. */
  const until = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> =>
    raceSignal(promise, signal, cancelled);

  /** The error for a request refused because the last attempt was too recent to repeat. */
  function tooSoon(
    entry: Entry,
    code: AppError['code'],
    detail: string,
  ): AppError {
    return new AppError(
      entry.problem?.code ?? code,
      entry.problem?.detail === undefined
        ? { detail }
        : { detail: entry.problem.detail },
    );
  }

  /**
   * Waits for a renewal on behalf of `credentialFor`. A token that is still good is better than
   * the failure of its renewal, unless the caller itself gave up or the manager is stopping.
   */
  async function waitForRenewal(
    entry: Entry,
    renewal: Promise<ResolvedCredential>,
    signal: AbortSignal,
  ): Promise<ResolvedCredential> {
    try {
      return await until(renewal, signal);
    } catch (error) {
      if (signal.aborted || isDisposed()) throw error;
      if (entry.credential !== undefined && !isExpired(entry, clock.now())) {
        return resolved(entry);
      }
      throw error;
    }
  }

  async function credentialFor(
    connectionId: string,
    protocol: CredentialProtocol,
    signal: AbortSignal,
  ): Promise<ResolvedCredential> {
    assertLive();
    if (signal.aborted) throw cancelled();
    const entry = entryFor(connectionId, protocol);
    if (entry.inflight !== undefined) {
      return waitForRenewal(entry, entry.inflight, signal);
    }
    const now = clock.now();
    if (entry.credential === undefined) {
      try {
        return await until(refresh(entry, 'demand'), signal);
      } finally {
        dropIfEmpty(entry);
      }
    }
    // Only an untracked entry is renewed lazily: a tracked one has its timer.
    const due =
      entry.targets.size === 0 &&
      entry.plannedRefreshAt !== null &&
      now >= entry.plannedRefreshAt &&
      now >= entry.retryNotBefore;
    if (!isExpired(entry, now)) {
      return due
        ? waitForRenewal(entry, refresh(entry, 'demand'), signal)
        : resolved(entry);
    }
    if (now < entry.retryNotBefore) {
      throw tooSoon(
        entry,
        'TOKEN_EXPIRED',
        'The token has expired and was renewed too recently to try again.',
      );
    }
    return until(refresh(entry, 'demand'), signal);
  }

  async function refreshAfterUnauthorized(
    connectionId: string,
    protocol: CredentialProtocol,
    generation: number,
    signal: AbortSignal,
  ): Promise<ResolvedCredential> {
    assertLive();
    if (signal.aborted) throw cancelled();
    const entry = entries.get(keyOf(connectionId, protocol));
    if (entry?.credential === undefined) {
      return credentialFor(connectionId, protocol, signal);
    }
    if (entry.inflight !== undefined) return until(entry.inflight, signal);
    // Another caller already renewed since this one took its token: use that one.
    if (generation !== entry.generation) {
      return credentialFor(connectionId, protocol, signal);
    }
    if (clock.now() < entry.retryNotBefore) {
      throw tooSoon(
        entry,
        'UNAUTHENTICATED',
        'The token was refused again right after it was renewed.',
      );
    }
    return until(refresh(entry, 'unauthorized'), signal);
  }

  function track(target: {
    readonly connectionId: string;
    readonly protocol: RenewalProtocol;
    readonly generation?: number;
  }): { release(): void } {
    assertLive();
    const entry = entryFor(
      target.connectionId,
      credentialProtocolOf(target.protocol),
    );
    const known = entry.targets.get(target.protocol);
    const held = target.generation ?? entry.generation;
    const slot: Target = known ?? { count: 0, pushedGeneration: held };
    if (known !== undefined) {
      slot.pushedGeneration = Math.min(slot.pushedGeneration, held);
    } else {
      entry.targets.set(target.protocol, slot);
    }
    slot.count += 1;
    arm(entry);
    if (behindOf(entry).length > 0) pushBehind(entry);
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        slot.count -= 1;
        if (slot.count === 0 && entry.targets.get(target.protocol) === slot) {
          entry.targets.delete(target.protocol);
        }
        if (entry.targets.size === 0) disarm(entry);
      },
    };
  }

  function dispose(): Promise<void> {
    if (disposing !== undefined) return disposing;
    disposed = true;
    stopListeningForClose();
    shutdown.abort(shuttingDown());
    for (const controller of [...controllers]) controller.abort(shuttingDown());
    for (const entry of entries.values()) disarm(entry);
    listeners.clear();
    disposing = Promise.allSettled([...background]).then(() => {
      entries.clear();
    });
    return disposing;
  }

  return {
    credentialFor,
    track,
    refreshAfterUnauthorized,
    state(connectionId, protocol) {
      const entry = entries.get(keyOf(connectionId, protocol));
      return entry === undefined ? undefined : snapshot(entry);
    },
    subscribe(listener) {
      assertLive();
      if (listeners.size >= limits.maxListeners) {
        counters.refusedListeners += 1;
        throw new AppError('BUDGET_EXCEEDED', {
          detail: 'The identity service has as many listeners as it allows.',
        });
      }
      const slot = { call: listener };
      listeners.add(slot);
      return () => {
        listeners.delete(slot);
      };
    },
    stats() {
      return {
        entries: entries.size,
        listeners: listeners.size,
        inflightRefreshes: [...entries.values()].filter(
          (entry) => entry.inflight !== undefined,
        ).length,
        pendingOperations: controllers.size,
        pendingTasks: background.size,
        ...counters,
      };
    },
    dispose,
  };
}
