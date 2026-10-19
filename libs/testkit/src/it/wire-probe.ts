// A BrokerWireProbe over the real adapters, for the integration test of svc-capabilities (M0-45):
// the TLS handshake through the Dialer and the TrustStore, and the AMQP handshake through the
// control connection of the AMQP adapter. Neither sends a message or declares anything.
//
// It lives in the testkit because a service may not import an adapter and the composition root does
// not wire svc-capabilities yet (OQ-441 for svc-connections, OQ-472 here): when it does, this is
// the code to move there, with the endpoint and credentials read from the connection profile.
import { Amqp091Error, connectControl } from '@app/adapter-amqp091';
import { createDialer } from '@app/net-dialer';
import {
  NetworkError,
  createTrustStore,
  toProfileTls,
} from '@app/net-truststore';
import type {
  AmqpHandshakeResult,
  BrokerWireProbe,
  ProbeFailure,
  TlsProbeResult,
} from '@app/ports';

const DIRECT = { kind: 'direct' } as const;

export interface WireProbeOptions {
  readonly host: string;
  /** Present when the management endpoint is HTTPS. */
  readonly managementTls?: { readonly port: number };
  readonly amqp: {
    readonly port: number;
    readonly vhost: string;
    readonly username: string;
    readonly password: string;
    readonly tls?: boolean;
  };
  /** PEM CAs added to the trust of the profile, and the name to verify when connecting by IP. */
  readonly ca?: readonly string[];
  readonly servername?: string;
}

function failureOf(error: unknown): ProbeFailure {
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
  }
  return { reason: 'unexpected' };
}

export function createRealWireProbe(
  options: WireProbeOptions,
): BrokerWireProbe {
  const dialer = createDialer();
  const trust = () =>
    createTrustStore().forProfile({
      ...(options.ca === undefined ? {} : { ca: [...options.ca] }),
      ...(options.servername === undefined
        ? {}
        : { servername: options.servername }),
    });

  return {
    describe: () =>
      Promise.resolve({
        host: options.host,
        managementTls: options.managementTls !== undefined,
      }),

    async tls(_connectionId, signal): Promise<TlsProbeResult> {
      if (options.managementTls === undefined) return { kind: 'plain' };
      try {
        const dialed = await dialer.dial(
          {
            host: options.host,
            port: options.managementTls.port,
            purpose: 'mgmt-http',
            tls: trust(),
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
        return { kind: 'failed', failure: failureOf(error) };
      }
    },

    async amqpHandshake(_connectionId, signal): Promise<AmqpHandshakeResult> {
      try {
        const opened = await connectControl({
          dialer,
          route: DIRECT,
          endpoint: {
            host: options.host,
            port: options.amqp.port,
            vhost: options.amqp.vhost,
            ...(options.amqp.tls === true ? { tls: trust() } : {}),
          },
          credentials: {
            kind: 'plain',
            username: options.amqp.username,
            password: options.amqp.password,
          },
          name: { product: 'product', mode: 'it', session: 'capability-probe' },
          connectTimeoutMs: 10_000,
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
        return { ok: false, failure: failureOf(error) };
      }
    },
  };
}
