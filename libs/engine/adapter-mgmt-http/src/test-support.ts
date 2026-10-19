// Helpers shared by the specs of this project. Not exported by index.ts.
//
// The specs run the real client over the real Dialer against a local HTTP server, so the wire
// behaviour (request line, query, headers, body, keep-alive) is what is tested, not a mock of it.
import {
  createServer,
  type IncomingHttpHeaders,
  type RequestListener,
  type Server,
} from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';

import type { ConnectionId } from '@app/contracts';
import { parseSemVer, type SemVer } from '@app/domain-model';
import { createDialer, type DialerOptions } from '@app/net-dialer';
import {
  createTrustStore,
  type TlsTrust,
  type TrustStore,
} from '@app/net-truststore';

import {
  createMgmtHttpClient,
  type MgmtAuth,
  type MgmtHttpClient,
  type MgmtHttpClientOptions,
  type MgmtTarget,
} from './client.ts';
import type { QueryProfile } from './query.ts';

export const CID = 'c1' as ConnectionId;

export interface Seen {
  readonly method: string;
  /** Path and query exactly as the client sent them. */
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface Reply {
  readonly status: number;
  readonly body?: string;
  readonly headers?: Record<string, string>;
  /** Wait this long before answering (timeout and abort specs). */
  readonly delayMs?: number;
}

export interface MgmtServer {
  readonly port: number;
  readonly requests: readonly Seen[];
  /** Replaces the answer; the default is `200 []`. */
  reply(next: (seen: Seen) => Reply): void;
  close(): Promise<void>;
}

/** A plain HTTP server on 127.0.0.1 that records every request. */
export async function startMgmtServer(
  makeServer: (
    listener: RequestListener,
  ) => Server | HttpsServer = createServer,
): Promise<MgmtServer> {
  const requests: Seen[] = [];
  let answer: (seen: Seen) => Reply = () => ({ status: 200, body: '[]' });
  const server = makeServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (part: Buffer) => parts.push(part));
    req.on('end', () => {
      const seen: Seen = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(parts).toString('utf8'),
      };
      requests.push(seen);
      const reply = answer(seen);
      setTimeout(() => {
        res.writeHead(reply.status, {
          'content-type': 'application/json',
          ...reply.headers,
        });
        res.end(reply.body ?? '');
      }, reply.delayMs ?? 0);
    });
  });
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

const version = (text: string): SemVer => {
  const parsed = parseSemVer(text);
  if (parsed === null) throw new Error(`test setup: ${text} does not parse`);
  return parsed;
};

export interface ProfileOptions {
  readonly statsOff?: boolean;
  readonly product?: QueryProfile['product'];
}

/** The slice of a BrokerProfile the client reads, for a one-node broker of `semver`. */
export function profileOf(
  semver: string,
  options: ProfileOptions = {},
): QueryProfile {
  const parsed = version(semver);
  return {
    product: options.product ?? 'rabbitmq',
    stats: { disabled: options.statsOff === true, queueTotals: true },
    versions: {
      min: parsed,
      perNode: { 'rabbit@n0': parsed },
      mixed: false,
      build: 'oss',
    },
  };
}

export const BASIC: MgmtAuth = {
  kind: 'basic',
  username: 'monitor',
  password: 'canary-secret-7f3a',
};

/** A trust store with no system or bundled CAs: only what a test imports is trusted. */
export function emptyTrustStore(): TrustStore {
  return createTrustStore({
    runtime: {
      getCACertificates: () => [],
      setDefaultCACertificates: () => undefined,
    },
  });
}

export interface HarnessOptions {
  readonly profile?: QueryProfile;
  readonly auth?: MgmtAuth;
  readonly pathPrefix?: string;
  readonly tls?: TlsTrust;
  readonly servername?: string;
  readonly dialer?: DialerOptions;
  readonly client?: Partial<Omit<MgmtHttpClientOptions, 'dialer' | 'targets'>>;
}

export interface Harness {
  readonly client: MgmtHttpClient;
  readonly signal: AbortSignal;
  /** Resolves of the target, to count them. */
  readonly resolved: () => number;
}

/** A client for a broker listening on `port`, over the real Dialer (direct route). */
export function harness(port: number, options: HarnessOptions = {}): Harness {
  let resolved = 0;
  const target: MgmtTarget = {
    host: '127.0.0.1',
    port,
    route: { kind: 'direct' },
    auth: options.auth ?? BASIC,
    profile: options.profile ?? profileOf('4.3.6'),
    ...(options.pathPrefix === undefined
      ? {}
      : { pathPrefix: options.pathPrefix }),
    ...(options.tls === undefined ? {} : { tls: options.tls }),
    ...(options.servername === undefined
      ? {}
      : { servername: options.servername }),
  };
  const client = createMgmtHttpClient({
    dialer: createDialer(options.dialer),
    targets: {
      resolve: () => {
        resolved += 1;
        return Promise.resolve(target);
      },
    },
    ...options.client,
  });
  return {
    client,
    signal: new AbortController().signal,
    resolved: () => resolved,
  };
}
