// Where a stored connection points and how it logs in, read for one call. The management target
// resolver, the wire probe and the connection prober all dial a profile; this is the one place that
// reads its row and opens its sealed credentials (I-10): a secret lives in the value this returns and
// the call that asked for it, and is in no log line, no error and no cache.
import { AppError } from '@app/kernel';
import type { ConnectionStore, FieldSealer } from '@app/ports';
import { configOf, openSecret, type StoredConfig } from '@app/svc-connections';

export type HttpLogin =
  | {
      readonly kind: 'basic';
      readonly username: string;
      readonly password: string;
    }
  | { readonly kind: 'bearer'; readonly token: string }
  | { readonly kind: 'none' };

export type AmqpLogin =
  | {
      readonly kind: 'plain';
      readonly username: string;
      readonly password: string;
    }
  | { readonly kind: 'none' };

export interface HttpEndpoint {
  readonly host: string;
  readonly port: number;
  readonly tls: boolean;
  readonly pathPrefix: string | null;
  readonly login: HttpLogin;
}

export interface AmqpEndpoint {
  readonly host: string;
  readonly port: number;
  readonly tls: boolean;
  readonly vhost: string;
  readonly login: AmqpLogin;
}

export interface ConnectionEndpoints {
  /** The management endpoint with its login opened; undefined when the connection does not exist. */
  http(connectionId: string): Promise<HttpEndpoint | undefined>;
  /** The AMQP endpoint with its login opened; undefined when the connection does not exist. */
  amqp(connectionId: string): Promise<AmqpEndpoint | undefined>;
  /** Where the management API is, with no secret opened (the TLS step needs no login). */
  address(
    connectionId: string,
  ): Promise<Pick<HttpEndpoint, 'host' | 'port' | 'tls'> | undefined>;
}

const unreadable = (what: string): AppError =>
  new AppError('GATE_BLOCKED', {
    detail: `The stored ${what} credential cannot be opened: the credential vault is locked, or the credential was stored under another key.`,
  });

export function createConnectionEndpoints(deps: {
  readonly connections: Pick<ConnectionStore, 'get' | 'credentials'>;
  readonly sealer: FieldSealer;
}): ConnectionEndpoints {
  const config = async (
    connectionId: string,
  ): Promise<StoredConfig | undefined> => {
    const record = await deps.connections.get(connectionId);
    return record === undefined ? undefined : configOf(record);
  };
  const secret = async (
    connectionId: string,
    protocol: 'http' | 'amqp',
  ): Promise<string> => {
    const rows = await deps.connections.credentials(connectionId);
    const row = rows.find((entry) => entry.protocol === protocol);
    const opened =
      row === undefined
        ? undefined
        : await openSecret(deps.sealer, connectionId, protocol, row.ciphertext);
    if (opened === undefined) throw unreadable(protocol.toUpperCase());
    return opened;
  };

  return {
    async address(connectionId) {
      const stored = await config(connectionId);
      return stored === undefined
        ? undefined
        : {
            host: stored.http.host,
            port: stored.http.port,
            tls: stored.http.tls,
          };
    },

    async http(connectionId) {
      const stored = await config(connectionId);
      if (stored === undefined) return undefined;
      const { auth } = stored.http;
      let login: HttpLogin;
      if (auth.kind === 'none') login = { kind: 'none' };
      else if (auth.kind === 'bearer') {
        login = { kind: 'bearer', token: await secret(connectionId, 'http') };
      } else {
        login = {
          kind: 'basic',
          username: auth.username ?? '',
          password: await secret(connectionId, 'http'),
        };
      }
      return {
        host: stored.http.host,
        port: stored.http.port,
        tls: stored.http.tls,
        pathPrefix: stored.http.pathPrefix,
        login,
      };
    },

    async amqp(connectionId) {
      const stored = await config(connectionId);
      if (stored === undefined) return undefined;
      const { auth } = stored.amqp;
      const login: AmqpLogin =
        auth.kind === 'none'
          ? { kind: 'none' }
          : {
              kind: 'plain',
              username: auth.username ?? '',
              password: await secret(connectionId, 'amqp'),
            };
      return {
        host: stored.amqp.host,
        port: stored.amqp.port,
        tls: stored.amqp.tls,
        vhost: stored.amqp.vhost,
        login,
      };
    },
  };
}
