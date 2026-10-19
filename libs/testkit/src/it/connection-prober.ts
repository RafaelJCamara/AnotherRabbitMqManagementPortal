// A ConnectionProber over the real adapters, for the integration test of svc-connections (M0-44).
// It is the wiring the composition root needs: the management HTTP client and the AMQP control
// connection, both opened through the Dialer (I-9) with the credentials of one call, none kept.
//
// It lives in the testkit because a service may not import an adapter and the composition root does
// not wire svc-connections yet (OQ-441): when it does, this is the code to move there.
import { Amqp091Error, connectControl } from '@app/adapter-amqp091';
import {
  MgmtHttpError,
  createMgmtHttpClient,
  type MgmtTarget,
} from '@app/adapter-mgmt-http';
import type { ConnectionId } from '@app/contracts';
import { createDialer } from '@app/net-dialer';
import { NetworkError, createTrustStore } from '@app/net-truststore';
import type {
  AmqpProbeResult,
  ConnectionProber,
  HttpProbeResult,
  ProbeAmqpEndpoint,
  ProbeFailure,
  ProbeHttpEndpoint,
} from '@app/ports';
import { z } from 'zod';

const PROBE_ID = 'connection-test' as ConnectionId;
const DIRECT = { kind: 'direct' } as const;

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

/** Nothing is known of a draft's broker yet: the adapter's rules read this conservatively. */
const UNPROBED = {
  product: 'unknown',
  stats: { disabled: false, queueTotals: false },
  versions: {
    min: null,
    perNode: {},
    mixed: false,
    build: 'commercial-or-unknown',
  },
} as const;

function httpFailure(error: unknown): ProbeFailure {
  if (error instanceof NetworkError || error instanceof MgmtHttpError) {
    if (error.code === 'EGRESS_DENIED') return { reason: 'egress-denied' };
    if (error.code === 'TLS_UNTRUSTED') return { reason: 'tls-untrusted' };
  }
  if (error instanceof MgmtHttpError) {
    switch (error.reason) {
      case 'auth-refused':
      case 'token-expired':
        return { reason: 'auth-refused' };
      case 'missing-tag':
        return { reason: 'missing-tag' };
      case 'connect-failed':
        return { reason: 'unreachable' };
      case 'timeout':
        return { reason: 'timeout' };
      // The socket connected and then the HTTP exchange broke (an AMQP port answering with its own
      // protocol header, a reset): something is there, and it is not a management API.
      case 'network':
      case 'unexpected-body':
      case 'not-found':
      case 'unexpected-status':
      case 'redirect-refused':
        return { reason: 'not-management' };
      default:
        return { reason: 'unexpected' };
    }
  }
  return { reason: 'unexpected' };
}

function amqpFailure(error: unknown): ProbeFailure {
  if (error instanceof NetworkError) {
    if (error.code === 'EGRESS_DENIED') return { reason: 'egress-denied' };
    if (error.code === 'TLS_UNTRUSTED') return { reason: 'tls-untrusted' };
    return { reason: 'unreachable' };
  }
  if (error instanceof Amqp091Error) {
    if (error.reason === 'auth-refused') return { reason: 'auth-refused' };
    if (error.reason === 'tls-untrusted') return { reason: 'tls-untrusted' };
    if (error.reason === 'timeout') return { reason: 'timeout' };
    if (error.reason === 'connect-failed') return { reason: 'unreachable' };
    // RabbitMQ answers connection.open with a close (530, not-allowed) for a vhost the user may not
    // use or that does not exist, after the login was accepted. amqplib reports it only as `Expected
    // ConnectionOpenOk; got <ConnectionClose>` in the cause (a recommendation in OQ-441: have the
    // adapter map it), so it is read from there, and the cause's text is never passed on.
    const cause = error.cause instanceof Error ? error.cause.message : '';
    if (
      error.broker?.code === 530 ||
      cause.includes('ConnectionOpenOk; got <ConnectionClose')
    ) {
      return { reason: 'vhost-refused' };
    }
  }
  return { reason: 'unexpected' };
}

export interface RealProberOptions {
  /** PEM CAs added to the trust of a TLS endpoint (the lab broker is its own CA). */
  readonly ca?: readonly string[];
  /** The name to verify when connecting by IP. */
  readonly servername?: string;
}

export function createRealProber(
  options: RealProberOptions = {},
): ConnectionProber {
  const dialer = createDialer();
  const trust = () =>
    createTrustStore().forProfile({
      ...(options.ca === undefined ? {} : { ca: [...options.ca] }),
      ...(options.servername === undefined
        ? {}
        : { servername: options.servername }),
    });

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
        ...(endpoint.tls ? { tls: trust() } : {}),
      };
      const client = createMgmtHttpClient({
        dialer,
        targets: { resolve: () => Promise.resolve(target) },
        requestTimeoutMs: 10_000,
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
            ...(overview.product_name === undefined
              ? { product: 'RabbitMQ' }
              : { product: overview.product_name }),
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
            ...(endpoint.tls ? { tls: trust() } : {}),
          },
          credentials:
            endpoint.auth.kind === 'plain'
              ? {
                  kind: 'plain',
                  username: endpoint.auth.username,
                  password: endpoint.auth.password,
                }
              : { kind: 'plain', username: '', password: '' },
          name: { product: 'product', mode: 'it', session: 'connection-test' },
          connectTimeoutMs: 10_000,
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
