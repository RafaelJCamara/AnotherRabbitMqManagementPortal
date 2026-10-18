// The repository contract: the same tests run against every dialect (SQLite unit tests, SQLite and
// Postgres 16 and 18 integration tests). Test-only; excluded from the library build.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { PersistenceHandle } from '../database';
import { createRepositories } from '../repos';
import type { Repositories } from '../repos/ports';

export interface RepositoryContractOptions {
  /** Prefix of every test name, for example `AC-1 sqlite`. */
  name: string;
  /** Opens a database that already has the migrations applied. */
  open: () => Promise<PersistenceHandle>;
}

export function repositoryContract(options: RepositoryContractOptions): void {
  describe(`${options.name} repositories`, () => {
    let handle: PersistenceHandle;
    let repos: Repositories;
    const clock = { now: 1_000 };

    beforeAll(async () => {
      handle = await options.open();
      repos = createRepositories(handle, { now: () => clock.now });
    });

    afterAll(async () => {
      await handle.close();
    });

    beforeEach(async () => {
      clock.now = 1_000;
      await handle.db.deleteFrom('settings').execute();
      await handle.db.deleteFrom('connection_profiles').execute();
      await handle.db.deleteFrom('blobs').execute();
    });

    describe('settings', () => {
      it('stores and reads back nested JSON', async () => {
        const value = { a: [1, 'two', null, true], b: { c: 1.5 } };

        await repos.settings.set('workspace', 'layout', value);

        expect(await repos.settings.get('workspace', 'layout')).toEqual(value);
      });

      it('returns undefined for a missing key and keeps scopes apart', async () => {
        await repos.settings.set('one', 'k', 1);

        expect(await repos.settings.get('one', 'missing')).toBeUndefined();
        expect(await repos.settings.get('two', 'k')).toBeUndefined();
      });

      it('replaces the value of an existing key', async () => {
        await repos.settings.set('s', 'k', 'first');
        await repos.settings.set('s', 'k', 'second');

        expect(await repos.settings.get('s', 'k')).toBe('second');
        expect(await repos.settings.list('s')).toHaveLength(1);
      });

      it('deletes a key and says whether it existed', async () => {
        await repos.settings.set('s', 'k', 1);

        expect(await repos.settings.delete('s', 'k')).toBe(true);
        expect(await repos.settings.delete('s', 'k')).toBe(false);
        expect(await repos.settings.get('s', 'k')).toBeUndefined();
      });

      it('pages a scope by key, bounded by the limit', async () => {
        for (const key of ['d', 'a', 'c', 'b', 'e']) {
          await repos.settings.set('s', key, key.toUpperCase());
        }
        await repos.settings.set('other', 'a', 'x');

        const first = await repos.settings.list('s', { limit: 2 });
        const second = await repos.settings.list('s', {
          limit: 2,
          afterKey: 'b',
        });

        expect(first.map((entry) => entry.key)).toEqual(['a', 'b']);
        expect(second).toEqual([
          { key: 'c', value: 'C' },
          { key: 'd', value: 'D' },
        ]);
      });
    });

    describe('connection profiles', () => {
      const input = {
        id: 'prod-eu',
        name: 'Production EU',
        envClass: 'production',
        color: '#c0392b',
        config: { endpoints: [{ host: 'mq.example', port: 5672 }], tls: true },
        ownerId: null,
        visibility: 'private',
      } as const;

      it('saves a profile and stamps both times', async () => {
        const saved = await repos.connectionProfiles.save(input);

        expect(saved).toEqual({ ...input, createdAt: 1_000, updatedAt: 1_000 });
        expect(await repos.connectionProfiles.get('prod-eu')).toEqual(saved);
      });

      it('keeps createdAt and refreshes the rest when a profile is saved again', async () => {
        await repos.connectionProfiles.save(input);
        clock.now = 5_000;

        const again = await repos.connectionProfiles.save({
          ...input,
          name: 'Renamed',
          color: null,
          ownerId: 'user-1',
          visibility: 'team',
        });

        expect(again).toMatchObject({
          name: 'Renamed',
          color: null,
          ownerId: 'user-1',
          visibility: 'team',
          createdAt: 1_000,
          updatedAt: 5_000,
        });
      });

      it('returns undefined for an unknown id and deletes by id', async () => {
        await repos.connectionProfiles.save(input);

        expect(await repos.connectionProfiles.get('nope')).toBeUndefined();
        expect(await repos.connectionProfiles.delete('prod-eu')).toBe(true);
        expect(await repos.connectionProfiles.delete('prod-eu')).toBe(false);
      });

      it('pages profiles by id', async () => {
        for (const id of ['c', 'a', 'b']) {
          await repos.connectionProfiles.save({ ...input, id });
        }

        const first = await repos.connectionProfiles.list({ limit: 2 });
        const second = await repos.connectionProfiles.list({
          limit: 2,
          afterId: 'b',
        });

        expect(first.map((profile) => profile.id)).toEqual(['a', 'b']);
        expect(second.map((profile) => profile.id)).toEqual(['c']);
      });
    });

    describe('blobs', () => {
      const everyByte = Uint8Array.from({ length: 256 }, (_, index) => index);

      it('stores bytes under their sha256 and reads them back unchanged', async () => {
        const stored = await repos.blobs.put(everyByte);

        expect(stored.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(stored.refcount).toBe(1);
        expect(await repos.blobs.get(stored.sha256)).toEqual(everyByte);
      });

      it('counts references to the same bytes and deletes at zero', async () => {
        const body = new TextEncoder().encode('same bytes');
        const first = await repos.blobs.put(body);
        const second = await repos.blobs.put(body);

        expect(second).toEqual({ sha256: first.sha256, refcount: 2 });
        expect(await repos.blobs.release(first.sha256)).toBe(1);
        expect(await repos.blobs.get(first.sha256)).toEqual(body);
        expect(await repos.blobs.release(first.sha256)).toBe(0);
        expect(await repos.blobs.get(first.sha256)).toBeUndefined();
      });

      it('returns undefined for an unknown hash', async () => {
        expect(await repos.blobs.get('0'.repeat(64))).toBeUndefined();
        expect(await repos.blobs.release('0'.repeat(64))).toBeUndefined();
      });

      it('stores an empty body', async () => {
        const stored = await repos.blobs.put(new Uint8Array());

        expect(await repos.blobs.get(stored.sha256)).toEqual(new Uint8Array());
      });
    });
  });
}
