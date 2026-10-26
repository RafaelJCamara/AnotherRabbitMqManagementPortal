// The service modules on the composed engine (M0-wiring, issue #278): the real composition root, the
// real router, executor, audit chain, SQLite file and live hub, over fake broker ports. Test names
// quote the acceptance criterion of docs/specs/M0-ENGINE-WIRING.md that they prove.
import { registry } from '@app/contracts';
import {
  createLogger,
  createManualClock,
  createManualTimers,
  denyAllAuthorizer,
  systemClock,
} from '@app/kernel';
import { createFakeWire } from '@app/svc-capabilities';
import { createFakeProber } from '@app/svc-connections';
import {
  createMemoryPublishHistory,
  createPublishHistory,
} from '@app/svc-messages';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { coreModules, type ServicePorts } from './modules/index.ts';
import {
  boot,
  closeAll,
  OWNER,
  scriptedBroker,
  storedConfig,
} from './testing/services.ts';

afterEach(closeAll);

/** `ServicePorts` over the fakes, for the checks that only need the module factory. */
function fakeServices(): ServicePorts {
  const broker = scriptedBroker();
  const clock = createManualClock();
  const unused = (): never => {
    throw new Error('not used by this check');
  };
  return {
    connections: {
      get: unused,
      save: unused,
      delete: unused,
      list: unused,
      count: unused,
      credentials: unused,
    },
    profiles: { get: unused, put: unused, delete: unused },
    workspace: {
      listViews: unused,
      countViews: unused,
      insertView: unused,
      deleteView: unused,
      getDocument: unused,
      putDocument: unused,
      listDocuments: unused,
    },
    sealer: { seal: unused, open: unused },
    publishHistory: createMemoryPublishHistory(),
    mgmt: broker.read,
    prom: { read: unused },
    wire: createFakeWire(),
    prober: createFakeProber(),
    authorizer: denyAllAuthorizer,
    newId: () => 'id',
    clock,
    timers: createManualTimers(clock),
    logger: createLogger({ level: 'silent' }),
  };
}

/** Registry actions this build does not serve, each with the reason. Every entry must still be unserved. */
const INTENTIONALLY_UNSERVED: Readonly<Record<string, string>> = {};

describe('the modules the engine registers', () => {
  const diagnostics = {
    versions: () => ({}),
    logs: { tail: () => ({ lines: [], held: 0, dropped: 0 }) },
    profiles: () => Promise.resolve([]),
    audit: {
      head: () => Promise.resolve(undefined),
      window: () => Promise.resolve([]),
    },
    secretValues: () => [],
  } as never;
  const modules = () =>
    coreModules({
      engineVersion: '0.0.0',
      mode: 'local',
      arming: {
        arm: () => ({ armed: true, armedAt: 0, expiresAt: 1 }),
        disarm: () => false,
        status: () => ({ armed: false }),
      },
      ops: {
        diagnostics,
        files: { write: () => Promise.resolve('unknown-token') },
        clock: createManualClock(),
      },
      services: fakeServices(),
    });

  it('AC-6 the explorer ends its sweeps and subscriptions on quit, SIGTERM and emergency, and leaves them alone on a suspend', () => {
    const explorer = modules().find((module) => module.id === 'svc-explorer');
    const phases = explorer?.drainPhases ?? [];

    expect(phases.map((phase) => phase.name)).toEqual(['taps-firehose']);
    expect(phases[0]?.reasons).toEqual(['quit', 'sigterm', 'emergency']);
  });

  it('AC-18 the metrics engine ends its collection and subscriptions on quit, SIGTERM and emergency, and leaves them alone on a suspend', () => {
    const metrics = modules().find((module) => module.id === 'svc-metrics');
    const phases = metrics?.drainPhases ?? [];

    expect(phases.map((phase) => phase.name)).toEqual(['taps-firehose']);
    expect(phases[0]?.reasons).toEqual(['quit', 'sigterm', 'emergency']);
    expect((metrics?.topics ?? []).map((topic) => topic.def.id)).toEqual([
      'metrics.live',
    ]);
    expect(
      (metrics?.actions ?? []).map((action) => action.def.id as string).sort(),
    ).toEqual(['metrics.forecast', 'metrics.query']);
  });
});

describe('what the composed engine serves', () => {
  it('AC-1 every action of the contract registry is served by the composed engine or listed as intentionally unserved with a reason', async () => {
    const { engine } = await boot();
    const served = new Set(engine.served.actions);
    const declared = registry.actions.map((def) => def.id as string);

    const missing = declared.filter(
      (id) => !served.has(id) && INTENTIONALLY_UNSERVED[id] === undefined,
    );
    const stale = Object.keys(INTENTIONALLY_UNSERVED).filter(
      (id) => served.has(id) || !declared.includes(id),
    );
    const unknown = [...served].filter((id) => !declared.includes(id));

    expect(missing).toEqual([]);
    expect(stale).toEqual([]);
    expect(unknown).toEqual([]);
    for (const reason of Object.values(INTENTIONALLY_UNSERVED)) {
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it('AC-2 every live topic of the contract registry has a source registered with the hub', async () => {
    const { engine } = await boot();

    expect(
      registry.topics
        .map((def) => def.id as string)
        .filter((id) => !engine.served.topics.includes(id)),
    ).toEqual([]);
  });
});
describe('probe, profile, inventory and overview through the real router', () => {
  it('AC-3 probe.run, profile.get, inventory.query and overview.get answer in sequence on a composed engine', async () => {
    const booted = await boot();
    await booted.seed('c1');

    const probe = await booted.call('POST', '/connections/c1/probe', {});
    const profile = await booted.call('GET', '/connections/c1/profile');
    // The window is read from the engine-resident index: the first query starts the sweep, and a
    // query a moment later sees the rows.
    const queries = () =>
      booted.call('POST', '/connections/c1/inventory/queries', {
        kind: 'queues',
        window: { offset: 0, limit: 50 },
      });
    await vi.waitFor(async () => {
      expect(((await queries()).body.rows as unknown[]).length).toBe(3);
    });
    const inventory = await queries();
    const overview = await booted.call('GET', '/connections/c1/overview');

    expect(probe.status).toBe(200);
    expect(probe.body).toMatchObject({
      changed: true,
      profile: { product: 'rabbitmq', versions: { min: { raw: '4.3.6' } } },
    });
    expect(profile.status).toBe(200);
    expect(profile.body).toMatchObject({
      profile: {
        fingerprint: (probe.body.profile as { fingerprint: string })
          .fingerprint,
      },
    });
    expect(inventory.status).toBe(200);
    expect(inventory.body).toMatchObject({ kind: 'queues' });
    expect(
      (inventory.body as { rows: { name: string }[] }).rows
        .map((row) => row.name)
        .sort(),
    ).toEqual(['audit', 'orders', 'payments']);
    expect(overview.status).toBe(200);
    expect(overview.body).toMatchObject({
      product: 'RabbitMQ',
      totals: { queues: 3 },
    });
    // The profile is cached in the engine's own database, derived data only (OQ-470).
    expect((await booted.repos().brokerProfiles.get('c1'))?.fingerprint).toBe(
      (probe.body.profile as { fingerprint: string }).fingerprint,
    );
  });

  it('AC-4 a connection that does not exist is a 404 Problem, and one the caller does not own looks the same', async () => {
    const booted = await boot();
    await booted.repos().connections.save({
      id: 'theirs',
      name: 'Not mine',
      envClass: 'dev',
      color: null,
      config: storedConfig(15672),
      ownerId: 'someone-else',
      visibility: 'private',
    });

    const absent = await booted.call('POST', '/connections/nope/probe', {});
    const foreign = await booted.call('POST', '/connections/theirs/probe', {});

    expect(absent.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe('NOT_FOUND');
    expect(booted.broker.requests).toEqual([]);
  });

  it("AC-5 workspace and connection writes that declare scope 'local' run on a real engine with nothing armed, and a write that names a connection is still locked (OQ-783)", async () => {
    const booted = await boot();
    await booted.seed('c1');

    const created = await booted.call('POST', '/connections', {
      name: 'Lab',
      envClass: 'dev',
      http: { host: '127.0.0.1', port: 15672 },
      amqp: { host: '127.0.0.1', port: 5672 },
    });
    const view = await booted.call('POST', '/views', {
      name: 'v',
      kind: 'queues',
      definition: {},
    });
    const settings = await booted.call('PUT', '/settings', {
      settings: { timeDisplay: 'utc' },
    });
    // Reads of the same state are not locked.
    const views = await booted.call('GET', '/views');
    // A write that names a connection is still locked until the person arms it.
    const renamed = await booted.call('PATCH', '/connections/c1', {
      name: 'Renamed',
    });

    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ profile: { name: 'Lab' } });
    expect(view.status).toBe(200);
    expect(settings.status).toBe(200);
    expect(views.status).toBe(200);
    expect(renamed.status).toBe(422);
    expect(renamed.body).toMatchObject({ code: 'GATE_BLOCKED' });
  });
});

describe('the publish actions on the composed engine', () => {
  const PUBLISH_IDS = [
    'messages.publish',
    'messages.publish-history.get',
    'messages.publish-history.list',
  ];
  const message = {
    vhost: '/',
    exchange: '',
    routingKey: 'orders',
    props: {},
    body: { encoding: 'utf8', data: 'hello' },
  };

  it('M1-19 AC-19 the composed engine serves the publish actions; publish is unwired until a manager is', async () => {
    const booted = await boot();
    await booted.seed('c1');

    const locked = await booted.call(
      'POST',
      '/connections/c1/messages/publish',
      message,
    );
    await booted.call('POST', '/connections/c1/arm', {});
    const publish = await booted.call(
      'POST',
      '/connections/c1/messages/publish',
      message,
    );
    const history = await booted.call(
      'GET',
      '/connections/c1/messages/publish-history',
    );
    const entry = await booted.call(
      'GET',
      '/connections/c1/messages/publish-history/nothing',
    );

    expect(
      PUBLISH_IDS.filter((id) => !booted.engine.served.actions.includes(id)),
    ).toEqual([]);
    // The prod lock comes first. Once the connection is armed, no broker connection manager is wired
    // yet (OQ-357, OQ-771): the publish is refused, says so, and records nothing. The reads work.
    expect(locked.body).toMatchObject({ code: 'GATE_BLOCKED' });
    expect(publish.status).toBe(412);
    expect(publish.body).toMatchObject({ code: 'CAPABILITY_MISSING' });
    expect(history.status).toBe(200);
    expect(history.body).toEqual({ entries: [] });
    expect(entry.status).toBe(404);
    expect(entry.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('M1-19 slice D: the composed engine reads a stored publish back through its real repository, vault and router', async () => {
    const booted = await boot();
    await booted.seed('c1');
    // The store of the module, built over the engine own table and field cipher: what a publish
    // that reached a broker would have written.
    const store = createPublishHistory({
      history: booted.repos().publishHistory,
      sealer: booted.input().sealer,
      newId: () => 'entry-composed-1',
      clock: systemClock,
      logger: createLogger({ level: 'silent' }),
    });
    await store.record({
      ownerId: OWNER,
      connectionId: 'c1',
      vhost: '/',
      at: Date.now(),
      exchange: '',
      routingKey: 'orders',
      copies: 1,
      summary: {
        confirmed: 1,
        nacked: 0,
        returned: 0,
        blocked: 0,
        timeout: 0,
        failed: 0,
        'not-sent': 0,
      },
      props: {},
      headers: {
        authorization: { t: 'string', v: 'Bearer COMPOSED-SECRET-1' },
      },
      body: new TextEncoder().encode('hello'),
    });

    const list = await booted.call(
      'GET',
      '/connections/c1/messages/publish-history',
    );
    const entry = await booted.call(
      'GET',
      '/connections/c1/messages/publish-history/entry-composed-1',
    );
    const other = await booted.call(
      'GET',
      '/connections/c2/messages/publish-history/entry-composed-1',
    );

    expect(list.status).toBe(200);
    expect(
      (list.body.entries as { id: string }[]).map((item) => item.id),
    ).toEqual(['entry-composed-1']);
    expect(entry.status).toBe(200);
    expect(entry.body).toMatchObject({
      resend: {
        routingKey: 'orders',
        body: { encoding: 'utf8', data: 'hello' },
        masked: ['header:authorization'],
      },
    });
    expect(JSON.stringify(entry.body)).not.toContain('COMPOSED-SECRET-1');
    expect(other.status).toBe(404);
  });
});

describe('the metrics engine on the composed engine', () => {
  it('AC-18 metrics.query reads the management API when the profile lists no Prometheus endpoint, and a quit drain stops the collection', async () => {
    const booted = await boot();
    await booted.seed('c1');
    await booted.call('POST', '/connections/c1/probe', {});
    const ask = () =>
      booted.call('POST', '/connections/c1/metrics/queries', {
        series: [{ metric: 'queues' }],
      });

    // The first call starts the collection and answers `loading`; the rounds fill the series.
    const first = await ask();
    expect(first.status).toBe(200);
    await vi.waitFor(
      async () => {
        const answer = await ask();
        expect(answer.body).toMatchObject({
          series: [{ found: true }],
          status: {
            source: 'management',
            fallbackReason: 'no-endpoint',
            partial: ['fallback'],
            approximate: true,
          },
        });
      },
      { timeout: 15_000 },
    );
    const answer = await ask();
    expect(
      (answer.body.series as { points: [number, number][] }[])[0]?.points.at(
        -1,
      )?.[1],
    ).toBe(3);

    const results = await booted.engine.drain('quit', 2000);
    const mark = booted.broker.requests.length;
    await ask();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(booted.broker.requests.length - mark).toBe(0);
    expect(results.every((result) => result.ok)).toBe(true);
  }, 30_000);
});

describe('the live hub and the drain', () => {
  it('AC-7 explorer.window is registered with the hub: a subscription over the live socket is acknowledged and answered with a snapshot', async () => {
    const booted = await boot();
    await booted.seed('c1');
    await booted.call('POST', '/connections/c1/probe', {});
    const base = `127.0.0.1:${String(booted.engine.address?.port ?? 0)}`;
    const issued = await fetch(`http://${base}/api/v1/live/tickets`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${booted.token}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    const { ticket } = (await issued.json()) as { ticket: string };
    const frames: Record<string, unknown>[] = [];
    const socket = new WebSocket(`ws://${base}/api/v1/live`, [
      'app.v1',
      `app.ticket.${ticket}`,
    ]);
    socket.addEventListener('message', (message) => {
      frames.push(JSON.parse(String(message.data)) as Record<string, unknown>);
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ t: 'hello', v: 1 }));
        resolve();
      });
      socket.addEventListener('error', () => {
        reject(new Error('the live socket did not open'));
      });
    });
    await vi.waitFor(() => {
      expect(frames.map((frame) => frame.t)).toContain('welcome');
    });

    socket.send(
      JSON.stringify({
        t: 'sub',
        sid: 1,
        topic: 'explorer.window',
        params: { cid: 'c1', kind: 'queues', keys: [] },
        credit: 16,
      }),
    );

    await vi.waitFor(() => {
      expect(frames.map((frame) => frame.t)).toEqual(
        expect.arrayContaining(['subok', 'snapshot']),
      );
    });
    socket.close();
  });

  it('AC-18 metrics.live is registered with the hub: a subscription over the live socket is acknowledged and the status reaches the client', async () => {
    const booted = await boot();
    await booted.seed('c1');
    await booted.call('POST', '/connections/c1/probe', {});
    const base = `127.0.0.1:${String(booted.engine.address?.port ?? 0)}`;
    const issued = await fetch(`http://${base}/api/v1/live/tickets`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${booted.token}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    const { ticket } = (await issued.json()) as { ticket: string };
    const frames: Record<string, unknown>[] = [];
    const socket = new WebSocket(`ws://${base}/api/v1/live`, [
      'app.v1',
      `app.ticket.${ticket}`,
    ]);
    socket.addEventListener('message', (message) => {
      frames.push(JSON.parse(String(message.data)) as Record<string, unknown>);
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ t: 'hello', v: 1 }));
        resolve();
      });
      socket.addEventListener('error', () => {
        reject(new Error('the live socket did not open'));
      });
    });
    await vi.waitFor(() => {
      expect(frames.map((frame) => frame.t)).toContain('welcome');
    });

    socket.send(
      JSON.stringify({
        t: 'sub',
        sid: 1,
        topic: 'metrics.live',
        params: { cid: 'c1', queues: [] },
        credit: 16,
      }),
    );

    await vi.waitFor(
      () => {
        expect(frames.map((frame) => frame.t)).toContain('subok');
        // However the admission races the first snapshot, the status reaches the client (as a delta
        // when the snapshot went out before the connection was admitted).
        expect(JSON.stringify(frames)).toContain('~status');
      },
      { timeout: 15_000 },
    );
    socket.close();
  }, 30_000);

  it('AC-8 a quit drain stops the explorer: a connection nobody asked about yet is not swept afterwards', async () => {
    const live = await boot();
    await live.seed('c2');
    await live.call('POST', '/connections/c2/probe', {});
    const before = live.broker.requests.length;
    await live.call('POST', '/connections/c2/inventory/queries', {
      kind: 'queues',
      window: { offset: 0, limit: 10 },
    });
    await vi.waitFor(() => {
      expect(live.broker.requests.length).toBeGreaterThan(before);
    });

    const drained = await boot();
    await drained.seed('c2');
    await drained.call('POST', '/connections/c2/probe', {});
    const results = await drained.engine.drain('quit', 2000);
    const mark = drained.broker.requests.length;
    await drained.call('POST', '/connections/c2/inventory/queries', {
      kind: 'queues',
      window: { offset: 0, limit: 10 },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(drained.broker.requests.length - mark).toBe(0);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(
      results.find((result) => result.phase === 'taps-firehose'),
    ).toMatchObject({
      ok: true,
    });
  });
});
