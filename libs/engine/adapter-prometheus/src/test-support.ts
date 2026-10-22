// Helpers shared by the specs of this project. Not exported by index.ts.
import {
  createServer,
  type IncomingHttpHeaders,
  type RequestListener,
  type Server,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import type { ConnectionId } from '@app/contracts';
import type { PromSample } from '@app/ports';
import { createDialer, type DialerOptions } from '@app/net-dialer';

import {
  createPromScrapeClient,
  type PromAuth,
  type PromScrapeClient,
  type PromTarget,
  type PromTargetRequest,
} from './client.ts';
import { parseExposition, type ParseOptions } from './parser.ts';

export const CID = 'c1' as ConnectionId;

/** Polls until condition holds (up to 5 s): the specs wait for an event, never for a fixed time. */
export async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const encoder = new TextEncoder();

/** `text` as an async stream of chunks cut at the given byte sizes (repeating the last). */
export function chunked(
  text: string | Uint8Array,
  sizes: readonly number[],
): AsyncIterable<Uint8Array> {
  const bytes = typeof text === 'string' ? encoder.encode(text) : text;
  return {
    [Symbol.asyncIterator]: async function* chunks() {
      let at = 0;
      let index = 0;
      while (at < bytes.length) {
        const size = sizes[Math.min(index, sizes.length - 1)] ?? bytes.length;
        yield bytes.subarray(at, at + Math.max(1, size));
        at += Math.max(1, size);
        index++;
        await Promise.resolve();
      }
    },
  };
}

export interface Parsed {
  readonly samples: PromSample[];
  readonly summary: Awaited<ReturnType<typeof parseExposition>>;
}

export async function parseAll(
  source: AsyncIterable<Uint8Array>,
  options: ParseOptions = {},
): Promise<Parsed> {
  const samples: PromSample[] = [];
  const summary = await parseExposition(
    source,
    (sample) => {
      samples.push(sample);
    },
    options,
  );
  return { samples, summary };
}

export interface Seen {
  readonly method: string;
  /** Path and query exactly as the client sent them. */
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
}

export interface Reply {
  readonly status: number;
  readonly body?: string;
  readonly headers?: Record<string, string>;
  /** Writes the body in pieces of this size with a turn between them. */
  readonly pieceBytes?: number;
}

export interface PromServer {
  readonly port: number;
  readonly requests: readonly Seen[];
  reply(next: (seen: Seen) => Reply): void;
  close(): Promise<void>;
}

/** A plain HTTP server on 127.0.0.1 that records every request. */
export async function startPromServer(
  listener?: RequestListener,
): Promise<PromServer> {
  const requests: Seen[] = [];
  let answer: (seen: Seen) => Reply = () => ({ status: 200, body: '' });
  const server: Server = createServer(
    listener ??
      ((req, res) => {
        const seen: Seen = {
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
        };
        requests.push(seen);
        const reply = answer(seen);
        res.writeHead(reply.status, {
          'content-type': 'text/plain; version=0.0.4',
          ...reply.headers,
        });
        const body = reply.body ?? '';
        const piece = reply.pieceBytes ?? body.length;
        void (async () => {
          for (let at = 0; at < body.length; at += Math.max(1, piece)) {
            if (res.destroyed) return;
            res.write(body.slice(at, at + Math.max(1, piece)));
            await new Promise((resolve) => setImmediate(resolve));
          }
          res.end();
        })();
      }),
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    reply: (next) => {
      answer = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

export const CANARY = 'canary-secret-prom-9d41';

export interface HarnessOptions {
  readonly auth?: PromAuth;
  readonly dialer?: DialerOptions;
  readonly requestTimeoutMs?: number;
}

export interface Harness {
  readonly client: PromScrapeClient;
  readonly signal: AbortSignal;
  /** What the resolver was asked, in order. */
  readonly asked: readonly PromTargetRequest[];
}

/** A client for a listener on `port`, over the real Dialer (direct route). */
export function harness(port: number, options: HarnessOptions = {}): Harness {
  const asked: PromTargetRequest[] = [];
  const target: PromTarget = {
    host: '127.0.0.1',
    port,
    route: { kind: 'direct' },
    auth: options.auth ?? { kind: 'none' },
  };
  const client = createPromScrapeClient({
    dialer: createDialer(options.dialer),
    targets: {
      resolve: (request) => {
        asked.push(request);
        return Promise.resolve(target);
      },
    },
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
  });
  return { client, signal: new AbortController().signal, asked };
}
