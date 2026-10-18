// The repository contract: the same tests run against every dialect (SQLite unit tests, SQLite and
// Postgres 16 and 18 integration tests). Test-only; excluded from the library build.
import type { PlanRecord } from '@app/ports';
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
      await handle.db.deleteFrom('plans').execute();
      await handle.db.deleteFrom('idempotency_keys').execute();
    });

    describe('plans', () => {
      const payload = Uint8Array.from({ length: 256 }, (_, index) => index);
      const plan: PlanRecord = {
        id: 'plan-1' as PlanRecord['id'],
        actionId: 'queues.purge' as PlanRecord['actionId'],
        inputHash: 'a'.repeat(64),
        digest: 'b'.repeat(64),
        principalId: 'user-1',
        onBehalfOfId: null,
        profileFingerprint: 'fp-1',
        env: 'prod',
        risk: 'critical',
        state: 'open',
        approvalsRequired: 0,
        approvals: [],
        gatesJson: '[]',
        warningsJson: '[]',
        previewJson: '{"messages":12}',
        consentsRequired: ['typed', 'W-LOSS'],
        confirmationPhrase: 'purge orders',
        payload,
        expiresAt: 10_000,
        createdAt: 1_000,
        updatedAt: 1_000,
        version: 1,
      };

      it('stores a plan and reads every column back, bytes included', async () => {
        await repos.plans.insert(plan);

        expect(await repos.plans.get(plan.id)).toEqual(plan);
        expect(
          await repos.plans.get('missing' as PlanRecord['id']),
        ).toBeUndefined();
      });

      it('keeps nulls as nulls', async () => {
        const bare = {
          ...plan,
          id: 'plan-2' as PlanRecord['id'],
          profileFingerprint: null,
          confirmationPhrase: null,
          payload: null,
        };
        await repos.plans.insert(bare);

        expect(await repos.plans.get(bare.id)).toEqual(bare);
      });

      it('refuses a second plan with the same id', async () => {
        await repos.plans.insert(plan);

        await expect(repos.plans.insert(plan)).rejects.toThrow();
      });

      it('update is a compare-and-set on the version', async () => {
        await repos.plans.insert(plan);
        const approvals = [
          {
            by: 'a1',
            at: 2_000,
            decision: 'approve' as const,
            digest: plan.digest,
            seal: 'c2VhbA==',
            note: 'ok',
          },
        ];

        const first = await repos.plans.update(
          plan.id,
          1,
          { state: 'approved', approvals, expiresAt: 20_000 },
          2_000,
        );
        const stale = await repos.plans.update(
          plan.id,
          1,
          { state: 'executing' },
          3_000,
        );

        expect(first).toMatchObject({
          state: 'approved',
          approvals,
          expiresAt: 20_000,
          updatedAt: 2_000,
          version: 2,
        });
        expect(first?.payload).toEqual(payload);
        expect(stale).toBeUndefined();
        expect((await repos.plans.get(plan.id))?.state).toBe('approved');
      });

      it('update can purge the payload, and an unknown id updates nothing', async () => {
        await repos.plans.insert(plan);

        const purged = await repos.plans.update(
          plan.id,
          1,
          { state: 'executed', payload: null },
          2_000,
        );
        const none = await repos.plans.update(
          'missing' as PlanRecord['id'],
          1,
          { state: 'executed' },
          2_000,
        );

        expect(purged).toMatchObject({ state: 'executed', payload: null });
        expect(purged?.digest).toBe(plan.digest);
        expect(none).toBeUndefined();
      });

      it('concurrent updates of one version: exactly one wins', async () => {
        await repos.plans.insert(plan);

        const results = await Promise.all(
          Array.from({ length: 6 }, () =>
            repos.plans.update(plan.id, 1, { state: 'executing' }, 2_000),
          ),
        );

        expect(results.filter((row) => row !== undefined)).toHaveLength(1);
        expect((await repos.plans.get(plan.id))?.version).toBe(2);
      });

      it('counts the live and executing plans of a principal that are not yet due', async () => {
        const make = (
          id: string,
          overrides: Partial<PlanRecord>,
        ): Promise<void> =>
          repos.plans.insert({
            ...plan,
            id: id as PlanRecord['id'],
            ...overrides,
          });
        await make('p-open', {});
        await make('p-await', { state: 'awaiting-approval' });
        await make('p-exec', { state: 'executing' });
        await make('p-done', { state: 'executed' });
        await make('p-due', { expiresAt: 5_000 });
        await make('p-other', { principalId: 'user-2' });

        expect(await repos.plans.countActive('user-1', 5_000)).toBe(3);
        expect(await repos.plans.countActive('user-2', 5_000)).toBe(1);
        expect(await repos.plans.countActive('nobody', 5_000)).toBe(0);
      });

      it('expireDue expires live plans past their time, drops the payload, and respects the limit', async () => {
        const make = (id: string, overrides: Partial<PlanRecord>) =>
          repos.plans.insert({
            ...plan,
            id: id as PlanRecord['id'],
            ...overrides,
          });
        await make('e1', { expiresAt: 1_500 });
        await make('e2', { expiresAt: 1_600, state: 'awaiting-approval' });
        await make('e3', { expiresAt: 1_700, state: 'approved' });
        await make('keep-future', { expiresAt: 9_000 });
        await make('keep-exec', { expiresAt: 1_500, state: 'executing' });
        await make('keep-done', { expiresAt: 1_500, state: 'executed' });

        expect(await repos.plans.expireDue(2_000, 2)).toBe(2);
        expect(await repos.plans.expireDue(2_000, 10)).toBe(1);
        expect(await repos.plans.expireDue(2_000, 10)).toBe(0);

        for (const id of ['e1', 'e2', 'e3']) {
          expect(await repos.plans.get(id as PlanRecord['id'])).toMatchObject({
            state: 'expired',
            payload: null,
            updatedAt: 2_000,
            version: 2,
          });
        }
        expect(
          (await repos.plans.get('keep-future' as PlanRecord['id']))?.state,
        ).toBe('open');
        expect(
          (await repos.plans.get('keep-exec' as PlanRecord['id']))?.state,
        ).toBe('executing');
        expect(
          (await repos.plans.get('keep-done' as PlanRecord['id']))?.version,
        ).toBe(1);
      });

      it('purgeBefore deletes finished plans last touched before the cutoff, never live ones', async () => {
        const make = (id: string, overrides: Partial<PlanRecord>) =>
          repos.plans.insert({
            ...plan,
            id: id as PlanRecord['id'],
            ...overrides,
          });
        await make('old-done', { state: 'executed', updatedAt: 100 });
        await make('old-failed', { state: 'failed', updatedAt: 100 });
        await make('old-open', { updatedAt: 100 });
        await make('new-done', { state: 'executed', updatedAt: 900 });

        expect(await repos.plans.purgeBefore(500, 1)).toBe(1);
        expect(await repos.plans.purgeBefore(500, 10)).toBe(1);

        expect(
          await repos.plans.get('old-open' as PlanRecord['id']),
        ).toBeDefined();
        expect(
          await repos.plans.get('new-done' as PlanRecord['id']),
        ).toBeDefined();
        expect(
          await repos.plans.get('old-done' as PlanRecord['id']),
        ).toBeUndefined();
      });
    });

    describe('idempotency keys', () => {
      const info = {
        actionId: 'queues.purge' as PlanRecord['actionId'],
        planId: null,
        at: 1_000,
      };

      it('takes a key once per principal', async () => {
        expect(await repos.idempotency.claim('user-1', 'key-0001', info)).toBe(
          true,
        );
        expect(await repos.idempotency.claim('user-1', 'key-0001', info)).toBe(
          false,
        );
        expect(await repos.idempotency.claim('user-2', 'key-0001', info)).toBe(
          true,
        );
        expect(await repos.idempotency.has('user-1', 'key-0001')).toBe(true);
        expect(await repos.idempotency.has('user-1', 'key-0002')).toBe(false);
      });

      it('concurrent claims of one key: exactly one wins', async () => {
        const results = await Promise.all(
          Array.from({ length: 6 }, () =>
            repos.idempotency.claim('user-1', 'key-race', info),
          ),
        );

        expect(results.filter(Boolean)).toHaveLength(1);
      });

      it('purges keys older than the cutoff', async () => {
        await repos.idempotency.claim('user-1', 'old-key-1', {
          ...info,
          at: 100,
        });
        await repos.idempotency.claim('user-1', 'new-key-1', {
          ...info,
          at: 900,
        });

        expect(await repos.idempotency.purgeBefore(500)).toBe(1);

        expect(await repos.idempotency.has('user-1', 'old-key-1')).toBe(false);
        expect(await repos.idempotency.has('user-1', 'new-key-1')).toBe(true);
      });
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
