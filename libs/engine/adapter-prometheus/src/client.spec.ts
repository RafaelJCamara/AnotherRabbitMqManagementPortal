import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { PromScrapeError } from './errors.ts';
import { parseExposition } from './parser.ts';
import {
  CANARY,
  CID,
  harness,
  parseAll,
  startPromServer,
  until,
  type Harness,
  type PromServer,
} from './test-support.ts';

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function setup(
  options: Parameters<typeof harness>[1] = {},
): Promise<{ server: PromServer; h: Harness }> {
  const server = await startPromServer();
  closers.push(() => server.close());
  const h = harness(server.port, options);
  closers.push(() => {
    h.client.close();
  });
  return { server, h };
}

const scrape = (
  h: Harness,
  request: Partial<Parameters<Harness['client']['scrape']['scrape']>[0]> = {},
  signal: AbortSignal = h.signal,
) =>
  h.client.scrape.scrape(
    {
      connectionId: CID,
      node: 'rabbit@n1',
      path: '/metrics',
      lane: 'background',
      ...request,
    },
    signal,
  );

async function failure(promise: Promise<unknown>): Promise<PromScrapeError> {
  try {
    await promise;
  } catch (error) {
    return error as PromScrapeError;
  }
  throw new Error('expected the scrape to fail');
}

/** Reads a body to the end and returns its text. */
async function text(body: AsyncIterable<Uint8Array>): Promise<string> {
  const parts: Uint8Array[] = [];
  for await (const chunk of body) parts.push(chunk);
  return Buffer.concat(parts).toString('utf8');
}

describe('PromScrapeClient', () => {
  it('AC-8 sends one GET of the exact path and query, asks the resolver for the node and the endpoint', async () => {
    const { server, h } = await setup();
    server.reply(() => ({
      status: 200,
      body: 'rabbitmq_queue_messages_ready 7\n',
    }));
    const endpoint = `http://127.0.0.1:${String(server.port)}/metrics`;
    const body = await scrape(h, {
      node: 'rabbit@n2',
      endpoint,
      path: '/metrics/detailed',
      query: {
        family: ['queue_coarse_metrics', 'queue_consumer_count'],
        vhost: '/',
        queue: '^(a|b)$',
      },
    });
    const { samples } = await parseAll(body);
    expect(samples).toEqual([
      { name: 'rabbitmq_queue_messages_ready', labels: {}, value: 7 },
    ]);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.method).toBe('GET');
    expect(server.requests[0]?.url).toBe(
      '/metrics/detailed?family=queue_coarse_metrics&family=queue_consumer_count&vhost=%2F&queue=%5E(a%7Cb)%24',
    );
    expect(server.requests[0]?.headers.authorization).toBeUndefined();
    expect(server.requests[0]?.headers['accept-encoding']).toBe('identity');
    expect(h.asked).toEqual([
      { connectionId: CID, node: 'rabbit@n2', endpoint },
    ]);
  });

  it('AC-8 the login goes as Authorization only when the resolver gave one', async () => {
    const { server, h } = await setup({
      auth: { kind: 'basic', username: 'monitor', password: 'pw' },
    });
    await text(await scrape(h));
    expect(server.requests[0]?.headers.authorization).toBe(
      `Basic ${Buffer.from('monitor:pw').toString('base64')}`,
    );
    const bearer = await setup({ auth: { kind: 'bearer', token: 'tok.en-1' } });
    await text(await scrape(bearer.h));
    expect(bearer.server.requests[0]?.headers.authorization).toBe(
      'Bearer tok.en-1',
    );
    const bad = await setup({
      auth: { kind: 'bearer', token: 'bad token\r\nx: y' },
    });
    expect((await failure(scrape(bad.h))).reason).toBe('invalid-request');
    expect(bad.server.requests).toHaveLength(0);
  });

  it('AC-8 sockets come from the Dialer, with the prom-scrape purpose', async () => {
    const purposes: string[] = [];
    const allowed = await setup({
      dialer: {
        policy: {
          evaluate: (asked) => {
            purposes.push(asked.purpose);
            return { allowed: true };
          },
        },
      },
    });
    await text(await scrape(allowed.h));
    expect(purposes).toEqual(['prom-scrape']);

    const denied = await setup({
      dialer: {
        policy: {
          evaluate: () => ({ allowed: false, reason: 'no egress' }),
        },
      },
    });
    const error = await failure(scrape(denied.h));
    expect(error.code).toBe('EGRESS_DENIED');
    expect(error.retryable).toBe(false);
    expect(denied.server.requests).toHaveLength(0);
  });

  it('AC-8 a refusal maps to its code and a redirect is not followed', async () => {
    const { server, h } = await setup();
    const cases: [number, string, string][] = [
      [401, 'UNAUTHENTICATED', 'auth-refused'],
      [403, 'FORBIDDEN_BROKER', 'forbidden'],
      [404, 'NOT_FOUND', 'not-found'],
      [429, 'RATE_LIMITED', 'rate-limited'],
      [500, 'BROKER_ERROR', 'server-error'],
      [503, 'BROKER_UNREACHABLE', 'unavailable'],
      [302, 'BROKER_ERROR', 'redirect-refused'],
    ];
    for (const [status, code, reason] of cases) {
      server.reply(() => ({
        status,
        body: 'secret-looking body that must not be echoed',
        headers: status === 302 ? { location: 'http://169.254.169.254/' } : {},
      }));
      const before = server.requests.length;
      const error = await failure(scrape(h));
      expect(error.code, String(status)).toBe(code);
      expect(error.reason, String(status)).toBe(reason);
      expect(error.broker, String(status)).toEqual({
        protocol: 'http',
        code: status,
      });
      expect(error.message).not.toContain('secret-looking');
      expect(server.requests.length - before).toBe(1);
    }
  });

  it('AC-8 an abort closes the socket and a closed client refuses', async () => {
    let closedByPeer = false;
    let served = false;
    const raw = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('rabbitmq_up 1\n');
      served = true;
      res.on('close', () => {
        closedByPeer = true;
      });
    });
    await new Promise<void>((resolve) => raw.listen(0, '127.0.0.1', resolve));
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          raw.closeAllConnections();
          raw.close(() => {
            resolve();
          });
        }),
    );
    const h = harness((raw.address() as AddressInfo).port);
    const controller = new AbortController();
    const body = await scrape(h, {}, controller.signal);
    const reading = text(body).catch((error: unknown) => error);
    await until(() => served);
    controller.abort();
    expect(((await reading) as PromScrapeError).reason).toBe('aborted');
    await until(() => closedByPeer);
    expect(closedByPeer).toBe(true);

    h.client.close();
    expect((await failure(scrape(h))).reason).toBe('aborted');
  });

  it('AC-8 a request that never answers ends at the deadline', async () => {
    const raw = createServer(() => undefined);
    await new Promise<void>((resolve) => raw.listen(0, '127.0.0.1', resolve));
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          raw.closeAllConnections();
          raw.close(() => {
            resolve();
          });
        }),
    );
    const h = harness((raw.address() as AddressInfo).port, {
      requestTimeoutMs: 60,
    });
    const error = await failure(scrape(h));
    expect(error.reason).toBe('timeout');
    expect(error.retryable).toBe(true);
  });

  it('AC-8 a bad path or query is refused before any request', async () => {
    const { server, h } = await setup();
    for (const path of ['/a/../b', '//evil/metrics', '/m etrics', 'metrics']) {
      const error = await failure(scrape(h, { path: path as `/${string}` }));
      expect(error.reason, path).toBe('invalid-request');
    }
    const badKey = await failure(scrape(h, { query: { 'a b': 'x' } }));
    expect(badKey.reason).toBe('invalid-request');
    const control = await failure(scrape(h, { query: { queue: 'a\r\nb' } }));
    expect(control.reason).toBe('invalid-request');
    expect(h.asked).toHaveLength(0);
    expect(server.requests).toHaveLength(0);
  });

  it('AC-8 a big body streams through the parser without being held', async () => {
    const { server, h } = await setup();
    const lines = Array.from(
      { length: 20_000 },
      (_, i) =>
        `rabbitmq_detailed_queue_messages_ready{vhost="/",queue="q${String(i)}"} ${String(i)}`,
    ).join('\n');
    server.reply(() => ({
      status: 200,
      body: `${lines}\n`,
      pieceBytes: 16_384,
    }));
    let count = 0;
    const summary = await parseExposition(await scrape(h), () => {
      count++;
    });
    expect(count).toBe(20_000);
    expect(summary.malformed).toBe(0);
  });
});

describe('PromScrapeClient secrets', () => {
  it('AC-9 a login never reaches an error', async () => {
    const auth = {
      kind: 'basic',
      username: 'monitor',
      password: CANARY,
    } as const;
    const encoded = Buffer.from(`monitor:${CANARY}`).toString('base64');
    const { server, h } = await setup({ auth, requestTimeoutMs: 80 });
    const errors: PromScrapeError[] = [];
    for (const status of [401, 403, 404, 429, 500, 302]) {
      server.reply(() => ({
        status,
        body: `echo ${CANARY} ${encoded}`,
        headers: { 'www-authenticate': `Basic realm="${CANARY}"` },
      }));
      errors.push(await failure(scrape(h)));
    }
    // The endpoint reads the request and never answers; and an abort in flight.
    server.reply(() => ({ status: 200, body: '' }));
    const slow = createServer(() => undefined);
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          slow.closeAllConnections();
          slow.close(() => {
            resolve();
          });
        }),
    );
    const hung = harness((slow.address() as AddressInfo).port, {
      auth,
      requestTimeoutMs: 60,
    });
    errors.push(await failure(scrape(hung)));
    const denied = harness(server.port, {
      auth,
      dialer: {
        policy: { evaluate: () => ({ allowed: false, reason: 'no' }) },
      },
    });
    errors.push(await failure(scrape(denied)));

    expect(errors).toHaveLength(8);
    for (const error of errors) {
      const everything = JSON.stringify({
        message: error.message,
        detail: error.detail,
        name: error.name,
        broker: error.broker,
        stack: error.stack,
      });
      expect(everything).not.toContain(CANARY);
      expect(everything).not.toContain(encoded);
    }
    // And the URL that went out has no login in it.
    expect(server.requests.every((seen) => !seen.url.includes(CANARY))).toBe(
      true,
    );
  });
});
