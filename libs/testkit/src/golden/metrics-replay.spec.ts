// The metrics engine against the golden Prometheus pages (M1-26, AC-5 and AC-16).
//
// The pages (testing/fixtures/prometheus, M0-25) are what real brokers answered: RabbitMQ 3.13.7,
// 4.0.9, 4.1.8, 4.2.9 and 4.3.6 with statistics on and off, and LavinMQ 2.10.2. A local HTTP server
// serves them; the real scrape client reads them over the real Dialer behind a real BrokerScheduler;
// the real parser reads the bodies; the collector stores the series; and `metrics.query` answers
// through the real router. The expected values are read from the page text by a regular expression,
// not from the parser, so the chain is checked end to end.
//
// Nothing here needs a broker or a Docker daemon, and no fixture is written or changed. What it does
// not prove: the cadence on a live broker, a real node loss, or `queue=` on a broker that supports
// it (the server ignores the filter and serves the whole page).
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import {
  createPromReader,
  createPromScrapeClient,
} from '@app/adapter-prometheus';
import { ConnectionIdSchema } from '@app/contracts';
import { BrokerScheduler, schedulePromScrape } from '@app/kernel';
import { createDialer } from '@app/net-dialer';
import {
  createMetricsFakeDeps,
  createMetricsQueryAction,
} from '@app/svc-metrics';
import { afterEach, describe, expect, it } from 'vitest';

import { createTestEngine, type TestEngine } from '../create-test-engine.ts';

const FIXTURES = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'testing',
  'fixtures',
  'prometheus',
);

const RECORDINGS = [
  ...['3.13.7', '4.0.9', '4.1.8', '4.2.9', '4.3.6'].flatMap((version) => [
    `${version}/stats-off`,
    `${version}/stats-on`,
  ]),
  'lavinmq-2.10.2/default',
];

const cid = ConnectionIdSchema.parse('c1');

let engine: TestEngine | undefined;
afterEach(async () => {
  await engine?.close();
  engine = undefined;
});

const page = (key: string, file: string): string =>
  readFileSync(join(FIXTURES, ...key.split('/'), file), 'utf8');

/** The value of the first line of `text` that starts with `name` (and holds `needle`), read by regex. */
function valueOf(text: string, name: string, needle = ''): number {
  for (const line of text.split('\n')) {
    if (!line.startsWith(name) || !line.includes(needle)) continue;
    const match = /(?:\}|\S)\s+(-?[0-9.]+(?:e[+-]?\d+)?)\s*$/.exec(line);
    if (match?.[1] !== undefined && /^[\s{]/.test(line.slice(name.length))) {
      return Number(match[1]);
    }
  }
  throw new Error(`no line ${name} ${needle}`);
}

interface Seen {
  readonly url: string;
  readonly authorization: string | undefined;
}

async function serve(key: string) {
  const aggregated = page(key, 'prometheus.metrics.prom');
  const detailed = page(key, 'prometheus.detailed-queues.prom');
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', authorization: req.headers.authorization });
    const path = (req.url ?? '').split('?')[0];
    res.writeHead(
      path === '/metrics' || path === '/metrics/detailed' ? 200 : 404,
      {
        'content-type': 'text/plain; version=0.0.4',
      },
    );
    res.end(
      path === '/metrics'
        ? aggregated
        : path === '/metrics/detailed'
          ? detailed
          : '',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    seen,
    aggregated,
    detailed,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

describe('metrics against the golden Prometheus pages', () => {
  it.each(RECORDINGS)(
    'AC-5 %s: the real client, parser, collector and router give the values on the page',
    async (key) => {
      const server = await serve(key);
      const scheduler = new BrokerScheduler();
      const client = createPromScrapeClient({
        dialer: createDialer(),
        targets: {
          resolve: () =>
            Promise.resolve({
              host: '127.0.0.1',
              port: server.port,
              route: { kind: 'direct' },
              auth: { kind: 'none' },
            }),
        },
      });
      try {
        const prefix = key.startsWith('lavinmq') ? 'lavinmq' : 'rabbitmq';
        const fakes = createMetricsFakeDeps({
          ownerId: 'local-token',
          prom: createPromReader(schedulePromScrape(client.scrape, scheduler)),
          profile: {
            prometheus: {
              endpoints: [
                {
                  node: 'rabbit@lab-node',
                  url: `http://127.0.0.1:${String(server.port)}/metrics`,
                  source: 'listener',
                },
              ],
              perObjectAllowed: true,
              queueFilter: true,
              minIntervalSec: 15,
            },
          },
        });
        fakes.collector.touch(cid, [
          { vhost: 'golden', name: 'golden.classic' },
        ]);
        const outcome = await fakes.collector.roundNow(
          cid,
          new AbortController().signal,
        );
        expect(outcome).toMatchObject({
          ended: 'complete',
          source: 'prometheus',
        });

        engine = createTestEngine({
          actions: [createMetricsQueryAction(fakes)],
        });
        const answer = await engine.inject({
          method: 'POST',
          path: '/connections/c1/metrics/queries',
          payload: {
            series: [
              { metric: 'messages_ready' },
              { metric: 'messages' },
              { metric: 'connections' },
              {
                metric: 'queue_messages',
                queue: { vhost: 'golden', name: 'golden.classic' },
              },
              {
                metric: 'queue_messages',
                queue: { vhost: 'golden', name: 'golden.dead' },
              },
            ],
          },
        });
        expect(answer.statusCode, answer.body).toBe(200);
        const body = answer.json<{
          series: { found: boolean; points: [number, number][] }[];
          status: { source: string; state: string; partial: string[] };
        }>();
        const last = (i: number) => body.series[i]?.points.at(-1)?.[1];
        expect(last(0)).toBe(
          valueOf(server.aggregated, `${prefix}_queue_messages_ready`),
        );
        expect(last(1)).toBe(
          valueOf(server.aggregated, `${prefix}_queue_messages`),
        );
        expect(last(2)).toBe(
          valueOf(server.aggregated, `${prefix}_connections`),
        );
        expect(last(3)).toBe(
          valueOf(
            server.detailed,
            `${prefix}_detailed_queue_messages`,
            'queue="golden.classic"',
          ),
        );
        // The page lists the dead-letter queue too, but nobody asked for it.
        expect(body.series[4]?.found).toBe(false);
        expect(body.status).toMatchObject({
          source: 'prometheus',
          state: 'live',
          partial: [],
        });

        // On the wire: two GETs, no login, the detailed read for the demanded vhost only.
        expect(server.seen.map((s) => s.url.split('?')[0])).toEqual([
          '/metrics',
          '/metrics/detailed',
        ]);
        expect(server.seen.every((s) => s.authorization === undefined)).toBe(
          true,
        );
        const query = new URLSearchParams(
          server.seen[1]?.url.split('?')[1] ?? '',
        );
        expect(query.getAll('family')).toEqual([
          'queue_coarse_metrics',
          'queue_consumer_count',
        ]);
        expect(query.get('vhost')).toBe('golden');
        expect(query.get('queue')).toBe('^(?:golden\\.classic)$');
        // The scheduler gave its background slot back.
        expect(scheduler.snapshot().backgroundInFlight).toBe(0);
        await fakes.collector.stop();
      } finally {
        client.close();
        scheduler.close();
        await server.close();
      }
    },
    60_000,
  );
});
