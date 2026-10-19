import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { MgmtGetRequest } from '@app/ports';

import { MgmtHttpError } from './errors.ts';
import { queueGet, queues } from './endpoints/index.ts';
import {
  CID,
  harness,
  profileOf,
  startMgmtServer,
  type Harness,
  type MgmtServer,
} from './test-support.ts';

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function setup(
  options: Parameters<typeof harness>[1] = {},
): Promise<{ server: MgmtServer; h: Harness }> {
  const server = await startMgmtServer();
  const h = harness(server.port, options);
  closers.push(() => {
    h.client.close();
  });
  closers.push(() => server.close());
  return { server, h };
}

const anything = z.array(z.unknown());

function get(
  path: string,
  query?: MgmtGetRequest<unknown>['query'],
): MgmtGetRequest<unknown[]> {
  return {
    connectionId: CID,
    path,
    ...(query === undefined ? {} : { query }),
    schema: anything,
    lane: 'interactive',
  };
}

async function failure(promise: Promise<unknown>): Promise<MgmtHttpError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MgmtHttpError);
    return error as MgmtHttpError;
  }
  throw new Error('expected the request to fail');
}

const queryOf = (url: string): URLSearchParams =>
  new URL(url, 'http://broker.test').searchParams;

describe('stats flags and paging', () => {
  it('AC-1 given a stats-off 4.3.5 profile, /api/channels never carries disable_stats', async () => {
    const { server, h } = await setup({
      profile: profileOf('4.3.5', { statsOff: true }),
    });

    await h.client.read.get(
      get('/api/channels', { disable_stats: true, page: 1 }),
      h.signal,
    );
    await h.client.read.get(
      get('/api/vhosts/%2F/channels', { disable_stats: 'true' }),
      h.signal,
    );

    expect(server.requests).toHaveLength(2);
    for (const seen of server.requests) {
      expect(queryOf(seen.url).has('disable_stats')).toBe(false);
    }
  });

  it('AC-1 given 4.3.6, the registry lets disable_stats through to /api/channels', async () => {
    const { server, h } = await setup({ profile: profileOf('4.3.6') });

    await h.client.read.get(
      get('/api/channels', { disable_stats: true }),
      h.signal,
    );

    expect(queryOf(server.requests[0]?.url ?? '').get('disable_stats')).toBe(
      'true',
    );
  });

  it('AC-1 given page_size 1000, it is clamped to 500 and columns= is set', async () => {
    const { server, h } = await setup();

    await h.client.read.get(get('/api/queues', { page_size: 1000 }), h.signal);

    const sent = queryOf(server.requests[0]?.url ?? '');
    expect(sent.get('page_size')).toBe('500');
    expect(sent.get('page')).toBe('1');
    expect(sent.get('columns')).toBe(queues.list.columns?.join(','));
    expect(sent.get('columns')).toContain('delivery_limit');
  });

  it('a list is always paged, even when the caller sends no query', async () => {
    const { server, h } = await setup();

    await h.client.read.get(get('/api/exchanges/%2F'), h.signal);

    const sent = queryOf(server.requests[0]?.url ?? '');
    expect(sent.get('page_size')).toBe('100');
    expect(sent.get('page')).toBe('1');
  });

  it('reads the broker envelope into one Page and a bare array into a single page', async () => {
    const { server, h } = await setup();
    const envelope = {
      items: [{ name: 'q1', vhost: '/' }],
      page: 2,
      page_count: 3,
      page_size: 1,
      total_count: 3,
      filtered_count: 3,
      item_count: 1,
    };
    server.reply(() => ({ status: 200, body: JSON.stringify(envelope) }));
    const paged = await h.client.read.get(
      { ...get('/api/queues'), schema: queues.list.schema },
      h.signal,
    );
    server.reply(() => ({
      status: 200,
      body: JSON.stringify([{ name: 'q1', vhost: '/' }]),
    }));
    const bare = await h.client.read.get(
      { ...get('/api/queues'), schema: queues.list.schema },
      h.signal,
    );

    expect(paged).toMatchObject({ page: 2, pageCount: 3, totalCount: 3 });
    expect(paged.items).toEqual([{ name: 'q1', vhost: '/' }]);
    expect(bare).toMatchObject({ page: 1, pageCount: 1, itemCount: 1 });
  });

  it('turns the channel-list 400 of a stats-off broker into a closed feature, not a bad request', async () => {
    const { server, h } = await setup({
      profile: profileOf('4.3.5', { statsOff: true }),
    });
    server.reply(() => ({
      status: 400,
      body: '{"error":"bad_request","reason":"Stats in management UI are disabled"}',
    }));

    const error = await failure(
      h.client.read.get(get('/api/channels'), h.signal),
    );

    expect(error.code).toBe('CAPABILITY_MISSING');
    expect(error.gate).toMatchObject({
      enabled: false,
      source: 'channels-400-stats-off',
    });
  });

  it('drops enable_queue_totals where the registry does not vouch for it', async () => {
    const { server, h } = await setup({ profile: profileOf('3.13.0') });

    await h.client.read.get(
      get('/api/queues/%2F/q1', { enable_queue_totals: true }),
      h.signal,
    );
    await h.client.read.get(
      get('/api/queues', { enable_queue_totals: true }),
      h.signal,
    );

    expect(
      queryOf(server.requests[0]?.url ?? '').has('enable_queue_totals'),
    ).toBe(false);
    expect(
      queryOf(server.requests[1]?.url ?? '').get('enable_queue_totals'),
    ).toBe('true');
  });
});

describe('product awareness', () => {
  const body = { count: 1, encoding: 'auto' };
  const path = '/api/queues/%2F/q1/get';

  it('AC-2 given LavinMQ, /get bodies always carry an explicit ackmode and requeue:true', async () => {
    const { server, h } = await setup({
      profile: profileOf('2.10.2', { product: 'lavinmq' }),
    });

    await h.client.write.send(
      {
        connectionId: CID,
        method: 'POST',
        path,
        body,
        schema: queueGet.schema,
      },
      h.signal,
    );
    await h.client.write.send(
      {
        connectionId: CID,
        method: 'POST',
        path,
        body: { ...body, ackmode: 'reject_requeue_true' },
        schema: queueGet.schema,
      },
      h.signal,
    );

    expect(JSON.parse(server.requests[0]?.body ?? '')).toEqual({
      ...body,
      ackmode: 'ack_requeue_true',
      requeue: true,
    });
    expect(JSON.parse(server.requests[1]?.body ?? '')).toEqual({
      ...body,
      ackmode: 'reject_requeue_true',
      requeue: true,
    });
  });

  it('keeps a destructive choice destructive on LavinMQ and leaves a RabbitMQ body as written', async () => {
    const lavin = await setup({
      profile: profileOf('2.10.2', { product: 'lavinmq' }),
    });
    const rabbit = await setup();
    const destructive = { ...body, ackmode: 'ack_requeue_false' };
    const send = (h: Harness) =>
      h.client.write.send(
        {
          connectionId: CID,
          method: 'POST',
          path,
          body: destructive,
          schema: queueGet.schema,
        },
        h.signal,
      );

    await send(lavin.h);
    await send(rabbit.h);

    expect(JSON.parse(lavin.server.requests[0]?.body ?? '')).toMatchObject({
      ackmode: 'ack_requeue_false',
      requeue: false,
    });
    expect(JSON.parse(rabbit.server.requests[0]?.body ?? '')).toEqual(
      destructive,
    );
  });

  it('does not send RabbitMQ statistics flags to another product', async () => {
    const { server, h } = await setup({
      profile: profileOf('2.10.2', { product: 'lavinmq' }),
    });

    await h.client.read.get(
      get('/api/queues', { disable_stats: true, enable_queue_totals: true }),
      h.signal,
    );

    const sent = queryOf(server.requests[0]?.url ?? '');
    expect(sent.has('disable_stats')).toBe(false);
    expect(sent.has('enable_queue_totals')).toBe(false);
  });
});

describe('errors', () => {
  it('AC-2 given a 405 Broker settings disallow body, the error is FORBIDDEN_BROKER with a provider-restriction gate', async () => {
    const { server, h } = await setup();
    server.reply(() => ({
      status: 405,
      body: '{"error":"method_not_allowed","reason":"Broker settings disallow editing of operator policies."}',
    }));

    const error = await failure(
      h.client.read.get(get('/api/operator-policies/%2F/p1'), h.signal),
    );

    expect(error.code).toBe('FORBIDDEN_BROKER');
    expect(error.gate).toEqual({
      enabled: false,
      reason: 'Broker settings disallow editing of operator policies.',
      source: 'provider-restriction',
    });
    expect(error.broker).toMatchObject({ protocol: 'http', code: 405 });
  });

  it('never puts the credential in an error, a URL or a log-shaped value', async () => {
    const { server, h } = await setup();
    server.reply(() => ({ status: 401, body: '{"reason":"Login failed"}' }));

    const error = await failure(
      h.client.read.get(get('/api/overview'), h.signal),
    );

    const everything = JSON.stringify({
      message: error.message,
      detail: error.detail,
      broker: error.broker,
      stack: error.stack,
    });
    expect(error.code).toBe('UNAUTHENTICATED');
    expect(everything).not.toContain('canary-secret-7f3a');
    expect(everything).not.toContain(
      Buffer.from('monitor:canary-secret-7f3a').toString('base64'),
    );
    expect(server.requests[0]?.url).not.toContain('canary-secret');
    expect(server.requests[0]?.headers.authorization).toBe(
      `Basic ${Buffer.from('monitor:canary-secret-7f3a').toString('base64')}`,
    );
  });

  it('answers a timeout as BROKER_UNREACHABLE and drops the connection', async () => {
    const { server, h } = await setup({ client: { requestTimeoutMs: 80 } });
    server.reply(() => ({ status: 200, body: '[]', delayMs: 1_000 }));

    const error = await failure(
      h.client.read.get(get('/api/overview'), h.signal),
    );

    expect(error.code).toBe('BROKER_UNREACHABLE');
    expect(error.reason).toBe('timeout');
    expect(error.retryable).toBe(true);
  });

  it('stops when the caller aborts', async () => {
    const { server, h } = await setup();
    server.reply(() => ({ status: 200, body: '[]', delayMs: 1_000 }));
    const controller = new AbortController();

    const pending = failure(
      h.client.read.get(get('/api/overview'), controller.signal),
    );
    setTimeout(() => {
      controller.abort();
    }, 30);

    expect((await pending).reason).toBe('aborted');
  });

  it('refuses a redirect instead of following it', async () => {
    const { server, h } = await setup();
    server.reply(() => ({
      status: 302,
      headers: { location: 'http://169.254.169.254/' },
    }));

    const error = await failure(
      h.client.read.get(get('/api/overview'), h.signal),
    );

    expect(error.reason).toBe('redirect-refused');
    expect(server.requests).toHaveLength(1);
  });

  it('refuses an answer above the byte cap (I-6)', async () => {
    const { server, h } = await setup({ client: { maxBodyBytes: 1_000 } });
    server.reply(() => ({
      status: 200,
      body: JSON.stringify(['x'.repeat(5_000)]),
    }));

    const error = await failure(
      h.client.read.get(get('/api/overview'), h.signal),
    );

    expect(error.reason).toBe('response-too-large');
  });

  it('reports the paths of a mismatch, never the values', async () => {
    const { server, h } = await setup();
    server.reply(() => ({
      status: 200,
      body: JSON.stringify([{ name: 42, vhost: 'secret-vhost-name' }]),
    }));

    const error = await failure(
      h.client.read.get(
        { ...get('/api/queues'), schema: queues.one.schema.array() },
        h.signal,
      ),
    );

    expect(error.reason).toBe('unexpected-body');
    expect(error.detail).toContain('0.name');
    expect(error.detail).not.toContain('secret-vhost-name');
  });

  it('rejects an unsafe path before anything is sent', async () => {
    const { server, h } = await setup();

    for (const path of [
      '//evil.test/x',
      '/api/../etc',
      '/api/%2e%2e/x',
      '/api?x=1',
    ]) {
      const error = await failure(h.client.read.get(get(path), h.signal));
      expect(error.reason).toBe('invalid-request');
    }
    expect(server.requests).toHaveLength(0);
  });
});

describe('requests', () => {
  it('sends the bearer token, the path prefix and a JSON body', async () => {
    const { server, h } = await setup({
      auth: { kind: 'bearer', token: 'abc.def-ghi' },
      pathPrefix: '/rabbitmq/',
    });
    server.reply(() => ({ status: 204 }));

    await h.client.write.send(
      {
        connectionId: CID,
        method: 'PUT',
        path: '/api/vhosts/v1',
        body: { description: 'x' },
        schema: z.undefined(),
      },
      h.signal,
    );

    const seen = server.requests[0];
    expect(seen?.url).toBe('/rabbitmq/api/vhosts/v1');
    expect(seen?.method).toBe('PUT');
    expect(seen?.headers.authorization).toBe('Bearer abc.def-ghi');
    expect(seen?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(seen?.body ?? '')).toEqual({ description: 'x' });
  });

  it('refuses a bearer token that could split a header', async () => {
    const { server, h } = await setup({
      auth: { kind: 'bearer', token: 'a\r\nX-Evil: 1' },
    });

    const error = await failure(
      h.client.read.get(get('/api/overview'), h.signal),
    );

    expect(error.reason).toBe('invalid-request');
    expect(server.requests).toHaveLength(0);
  });

  it('streams a large body as chunks and reports an error status as an error', async () => {
    const { server, h } = await setup();
    const big = JSON.stringify({
      queues: Array.from({ length: 2_000 }, (_, i) => ({
        name: `q${String(i)}`,
      })),
    });
    server.reply(() => ({ status: 200, body: big }));
    const chunks = await h.client.read.stream(
      { connectionId: CID, path: '/api/definitions', lane: 'background' },
      h.signal,
    );
    let text = '';
    for await (const chunk of chunks)
      text += Buffer.from(chunk).toString('utf8');
    server.reply(() => ({ status: 503, body: '{"reason":"down"}' }));

    const error = await failure(
      h.client.read.stream(
        { connectionId: CID, path: '/api/definitions', lane: 'background' },
        h.signal,
      ),
    );

    expect(text).toBe(big);
    expect(error.code).toBe('BROKER_UNREACHABLE');
    expect(error.broker?.code).toBe(503);
  });

  it('reuses one socket for sequential requests of a connection', async () => {
    const { server, h } = await setup();

    await h.client.read.get(get('/api/overview'), h.signal);
    await h.client.read.get(get('/api/overview'), h.signal);

    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]?.headers.connection).toBe('keep-alive');
  });
});
