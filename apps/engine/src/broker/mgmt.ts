// The management API as the engine reaches it: the resolver that tells the HTTP client where a
// connection is, and the wrapper that turns the adapter's errors into Problems.
//
//   adapter (MgmtHttpClient.read)  ->  BrokerScheduler (scheduleMgmtRead)  ->  mapMgmtErrors  ->  service
//
// The adapter throws `MgmtHttpError` and may not import the kernel; a service may not import the
// adapter. So the composition root maps the one to the other, outside the scheduler (which reads the
// adapter's own `code` and `broker` to tell overload from refusal).
import {
  MgmtHttpError,
  type MgmtAuth,
  type MgmtTarget,
  type MgmtTargetResolver,
} from '@app/adapter-mgmt-http';
import type { ConnectionId } from '@app/contracts';
import { BrokerProfileSchema } from '@app/domain-model';
import { AppError } from '@app/kernel';
import type { TrustStore } from '@app/net-truststore';
import type {
  BrokerProfileStore,
  MgmtGetRequest,
  MgmtReadPort,
  MgmtStreamRequest,
} from '@app/ports';

import type { ConnectionEndpoints, HttpLogin } from './endpoints.ts';

export const DIRECT = { kind: 'direct' } as const;

/** Nothing is known of the broker yet: the adapter's rules read this conservatively. */
export const UNPROBED = {
  product: 'unknown',
  stats: { disabled: false, queueTotals: false },
  versions: {
    min: null,
    perNode: {},
    mixed: false,
    build: 'commercial-or-unknown',
  },
} as const;

/** `none` has no header of its own: an empty basic login is what the broker refuses with 401. */
export function mgmtAuthOf(login: HttpLogin): MgmtAuth {
  switch (login.kind) {
    case 'basic':
      return {
        kind: 'basic',
        username: login.username,
        password: login.password,
      };
    case 'bearer':
      return { kind: 'bearer', token: login.token };
    case 'none':
      return { kind: 'basic', username: '', password: '' };
  }
}

/**
 * Resolves a connection id to the management target: the endpoint and login of the stored profile,
 * the TLS trust of the process, a direct route and the cached BrokerProfile (the unprobed one until
 * `probe.run` has stored one). Read for every request, so a changed profile is used at once.
 */
export function createMgmtTargetResolver(deps: {
  readonly endpoints: ConnectionEndpoints;
  readonly profiles: Pick<BrokerProfileStore, 'get'>;
  readonly trust: Pick<TrustStore, 'forProfile'>;
}): MgmtTargetResolver {
  return {
    async resolve(connectionId: ConnectionId): Promise<MgmtTarget> {
      const endpoint = await deps.endpoints.http(connectionId);
      if (endpoint === undefined) {
        throw new AppError('NOT_FOUND', {
          detail: 'There is no such connection.',
        });
      }
      const cached = await deps.profiles.get(connectionId);
      const parsed = BrokerProfileSchema.safeParse(cached?.profile);
      return {
        host: endpoint.host,
        port: endpoint.port,
        route: DIRECT,
        profile: parsed.success ? parsed.data : UNPROBED,
        auth: mgmtAuthOf(endpoint.login),
        ...(endpoint.pathPrefix === null
          ? {}
          : { pathPrefix: endpoint.pathPrefix }),
        ...(endpoint.tls ? { tls: deps.trust.forProfile({}) } : {}),
      };
    },
  };
}

/** A management failure as a Problem: its code, its safe detail and what the broker answered. */
export function toAppError(error: unknown): unknown {
  if (!(error instanceof MgmtHttpError)) return error;
  return new AppError(error.code, {
    detail: error.detail,
    retryable: error.retryable,
    cause: error,
    ...(error.broker === undefined ? {} : { broker: error.broker }),
    ...(error.gate === undefined ? {} : { gate: error.gate }),
  });
}

/** The read port with the adapter's errors mapped; `get` and `stream` fail with an `AppError`. */
export function mapMgmtErrors(inner: MgmtReadPort): MgmtReadPort {
  return {
    async get<T>(request: MgmtGetRequest<T>, signal: AbortSignal): Promise<T> {
      try {
        return await inner.get(request, signal);
      } catch (error) {
        throw toAppError(error);
      }
    },
    async stream(request: MgmtStreamRequest, signal: AbortSignal) {
      try {
        const body = await inner.stream(request, signal);
        return {
          [Symbol.asyncIterator]: () => {
            const iterator = body[Symbol.asyncIterator]();
            return {
              next: async () => {
                try {
                  return await iterator.next();
                } catch (error) {
                  throw toAppError(error);
                }
              },
              return: (value?: unknown) =>
                iterator.return?.(value) ??
                Promise.resolve({ done: true as const, value: undefined }),
            };
          },
        };
      } catch (error) {
        throw toAppError(error);
      }
    },
  };
}
