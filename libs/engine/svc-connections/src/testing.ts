// Fakes for the ports of this module, shared by its specs, by the architecture manifest
// (tools/arch-tests) and by the HTTP specs (libs/testkit). Give each port in deps.ts a fake here.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type {
  AmqpProbeResult,
  ConnectionInput,
  ConnectionProber,
  ConnectionRecord,
  ConnectionStore,
  CredentialProtocol,
  CredentialRecord,
  FieldSealer,
  HttpProbeResult,
  ProbeAmqpEndpoint,
  ProbeHttpEndpoint,
} from '@app/ports';

import type { ConnectionsModuleDeps } from './deps';

/** A store in memory with the semantics of the real one: visibility, windows by id, one transaction. */
export function createMemoryConnectionStore(
  options: { now?: () => number; profiles?: readonly ConnectionRecord[] } = {},
): ConnectionStore {
  const now = options.now ?? Date.now;
  const profiles = new Map<string, ConnectionRecord>(
    (options.profiles ?? []).map((profile) => [profile.id, profile]),
  );
  const credentials = new Map<
    string,
    Map<CredentialProtocol, CredentialRecord>
  >();
  const visibleTo = (id: string) =>
    [...profiles.values()]
      .filter((p) => p.visibility === 'team' || p.ownerId === id)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    get: (id) => Promise.resolve(profiles.get(id)),
    save: (input: ConnectionInput, change) => {
      const at = now();
      const previous = profiles.get(input.id);
      const record: ConnectionRecord = {
        ...input,
        createdAt: previous?.createdAt ?? at,
        updatedAt: at,
      };
      profiles.set(input.id, record);
      const rows =
        credentials.get(input.id) ??
        new Map<CredentialProtocol, CredentialRecord>();
      for (const protocol of change?.remove ?? []) rows.delete(protocol);
      for (const protocol of ['http', 'amqp'] as const) {
        const ciphertext = change?.put?.[protocol];
        if (ciphertext !== undefined) {
          // Copied: the store never keeps the caller's buffer.
          rows.set(protocol, {
            protocol,
            ciphertext: Uint8Array.from(ciphertext),
            updatedAt: at,
          });
        }
      }
      credentials.set(input.id, rows);
      return Promise.resolve(record);
    },
    delete: (id) => {
      credentials.delete(id);
      return Promise.resolve(profiles.delete(id));
    },
    list: (query) => {
      const matching = visibleTo(query.visibleTo).filter(
        (p) => query.cursor === undefined || p.id > query.cursor,
      );
      const items = matching.slice(0, query.limit);
      const last = items.at(-1);
      return Promise.resolve(
        matching.length > query.limit && last !== undefined
          ? { items, nextCursor: last.id }
          : { items },
      );
    },
    count: (id) => Promise.resolve(visibleTo(id).length),
    credentials: (id) =>
      Promise.resolve(
        [...(credentials.get(id)?.values() ?? [])].sort((a, b) =>
          a.protocol < b.protocol ? -1 : 1,
        ),
      ),
  };
}

/**
 * A sealer with the properties of `@app/secrets`' field cipher: AES-256-GCM, the place a value
 * lives in is authenticated, so a ciphertext moved to another row does not open. The key is random
 * and lives for this object only. `lock()` makes it refuse, like a locked vault.
 */
export function createFakeSealer(): FieldSealer & {
  lock(): void;
  unlock(): void;
} {
  const key = randomBytes(32);
  let locked = false;
  const aad = (table: string, column: string, rowId: string) =>
    Buffer.from(`${table}:${column}:${rowId}`, 'utf8');
  return {
    lock: () => {
      locked = true;
    },
    unlock: () => {
      locked = false;
    },
    seal: (table, column, rowId, plaintext) => {
      if (locked) return Promise.reject(new Error('locked'));
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(aad(table, column, rowId));
      const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Promise.resolve(
        new Uint8Array(Buffer.concat([iv, cipher.getAuthTag(), body])),
      );
    },
    open: (table, column, rowId, sealed) => {
      if (locked) return Promise.reject(new Error('locked'));
      try {
        const bytes = Buffer.from(sealed);
        const decipher = createDecipheriv(
          'aes-256-gcm',
          key,
          bytes.subarray(0, 12),
        );
        decipher.setAAD(aad(table, column, rowId));
        decipher.setAuthTag(bytes.subarray(12, 28));
        return Promise.resolve(
          new Uint8Array(
            Buffer.concat([
              decipher.update(bytes.subarray(28)),
              decipher.final(),
            ]),
          ),
        );
      } catch {
        return Promise.reject(new Error('DECRYPT_FAILED'));
      }
    },
  };
}

/** A prober whose answers a spec scripts, and which records what it was asked (and with which login). */
export interface FakeProber extends ConnectionProber {
  readonly httpCalls: ProbeHttpEndpoint[];
  readonly amqpCalls: ProbeAmqpEndpoint[];
  /** What the next HTTP and AMQP probes answer, until changed. */
  httpResult: HttpProbeResult;
  amqpResult: AmqpProbeResult;
}

export function createFakeProber(): FakeProber {
  const prober: FakeProber = {
    httpCalls: [],
    amqpCalls: [],
    httpResult: {
      ok: true,
      facts: {
        product: 'RabbitMQ',
        version: '4.3.6',
        clusterName: 'rabbit@fake',
        user: 'fake',
        tags: ['administrator'],
        listeners: [
          { protocol: 'amqp', port: 5672 },
          { protocol: 'amqp/ssl', port: 5671 },
          { protocol: 'http', port: 15672 },
        ],
      },
    },
    amqpResult: { ok: true },
    http: (endpoint) => {
      prober.httpCalls.push(endpoint);
      return Promise.resolve(prober.httpResult);
    },
    amqp: (endpoint) => {
      prober.amqpCalls.push(endpoint);
      return Promise.resolve(prober.amqpResult);
    },
  };
  return prober;
}

export interface ConnectionsFakeDeps extends ConnectionsModuleDeps {
  readonly store: ConnectionStore;
  readonly sealer: ReturnType<typeof createFakeSealer>;
  readonly prober: FakeProber;
}

/** The profile every fake store starts with: owned by the test principal, with no credentials. */
export const FAKE_PROFILE_ID = 'c1';

export function createConnectionsFakeDeps(
  options: {
    now?: () => number;
    /** Start with no profile at all. */
    empty?: boolean;
    /** Who owns the starting profile: the test principal, `user-1`, by default. */
    ownerId?: string;
  } = {},
): ConnectionsFakeDeps {
  let next = 1;
  const profiles: ConnectionRecord[] = options.empty
    ? []
    : [
        {
          id: FAKE_PROFILE_ID,
          name: 'Fake broker',
          envClass: 'dev',
          color: null,
          config: {
            v: 1,
            http: {
              host: 'mq.example',
              port: 15672,
              tls: false,
              pathPrefix: null,
              auth: { kind: 'none', username: null },
            },
            amqp: {
              host: 'mq.example',
              port: 5672,
              tls: false,
              vhost: '/',
              auth: { kind: 'none', username: null },
            },
          },
          ownerId: options.ownerId ?? 'user-1',
          visibility: 'private',
          createdAt: 1_000,
          updatedAt: 1_000,
        },
      ];
  return {
    store: createMemoryConnectionStore({
      ...(options.now === undefined ? {} : { now: options.now }),
      profiles,
    }),
    sealer: createFakeSealer(),
    prober: createFakeProber(),
    newId: () => `conn-${String((next += 1)).padStart(4, '0')}`,
  };
}
