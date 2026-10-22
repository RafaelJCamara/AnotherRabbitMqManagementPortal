// The real broker ports of the composition root (the management adapter behind the BrokerScheduler,
// the Dialer, the stored login) against a management API on loopback, through the real router. No
// Docker: the lab brokers are covered by the `it` targets of svc-capabilities and svc-explorer.
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BROKER_ROUTES,
  boot,
  closeAll,
  OWNER,
  storedConfig,
} from '../testing/services.ts';
import { createBrokerPorts } from './index.ts';

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
}

const servers: Server[] = [];

afterEach(async () => {
  await closeAll();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** A management API: it answers from `BROKER_ROUTES` and writes down every request it saw. */
async function managementApi(
  routes: Readonly<Record<string, unknown>> = BROKER_ROUTES,
): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer(
    (request: IncomingMessage, reply: ServerResponse) => {
      seen.push({
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: request.headers.authorization,
      });
      const path = (request.url ?? '').split('?')[0] ?? '';
      const body = routes[path];
      reply.setHeader('content-type', 'application/json');
      if (body === undefined) {
        reply.statusCode = 404;
        reply.end('{"error":"Object Not Found","reason":"Not Found"}');
        return;
      }
      reply.end(JSON.stringify(body));
    },
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, seen };
}

/** A TCP port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const BASIC = `Basic ${Buffer.from('guest:guest-secret').toString('base64')}`;

describe('the real broker ports', () => {
  it('AC-9 probe.run and the explorer reach a management API with the stored login, through the scheduler, and only read', async () => {
    const api = await managementApi();
    const booted = await boot(createBrokerPorts);
    await booted.seed('c1', { http: api.port, amqp: await closedPort() });

    const probe = await booted.call('POST', '/connections/c1/probe', {});
    const queries = () =>
      booted.call('POST', '/connections/c1/inventory/queries', {
        kind: 'queues',
        window: { offset: 0, limit: 10 },
      });
    await vi.waitFor(async () => {
      expect(((await queries()).body.rows as unknown[]).length).toBe(3);
    });

    expect(probe.status).toBe(200);
    expect(probe.body).toMatchObject({
      changed: true,
      profile: { product: 'rabbitmq', versions: { min: { raw: '4.3.6' } } },
    });
    // The AMQP port is closed: the handshake is "unavailable", never a failure of the probe.
    expect(
      (probe.body.steps as { id: string; status: string }[]).find(
        (step) => step.id === 'amqp-handshake',
      ),
    ).toMatchObject({ status: 'unavailable', detail: 'unreachable' });
    expect(api.seen.length).toBeGreaterThan(5);
    expect(new Set(api.seen.map((request) => request.method))).toEqual(
      new Set(['GET']),
    );
    expect(new Set(api.seen.map((request) => request.authorization))).toEqual(
      new Set([BASIC]),
    );
    expect(
      api.seen.some((request) => request.url.startsWith('/api/queues/%2F')),
    ).toBe(true);
  });

  it('AC-18 the metrics engine scrapes the listener the profile lists: no login, only reads, through the scheduler and the parser; a listener the profile does not list is never dialled', async () => {
    const exposition = [
      '# TYPE rabbitmq_queue_messages_ready gauge',
      'rabbitmq_queue_messages_ready 41',
      'rabbitmq_connections 5',
      'erlang_vm_dist_recv_bytes 99',
      '',
    ].join('\n');
    const scrapes: Seen[] = [];
    const prom = createServer((request, reply) => {
      scrapes.push({
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: request.headers.authorization,
      });
      reply.setHeader('content-type', 'text/plain; version=0.0.4');
      reply.end(exposition);
    });
    servers.push(prom);
    await new Promise<void>((resolve) => prom.listen(0, '127.0.0.1', resolve));
    const promPort = (prom.address() as AddressInfo).port;
    const api = await managementApi({
      ...BROKER_ROUTES,
      '/api/overview': {
        ...(BROKER_ROUTES['/api/overview'] as Record<string, unknown>),
        listeners: [
          { protocol: 'http', port: 15672 },
          { node: 'rabbit@a', protocol: 'http/prometheus', port: promPort },
        ],
      },
    });
    const booted = await boot(createBrokerPorts);
    await booted.seed('c1', { http: api.port, amqp: await closedPort() });
    const probe = await booted.call('POST', '/connections/c1/probe', {});
    expect(probe.body).toMatchObject({
      profile: {
        prometheus: {
          endpoints: [
            {
              node: 'rabbit@a',
              url: `http://127.0.0.1:${String(promPort)}/metrics`,
              source: 'listener',
            },
          ],
        },
      },
    });

    const ask = () =>
      booted.call('POST', '/connections/c1/metrics/queries', {
        series: [{ metric: 'messages_ready' }, { metric: 'connections' }],
      });
    await ask();
    await vi.waitFor(async () => {
      const answer = await ask();
      expect(answer.body).toMatchObject({
        series: [{ found: true }, { found: true }],
        status: { source: 'prometheus', state: 'live', partial: [] },
      });
    });
    const answer = await ask();
    const series = answer.body.series as { points: [number, number][] }[];
    expect(series.map((one) => one.points.at(-1)?.[1])).toEqual([41, 5]);
    expect(scrapes.length).toBeGreaterThan(0);
    expect(new Set(scrapes.map((seen) => seen.method))).toEqual(
      new Set(['GET']),
    );
    expect(new Set(scrapes.map((seen) => seen.url))).toEqual(
      new Set(['/metrics']),
    );
    // A listener (not a provider endpoint) gets no login: the management login stays on its own port.
    expect(new Set(scrapes.map((seen) => seen.authorization))).toEqual(
      new Set([undefined]),
    );
    // The collection read no management object: the aggregate page answered.
    expect(
      api.seen.filter((seen) => seen.url.startsWith('/api/queues/')),
    ).toEqual([]);
  });

  it('AC-18 the scrape resolver only dials what the cached profile lists, and holds no login in an error', async () => {
    const { createPromTargetResolver } = await import('./prom.ts');
    const booted = await boot();
    await booted.seed('c1');
    await booted.call('POST', '/connections/c1/probe', {});
    const input = booted.input();
    const resolver = createPromTargetResolver({
      endpoints: {
        http: () => Promise.reject(new Error('not read for a listener')),
      },
      profiles: input.profiles,
      trust: input.trust,
    });
    const signal = new AbortController().signal;
    // The probed profile of the fake broker lists no Prometheus endpoint at all.
    await expect(
      resolver.resolve(
        {
          connectionId: 'c1' as never,
          node: 'rabbit@a',
          endpoint: 'http://169.254.169.254/metrics',
        },
        signal,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      resolver.resolve(
        { connectionId: 'nope' as never, node: 'rabbit@a' },
        signal,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('AC-10 a login the broker refuses is a Problem with the code of the refusal, not an INTERNAL error, and holds no secret', async () => {
    const server = createServer((_request, reply) => {
      reply.statusCode = 401;
      reply.setHeader('content-type', 'application/json');
      reply.end('{"error":"not_authorised","reason":"Login failed"}');
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const booted = await boot(createBrokerPorts);
    await booted.seed('c1', {
      http: (server.address() as AddressInfo).port,
      amqp: await closedPort(),
    });

    const probe = await booted.call('POST', '/connections/c1/probe', {});

    expect(probe.body).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(JSON.stringify(probe.body)).not.toContain('guest-secret');
  });

  it('AC-11 a stored login that cannot be opened never reaches the broker', async () => {
    const api = await managementApi();
    const booted = await boot(createBrokerPorts);
    // A credential sealed for another row does not open for this one (the place is authenticated data).
    const sealer = booted.input().sealer;
    const foreign = await sealer.seal(
      'credentials',
      'ciphertext',
      'another:http',
      Buffer.from('guest-secret'),
    );
    await booted.repos().connections.save(
      {
        id: 'c9',
        name: 'Moved credential',
        envClass: 'dev',
        color: null,
        config: storedConfig(api.port),
        ownerId: OWNER,
        visibility: 'private',
      },
      { put: { http: foreign } },
    );

    const probe = await booted.call('POST', '/connections/c9/probe', {});

    expect(probe.status).toBeGreaterThanOrEqual(400);
    expect(api.seen).toEqual([]);
    expect(JSON.stringify(probe.body)).not.toContain('guest-secret');
  });
});
