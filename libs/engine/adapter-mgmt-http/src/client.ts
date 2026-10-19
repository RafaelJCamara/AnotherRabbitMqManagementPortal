// The management HTTP client (DC-48): `MgmtReadPort` and `MgmtWritePort` over Node's HTTP client,
// with sockets from the Dialer (I-9), answers read with zod, paging and the stats rules of
// query.ts, the status-to-code map of errors.ts and the product rules of product.ts.
//
// The adapter does not schedule. It is handed to the BrokerScheduler's wrappers at the composition
// root, which are the only code that calls it (I-8, OQ-175): no queue, no cache and no retry here.
//
// Credentials (I-10) exist only in the `MgmtTarget` the resolver returns for one request. They are
// turned into the `Authorization` header and never stored, logged, put in an error or in a URL.
import type { ConnectionId } from '@app/contracts';
import type { Dialer } from '@app/net-dialer';
import type {
  MgmtGetRequest,
  MgmtReadPort,
  MgmtSendRequest,
  MgmtStreamRequest,
  MgmtWritePort,
} from '@app/ports';
import { semanticsRegistry } from '@app/semantics';
import type { OutgoingHttpHeaders } from 'node:http';
import type { z } from 'zod';

import { MgmtHttpError, errorForStatus } from './errors.ts';
import { isGetMessagesPath, normaliseGetMessagesBody } from './product.ts';
import {
  assertSafePath,
  isChannelsPath,
  shapeRequest,
  type CapabilityCheck,
  type QueryProfile,
  type ShapedRequest,
} from './query.ts';
import {
  AgentPool,
  startExchange,
  type DialInfo,
  type Exchange,
} from './transport.ts';

/** How the engine logs in to the management API. */
export type MgmtAuth =
  | {
      readonly kind: 'basic';
      readonly username: string;
      readonly password: string;
    }
  | { readonly kind: 'bearer'; readonly token: string };

/** Everything the client needs to talk to one broker, resolved for one request. */
export interface MgmtTarget extends DialInfo {
  /** `management.path_prefix` of the broker, for example `/rabbitmq`. Default none. */
  readonly pathPrefix?: string;
  readonly auth: MgmtAuth;
  /** The probed profile (product, versions, statistics mode); the registry's rules read it. */
  readonly profile: QueryProfile;
}

/** Resolves a connection id to its target (profile endpoint, secrets, TLS trust, route). */
export interface MgmtTargetResolver {
  resolve(connectionId: ConnectionId, signal: AbortSignal): Promise<MgmtTarget>;
}

export interface MgmtHttpClientOptions {
  /** The Dialer (I-9). Only `dial` is used. */
  readonly dialer: Pick<Dialer, 'dial'>;
  readonly targets: MgmtTargetResolver;
  /** The registry's `capability`; defaults to the shipped registry. */
  readonly capability?: CapabilityCheck;
  /** Milliseconds to the answer (the whole body for `get` and `send`). Default 30,000. */
  readonly requestTimeoutMs?: number;
  /** The largest `get` or `send` answer in bytes; a bigger one is refused (I-6). Default 16 MiB. */
  readonly maxBodyBytes?: number;
  /** Sockets per connection profile. Default 4 (the scheduler's interactive cap). */
  readonly maxSocketsPerConnection?: number;
}

export interface MgmtHttpClient {
  readonly read: MgmtReadPort;
  readonly write: MgmtWritePort;
  /** Drops the idle sockets of a connection, for example after its credentials or CAs changed. */
  invalidate(connectionId: ConnectionId): void;
  close(): void;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const TOKEN = /^[A-Za-z0-9._~+/=-]+$/;
const WRITE_METHODS: ReadonlySet<string> = new Set(['PUT', 'POST', 'DELETE']);

function positive(value: number | undefined, fallback: number, name: string) {
  const chosen = value ?? fallback;
  if (!Number.isInteger(chosen) || chosen < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return chosen;
}

function authorization(auth: MgmtAuth): string {
  if (auth.kind === 'basic') {
    const pair = `${auth.username}:${auth.password}`;
    return `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`;
  }
  if (!TOKEN.test(auth.token)) {
    throw new MgmtHttpError('invalid-request', 'the bearer token is not valid');
  }
  return `Bearer ${auth.token}`;
}

function prefixOf(target: MgmtTarget): string {
  const prefix = (target.pathPrefix ?? '').replace(/\/+$/, '');
  if (prefix !== '') assertSafePath(prefix);
  return prefix;
}

function shapeIssue(issues: readonly z.core.$ZodIssue[]): string {
  const where = issues
    .slice(0, 5)
    .map((issue) => issue.path.map(String).join('.') || '(root)');
  return [...new Set(where)].join(', ');
}

function parseAnswer<T>(
  schema: z.ZodType<T>,
  text: string,
  context: string,
): T {
  let json: unknown;
  if (text.trim() !== '') {
    try {
      json = JSON.parse(text);
    } catch {
      throw new MgmtHttpError(
        'unexpected-body',
        `the answer to ${context} is not JSON`,
      );
    }
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    // Paths only: the values may be message data or names.
    throw new MgmtHttpError(
      'unexpected-body',
      `the answer to ${context} does not have the expected shape (${shapeIssue(parsed.error.issues)})`,
    );
  }
  return parsed.data;
}

export function createMgmtHttpClient(
  options: MgmtHttpClientOptions,
): MgmtHttpClient {
  const timeoutMs = positive(
    options.requestTimeoutMs,
    DEFAULT_TIMEOUT_MS,
    'requestTimeoutMs',
  );
  const maxBodyBytes = positive(
    options.maxBodyBytes,
    DEFAULT_MAX_BODY_BYTES,
    'maxBodyBytes',
  );
  const capability: CapabilityCheck =
    options.capability ??
    ((id, profile) => semanticsRegistry.capability(id, profile));
  const pool = new AgentPool(
    options.dialer,
    positive(options.maxSocketsPerConnection, 4, 'maxSocketsPerConnection'),
  );

  /** Reads the body up to `limit` bytes. `truncate`: stop quietly there; else refuse. */
  async function readText(
    exchange: Exchange,
    limit: number,
    truncate: boolean,
    context: string,
  ): Promise<string> {
    const parts: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of exchange.response) {
        const part = chunk as Buffer;
        size += part.length;
        if (size > limit) {
          exchange.response.destroy();
          if (!truncate) {
            throw new MgmtHttpError(
              'response-too-large',
              `the answer to ${context} is larger than ${String(limit)} bytes`,
            );
          }
          break;
        }
        parts.push(part);
      }
    } catch (error) {
      throw error instanceof MgmtHttpError ? error : exchange.failure(error);
    }
    return Buffer.concat(parts).toString('utf8');
  }

  function translate(
    exchange: Exchange,
    text: string,
    context: string,
    path: string,
    profile: QueryProfile,
  ): MgmtHttpError {
    if (
      exchange.status === 400 &&
      isChannelsPath(path) &&
      profile.stats.disabled &&
      !capability('channelsListWithStatsOff', profile)
    ) {
      // The known hazard (channels-400-stats-off): not a bad request of ours, a closed feature.
      return new MgmtHttpError(
        'channels-stats-off',
        `${context} answered 400: this broker does not list channels while statistics are off`,
        {
          broker: { status: 400 },
          gate: {
            enabled: false,
            reason:
              'The channel list is not available while management statistics are off on this broker version.',
            source: 'channels-400-stats-off',
          },
        },
      );
    }
    return errorForStatus(exchange.status, text, context);
  }

  async function open(
    connectionId: ConnectionId,
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    path: string,
    query: MgmtGetRequest<unknown>['query'],
    body: unknown,
    signal: AbortSignal,
    deadlineCoversBody: boolean,
  ): Promise<{
    exchange: Exchange;
    target: MgmtTarget;
    shaped: ShapedRequest;
    context: string;
  }> {
    signal.throwIfAborted();
    const target = await options.targets.resolve(connectionId, signal);
    const shaped = shapeRequest(path, query, target.profile, capability);
    const headers: OutgoingHttpHeaders = {
      accept: 'application/json',
      authorization: authorization(target.auth),
    };
    let payload: string | undefined;
    if (body !== undefined) {
      const sent =
        method === 'POST' && isGetMessagesPath(path)
          ? normaliseGetMessagesBody(target.profile.product, body)
          : body;
      payload = JSON.stringify(sent);
      headers['content-type'] = 'application/json';
    }
    const exchange = await startExchange({
      agent: pool.agentFor(connectionId, target),
      host: target.host,
      port: target.port,
      method,
      target: `${prefixOf(target)}${shaped.target}`,
      headers,
      ...(payload === undefined ? {} : { body: payload }),
      signal,
      timeoutMs,
      deadlineCoversBody,
    });
    return { exchange, target, shaped, context: `${method} ${path}` };
  }

  async function run<T>(
    connectionId: ConnectionId,
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    path: string,
    query: MgmtGetRequest<unknown>['query'],
    body: unknown,
    schema: z.ZodType<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const { exchange, target, context } = await open(
      connectionId,
      method,
      path,
      query,
      body,
      signal,
      true,
    );
    try {
      const ok = exchange.status >= 200 && exchange.status < 300;
      const text = await readText(
        exchange,
        ok ? maxBodyBytes : MAX_ERROR_BODY_BYTES,
        !ok,
        context,
      );
      if (!ok) {
        throw translate(exchange, text, context, path, target.profile);
      }
      return parseAnswer(schema, text, context);
    } finally {
      exchange.settle();
    }
  }

  const read: MgmtReadPort = {
    get: <T>(request: MgmtGetRequest<T>, signal: AbortSignal): Promise<T> =>
      run(
        request.connectionId,
        'GET',
        request.path,
        request.query,
        undefined,
        request.schema,
        signal,
      ),

    async stream(
      request: MgmtStreamRequest,
      signal: AbortSignal,
    ): Promise<AsyncIterable<Uint8Array>> {
      const { exchange, target, context } = await open(
        request.connectionId,
        'GET',
        request.path,
        request.query,
        undefined,
        signal,
        false,
      );
      if (exchange.status < 200 || exchange.status >= 300) {
        try {
          const text = await readText(
            exchange,
            MAX_ERROR_BODY_BYTES,
            true,
            context,
          );
          throw translate(
            exchange,
            text,
            context,
            request.path,
            target.profile,
          );
        } finally {
          exchange.settle();
        }
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
        }
      })();
    },
  };

  const write: MgmtWritePort = {
    send: <T>(request: MgmtSendRequest<T>, signal: AbortSignal): Promise<T> => {
      // The type says so already; a caller that got past it is refused, not sent.
      if (!WRITE_METHODS.has(request.method)) {
        return Promise.reject(
          new MgmtHttpError(
            'invalid-request',
            'a write is a PUT, a POST or a DELETE',
          ),
        );
      }
      return run(
        request.connectionId,
        request.method,
        request.path,
        undefined,
        request.body,
        request.schema,
        signal,
      );
    },
  };

  return {
    read,
    write,
    invalidate: (connectionId) => {
      pool.invalidate(connectionId);
    },
    close: () => {
      pool.close();
    },
  };
}
