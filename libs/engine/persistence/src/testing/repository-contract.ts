// The repository contract: the same tests run against every dialect (SQLite unit tests, SQLite and
// Postgres 16 and 18 integration tests). Test-only; excluded from the library build.
import type {
  AuditRow,
  DataKeyRecord,
  PlanRecord,
  ReceiptRecord,
} from '@app/ports';
import { sql } from 'kysely';
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
      await handle.db.deleteFrom('receipts').execute();
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

    describe('audit events (append-only)', () => {
      const row = (seq: number, over: Partial<AuditRow> = {}): AuditRow => ({
        seq,
        at: 1_700_000_000_000 + seq,
        phase: 'attempt',
        correlationId: `corr-${String(seq)}`,
        actionId: 'queues.purge',
        kind: 'command',
        actorId: 'user-1',
        surface: 'ui',
        onBehalfOfId: null,
        actorJson: '{"id":"user-1"}',
        targetJson: '{"name":"orders"}',
        env: 'prod',
        risk: 'critical',
        planId: null,
        planDigest: null,
        approvedByJson: '[]',
        attemptSeq: null,
        result: null,
        code: null,
        jobId: null,
        receiptId: null,
        detailJson: '{}',
        prevHash: String(seq - 1).padStart(64, '0'),
        hash: String(seq).padStart(64, 'a'),
        ...over,
      });
      /** A database of its own: audit rows cannot be deleted between tests. */
      const own = async (): Promise<PersistenceHandle> => options.open();

      it('AC-1 audit: stores a row with every column and reads it back, nulls included', async () => {
        const handle = await own();
        const audit = createRepositories(handle).audit;
        const full = row(1, {
          phase: 'outcome',
          onBehalfOfId: 'boss',
          planId: 'plan-1',
          planDigest: 'd'.repeat(64),
          approvedByJson: '["approver-1"]',
          attemptSeq: 1,
          result: 'error',
          code: 'INTERNAL',
          jobId: 'job-1',
          receiptId: 'rcpt-1',
          detailJson: '{"receiptFailed":true}',
        });

        expect(await audit.append(full)).toBe(true);
        expect(await audit.append(row(2))).toBe(true);

        expect(await audit.window(0, 10)).toEqual([full, row(2)]);
        expect(await audit.head()).toEqual({ seq: 2, hash: row(2).hash });
        await handle.close();
      });

      it('AC-1 audit: an empty chain has no head', async () => {
        const handle = await own();

        expect(await createRepositories(handle).audit.head()).toBeUndefined();
        expect(await createRepositories(handle).audit.window(0, 10)).toEqual(
          [],
        );
        await handle.close();
      });

      it('AC-1 audit: a second row with the same seq, or the same prevHash, is refused and not stored', async () => {
        const handle = await own();
        const audit = createRepositories(handle).audit;
        await audit.append(row(1));

        expect(await audit.append(row(1, { correlationId: 'other' }))).toBe(
          false,
        );
        expect(await audit.append(row(2, { prevHash: row(1).prevHash }))).toBe(
          false,
        );

        expect(await audit.window(0, 10)).toEqual([row(1)]);
        await handle.close();
      });

      it('AC-1 audit: of many writers racing for one seq exactly one wins', async () => {
        const handle = await own();
        const audit = createRepositories(handle).audit;

        const results = await Promise.all(
          Array.from({ length: 12 }, (_, i) =>
            audit.append(
              row(1, {
                correlationId: `racer-${String(i)}`,
                prevHash: String(i).padStart(64, '0'),
              }),
            ),
          ),
        );

        expect(results.filter(Boolean)).toHaveLength(1);
        expect(await audit.window(0, 100)).toHaveLength(1);
        await handle.close();
      });

      it('AC-1 audit: windows are ordered by seq, start after a seq and are bounded', async () => {
        const handle = await own();
        const audit = createRepositories(handle).audit;
        for (const seq of [3, 1, 2, 4]) await audit.append(row(seq));

        expect((await audit.window(0, 10)).map((r) => r.seq)).toEqual([
          1, 2, 3, 4,
        ]);
        expect((await audit.window(1, 2)).map((r) => r.seq)).toEqual([2, 3]);
        expect(await audit.window(4, 10)).toEqual([]);
        expect(await audit.window(0, 0)).toHaveLength(1);
        expect(await audit.window(0, 5_000_000)).toHaveLength(4);
        await handle.close();
      });

      it('AC-1 audit: the database itself refuses to update or delete an audit row', async () => {
        const handle = await own();
        const audit = createRepositories(handle).audit;
        await audit.append(row(1));

        await expect(
          handle.db
            .updateTable('audit_events')
            .set({ risk: 'none' })
            .where('seq', '=', 1)
            .execute(),
        ).rejects.toThrow(/append-only/);
        await expect(
          handle.db.deleteFrom('audit_events').where('seq', '=', 1).execute(),
        ).rejects.toThrow(/append-only/);
        await expect(
          handle.db.deleteFrom('audit_events').execute(),
        ).rejects.toThrow(/append-only/);

        expect(await audit.window(0, 10)).toEqual([row(1)]);
        await handle.close();
      });

      it('AC-1 audit: Postgres also refuses TRUNCATE', async ({ skip }) => {
        const handle = await own();
        if (handle.dialect !== 'pg') {
          await handle.close();
          skip();
          return;
        }

        await expect(
          sql`TRUNCATE audit_events`.execute(handle.db),
        ).rejects.toThrow(/append-only/);
        await handle.close();
      });
    });

    describe('receipts', () => {
      const receipt = (
        id: string,
        over: Partial<ReceiptRecord> = {},
      ): ReceiptRecord => ({
        id: id as ReceiptRecord['id'],
        actionId: 'queues.purge' as ReceiptRecord['actionId'],
        planId: null,
        planDigest: null,
        principalId: 'user-1',
        onBehalfOfId: null,
        correlationId: 'corr-1',
        env: 'prod',
        risk: 'critical',
        startedAt: 1_000,
        finishedAt: 1_250,
        result: 'ok',
        code: null,
        jobId: null,
        auditSeq: null,
        detailJson: '{}',
        createdAt: 1_300,
        ...over,
      });

      it('AC-1 receipt: stores a receipt and reads every column back, nulls included', async () => {
        const full = receipt('rcpt-1', {
          planId: 'plan-1' as ReceiptRecord['planId'],
          planDigest: 'd'.repeat(64),
          onBehalfOfId: 'boss',
          result: 'error',
          code: 'BROKER_UNREACHABLE',
          jobId: 'job-1' as ReceiptRecord['jobId'],
          auditSeq: 12,
          detailJson: '{"perMessage":[{"position":1}]}',
        });

        await repos.receipts.insert(full);
        await repos.receipts.insert(receipt('rcpt-2'));

        expect(await repos.receipts.get(full.id)).toEqual(full);
        expect(await repos.receipts.get('rcpt-2' as never)).toEqual(
          receipt('rcpt-2'),
        );
        expect(await repos.receipts.get('missing' as never)).toBeUndefined();
      });

      it('AC-1 receipt: a repeated id is refused', async () => {
        await repos.receipts.insert(receipt('rcpt-1'));

        await expect(
          repos.receipts.insert(receipt('rcpt-1')),
        ).rejects.toThrow();
      });

      it('AC-1 receipt: retention deletes old receipts only, at most the limit at a time', async () => {
        await repos.receipts.insert(receipt('old-1', { createdAt: 100 }));
        await repos.receipts.insert(receipt('old-2', { createdAt: 200 }));
        await repos.receipts.insert(receipt('new-1', { createdAt: 900 }));

        expect(await repos.receipts.purgeBefore(500, 1)).toBe(1);
        expect(await repos.receipts.purgeBefore(500, 10)).toBe(1);
        expect(await repos.receipts.purgeBefore(500, 10)).toBe(0);

        expect(await repos.receipts.get('new-1' as never)).toBeDefined();
      });
    });

    describe('data keys (wrapped, never in the open)', () => {
      const key = (
        id: string,
        over: Partial<DataKeyRecord> = {},
      ): DataKeyRecord => ({
        id: id.padEnd(32, '0'),
        purpose: 'main',
        wrapKind: 'passphrase',
        wrapParamsJson:
          '{"N":131072,"kdf":"scrypt","p":1,"r":8,"salt":"c2FsdA=="}',
        wrapped: Uint8Array.from(
          { length: 60 },
          (_, index) => (index * 7) % 256,
        ),
        state: 'active',
        createdAt: 1_000,
        retiredAt: null,
        ...over,
      });

      beforeEach(async () => {
        await handle.db.deleteFrom('data_keys').execute();
      });

      it('AC-1 data key: stores a key and reads every column back, bytes and nulls included', async () => {
        const retired = key('b', {
          wrapKind: 'keyring',
          state: 'retired',
          createdAt: 500,
          retiredAt: 900,
        });

        expect(await repos.dataKeys.insert(key('a'))).toBe(true);
        expect(await repos.dataKeys.insert(retired)).toBe(true);

        expect(await repos.dataKeys.get(key('a').id)).toEqual(key('a'));
        expect(await repos.dataKeys.get(retired.id)).toEqual(retired);
        expect(await repos.dataKeys.get('f'.repeat(32))).toBeUndefined();
        const stored = await repos.dataKeys.get(key('a').id);
        expect(stored?.wrapped).toBeInstanceOf(Uint8Array);
        expect(Buffer.isBuffer(stored?.wrapped)).toBe(false);
      });

      it('AC-1 data key: a repeated id is refused and the first row stays', async () => {
        await repos.dataKeys.insert(key('a'));

        expect(
          await repos.dataKeys.insert(
            key('a', { wrapKind: 'file-kek', purpose: 'other' }),
          ),
        ).toBe(false);

        expect(await repos.dataKeys.get(key('a').id)).toEqual(key('a'));
      });

      it('AC-1 data key: one active key per purpose, more under other purposes and beside retired ones', async () => {
        expect(await repos.dataKeys.insert(key('a'))).toBe(true);
        expect(await repos.dataKeys.insert(key('b'))).toBe(false);
        expect(await repos.dataKeys.get(key('b').id)).toBeUndefined();

        expect(
          await repos.dataKeys.insert(key('c', { purpose: 'captures' })),
        ).toBe(true);
        expect(
          await repos.dataKeys.insert(
            key('d', { state: 'retired', retiredAt: 5 }),
          ),
        ).toBe(true);
      });

      it('AC-1 data key: of many writers racing to initialise one purpose exactly one wins', async () => {
        const results = await Promise.all(
          Array.from({ length: 12 }, (_, i) =>
            repos.dataKeys.insert(key(i.toString(16))),
          ),
        );

        expect(results.filter(Boolean)).toHaveLength(1);
        expect(await repos.dataKeys.list('main')).toHaveLength(1);
      });

      it('AC-1 data key: retiring keeps the row, once, and frees the purpose for a new active key', async () => {
        await repos.dataKeys.insert(key('a'));

        expect(await repos.dataKeys.retire(key('a').id, 2_000)).toBe(true);
        expect(await repos.dataKeys.retire(key('a').id, 3_000)).toBe(false);
        expect(await repos.dataKeys.retire('f'.repeat(32), 3_000)).toBe(false);
        expect(await repos.dataKeys.get(key('a').id)).toEqual(
          key('a', { state: 'retired', retiredAt: 2_000 }),
        );

        expect(
          await repos.dataKeys.insert(key('b', { createdAt: 2_000 })),
        ).toBe(true);
      });

      it('AC-1 data key: lists one purpose, newest first', async () => {
        await repos.dataKeys.insert(
          key('a', { state: 'retired', retiredAt: 1, createdAt: 100 }),
        );
        await repos.dataKeys.insert(key('b', { createdAt: 300 }));
        await repos.dataKeys.insert(
          key('c', { state: 'retired', retiredAt: 2, createdAt: 200 }),
        );
        await repos.dataKeys.insert(key('d', { purpose: 'captures' }));

        expect(
          (await repos.dataKeys.list('main')).map((row) => row.id),
        ).toEqual([key('b').id, key('c').id, key('a').id]);
        expect(await repos.dataKeys.list('nobody')).toEqual([]);
      });

      it('AC-1 data key: the database refuses a wrap kind or a state it does not know', async () => {
        const base = {
          id: 'e'.repeat(32),
          purpose: 'main',
          wrap_params: '{}',
          wrapped: new Uint8Array(1),
          created_at: 1,
          retired_at: null,
        };

        await expect(
          handle.db
            .insertInto('data_keys')
            .values({
              ...base,
              wrap_kind: 'plaintext' as never,
              state: 'retired',
            })
            .execute(),
        ).rejects.toThrow();
        await expect(
          handle.db
            .insertInto('data_keys')
            .values({
              ...base,
              wrap_kind: 'keyring',
              state: 'maybe' as never,
            })
            .execute(),
        ).rejects.toThrow();
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

    describe('workspace (views and per-owner documents)', () => {
      const view = (id: string, ownerId: string, kind = 'queues') => ({
        id,
        ownerId,
        name: `view ${id}`,
        kind,
        definition: {
          filter: { regex: '^orders' },
          columns: ['name', 'ready'],
        },
        createdAt: 1_000,
        updatedAt: 1_000,
      });

      beforeEach(async () => {
        await handle.db.deleteFrom('views').execute();
      });

      it('stores a view with its JSON definition and deletes it for its owner only', async () => {
        await repos.workspace.insertView(view('v1', 'alice'));

        expect(await repos.workspace.deleteView('bob', 'v1')).toBe(false);
        expect(await repos.workspace.listViews('alice', { limit: 10 })).toEqual(
          {
            items: [view('v1', 'alice')],
          },
        );
        expect(await repos.workspace.deleteView('alice', 'v1')).toBe(true);
        expect(await repos.workspace.deleteView('alice', 'v1')).toBe(false);
        expect(await repos.workspace.countViews('alice')).toBe(0);
      });

      it('lists one owner in windows by id and filters by kind', async () => {
        for (const id of ['v1', 'v2', 'v3']) {
          await repos.workspace.insertView(
            view(id, 'alice', id === 'v2' ? 'exchanges' : 'queues'),
          );
        }
        await repos.workspace.insertView(view('v4', 'bob'));

        const first = await repos.workspace.listViews('alice', { limit: 2 });
        const second = await repos.workspace.listViews('alice', {
          limit: 2,
          ...(first.nextCursor === undefined
            ? {}
            : { cursor: first.nextCursor }),
        });

        expect(first.items.map((item) => item.id)).toEqual(['v1', 'v2']);
        expect(first.nextCursor).toBe('v2');
        expect(second.items.map((item) => item.id)).toEqual(['v3']);
        expect(second.nextCursor).toBeUndefined();
        expect(
          (
            await repos.workspace.listViews('alice', {
              kind: 'exchanges',
              limit: 10,
            })
          ).items.map((item) => item.id),
        ).toEqual(['v2']);
        expect(await repos.workspace.countViews('alice')).toBe(3);
      });

      it('keeps documents apart by owner and kind, and replaces on write', async () => {
        clock.now = 5_000;
        await repos.workspace.putDocument('alice', 'layout', 'c1', { a: 1 });
        await repos.workspace.putDocument('alice', 'layout', 'c2', { a: 2 });
        await repos.workspace.putDocument('alice', 'setting', 'c1', 'x');
        clock.now = 6_000;
        await repos.workspace.putDocument('alice', 'layout', 'c1', { a: 3 });

        expect(
          await repos.workspace.getDocument('alice', 'layout', 'c1'),
        ).toEqual({
          key: 'c1',
          value: { a: 3 },
          updatedAt: 6_000,
        });
        expect(
          await repos.workspace.getDocument('bob', 'layout', 'c1'),
        ).toBeUndefined();
        expect(
          (await repos.workspace.listDocuments('alice', 'layout', 10)).map(
            (document) => document.key,
          ),
        ).toEqual(['c1', 'c2']);
        expect(
          await repos.workspace.listDocuments('alice', 'layout', 1),
        ).toHaveLength(1);
      });
    });

    describe('connections (profiles with sealed credentials)', () => {
      const profile = (id: string, ownerId: string | null, team = false) => ({
        id,
        name: `connection ${id}`,
        envClass: 'staging',
        color: null,
        config: { v: 1, http: { host: 'mq.example', port: 15672 } },
        ownerId,
        visibility: team ? ('team' as const) : ('private' as const),
      });
      // Bytes with every value in them, as a real ciphertext has.
      const sealed = (seed: number) =>
        Uint8Array.from({ length: 64 }, (_, index) => (index * 7 + seed) % 256);

      beforeEach(async () => {
        await handle.db.deleteFrom('credentials').execute();
      });

      it('saves the profile and its credentials together and reads the bytes back unchanged', async () => {
        const saved = await repos.connections.save(profile('c1', 'alice'), {
          put: { http: sealed(1), amqp: sealed(2) },
        });

        expect(saved).toMatchObject({
          id: 'c1',
          createdAt: 1_000,
          updatedAt: 1_000,
        });
        const stored = await repos.connections.credentials('c1');
        expect(stored.map((row) => row.protocol)).toEqual(['amqp', 'http']);
        expect(
          Buffer.from(stored[0]?.ciphertext ?? new Uint8Array()).equals(
            Buffer.from(sealed(2)),
          ),
        ).toBe(true);
        expect(
          Buffer.from(stored[1]?.ciphertext ?? new Uint8Array()).equals(
            Buffer.from(sealed(1)),
          ),
        ).toBe(true);
      });

      it('replaces one credential, removes another and leaves a protocol that is not named alone', async () => {
        await repos.connections.save(profile('c1', 'alice'), {
          put: { http: sealed(1), amqp: sealed(2) },
        });
        clock.now = 5_000;

        await repos.connections.save(profile('c1', 'alice'), {
          put: { http: sealed(3) },
        });
        expect(
          (await repos.connections.credentials('c1')).map((row) => [
            row.protocol,
            row.updatedAt,
          ]),
        ).toEqual([
          ['amqp', 1_000],
          ['http', 5_000],
        ]);

        await repos.connections.save(profile('c1', 'alice'), {
          remove: ['amqp'],
        });
        expect(
          (await repos.connections.credentials('c1')).map(
            (row) => row.protocol,
          ),
        ).toEqual(['http']);
      });

      it('deletes the profile and every credential of it, and only that profile', async () => {
        await repos.connections.save(profile('c1', 'alice'), {
          put: { http: sealed(1), amqp: sealed(2) },
        });
        await repos.connections.save(profile('c2', 'alice'), {
          put: { http: sealed(3) },
        });

        expect(await repos.connections.delete('c1')).toBe(true);
        expect(await repos.connections.delete('c1')).toBe(false);

        expect(await repos.connections.get('c1')).toBeUndefined();
        expect(await repos.connections.credentials('c1')).toEqual([]);
        expect(await repos.connections.credentials('c2')).toHaveLength(1);
      });

      it('lists only what a person may see, in windows by id, and counts the same', async () => {
        for (const row of [
          profile('a', 'alice'),
          profile('b', 'bob'),
          profile('c', 'bob', true),
          profile('d', 'alice'),
          profile('e', null, true),
        ]) {
          await repos.connections.save(row);
        }

        const first = await repos.connections.list({
          visibleTo: 'alice',
          limit: 2,
        });
        const second = await repos.connections.list({
          visibleTo: 'alice',
          limit: 2,
          ...(first.nextCursor === undefined
            ? {}
            : { cursor: first.nextCursor }),
        });

        expect(first.items.map((item) => item.id)).toEqual(['a', 'c']);
        expect(first.nextCursor).toBe('c');
        expect(second.items.map((item) => item.id)).toEqual(['d', 'e']);
        expect(second.nextCursor).toBeUndefined();
        expect(await repos.connections.count('alice')).toBe(4);
        expect(await repos.connections.count('bob')).toBe(3);
        expect(await repos.connections.count('nobody')).toBe(2);
      });
    });
  });
}
