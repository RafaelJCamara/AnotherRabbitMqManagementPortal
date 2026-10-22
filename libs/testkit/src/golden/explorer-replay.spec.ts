// The explorer's sweeper against the golden recordings (M0-48 slice F, AC-22).
//
// The recordings (testing/fixtures/mgmt, M0-25) are the answers of real brokers: RabbitMQ 3.13.7,
// 4.0.9, 4.1.8, 4.2.9 and 4.3.6 with statistics on and off, and LavinMQ 2.10.2. They are served by
// a local HTTP server and read by the real management adapter over the real Dialer behind a real
// BrokerScheduler, so what the sweeper asks for is checked as the broker would see it on the wire
// (the unit tests of svc-explorer check what the service passes; only this one checks what is sent).
//
// Nothing here needs a broker or a Docker daemon, and no fixture is written or changed.
import { readFileSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import {
  createMgmtHttpClient,
  type MgmtTarget,
  type QueryProfile,
} from '@app/adapter-mgmt-http';
import { ConnectionIdSchema } from '@app/contracts';
import { parseSemVer } from '@app/domain-model';
import { BrokerScheduler, scheduleMgmtRead } from '@app/kernel';
import { createDialer } from '@app/net-dialer';
import { createExplorerFakeDeps } from '@app/svc-explorer';
import { describe, expect, it } from 'vitest';

import type { FixtureManifest } from './types.ts';

const FIXTURES = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'testing',
  'fixtures',
  'mgmt',
);

/** The recordings the criterion names: five RabbitMQ versions in both statistics modes, and LavinMQ. */
const RECORDINGS = [
  ...['3.13.7', '4.0.9', '4.1.8', '4.2.9', '4.3.6'].flatMap((version) => [
    `${version}/stats-off`,
    `${version}/stats-on`,
  ]),
  'lavinmq-2.10.2/default',
];

const BROKER_PAGE_CEILING = 500;
const cid = ConnectionIdSchema.parse('c1');

interface Recording {
  readonly key: string;
  readonly manifest: FixtureManifest;
  /** The recorded answer of an endpoint, as parsed JSON. */
  readonly json: (id: string) => unknown;
}

function loadRecording(key: string): Recording {
  const dir = join(FIXTURES, ...key.split('/'));
  const manifest = JSON.parse(
    readFileSync(join(dir, 'manifest.json'), 'utf8'),
  ) as FixtureManifest;
  return {
    key,
    manifest,
    json: (id) => {
      const entry = manifest.entries.find((candidate) => candidate.id === id);
      if (entry === undefined) throw new Error(`${key} has no entry ${id}`);
      return JSON.parse(readFileSync(join(dir, entry.file), 'utf8')) as unknown;
    },
  };
}

/** The objects of a recorded paged list. */
const itemsOf = (answer: unknown): Record<string, unknown>[] =>
  (answer as { items: Record<string, unknown>[] }).items;

/** The profile the adapter was given when the fixture was recorded. */
function profileOf(manifest: FixtureManifest): QueryProfile {
  const version = parseSemVer(manifest.version);
  if (version === null) throw new Error(`${manifest.version} does not parse`);
  return {
    product: manifest.product,
    stats: { disabled: manifest.stats === 'off', queueTotals: true },
    versions: {
      min: version,
      perNode: { 'rabbit@n0': version },
      mixed: false,
      build: 'oss',
    },
  };
}

interface Seen {
  readonly path: string;
  readonly params: URLSearchParams;
}

/**
 * Answers the reads of a sweep from a recording: the vhost list verbatim, the connection list as
 * recorded, and the queue and exchange lists of each vhost cut from the recorded all-vhosts list into
 * the broker's paged envelope (the recordings hold at most five objects, so a page is the whole list). Any other path
 * is a 404 and is recorded, so a request the sweeper should not make is seen.
 */
async function serve(recording: Recording) {
  const seen: Seen[] = [];
  const queues = itemsOf(recording.json('queues.list'));
  const exchanges = itemsOf(recording.json('exchanges.list'));
  const connections = itemsOf(recording.json('connections.list'));
  const vhosts = recording.json('vhosts.list');
  const listing = (
    items: Record<string, unknown>[],
    params: URLSearchParams,
  ) => {
    const size = Number(params.get('page_size') ?? BROKER_PAGE_CEILING);
    return {
      items,
      page: Number(params.get('page') ?? 1),
      page_size: size,
      page_count: 1,
      total_count: items.length,
      filtered_count: items.length,
      item_count: items.length,
    };
  };
  const server = createServer(
    (req: IncomingMessage, res: ServerResponse): void => {
      const url = new URL(req.url ?? '/', 'http://broker.invalid');
      seen.push({ path: url.pathname, params: url.searchParams });
      const [, , kind, rawVhost] = url.pathname.split('/');
      let body: unknown;
      if (url.pathname === '/api/vhosts') {
        body = vhosts;
      } else if (url.pathname === '/api/connections') {
        body = listing(connections, url.searchParams);
      } else if (rawVhost !== undefined && kind === 'queues') {
        const vhost = decodeURIComponent(rawVhost);
        body = listing(
          queues.filter((queue) => queue.vhost === vhost),
          url.searchParams,
        );
      } else if (rawVhost !== undefined && kind === 'exchanges') {
        const vhost = decodeURIComponent(rawVhost);
        body = listing(
          exchanges.filter((exchange) => exchange.vhost === vhost),
          url.searchParams,
        );
      }
      res.writeHead(body === undefined ? 404 : 200, {
        'content-type': 'application/json',
      });
      res.end(JSON.stringify(body ?? { error: 'not_found' }));
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    seen,
    port: (server.address() as AddressInfo).port,
    queues: queues.length,
    exchanges: exchanges.length,
    connections: connections.length,
    vhosts: (vhosts as unknown[]).length,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

describe('explorer sweep over the golden recordings', () => {
  it('M0-48 AC-22 explorer sweep requests are correct on the wire for every recorded broker', async () => {
    for (const key of RECORDINGS) {
      const recording = loadRecording(key);
      const broker = await serve(recording);
      const target: MgmtTarget = {
        host: '127.0.0.1',
        port: broker.port,
        route: { kind: 'direct' },
        auth: { kind: 'basic', username: 'monitor', password: 'not-a-secret' },
        profile: profileOf(recording.manifest),
      };
      const client = createMgmtHttpClient({
        dialer: createDialer(),
        targets: { resolve: () => Promise.resolve(target) },
        requestTimeoutMs: 15_000,
      });
      try {
        // The real scheduler, with the pause between background requests cut to 1 ms: the pacing
        // is the scheduler's own test, and a sweep here is only five requests.
        const reader = scheduleMgmtRead(
          client.read,
          new BrokerScheduler({ aimd: { baseIntervalMs: 1 } }),
        );
        const { sweeper } = createExplorerFakeDeps({ mgmt: reader });

        const outcome = await sweeper.sweepNow(
          cid,
          AbortSignal.timeout(30_000),
        );

        // Every recording parses without a schema error, and the index holds what was recorded.
        expect(outcome.problem, key).toBeUndefined();
        expect(outcome.ended, key).toBe('complete');
        const index = sweeper.index(cid);
        expect(
          index?.window({ kind: 'queues', offset: 0, limit: 500 }).total,
          key,
        ).toBe(broker.queues);
        expect(
          index?.window({ kind: 'exchanges', offset: 0, limit: 500 }).total,
          key,
        ).toBe(broker.exchanges);
        expect(
          index?.window({ kind: 'connections', offset: 0, limit: 500 }).total,
          key,
        ).toBe(broker.connections);

        // One vhost list, a queue list and an exchange list per vhost, and one connection list;
        // nothing else.
        const lists = broker.seen.filter(
          (request) => request.path !== '/api/vhosts',
        );
        expect(
          broker.seen.filter((request) => request.path === '/api/vhosts'),
          key,
        ).toHaveLength(1);
        expect(broker.seen, key).toHaveLength(2 + 2 * broker.vhosts);
        expect(
          lists.every((request) =>
            /^\/api\/(?:(?:queues|exchanges)\/[^/]+|connections)$/.test(
              request.path,
            ),
          ),
          key,
        ).toBe(true);
        expect(
          lists.filter((request) => request.path.startsWith('/api/queues/')),
          key,
        ).toHaveLength(broker.vhosts);

        const rabbit = recording.manifest.product === 'rabbitmq';
        for (const request of broker.seen) {
          const where = `${key} ${request.path}`;
          const params = request.params;
          if (request.path === '/api/vhosts') {
            expect(params.has('page'), where).toBe(false);
          } else {
            // DC-48, I-7: every list is paged, and never above the broker's own ceiling.
            expect(params.has('page'), where).toBe(true);
            const size = Number(params.get('page_size'));
            expect(size, where).toBeGreaterThan(0);
            expect(size, where).toBeLessThanOrEqual(BROKER_PAGE_CEILING);
          }
          if (!rabbit) {
            // LavinMQ has no statistics switch: neither flag may be sent to it.
            expect(params.has('disable_stats'), where).toBe(false);
            expect(params.has('enable_queue_totals'), where).toBe(false);
          } else if (request.path.startsWith('/api/queues/')) {
            expect(params.get('disable_stats'), where).toBe('true');
            expect(params.get('enable_queue_totals'), where).toBe('true');
          } else if (request.path === '/api/connections') {
            expect(params.get('disable_stats'), where).toBe('true');
          }
        }
      } finally {
        client.close();
        await broker.close();
      }
    }
  }, 120_000);
});
