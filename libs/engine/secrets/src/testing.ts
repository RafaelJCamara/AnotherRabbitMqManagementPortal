// In-memory stand-ins for tests: a DataKeyRepository that behaves like the SQL one (one active key
// per purpose, no unwrapped key anywhere) and a fake OS keyring. Nothing here is for production.
import type { DataKeyRecord, DataKeyRepository } from '@app/ports';

import type { KeyringBackend, KeyringBackendKind } from './wraps/keyring.ts';

export interface MemoryDataKeyRepository extends DataKeyRepository {
  /** Every stored row, for assertions (a test may look for key bytes in it). */
  dump(): readonly DataKeyRecord[];
}

export function createMemoryDataKeyRepository(): MemoryDataKeyRepository {
  const rows = new Map<string, DataKeyRecord>();
  return {
    insert(record) {
      if (rows.has(record.id)) return Promise.resolve(false);
      if (
        record.state === 'active' &&
        [...rows.values()].some(
          (row) => row.purpose === record.purpose && row.state === 'active',
        )
      ) {
        return Promise.resolve(false);
      }
      rows.set(record.id, {
        ...record,
        wrapped: new Uint8Array(record.wrapped),
      });
      return Promise.resolve(true);
    },
    get(id) {
      return Promise.resolve(rows.get(id));
    },
    list(purpose) {
      return Promise.resolve(
        [...rows.values()]
          .filter((row) => row.purpose === purpose)
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, 100),
      );
    },
    retire(id, now) {
      const row = rows.get(id);
      if (row?.state !== 'active') return Promise.resolve(false);
      rows.set(id, { ...row, state: 'retired', retiredAt: now });
      return Promise.resolve(true);
    },
    dump: () => [...rows.values()],
  };
}

export interface MemoryKeyring extends KeyringBackend {
  /** Every secret stored, for assertions. */
  dump(): readonly Uint8Array[];
}

/** A keyring that keeps copies in a map. `kind` lets a test play a Linux box with no secret store. */
export function createMemoryKeyring(
  kind: KeyringBackendKind = 'secret-service',
): MemoryKeyring {
  const secrets = new Map<string, Uint8Array>();
  return {
    kind,
    get(service, account) {
      const stored = secrets.get(`${service}\u0000${account}`);
      return Promise.resolve(
        stored === undefined ? null : new Uint8Array(stored),
      );
    },
    set(service, account, secret) {
      secrets.set(`${service}\u0000${account}`, new Uint8Array(secret));
      return Promise.resolve();
    },
    dump: () => [...secrets.values()],
  };
}
