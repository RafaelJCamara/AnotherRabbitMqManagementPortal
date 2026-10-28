// The credential provider store contract on a database (M1-23 slice E, OQ-1455): the same tests run on
// every dialect (SQLite unit tests, SQLite and Postgres 16 and 18 integration tests). The behaviour of
// the port is the shared suite of `@app/ports/testing`, which the in-memory store of `svc-identity`
// passes too; what only a database can show (the CHECK, the cascade with the connection, the sealed
// secret kept apart) is here. Test-only; excluded from the library build.
import { credentialProviderStoreContract } from '@app/ports/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { PersistenceHandle } from '../database';
import { createRepositories } from '../repos';
import type { Repositories } from '../repos/ports';

export interface CredentialProvidersContractOptions {
  /** Prefix of every test name, for example `sqlite (in memory)`. */
  name: string;
  /** Opens a database that already has the migrations applied. */
  open: () => Promise<PersistenceHandle>;
}

const CLOCK = 5_000;

const CLIENT_CREDENTIALS = {
  kind: 'client-credentials',
  endpoint: 'https://idp.example/oauth/token',
  clientId: 'engine',
  usernameClaims: ['sub'],
};
const TOKEN_COMMAND = {
  kind: 'token-command',
  file: '/usr/local/bin/mint-token',
  args: [],
  usernameClaims: ['sub'],
};

export function credentialProvidersContract(
  options: CredentialProvidersContractOptions,
): void {
  // The port itself: the suite that the in-memory store passes as well.
  credentialProviderStoreContract({
    name: `credential_providers, ${options.name}`,
    open: async () => {
      const handle = await options.open();
      let clock = CLOCK;
      const repos = createRepositories(handle, { now: () => clock });
      return {
        store: repos.credentialProviders,
        setClock: (ms) => {
          clock = ms;
          return true;
        },
        plantRaw: async (connectionId, protocol, text) => {
          await handle.db
            .insertInto('credential_providers')
            .values({
              connection_id: connectionId,
              protocol,
              config: text,
              updated_at: 1,
            })
            .execute();
        },
        reset: async () => {
          await handle.db.deleteFrom('credential_providers').execute();
        },
        close: () => handle.close(),
      };
    },
  });

  describe(`M1-23 slice E the credential_providers table (${options.name})`, () => {
    let handle: PersistenceHandle;
    let repos: Repositories;

    beforeAll(async () => {
      handle = await options.open();
      repos = createRepositories(handle, { now: () => CLOCK });
    });

    afterAll(async () => {
      await handle.close();
    });

    beforeEach(async () => {
      await handle.db.deleteFrom('credential_providers').execute();
      await handle.db.deleteFrom('credentials').execute();
      await handle.db.deleteFrom('connection_profiles').execute();
    });

    const profile = (id: string) => ({
      id,
      name: `connection ${id}`,
      envClass: 'staging',
      color: null,
      config: { v: 1 },
      ownerId: 'alice',
      visibility: 'private' as const,
    });

    it('refuses a protocol the credentials table does not know (the same CHECK as 0007)', async () => {
      await expect(
        handle.db
          .insertInto('credential_providers')
          .values({
            connection_id: 'c1',
            protocol: 'stream' as 'http',
            config: '{}',
            updated_at: 1,
          })
          .execute(),
      ).rejects.toThrow();
    });

    it('keeps one row for a key whatever the order of writes, and refuses a second row for it', async () => {
      await repos.credentialProviders.put('c1', 'amqp', CLIENT_CREDENTIALS);
      await repos.credentialProviders.put('c1', 'amqp', TOKEN_COMMAND);

      const rows = await handle.db
        .selectFrom('credential_providers')
        .selectAll()
        .execute();
      expect(rows).toHaveLength(1);
      await expect(
        handle.db
          .insertInto('credential_providers')
          .values({
            connection_id: 'c1',
            protocol: 'amqp',
            config: '{}',
            updated_at: 1,
          })
          .execute(),
      ).rejects.toThrow();
    });

    it('removes the provider rows of a connection when the connection is deleted, and only that connection', async () => {
      await repos.connections.save(profile('c1'));
      await repos.connections.save(profile('c2'));
      await repos.credentialProviders.put('c1', 'amqp', CLIENT_CREDENTIALS);
      await repos.credentialProviders.put('c1', 'http', TOKEN_COMMAND);
      await repos.credentialProviders.put('c2', 'amqp', CLIENT_CREDENTIALS);

      expect(await repos.connections.delete('c1')).toBe(true);

      expect(await repos.credentialProviders.get('c1', 'amqp')).toEqual({
        kind: 'absent',
      });
      expect(await repos.credentialProviders.get('c1', 'http')).toEqual({
        kind: 'absent',
      });
      expect((await repos.credentialProviders.get('c2', 'amqp')).kind).toBe(
        'found',
      );
    });

    it('removes the provider rows of a connection that has no profile row any more (a leftover)', async () => {
      await repos.credentialProviders.put('ghost', 'amqp', CLIENT_CREDENTIALS);

      expect(await repos.connections.delete('ghost')).toBe(false);

      expect(await repos.credentialProviders.get('ghost', 'amqp')).toEqual({
        kind: 'absent',
      });
    });

    it('keeps the sealed credential and the provider row of a profile independent of each other', async () => {
      const sealed = Uint8Array.from([9, 8, 7, 6]);
      await repos.connections.save(profile('c1'), { put: { amqp: sealed } });
      await repos.credentialProviders.put('c1', 'amqp', CLIENT_CREDENTIALS);

      // Removing the provider row does not touch the sealed secret...
      await repos.credentialProviders.delete('c1', 'amqp');
      expect(await repos.connections.credentials('c1')).toHaveLength(1);

      // ...and removing the secret does not touch the provider row.
      await repos.credentialProviders.put('c1', 'amqp', TOKEN_COMMAND);
      await repos.connections.save(profile('c1'), { remove: ['amqp'] });
      expect(await repos.connections.credentials('c1')).toEqual([]);
      expect((await repos.credentialProviders.get('c1', 'amqp')).kind).toBe(
        'found',
      );
    });

    it('creates no provider row when a profile is saved with sealed secrets (a bundle import saves this way)', async () => {
      // A bundle import goes through ConnectionStore.save; it never creates a provider config, so a
      // token command cannot arrive that way (the E7 review checks the rest).
      await repos.connections.save(profile('c1'), {
        put: { http: Uint8Array.from([1, 2, 3]), amqp: Uint8Array.from([4]) },
      });

      const rows = await handle.db
        .selectFrom('credential_providers')
        .selectAll()
        .execute();
      expect(rows).toEqual([]);
    });
  });
}
