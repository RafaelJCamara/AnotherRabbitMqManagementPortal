// M1-23 slice C: the TokenManager (AC-9 to AC-17). Time is the kernel's manual clock and manual
// timers, so nothing here sleeps: `timers.advance(ms)` runs every timer that falls due, in order.
import util from 'node:util';

import {
  AppError,
  createCanaryScanner,
  createManualClock,
  createManualTimers,
  type Timers,
} from '@app/kernel';
import type {
  ConnectionAuthPort,
  CredentialProtocol,
  RenewalProtocol,
} from '@app/ports';
import { describe, expect, it } from 'vitest';

import { SecretValue } from './internal/secret-value';
import type { CredentialProvider, IssuedCredential } from './provider';
import { isRetryableAfter401 } from './retry-policy';
import {
  DEFAULT_TOKEN_MANAGER_LIMITS,
  createTokenManager,
  type RenewalCapabilities,
  type TokenManager,
  type TokenManagerLimits,
  type TokenState,
} from './token-manager';

const signal = new AbortController().signal;
const SECOND = 1000;
const LIFETIME = 1_000 * SECOND; // the token of AC-9: iat 0, exp 1,000 s

type Bearer = Extract<IssuedCredential, { kind: 'bearer' }>;

function bearer(input: {
  n: number;
  iat: number;
  exp: number | null;
  username?: string | null;
}): Bearer {
  return {
    kind: 'bearer',
    token: new SecretValue(`token-${String(input.n)}`),
    issuedAt: input.iat,
    expiresAt: input.exp,
    username: input.username === undefined ? 'alice' : input.username,
  };
}

const reveal = (credential: IssuedCredential): string => {
  if (credential.kind !== 'bearer') throw new Error('not a bearer credential');
  return credential.token.reveal();
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface AuthCall {
  readonly method: string;
  readonly id: string;
  readonly arg?: string;
}

interface Harness {
  readonly clock: ReturnType<typeof createManualClock>;
  readonly timers: ReturnType<typeof createManualTimers>;
  readonly manager: TokenManager;
  readonly provider: { calls: number };
  readonly auth: {
    calls: AuthCall[];
    reasons: string[];
    cancelResult: { cancelled: number };
    updateSecretFailures: number;
    updateSecretGate: Promise<void> | undefined;
    listening(): boolean;
    emitClose(connectionId: string): void;
    onReconnect: (id: string, protocol: RenewalProtocol) => Promise<void>;
    onCancel: () => Promise<{ cancelled: number }>;
  };
  readonly caps: RenewalCapabilities;
  readonly states: TokenState[];
}

/**
 * A manager wired to fakes. `script(call)` is the n-th provider answer (1-based); the default is a
 * fresh token that lives `lifetimeMs` from now, for `alice`.
 */
function harness(
  options: {
    lifetimeMs?: number;
    script?: (
      call: number,
      now: number,
      request: { connectionId: string; protocol: CredentialProtocol },
    ) => IssuedCredential | Promise<IssuedCredential>;
    caps?: Partial<RenewalCapabilities>;
    capabilities?: (connectionId: string) => RenewalCapabilities;
    limits?: Partial<TokenManagerLimits>;
    withPutAuthToken?: boolean;
    timers?: (inner: Timers) => Timers;
  } = {},
): Harness {
  const clock = createManualClock(0);
  const timers = createManualTimers(clock);
  const lifetime = options.lifetimeMs ?? LIFETIME;
  const provider = { calls: 0 };
  const credentialProvider: CredentialProvider = {
    kind: 'client-credentials',
    acquire: (request) => {
      provider.calls += 1;
      const now = clock.now();
      return Promise.resolve(
        (
          options.script ??
          ((n, at) => bearer({ n, iat: at, exp: at + lifetime }))
        )(provider.calls, now, request),
      );
    },
  };
  const calls: AuthCall[] = [];
  let closeListener: ((id: string) => void) | undefined;
  const auth: Harness['auth'] = {
    calls,
    reasons: [],
    cancelResult: { cancelled: 0 },
    updateSecretFailures: 0,
    updateSecretGate: undefined,
    listening: () => closeListener !== undefined,
    emitClose: (id) => closeListener?.(id),
    onReconnect: () => Promise.resolve(),
    onCancel: () => Promise.resolve(auth.cancelResult),
  };
  const port: ConnectionAuthPort = {
    updateSecret: (id, secret, reason) => {
      auth.reasons.push(reason);
      calls.push({ method: 'updateSecret', id, arg: secret });
      if (auth.updateSecretFailures > 0) {
        auth.updateSecretFailures -= 1;
        return Promise.reject(new Error('the broker said no'));
      }
      return auth.updateSecretGate ?? Promise.resolve();
    },
    reconnect: (id, protocol) => {
      calls.push({ method: 'reconnect', id, arg: protocol });
      return auth.onReconnect(id, protocol);
    },
    cancelOwnConsumers: (id, reason) => {
      calls.push({ method: 'cancelOwnConsumers', id, arg: reason });
      return auth.onCancel();
    },
    onCredentialExpiredClose: (listener) => {
      closeListener = listener;
      return () => {
        closeListener = undefined;
      };
    },
    ...(options.withPutAuthToken === true
      ? {
          putAuthToken: (id: string, token: string) => {
            calls.push({ method: 'putAuthToken', id, arg: token });
            return Promise.resolve();
          },
        }
      : {}),
  };
  const caps: RenewalCapabilities = {
    amqp10TokenRenewalEndpoint: false,
    amqp091ClosesAtCredentialExpiry: false,
    ...options.caps,
  };
  const manager = createTokenManager({
    providers: { providerFor: () => Promise.resolve(credentialProvider) },
    auth: port,
    capabilities: options.capabilities ?? (() => caps),
    clock,
    timers: options.timers === undefined ? timers : options.timers(timers),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  const states: TokenState[] = [];
  manager.subscribe((state) => states.push(state));
  return { clock, timers, manager, provider, auth, caps, states };
}

const credentialFor = (
  h: Harness,
  id = 'c1',
  protocol: CredentialProtocol = 'amqp',
) => h.manager.credentialFor(id, protocol, signal);

/** Resolves the first token and registers an AMQP 0-9-1 connection for renewal. */
async function started(
  h: Harness,
  protocol: RenewalProtocol = 'amqp091',
): Promise<{ release(): void }> {
  const credentialProtocol: CredentialProtocol =
    protocol === 'http' ? 'http' : 'amqp';
  await credentialFor(h, 'c1', credentialProtocol);
  return h.manager.track({ connectionId: 'c1', protocol });
}

const stateOf = (h: Harness, protocol: CredentialProtocol = 'amqp') =>
  h.manager.state('c1', protocol);

function syncFailure(call: () => unknown): AppError {
  try {
    call();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('expected a throw');
}

async function failureOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('expected a rejection');
}

describe('TokenManager renewal', () => {
  it('M1-23 AC-9 token manager refreshes at 75 percent of the lifetime and not before', async () => {
    const h = harness();
    await started(h);
    expect(h.provider.calls).toBe(1);
    expect(stateOf(h)?.nextRefreshAt).toBe(750 * SECOND);
    expect(stateOf(h)?.expiresAt).toBe(LIFETIME);

    await h.timers.advance(749_999);
    expect(h.provider.calls).toBe(1);
    await h.timers.advance(1); // 750 s
    expect(h.provider.calls).toBe(2);
    expect(stateOf(h)?.state).toBe('valid');
    // The next point is 75 % of the new token's lifetime, counted from its own issue time.
    expect(stateOf(h)?.nextRefreshAt).toBe(750 * SECOND + 750 * SECOND);
    await h.timers.advance(749_999);
    expect(h.provider.calls).toBe(2);
    await h.timers.advance(1);
    expect(h.provider.calls).toBe(3);
  });

  it('M1-23 AC-10 token manager single-flights refreshes and ignores a stale 401', async () => {
    const gate = deferred<IssuedCredential>();
    const h = harness({
      script: (n, now) =>
        n === 2 ? gate.promise : bearer({ n, iat: now, exp: now + LIFETIME }),
    });
    const first = await credentialFor(h);
    expect(first.generation).toBe(1);
    h.manager.track({ connectionId: 'c1', protocol: 'amqp091' });
    await h.timers.advance(750 * SECOND);
    expect(h.provider.calls).toBe(2); // the renewal is in flight
    expect(stateOf(h)?.state).toBe('refreshing');

    const a = credentialFor(h);
    const b = credentialFor(h);
    const c = h.manager.refreshAfterUnauthorized('c1', 'amqp', 1, signal);
    await h.timers.settle();
    expect(h.provider.calls).toBe(2); // one provider call serves all three

    gate.resolve(
      bearer({ n: 2, iat: 750 * SECOND, exp: 750 * SECOND + LIFETIME }),
    );
    const results = await Promise.all([a, b, c]);
    for (const result of results) {
      expect(result.generation).toBe(2); // it went up once
      expect(reveal(result.credential)).toBe('token-2');
    }
    expect(h.provider.calls).toBe(2);

    // A 401 that carries the generation before the renewal, or one nobody issued, is a no-op.
    for (const stale of [1, 99, 0]) {
      const again = await h.manager.refreshAfterUnauthorized(
        'c1',
        'amqp',
        stale,
        signal,
      );
      expect(again.generation).toBe(2);
    }
    expect(h.provider.calls).toBe(2);
  });

  it('M1-23 AC-11 token manager refuses a refreshed token whose username claim changed', async () => {
    const cases: {
      second: (now: number) => Bearer;
      state: string;
    }[] = [
      {
        second: (now) =>
          bearer({ n: 2, iat: now, exp: now + LIFETIME, username: 'bob' }),
        state: 'username-changed',
      },
      {
        second: (now) =>
          bearer({ n: 2, iat: now, exp: now + LIFETIME, username: null }),
        state: 'failed',
      },
    ];
    for (const { second, state } of cases) {
      const h = harness({
        script: (n, now) =>
          n === 1 ? bearer({ n, iat: now, exp: now + LIFETIME }) : second(now),
      });
      await started(h);
      await h.timers.advance(750 * SECOND);
      expect(h.provider.calls).toBe(2);
      // Neither refreshed token reaches the connection.
      expect(h.auth.calls).toEqual([]);
      expect(stateOf(h)?.state).toBe(state);
      expect(stateOf(h)?.problem?.code).toBe('UNAUTHENTICATED');
      // The old token keeps being used, and no retry loop starts.
      const used = await credentialFor(h);
      expect(reveal(used.credential)).toBe('token-1');
      expect(used.generation).toBe(1);
      await h.timers.advance(240 * SECOND); // to 990 s, still before the expiry
      expect(h.provider.calls).toBe(2);
      // Past its point and asked for again: still the old token, and no lazy renewal.
      expect(reveal((await credentialFor(h)).credential)).toBe('token-1');
      expect(h.provider.calls).toBe(2);
      expect(h.auth.calls).toEqual([]);
      expect(stateOf(h)?.nextRefreshAt).toBeNull();
      // After its own expiry the token is gone; a new request is refused again, not looped.
      await h.timers.advance(20 * SECOND);
      expect(h.provider.calls).toBe(2);
      const error = await failureOf(credentialFor(h));
      expect(error.code).toBe('UNAUTHENTICATED');
      expect(h.provider.calls).toBe(3);
    }
  });

  it('M1-23 AC-12 token manager renews each protocol its own way', async () => {
    interface Row {
      protocol: RenewalProtocol;
      caps: Partial<RenewalCapabilities>;
      putAuthToken: boolean;
      expected: AuthCall[];
    }
    const rows: Row[] = [
      {
        protocol: 'amqp091',
        caps: {},
        putAuthToken: false,
        expected: [{ method: 'updateSecret', id: 'c1', arg: 'token-2' }],
      },
      {
        protocol: 'amqp10',
        caps: { amqp10TokenRenewalEndpoint: true },
        putAuthToken: true,
        expected: [{ method: 'putAuthToken', id: 'c1', arg: 'token-2' }],
      },
      {
        protocol: 'amqp10',
        caps: { amqp10TokenRenewalEndpoint: false },
        putAuthToken: true,
        expected: [{ method: 'reconnect', id: 'c1', arg: 'amqp10' }],
      },
      {
        // The capability holds but no sink exists yet: reconnect, never nothing.
        protocol: 'amqp10',
        caps: { amqp10TokenRenewalEndpoint: true },
        putAuthToken: false,
        expected: [{ method: 'reconnect', id: 'c1', arg: 'amqp10' }],
      },
      {
        protocol: 'stream',
        caps: { amqp10TokenRenewalEndpoint: true },
        putAuthToken: true,
        expected: [{ method: 'reconnect', id: 'c1', arg: 'stream' }],
      },
      { protocol: 'http', caps: {}, putAuthToken: false, expected: [] },
    ];
    for (const row of rows) {
      const h = harness({ caps: row.caps, withPutAuthToken: row.putAuthToken });
      const credentialProtocol: CredentialProtocol =
        row.protocol === 'http' ? 'http' : 'amqp';
      // A reconnect asks for its login while the manager is still pushing: it must not wait on it.
      let loginDuringReconnect: string | undefined;
      h.auth.onReconnect = async () => {
        const login = await h.manager.credentialFor(
          'c1',
          credentialProtocol,
          signal,
        );
        loginDuringReconnect = reveal(login.credential);
      };
      await started(h, row.protocol);
      await h.timers.advance(750 * SECOND);
      expect(h.provider.calls).toBe(2);
      expect(h.auth.calls).toEqual(row.expected);
      if (row.expected[0]?.method === 'updateSecret') {
        expect(h.auth.reasons).toEqual(['token refresh']); // fixed, and not the token
      }
      if (row.expected[0]?.method === 'reconnect') {
        expect(loginDuringReconnect).toBe('token-2');
      }
      // HTTP has nothing to push: the next request simply gets the new token.
      const next = await credentialFor(h, 'c1', credentialProtocol);
      expect(reveal(next.credential)).toBe('token-2');
      expect(stateOf(h, credentialProtocol)?.state).toBe('valid');
    }
  });

  it('M1-23 AC-13 token manager cancels its own consumers at expiry when the broker will not close the connection', async () => {
    const refreshFails = (n: number, now: number): Promise<IssuedCredential> =>
      n === 1
        ? Promise.resolve(bearer({ n, iat: now, exp: now + LIFETIME }))
        : Promise.reject(
            new AppError('BROKER_UNREACHABLE', { detail: 'down' }),
          );

    // The broker does not close at expiry (4.2.5 or earlier, or not proven above it).
    const h = harness({ script: refreshFails });
    h.auth.cancelResult = { cancelled: 3 };
    await started(h);
    await h.timers.advance(LIFETIME - 1);
    expect(
      h.auth.calls.filter((c) => c.method === 'cancelOwnConsumers'),
    ).toEqual([]);
    expect(stateOf(h)?.state).toBe('failed');
    await h.timers.advance(1);
    expect(h.auth.calls).toEqual([
      { method: 'cancelOwnConsumers', id: 'c1', arg: 'token-expired' },
    ]);
    expect(stateOf(h)?.state).toBe('expired');
    expect(stateOf(h)?.consumersCancelled).toBe(3); // counted, and published
    expect(h.states.at(-1)?.consumersCancelled).toBe(3);
    await h.timers.advance(3_600 * SECOND);
    expect(h.auth.calls.length).toBe(1); // once

    // A refresh that succeeded replaces the expiry: nothing is cancelled at the old one.
    const ok = harness();
    ok.auth.cancelResult = { cancelled: 3 };
    await started(ok);
    await ok.timers.advance(LIFETIME + 1);
    expect(
      ok.auth.calls.filter((c) => c.method === 'cancelOwnConsumers'),
    ).toEqual([]);
    expect(stateOf(ok)?.consumersCancelled).toBe(0);

    // A broker that closes by itself (4.2.6 or later): the engine cancels nothing.
    const closes = harness({
      script: refreshFails,
      caps: { amqp091ClosesAtCredentialExpiry: true },
    });
    closes.auth.cancelResult = { cancelled: 3 };
    await started(closes);
    await closes.timers.advance(LIFETIME + 1);
    expect(closes.auth.calls).toEqual([]);
    expect(stateOf(closes)?.state).toBe('expired');

    // Only HTTP is tracked: there are no connections to cancel on.
    const http = harness({ script: refreshFails });
    await started(http, 'http');
    await http.timers.advance(LIFETIME + 1);
    expect(http.auth.calls).toEqual([]);
    expect(stateOf(http, 'http')?.state).toBe('expired');

    // A count that is not a positive whole number is not added.
    for (const cancelled of [-4, 2.5, Number.NaN, 0]) {
      const odd = harness({ script: refreshFails });
      odd.auth.cancelResult = { cancelled };
      await started(odd);
      await odd.timers.advance(LIFETIME);
      expect(odd.auth.calls.map((c) => c.method)).toEqual([
        'cancelOwnConsumers',
      ]);
      expect(stateOf(odd)?.consumersCancelled).toBe(0);
    }
  });

  it('M1-23 AC-14 token manager rides through a credential-expired close on 4.2.6 and later', async () => {
    const h = harness({ caps: { amqp091ClosesAtCredentialExpiry: true } });
    let loginAtReconnect: string | undefined;
    h.auth.onReconnect = async () => {
      // The connection layer asks for its login while reconnecting.
      const login = await credentialFor(h);
      loginAtReconnect = reveal(login.credential);
    };
    await started(h);
    await h.timers.advance(10 * SECOND);

    h.auth.emitClose('c1');
    await h.timers.settle();
    expect(h.provider.calls).toBe(2); // a freshly acquired token
    expect(h.auth.calls).toEqual([
      { method: 'reconnect', id: 'c1', arg: 'amqp091' },
    ]);
    expect(loginAtReconnect).toBe('token-2');

    // A second close inside the floor (5 s) is coalesced, and counted.
    await h.timers.advance(4_999);
    h.auth.emitClose('c1');
    await h.timers.settle();
    expect(h.provider.calls).toBe(2);
    expect(h.auth.calls.length).toBe(1);
    expect(h.manager.stats().coalescedForcedCloses).toBe(1);
    // At the floor it is handled again.
    await h.timers.advance(1);
    h.auth.emitClose('c1');
    await h.timers.settle();
    expect(h.provider.calls).toBe(3);
    expect(h.auth.calls.length).toBe(2);

    // The engine cancelled nothing itself and the state never showed a failure.
    expect(h.auth.calls.some((c) => c.method === 'cancelOwnConsumers')).toBe(
      false,
    );
    expect(h.states.length).toBeGreaterThan(0);
    for (const state of h.states) {
      expect(['valid', 'refreshing']).toContain(state.state);
    }

    // Not a connection this manager renews over AMQP 0-9-1: ignored.
    h.auth.emitClose('nobody');
    await h.timers.settle();
    expect(h.provider.calls).toBe(3);
  });

  it('M1-23 AC-15 token manager backs off, expires honestly and leaves no timer behind', async () => {
    const h = harness({
      script: (n, now) =>
        n === 1
          ? bearer({ n, iat: now, exp: now + LIFETIME })
          : Promise.reject(
              new AppError('BROKER_UNREACHABLE', { detail: 'down' }),
            ),
    });
    h.auth.cancelResult = { cancelled: 1 };
    await started(h);
    // [time, provider calls at that time]: attempts at 750, +2, +4, +8, +16, +32, +60, +60 s.
    const timeline: [number, number][] = [
      [749_999, 1],
      [750_000, 2],
      [751_999, 2],
      [752_000, 3],
      [755_999, 3],
      [756_000, 4],
      [763_999, 4],
      [764_000, 5],
      [779_999, 5],
      [780_000, 6],
      [811_999, 6],
      [812_000, 7],
      [871_999, 7],
      [872_000, 8],
      [931_999, 8],
      [932_000, 9], // the 8th attempt: the cap
      [999_999, 9],
    ];
    for (const [at, calls] of timeline) {
      await h.timers.advance(at - h.clock.now());
      expect(h.provider.calls, `calls at ${String(at)} ms`).toBe(calls);
    }
    expect(stateOf(h)?.state).toBe('failed');
    expect(stateOf(h)?.problem?.code).toBe('BROKER_UNREACHABLE');
    expect(stateOf(h)?.nextRefreshAt).toBeNull();
    expect(
      h.states.some(
        (state) =>
          state.state === 'failed' &&
          state.problem?.code === 'BROKER_UNREACHABLE',
      ),
    ).toBe(true);

    await h.timers.advance(1); // exp
    expect(stateOf(h)?.state).toBe('expired');
    expect(stateOf(h)?.problem?.code).toBe('BROKER_UNREACHABLE');
    expect(h.auth.calls).toEqual([
      { method: 'cancelOwnConsumers', id: 'c1', arg: 'token-expired' },
    ]);
    await h.timers.advance(3_600 * SECOND);
    expect(h.provider.calls).toBe(9); // no attempt past the cap
    expect(h.timers.pending()).toBe(0);
    expect(h.manager.stats().pendingOperations).toBe(0);
    await h.manager.dispose();
    expect(h.timers.pending()).toBe(0);
  });

  it('M1-23 AC-16 token manager is bounded and counts what it refuses', async () => {
    const h = harness({ limits: { maxEntries: 2, maxListeners: 2 } });
    // `harness` already holds one listener; two entries fill the cap.
    await credentialFor(h, 'a');
    await credentialFor(h, 'b');
    const trackA = h.manager.track({ connectionId: 'a', protocol: 'amqp091' });
    h.manager.track({ connectionId: 'b', protocol: 'amqp091' });
    expect(h.manager.stats().entries).toBe(2);

    // Tracked entries cannot be evicted: a new connection is refused.
    expect((await failureOf(credentialFor(h, 'c'))).code).toBe(
      'BUDGET_EXCEEDED',
    );
    expect(
      syncFailure(() =>
        h.manager.track({ connectionId: 'd', protocol: 'stream' }),
      ).code,
    ).toBe('BUDGET_EXCEEDED');
    expect(h.manager.stats().refusedEntries).toBe(2);
    expect(h.manager.stats().entries).toBe(2);
    expect(h.provider.calls).toBe(2); // the refusal happened before any provider call

    // Listeners: one more fits, the next is refused and counted.
    const off = h.manager.subscribe(() => undefined);
    expect(syncFailure(() => h.manager.subscribe(() => undefined)).code).toBe(
      'BUDGET_EXCEEDED',
    );
    expect(h.manager.stats()).toMatchObject({
      listeners: 2,
      refusedListeners: 1,
    });
    off();
    expect(h.manager.stats().listeners).toBe(1);

    // An entry nobody tracks is idle and makes room, oldest first; it is counted.
    trackA.release();
    await credentialFor(h, 'c');
    expect(h.manager.stats()).toMatchObject({ entries: 2, evictedEntries: 1 });
    expect(h.manager.state('a', 'amqp')).toBeUndefined();
    expect(h.manager.state('b', 'amqp')).toBeDefined();
    expect(h.manager.state('c', 'amqp')).toBeDefined();

    // Provider calls are bounded in concurrency: with 1 slot the second waits for the first.
    const gates = [deferred<IssuedCredential>(), deferred<IssuedCredential>()];
    const slow = harness({
      limits: { maxConcurrentAcquires: 1 },
      script: (n) =>
        gates[n - 1]?.promise ?? Promise.reject(new Error('no gate')),
    });
    const one = credentialFor(slow, 'x');
    const two = credentialFor(slow, 'y');
    await slow.timers.settle();
    expect(slow.provider.calls).toBe(1);
    gates[0]?.resolve(bearer({ n: 1, iat: 0, exp: LIFETIME }));
    await one;
    await slow.timers.settle();
    expect(slow.provider.calls).toBe(2);
    gates[1]?.resolve(bearer({ n: 2, iat: 0, exp: LIFETIME }));
    await two;

    // A listener that throws is counted and does not stop the others.
    const seen: string[] = [];
    const noisy = harness();
    noisy.manager.subscribe(() => {
      throw new Error('listener bug');
    });
    noisy.manager.subscribe((state) => seen.push(state.state));
    await credentialFor(noisy);
    expect(seen).toEqual(['valid']);
    expect(noisy.manager.stats().listenerErrors).toBe(1);
  });

  it('M1-23 AC-17 only idempotent reads are retried after a 401', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get', 'Head']) {
      expect(isRetryableAfter401(method), method).toBe(true);
    }
    for (const method of [
      'POST',
      'DELETE',
      'PUT',
      'PATCH',
      '',
      'GETX',
      'XGET',
    ]) {
      expect(isRetryableAfter401(method), method).toBe(false);
    }
  });
});

describe('TokenManager edges (slice C)', () => {
  it('M1-23 slice C a future iat is read as now and a token with no exp is not scheduled', async () => {
    // iat 500 s ahead, exp 1,000 s: the point is 75 % of 1,000 s from now, not of 500 s.
    const future = harness({
      script: (n) => bearer({ n, iat: 500 * SECOND, exp: LIFETIME }),
    });
    await started(future);
    expect(stateOf(future)?.nextRefreshAt).toBe(750 * SECOND);
    await future.timers.advance(749_999);
    expect(future.provider.calls).toBe(1);

    // No exp: no refresh timer, no expiry timer, and the same token for as long as it is asked.
    const forever = harness({
      script: (n) => bearer({ n, iat: 0, exp: null }),
    });
    await started(forever);
    expect(forever.timers.pending()).toBe(0);
    expect(stateOf(forever)).toMatchObject({
      state: 'valid',
      expiresAt: null,
      nextRefreshAt: null,
    });
    await forever.timers.advance(10_000 * SECOND);
    const again = await credentialFor(forever);
    expect(forever.provider.calls).toBe(1);
    expect(again.generation).toBe(1);
    expect(forever.auth.calls).toEqual([]);
    expect(stateOf(forever)?.state).toBe('valid');
  });

  it('M1-23 slice C a token already past its point is renewed after the floor, not in a loop', async () => {
    // Issued long ago, 10 s left: due at once, but not before 5 s after the start.
    const h = harness({
      script: (n, now) =>
        n === 1
          ? bearer({ n, iat: -100_000_000, exp: now + 10 * SECOND })
          : bearer({ n, iat: now, exp: now + LIFETIME }),
    });
    await started(h);
    await h.timers.advance(4_999);
    expect(h.provider.calls).toBe(1);
    await h.timers.advance(1);
    expect(h.provider.calls).toBe(2);
  });

  it('M1-23 slice C a token expired on arrival is refused and leaves no entry behind', async () => {
    const h = harness({ script: (n, now) => bearer({ n, iat: 0, exp: now }) });
    expect((await failureOf(credentialFor(h))).code).toBe('TOKEN_EXPIRED');
    expect(h.manager.stats().entries).toBe(0);
    expect(h.timers.pending()).toBe(0);
    const unknown = harness({ script: () => Promise.reject(new Error('x')) });
    expect((await failureOf(credentialFor(unknown))).code).toBe('INTERNAL');
  });

  it('M1-23 slice C a retry is not made when it would land on or after the expiry', async () => {
    // 100 s token: refresh at 75 s, retries at +2 (77), +4 (81), +8 (89), and +16 (105) is past exp.
    const h = harness({
      lifetimeMs: 100 * SECOND,
      script: (n, now) =>
        n === 1
          ? bearer({ n, iat: now, exp: now + 100 * SECOND })
          : Promise.reject(new AppError('BROKER_UNREACHABLE')),
    });
    await started(h);
    await h.timers.advance(99_999);
    expect(h.provider.calls).toBe(5);
    expect(stateOf(h)?.nextRefreshAt).toBeNull();
    await h.timers.advance(1);
    expect(stateOf(h)?.state).toBe('expired');
    expect(h.provider.calls).toBe(5);
    // A retry that would fall exactly on the expiry is not made either: 120 s token, attempts at
    // 90, 92, 96 and 104 s, and the next would be at 120 s.
    const edge = harness({
      lifetimeMs: 120 * SECOND,
      script: (n, now) =>
        n === 1
          ? bearer({ n, iat: now, exp: now + 120 * SECOND })
          : Promise.reject(new AppError('BROKER_UNREACHABLE')),
    });
    await started(edge);
    await edge.timers.advance(120 * SECOND);
    expect(edge.provider.calls).toBe(5);
  });

  it('M1-23 slice C a push the connection refused is retried without asking the provider again', async () => {
    const h = harness();
    h.auth.updateSecretFailures = 2;
    await started(h);
    await h.timers.advance(750 * SECOND);
    expect(h.provider.calls).toBe(2);
    expect(h.auth.calls.length).toBe(1);
    expect(stateOf(h)?.state).toBe('failed');
    expect(stateOf(h)?.problem?.code).toBe('BROKER_ERROR');
    // The new token is already the current one for everybody else.
    expect(reveal((await credentialFor(h)).credential)).toBe('token-2');
    await h.timers.advance(1_999);
    expect(h.auth.calls.length).toBe(1);
    await h.timers.advance(1); // +2 s
    expect(h.auth.calls.length).toBe(2);
    await h.timers.advance(3_999);
    expect(h.auth.calls.length).toBe(2);
    await h.timers.advance(1); // +4 s
    expect(h.auth.calls.length).toBe(3);
    expect(h.auth.calls.every((c) => c.arg === 'token-2')).toBe(true);
    expect(h.provider.calls).toBe(2); // push only
    expect(stateOf(h)).toMatchObject({ state: 'valid', problem: null });
    await h.timers.advance(1_000 * SECOND);
    expect(h.auth.calls.length).toBe(4); // the next scheduled refresh, pushed once
  });

  it('M1-23 slice C a connection that logged in with an older generation is brought up to date', async () => {
    const h = harness();
    const first = await credentialFor(h);
    await h.timers.advance(5_000);
    await h.manager.refreshAfterUnauthorized(
      'c1',
      'amqp',
      first.generation,
      signal,
    );
    expect(h.provider.calls).toBe(2);
    h.manager.track({
      connectionId: 'c1',
      protocol: 'amqp091',
      generation: first.generation,
    });
    await h.timers.settle();
    expect(h.auth.calls).toEqual([
      { method: 'updateSecret', id: 'c1', arg: 'token-2' },
    ]);
    // Without a generation the connection is taken to hold the current token.
    const other = harness();
    await credentialFor(other);
    other.manager.track({ connectionId: 'c1', protocol: 'amqp091' });
    await other.timers.settle();
    expect(other.auth.calls).toEqual([]);
  });

  it('M1-23 slice C a connection tracked before its first token is not pushed that token', async () => {
    const h = harness();
    h.manager.track({ connectionId: 'c1', protocol: 'amqp091' });
    expect(h.manager.state('c1', 'amqp')).toBeDefined();
    await credentialFor(h);
    await h.timers.settle();
    expect(h.auth.calls).toEqual([]);
    expect(stateOf(h)?.nextRefreshAt).toBe(750 * SECOND); // and it is on a timer now
  });

  it('M1-23 slice C a 401 right after a renewal is refused until the floor has passed', async () => {
    const h = harness();
    const first = await credentialFor(h);
    const tooSoon = await failureOf(
      h.manager.refreshAfterUnauthorized(
        'c1',
        'amqp',
        first.generation,
        signal,
      ),
    );
    expect(tooSoon.code).toBe('UNAUTHENTICATED');
    expect(h.provider.calls).toBe(1);
    await h.timers.advance(4_999);
    await failureOf(
      h.manager.refreshAfterUnauthorized(
        'c1',
        'amqp',
        first.generation,
        signal,
      ),
    );
    expect(h.provider.calls).toBe(1);
    await h.timers.advance(1);
    const second = await h.manager.refreshAfterUnauthorized(
      'c1',
      'amqp',
      first.generation,
      signal,
    );
    expect(h.provider.calls).toBe(2);
    expect(second.generation).toBe(2);
    // With no entry at all a 401 is just a first request.
    const fresh = await h.manager.refreshAfterUnauthorized(
      'other',
      'amqp',
      7,
      signal,
    );
    expect(fresh.generation).toBe(3);
    expect(h.provider.calls).toBe(3);
  });

  it('M1-23 slice C an untracked token is renewed lazily and keeps a good token when the renewal fails', async () => {
    const h = harness({
      script: (n, now) =>
        n === 2
          ? Promise.reject(
              new AppError('BROKER_UNREACHABLE', { detail: 'down' }),
            )
          : bearer({ n, iat: now, exp: now + LIFETIME }),
    });
    await credentialFor(h, 'c1', 'http');
    expect(h.timers.pending()).toBe(0); // nobody tracks it: no timer at all
    await h.timers.advance(749_999);
    expect(reveal((await credentialFor(h, 'c1', 'http')).credential)).toBe(
      'token-1',
    );
    expect(h.provider.calls).toBe(1);
    await h.timers.advance(1); // 750 s: due
    const kept = await credentialFor(h, 'c1', 'http');
    expect(h.provider.calls).toBe(2);
    expect(reveal(kept.credential)).toBe('token-1'); // the renewal failed, the token is good
    expect(stateOf(h, 'http')?.state).toBe('failed');
    // Inside the backoff the provider is not asked again.
    await credentialFor(h, 'c1', 'http');
    expect(h.provider.calls).toBe(2);
    // On demand the floor (5 s from the start of the failed attempt) outlasts the 2 s backoff.
    await h.timers.advance(4_999);
    await credentialFor(h, 'c1', 'http');
    expect(h.provider.calls).toBe(2);
    await h.timers.advance(1);
    const renewed = await credentialFor(h, 'c1', 'http');
    expect(h.provider.calls).toBe(3);
    expect(reveal(renewed.credential)).toBe('token-3');
    expect(h.timers.pending()).toBe(0);
    // Past the expiry a failed renewal is the caller's failure, and no token is handed out.
    const dead = harness({
      script: (n, now) =>
        n === 1
          ? bearer({ n, iat: now, exp: now + 10 * SECOND })
          : Promise.reject(
              new AppError('BROKER_UNREACHABLE', { detail: 'down' }),
            ),
    });
    await credentialFor(dead);
    await dead.timers.advance(10 * SECOND);
    expect((await failureOf(credentialFor(dead))).code).toBe(
      'BROKER_UNREACHABLE',
    );
    // ...and the next call inside the backoff is refused without a provider call.
    const calls = dead.provider.calls;
    expect((await failureOf(credentialFor(dead))).code).toBe(
      'BROKER_UNREACHABLE',
    );
    expect(dead.provider.calls).toBe(calls);
  });

  it('M1-23 slice C a refreshed token that is not later than the one it replaces is refused, and a changed kind too', async () => {
    const h = harness({
      script: (n, now) =>
        n === 2
          ? bearer({ n, iat: now, exp: LIFETIME }) // same exp as token-1
          : bearer({ n, iat: now, exp: now + LIFETIME }),
    });
    await started(h);
    await h.timers.advance(750 * SECOND);
    expect(h.provider.calls).toBe(2);
    expect(stateOf(h)?.state).toBe('failed');
    expect(stateOf(h)?.problem?.code).toBe('VALIDATION_FAILED');
    expect(h.auth.calls).toEqual([]);
    await h.timers.advance(2 * SECOND);
    expect(h.provider.calls).toBe(3); // retried after the backoff
    expect(stateOf(h)?.state).toBe('valid');
    expect(h.auth.calls.length).toBe(1);

    const kind = harness({
      script: (n, now) =>
        n === 1
          ? bearer({ n, iat: now, exp: now + LIFETIME })
          : { kind: 'external' },
    });
    await started(kind);
    await kind.timers.advance(750 * SECOND);
    expect(stateOf(kind)?.state).toBe('failed');
    expect(stateOf(kind)?.problem?.code).toBe('VALIDATION_FAILED');
    expect(kind.auth.calls).toEqual([]);

    // A password has no lifetime: it is returned as it is, and never scheduled.
    const password = harness({
      script: () => ({
        kind: 'password',
        username: 'u',
        password: new SecretValue('pw'),
      }),
    });
    await started(password);
    expect(password.timers.pending()).toBe(0);
    expect(stateOf(password)).toMatchObject({
      state: 'valid',
      expiresAt: null,
    });
  });

  it('M1-23 slice C timers longer than the platform allows are made in steps and a clock set back re-arms them', async () => {
    const delays: number[] = [];
    const long = harness({
      lifetimeMs: 100 * 86_400 * SECOND,
      timers: (inner) => ({
        setTimer: (callback, ms) => {
          delays.push(ms);
          return inner.setTimer(callback, ms);
        },
      }),
    });
    await started(long);
    const seventyFiveDays = 75 * 86_400 * SECOND;
    await long.timers.advance(seventyFiveDays - 1);
    expect(long.provider.calls).toBe(1);
    await long.timers.advance(1);
    expect(long.provider.calls).toBe(2);
    // The expiry timer fired early on the platform's limit too, and was not taken for the expiry.
    expect(
      long.auth.calls.filter((c) => c.method === 'cancelOwnConsumers'),
    ).toEqual([]);
    expect(stateOf(long)?.state).toBe('valid');
    expect(delays.reduce((a, b) => Math.max(a, b), 0)).toBeLessThanOrEqual(
      2_147_483_647,
    );
    expect(delays.some((d) => d === 2_147_483_647)).toBe(true);

    // The wall clock was set back 100 s: the timer fires on time but the instant is not here yet.
    const back = harness();
    await started(back);
    back.clock.setNow(back.clock.now() - 100 * SECOND);
    await back.timers.advance(750 * SECOND);
    expect(back.provider.calls).toBe(1);
    await back.timers.advance(99_999);
    expect(back.provider.calls).toBe(1);
    await back.timers.advance(1);
    expect(back.provider.calls).toBe(2);
  });

  it('M1-23 slice C releasing the last handle stops the timers and the entry stays usable', async () => {
    const h = harness();
    const one = await started(h);
    const two = h.manager.track({ connectionId: 'c1', protocol: 'amqp091' });
    expect(h.timers.pending()).toBe(2);
    one.release();
    one.release(); // idempotent: it must not release the second handle's claim
    expect(h.timers.pending()).toBe(2);
    two.release();
    expect(h.timers.pending()).toBe(0);
    await h.timers.advance(2_000 * SECOND);
    expect(h.provider.calls).toBe(1);
    // It is renewed lazily now.
    expect(reveal((await credentialFor(h)).credential)).toBe('token-2');
  });

  it('M1-23 slice C a caller that gives up does not stop the renewal other callers wait for', async () => {
    const gate = deferred<IssuedCredential>();
    const h = harness({ script: () => gate.promise });
    const controller = new AbortController();
    const impatient = h.manager.credentialFor('c1', 'amqp', controller.signal);
    const patient = credentialFor(h);
    await h.timers.settle();
    controller.abort();
    expect((await failureOf(impatient)).code).toBe('BROKER_UNREACHABLE');
    gate.resolve(bearer({ n: 1, iat: 0, exp: LIFETIME }));
    expect(reveal((await patient).credential)).toBe('token-1');
    expect(h.provider.calls).toBe(1);
    const gone = new AbortController();
    gone.abort();
    expect(
      (await failureOf(h.manager.credentialFor('c1', 'amqp', gone.signal)))
        .code,
    ).toBe('BROKER_UNREACHABLE');
  });

  it('M1-23 slice C dispose cuts off an unfinished renewal, clears every timer and refuses further calls', async () => {
    const gate = deferred<IssuedCredential>();
    const h = harness({
      script: (n, now) =>
        n === 1 ? bearer({ n, iat: now, exp: now + LIFETIME }) : gate.promise,
    });
    await started(h);
    await h.timers.advance(750 * SECOND);
    const waiting = credentialFor(h);
    await h.timers.settle();
    expect(h.provider.calls).toBe(2);
    const disposing = h.manager.dispose();
    expect((await failureOf(waiting)).code).toBe('ENGINE_SHUTTING_DOWN');
    await disposing;
    await h.manager.dispose(); // idempotent
    expect(h.timers.pending()).toBe(0);
    expect(h.manager.stats().entries).toBe(0);
    expect((await failureOf(credentialFor(h))).code).toBe(
      'ENGINE_SHUTTING_DOWN',
    );
    expect(
      syncFailure(() =>
        h.manager.track({ connectionId: 'c1', protocol: 'http' }),
      ).code,
    ).toBe('ENGINE_SHUTTING_DOWN');
    expect(syncFailure(() => h.manager.subscribe(() => undefined)).code).toBe(
      'ENGINE_SHUTTING_DOWN',
    );
    // A close after dispose is not listened to.
    h.auth.emitClose('c1');
    gate.resolve(bearer({ n: 2, iat: 0, exp: LIFETIME }));
    await h.timers.settle();
    expect(h.auth.calls).toEqual([]);
  });

  it('M1-23 slice C a provider that never answers is cut off at the operation timeout', async () => {
    const never = harness({
      limits: { operationTimeoutMs: 10 * SECOND },
      script: () => new Promise<IssuedCredential>(() => undefined),
    });
    const pending = credentialFor(never);
    const outcome = failureOf(pending);
    await never.timers.advance(10 * SECOND);
    expect((await outcome).code).toBe('BROKER_UNREACHABLE');
    expect(never.timers.pending()).toBe(0);
    // A push that never returns is cut off too, and the failure is recorded.
    const stuck = harness({ limits: { operationTimeoutMs: 10 * SECOND } });
    stuck.auth.onReconnect = () => new Promise<void>(() => undefined);
    await started(stuck, 'stream');
    await stuck.timers.advance(750 * SECOND);
    await stuck.timers.advance(10 * SECOND);
    expect(stateOf(stuck)?.state).toBe('failed');
    expect(stateOf(stuck)?.problem?.code).toBe('BROKER_ERROR');
  });

  it('M1-23 slice C a reconnect that fails after a 320 close is recorded and the manager stays usable', async () => {
    const h = harness({ caps: { amqp091ClosesAtCredentialExpiry: true } });
    h.auth.onReconnect = () => Promise.reject(new Error('cannot reopen'));
    await started(h);
    h.auth.emitClose('c1');
    await h.timers.settle();
    expect(stateOf(h)?.state).toBe('failed');
    expect(stateOf(h)?.problem?.code).toBe('BROKER_ERROR');
    // A 320 close is also acted on when the broker was not expected to close: it did.
    const legacy = harness();
    await started(legacy);
    legacy.auth.emitClose('c1');
    await legacy.timers.settle();
    expect(legacy.auth.calls).toEqual([
      { method: 'reconnect', id: 'c1', arg: 'amqp091' },
    ]);
    // Only AMQP 0-9-1 connections are reopened this way.
    const stream = harness();
    await started(stream, 'stream');
    stream.auth.emitClose('c1');
    await stream.timers.settle();
    expect(stream.auth.calls).toEqual([]);
  });

  it('M1-23 slice C no failure carries a secret, a cause or the text a provider or the connection layer sent', async () => {
    const CANARY = {
      token: 'CANARY-token-Zq8mT3vK1x',
      providerText: 'CANARY-provider-Yb5nW2cL9d',
      connectionText: 'CANARY-connection-Hg7sP4fJ6e',
    };
    const scanner = createCanaryScanner(Object.values(CANARY));
    const seen: string[] = [];
    const record = (value: unknown): void => {
      seen.push(
        util.inspect(value, { depth: null, showHidden: true }),
        JSON.stringify(value, (_k, v: unknown) =>
          v instanceof Error ? { message: v.message, cause: v.cause } : v,
        ),
      );
    };
    const h = harness({
      script: (n, now) => {
        if (n === 1) {
          return {
            ...bearer({ n, iat: now, exp: now + LIFETIME }),
            token: new SecretValue(CANARY.token),
          };
        }
        if (n === 2) {
          return Promise.reject(
            new AppError('UNAUTHENTICATED', {
              detail: 'refused',
              cause: new Error(CANARY.providerText),
            }),
          );
        }
        return Promise.reject(new Error(CANARY.providerText));
      },
    });
    h.manager.subscribe((state) => {
      record(state);
    });
    h.auth.updateSecretFailures = 0;
    await started(h);
    await h.timers.advance(750 * SECOND);
    await h.timers.advance(2 * SECOND);
    const thrown = await failureOf(
      h.manager.refreshAfterUnauthorized('c1', 'amqp', 1, signal),
    );
    record(thrown);
    expect(thrown.cause).toBeUndefined();
    record(stateOf(h));
    // The connection layer's own error text stays out of the state.
    const pushFails = harness();
    pushFails.auth.onReconnect = () =>
      Promise.reject(
        new AppError('BROKER_ERROR', {
          detail: CANARY.connectionText,
          cause: new Error(CANARY.connectionText),
        }),
      );
    pushFails.manager.subscribe((state) => {
      record(state);
    });
    await started(pushFails, 'stream');
    await pushFails.timers.advance(750 * SECOND);
    record(pushFails.manager.state('c1', 'amqp'));
    expect(pushFails.manager.state('c1', 'amqp')?.state).toBe('failed');
    expect(seen.length).toBeGreaterThan(6);
    expect(scanner.scan(seen.join('\n'))).toEqual([]);
    // The scanner is not vacuous.
    expect(scanner.scan(JSON.stringify(CANARY)).length).toBeGreaterThan(0);
    // The one way to the token is reveal().
    expect(reveal((await credentialFor(h)).credential)).toBe(CANARY.token);
  });

  it('M1-23 slice C the limits are validated when the manager is made', () => {
    const base = harness();
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        createTokenManager({
          providers: { providerFor: () => Promise.resolve(undefined) },
          auth: {
            updateSecret: () => Promise.resolve(),
            reconnect: () => Promise.resolve(),
            cancelOwnConsumers: () => Promise.resolve({ cancelled: 0 }),
            onCredentialExpiredClose: () => () => undefined,
          },
          capabilities: () => base.caps,
          clock: base.clock,
          timers: base.timers,
          limits: { maxEntries: bad },
        }),
      ).toThrow(RangeError);
    }
  });

  it('M1-23 slice C a profile with no provider is NOT_FOUND and keeps no entry', async () => {
    const clock = createManualClock(0);
    const manager = createTokenManager({
      providers: { providerFor: () => Promise.resolve(undefined) },
      auth: {
        updateSecret: () => Promise.resolve(),
        reconnect: () => Promise.resolve(),
        cancelOwnConsumers: () => Promise.resolve({ cancelled: 0 }),
        onCredentialExpiredClose: () => () => undefined,
      },
      capabilities: () => ({
        amqp10TokenRenewalEndpoint: false,
        amqp091ClosesAtCredentialExpiry: false,
      }),
      clock,
      timers: createManualTimers(clock),
    });
    expect(
      (await failureOf(manager.credentialFor('c1', 'amqp', signal))).code,
    ).toBe('NOT_FOUND');
    expect(manager.stats().entries).toBe(0);
    expect(manager.state('c1', 'amqp')).toBeUndefined();
  });
});

describe('TokenManager edges found by mutation (slice C)', () => {
  const hold = { operationTimeoutMs: 1_000 * SECOND };
  const down = () =>
    Promise.reject(new AppError('BROKER_UNREACHABLE', { detail: 'down' }));

  it('M1-23 slice C a token shorter than the floor is renewed at its expiry', async () => {
    const h = harness({ lifetimeMs: 4 * SECOND });
    await started(h);
    expect(stateOf(h)?.nextRefreshAt).toBe(4 * SECOND);
    await h.timers.advance(3_999);
    expect(h.provider.calls).toBe(1);
    await h.timers.advance(1);
    expect(h.provider.calls).toBe(2);
  });

  it('M1-23 slice C the entry used longest ago is the one that makes room', async () => {
    const h = harness({ limits: { maxEntries: 2 } });
    await credentialFor(h, 'a');
    await credentialFor(h, 'b');
    await credentialFor(h, 'a'); // a is the most recently used now
    await credentialFor(h, 'c');
    expect(h.manager.state('a', 'amqp')).toBeDefined();
    expect(h.manager.state('b', 'amqp')).toBeUndefined();
    expect(h.manager.state('c', 'amqp')).toBeDefined();
  });

  it('M1-23 slice C an entry with a renewal or a push running is never evicted or dropped', async () => {
    // A first token on its way: a second connection is refused, not given its slot.
    const gate = deferred<IssuedCredential>();
    const waiting = harness({
      limits: { maxEntries: 1 },
      script: () => gate.promise,
    });
    const controller = new AbortController();
    const initiator = waiting.manager.credentialFor(
      'a',
      'amqp',
      controller.signal,
    );
    await waiting.timers.settle();
    expect((await failureOf(credentialFor(waiting, 'b'))).code).toBe(
      'BUDGET_EXCEEDED',
    );
    expect(waiting.manager.stats().evictedEntries).toBe(0);
    // The caller that started it gives up: the entry, and the renewal, stay.
    controller.abort();
    expect((await failureOf(initiator)).code).toBe('BROKER_UNREACHABLE');
    expect(waiting.manager.stats().entries).toBe(1);
    gate.resolve(bearer({ n: 1, iat: 0, exp: LIFETIME }));
    await waiting.timers.settle();
    expect(reveal((await credentialFor(waiting, 'a')).credential)).toBe(
      'token-1',
    );
    expect(waiting.provider.calls).toBe(1);

    // A push on its way, though the connection was released meanwhile.
    const pushing = harness({ limits: { maxEntries: 1 } });
    const handle = await started(pushing, 'stream');
    const done = deferred<undefined>();
    pushing.auth.onReconnect = () => done.promise;
    await pushing.timers.advance(750 * SECOND);
    handle.release();
    expect((await failureOf(credentialFor(pushing, 'other'))).code).toBe(
      'BUDGET_EXCEEDED',
    );
    done.resolve(undefined);
    await pushing.timers.settle();
    await credentialFor(pushing, 'other'); // idle now: the old entry makes room
    expect(pushing.manager.stats().evictedEntries).toBe(1);
  });

  it('M1-23 slice C the error of a provider has its code and text and nothing it carried', async () => {
    const CANARY = 'CANARY-cause-Pw4tG8nB2y';
    const scanner = createCanaryScanner([CANARY]);
    const h = harness({
      script: () =>
        Promise.reject(
          new AppError('UNAUTHENTICATED', {
            detail: 'the identity provider said no',
            cause: new Error(CANARY),
          }),
        ),
    });
    const error = await failureOf(credentialFor(h));
    expect(error.code).toBe('UNAUTHENTICATED');
    expect(error.detail).toBe('the identity provider said no');
    expect(error.cause).toBeUndefined();
    expect(
      scanner.scan(
        `${util.inspect(error, { depth: null, showHidden: true })}\n${error.stack ?? ''}`,
      ),
    ).toEqual([]);
  });

  it('M1-23 slice C a success clears the failure count, the problem and a refused user name', async () => {
    // The count: two failures, a success, then a failure that backs off from 2 s again.
    const h = harness({
      script: (n, now) =>
        n === 2 || n === 3 || n === 5
          ? down()
          : bearer({ n, iat: now, exp: now + LIFETIME }),
    });
    await started(h);
    await h.timers.advance(750_000); // call 2 fails
    await h.timers.advance(2_000); // call 3 fails
    expect(h.provider.calls).toBe(3);
    expect(stateOf(h)?.problem?.code).toBe('BROKER_UNREACHABLE');
    await h.timers.advance(4_000); // call 4 succeeds
    expect(h.provider.calls).toBe(4);
    expect(stateOf(h)).toMatchObject({ state: 'valid', problem: null });
    await h.timers.advance(750_000 - 1);
    expect(h.provider.calls).toBe(4);
    await h.timers.advance(1); // call 5 fails: the first failure of this lifetime
    expect(h.provider.calls).toBe(5);
    await h.timers.advance(1_999);
    expect(h.provider.calls).toBe(5);
    await h.timers.advance(1); // 2 s later, not 8 s
    expect(h.provider.calls).toBe(6);

    // A refused user name stops the retries; a later good token starts them again.
    const t = harness({
      script: (n, now) =>
        bearer({
          n,
          iat: now,
          exp: now + LIFETIME,
          username: n === 2 ? 'bob' : 'alice',
        }),
    });
    await started(t);
    await t.timers.advance(750 * SECOND);
    expect(stateOf(t)?.state).toBe('username-changed');
    await t.timers.advance(250 * SECOND); // the old token runs out
    expect(stateOf(t)?.state).toBe('username-changed'); // not "expired": the reason stays
    const again = await credentialFor(t);
    expect(reveal(again.credential)).toBe('token-3');
    expect(stateOf(t)).toMatchObject({
      state: 'valid',
      problem: null,
      nextRefreshAt: LIFETIME + 750 * SECOND,
    });
    await t.timers.advance(750 * SECOND);
    expect(t.provider.calls).toBe(4);
  });

  it('M1-23 slice C a success lifts the wait that earlier failures put on a 401', async () => {
    const h = harness({
      caps: { amqp091ClosesAtCredentialExpiry: true },
      script: (n, now) =>
        n >= 2 && n <= 7
          ? down()
          : bearer({ n, iat: now, exp: now + LIFETIME }),
    });
    await started(h);
    await h.timers.advance(812_000); // six failures: the next retry is 60 s away
    expect(h.provider.calls).toBe(7);
    await h.timers.advance(1_000);
    h.auth.emitClose('c1'); // a forced renewal is not held back by that wait
    await h.timers.settle();
    expect(h.provider.calls).toBe(8);
    const current = await credentialFor(h);
    await h.timers.advance(6_000); // 5 s after the renewal started
    const next = await h.manager.refreshAfterUnauthorized(
      'c1',
      'amqp',
      current.generation,
      signal,
    );
    expect(h.provider.calls).toBe(9);
    expect(next.generation).toBe(current.generation + 1);
  });

  it('M1-23 slice C the next renewal counts from when the last one started, not from when it ended', async () => {
    const gate = deferred<IssuedCredential>();
    const h = harness({ script: () => gate.promise });
    const pending = credentialFor(h);
    await h.timers.advance(3_000);
    // Issued long ago with 10 s to live: due at once, but not before 5 s after the start.
    gate.resolve(bearer({ n: 1, iat: -100_000_000, exp: 10 * SECOND }));
    await pending;
    expect(stateOf(h)?.nextRefreshAt).toBe(5_000);
  });

  it('M1-23 slice C asked again, an untracked token waits out the floor and then the backoff', async () => {
    const h = harness({
      script: (n, now) =>
        n === 1 ? bearer({ n, iat: now, exp: now + 10_000 * SECOND }) : down(),
    });
    await credentialFor(h, 'c1', 'http');
    await h.timers.advance(7_500 * SECOND); // the 75 % point
    const t0 = h.clock.now();
    await credentialFor(h, 'c1', 'http'); // call 2 fails: held until t0 + 5 s
    await h.timers.advance(5_000);
    await credentialFor(h, 'c1', 'http'); // call 3 fails (4 s backoff, floor 5 s): until t0 + 10 s
    await h.timers.advance(5_000);
    await credentialFor(h, 'c1', 'http'); // call 4 fails (8 s backoff beats the floor): until t0 + 18 s
    expect(h.provider.calls).toBe(4);
    expect(h.clock.now()).toBe(t0 + 10_000);
    await h.timers.advance(7_999);
    await credentialFor(h, 'c1', 'http');
    expect(h.provider.calls).toBe(4);
    await h.timers.advance(1);
    await credentialFor(h, 'c1', 'http');
    expect(h.provider.calls).toBe(5);
  });

  it('M1-23 slice C a 320 close during a renewal joins it, and one during a long reconnect is coalesced', async () => {
    const gate = deferred<IssuedCredential>();
    const joined = harness({
      caps: { amqp091ClosesAtCredentialExpiry: true },
      limits: hold,
      script: (n, now) =>
        n === 2 ? gate.promise : bearer({ n, iat: now, exp: now + LIFETIME }),
    });
    await started(joined);
    await joined.timers.advance(750 * SECOND); // the scheduled renewal is running
    joined.auth.emitClose('c1');
    await joined.timers.settle();
    expect(joined.provider.calls).toBe(2); // no second renewal
    gate.resolve(
      bearer({ n: 2, iat: 750 * SECOND, exp: 750 * SECOND + LIFETIME }),
    );
    await joined.timers.settle();
    expect(
      joined.auth.calls.filter((c) => c.method === 'reconnect'),
    ).toHaveLength(1);

    const reopening = deferred<undefined>();
    const h = harness({ caps: { amqp091ClosesAtCredentialExpiry: true } });
    h.auth.onReconnect = () => reopening.promise;
    await started(h);
    h.auth.emitClose('c1');
    await h.timers.settle();
    await h.timers.advance(6_000); // past the floor, but the reconnect has not finished
    h.auth.emitClose('c1');
    await h.timers.settle();
    expect(h.provider.calls).toBe(2);
    expect(h.auth.calls.filter((c) => c.method === 'reconnect')).toHaveLength(
      1,
    );
    expect(h.manager.stats().coalescedForcedCloses).toBe(1);
    reopening.resolve(undefined);
    await h.timers.settle();
    h.auth.emitClose('c1'); // finished and past the floor: handled
    await h.timers.settle();
    expect(h.provider.calls).toBe(3);
    expect(h.auth.calls.filter((c) => c.method === 'reconnect')).toHaveLength(
      2,
    );
  });

  it('M1-23 slice C an expired token is not pushed and a push already running is not started twice', async () => {
    const stale = harness();
    await credentialFor(stale);
    await stale.timers.advance(1_001 * SECOND);
    stale.manager.track({
      connectionId: 'c1',
      protocol: 'amqp091',
      generation: 0,
    });
    await stale.timers.settle();
    expect(stale.auth.calls.filter((c) => c.method === 'updateSecret')).toEqual(
      [],
    );

    const h = harness();
    const first = await credentialFor(h);
    await h.timers.advance(5_000);
    await h.manager.refreshAfterUnauthorized(
      'c1',
      'amqp',
      first.generation,
      signal,
    );
    const gate = deferred<undefined>();
    h.auth.updateSecretGate = gate.promise;
    h.manager.track({ connectionId: 'c1', protocol: 'amqp091', generation: 1 });
    h.manager.track({ connectionId: 'c1', protocol: 'amqp091', generation: 1 });
    await h.timers.settle();
    expect(h.auth.calls).toHaveLength(1);
    gate.resolve(undefined);
    await h.timers.settle();
    expect(h.auth.calls).toHaveLength(1);
  });

  it('M1-23 slice C a second handle that is behind keeps the connection marked behind', async () => {
    const h = harness();
    const first = await credentialFor(h);
    await h.timers.advance(5_000);
    await h.manager.refreshAfterUnauthorized(
      'c1',
      'amqp',
      first.generation,
      signal,
    );
    h.manager.track({ connectionId: 'c1', protocol: 'amqp091' }); // holds the current token
    h.manager.track({ connectionId: 'c1', protocol: 'amqp091', generation: 1 });
    await h.timers.settle();
    expect(h.auth.calls).toEqual([
      { method: 'updateSecret', id: 'c1', arg: 'token-2' },
    ]);
  });

  it('M1-23 slice C a first token that cannot be fetched leaves a tracked connection quiet, not spinning', async () => {
    const h = harness({ script: down });
    h.manager.track({ connectionId: 'c1', protocol: 'amqp091' });
    expect((await failureOf(credentialFor(h))).code).toBe('BROKER_UNREACHABLE');
    await h.timers.advance(10 * SECOND);
    expect(h.provider.calls).toBe(1);
    expect(h.timers.pending()).toBe(0);
  });

  it('M1-23 slice C a token that runs out during a renewal is expired at once and recovers when the renewal ends', async () => {
    const gate = deferred<IssuedCredential>();
    const h = harness({
      limits: hold,
      script: (n, now) =>
        n === 2 ? gate.promise : bearer({ n, iat: now, exp: now + LIFETIME }),
    });
    h.auth.cancelResult = { cancelled: 1 };
    await started(h);
    await h.timers.advance(750 * SECOND);
    expect(stateOf(h)?.state).toBe('refreshing');
    await h.timers.advance(250 * SECOND); // the old token runs out
    expect(stateOf(h)).toMatchObject({
      state: 'expired',
      consumersCancelled: 1,
    });
    gate.resolve(
      bearer({ n: 2, iat: 750 * SECOND, exp: 750 * SECOND + LIFETIME }),
    );
    await h.timers.settle();
    expect(stateOf(h)?.state).toBe('valid');
    expect(h.auth.calls.filter((c) => c.method === 'updateSecret')).toEqual([
      { method: 'updateSecret', id: 'c1', arg: 'token-2' },
    ]);
  });

  it('M1-23 slice C a caller that joins a failing renewal gets the live token, a cancel, or the failure', async () => {
    // Live old token: the failure of the renewal is not the caller's.
    const gate = deferred<IssuedCredential>();
    const h = harness({
      limits: hold,
      script: (n, now) =>
        n === 2 ? gate.promise : bearer({ n, iat: now, exp: now + LIFETIME }),
    });
    await started(h);
    await h.timers.advance(750 * SECOND);
    const joined = credentialFor(h);
    // A caller that gives up gets its own cancellation, not the old token.
    const controller = new AbortController();
    const quitting = h.manager.credentialFor('c1', 'amqp', controller.signal);
    await h.timers.settle();
    controller.abort();
    gate.reject(new AppError('BROKER_UNREACHABLE', { detail: 'down' }));
    const got = await joined;
    expect(reveal(got.credential)).toBe('token-1');
    expect(got.generation).toBe(1);
    const cancel = await failureOf(quitting);
    expect(cancel.code).toBe('BROKER_UNREACHABLE');
    expect(cancel.detail).toContain('cancelled');

    // Expired old token: the failure is everyone's.
    const gate2 = deferred<IssuedCredential>();
    const dead = harness({
      limits: hold,
      script: (n, now) =>
        n === 2 ? gate2.promise : bearer({ n, iat: now, exp: now + LIFETIME }),
    });
    await credentialFor(dead, 'c1', 'http');
    await dead.timers.advance(1_001 * SECOND);
    const a = failureOf(credentialFor(dead, 'c1', 'http'));
    const b = failureOf(credentialFor(dead, 'c1', 'http'));
    await dead.timers.settle();
    gate2.reject(new AppError('BROKER_UNREACHABLE', { detail: 'down' }));
    expect((await a).code).toBe('BROKER_UNREACHABLE');
    expect((await b).code).toBe('BROKER_UNREACHABLE');
  });

  it('M1-23 slice C an expired token is asked for again only after the wait, and the refusal says why', async () => {
    const h = harness({
      script: (n, now) =>
        n === 1 ? bearer({ n, iat: now, exp: now + 10 * SECOND }) : down(),
    });
    await credentialFor(h);
    await h.timers.advance(10 * SECOND);
    await failureOf(credentialFor(h)); // call 2, held until 15 s
    expect(h.provider.calls).toBe(2);
    await h.timers.advance(4_999);
    const held = await failureOf(credentialFor(h));
    expect(h.provider.calls).toBe(2);
    expect(held.code).toBe('BROKER_UNREACHABLE');
    expect(held.detail).toBe('down');
    await h.timers.advance(1); // 15 s: the wait is over
    await failureOf(credentialFor(h));
    expect(h.provider.calls).toBe(3);
  });

  it('M1-23 slice C a renewal after a 401 may carry the same expiry, a scheduled one may not', async () => {
    const h = harness({
      script: (n, now) =>
        n === 2
          ? bearer({ n, iat: now, exp: LIFETIME }) // the same expiry as token-1
          : bearer({ n, iat: now, exp: now + LIFETIME }),
    });
    const first = await credentialFor(h);
    await h.timers.advance(5_000);
    const second = await h.manager.refreshAfterUnauthorized(
      'c1',
      'amqp',
      first.generation,
      signal,
    );
    expect(second.generation).toBe(2);
    expect(reveal(second.credential)).toBe('token-2');
  });

  it('M1-23 slice C an untracked token reports its lazy point and its expiry without any timer', async () => {
    const h = harness();
    await credentialFor(h, 'c1', 'http');
    expect(stateOf(h, 'http')?.nextRefreshAt).toBe(750 * SECOND);
    await h.timers.advance(1_000 * SECOND);
    expect(stateOf(h, 'http')?.state).toBe('expired');
    expect(h.timers.pending()).toBe(0);
  });

  it('M1-23 slice C dispose frees a call that waits for a slot, stops listening and returns one promise', async () => {
    const gate = deferred<IssuedCredential>();
    const h = harness({
      limits: { maxConcurrentAcquires: 1 },
      script: () => gate.promise,
    });
    const first = failureOf(credentialFor(h, 'a'));
    const second = failureOf(credentialFor(h, 'b'));
    await h.timers.settle();
    expect(h.provider.calls).toBe(1);
    expect(h.auth.listening()).toBe(true);
    const disposing = h.manager.dispose();
    expect(h.manager.dispose()).toBe(disposing);
    expect((await second).code).toBe('ENGINE_SHUTTING_DOWN');
    expect((await first).code).toBe('ENGINE_SHUTTING_DOWN');
    await disposing;
    expect(h.provider.calls).toBe(1);
    expect(h.auth.listening()).toBe(false);
    expect(h.timers.pending()).toBe(0);
    expect(h.manager.stats().pendingOperations).toBe(0);
  });

  it('M1-23 slice C the default limits are the documented ones and they bite', async () => {
    expect(DEFAULT_TOKEN_MANAGER_LIMITS).toEqual({
      maxEntries: 256,
      maxListeners: 32,
      maxConcurrentAcquires: 8,
      operationTimeoutMs: 30_000,
      minRefreshIntervalMs: 5_000,
      backoffBaseMs: 2_000,
      backoffMaxMs: 60_000,
      maxAttempts: 8,
    });
    // Eight provider calls at a time.
    const gates = Array.from({ length: 9 }, () => deferred<IssuedCredential>());
    const busy = harness({ script: (n) => gates[n - 1]?.promise ?? down() });
    const all = gates.map((_, i) => credentialFor(busy, `c${String(i)}`));
    await busy.timers.settle();
    expect(busy.provider.calls).toBe(8);
    expect(busy.manager.stats().pendingOperations).toBe(8);
    expect(busy.manager.stats().pendingTasks).toBe(9); // one waits for a slot
    gates.forEach((gate, i) => {
      gate.resolve(bearer({ n: i + 1, iat: 0, exp: LIFETIME }));
    });
    await Promise.all(all);
    expect(busy.provider.calls).toBe(9);
    expect(busy.manager.stats().pendingOperations).toBe(0);

    // A provider that never answers is cut off after 30 s.
    const never = harness({
      script: () => new Promise<IssuedCredential>(() => undefined),
    });
    let ended = false;
    const outcome = failureOf(credentialFor(never)).then((error) => {
      ended = true;
      return error;
    });
    await never.timers.advance(29_999);
    expect(ended).toBe(false);
    await never.timers.advance(1);
    expect((await outcome).code).toBe('BROKER_UNREACHABLE');

    // 256 tracked connections fill the table; the 257th is refused.
    const full = harness();
    for (let i = 0; i < 256; i += 1) {
      await credentialFor(full, `c${String(i)}`);
      full.manager.track({
        connectionId: `c${String(i)}`,
        protocol: 'amqp091',
      });
    }
    expect((await failureOf(credentialFor(full, 'extra'))).code).toBe(
      'BUDGET_EXCEEDED',
    );
    expect(full.manager.stats().entries).toBe(256);
  });

  it('M1-23 slice C a failed push is settled when the connection that failed is released', async () => {
    const h = harness();
    await credentialFor(h);
    h.manager.track({ connectionId: 'c1', protocol: 'amqp091' });
    const stream = h.manager.track({ connectionId: 'c1', protocol: 'stream' });
    h.auth.onReconnect = () => Promise.reject(new Error('no'));
    await h.timers.advance(750 * SECOND);
    expect(stateOf(h)).toMatchObject({ state: 'failed' });
    expect(stateOf(h)?.problem?.code).toBe('BROKER_ERROR');
    stream.release(); // nothing is behind any more
    await h.timers.advance(2_000);
    expect(stateOf(h)).toMatchObject({ state: 'valid', problem: null });
    expect(h.provider.calls).toBe(2);
  });

  it('M1-23 slice C dispose returns only when the renewals, pushes and handlers have finished', async () => {
    const h = harness({ limits: hold });
    await started(h, 'stream');
    h.auth.onReconnect = () => new Promise<undefined>(() => undefined);
    await h.timers.advance(750 * SECOND); // the push is waiting on the connection
    expect(h.manager.stats().pendingTasks).toBeGreaterThan(0);
    await h.manager.dispose();
    expect(h.manager.stats().pendingTasks).toBe(0);
    expect(h.manager.stats().pendingOperations).toBe(0);
  });
});

// -- hardening after the two reviews of slice C (user name continuity, invalidate, bounds) -------

const firstThenDown = (
  n: number,
  now: number,
): IssuedCredential | Promise<IssuedCredential> =>
  n === 1
    ? bearer({ n, iat: now, exp: now + LIFETIME })
    : Promise.reject(new AppError('BROKER_UNREACHABLE', { detail: 'down' }));

const helpers = {
  calls: (h: Harness, method: string) =>
    h.auth.calls.filter((c) => c.method === method),
};

describe('TokenManager first-token requests and the sweep (slice C hardening)', () => {
  it('M1-23 hardening a retry that is due a little before the token point is made at the point (armWake)', async () => {
    // A 401 fails at 749 s with a retry due at 751 s; the 75 % point (750 s) is sooner, so the
    // wake is at the point and the scheduled renewal does not wait for the backoff.
    const h = harness({
      script: (n, now) =>
        n === 2
          ? Promise.reject(new AppError('BROKER_UNREACHABLE', {}))
          : bearer({ n, iat: now, exp: now + LIFETIME }),
    });
    await started(h);
    await h.timers.advance(749 * SECOND);
    const generation = (await credentialFor(h)).generation;
    await failureOf(
      h.manager.refreshAfterUnauthorized('c1', 'amqp', generation, signal),
    );
    expect(h.provider.calls).toBe(2);
    expect(stateOf(h)?.nextRefreshAt).toBe(750 * SECOND);
    await h.timers.advance(999);
    expect(h.provider.calls).toBe(2);
    await h.timers.advance(1);
    expect(h.provider.calls).toBe(3);
  });
});

describe('TokenManager reviews: timers, tasks and the edges they found (slice C hardening)', () => {
  it('M1-23 hardening the slot of the limiter is given back when the provider fails (F2a)', async () => {
    const h = harness({
      limits: { maxConcurrentAcquires: 1 },
      script: (n, now) =>
        n === 1
          ? Promise.reject(new AppError('BROKER_UNREACHABLE', { detail: 'x' }))
          : bearer({ n, iat: now, exp: now + LIFETIME }),
    });
    await failureOf(credentialFor(h, 'c1'));
    const second = credentialFor(h, 'c2');
    await h.timers.settle();
    expect(h.provider.calls).toBe(2); // not stuck behind a slot that was never returned
    expect(reveal((await second).credential)).toBe('token-2');
    // A timeout gives the slot back as well.
    const slow = harness({
      limits: { maxConcurrentAcquires: 1, operationTimeoutMs: 10 * SECOND },
      script: (n, now) =>
        n === 1
          ? new Promise<IssuedCredential>(() => undefined)
          : bearer({ n, iat: now, exp: now + LIFETIME }),
    });
    const stuck = failureOf(credentialFor(slow, 'c1'));
    const next = credentialFor(slow, 'c2');
    await slow.timers.advance(10 * SECOND);
    expect((await stuck).code).toBe('BROKER_UNREACHABLE');
    expect(reveal((await next).credential)).toBe('token-2');
  });

  it('M1-23 hardening an expiry timer that fires early is armed again and the consumers are cancelled once at the real expiry (F2b)', async () => {
    const h = harness({ script: firstThenDown });
    await started(h);
    h.clock.setNow(h.clock.now() - 100 * SECOND); // the wall clock is set back
    await h.timers.advance(LIFETIME); // the timer is due, the instant is not here yet
    expect(helpers.calls(h, 'cancelOwnConsumers')).toEqual([]);
    expect(stateOf(h)?.state).not.toBe('expired');
    await h.timers.advance(99_999);
    expect(helpers.calls(h, 'cancelOwnConsumers')).toEqual([]);
    await h.timers.advance(1);
    expect(helpers.calls(h, 'cancelOwnConsumers').length).toBe(1);
    expect(stateOf(h)?.state).toBe('expired');
  });

  it('M1-23 hardening the work started at expiry and at a forced close is counted as pending until it ends (F2c)', async () => {
    const gate = deferred<{ cancelled: number }>();
    const expiring = harness({ script: firstThenDown });
    expiring.auth.onCancel = () => gate.promise;
    await started(expiring);
    await expiring.timers.advance(LIFETIME);
    expect(expiring.manager.stats().pendingTasks).toBe(1);
    expect(expiring.manager.stats().pendingOperations).toBe(1);
    gate.resolve({ cancelled: 2 });
    await expiring.timers.settle();
    expect(expiring.manager.stats().pendingTasks).toBe(0);
    expect(stateOf(expiring)?.consumersCancelled).toBe(2);

    const closing = harness();
    const reopen = deferred<undefined>();
    closing.auth.onReconnect = () => reopen.promise;
    await started(closing);
    closing.auth.emitClose('c1');
    await closing.timers.settle();
    expect(closing.manager.stats().pendingTasks).toBe(1);
    // dispose waits for it, and the unfinished reconnect is cut off.
    const disposed = closing.manager.dispose();
    await disposed;
    expect(closing.manager.stats().pendingTasks).toBe(0);
    reopen.resolve(undefined);
  });

  it('M1-23 hardening cancelling the consumers can fail or hang, and the state says so, counted and published (I-13, F2)', async () => {
    const problem =
      'The engine own consumers could not be cancelled at token expiry.';
    const cases: {
      name: string;
      cancel: () => Promise<{ cancelled: number }>;
      wait: number;
    }[] = [
      {
        name: 'rejects',
        cancel: () => Promise.reject(new Error('CANARY-cancel-text')),
        wait: 0,
      },
      {
        name: 'hangs',
        cancel: () => new Promise<{ cancelled: number }>(() => undefined),
        wait: 10 * SECOND,
      },
    ];
    for (const { name, cancel, wait } of cases) {
      const h = harness({
        script: firstThenDown,
        limits: { operationTimeoutMs: 10 * SECOND },
      });
      h.auth.onCancel = cancel;
      await started(h);
      await h.timers.advance(LIFETIME);
      if (wait > 0) {
        await h.timers.advance(wait - 1);
        expect(stateOf(h)?.problem?.detail ?? '').not.toBe(problem);
        await h.timers.advance(1);
      }
      expect(stateOf(h)?.consumersCancelled, name).toBe(0);
      expect(stateOf(h)?.problem?.code, name).toBe('BROKER_ERROR');
      expect(stateOf(h)?.problem?.detail, name).toBe(problem);
      expect(h.states.at(-1)?.problem?.detail, name).toBe(problem);
      expect(JSON.stringify(h.states)).not.toContain('CANARY');
      expect(h.manager.stats().pendingTasks).toBe(0);
    }
  });

  it('M1-23 hardening a push that hangs is cut off at the operation timeout and not before (F2)', async () => {
    const h = harness({ limits: { operationTimeoutMs: 10 * SECOND } });
    await started(h);
    h.auth.updateSecretGate = new Promise<void>(() => undefined);
    await h.timers.advance(750 * SECOND);
    await h.timers.advance(10 * SECOND - 1);
    expect(stateOf(h)?.state).toBe('valid');
    expect(h.manager.stats().pendingOperations).toBe(1);
    await h.timers.advance(1);
    expect(stateOf(h)?.state).toBe('failed');
    expect(h.manager.stats().pendingOperations).toBe(0);
  });

  it('M1-23 hardening a 320 close whose renewal fails keeps the failure of the renewal and never reconnects (F2 renewed flag)', async () => {
    const h = harness({ script: firstThenDown });
    await started(h);
    h.auth.emitClose('c1');
    await h.timers.settle();
    expect(helpers.calls(h, 'reconnect')).toEqual([]);
    expect(stateOf(h)?.problem?.code).toBe('BROKER_UNREACHABLE');
    expect(stateOf(h)?.problem?.detail).toBe('down');
    expect(stateOf(h)?.state).toBe('failed');
  });

  it('M1-23 hardening a lazy renewal that carries the same expiry is refused as well (F2e)', async () => {
    const h = harness({
      script: (n, now) =>
        n === 1
          ? bearer({ n, iat: now, exp: LIFETIME })
          : bearer({ n, iat: now, exp: LIFETIME }), // the same expiry again
    });
    const first = await credentialFor(h);
    await h.timers.advance(800 * SECOND); // past the 75 % point, still before the expiry
    const again = await credentialFor(h); // the renewal is refused; the good token is kept
    expect(h.provider.calls).toBe(2);
    expect(again.generation).toBe(first.generation);
    expect(stateOf(h)?.state).toBe('failed');
    expect(stateOf(h)?.problem?.code).toBe('VALIDATION_FAILED');
  });

  it('M1-23 hardening a request that was cancelled before it started, or while it waits, is answered as cancelled (F2)', async () => {
    const h = harness();
    const done = new AbortController();
    done.abort();
    for (const call of [
      () => h.manager.credentialFor('c1', 'amqp', done.signal),
      () => h.manager.refreshAfterUnauthorized('c1', 'amqp', 1, done.signal),
    ]) {
      const error = await failureOf(call());
      expect(error.code).toBe('BROKER_UNREACHABLE');
      expect(error.detail).toBe('The credential request was cancelled.');
    }
    expect(h.provider.calls).toBe(0);
    expect(h.manager.stats().entries).toBe(0);

    // Waiting on a renewal that another caller started: giving up leaves it running.
    const gate = deferred<IssuedCredential>();
    const slow = harness({
      script: (n, now) =>
        n === 2 ? gate.promise : bearer({ n, iat: now, exp: now + LIFETIME }),
    });
    const first = await credentialFor(slow);
    await slow.timers.advance(5 * SECOND);
    const waiter = new AbortController();
    const unauthorized = failureOf(
      slow.manager.refreshAfterUnauthorized(
        'c1',
        'amqp',
        first.generation,
        waiter.signal,
      ),
    );
    await slow.timers.settle();
    const joiner = new AbortController();
    const joined = failureOf(
      slow.manager.refreshAfterUnauthorized(
        'c1',
        'amqp',
        first.generation,
        joiner.signal,
      ),
    );
    waiter.abort();
    joiner.abort();
    expect((await unauthorized).detail).toBe(
      'The credential request was cancelled.',
    );
    expect((await joined).detail).toBe('The credential request was cancelled.');
    expect(slow.manager.stats().inflightRefreshes).toBe(1);
    gate.resolve(bearer({ n: 2, iat: 5 * SECOND, exp: 5 * SECOND + LIFETIME }));
    await slow.timers.settle();
    expect(reveal((await credentialFor(slow)).credential)).toBe('token-2');
  });

  it('M1-23 hardening the state is published as refreshing while a renewal runs, and in flight renewals are counted (F2)', async () => {
    const gates = [deferred<IssuedCredential>(), deferred<IssuedCredential>()];
    const h = harness({
      script: (n, now) =>
        n >= 3
          ? (gates[n - 3]?.promise ?? down())
          : bearer({ n, iat: now, exp: now + LIFETIME }),
    });
    const down = () =>
      Promise.reject<IssuedCredential>(new AppError('BROKER_UNREACHABLE', {}));
    await credentialFor(h, 'a');
    await credentialFor(h, 'b');
    h.manager.track({ connectionId: 'a', protocol: 'amqp091' });
    h.manager.track({ connectionId: 'b', protocol: 'amqp091' });
    h.states.length = 0;
    await h.timers.advance(750 * SECOND);
    expect(h.manager.stats().inflightRefreshes).toBe(2);
    const refreshing = h.states.filter((s) => s.state === 'refreshing');
    expect(refreshing.map((s) => s.connectionId).sort()).toEqual(['a', 'b']);
    expect(refreshing[0]?.expiresAt).toBe(LIFETIME); // the old token is still described
    gates[0]?.resolve(bearer({ n: 3, iat: 750 * SECOND, exp: 1750 * SECOND }));
    gates[1]?.resolve(bearer({ n: 4, iat: 750 * SECOND, exp: 1750 * SECOND }));
    await h.timers.settle();
    expect(h.manager.stats().inflightRefreshes).toBe(0);
    expect(h.states.at(-1)?.state).toBe('valid');
  });

  it('M1-23 hardening a 401 for a token that was already replaced gets the current one, and an unknown connection gets its first (F2)', async () => {
    const h = harness();
    const old = await credentialFor(h);
    await h.timers.advance(5 * SECOND);
    const fresh = await h.manager.refreshAfterUnauthorized(
      'c1',
      'amqp',
      old.generation,
      signal,
    );
    expect(h.provider.calls).toBe(2);
    const stale = await h.manager.refreshAfterUnauthorized(
      'c1',
      'amqp',
      old.generation,
      signal,
    );
    expect(stale.generation).toBe(fresh.generation);
    expect(h.provider.calls).toBe(2);
    const unknown = await h.manager.refreshAfterUnauthorized(
      'other',
      'amqp',
      99,
      signal,
    );
    expect(reveal(unknown.credential)).toBe('token-3');
    expect(h.provider.calls).toBe(3);
  });
});

describe('TokenManager edges found by the mutation pass over the hardening (slice C hardening)', () => {
  it('M1-23 hardening an entry whose renewal failed is evicted for room like any idle entry', async () => {
    const h = harness({ limits: { maxEntries: 1 }, script: firstThenDown });
    await credentialFor(h, 'c1');
    await h.timers.advance(800 * SECOND);
    await credentialFor(h, 'c1'); // the lazy renewal fails; the good token is kept
    expect(h.provider.calls).toBe(2);
    await failureOf(credentialFor(h, 'c2')); // evicts c1; c2's own request fails
    expect(h.manager.stats().evictedEntries).toBe(1);
    expect(h.manager.stats().refusedEntries).toBe(0);
  });

  it('M1-23 hardening the floor between renewals counts from when the last one started, not from when it ended', async () => {
    const gate = deferred<IssuedCredential>();
    const h = harness({
      script: (n, now) =>
        n === 2 ? gate.promise : bearer({ n, iat: now, exp: now + LIFETIME }),
    });
    const first = await credentialFor(h);
    await h.timers.advance(100 * SECOND);
    const renewal = h.manager.refreshAfterUnauthorized(
      'c1',
      'amqp',
      first.generation,
      signal,
    );
    await h.timers.advance(3 * SECOND);
    gate.resolve(
      bearer({ n: 2, iat: h.clock.now(), exp: h.clock.now() + LIFETIME }),
    );
    const second = await renewal; // started at 100 s, ended at 103 s
    await h.timers.advance(2 * SECOND); // 105 s: five seconds after the start
    const third = await h.manager.refreshAfterUnauthorized(
      'c1',
      'amqp',
      second.generation,
      signal,
    );
    expect(reveal(third.credential)).toBe('token-3');
  });

  it('M1-23 hardening a request that was cancelled before it started does not reach the provider even when the entry exists', async () => {
    const h = harness();
    const first = await credentialFor(h);
    await h.timers.advance(5 * SECOND);
    const done = new AbortController();
    done.abort();
    await failureOf(
      h.manager.refreshAfterUnauthorized(
        'c1',
        'amqp',
        first.generation,
        done.signal,
      ),
    );
    expect(h.provider.calls).toBe(1);
  });
});
