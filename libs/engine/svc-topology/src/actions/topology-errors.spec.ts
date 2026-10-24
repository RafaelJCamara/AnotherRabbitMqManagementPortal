// The failure paths every action of this module shares (M1-20 AC-11): who may see a connection, what
// a missing profile, vhost or object is, and what a broker failure becomes. The table grows with the
// actions; each row names the input that reaches the broker.
import type { ActionDef } from '@app/contracts';
import {
  queuesEffectiveConfig,
  routingDeadLetter,
  routingDlxSources,
  routingSimulate,
  topologyGraph,
  topologySubgraph,
} from '@app/contracts';
import {
  AppError,
  createTestContext,
  createTestExecutor,
  createTestPrincipal,
  type ActionImpl,
} from '@app/kernel';
import { describe, expect, it } from 'vitest';

import {
  brokerFailure,
  createTopologyFakeDeps,
  type TopologyFakeDeps,
} from '../testing';

import { createQueuesEffectiveConfigAction } from './queues-effective-config';
import { createRoutingDeadLetterAction } from './routing-dead-letter';
import { createRoutingDlxSourcesAction } from './routing-dlx-sources';
import { createRoutingSimulateAction } from './routing-simulate';
import { createTopologyGraphAction } from './topology-graph';
import { createTopologySubgraphAction } from './topology-subgraph';

interface Row {
  readonly name: string;
  readonly def: ActionDef;
  readonly create: (deps: TopologyFakeDeps) => ActionImpl;
  readonly input: Record<string, unknown>;
  /** An input that names an object the vhost does not have. */
  readonly missingObject?: Record<string, unknown>;
}

const ROWS: readonly Row[] = [
  {
    name: 'queues.effective-config',
    def: queuesEffectiveConfig,
    create: createQueuesEffectiveConfigAction,
    input: { cid: 'c1', vhost: '/', queue: 'orders.q' },
    missingObject: { cid: 'c1', vhost: '/', queue: 'no-such-queue' },
  },
  {
    name: 'topology.graph',
    def: topologyGraph,
    create: createTopologyGraphAction,
    input: { cid: 'c1', vhost: '/' },
  },
  {
    name: 'topology.subgraph',
    def: topologySubgraph,
    create: createTopologySubgraphAction,
    input: {
      cid: 'c1',
      vhost: '/',
      focus: { kind: 'exchange', name: 'orders' },
    },
    missingObject: {
      cid: 'c1',
      vhost: '/',
      focus: { kind: 'exchange', name: 'no-such-exchange' },
    },
  },
  {
    name: 'routing.simulate',
    def: routingSimulate,
    create: createRoutingSimulateAction,
    input: { cid: 'c1', vhost: '/', exchange: 'orders', routingKey: 'a' },
  },
  {
    name: 'routing.dead-letter',
    def: routingDeadLetter,
    create: createRoutingDeadLetterAction,
    input: { cid: 'c1', vhost: '/', queue: 'orders.q' },
    missingObject: { cid: 'c1', vhost: '/', queue: 'no-such-queue' },
  },
  {
    name: 'routing.dlx-sources',
    def: routingDlxSources,
    create: createRoutingDlxSourcesAction,
    input: { cid: 'c1', vhost: '/', queue: 'orders.dlq' },
    missingObject: { cid: 'c1', vhost: '/', queue: 'no-such-queue' },
  },
];

async function run(
  row: Row,
  deps: TopologyFakeDeps,
  input: Record<string, unknown>,
  userId = 'user-1',
) {
  const engine = createTestExecutor();
  engine.executor.register(row.create(deps));
  const ctx = createTestContext({
    principal: createTestPrincipal({ id: userId }),
    idempotencyKey: 'errors-spec-key-0001',
  });
  const outcome = await engine.executor.run(row.def, input, ctx);
  return { outcome, engine };
}

describe.each(ROWS)(
  'M1-20 AC-11 errors are Problems and fail closed: $name',
  (row) => {
    it('answers a private connection of someone else exactly like one that does not exist', async () => {
      const other = await run(
        row,
        createTopologyFakeDeps(),
        row.input,
        'someone-else',
      ).catch((error: unknown) => error);
      const absent = await run(row, createTopologyFakeDeps(), {
        ...row.input,
        cid: 'c-unknown',
      }).catch((error: unknown) => error);

      expect(other).toMatchObject({ code: 'NOT_FOUND' });
      expect(absent).toMatchObject({ code: 'NOT_FOUND' });
      expect((other as Error).message).toBe((absent as Error).message);
    });

    it('asks for a probe when the connection has no cached profile', async () => {
      await expect(
        run(row, createTopologyFakeDeps({ seeded: false }), row.input),
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
        detail: expect.stringContaining('probe') as string,
      });
    });

    it('says a vhost the broker does not hold is not found', async () => {
      await expect(
        run(row, createTopologyFakeDeps(), { ...row.input, vhost: 'nope' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    if (row.missingObject !== undefined) {
      it('says an object the vhost does not have is not found', async () => {
        await expect(
          run(row, createTopologyFakeDeps(), row.missingObject ?? {}),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      });
    }

    it('passes a broker failure on as the Problem of the port, unchanged', async () => {
      const deps = createTopologyFakeDeps();
      const failure = brokerFailure();
      deps.broker.intercept = () => failure;

      await expect(run(row, deps, row.input)).rejects.toBe(failure);
    });

    it('carries no broker text in an answer when a list is refused', async () => {
      const deps = createTopologyFakeDeps();
      deps.broker.intercept = (request) =>
        request.path.startsWith('/api/policies/')
          ? new AppError('FORBIDDEN_BROKER', {
              detail: 'secret-broker-text',
              broker: {
                protocol: 'http',
                code: 403,
                text: 'secret-broker-text',
              },
            })
          : undefined;

      const { outcome } = await run(row, deps, row.input);

      expect(outcome.kind).toBe('output');
      expect(JSON.stringify(outcome)).toContain('policy-unreadable');
      expect(JSON.stringify(outcome)).not.toContain('secret-broker-text');
    });
  },
);
