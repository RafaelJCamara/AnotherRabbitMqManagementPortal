// A stand-in for a lab broker, for specs that must run without Docker: an AMQP listener that
// answers the protocol header, a stream listener that answers PeerProperties, a management API and
// a Prometheus endpoint. Test support only; it is not exported from the testkit index.
import { createServer as createHttpServer, type Server } from 'node:http';
import {
  createServer as createTcpServer,
  type Server as TcpServer,
} from 'node:net';

import type { BrokerHandle } from './types.ts';

export interface FakeBrokerOptions {
  /** The version `/api/overview` reports. */
  readonly version: string;
  readonly extensions?: readonly string[];
  readonly exchangeTypes?: readonly string[];
  readonly eventExchange?: boolean;
  readonly metrics?: string;
  readonly nodesRunning?: number;
  /** Answer `/api/whoami` for a basic login whose password is a token (OAuth variant). */
  readonly acceptTokens?: boolean;
  /** Do not listen on the stream port (it refuses connections). */
  readonly noStream?: boolean;
}

export interface FakeBroker {
  readonly handle: BrokerHandle;
  readonly httpPort: number;
  close(): Promise<void>;
}

const listen = (server: Server | TcpServer): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });

const closeServer = (server: Server | TcpServer): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
    if ('closeAllConnections' in server) server.closeAllConnections();
  });

export const DEFAULT_EXTENSIONS = [
  'dispatcher',
  'shovel',
  'federation',
  'tracing',
  'stream',
];

export async function startFakeBroker(
  options: FakeBrokerOptions,
): Promise<FakeBroker> {
  const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
  const exchangeTypes = options.exchangeTypes ?? [
    'direct',
    'fanout',
    'x-consistent-hash',
  ];
  const nodes = Array.from({ length: options.nodesRunning ?? 3 }, () => ({
    running: true,
  }));
  const sockets = new Set<import('node:net').Socket>();

  const http = createHttpServer((request, response) => {
    const reply = (status: number, body: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    const expected = `Basic ${Buffer.from('guest:guest').toString('base64')}`;
    const path = request.url ?? '';
    if (path === '/api/whoami' && options.acceptTokens) {
      // the oauth2 backend: any user name, a three-part token as the password
      const password = Buffer.from(
        (request.headers.authorization ?? '').slice(6),
        'base64',
      )
        .toString()
        .split(':')
        .slice(1)
        .join(':');
      if (password.split('.').length === 3) {
        reply(200, { name: 'lab-admin', tags: 'administrator' });
        return;
      }
    }
    if (request.headers.authorization !== expected) {
      reply(401, { error: 'not_authorised' });
      return;
    }
    if (path === '/api/overview') {
      reply(200, {
        rabbitmq_version: options.version,
        exchange_types: exchangeTypes.map((name) => ({ name })),
      });
    } else if (path === '/api/extensions') {
      reply(
        200,
        extensions.map((name) => ({ javascript: `${name}.js` })),
      );
    } else if (path === '/api/exchanges/%2F/amq.rabbitmq.event') {
      if (options.eventExchange === false) reply(404, { error: 'Not Found' });
      else reply(200, { name: 'amq.rabbitmq.event', type: 'topic' });
    } else if (path === '/api/nodes') {
      reply(200, nodes);
    } else {
      reply(404, { error: 'Not Found' });
    }
  });
  const prometheus = createHttpServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(
      options.metrics ??
        '# TYPE rabbitmq_identity_info gauge\nrabbitmq_identity_info 1\n',
    );
  });

  const amqp = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on('data', () => {
      // method frame: type 1, channel 0, size 4, class 10, method 10, end marker
      socket.write(Buffer.from([1, 0, 0, 0, 0, 0, 4, 0, 10, 0, 10, 0xce]));
    });
    socket.on('error', () => undefined);
  });
  const stream = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on('data', (request: Buffer) => {
      const reply = Buffer.alloc(14);
      reply.writeUInt32BE(10, 0);
      reply.writeUInt16BE(0x8011, 4);
      reply.writeUInt16BE(1, 6);
      reply.writeUInt32BE(request.readUInt32BE(8), 8);
      reply.writeUInt16BE(1, 12);
      socket.write(reply);
    });
    socket.on('error', () => undefined);
  });

  const [httpPort, prometheusPort, amqpPort, streamPort] = await Promise.all([
    listen(http),
    listen(prometheus),
    listen(amqp),
    options.noStream ? Promise.resolve(1) : listen(stream),
  ]);

  const handle: BrokerHandle = {
    version: options.version,
    variant: 'plain',
    nodes: 1,
    digest: `sha256:${'0'.repeat(64)}`,
    amqp: `amqp://127.0.0.1:${String(amqpPort)}`,
    http: `http://127.0.0.1:${String(httpPort)}`,
    stream: `rabbitmq-stream://127.0.0.1:${String(streamPort)}`,
    prometheus: `http://127.0.0.1:${String(prometheusPort)}/metrics`,
    credentials: { username: 'guest', password: 'guest' },
    stop: () => Promise.resolve(),
  };
  return {
    handle,
    httpPort,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        closeServer(http),
        closeServer(prometheus),
        closeServer(amqp),
        ...(options.noStream ? [] : [closeServer(stream)]),
      ]);
    },
  };
}
