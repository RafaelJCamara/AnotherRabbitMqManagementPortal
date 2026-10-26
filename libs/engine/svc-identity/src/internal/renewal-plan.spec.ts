// M1-23 slice C: the pure parts of the TokenManager. The AC-tagged tests of the manager itself are
// in ../token-manager.spec.ts; these pin the arithmetic and the tables it stands on, edge by edge.
import { AppError } from '@app/kernel';
import { describe, expect, it } from 'vitest';

import { createLimiter } from './limiter';
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  MAX_ATTEMPTS,
  MIN_REFRESH_INTERVAL_MS,
  backoffDelayMs,
  expiryRuleFor,
  plannedRefreshAt,
  refreshPoint,
  renewalActionFor,
} from './renewal-plan';
import { abortReason, raceSignal } from './signals';
import { checkUsername } from './username-claim';

describe('refreshPoint (75 percent of the lifetime)', () => {
  it('M1-23 slice C refresh point is issuedAt plus three quarters of the lifetime, rounded down', () => {
    const cases: [number, number, number, number][] = [
      // issuedAt, expiresAt, now, expected
      [0, 1_000_000, 0, 750_000],
      [
        1_700_000_000_000, 1_700_000_100_000, 1_700_000_000_000,
        1_700_000_075_000,
      ],
      [0, 1001, 0, 750], // 750.75 rounds down, never up
      [0, 1003, 0, 752], // 752.25
      [0, 4, 0, 3],
      [0, 1, 0, 0],
      [0, 0, 0, 0],
    ];
    for (const [issuedAt, expiresAt, now, expected] of cases) {
      expect(refreshPoint({ issuedAt, expiresAt, now })).toBe(expected);
    }
  });

  it('M1-23 slice C a future issuedAt is read as now, so the point cannot slide towards the expiry', () => {
    // iat 500 s ahead of now, exp 1000 s from now: taken as written the point would be at 875 s.
    expect(
      refreshPoint({ issuedAt: 500_000, expiresAt: 1_000_000, now: 0 }),
    ).toBe(750_000);
    // iat exactly now is not "future".
    expect(refreshPoint({ issuedAt: 10, expiresAt: 1_000_010, now: 10 })).toBe(
      750_010,
    );
    // iat one millisecond ahead is clamped.
    expect(refreshPoint({ issuedAt: 11, expiresAt: 1_000_010, now: 10 })).toBe(
      750_010,
    );
  });

  it('M1-23 slice C a past issuedAt and an expiry before issuedAt both give a point that is already due', () => {
    // Lifetime 1 h but issued 50 min ago: 75 % of the whole lifetime is 45 min after issue, past.
    const hour = 3_600_000;
    const now = 50 * 60_000;
    expect(refreshPoint({ issuedAt: 0, expiresAt: hour, now })).toBeLessThan(
      now,
    );
    expect(refreshPoint({ issuedAt: 100, expiresAt: 50, now: 200 })).toBe(100);
  });
});

describe('plannedRefreshAt (floor and ceiling)', () => {
  it('M1-23 slice C planned refresh keeps the floor after the last start and never passes the expiry', () => {
    const base = { issuedAt: 0, now: 0, lastStartedAt: 0 };
    // Normal: the 75 % point.
    expect(plannedRefreshAt({ ...base, expiresAt: 1_000_000 })).toBe(750_000);
    // A point before the floor is lifted to start + 5 s.
    expect(plannedRefreshAt({ ...base, expiresAt: 4_000 })).toBe(4_000); // ceiling wins over 5 s
    expect(plannedRefreshAt({ ...base, expiresAt: 8_000 })).toBe(6_000); // 75 % of 8 s
    expect(
      plannedRefreshAt({
        ...base,
        issuedAt: -100_000,
        expiresAt: 10_000,
        now: 0,
      }),
    ).toBe(MIN_REFRESH_INTERVAL_MS); // long past due: the floor
    expect(
      plannedRefreshAt({
        ...base,
        issuedAt: -100_000,
        expiresAt: 10_000,
        lastStartedAt: 2_000,
      }),
    ).toBe(2_000 + MIN_REFRESH_INTERVAL_MS);
    // The floor is configurable and the ceiling still wins.
    expect(
      plannedRefreshAt({
        ...base,
        issuedAt: -100_000,
        expiresAt: 10_000,
        minIntervalMs: 1_000,
      }),
    ).toBe(1_000);
    expect(
      plannedRefreshAt({
        ...base,
        issuedAt: -100_000,
        expiresAt: 500,
        minIntervalMs: 1_000,
      }),
    ).toBe(500);
  });
});

describe('backoffDelayMs', () => {
  it('M1-23 slice C backoff is 2 s doubling to 60 s and stays there', () => {
    const delays = Array.from({ length: 10 }, (_, i) => backoffDelayMs(i + 1));
    expect(delays).toEqual([
      2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000,
      60_000,
    ]);
    expect(backoffDelayMs(0)).toBe(BACKOFF_BASE_MS);
    expect(backoffDelayMs(-5)).toBe(BACKOFF_BASE_MS);
    expect(backoffDelayMs(10_000)).toBe(BACKOFF_MAX_MS); // no overflow to Infinity or NaN
    expect(backoffDelayMs(3, 100, 1_000)).toBe(400);
    expect(backoffDelayMs(5, 100, 1_000)).toBe(1_000);
    expect(MAX_ATTEMPTS).toBe(8);
  });
});

describe('renewal tables', () => {
  it('M1-23 slice C each protocol is renewed its own way and a missing endpoint reconnects', () => {
    const yes = { amqp10TokenRenewalEndpoint: true };
    const no = { amqp10TokenRenewalEndpoint: false };
    expect(renewalActionFor('http', yes)).toBe('push-none');
    expect(renewalActionFor('http', no)).toBe('push-none');
    expect(renewalActionFor('amqp091', yes)).toBe('update-secret');
    expect(renewalActionFor('amqp091', no)).toBe('update-secret');
    expect(renewalActionFor('amqp10', yes)).toBe('put-auth-token');
    expect(renewalActionFor('amqp10', no)).toBe('reconnect');
    expect(renewalActionFor('stream', yes)).toBe('reconnect');
    expect(renewalActionFor('stream', no)).toBe('reconnect');
  });

  it('M1-23 slice C the expiry rule follows the broker, and a broker not proven to close cancels', () => {
    expect(expiryRuleFor({ amqp091ClosesAtCredentialExpiry: true })).toBe(
      'reconnect-on-forced-close',
    );
    expect(expiryRuleFor({ amqp091ClosesAtCredentialExpiry: false })).toBe(
      'cancel-own-consumers',
    );
  });
});

describe('checkUsername', () => {
  it('M1-23 slice C a username must be present and exactly the first one', () => {
    expect(checkUsername('alice', 'alice')).toBe('same');
    expect(checkUsername('alice', 'bob')).toBe('changed');
    expect(checkUsername('alice', 'Alice')).toBe('changed'); // case-sensitive
    expect(checkUsername('alice', 'alice ')).toBe('changed');
    expect(checkUsername('alice', null)).toBe('missing');
    // The first token named nobody: no refresh can be checked against it.
    expect(checkUsername(null, 'bob')).toBe('changed');
    expect(checkUsername(null, null)).toBe('missing');
  });
});

describe('createLimiter', () => {
  const never = new AbortController().signal;
  const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

  it('M1-23 slice C the limiter runs at most max at once, in order, and a release frees one', async () => {
    const limiter = createLimiter(2);
    const order: string[] = [];
    const start = async (name: string): Promise<() => void> => {
      const release = await limiter.acquire(never);
      order.push(name);
      return release;
    };
    const a = start('a');
    const b = start('b');
    const c = start('c');
    const d = start('d');
    await tick();
    expect(order).toEqual(['a', 'b']);
    expect(limiter.active).toBe(2);
    expect(limiter.waiting).toBe(2);
    (await a)();
    await tick();
    expect(order).toEqual(['a', 'b', 'c']);
    (await a)(); // a second release of the same slot frees nothing more
    await tick();
    expect(order).toEqual(['a', 'b', 'c']);
    (await b)();
    await tick();
    expect(order).toEqual(['a', 'b', 'c', 'd']);
    (await c)();
    (await d)();
    expect(limiter.active).toBe(0);
    expect(limiter.waiting).toBe(0);
  });

  it('M1-23 slice C a waiter that is aborted leaves the line and an aborted signal never queues', async () => {
    const limiter = createLimiter(1);
    const hold = await limiter.acquire(never);
    const controller = new AbortController();
    const waiting = limiter.acquire(controller.signal);
    const behind = limiter.acquire(never);
    await tick();
    expect(limiter.waiting).toBe(2);
    controller.abort(new AppError('ENGINE_SHUTTING_DOWN'));
    await expect(waiting).rejects.toMatchObject({
      code: 'ENGINE_SHUTTING_DOWN',
    });
    expect(limiter.waiting).toBe(1);
    const aborted = new AbortController();
    aborted.abort();
    await expect(limiter.acquire(aborted.signal)).rejects.toBeInstanceOf(Error);
    expect(limiter.waiting).toBe(1);
    hold();
    const release = await behind;
    expect(limiter.active).toBe(1);
    release();
    expect(limiter.active).toBe(0);
  });
});

describe('raceSignal', () => {
  it('M1-23 slice C a wait ends at the abort, with the reason as an Error, and drops the late result', async () => {
    const controller = new AbortController();
    let resolveLate: (value: string) => void = () => undefined;
    const late = new Promise<string>((resolve) => {
      resolveLate = resolve;
    });
    const raced = raceSignal(late, controller.signal, () =>
      abortReason(controller.signal),
    );
    controller.abort(new AppError('BROKER_UNREACHABLE'));
    await expect(raced).rejects.toMatchObject({ code: 'BROKER_UNREACHABLE' });
    resolveLate('too late');
    // Already aborted: rejects at once and a rejecting promise does not go unhandled.
    const done = Promise.reject(new Error('later'));
    await expect(
      raceSignal(done, controller.signal, () => new Error('aborted first')),
    ).rejects.toThrow('aborted first');
    // A signal that aborted with something that is not an Error still gives an Error.
    const odd = new AbortController();
    odd.abort('text');
    expect(abortReason(odd.signal)).toBeInstanceOf(Error);
    // Without an abort the promise decides.
    await expect(
      raceSignal(
        Promise.resolve(7),
        new AbortController().signal,
        () => new Error('x'),
      ),
    ).resolves.toBe(7);
    await expect(
      raceSignal(
        Promise.reject(new Error('own')),
        new AbortController().signal,
        () => new Error('x'),
      ),
    ).rejects.toThrow('own');
  });
});
