// A `connect` function for undici's `Agent`/`Pool`/`Client` (`new Agent({ connect })`), so HTTP
// clients open their sockets through the Dialer and the TrustStore (I-9) instead of undici's own
// `net`/`tls` calls. It follows undici's `buildConnector` contract (nodejs/undici
// lib/core/connect.js): `(options, callback(error, socket)) => void`, the callback called exactly
// once. The types are declared here, so this project does not depend on the undici package; the
// management HTTP adapter (M0-24) hands the function to its own undici.
//
// HTTP/1.1 only: no ALPN is offered, so a server cannot switch the connection to HTTP/2.
import type { Socket } from 'node:net';

import { NetworkError, type TlsTrust } from '@app/net-truststore';

import type { Dialer } from './dialer.ts';

/** The members of undici's connector options that matter here. */
export interface ConnectorOptions {
  readonly hostname: string;
  /** `host[:port]`, used by undici for the Host header. Not used for dialling. */
  readonly host?: string | undefined;
  /** `http:` or `https:`. */
  readonly protocol: string;
  readonly port: string | number;
  /** undici's guess of the name to verify; the profile's own override wins. */
  readonly servername?: string | undefined;
  readonly localAddress?: string | null | undefined;
  readonly httpSocketPath?: string | null | undefined;
}

export type ConnectorCallback = (
  error: Error | null,
  socket: Socket | null,
) => void;
export type UndiciConnector = (
  options: ConnectorOptions,
  callback: ConnectorCallback,
) => void;

export interface UndiciConnectorOptions {
  readonly dialer: Pick<Dialer, 'dial'>;
  /** Passed to the egress policy, for example `mgmt-http`. */
  readonly purpose: string;
  /** Trust for `https:` origins. Plain `http:` origins ignore it. */
  readonly tls: TlsTrust;
  readonly signal?: AbortSignal;
}

function portOf(options: ConnectorOptions): number {
  const port = Number(options.port);
  if (Number.isInteger(port) && port > 0) return port;
  return options.protocol === 'https:' ? 443 : 80;
}

export function createUndiciConnector(
  options: UndiciConnectorOptions,
): UndiciConnector {
  return (connectorOptions, callback) => {
    if (
      connectorOptions.httpSocketPath !== undefined &&
      connectorOptions.httpSocketPath !== null &&
      connectorOptions.httpSocketPath !== ''
    ) {
      // A path would bypass host policy and TLS naming; the Dialer dials hosts only.
      callback(
        new NetworkError(
          'VALIDATION_FAILED',
          'connections to a Unix socket path are not made through the Dialer',
        ),
        null,
      );
      return;
    }
    const protocol = connectorOptions.protocol;
    if (protocol !== 'https:' && protocol !== 'http:') {
      // Never guess: an unknown scheme must not quietly become a plaintext connection.
      callback(
        new NetworkError(
          'VALIDATION_FAILED',
          'only http: and https: origins are dialled',
        ),
        null,
      );
      return;
    }
    dialerConnect(options, connectorOptions, protocol === 'https:').then(
      (socket) => {
        try {
          callback(null, socket);
        } catch {
          // A throwing callback must not leak the socket or crash the process.
          socket.destroy();
        }
      },
      (error: unknown) => {
        try {
          callback(
            error instanceof Error ? error : new Error(String(error)),
            null,
          );
        } catch {
          // Nothing left to clean up.
        }
      },
    );
  };
}

async function dialerConnect(
  options: UndiciConnectorOptions,
  connectorOptions: ConnectorOptions,
  secure: boolean,
): Promise<Socket> {
  const { socket } = await options.dialer.dial(
    {
      host: connectorOptions.hostname,
      port: portOf(connectorOptions),
      purpose: options.purpose,
      ...(connectorOptions.servername === undefined ||
      connectorOptions.servername === ''
        ? {}
        : { servername: connectorOptions.servername }),
      ...(secure ? { tls: options.tls } : {}),
    },
    { kind: 'direct' },
    options.signal,
  );
  return socket;
}
