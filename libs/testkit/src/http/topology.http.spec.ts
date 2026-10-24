// M1-20 over the real router: the six actions of svc-topology, built by the module over one scripted
// management API, answer in the shape of their contracts. The per-action HTTP specs (generated) prove
// the guards; this one proves the module as the engine composes it. What is proved against a fake
// management API only: the shapes and the routes, not what a real broker lists (M1-05, M1-18).
import {
  queuesEffectiveConfig,
  routingDeadLetter,
  routingDlxSources,
  routingSimulate,
  topologyGraph,
  topologySubgraph,
} from '@app/contracts';
import {
  createTopologyFakeDeps,
  createTopologyModule,
} from '@app/svc-topology';
import { afterEach, describe, expect, it } from 'vitest';

import { createTestEngine, type TestEngine } from '../create-test-engine.ts';

let engine: TestEngine;

afterEach(async () => {
  await engine.close();
});

const start = () => {
  const module = createTopologyModule(
    createTopologyFakeDeps({ ownerId: 'local-token' }),
  );
  engine = createTestEngine({ actions: [...module.actions] });
  return module;
};

const call = (path: string, payload: unknown) =>
  engine.inject({ method: 'POST', path: `/connections/c1/${path}`, payload });

describe('M1-20 AC-14 six routes over the real router', () => {
  it('serves all six actions in the shape of their contracts', async () => {
    start();
    const routes = [
      [
        'effective-config/queries',
        { vhost: '/', queue: 'orders.q' },
        queuesEffectiveConfig,
      ],
      ['topology/graphs', { vhost: '/' }, topologyGraph],
      [
        'topology/subgraphs',
        { vhost: '/', focus: { kind: 'exchange', name: 'orders' }, depth: 2 },
        topologySubgraph,
      ],
      [
        'routing/simulations',
        { vhost: '/', exchange: 'orders', routingKey: 'order.created' },
        routingSimulate,
      ],
      [
        'routing/dead-letter-paths',
        { vhost: '/', queue: 'orders.q' },
        routingDeadLetter,
      ],
      [
        'routing/dlx-sources',
        { vhost: '/', queue: 'orders.dlq' },
        routingDlxSources,
      ],
    ] as const;

    for (const [path, payload, def] of routes) {
      const answer = await call(path, payload);
      expect(answer.statusCode, path).toBe(200);
      const parsed = def.output.safeParse(answer.json());
      expect(parsed.success, path).toBe(true);
    }
  });

  it('routes a publish through the vhost and answers the dead-letter sources of its queue', async () => {
    start();

    const simulated = await call('routing/simulations', {
      vhost: '/',
      exchange: 'orders',
      routingKey: 'order.created',
    });
    const sources = await call('routing/dlx-sources', {
      vhost: '/',
      queue: 'orders.dlq',
    });

    expect(simulated.json()).toMatchObject({
      result: { outcome: 'routed', queues: ['orders.q'] },
    });
    expect(sources.json()).toMatchObject({
      complete: true,
      sources: [{ queue: 'orders.q', limit: { kind: 'finite', value: 20 } }],
    });
  });

  it('answers 404 for a vhost the broker does not hold and 400 for a body that breaks a contract', async () => {
    start();

    const missing = await call('topology/graphs', { vhost: 'nope' });
    const depth = await call('topology/subgraphs', {
      vhost: '/',
      focus: { kind: 'exchange', name: 'orders' },
      depth: 3,
    });

    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'NOT_FOUND' });
    expect(depth.statusCode).toBe(400);
    expect(depth.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('writes nothing: no audit row, no receipt and no write call for any of them', async () => {
    start();

    await call('topology/graphs', { vhost: '/' });
    await call('routing/simulations', {
      vhost: '/',
      exchange: 'orders',
      routingKey: 'x',
    });

    expect(engine.audit.attempts).toEqual([]);
    expect(engine.writeCalls).toEqual([]);
  });
});
