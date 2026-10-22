// The Prometheus endpoints as the engine reaches them: the resolver that tells the scrape client where
// a node's listener is, and the wrapper that turns the adapter's errors into Problems.
//
//   adapter (PromScrapeClient.scrape)  ->  BrokerScheduler (schedulePromScrape)  ->  reader (parser)
//     ->  mapPromErrors  ->  service
//
// The resolver never takes an address from a request: the only addresses it dials are the ones the
// cached BrokerProfile lists (`prometheus.endpoints`, found by the probe from the broker's own
// listeners, the provider's documented ports or the default port), so the port cannot be used to
// reach a host the engine did not probe (OQ-867). The connection's login goes only to endpoints whose
// source is `provider` (Amazon MQ needs it); a listener, default or user endpoint gets none (OQ-864).
import {
  PromScrapeError,
  type PromAuth,
  type PromTarget,
  type PromTargetResolver,
} from '@app/adapter-prometheus';
import type { ConnectionId } from '@app/contracts';
import { BrokerProfileSchema } from '@app/domain-model';
import { AppError } from '@app/kernel';
import type { TrustStore } from '@app/net-truststore';
import type {
  BrokerProfileStore,
  PromReadOptions,
  PromReadPort,
  PromReadSummary,
  PromSample,
  PromScrapeRequest,
} from '@app/ports';

import type { ConnectionEndpoints } from './endpoints.ts';
import { DIRECT } from './mgmt.ts';

const unlisted = (): AppError =>
  new AppError('NOT_FOUND', {
    detail: 'That metrics endpoint is not one the broker profile lists.',
  });

/** `[::1]` as a URL carries it, `::1` as a socket wants it. */
const bare = (hostname: string): string =>
  hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;

export function createPromTargetResolver(deps: {
  readonly endpoints: Pick<ConnectionEndpoints, 'http'>;
  readonly profiles: Pick<BrokerProfileStore, 'get'>;
  readonly trust: Pick<TrustStore, 'forProfile'>;
}): PromTargetResolver {
  return {
    async resolve(request): Promise<PromTarget> {
      const cached = await deps.profiles.get(request.connectionId);
      const profile = BrokerProfileSchema.safeParse(cached?.profile);
      if (!profile.success) {
        throw new AppError('NOT_FOUND', {
          detail:
            'This connection has not been probed yet. Run the probe first.',
        });
      }
      const listed = profile.data.prometheus.endpoints.find((candidate) =>
        request.endpoint === undefined
          ? candidate.node === request.node
          : candidate.url === request.endpoint &&
            candidate.node === request.node,
      );
      if (listed === undefined) throw unlisted();
      let url: URL;
      try {
        url = new URL(listed.url);
      } catch {
        throw unlisted();
      }
      // A login in the URL would put a secret where logs and errors can reach it (I-10).
      if (
        (url.protocol !== 'http:' && url.protocol !== 'https:') ||
        url.username !== '' ||
        url.password !== ''
      ) {
        throw unlisted();
      }
      const tls = url.protocol === 'https:';
      return {
        host: bare(url.hostname),
        port: url.port === '' ? (tls ? 443 : 80) : Number(url.port),
        route: DIRECT,
        auth: await authFor(
          deps.endpoints,
          request.connectionId,
          listed.source,
        ),
        ...(tls ? { tls: deps.trust.forProfile({}) } : {}),
      };
    },
  };
}

async function authFor(
  endpoints: Pick<ConnectionEndpoints, 'http'>,
  connectionId: ConnectionId,
  source: string,
): Promise<PromAuth> {
  if (source !== 'provider') return { kind: 'none' };
  const endpoint = await endpoints.http(connectionId);
  if (endpoint === undefined) {
    throw new AppError('NOT_FOUND', { detail: 'There is no such connection.' });
  }
  switch (endpoint.login.kind) {
    case 'basic':
      return {
        kind: 'basic',
        username: endpoint.login.username,
        password: endpoint.login.password,
      };
    case 'bearer':
      return { kind: 'bearer', token: endpoint.login.token };
    case 'none':
      return { kind: 'none' };
  }
}

/** A scrape failure as a Problem: its code, its safe detail and what the endpoint answered. */
export function toAppError(error: unknown): unknown {
  if (!(error instanceof PromScrapeError)) return error;
  return new AppError(error.code, {
    detail: error.detail,
    retryable: error.retryable,
    cause: error,
    ...(error.broker === undefined ? {} : { broker: error.broker }),
  });
}

/** The reader with the adapter's errors mapped; `read` fails with an `AppError`. */
export function mapPromErrors(inner: PromReadPort): PromReadPort {
  return {
    async read(
      request: PromScrapeRequest,
      sink: (sample: PromSample) => void,
      options: PromReadOptions,
      signal: AbortSignal,
    ): Promise<PromReadSummary> {
      try {
        return await inner.read(request, sink, options, signal);
      } catch (error) {
        throw toAppError(error);
      }
    },
  };
}
