// The Prometheus scrape client (DC-33): `PromScrapePort` over Node's HTTP client, with sockets from
// the Dialer (I-9). It returns the body as chunks for the streaming parser (parser.ts) and turns a
// refusal into a `PromScrapeError`.
//
// The adapter does not schedule. It is handed to the BrokerScheduler's wrapper (`schedulePromScrape`)
// at the composition root, which is the only code that calls it (I-8): no queue, no retry, no cache.
//
// Credentials (I-10) exist only in the `PromTarget` the resolver returns for one request. They are
// turned into the `Authorization` header and never stored, logged, put in an error or in a URL.
import type { ConnectionId } from '@app/contracts';
import type { Dialer } from '@app/net-dialer';
import type { PromQuery, PromScrapePort, PromScrapeRequest } from '@app/ports';
import type { OutgoingHttpHeaders } from 'node:http';

import { PromScrapeError, errorForStatus } from './errors.ts';
import { startExchange, type DialInfo } from './transport.ts';

/** How the engine logs in to a metrics endpoint; most listeners need no login at all. */
export type PromAuth =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'basic';
      readonly username: string;
      readonly password: string;
    }
  | { readonly kind: 'bearer'; readonly token: string };

/** Everything the client needs to scrape one listener, resolved for one request. */
export interface PromTarget extends DialInfo {
  readonly auth: PromAuth;
}

export interface PromTargetRequest {
  readonly connectionId: ConnectionId;
  readonly node: string;
  /** A URL of the BrokerProfile's `prometheus.endpoints`; the resolver refuses any other. */
  readonly endpoint?: string;
}

/** Resolves a node of a connection to its listener (the composition root reads the stored profile). */
export interface PromTargetResolver {
  resolve(request: PromTargetRequest, signal: AbortSignal): Promise<PromTarget>;
}

export interface PromScrapeClientOptions {
  /** The Dialer (I-9). Only `dial` is used. */
  readonly dialer: Pick<Dialer, 'dial'>;
  readonly targets: PromTargetResolver;
  /** Milliseconds for the whole exchange, body included. Default 30,000. */
  readonly requestTimeoutMs?: number;
}

export interface PromScrapeClient {
  readonly scrape: PromScrapePort;
  /** Aborts every scrape in flight and refuses new ones. */
  close(): void;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const SAFE_PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;
const KEY = /^[A-Za-z0-9_.-]{1,64}$/;
const TOKEN = /^[A-Za-z0-9._~+/=-]+$/;
const MAX_VALUE_LENGTH = 2_048;
const MAX_TARGET_LENGTH = 16 * 1024;

function assertSafePath(path: string): void {
  const dot = path
    .split('/')
    .some((segment) => segment === '.' || segment === '..');
  if (!SAFE_PATH.test(path) || path.startsWith('//') || dot) {
    throw new PromScrapeError(
      'invalid-request',
      'the request path is not valid',
    );
  }
}

function assertSafeValue(key: string, value: string | number | boolean): void {
  if (!KEY.test(key)) {
    throw new PromScrapeError('invalid-request', 'a query key is not valid');
  }
  if (
    typeof value === 'string' &&
    (value.length > MAX_VALUE_LENGTH || /[\u0000-\u001f\u007f]/.test(value))
  ) {
    throw new PromScrapeError(
      'invalid-request',
      `the query value of ${key} is not valid`,
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new PromScrapeError(
      'invalid-request',
      `the query value of ${key} is not a number`,
    );
  }
}

/** Path and encoded query, keys in the order given, a list repeating its key. */
export function targetOf(path: string, query: PromQuery | undefined): string {
  assertSafePath(path);
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(query ?? {})) {
    for (const each of typeof value === 'object' ? value : [value]) {
      assertSafeValue(key, each);
      pairs.push(
        `${encodeURIComponent(key)}=${encodeURIComponent(String(each))}`,
      );
    }
  }
  const target = pairs.length === 0 ? path : `${path}?${pairs.join('&')}`;
  if (target.length > MAX_TARGET_LENGTH) {
    throw new PromScrapeError('invalid-request', 'the request is too long');
  }
  return target;
}

function authorization(auth: PromAuth): string | undefined {
  switch (auth.kind) {
    case 'none':
      return undefined;
    case 'basic':
      return `Basic ${Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64')}`;
    case 'bearer':
      if (!TOKEN.test(auth.token)) {
        throw new PromScrapeError(
          'invalid-request',
          'the bearer token is not valid',
        );
      }
      return `Bearer ${auth.token}`;
  }
}

export function createPromScrapeClient(
  options: PromScrapeClientOptions,
): PromScrapeClient {
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError('requestTimeoutMs must be a positive integer');
  }
  const live = new Set<AbortController>();
  let closed = false;

  const scrape: PromScrapePort = {
    async scrape(
      request: PromScrapeRequest,
      signal: AbortSignal,
    ): Promise<AsyncIterable<Uint8Array>> {
      if (closed) {
        throw new PromScrapeError('aborted', 'the metrics client is closed');
      }
      const target = targetOf(request.path, request.query);
      const control = new AbortController();
      live.add(control);
      const joined = AbortSignal.any([signal, control.signal]);
      try {
        const resolved = await options.targets.resolve(
          {
            connectionId: request.connectionId,
            node: request.node,
            ...(request.endpoint === undefined
              ? {}
              : { endpoint: request.endpoint }),
          },
          joined,
        );
        const headers: OutgoingHttpHeaders = {
          accept: 'text/plain;version=0.0.4;q=1,*/*;q=0.1',
          'accept-encoding': 'identity',
        };
        const login = authorization(resolved.auth);
        if (login !== undefined) headers.authorization = login;
        const exchange = await startExchange({
          dial: resolved,
          dialer: options.dialer,
          target,
          headers,
          signal: joined,
          timeoutMs,
        });
        if (exchange.status < 200 || exchange.status >= 300) {
          exchange.response.destroy();
          exchange.settle();
          throw errorForStatus(exchange.status, `GET ${request.path}`);
        }
        return (async function* chunks(): AsyncGenerator<Uint8Array> {
          try {
            for await (const chunk of exchange.response) {
              yield chunk as Uint8Array;
            }
          } catch (error) {
            throw exchange.failure(error);
          } finally {
            exchange.response.destroy();
            exchange.settle();
            live.delete(control);
          }
        })();
      } catch (error) {
        live.delete(control);
        throw error;
      }
    },
  };

  return {
    scrape,
    close: () => {
      closed = true;
      for (const control of live) control.abort();
      live.clear();
    },
  };
}
