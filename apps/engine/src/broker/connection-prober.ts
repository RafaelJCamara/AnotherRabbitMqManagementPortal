// The ConnectionProber of svc-connections over the real adapters (OQ-441): `connections.test-http`
// and `connections.test-amqp` try an endpoint a person typed, before or after it is saved. Both calls
// dial through the Dialer (I-9) with the credentials of that one call and keep none of them. A draft
// has no connection id, so its management request does not go through the BrokerScheduler; it is two
// reads on the interactive lane of one client that is closed afterwards.
import { connectControl } from '@app/adapter-amqp091';
import { createMgmtHttpClient, type MgmtTarget } from '@app/adapter-mgmt-http';
import type { ConnectionId } from '@app/contracts';
import type { Dialer } from '@app/net-dialer';
import type { TrustStore } from '@app/net-truststore';
import type {
  AmqpProbeResult,
  ConnectionProber,
  HttpProbeResult,
  ProbeAmqpEndpoint,
  ProbeHttpEndpoint,
} from '@app/ports';
import { z } from 'zod';

import { amqpFailure, httpFailure } from './failures.ts';
import { DIRECT, UNPROBED } from './mgmt.ts';

const PROBE_ID = 'connection-test' as ConnectionId;
const REQUEST_TIMEOUT_MS = 10_000;

/** What `/api/overview` tells; the fields a test reports. */
const OverviewSchema = z.object({
  rabbitmq_version: z.string().optional(),
  product_name: z.string().optional(),
  cluster_name: z.string().optional(),
  listeners: z
    .array(z.object({ protocol: z.string(), port: z.number() }))
    .default([]),
});
const WhoamiSchema = z.object({
  name: z.string(),
  tags: z.union([z.array(z.string()), z.string()]).default([]),
});

export function createConnectionProber(deps: {
  readonly dialer: Dialer;
  readonly trust: Pick<TrustStore, 'forProfile'>;
  /** The `connection_name` mode part (blueprint 5.3). */
  readonly mode: string;
}): ConnectionProber {
  const { dialer, trust } = deps;
  return {
    async http(endpoint: ProbeHttpEndpoint, signal): Promise<HttpProbeResult> {
      const target: MgmtTarget = {
        host: endpoint.host,
        port: endpoint.port,
        route: DIRECT,
        profile: UNPROBED,
        auth:
          endpoint.auth.kind === 'basic'
            ? {
                kind: 'basic',
                username: endpoint.auth.username,
                password: endpoint.auth.password,
              }
            : endpoint.auth.kind === 'bearer'
              ? { kind: 'bearer', token: endpoint.auth.token }
              : { kind: 'basic', username: '', password: '' },
        ...(endpoint.pathPrefix === undefined
          ? {}
          : { pathPrefix: endpoint.pathPrefix }),
        ...(endpoint.tls ? { tls: trust.forProfile({}) } : {}),
      };
      const client = createMgmtHttpClient({
        dialer,
        targets: { resolve: () => Promise.resolve(target) },
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
      });
      try {
        const get = <T>(path: string, schema: z.ZodType<T>) =>
          client.read.get(
            { connectionId: PROBE_ID, path, schema, lane: 'interactive' },
            signal,
          );
        const overview = await get('/api/overview', OverviewSchema);
        const whoami = await get('/api/whoami', WhoamiSchema);
        return {
          ok: true,
          facts: {
            product: overview.product_name ?? 'RabbitMQ',
            ...(overview.rabbitmq_version === undefined
              ? {}
              : { version: overview.rabbitmq_version }),
            ...(overview.cluster_name === undefined
              ? {}
              : { clusterName: overview.cluster_name }),
            user: whoami.name,
            tags: Array.isArray(whoami.tags)
              ? whoami.tags
              : whoami.tags.split(',').filter((tag) => tag !== ''),
            listeners: overview.listeners,
          },
        };
      } catch (error) {
        return { ok: false, failure: httpFailure(error) };
      } finally {
        client.close();
      }
    },

    async amqp(endpoint: ProbeAmqpEndpoint, signal): Promise<AmqpProbeResult> {
      try {
        const opened = await connectControl({
          dialer,
          route: DIRECT,
          endpoint: {
            host: endpoint.host,
            port: endpoint.port,
            vhost: endpoint.vhost,
            ...(endpoint.tls ? { tls: trust.forProfile({}) } : {}),
          },
          credentials:
            endpoint.auth.kind === 'plain'
              ? {
                  kind: 'plain',
                  username: endpoint.auth.username,
                  password: endpoint.auth.password,
                }
              : { kind: 'plain', username: '', password: '' },
          name: {
            product: 'product',
            mode: deps.mode,
            session: 'connection-test',
          },
          connectTimeoutMs: REQUEST_TIMEOUT_MS,
          signal,
        });
        await opened.lease.release();
        return { ok: true };
      } catch (error) {
        return { ok: false, failure: amqpFailure(error) };
      }
    },
  };
}
