import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { brokerData, mintEndpoint } from '../testing/lab.ts';
import { httpRaw } from './http-raw.ts';
import { ForeignEndpointError, type LabEndpoint } from './lab-endpoint.ts';

interface Seen {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  contentType: string | undefined;
  body: string;
}

let server: Server;
let seen: Seen[];
let reply: { status: number; body: string; delayMs?: number };
let endpoint: LabEndpoint;

beforeEach(async () => {
  seen = [];
  reply = { status: 200, body: '{"rabbitmq_version":"4.3.6"}' };
  server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      seen.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        contentType: request.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      });
      setTimeout(() => {
        response.statusCode = reply.status;
        response.end(reply.body);
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  endpoint = await mintEndpoint(
    brokerData({ http: `http://127.0.0.1:${String(port)}` }),
  );
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe('AC-2 the raw management HTTP driver', () => {
  it('refuses a forged endpoint without sending anything', async () => {
    const forged = { ...endpoint } as LabEndpoint;

    await expect(
      httpRaw(forged, { method: 'GET', path: '/api/overview' }),
    ).rejects.toThrow(ForeignEndpointError);
    expect(seen).toEqual([]);
  });

  it('sends the request to the endpoint, with its login, and returns the status and the parsed body', async () => {
    const answer = await httpRaw(endpoint, {
      method: 'GET',
      path: '/api/overview',
    });

    expect(answer).toEqual({
      status: 200,
      json: { rabbitmq_version: '4.3.6' },
    });
    expect(seen).toEqual([
      {
        method: 'GET',
        url: '/api/overview',
        authorization: `Basic ${Buffer.from('guest:guest').toString('base64')}`,
        contentType: undefined,
        body: '',
      },
    ]);
  });

  it('sends a JSON body with its content type, for the destructive paths of the management API', async () => {
    reply = { status: 200, body: '[]' };

    await httpRaw(endpoint, {
      method: 'POST',
      path: '/api/queues/%2F/q/get',
      body: { count: 1, ackmode: 'ack_requeue_false', encoding: 'auto' },
    });

    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: '/api/queues/%2F/q/get',
      contentType: 'application/json',
      body: '{"count":1,"ackmode":"ack_requeue_false","encoding":"auto"}',
    });
  });

  it('returns the status of an error answer and no body when it is not JSON', async () => {
    reply = { status: 404, body: 'Object Not Found' };

    expect(
      await httpRaw(endpoint, {
        method: 'DELETE',
        path: '/api/queues/%2F/missing',
      }),
    ).toEqual({
      status: 404,
      json: undefined,
    });
    reply = { status: 204, body: '' };
    expect(
      await httpRaw(endpoint, {
        method: 'PUT',
        path: '/api/queues/%2F/q',
        body: {},
      }),
    ).toEqual({
      status: 204,
      json: undefined,
    });
  });

  it.each([
    'overview',
    '/overview',
    '/api',
    '/apix/overview',
    'http://127.0.0.1:5672/api/overview',
    '//evil.example/api/overview',
    '/api/../etc/passwd',
    '/api/queues/%2F/../../x',
    '/api/overview HTTP/1.1\r\nHost: evil',
    '/api/overview#fragment',
    '/api/ü',
    '',
  ])('refuses the path %j', async (path) => {
    await expect(httpRaw(endpoint, { method: 'GET', path })).rejects.toThrow(
      /not a management API path/,
    );
    expect(seen).toEqual([]);
  });

  it('accepts a query string, an encoded vhost and a queue name with dots and dashes', async () => {
    await httpRaw(endpoint, {
      method: 'GET',
      path: '/api/queues/%2F/lab-cf-smoke-01-0a1b.q?columns=name&page=1',
    });

    expect(seen[0]?.url).toBe(
      '/api/queues/%2F/lab-cf-smoke-01-0a1b.q?columns=name&page=1',
    );
  });

  it('times out instead of waiting for ever', async () => {
    reply = { status: 200, body: '{}', delayMs: 500 };

    await expect(
      httpRaw(endpoint, {
        method: 'GET',
        path: '/api/overview',
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/timed out/);
  });
});
