// The contract every CredentialProviderStore must meet (M1-23 slice E3, OQ-1455): the in-memory
// store of `@app/svc-identity` and the Kysely store of `@app/persistence` (SQLite and Postgres) run
// this one suite, so what a spec shows over the first says something true about the second. It
// lives here, behind `@app/ports/testing`, because neither of those projects may import the other.
// What only a database can show (the CHECK, the cascade with the connection) stays in `persistence`.
import { describe, expect, it, afterAll, beforeAll, beforeEach } from 'vitest';

import {
  CREDENTIAL_PROVIDER_MAX_CONFIG_BYTES,
  type CredentialProviderStore,
} from '../identity.ts';

/** What the contract needs of an implementation under test. */
export interface CredentialProviderStoreHarness {
  /** The store, empty after `reset`. A getter is fine: the contract reads it again in every test. */
  readonly store: CredentialProviderStore;
  /**
   * Sets the time that the next writes are stamped with. For a store without an injected clock the
   * harness may ignore it and return false; the time checks are then skipped.
   */
  setClock(ms: number): boolean;
  /**
   * Puts raw text into a row, as a damaged or hand-edited database would hold it. Not a method of
   * the port: a store has no way to write text that is not JSON, and a test must.
   */
  plantRaw(
    connectionId: string,
    protocol: 'http' | 'amqp',
    text: string,
  ): Promise<void>;
  /** Removes every row. */
  reset(): Promise<void>;
  /** Releases what `open` acquired. */
  close(): Promise<void>;
}

export interface CredentialProviderStoreContractOptions {
  /** A prefix for the test names, for example `sqlite (in memory)`. */
  name: string;
  open(): Promise<CredentialProviderStoreHarness>;
}

/** The fixed text of a refused write: the value is never repeated. */
export const CREDENTIAL_PROVIDER_NOT_STORABLE =
  'The provider config is not a JSON value within the size bound.';

const T0 = 5_000;

/** A config as svc-identity would store it: no secret in it, by the shape of its schema. */
const CLIENT_CREDENTIALS = {
  kind: 'client-credentials',
  endpoint: 'https://idp.example/oauth/token',
  clientId: 'engine',
  scope: 'rabbitmq.read:*/*',
  usernameClaims: ['sub'],
};
const TOKEN_COMMAND = {
  kind: 'token-command',
  file: '/usr/local/bin/mint-token',
  args: ['--audience', 'rabbitmq'],
  timeoutMs: 10_000,
  maxStdoutBytes: 16_384,
  usernameClaims: ['sub'],
};

export function credentialProviderStoreContract(
  options: CredentialProviderStoreContractOptions,
): void {
  describe(`M1-23 slice E the credential provider store contract (${options.name})`, () => {
    let harness: CredentialProviderStoreHarness;

    beforeAll(async () => {
      harness = await options.open();
    });

    afterAll(async () => {
      await harness.close();
    });

    beforeEach(async () => {
      await harness.reset();
      harness.setClock(T0);
    });

    const store = (): CredentialProviderStore => harness.store;

    it('stores a config per connection and protocol and reads the JSON back unchanged', async () => {
      await store().put('c1', 'amqp', CLIENT_CREDENTIALS);
      await store().put('c1', 'http', TOKEN_COMMAND);

      const amqp = await store().get('c1', 'amqp');
      expect(amqp).toMatchObject({
        kind: 'found',
        record: {
          connectionId: 'c1',
          protocol: 'amqp',
          config: CLIENT_CREDENTIALS,
        },
      });
      expect(await store().get('c1', 'http')).toMatchObject({
        kind: 'found',
        record: { protocol: 'http', config: TOKEN_COMMAND },
      });
    });

    it('hands out a copy: changing a value that was put, or one that was read, changes nothing stored', async () => {
      const config = { kind: 'password', nested: { list: [1, 2] } };
      await store().put('c1', 'amqp', config);
      config.nested.list.push(3);

      const read = await store().get('c1', 'amqp');
      if (read.kind !== 'found') throw new Error('setup');
      (read.record.config as typeof config).nested.list.push(4);

      expect(await store().get('c1', 'amqp')).toMatchObject({
        record: { config: { kind: 'password', nested: { list: [1, 2] } } },
      });
    });

    it('keys a row by connection and protocol: another connection or protocol reads as absent', async () => {
      await store().put('c1', 'amqp', CLIENT_CREDENTIALS);

      expect(await store().get('c2', 'amqp')).toEqual({ kind: 'absent' });
      expect(await store().get('c1', 'http')).toEqual({ kind: 'absent' });
    });

    it('stamps the time of the write and replaces the config of the same key', async () => {
      const timed = harness.setClock(T0);
      await store().put('c1', 'amqp', CLIENT_CREDENTIALS);
      harness.setClock(T0 + 777);
      await store().put('c1', 'amqp', TOKEN_COMMAND);

      const read = await store().get('c1', 'amqp');
      expect(read).toMatchObject({
        kind: 'found',
        record: { config: TOKEN_COMMAND },
      });
      if (timed && read.kind === 'found') {
        expect(read.record.updatedAt).toBe(T0 + 777);
      }
    });

    it('deletes only the named key and says whether there was a row', async () => {
      await store().put('c1', 'amqp', CLIENT_CREDENTIALS);
      await store().put('c1', 'http', TOKEN_COMMAND);
      await store().put('c2', 'amqp', CLIENT_CREDENTIALS);

      expect(await store().delete('c1', 'amqp')).toBe(true);
      expect(await store().delete('c1', 'amqp')).toBe(false);

      expect((await store().get('c1', 'amqp')).kind).toBe('absent');
      expect((await store().get('c1', 'http')).kind).toBe('found');
      expect((await store().get('c2', 'amqp')).kind).toBe('found');
    });

    it('reads a row that is not JSON as unreadable, without throwing and without the text', async () => {
      await harness.plantRaw(
        'c1',
        'amqp',
        '{"kind": "token-command", "file": ',
      );
      await harness.plantRaw('c1', 'http', 'not json at all');

      for (const protocol of ['amqp', 'http'] as const) {
        const read = await store().get('c1', protocol);
        expect(read).toEqual({ kind: 'unreadable' });
        expect(JSON.stringify(read)).not.toContain('token-command');
        expect(JSON.stringify(read)).not.toContain('not json');
      }
    });

    it('reads a row over the size bound as unreadable, and refuses to write one', async () => {
      await harness.plantRaw(
        'c1',
        'amqp',
        JSON.stringify({
          pad: 'x'.repeat(CREDENTIAL_PROVIDER_MAX_CONFIG_BYTES),
        }),
      );

      expect(await store().get('c1', 'amqp')).toEqual({ kind: 'unreadable' });
      await expect(
        store().put('c2', 'amqp', {
          pad: 'x'.repeat(CREDENTIAL_PROVIDER_MAX_CONFIG_BYTES),
        }),
      ).rejects.toThrow(CREDENTIAL_PROVIDER_NOT_STORABLE);
      expect(await store().get('c2', 'amqp')).toEqual({ kind: 'absent' });
    });

    it('accepts a config of exactly the size bound, and reads a row of exactly that size', async () => {
      const overhead = Buffer.byteLength(JSON.stringify({ pad: '' }), 'utf8');
      const exact = {
        pad: 'x'.repeat(CREDENTIAL_PROVIDER_MAX_CONFIG_BYTES - overhead),
      };
      expect(Buffer.byteLength(JSON.stringify(exact), 'utf8')).toBe(
        CREDENTIAL_PROVIDER_MAX_CONFIG_BYTES,
      );

      await store().put('c1', 'amqp', exact);
      await harness.plantRaw('c1', 'http', JSON.stringify(exact));

      for (const protocol of ['amqp', 'http'] as const) {
        expect(await store().get('c1', protocol)).toMatchObject({
          kind: 'found',
          record: { config: exact },
        });
      }
    });

    it('counts the bound in bytes, not in characters', async () => {
      // Three bytes each in UTF-8: the same character count is over the bound.
      const wide = {
        pad: '€'.repeat(Math.ceil(CREDENTIAL_PROVIDER_MAX_CONFIG_BYTES / 3)),
      };

      await expect(store().put('c1', 'amqp', wide)).rejects.toThrow(
        CREDENTIAL_PROVIDER_NOT_STORABLE,
      );
      await harness.plantRaw('c1', 'http', JSON.stringify(wide));
      expect(await store().get('c1', 'http')).toEqual({ kind: 'unreadable' });
    });

    it.each([
      ['undefined', undefined],
      ['a function', () => 1],
      ['a symbol', Symbol('x')],
      ['a bigint', { n: 10n }],
    ])('refuses to write %s with the fixed text', async (_label, value) => {
      await expect(store().put('c1', 'amqp', value)).rejects.toThrow(
        CREDENTIAL_PROVIDER_NOT_STORABLE,
      );
      expect(await store().get('c1', 'amqp')).toEqual({ kind: 'absent' });
    });

    it('refuses a value whose serialisation throws, and a cyclic one, without repeating the error', async () => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      const hostile = {
        toJSON: () => {
          throw new Error('secret-in-error');
        },
      };

      for (const value of [cyclic, hostile]) {
        const attempt = store().put('c1', 'amqp', value);
        await expect(attempt).rejects.toThrow(CREDENTIAL_PROVIDER_NOT_STORABLE);
        await expect(attempt).rejects.not.toThrow(/secret-in-error/);
      }
      expect(await store().get('c1', 'amqp')).toEqual({ kind: 'absent' });
    });
  });
}
