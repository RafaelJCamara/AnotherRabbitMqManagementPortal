// Fakes for the ports of this module, shared by its specs, by the architecture manifest
// (tools/arch-tests) and by the HTTP specs (libs/testkit). Give each port in deps.ts a fake here.
import {
  CREDENTIAL_PROVIDER_MAX_CONFIG_BYTES,
  type CredentialProtocol,
  type CredentialProviderStore,
} from '@app/ports';

import type { IdentityModuleDeps } from './deps';

export function createIdentityFakeDeps(): IdentityModuleDeps {
  return {};
}

/** The fixed text of a refused write: the value is never repeated, as in the real store. */
const NOT_STORABLE =
  'The provider config is not a JSON value within the size bound.';

/** The most rows the fake holds (I-6: a fake is bounded too). */
const FAKE_MAX_ROWS = 4096;

export interface InMemoryCredentialProviderStore extends CredentialProviderStore {
  /**
   * Puts raw text into a row, as a damaged or hand-edited database would hold it. Specs use it to
   * reach the `unreadable` answer; the real store has no such method.
   */
  plantRaw(
    connectionId: string,
    protocol: CredentialProtocol,
    text: string,
  ): void;
  /** The connection's rows go with it, as `ConnectionStore.delete` does in the real store. */
  deleteConnection(connectionId: string): void;
}

/**
 * A `CredentialProviderStore` over a map, with the same contract as the SQLite and Postgres
 * repositories of `persistence`: the config is held as JSON text (so a caller's object is never
 * aliased), a write that is not JSON or is over the bound is refused with the fixed text, and a row
 * that is not JSON reads as `unreadable`. `now` stamps `updatedAt`.
 */
export function createInMemoryCredentialProviderStore(
  now: () => number = () => 0,
): InMemoryCredentialProviderStore {
  const rows = new Map<string, { text: string; updatedAt: number }>();
  const keyOf = (connectionId: string, protocol: CredentialProtocol) =>
    JSON.stringify([connectionId, protocol]);

  const serialise = (config: unknown): string => {
    // JSON.stringify gives undefined for undefined, a function and a symbol, though its type says string.
    let text: unknown;
    try {
      text = JSON.stringify(config);
    } catch {
      throw new TypeError(NOT_STORABLE);
    }
    if (
      typeof text !== 'string' ||
      Buffer.byteLength(text, 'utf8') > CREDENTIAL_PROVIDER_MAX_CONFIG_BYTES
    ) {
      throw new TypeError(NOT_STORABLE);
    }
    return text;
  };

  const set = (key: string, text: string, updatedAt: number): void => {
    if (!rows.has(key) && rows.size >= FAKE_MAX_ROWS) {
      throw new RangeError('The in-memory provider store is full.');
    }
    rows.set(key, { text, updatedAt });
  };

  return {
    get(connectionId, protocol) {
      const row = rows.get(keyOf(connectionId, protocol));
      if (row === undefined) return Promise.resolve({ kind: 'absent' });
      if (
        Buffer.byteLength(row.text, 'utf8') >
        CREDENTIAL_PROVIDER_MAX_CONFIG_BYTES
      ) {
        return Promise.resolve({ kind: 'unreadable' });
      }
      let config: unknown;
      try {
        config = JSON.parse(row.text);
      } catch {
        return Promise.resolve({ kind: 'unreadable' });
      }
      return Promise.resolve({
        kind: 'found',
        record: { connectionId, protocol, config, updatedAt: row.updatedAt },
      });
    },

    put(connectionId, protocol, config) {
      // A throw inside the executor rejects the promise, as the real store's put does.
      return new Promise<void>((resolve) => {
        set(keyOf(connectionId, protocol), serialise(config), now());
        resolve();
      });
    },

    delete(connectionId, protocol) {
      return Promise.resolve(rows.delete(keyOf(connectionId, protocol)));
    },

    plantRaw(connectionId, protocol, text) {
      set(keyOf(connectionId, protocol), text, 1);
    },

    deleteConnection(connectionId) {
      for (const protocol of ['http', 'amqp'] as const) {
        rows.delete(keyOf(connectionId, protocol));
      }
    },
  };
}
