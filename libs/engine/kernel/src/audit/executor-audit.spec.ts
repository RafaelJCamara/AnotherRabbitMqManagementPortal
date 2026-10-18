// The executor over the real audit chain, receipt store and guardrails (memory repositories).
import type { AuditRow } from '@app/ports';
import { describe, expect, it } from 'vitest';

import { createActionExecutor } from '../actions/executor.ts';
import type { GuardrailPolicy } from '../actions/hooks.ts';
import { implementAction } from '../actions/implement-action.ts';
import {
  createProbe,
  peekImpl,
  peekDef,
  pingDef,
  pingImpl,
  purgeDef,
  purgeImpl,
  statDef,
  statImpl,
  type Probe,
} from '../actions/test-actions.ts';
import {
  createTestContext,
  createTestPrincipal,
  createWiredExecutor,
  type WiredExecutor,
} from '../actions/testing.ts';
import { createManualClock } from '../clock/clock.ts';
import { createGuardrails } from '../guardrails/policy.ts';
import { AppError } from '../problem/problem.ts';

const input = { connectionId: 'c1', name: 'orders' };
let n = 0;
const key = (): string => {
  n += 1;
  return `audit-key-${String(n).padStart(6, '0')}`;
};
const person = createTestPrincipal();
const ctx = (over: Parameters<typeof createTestContext>[0] = {}) =>
  createTestContext({ env: 'dev', ...over });

interface Setup extends WiredExecutor {
  probe: Probe;
}

function setup(parts: Parameters<typeof createWiredExecutor>[0] = {}): Setup {
  const probe = createProbe();
  const w = createWiredExecutor(parts);
  w.executor.register(
    purgeImpl(probe),
    peekImpl(probe),
    pingImpl(probe),
    statImpl(probe),
  );
  return { ...w, probe };
}

async function plan(s: Setup, over = {}) {
  return s.executor.plan(purgeDef, input, ctx(over));
}

const execute = (s: Setup, planId: string, over = {}) =>
  s.executor.execute(
    {
      planId: planId as never,
      consents: [],
      idempotencyKey: key(),
    },
    ctx(over),
  );

async function code(work: Promise<unknown>): Promise<string> {
  const error = await work.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppError);
  return (error as AppError).code;
}

describe('audit: the attempt row is written before the action and gates it', () => {
  it('AC-1 audit: when the attempt write fails the plan is denied and execute() is not called', async () => {
    const s = setup();
    const p = await plan(s);
    s.auditRows.failAppends(true);

    expect(await code(execute(s, p.id))).toBe('INTERNAL');

    expect(s.probe.executed).toBe(0);
    expect(s.writeCalls).toEqual([]);
    expect(s.auditRows.rows).toHaveLength(0);
    // A denied run consumes the plan and the key: the outcome of a mutation is never guessed.
    expect((await s.plans.view(p.id))?.state).toBe('failed');
  });

  it('AC-1 audit: when the attempt write fails a direct command is denied and execute() is not called', async () => {
    const s = setup();
    s.auditRows.failAppends(true);

    expect(
      await code(s.executor.run(pingDef, {}, ctx({ idempotencyKey: key() }))),
    ).toBe('INTERNAL');

    expect(s.probe.executed).toBe(0);
    expect(s.writeCalls).toEqual([]);
  });

  it('AC-1 audit: when the attempt write fails a peek is denied and execute() is not called', async () => {
    const s = setup();
    const p = await s.executor.plan(peekDef, input, ctx());
    s.auditRows.failAppends(true);

    expect(await code(execute(s, p.id))).toBe('INTERNAL');

    expect(s.probe.executed).toBe(0);
  });

  it('AC-1 audit: the attempt row is in the chain before execute() starts', async () => {
    const w = createWiredExecutor();
    const seen: { rows: number; phases: string[] } = { rows: -1, phases: [] };
    w.executor.register(
      implementAction(purgeDef, {
        plan: () =>
          Promise.resolve({
            preview: {},
            gates: [],
            warnings: [],
            consentsRequired: [],
          }),
        revalidate: () => Promise.resolve('valid'),
        execute: () => {
          seen.rows = w.auditRows.rows.length;
          seen.phases = w.auditRows.rows.map((row) => row.phase);
          return Promise.resolve({ purged: 1 });
        },
      }),
    );
    const made = await w.executor.plan(purgeDef, input, ctx());

    await w.executor.execute(
      { planId: made.id, consents: [], idempotencyKey: key() },
      ctx(),
    );

    expect(seen).toEqual({ rows: 1, phases: ['attempt'] });
    expect(w.auditRows.rows).toHaveLength(2);
  });

  it('AC-1 audit: a successful run leaves an attempt and an outcome row, linked, with a receipt', async () => {
    const s = setup();
    const p = await plan(s);

    const outcome = await execute(s, p.id);

    const [attempt, closing] = s.auditRows.rows as [AuditRow, AuditRow];
    expect(attempt).toMatchObject({
      seq: 1,
      phase: 'attempt',
      actionId: 'queues.purge',
      planId: p.id,
      planDigest: p.digest,
      actorId: 'user-1',
      env: 'dev',
      risk: 'critical',
    });
    expect(closing).toMatchObject({
      seq: 2,
      phase: 'outcome',
      attemptSeq: 1,
      result: 'ok',
      code: null,
    });
    const receiptId = (outcome as { receiptId?: string }).receiptId;
    expect(closing.receiptId).toBe(receiptId);
    expect(await s.receipts.get(receiptId as never)).toMatchObject({
      actionId: 'queues.purge',
      planId: p.id,
      planDigest: p.digest,
      principalId: 'user-1',
      result: 'ok',
      auditSeq: 1,
      detail: {},
    });
    expect(await s.chain.verify()).toMatchObject({ ok: true, rows: 2 });
  });

  it('AC-1 audit: a failed run leaves an outcome row with the error code and an error receipt', async () => {
    const s = setup();
    const p = await plan(s);
    s.probe.failWith = new AppError('BROKER_UNREACHABLE', { detail: 'down' });

    expect(await code(execute(s, p.id))).toBe('BROKER_UNREACHABLE');

    expect(s.auditRows.rows[1]).toMatchObject({
      phase: 'outcome',
      result: 'error',
      code: 'BROKER_UNREACHABLE',
    });
    const [stored] = [...s.receiptRows.rows.values()];
    expect(stored).toMatchObject({
      result: 'error',
      code: 'BROKER_UNREACHABLE',
    });
  });

  it('AC-1 audit: the approvers of a plan are recorded in its rows', async () => {
    const real = createGuardrails({ clock: createManualClock(1) }).policy;
    const approving: GuardrailPolicy = {
      decide: async (decided) => ({
        ...(await real.decide(decided)),
        planning: 'required',
        approvalsRequired: 1,
      }),
    };
    const s = setup({
      executor: {
        guardrails: approving,
        authorizer: { authorize: () => Promise.resolve({ allowed: true }) },
      },
    });
    // A dev connection: the real lock stays out of the way; the wrapper adds one approval.
    const p = await plan(s);
    await s.executor.approve(
      p.id,
      'approve',
      ctx({
        principal: createTestPrincipal({ id: 'approver-1', kind: 'team-user' }),
      }),
    );

    await execute(s, p.id);

    expect(s.auditRows.rows[0]?.approvedByJson).toBe('["approver-1"]');
  });

  it('AC-1 audit: a query writes no audit row and no receipt', async () => {
    const s = setup();

    await s.executor.run(statDef, { name: 'q' }, ctx());

    expect(s.auditRows.rows).toHaveLength(0);
    expect(s.receiptRows.rows.size).toBe(0);
  });

  it('AC-1 audit: an audit row after real runs that is edited is found by verify', async () => {
    const s = setup();
    for (let i = 0; i < 3; i += 1) await execute(s, (await plan(s)).id);
    const target = s.auditRows.rows.at(3);
    if (target === undefined) throw new Error('expected at least four rows');
    s.auditRows.rows[3] = { ...target, actorId: 'someone-else' };

    expect(await s.chain.verify()).toMatchObject({
      ok: false,
      brokenSeq: 4,
      reason: 'hash-mismatch',
    });
  });
});

describe('audit: nothing is lost silently (I-13) and nothing secret is kept (I-10)', () => {
  it('AC-1 audit: a failed outcome write is flagged on the result, queued, and written with the next row', async () => {
    const s = setup();
    const first = await plan(s);
    const failing = s.auditRows.append.bind(s.auditRows);
    let calls = 0;
    s.auditRows.append = (row) => {
      calls += 1;
      // The attempt (call 1) is written; the outcome (call 2) fails.
      return calls === 2
        ? Promise.reject(new Error('audit store is down'))
        : failing(row);
    };

    const outcome = await execute(s, first.id);

    expect(outcome).toMatchObject({ kind: 'output', auditOutcomeFailed: true });
    expect(s.probe.executed).toBe(1);
    expect(s.chain.stats().pending).toBe(1);
    await execute(s, (await plan(s)).id);
    expect(s.chain.stats().pending).toBe(0);
    expect(s.auditRows.rows.map((row) => row.phase)).toEqual([
      'attempt',
      'outcome',
      'attempt',
      'outcome',
    ]);
    expect(await s.chain.verify()).toMatchObject({ ok: true, rows: 4 });
  });

  it('AC-1 audit: a receipt that cannot be stored is flagged and the audit outcome row says so', async () => {
    const s = setup();
    const p = await plan(s);
    s.receiptRows.failInserts(true);

    const outcome = await execute(s, p.id);

    expect(outcome).toMatchObject({ kind: 'output', receiptFailed: true });
    expect(outcome).not.toHaveProperty('receiptId');
    expect(s.auditRows.rows[1]).toMatchObject({
      receiptId: null,
      detailJson: '{"receiptFailed":true}',
    });
  });

  it('AC-1 audit: neither the input nor the sensitive payload reaches an audit row or a receipt (I-10)', async () => {
    const s = setup();
    const p = await plan(s);
    await execute(s, p.id);

    const stored = JSON.stringify([
      s.auditRows.rows,
      [...s.receiptRows.rows.values()],
    ]);

    expect(stored).not.toContain('secret body');
    expect(stored).not.toContain('"input"');
    expect(stored).not.toContain('sensitivePayload');
  });

  it('AC-1 audit: the executor will not start without an audit sink, guardrails or receipts', () => {
    const w = createWiredExecutor();
    const base = {
      plans: w.plans,
      idempotency: w.idempotencyRepository,
      authorizer: {
        authorize: () => Promise.resolve({ allowed: true as const }),
      },
      audit: w.chain,
      guardrails: w.guardrails.policy,
      receipts: w.receipts,
      writes: { mgmt: {}, connections: {} } as never,
      clock: w.clock,
      ids: { correlationId: () => 'x' } as never,
    };

    for (const missing of ['audit', 'guardrails', 'receipts'] as const) {
      expect(() =>
        createActionExecutor({ ...base, [missing]: undefined }),
      ).toThrow(new RegExp(`${missing} is required`));
    }
  });

  it('AC-1 audit: the person is the actor even when the chain is read back', async () => {
    const s = setup();
    await execute(s, (await plan(s)).id);

    expect(JSON.parse(s.auditRows.rows[0]?.actorJson ?? '{}')).toMatchObject({
      id: person.id,
      kind: 'desktop-user',
      surface: 'ui',
      unattended: false,
    });
  });
});
