import { ConnectionIdSchema } from '@app/contracts';
import {
  AppError,
  createManualClock,
  createManualTimers,
  toProblem,
} from '@app/kernel';
import type { Principal } from '@app/ports';
import { describe, expect, it } from 'vitest';

import type { BrokerBudgetInput } from './budget.ts';
import {
  createConnectionManager,
  DEFAULT_HOLD_MS,
  type ConnectionManagerOptions,
  type ManagedConnectionManager,
} from './connection-manager.ts';
import { createFakeConnector, type FakeConnector } from './fake-connector.ts';

const BROKER = ConnectionIdSchema.parse('broker-a');
const OTHER = ConnectionIdSchema.parse('broker-b');

function principal(id: string): Principal {
  return {
    kind: 'team-user',
    id,
    display: id,
    roles: [],
    surface: 'ui',
    unattended: false,
  };
}

const ALICE = principal('alice');
const BOB = principal('bob');

interface Rig {
  readonly connector: FakeConnector;
  readonly manager: ManagedConnectionManager;
  readonly clock: ReturnType<typeof createManualClock>;
  readonly timers: ReturnType<typeof createManualTimers>;
  readonly resolved: string[];
  signal(): AbortSignal;
}

function rig(
  input: BrokerBudgetInput,
  extra: Partial<ConnectionManagerOptions> = {},
): Rig {
  const connector = createFakeConnector();
  const clock = createManualClock();
  const timers = createManualTimers(clock);
  const resolved: string[] = [];
  const manager = createConnectionManager({
    connector,
    budgets: {
      resolve: (id) => {
        resolved.push(id);
        return Promise.resolve(input);
      },
    },
    product: 'product',
    mode: 'desktop',
    clock,
    timers,
    ...extra,
  });
  return {
    connector,
    manager,
    clock,
    timers,
    resolved,
    signal: () => new AbortController().signal,
  };
}

/** Lets the manager's promise chains run; the fakes never wait on real time. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('connection-manager', () => {
  it('AC-1 queues the 11th observe request at consumersPerChannelMax=10 and budget() reports queued=1 with an ETA', async () => {
    // The Amazon MQ preset: 10 consumers per channel.
    const t = rig({
      limits: { consumersPerChannelMax: 10 },
      toolConnectionCap: 20,
    });
    const leases = [];
    for (let i = 0; i < 10; i += 1) {
      leases.push(await t.manager.observe(BROKER, '/', ALICE, t.signal()));
    }
    let eleventh: unknown;
    const pending = t.manager
      .observe(BROKER, '/', ALICE, t.signal())
      .then((lease) => (eleventh = lease));
    await settle();

    expect(eleventh).toBeUndefined();
    expect(t.connector.opened).toHaveLength(10);
    const observe = t.manager
      .budget(BROKER, '/')
      .find((row) => row.role === 'observe');
    expect(observe).toEqual({
      role: 'observe',
      vhost: '/',
      inUse: 10,
      max: 10,
      queued: 1,
      etaMs: DEFAULT_HOLD_MS,
    });

    // The ETA counts down as the oldest holder ages.
    t.clock.advance(12_000);
    expect(
      t.manager.budget(BROKER, '/').find((row) => row.role === 'observe')
        ?.etaMs,
    ).toBe(DEFAULT_HOLD_MS - 12_000);

    // A release serves the queued request.
    await leases[0]?.release();
    await pending;
    expect(eleventh).toBeDefined();
    const after = t.manager
      .budget(BROKER, '/')
      .find((row) => row.role === 'observe');
    expect(after).toMatchObject({ inUse: 10, queued: 0, etaMs: null });
  });

  it('AC-2 a peek connection serves one job at a time: the next peek waits for a release and gets its own connection', async () => {
    const t = rig({ limits: {}, roleMax: { peek: 1 } });
    const first = await t.manager.peek(BROKER, '/', ALICE, t.signal());
    let second: unknown;
    const pending = t.manager
      .peek(BROKER, '/', ALICE, t.signal())
      .then((lease) => (second = lease));
    await settle();

    expect(second).toBeUndefined();
    expect(t.connector.opened).toHaveLength(1);

    await first.release('healthy');
    await pending;
    expect(t.connector.opened).toHaveLength(2);
    expect(t.connector.opened[0]?.closed).toBe(true);
    expect(t.connector.opened[0]?.releases).toEqual(['peek:healthy']);
    expect(second).not.toBe(first);
  });

  it('AC-2 the peek lease exposes no publish and nothing beyond the peek methods', async () => {
    const t = rig({ limits: {} });
    const lease = await t.manager.peek(BROKER, '/', ALICE, t.signal());

    expect(Object.keys(lease).sort()).toEqual([
      'ackWithProof',
      'get',
      'nackRequeue',
      'qosBarrier',
      'release',
      'throwaway',
    ]);
    expect('publish' in lease).toBe(false);
    expect(Object.isFrozen(lease)).toBe(true);
    // The lease is a wrapper: what the adapter built is not handed out.
    await expect(lease.get('q')).resolves.toBeNull();
  });

  it('each role gets exactly its own methods', async () => {
    const t = rig({ limits: {} });
    const source = await t.manager.source(BROKER, '/', ALICE, t.signal());
    const publish = await t.manager.publish(BROKER, '/', ALICE, t.signal());
    const observe = await t.manager.observe(BROKER, '/', ALICE, t.signal());

    expect(Object.keys(source).sort()).toEqual([
      'ackWithProof',
      'cancel',
      'consume',
      'nackRequeue',
      'qosBarrier',
      'release',
    ]);
    expect(Object.keys(publish).sort()).toEqual([
      'blocked',
      'publish',
      'release',
    ]);
    expect(Object.keys(observe).sort()).toEqual([
      'ackTap',
      'bindQueue',
      'consume',
      'declareTapQueue',
      'release',
      'unbindQueue',
    ]);
    expect(publish.blocked()).toBe(false);
    expect(t.connector.opened.map((c) => c.role)).toEqual([
      'source',
      'publish',
      'observe',
    ]);
  });

  it('A-10 opens connections lazily and keeps none after the lease is released', async () => {
    const t = rig({ limits: {} });
    expect(t.connector.opened).toHaveLength(0);
    expect(t.manager.usage(BROKER)).toMatchObject({ inUse: 0 });

    const lease = await t.manager.publish(BROKER, '/', ALICE, t.signal());
    expect(t.connector.opened).toHaveLength(1);
    expect(t.manager.usage(BROKER).inUse).toBe(1);

    await lease.release();
    expect(t.connector.opened[0]?.closed).toBe(true);
    expect(t.manager.usage(BROKER).inUse).toBe(0);
  });

  it('A-10 caps the tool as a whole on the broker and reports "uses X of Y"', async () => {
    const t = rig({ limits: { connectionMax: 10 } });
    // connection_max 10 is a tight preset: the tool takes 2.
    await t.manager.refreshBudget(BROKER, t.signal());
    expect(t.manager.usage(BROKER)).toEqual({
      inUse: 0,
      max: 2,
      queued: 0,
      brokerMax: 10,
    });
    const peek = await t.manager.peek(BROKER, '/', ALICE, t.signal());
    await t.manager.source(BROKER, '/', ALICE, t.signal());
    let published: unknown;
    const pending = t.manager
      .publish(BROKER, '/', ALICE, t.signal())
      .then((lease) => (published = lease));
    await settle();

    expect(published).toBeUndefined();
    expect(t.manager.usage(BROKER)).toMatchObject({
      inUse: 2,
      max: 2,
      queued: 1,
    });
    // The queued call's role has room; the broker-wide cap is what holds it, and the ETA follows.
    expect(
      t.manager.budget(BROKER, '/').find((row) => row.role === 'publish'),
    ).toMatchObject({ inUse: 0, queued: 1, etaMs: DEFAULT_HOLD_MS });

    await peek.release('healthy');
    await pending;
    expect(published).toBeDefined();
    expect(t.manager.usage(BROKER)).toMatchObject({ inUse: 2, queued: 0 });
  });

  it('budgets are keyed by vhost: one vhost spending its peek budget does not queue another', async () => {
    const t = rig({ limits: {}, roleMax: { peek: 1 } });
    await t.manager.peek(BROKER, '/a', ALICE, t.signal());
    await t.manager.peek(BROKER, '/b', ALICE, t.signal());

    const a = t.manager.budget(BROKER, '/a').find((row) => row.role === 'peek');
    const b = t.manager.budget(BROKER, '/b').find((row) => row.role === 'peek');
    expect(a).toMatchObject({ vhost: '/a', inUse: 1, max: 1, queued: 0 });
    expect(b).toMatchObject({ vhost: '/b', inUse: 1, max: 1, queued: 0 });
    expect(t.connector.opened.map((c) => c.request.vhost)).toEqual([
      '/a',
      '/b',
    ]);
    expect(t.manager.usage(BROKER).inUse).toBe(2);
  });

  it('budgets are per broker', async () => {
    const t = rig({ limits: {}, roleMax: { peek: 1 } });
    await t.manager.peek(BROKER, '/', ALICE, t.signal());
    await t.manager.peek(OTHER, '/', ALICE, t.signal());

    expect(t.manager.usage(BROKER).inUse).toBe(1);
    expect(t.manager.usage(OTHER).inUse).toBe(1);
  });

  it('names the connection <product>/<mode>/<role>/<session> from the principal', async () => {
    const t = rig({ limits: {} });
    await t.manager.peek(BROKER, '/', ALICE, t.signal());
    await t.manager.publish(
      BROKER,
      '/',
      principal('job:01H/x y\u0001'),
      t.signal(),
    );

    expect(t.connector.opened.map((c) => c.connectionName)).toEqual([
      'product/desktop/peek/alice',
      'product/desktop/publish/job:01H-x-y-',
    ]);
  });

  it('serves waiting calls fairly: the principal with fewer connections goes before an earlier waiter', async () => {
    const t = rig({ limits: {}, toolConnectionCap: 2, roleMax: { peek: 2 } });
    const a1 = await t.manager.peek(BROKER, '/', ALICE, t.signal());
    await t.manager.peek(BROKER, '/', ALICE, t.signal());
    const order: string[] = [];
    const a3 = t.manager
      .peek(BROKER, '/', ALICE, t.signal())
      .then(() => order.push('alice'));
    const b1 = t.manager
      .peek(BROKER, '/', BOB, t.signal())
      .then(() => order.push('bob'));
    await settle();
    expect(order).toEqual([]);

    await a1.release('healthy');
    await settle();
    // Alice still holds one connection and Bob none, so Bob is served first although he asked last.
    expect(order).toEqual(['bob']);
    expect(t.connector.opened.at(-1)?.connectionName).toBe(
      'product/desktop/peek/bob',
    );
    void a3;
    void b1;
  });

  it('serves one principal in arrival order', async () => {
    const t = rig({ limits: {}, toolConnectionCap: 1, roleMax: { peek: 1 } });
    const first = await t.manager.peek(BROKER, '/', ALICE, t.signal());
    const order: number[] = [];
    const waits = [1, 2, 3].map((n) =>
      t.manager.peek(BROKER, '/', ALICE, t.signal()).then(async (lease) => {
        order.push(n);
        await lease.release('healthy');
      }),
    );
    await settle();
    await first.release('healthy');
    await Promise.all(waits);

    expect(order).toEqual([1, 2, 3]);
  });

  it('fails with RATE_LIMITED and an ETA when the queue is full', async () => {
    const t = rig(
      { limits: {}, toolConnectionCap: 1, roleMax: { peek: 1 } },
      { maxQueued: 1 },
    );
    await t.manager.peek(BROKER, '/', ALICE, t.signal());
    void t.manager.peek(BROKER, '/', ALICE, t.signal()).catch(() => undefined);
    await settle();

    const error = await rejection(
      t.manager.peek(BROKER, '/', ALICE, t.signal()),
    );
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'RATE_LIMITED' });
    expect((error as AppError).detail).toMatch(
      /1 requests are already waiting/,
    );
    expect((error as AppError).detail).toMatch(/in about 30 s/);
    expect(toProblem(error).status).toBe(429);
    expect(t.manager.usage(BROKER).queued).toBe(1);
  });

  it('fails with RATE_LIMITED when no connection frees up in time, and leaves the queue', async () => {
    const t = rig(
      { limits: {}, toolConnectionCap: 1, roleMax: { peek: 1 } },
      { maxWaitMs: 5_000 },
    );
    await t.manager.peek(BROKER, '/', ALICE, t.signal());
    const waiting = rejection(t.manager.peek(BROKER, '/', ALICE, t.signal()));
    await settle();
    expect(t.manager.usage(BROKER).queued).toBe(1);

    await t.timers.advance(5_000);
    const error = await waiting;

    expect(error).toMatchObject({ code: 'RATE_LIMITED' });
    expect((error as AppError).detail).toMatch(/within 5000 ms/);
    expect(t.manager.usage(BROKER).queued).toBe(0);
    expect(t.timers.pending()).toBe(0);
  });

  it('removes a queued call whose signal aborts', async () => {
    const t = rig({ limits: {}, toolConnectionCap: 1, roleMax: { peek: 1 } });
    const holder = await t.manager.peek(BROKER, '/', ALICE, t.signal());
    const controller = new AbortController();
    const waiting = rejection(
      t.manager.peek(BROKER, '/', BOB, controller.signal),
    );
    await settle();
    expect(t.manager.usage(BROKER).queued).toBe(1);

    controller.abort();
    const error = await waiting;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('AbortError');
    expect(t.manager.usage(BROKER).queued).toBe(0);
    // The slot is not given to the aborted call when the holder lets go.
    await holder.release('healthy');
    await settle();
    expect(t.connector.opened).toHaveLength(1);
    expect(t.manager.usage(BROKER).inUse).toBe(0);
    expect(t.timers.pending()).toBe(0);
  });

  it('refuses a call whose signal is already aborted, without opening anything', async () => {
    const t = rig({ limits: {} });
    const controller = new AbortController();
    controller.abort();

    const error = await rejection(
      t.manager.peek(BROKER, '/', ALICE, controller.signal),
    );

    expect((error as Error).name).toBe('AbortError');
    expect(t.connector.opened).toHaveLength(0);
  });

  it('gives the slot back when the connector fails, and serves the next call', async () => {
    const t = rig({ limits: {}, toolConnectionCap: 1, roleMax: { peek: 1 } });
    t.connector.failNext(new Error('handshake failed'));
    const failed = rejection(t.manager.peek(BROKER, '/', ALICE, t.signal()));
    const next = t.manager.peek(BROKER, '/', ALICE, t.signal());

    expect(await failed).toMatchObject({ message: 'handshake failed' });
    await next;
    expect(t.connector.opened).toHaveLength(1);
    expect(t.manager.usage(BROKER).inUse).toBe(1);
  });

  it('gives the slot back when the broker closes the connection under a lease', async () => {
    const t = rig({ limits: {}, toolConnectionCap: 1, roleMax: { peek: 1 } });
    await t.manager.peek(BROKER, '/', ALICE, t.signal());
    const next = t.manager.peek(BROKER, '/', BOB, t.signal());
    await settle();
    expect(t.connector.opened).toHaveLength(1);

    t.connector.opened[0]?.breakConnection();
    await next;

    expect(t.connector.opened).toHaveLength(2);
    expect(t.manager.usage(BROKER)).toMatchObject({ inUse: 1, queued: 0 });
  });

  it('keeps the slot of a lease whose release was refused, until the connection ends', async () => {
    const t = rig({ limits: {}, toolConnectionCap: 1, roleMax: { source: 1 } });
    const lease = await t.manager.source(BROKER, '/', ALICE, t.signal());
    const connection = t.connector.opened[0];
    if (connection === undefined) throw new Error('no connection');
    connection.refuseRelease = true;

    await expect(lease.release('healthy')).rejects.toThrow('still held');
    expect(t.manager.usage(BROKER).inUse).toBe(1);

    connection.refuseRelease = false;
    await lease.release('poisoned');
    expect(t.manager.usage(BROKER).inUse).toBe(0);
  });

  it('closes a connection that was opened for a call that gave up while it opened', async () => {
    const t = rig({ limits: {} });
    t.connector.pauseOpens();
    const controller = new AbortController();
    const waiting = rejection(
      t.manager.peek(BROKER, '/', ALICE, controller.signal),
    );
    await settle();
    controller.abort();
    t.connector.resume();
    const error = await waiting;

    expect((error as Error).name).toBe('AbortError');
    expect(t.connector.opened).toHaveLength(1);
    expect(t.connector.opened[0]?.closed).toBe(true);
    expect(t.manager.usage(BROKER).inUse).toBe(0);
  });

  it('counts a connection that is still opening against the budget', async () => {
    const t = rig({ limits: {}, toolConnectionCap: 1, roleMax: { peek: 1 } });
    t.connector.pauseOpens();
    const first = t.manager.peek(BROKER, '/', ALICE, t.signal());
    await settle();

    expect(t.manager.usage(BROKER).inUse).toBe(1);
    t.connector.resume();
    await first;
  });

  it('learns how long a role is held, so the ETA follows what really happens', async () => {
    const t = rig({ limits: {}, toolConnectionCap: 1, roleMax: { peek: 1 } });
    const quick = await t.manager.peek(BROKER, '/', ALICE, t.signal());
    t.clock.advance(2_000);
    await quick.release('healthy');

    await t.manager.peek(BROKER, '/', ALICE, t.signal());
    void t.manager.peek(BROKER, '/', ALICE, t.signal()).catch(() => undefined);
    await settle();

    expect(
      t.manager.budget(BROKER, '/').find((row) => row.role === 'peek')?.etaMs,
    ).toBe(2_000);
  });

  it('reads the limits again on every call, so a new probe changes the budget', async () => {
    let input: BrokerBudgetInput = { limits: {}, roleMax: { peek: 1 } };
    const connector = createFakeConnector();
    const manager = createConnectionManager({
      connector,
      budgets: { resolve: () => Promise.resolve(input) },
      product: 'product',
      mode: 'desktop',
    });
    const signal = new AbortController().signal;
    await manager.peek(BROKER, '/', ALICE, signal);
    expect(manager.budget(BROKER, '/')[0]).toMatchObject({
      role: 'peek',
      max: 1,
    });

    input = { limits: {}, roleMax: { peek: 2 } };
    await manager.peek(BROKER, '/', ALICE, signal);

    expect(manager.budget(BROKER, '/')[0]).toMatchObject({
      role: 'peek',
      inUse: 2,
      max: 2,
    });
  });

  it('reports the default budget for a broker it has not served', () => {
    const t = rig({ limits: {} });

    expect(t.manager.budget(BROKER, '/')).toEqual([
      { role: 'peek', vhost: '/', inUse: 0, max: 2, queued: 0, etaMs: null },
      { role: 'source', vhost: '/', inUse: 0, max: 2, queued: 0, etaMs: null },
      {
        role: 'publish',
        vhost: '/',
        inUse: 0,
        max: 2,
        queued: 0,
        etaMs: null,
      },
      {
        role: 'observe',
        vhost: '/',
        inUse: 0,
        max: 8,
        queued: 0,
        etaMs: null,
      },
    ]);
    expect(t.resolved).toEqual([]);
  });

  it('refuses a vhost that is too long or holds a control character', async () => {
    const t = rig({ limits: {} });

    for (const vhost of ['a'.repeat(256), 'bad\u0000name']) {
      const error = await rejection(
        t.manager.peek(BROKER, vhost, ALICE, t.signal()),
      );
      expect(error).toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    expect(t.connector.opened).toHaveLength(0);
  });

  it('close() fails the waiting calls and refuses new ones', async () => {
    const t = rig({ limits: {}, toolConnectionCap: 1, roleMax: { peek: 1 } });
    await t.manager.peek(BROKER, '/', ALICE, t.signal());
    const waiting = rejection(t.manager.peek(BROKER, '/', BOB, t.signal()));
    await settle();

    t.manager.close();

    expect(await waiting).toMatchObject({ code: 'ENGINE_SHUTTING_DOWN' });
    expect(t.timers.pending()).toBe(0);
    expect(
      await rejection(t.manager.publish(BROKER, '/', ALICE, t.signal())),
    ).toMatchObject({ code: 'ENGINE_SHUTTING_DOWN' });
  });
});
