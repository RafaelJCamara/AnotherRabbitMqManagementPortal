// Data for the specs: a connection profile as the engine reads it back, and a BrokerProfile as plain JSON.
// Never part of the library build.
import type { ConnectionProfile } from '@app/contracts';

export function profileFixture(
  id: string,
  options: {
    readonly name?: string;
    readonly envClass?: ConnectionProfile['envClass'];
    readonly secretsSet?: boolean;
    readonly canEdit?: boolean;
  } = {},
): ConnectionProfile {
  const secret =
    options.secretsSet === false
      ? { isSet: false, updatedAt: null }
      : { isSet: true, updatedAt: 1_760_000_000_000 };
  return {
    id: id as ConnectionProfile['id'],
    name: options.name ?? `Broker ${id}`,
    envClass: options.envClass ?? 'dev',
    color: null,
    visibility: 'private',
    canEdit: options.canEdit ?? true,
    http: {
      url: 'http://127.0.0.1:15672',
      host: '127.0.0.1',
      port: 15672,
      tls: false,
      pathPrefix: null,
      auth: { kind: 'basic', username: 'guest', secret },
    },
    amqp: {
      host: '127.0.0.1',
      port: 5672,
      tls: false,
      vhost: '/',
      auth: { kind: 'plain', username: 'guest', secret },
    },
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_000_000,
  };
}

/** A string no engine text and no label contains, planted as a secret to prove where it never goes. */
export const CANARY = 'canary-7f3a9e1c-do-not-leak';
