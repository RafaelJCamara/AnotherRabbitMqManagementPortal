// The Kysely implementation of the CredentialProviderStore port of @app/ports (M1-23, OQ-1455): the
// non-secret provider settings of a profile in `credential_providers` (0012_credential_providers).
// The document is opaque here; svc-identity validates it with `ProviderConfigSchema` on every read.
// A row that is not JSON, or is larger than the bound, reads as `unreadable`: a fixed answer that
// holds neither the text nor a parse error. The secret is never here (I-10): it stays in the sealed
// `credentials` row.
import {
  CREDENTIAL_PROVIDER_MAX_CONFIG_BYTES,
  type CredentialProviderStore,
} from '@app/ports';
import type { Kysely } from 'kysely';

import type { Database } from '../database';

/** Fixed text: the rejected value is never repeated, whatever it held. */
const NOT_STORABLE =
  'The provider config is not a JSON value within the size bound.';

/** The JSON text of `config`, or undefined when it is not a JSON value or is over the bound. */
function serialise(config: unknown): string | undefined {
  // JSON.stringify gives undefined for undefined, a function and a symbol, though its type says string.
  let text: unknown;
  try {
    text = JSON.stringify(config);
  } catch {
    return undefined;
  }
  if (typeof text !== 'string') return undefined;
  return Buffer.byteLength(text, 'utf8') > CREDENTIAL_PROVIDER_MAX_CONFIG_BYTES
    ? undefined
    : text;
}

export function createCredentialProviderStore(
  db: Kysely<Database>,
  now: () => number,
): CredentialProviderStore {
  return {
    async get(connectionId, protocol) {
      const row = await db
        .selectFrom('credential_providers')
        .selectAll()
        .where('connection_id', '=', connectionId)
        .where('protocol', '=', protocol)
        .executeTakeFirst();
      if (row === undefined) return { kind: 'absent' };
      if (
        Buffer.byteLength(row.config, 'utf8') >
        CREDENTIAL_PROVIDER_MAX_CONFIG_BYTES
      ) {
        return { kind: 'unreadable' };
      }
      let config: unknown;
      try {
        config = JSON.parse(row.config);
      } catch {
        return { kind: 'unreadable' };
      }
      return {
        kind: 'found',
        record: {
          connectionId: row.connection_id,
          protocol: row.protocol,
          config,
          updatedAt: row.updated_at,
        },
      };
    },

    async put(connectionId, protocol, config) {
      const text = serialise(config);
      if (text === undefined) throw new TypeError(NOT_STORABLE);
      const updatedAt = now();
      await db
        .insertInto('credential_providers')
        .values({
          connection_id: connectionId,
          protocol,
          config: text,
          updated_at: updatedAt,
        })
        .onConflict((conflict) =>
          conflict
            .columns(['connection_id', 'protocol'])
            .doUpdateSet({ config: text, updated_at: updatedAt }),
        )
        .execute();
    },

    async delete(connectionId, protocol) {
      const result = await db
        .deleteFrom('credential_providers')
        .where('connection_id', '=', connectionId)
        .where('protocol', '=', protocol)
        .executeTakeFirst();
      return result.numDeletedRows > 0n;
    },
  };
}
