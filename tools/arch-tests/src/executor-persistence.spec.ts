// The ActionExecutor (kernel) running over the SQL plan and idempotency repositories (persistence):
// the two halves of M0-29 agree on what a row holds, and a row edited behind the executor's back
// is caught. The kernel cannot import an adapter and an adapter cannot import the kernel, so the
// test that joins them lives in a type:test project.
import { defineAction, type ConnectionId } from '@app/contracts';
import {
  allowUiPrincipals,
  AppError,
  createActionExecutor,
  createAesGcmTestCipher,
  createAuditChain,
  createGuardrails,
  createIdGenerator,
  createManualClock,
  createPlanStore,
  createReceiptStore,
  createRecordingWrites,
  createTestContext,
  createTestPrincipal,
  implementAction,
  type ActionExecutor,
  type AuditChain,
  type ReceiptStore,
} from '@app/kernel';
import {
  createMigrationRunner,
  createRepositories,
  executeRawStatement,
  openSqlite,
  type PersistenceHandle,
  type Repositories,
} from '@app/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

const purge = defineAction({
  id: 'queues.purge',
  kind: 'command',
  summary: 'Purge a queue',
  input: z.strictObject({ name: z.string() }),
  output: z.strictObject({ purged: z.number() }),
  permission: 'messages.purge',
  risk: 'critical',
  planning: 'required',
  confirm: {
    requiredWhen: (env) => env === 'prod',
    phrase: (input) => `purge ${input.name}`,
  },
  audit: 'attempt+outcome',
  target: (input) => ({
    connectionId: 'c1' as ConnectionId,
    name: input.name,
  }),
  since: '1.0',
});

describe('executor over the SQL plan repositories', () => {
  let handle: PersistenceHandle;
  let repos: Repositories;
  let executor: ActionExecutor;
  let chain: AuditChain;
  let receipts: ReceiptStore;
  let executed = 0;
  const clock = createManualClock(1_700_000_000_000);
  let counter = 0;
  const key = (): string => {
    counter += 1;
    return `sql-key-${String(counter).padStart(6, '0')}`;
  };
  const ctx = createTestContext({ env: 'prod' });

  beforeEach(async () => {
    executed = 0;
    handle = await openSqlite({ path: ':memory:' });
    await createMigrationRunner({ handle }).migrate();
    repos = createRepositories(handle, { now: () => clock.now() });
    const ids = createIdGenerator({ clock });
    const guardrails = createGuardrails({ clock });
    // The person arms the production connection the specs below work on.
    guardrails.arming.arm(createTestPrincipal(), 'c1');
    chain = createAuditChain({ repository: repos.audit });
    receipts = createReceiptStore({ repository: repos.receipts, clock, ids });
    executor = createActionExecutor({
      plans: createPlanStore({
        repository: repos.plans,
        cipher: createAesGcmTestCipher(),
        clock,
        ids,
      }),
      idempotency: repos.idempotency,
      authorizer: allowUiPrincipals(),
      audit: chain,
      guardrails: guardrails.policy,
      receipts,
      writes: createRecordingWrites().writes,
      clock,
      ids,
    });
    executor.register(
      implementAction(purge, {
        plan: () =>
          Promise.resolve({
            preview: { messages: 12, big: 2n ** 60n, raw: Uint8Array.of(1, 2) },
            gates: [{ id: 'note', blocking: false, reason: 'FYI' }],
            warnings: [],
            consentsRequired: ['typed'],
            sensitivePayload: { body: 'a very secret body' },
          }),
        revalidate: () => Promise.resolve('valid'),
        execute: () => {
          executed += 1;
          return Promise.resolve({ purged: 12 });
        },
      }),
    );
  });

  afterEach(async () => {
    await handle.close();
  });

  const plan = () => executor.plan(purge, { name: 'orders' }, ctx);
  const run = (planId: string, extra: { confirmation?: string } = {}) =>
    executor.execute(
      {
        planId: planId as never,
        consents: ['typed'],
        idempotencyKey: key(),
        confirmation: extra.confirmation ?? 'purge orders',
      },
      ctx,
    );

  it('AC-1 stores the plan as a row with an encrypted payload, then executes once and purges it', async () => {
    const created = await plan();

    const row = await repos.plans.get(created.id);
    expect(row).toMatchObject({
      state: 'open',
      actionId: 'queues.purge',
      env: 'prod',
      risk: 'critical',
      digest: created.digest,
      confirmationPhrase: 'purge orders',
      consentsRequired: ['typed'],
    });
    expect(Buffer.from(row?.payload ?? []).toString('latin1')).not.toContain(
      'secret',
    );
    expect(created.preview).toEqual({
      messages: 12,
      big: 2n ** 60n,
      raw: Uint8Array.of(1, 2),
    });

    expect(await run(created.id)).toMatchObject({
      kind: 'output',
      output: { purged: 12 },
    });

    expect(executed).toBe(1);
    expect(await repos.plans.get(created.id)).toMatchObject({
      state: 'executed',
      payload: null,
      digest: created.digest,
    });
  });

  it('AC-1 a plan past its TTL is expired by the sweep, and refused', async () => {
    const created = await plan();
    clock.advance(5 * 60_000);

    await expect(run(created.id)).rejects.toMatchObject({
      code: 'PLAN_EXPIRED',
    });
    const other = await plan();
    clock.advance(5 * 60_000);

    expect(
      await createPlanStore({
        repository: repos.plans,
        cipher: createAesGcmTestCipher(),
        clock,
        ids: createIdGenerator({ clock }),
      }).sweep(),
    ).toBe(1);
    expect(await repos.plans.get(other.id)).toMatchObject({
      state: 'expired',
      payload: null,
    });
    expect(executed).toBe(0);
  });

  it('AC-1 a row edited in SQL behind the executor is refused (risk lowered)', async () => {
    const created = await plan();
    await handle.db
      .updateTable('plans')
      .set({ risk: 'low' })
      .where('id', '=', created.id)
      .execute();

    await expect(run(created.id)).rejects.toMatchObject({ code: 'PLAN_STALE' });

    expect(executed).toBe(0);
  });

  it('AC-1 a payload copied from another plan row in SQL is refused', async () => {
    const first = await plan();
    const second = await plan();
    const donor = await repos.plans.get(second.id);
    await handle.db
      .updateTable('plans')
      .set({ payload: donor?.payload ?? null })
      .where('id', '=', first.id)
      .execute();

    await expect(run(first.id)).rejects.toBeInstanceOf(AppError);

    expect(executed).toBe(0);
  });

  it('AC-1 a key can be used once per principal across the SQL table', async () => {
    const first = await plan();
    const second = await plan();
    const used = key();
    await executor.execute(
      {
        planId: first.id,
        consents: ['typed'],
        idempotencyKey: used,
        confirmation: 'purge orders',
      },
      ctx,
    );

    await expect(
      executor.execute(
        {
          planId: second.id,
          consents: ['typed'],
          idempotencyKey: used,
          confirmation: 'purge orders',
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 409 });

    expect(executed).toBe(1);
    expect(await repos.idempotency.has('user-1', used)).toBe(true);
  });

  it('AC-1 two executes of one plan at once run it once', async () => {
    const created = await plan();

    const results = await Promise.allSettled([
      run(created.id),
      run(created.id),
      run(created.id),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(executed).toBe(1);
  });

  it('AC-1 a wrong typed phrase is refused before anything runs', async () => {
    const created = await plan();

    await expect(
      run(created.id, { confirmation: 'purge orderz' }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_MISMATCH' });

    expect(executed).toBe(0);
  });

  describe('audit chain and receipts over SQL', () => {
    const runOnce = async (): Promise<void> => {
      await run((await plan()).id);
    };

    it('AC-1 audit: an executed plan leaves linked attempt and outcome rows and a receipt, and the chain verifies', async () => {
      await runOnce();

      const rows = await repos.audit.window(0, 10);
      expect(rows.map((row) => [row.seq, row.phase, row.attemptSeq])).toEqual([
        [1, 'attempt', null],
        [2, 'outcome', 1],
      ]);
      expect(rows[1]?.receiptId).toMatch(/\S/);
      expect(
        await receipts.get((rows[1]?.receiptId ?? '') as never),
      ).toMatchObject({ actionId: 'queues.purge', auditSeq: 1, result: 'ok' });
      expect(await chain.verify()).toMatchObject({ ok: true, rows: 2 });
      expect(JSON.stringify(rows)).not.toContain('secret body');
    });

    it('AC-1 audit: the database refuses to edit or delete an audit row', async () => {
      await runOnce();

      await expect(
        handle.db
          .updateTable('audit_events')
          .set({ risk: 'none' })
          .where('seq', '=', 1)
          .execute(),
      ).rejects.toThrow(/append-only/);
      await expect(
        handle.db.deleteFrom('audit_events').where('seq', '=', 2).execute(),
      ).rejects.toThrow(/append-only/);

      expect(await chain.verify()).toMatchObject({ ok: true });
    });

    it('AC-1 audit: a schema owner who drops the triggers and edits a row is found by verify, at that seq', async () => {
      await runOnce();
      await runOnce();
      await executeRawStatement(handle, 'DROP TRIGGER audit_events_no_update');
      await executeRawStatement(
        handle,
        "UPDATE audit_events SET actor_id = 'someone-else' WHERE seq = 3",
      );

      expect(await chain.verify()).toMatchObject({
        ok: false,
        brokenSeq: 3,
        reason: 'hash-mismatch',
      });
    });

    it('AC-1 audit: a deleted audit row (triggers dropped) is reported at the missing seq', async () => {
      await runOnce();
      await runOnce();
      await executeRawStatement(handle, 'DROP TRIGGER audit_events_no_delete');
      await executeRawStatement(
        handle,
        'DELETE FROM audit_events WHERE seq = 2',
      );

      expect(await chain.verify()).toMatchObject({
        ok: false,
        brokenSeq: 2,
        reason: 'seq-gap',
      });
    });

    it('AC-1 audit: a truncated tail is reported against the anchored head', async () => {
      await runOnce();
      await runOnce();
      const anchor = await chain.head();
      await executeRawStatement(handle, 'DROP TRIGGER audit_events_no_delete');
      await executeRawStatement(
        handle,
        'DELETE FROM audit_events WHERE seq > 2',
      );

      expect(await chain.verify()).toMatchObject({ ok: true, rows: 2 });
      expect(await chain.verify({ expect: anchor })).toMatchObject({
        ok: false,
        brokenSeq: 3,
        reason: 'truncated',
      });
    });

    it('AC-1 audit: two engines on one database never fork the chain', async () => {
      const other = createAuditChain({ repository: repos.audit });
      const entry = (correlationId: string) => ({
        at: clock.now(),
        correlationId,
        actionId: 'queues.purge' as never,
        kind: 'command' as const,
        principal: createTestPrincipal(),
        target: {},
        env: 'prod' as const,
        risk: 'low' as const,
      });

      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          (i % 2 === 0 ? chain : other).attempt(entry(`c-${String(i)}`)),
        ),
      );

      expect((await repos.audit.window(0, 100)).map((row) => row.seq)).toEqual(
        Array.from({ length: 20 }, (_, i) => i + 1),
      );
      expect(await chain.verify()).toMatchObject({ ok: true, rows: 20 });
    });

    it('AC-1 audit: when the audit table is unwritable the plan is denied and execute() is not called', async () => {
      const created = await plan();
      await executeRawStatement(handle, 'DROP TABLE audit_events');

      await expect(run(created.id)).rejects.toMatchObject({ code: 'INTERNAL' });

      expect(executed).toBe(0);
    });

    it('AC-2 guardrail: an unarmed prod connection is locked, on the SQL-backed executor too', async () => {
      const locked = createTestContext({ env: 'prod' });
      const other = createTestContext({
        env: 'prod',
        principal: createTestPrincipal({ id: 'user-2' }),
      });

      await expect(
        executor.plan(purge, { name: 'orders' }, other),
      ).rejects.toMatchObject({ code: 'GATE_BLOCKED' });

      expect(
        (await executor.plan(purge, { name: 'orders' }, locked)).state,
      ).toBe('open');
      expect(executed).toBe(0);
    });
  });
});
