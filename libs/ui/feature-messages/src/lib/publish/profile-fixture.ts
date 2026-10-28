// A connection profile as the engine reads it back, for the specs. Never part of the library build.
import type { ConnectionProfile } from '@app/contracts';

export function profileFixture(
  id: string,
  options: {
    readonly name?: string;
    readonly envClass?: ConnectionProfile['envClass'];
  } = {},
): ConnectionProfile {
  const secret = { isSet: true, updatedAt: 1_760_000_000_000 };
  return {
    id: id as ConnectionProfile['id'],
    name: options.name ?? `Broker ${id}`,
    envClass: options.envClass ?? 'dev',
    color: null,
    visibility: 'private',
    canEdit: true,
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
