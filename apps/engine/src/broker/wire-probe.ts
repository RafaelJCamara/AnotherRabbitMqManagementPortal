// The two steps of the capability probe that need a socket of their own (fact sheet j.2, steps 1 and
// 12): the TLS handshake of the management endpoint and the AMQP handshake. Both dial through the
// Dialer, so the egress policy and the TrustStore apply (I-9); neither sends a message or declares
// anything. The endpoint and login come from the stored profile of the connection.
import { connectControl } from '@app/adapter-amqp091';
import type { Dialer } from '@app/net-dialer';
import { type TrustStore, toProfileTls } from '@app/net-truststore';
import type {
  AmqpHandshakeResult,
  BrokerWireProbe,
  TlsProbeResult,
} from '@app/ports';

import type { ConnectionEndpoints } from './endpoints.ts';
import { amqpFailure } from './failures.ts';
import { DIRECT } from './mgmt.ts';

const CONNECT_TIMEOUT_MS = 10_000;

export function createWireProbe(deps: {
  readonly endpoints: ConnectionEndpoints;
  readonly dialer: Dialer;
  readonly trust: Pick<TrustStore, 'forProfile'>;
  /** The `connection_name` mode part (blueprint 5.3). */
  readonly mode: string;
}): BrokerWireProbe {
  return {
    async describe(connectionId) {
      const address = await deps.endpoints.address(connectionId);
      return address === undefined
        ? undefined
        : { host: address.host, managementTls: address.tls };
    },

    async tls(connectionId, signal): Promise<TlsProbeResult> {
      const address = await deps.endpoints.address(connectionId);
      if (!address?.tls) return { kind: 'plain' };
      try {
        const dialed = await deps.dialer.dial(
          {
            host: address.host,
            port: address.port,
            purpose: 'mgmt-http',
            tls: deps.trust.forProfile({}),
          },
          DIRECT,
          signal,
        );
        dialed.socket.destroy();
        if (dialed.tls === undefined) {
          return { kind: 'failed', failure: { reason: 'unexpected' } };
        }
        const { verified, insecureOverride, notAfter } = toProfileTls(
          dialed.tls,
        );
        return {
          kind: 'checked',
          verified,
          insecureOverride,
          ...(notAfter === undefined ? {} : { notAfter }),
        };
      } catch (error) {
        return { kind: 'failed', failure: amqpFailure(error) };
      }
    },

    async amqpHandshake(connectionId, signal): Promise<AmqpHandshakeResult> {
      try {
        const endpoint = await deps.endpoints.amqp(connectionId);
        if (endpoint === undefined) {
          return { ok: false, failure: { reason: 'unexpected' } };
        }
        const opened = await connectControl({
          dialer: deps.dialer,
          route: DIRECT,
          endpoint: {
            host: endpoint.host,
            port: endpoint.port,
            vhost: endpoint.vhost,
            ...(endpoint.tls ? { tls: deps.trust.forProfile({}) } : {}),
          },
          credentials:
            endpoint.login.kind === 'plain'
              ? {
                  kind: 'plain',
                  username: endpoint.login.username,
                  password: endpoint.login.password,
                }
              : { kind: 'plain', username: '', password: '' },
          name: {
            product: 'product',
            mode: deps.mode,
            session: 'capability-probe',
          },
          connectTimeoutMs: CONNECT_TIMEOUT_MS,
          signal,
        });
        await opened.lease.release();
        // The adapter reports the server's version; its channel and frame limits are not exposed yet.
        return {
          ok: true,
          ...(opened.info.serverVersion === undefined
            ? {}
            : { version: opened.info.serverVersion }),
        };
      } catch (error) {
        // A credential that cannot be opened (a locked vault) is `unexpected`, not "refused".
        return { ok: false, failure: amqpFailure(error) };
      }
    },
  };
}
