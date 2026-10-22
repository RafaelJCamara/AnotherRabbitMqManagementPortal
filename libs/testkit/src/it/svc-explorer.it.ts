// Integration test of svc-explorer against lab brokers (M0-48 slice F, AC-23 and the S-13 record).
// Run with `pnpm nx run svc-explorer:it --versions=4.2.9,4.3.6`; it needs a Docker daemon (Linux in
// CI). `IT_QUEUES=100000` seeds 100,000 queues instead of 20,000, for the S-13 figures only.
//
// Everything below the service is real: the management HTTP adapter over the Dialer, the
// BrokerScheduler's background lane (one request at a time, paced), and a RabbitMQ from the broker
// lab holding the seeded queues. A recording proxy sits between the adapter and the broker, so what
// the sweeper sends is checked as the broker received it, and what each request cost is measured at
// the engine's door.
import {
  request as httpRequest,
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createMgmtHttpClient,
  type MgmtTarget,
  type QueryProfile,
} from '@app/adapter-mgmt-http';
import { ConnectionIdSchema } from '@app/contracts';
import { parseSemVer } from '@app/domain-model';
import {
  BrokerScheduler,
  createTestContext,
  createTestExecutor,
  scheduleMgmtRead,
} from '@app/kernel';
import { createDialer } from '@app/net-dialer';
import {
  createExplorerFakeDeps,
  createInventoryQueryAction,
  createSweeper,
  type Sweeper,
} from '@app/svc-explorer';

import { startBroker } from '../broker-lab.ts';
import { call } from '../golden/http.ts';
import type { BrokerHandle } from '../lab/types.ts';
import { measureAlternatives } from './s13-alternatives.ts';
import {
  queueName,
  seedQueues,
  vhostName,
  waitForQueueTotal,
} from './seed-queues.ts';

const versions = (process.env.IT_BROKER_VERSIONS ?? '4.3.6')
  .split(',')
  .filter((version) => version !== '');
const QUEUES = Number(process.env.IT_QUEUES ?? 20_000);
const VHOSTS = 4;
const PAGE_CEILING = 500;
const WINDOW_QUERIES = 200;
const WINDOW_P95_BUDGET_MS = 100;
const cid = ConnectionIdSchema.parse('c1');

// Vitest 5 hides the console output of a passing test, and these figures are the point of the run.
const report = (line: string): void => {
  process.stdout.write(line + '\n');
};

/** One request as the broker received it, and how long it took to answer. */
interface Wire {
  readonly path: string;
  readonly params: URLSearchParams;
  ms: number;
}

/** A forwarding proxy that records every request line and the time the broker took to answer. */
async function startRecordingProxy(upstream: string) {
  const target = new URL(upstream);
  const seen: Wire[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://proxy.invalid');
    const wire: Wire = {
      path: url.pathname,
      params: url.searchParams,
      ms: 0,
    };
    seen.push(wire);
    const began = performance.now();
    const forward = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
        answer.on('end', () => {
          wire.ms = performance.now() - began;
        });
      },
    );
    forward.on('error', () => {
      res.writeHead(502).end();
    });
    req.pipe(forward);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    seen,
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

const percentile = (values: readonly number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return (
    sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0
  );
};

/** How many queues the seed put in vhost `index` (evenly, in order). */
const queuesInVhost = (index: number): number =>
  Math.floor(QUEUES / VHOSTS) + (index < QUEUES % VHOSTS ? 1 : 0);

describe.each(versions)('svc-explorer against RabbitMQ %s', (version) => {
  let broker: BrokerHandle;
  let proxy: Awaited<ReturnType<typeof startRecordingProxy>>;
  let closeClient: () => void = () => undefined;
  let deps: ReturnType<typeof createExplorerFakeDeps>;
  let sweeper: Sweeper;
  let seededMs = 0;

  beforeAll(async () => {
    broker = await startBroker({ version });
    const seeded = await seedQueues({
      origin: broker.http,
      login: broker.credentials,
      count: QUEUES,
      vhosts: VHOSTS,
    });
    seededMs = seeded.ms;
    await waitForQueueTotal({
      origin: broker.http,
      login: broker.credentials,
      expected: QUEUES,
    });
    proxy = await startRecordingProxy(broker.http);

    const semver = parseSemVer(version);
    if (semver === null) throw new Error(`${version} does not parse`);
    // What the connection probe would have found: a RabbitMQ of this version with statistics on.
    const profile: QueryProfile = {
      product: 'rabbitmq',
      stats: { disabled: false, queueTotals: true },
      versions: {
        min: semver,
        perNode: { 'rabbit@n0': semver },
        mixed: false,
        build: 'oss',
      },
    };
    const target: MgmtTarget = {
      host: '127.0.0.1',
      port: proxy.port,
      route: { kind: 'direct' },
      profile,
      auth: {
        kind: 'basic',
        username: broker.credentials.username,
        password: broker.credentials.password,
      },
    };
    const client = createMgmtHttpClient({
      dialer: createDialer(),
      targets: { resolve: () => Promise.resolve(target) },
      requestTimeoutMs: 60_000,
    });
    closeClient = () => {
      client.close();
    };
    // The scheduler is what a service is really given (I-8): background reads, one at a time.
    const mgmt = scheduleMgmtRead(client.read, new BrokerScheduler());
    // The fakes give the profile and connection stores; the sweeper is the real one on the real
    // clock, so the server time it measures (the input of its cadence) is a real figure.
    deps = createExplorerFakeDeps({ mgmt });
    sweeper = createSweeper({ mgmt });
  }, 1_800_000);

  afterAll(async () => {
    await sweeper.stop();
    closeClient();
    await proxy.close();
    await broker.stop();
  });

  it('M0-48 AC-23 explorer on a lab broker with 20k queues stays within the paging and latency budget', async () => {
    // The first sweep. `touch` starts it the way a first window query does; `sweepNow` joins it.
    sweeper.touch(cid);
    const began = performance.now();
    const outcome = await sweeper.sweepNow(cid, AbortSignal.timeout(1_200_000));
    const sweepMs = performance.now() - began;
    expect(outcome.problem).toBeUndefined();
    expect(outcome.ended).toBe('complete');

    // Paging and flags, as the broker received them.
    const sweepWire = [...proxy.seen];
    const queueLists = sweepWire.filter((wire) =>
      wire.path.startsWith('/api/queues/'),
    );
    const exchangeLists = sweepWire.filter((wire) =>
      wire.path.startsWith('/api/exchanges/'),
    );
    const connectionLists = sweepWire.filter(
      (wire) => wire.path === '/api/connections',
    );
    expect(
      sweepWire.filter((wire) => wire.path === '/api/vhosts'),
    ).toHaveLength(1);
    expect(sweepWire).toHaveLength(
      1 + queueLists.length + exchangeLists.length + connectionLists.length,
    );
    expect(connectionLists).toHaveLength(1);
    for (const wire of [...queueLists, ...exchangeLists, ...connectionLists]) {
      expect(wire.params.has('page'), wire.path).toBe(true);
      expect(
        Number(wire.params.get('page_size')),
        wire.path,
      ).toBeLessThanOrEqual(PAGE_CEILING);
    }
    for (const wire of [...queueLists, ...connectionLists]) {
      expect(wire.params.get('disable_stats'), wire.path).toBe('true');
    }
    for (const wire of queueLists) {
      expect(wire.params.get('enable_queue_totals'), wire.path).toBe('true');
    }
    // A vhost with no queue still costs one page; the seeded ones cost ceil(n / 500) each.
    const seededPages = Array.from({ length: VHOSTS }, (_, i) =>
      Math.ceil(queuesInVhost(i) / PAGE_CEILING),
    ).reduce((a, b) => a + b, 0);
    const vhostsOnBroker = (
      JSON.parse(
        (
          await call(broker.http, 'GET', '/api/vhosts', {
            login: broker.credentials,
          })
        ).text,
      ) as unknown[]
    ).length;
    expect(queueLists).toHaveLength(seededPages + (vhostsOnBroker - VHOSTS));
    expect(exchangeLists).toHaveLength(vhostsOnBroker);

    // The index holds exactly what the broker says it has.
    const overview = JSON.parse(
      (
        await call(broker.http, 'GET', '/api/overview', {
          login: broker.credentials,
        })
      ).text,
    ) as { object_totals: { queues: number } };
    const index = sweeper.index(cid);
    const first = index?.window({ kind: 'queues', offset: 0, limit: 1 });
    expect(first?.total).toBe(overview.object_totals.queues);
    expect(first?.total).toBe(QUEUES);
    expect(first?.version.dropped).toBe(0);

    // Windows are served from the index: the broker sees nothing while they are read, and they are
    // fast. The action runs under the executor, as a request does.
    const engine = createTestExecutor();
    const action = createInventoryQueryAction({ ...deps, sweeper });
    engine.executor.register(action);
    const ask = async (input: Record<string, unknown>) => {
      const outcome = await engine.executor.run(
        action.def,
        input,
        createTestContext({ idempotencyKey: 'svc-explorer-it-key-0001' }),
      );
      if (outcome.kind !== 'output') throw new Error(`got ${outcome.kind}`);
      return outcome.output;
    };
    const before = proxy.seen.length;
    const shapes: Record<string, unknown>[] = [
      {},
      { sort: { column: 'name', dir: 'desc' } },
      { sort: { column: 'messages', dir: 'asc' } },
      { filter: { text: 'queue-00' } },
      {
        filter: { vhosts: [vhostName(1)] },
        sort: { column: 'vhost', dir: 'asc' },
      },
      { filter: { text: '99' }, sort: { column: 'name', dir: 'asc' } },
    ];
    const limits = [1, 200, 500];
    const elapsed: number[] = [];
    for (let i = 0; i < WINDOW_QUERIES; i++) {
      const shape = shapes[i % shapes.length] ?? {};
      const limit = limits[i % limits.length] ?? 200;
      const started = performance.now();
      const answer = await ask({
        cid: 'c1',
        kind: 'queues',
        ...shape,
        window: { offset: (i * 997) % QUEUES, limit },
      });
      elapsed.push(performance.now() - started);
      expect(answer.rows.length).toBeLessThanOrEqual(limit);
    }
    const p95 = percentile(elapsed, 0.95);
    expect(p95).toBeLessThanOrEqual(WINDOW_P95_BUDGET_MS);

    // A scroll over the whole inventory, pinned to one version: every queue once, in order.
    let version0: number | undefined;
    const names = new Set<string>();
    for (let offset = 0; offset < QUEUES; offset += PAGE_CEILING) {
      const answer = await ask({
        cid: 'c1',
        kind: 'queues',
        window: {
          offset,
          limit: PAGE_CEILING,
          ...(version0 === undefined ? {} : { version: version0 }),
        },
      });
      version0 ??= answer.version;
      expect(answer.freshness.versionChanged).toBe(false);
      if (answer.kind !== 'queues') throw new Error(answer.kind);
      for (const row of answer.rows) names.add(`${row.vhost}/${row.name}`);
    }
    expect(names.size).toBe(QUEUES);
    expect(names.has(`${vhostName(0)}/${queueName(0)}`)).toBe(true);
    expect(proxy.seen.length).toBe(before);

    // The figures S-13 records (docs/architecture/s-13-mgmt-api-cost-100k.md).
    const serverMs = queueLists
      .concat(exchangeLists, connectionLists)
      .reduce((sum, wire) => sum + wire.ms, 0);
    // No further sweep may start while the alternatives are measured (its timer is real).
    await sweeper.stop();
    report(
      `[S-13] ${JSON.stringify({
        version,
        queues: QUEUES,
        vhosts: vhostsOnBroker,
        requests: outcome.requests,
        queueListRequests: queueLists.length,
        seedMs: seededMs,
        sweepMs: Math.round(sweepMs),
        // What the sweeper itself measured (it includes the scheduler's pacing); the wait before
        // its next sweep is 50 times this, kept between 30 s and 15 min.
        sweeperServerTimeMs: Math.round(outcome.serverTimeMs),
        brokerAnswerMsTotal: Math.round(serverMs),
        brokerAnswerMsPerQueuePage: Math.round(
          queueLists.reduce((sum, wire) => sum + wire.ms, 0) /
            queueLists.length,
        ),
        windowQueries: WINDOW_QUERIES,
        windowP50Ms: Number(percentile(elapsed, 0.5).toFixed(2)),
        windowP95Ms: Number(p95.toFixed(2)),
        windowMaxMs: Number(Math.max(...elapsed).toFixed(2)),
      })}`,
    );
  }, 1_800_000);

  // The comparison S-13 asks for (OQ-662): the same queues listed in other ways, straight at the
  // broker with plain GETs. Printed for docs/architecture/s-13-mgmt-api-cost-100k.md, never asserted:
  // it only holds the figures of this broker on this machine. Two rounds, the second in reverse
  // order, so that the cost of a variant can be told from the cost of coming after the others.
  it('S-13 listing the queues other ways is measured and printed, not asserted', async () => {
    // At 100,000 queues a slow variant (page_size 100, the paged global list) takes hours: only the
    // sweep, the statistics-on list and the unpaged list are measured, once.
    const large = QUEUES > 20_000;
    for (const round of large ? [1] : [1, 2]) {
      const variants = await measureAlternatives(
        broker.http,
        broker.credentials,
        {
          reverse: round === 2,
          ...(large
            ? { only: ['vhost-500', 'vhost-500-stats', 'global-unpaged'] }
            : {}),
        },
      );
      for (const variant of variants) {
        report(
          `[S-13 alternative] ${JSON.stringify({
            version,
            seededQueues: QUEUES,
            round,
            ...variant,
            totalMs: Math.round(variant.totalMs),
            maxRequestMs: Math.round(variant.maxRequestMs),
          })}`,
        );
      }
      expect(variants).toHaveLength(large ? 3 : 6);
    }
  }, 1_800_000);
});
