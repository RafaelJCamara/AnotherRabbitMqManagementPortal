// The provider config of a profile, read and written through the CredentialProviderStore port
// (M1-23 slice E3, OQ-1455, ADR-036). The store holds the JSON as it was written and decides nothing
// about it; this file is where `ProviderConfigSchema` is applied, on every read and on every write.
// A caller therefore never holds a config that did not pass the schema, and a damaged, hand-edited or
// out-of-date row reads as one fixed refusal: no thrown parse error, no zod issue (an issue echoes a
// value), no part of the stored text.
//
// The config holds no secret. The password, the token or the client secret stays in the profile's
// sealed `credentials` row (I-10); `StoredLoginPort` opens it.
import type { CredentialProtocol, CredentialProviderStore } from '@app/ports';

import { ProviderConfigSchema, type ProviderConfig } from './provider';

/**
 * Why a stored config could not be used. `unreadable` is a row that is not JSON or is over the size
 * bound; `schema` is JSON that `ProviderConfigSchema` refuses (an unknown kind, an extra key, a
 * relative command path...). Both are fixed words: neither says what the row held.
 */
export type ProviderConfigRefusal = 'unreadable' | 'schema';

export type ProviderConfigRead =
  | {
      readonly kind: 'found';
      readonly config: ProviderConfig;
      readonly updatedAt: number;
    }
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid'; readonly reason: ProviderConfigRefusal };

export type ProviderConfigWrite =
  | { readonly kind: 'saved'; readonly config: ProviderConfig }
  | { readonly kind: 'invalid'; readonly reason: 'schema' };

export interface ProviderConfigStore {
  /** The validated config, `absent`, or the fixed refusal. Rejects only when the database itself fails. */
  get(
    connectionId: string,
    protocol: CredentialProtocol,
  ): Promise<ProviderConfigRead>;
  /**
   * Validates `input` with `ProviderConfigSchema` and stores what the schema returned (defaults
   * filled in). An input the schema refuses is not stored and not repeated.
   */
  put(
    connectionId: string,
    protocol: CredentialProtocol,
    input: unknown,
  ): Promise<ProviderConfigWrite>;
  /** True when a row was removed. */
  delete(connectionId: string, protocol: CredentialProtocol): Promise<boolean>;
}

export function createProviderConfigStore(
  store: CredentialProviderStore,
): ProviderConfigStore {
  return {
    async get(connectionId, protocol) {
      const read = await store.get(connectionId, protocol);
      if (read.kind === 'absent') return { kind: 'absent' };
      if (read.kind === 'unreadable') {
        return { kind: 'invalid', reason: 'unreadable' };
      }
      const parsed = ProviderConfigSchema.safeParse(read.record.config);
      if (!parsed.success) return { kind: 'invalid', reason: 'schema' };
      return {
        kind: 'found',
        config: parsed.data,
        updatedAt: read.record.updatedAt,
      };
    },

    async put(connectionId, protocol, input) {
      const parsed = ProviderConfigSchema.safeParse(input);
      if (!parsed.success) return { kind: 'invalid', reason: 'schema' };
      await store.put(connectionId, protocol, parsed.data);
      return { kind: 'saved', config: parsed.data };
    },

    delete: (connectionId, protocol) => store.delete(connectionId, protocol),
  };
}
