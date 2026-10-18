// The ActionExecutor (kernel) running over the SQL plan and idempotency repositories (persistence):
// the two halves of M0-29 agree on what a row holds, and a row edited behind the executor's back
// is caught. The kernel cannot import an adapter and an adapter cannot import the kernel, so the
// test that joins them lives in a type:test project.
import { defineAction } from '@app/contracts';
import {
  allowUiPrincipals,
  AppError,
  createActionExecutor,
  createAesGcmTestCipher,
  createIdGenerator,
  createManualClock,
  createMemoryAuditSink,
  createPlanStore,
  createRecordingWrites,
  createTestContext,
  implementAction,
  type ActionExecutor,
} from '@app/kernel';
import {
  createMigrationRunner,
  createRepositories,
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
  target: (input) => ({ name: input.name }),
  since: '1.0',
});

describe('executor over the SQL plan repositories', () => {
  let handle: PersistenceHandle;
  let repos: Repositories;
  let executor: ActionExecutor;
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
    executor = createActionExecutor({
      plans: createPlanStore({
        repository: repos.plans,
        cipher: createAesGcmTestCipher(),
        clock,
        ids,
      }),
      idempotency: repos.idempotency,
      authorizer: allowUiPrincipals(),
      audit: createMemoryAuditSink(),
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

    expect(await run(created.id)).toEqual({
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
});
