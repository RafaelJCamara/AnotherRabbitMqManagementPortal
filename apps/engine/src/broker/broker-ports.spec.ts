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
async function managementApi(): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer(
    (request: IncomingMessage, reply: ServerResponse) => {
      seen.push({
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: request.headers.authorization,
      });
      const path = (request.url ?? '').split('?')[0] ?? '';
      const body = BROKER_ROUTES[path];
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
