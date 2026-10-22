// The service modules on the composed engine (M0-wiring, issue #278): the real composition root, the
// real router, executor, audit chain, SQLite file and live hub, over fake broker ports. Test names
// quote the acceptance criterion of docs/specs/M0-ENGINE-WIRING.md that they prove.
import { registry } from '@app/contracts';
import {
  createManualClock,
  createManualTimers,
  denyAllAuthorizer,
} from '@app/kernel';
import { createFakeWire } from '@app/svc-capabilities';
import { createFakeProber } from '@app/svc-connections';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { coreModules, type ServicePorts } from './modules/index.ts';
import {
  boot,
  closeAll,
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
    mgmt: broker.read,
    wire: createFakeWire(),
    prober: createFakeProber(),
    authorizer: denyAllAuthorizer,
    newId: () => 'id',
    clock,
    timers: createManualTimers(clock),
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
