import type { ErrorCode, PlanId } from '@app/contracts';
import type { PlanRecord, PlanRepository } from '@app/ports';
import { describe, expect, it } from 'vitest';

import { AppError, toProblem } from '../problem/problem.ts';
import {
  allowUiPrincipals,
  createRoleAuthorizer,
  denyAllAuthorizer,
} from './authorizer.ts';
import { planRequiredError } from './executor.ts';
import type { GuardrailPolicy } from './hooks.ts';
import { implementAction } from './implement-action.ts';
import {
  createProbe,
  liarImpl,
  pingDef,
  pingImpl,
  purgeDef,
  purgeImpl,
  renameDef,
  renameImpl,
  startJobDef,
  startJobImpl,
  statDef,
  statImpl,
  type Probe,
} from './test-actions.ts';
import {
  createMemoryPlanRepository,
  createTestContext,
  createTestExecutor,
  createTestPrincipal,
  type TestExecutor,
  type TestExecutorParts,
} from './testing.ts';
import type { ExecutorContext, PlanView } from './types.ts';

const input = { connectionId: 'c1', name: 'orders' };
let keyCounter = 0;
const freshKey = (): string => {
  keyCounter += 1;
  return `idem-key-${String(keyCounter).padStart(6, '0')}`;
};

interface Setup extends TestExecutor {
  probe: Probe;
}

function setup(parts: TestExecutorParts = {}, consents: string[] = []): Setup {
  const probe = createProbe();
  const t = createTestExecutor(parts);
  t.executor.register(
    purgeImpl(probe),
    renameImpl(probe, consents),
    pingImpl(probe),
    statImpl(probe),
    startJobImpl(probe),
    liarImpl(),
  );
  return { ...t, probe };
}

async function refusal(work: Promise<unknown>): Promise<AppError> {
  const error = await work.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

async function expectRefused(
  work: Promise<unknown>,
  code: ErrorCode,
): Promise<AppError> {
  const error = await refusal(work);
  expect(error.code).toBe(code);
  return error;
}

async function makePlan(
  s: Setup,
  ctx: ExecutorContext = createTestContext(),
): Promise<PlanView> {
  return s.executor.plan(purgeDef, input, ctx);
}

/** Opens the prod lock for the test person on the connection the specs use. */
function arm(s: Setup): void {
  s.arming.arm(createTestPrincipal(), input.connectionId);
}

const runPlan = (
  s: Setup,
  plan: PlanView,
  extra: {
    consents?: string[];
    confirmation?: string;
    idempotencyKey?: string;
    expectedDigest?: string;
  } = {},
  ctx: ExecutorContext = createTestContext(),
) =>
  s.executor.execute(
    {
      planId: plan.id,
      consents: extra.consents ?? [],
      idempotencyKey: extra.idempotencyKey ?? freshKey(),
      ...(extra.confirmation === undefined
        ? {}
        : { confirmation: extra.confirmation }),
      ...(extra.expectedDigest === undefined
        ? {}
        : { expectedDigest: extra.expectedDigest }),
    },
    ctx,
  );

describe('executor AC-1 refusals never reach execute()', () => {
  it('AC-1 an unknown action is refused with NOT_FOUND', async () => {
    const s = setup();
    const unknown = { ...purgeDef, id: 'queues.unknown' } as typeof purgeDef;

    await expectRefused(
      s.executor.run(unknown, input, createTestContext()),
      'NOT_FOUND',
    );

    expect(s.probe.executed).toBe(0);
    expect(s.audit.attempts).toHaveLength(0);
  });

  it('AC-1 a forged definition with a registered id is refused, not trusted', async () => {
    const s = setup();
    // Same id, but claiming to be a harmless query: the registered definition must decide.
    const forged = {
      ...purgeDef,
      kind: 'query',
      planning: 'none',
      permission: 'meta.read',
    } as typeof purgeDef;

    await expectRefused(
      s.executor.run(forged, input, createTestContext()),
      'NOT_FOUND',
    );

    expect(s.probe.executed).toBe(0);
  });

  it('AC-1 only implementAction results can be registered', () => {
    const s = createTestExecutor();
    const literal = {
      def: statDef,
      execute: () => Promise.resolve({ depth: 1 }),
    };

    expect(() => {
      s.executor.register(literal);
    }).toThrow(/implementAction/);
    expect(() => {
      s.executor.register({ ...statImpl(createProbe()) });
    }).toThrow(/implementAction/);
  });

  it('AC-1 a repeated action id cannot be registered twice', () => {
    const s = setup();

    expect(() => {
      s.executor.register(statImpl(createProbe()));
    }).toThrow(/already registered/);
  });

  it('AC-1 a missing idempotencyKey is refused when executing a plan', async () => {
    const s = setup();
    const plan = await makePlan(s);

    const missing = await expectRefused(
      s.executor.execute(
        { planId: plan.id, consents: [] } as never,
        createTestContext(),
      ),
      'VALIDATION_FAILED',
    );

    expect(missing.detail).toMatch(/idempotencyKey/);
    expect(s.probe.executed).toBe(0);
    expect((await s.plans.view(plan.id))?.state).toBe('open');
  });

  it('AC-1 a malformed idempotencyKey is refused', async () => {
    const s = setup();
    const plan = await makePlan(s);

    for (const key of ['', 'short', 'has spaces in it', 'x'.repeat(129)]) {
      await expectRefused(
        runPlan(s, plan, { idempotencyKey: key }),
        'VALIDATION_FAILED',
      );
    }

    expect(s.probe.executed).toBe(0);
  });

  it('AC-1 a missing idempotencyKey is refused on a direct call of a mutating action', async () => {
    const s = setup();

    const error = await expectRefused(
      s.executor.run(pingDef, {}, createTestContext()),
      'VALIDATION_FAILED',
    );

    expect(error.detail).toMatch(/idempotencyKey/);
    expect(s.probe.executed).toBe(0);
    expect(s.audit.attempts).toHaveLength(0);
  });

  it('AC-1 an idempotencyKey can be used once; a retry with it is refused with 409', async () => {
    const s = setup();
    const key = freshKey();
    await s.executor.run(
      pingDef,
      {},
      createTestContext({ idempotencyKey: key }),
    );

    const again = await expectRefused(
      s.executor.run(pingDef, {}, createTestContext({ idempotencyKey: key })),
      'VALIDATION_FAILED',
    );

    expect(toProblem(again).status).toBe(409);
    expect(s.probe.executed).toBe(1);
  });

  it('AC-1 a key is scoped to its principal: another principal cannot burn it', async () => {
    const s = setup();
    const key = freshKey();
    await s.executor.run(
      pingDef,
      {},
      createTestContext({
        principal: createTestPrincipal({ id: 'user-2' }),
        idempotencyKey: key,
      }),
    );

    await s.executor.run(
      pingDef,
      {},
      createTestContext({ idempotencyKey: key }),
    );

    expect(s.probe.executed).toBe(2);
  });

  it('AC-1 an expired plan is refused with PLAN_EXPIRED and its payload is purged', async () => {
    const s = setup();
    const plan = await makePlan(s);
    s.clock.advance(5 * 60_000);

    await expectRefused(runPlan(s, plan), 'PLAN_EXPIRED');

    expect(s.probe.executed).toBe(0);
    expect((await s.planRepository.get(plan.id))?.payload).toBeNull();
    expect((await s.plans.view(plan.id))?.state).toBe('expired');
  });

  it('AC-1 a plan is still good one millisecond before it expires', async () => {
    const s = setup();
    const plan = await makePlan(s);
    s.clock.advance(5 * 60_000 - 1);

    const outcome = await runPlan(s, plan);

    expect(outcome.kind).toBe('output');
    expect(s.probe.executed).toBe(1);
  });

  it('AC-1 an approval by the requester is refused with FORBIDDEN_RBAC', async () => {
    const needsApproval: GuardrailPolicy = {
      decide: ({ risk }) =>
        Promise.resolve({
          risk,
          planning: 'required',
          approvalsRequired: 1,
          forbidLetBrokerHandle: false,
          extraConsents: [],
        }),
    };
    const s = setup({ executor: { guardrails: needsApproval } });
    const plan = await makePlan(s);

    await expectRefused(
      s.executor.approve(plan.id, 'approve', createTestContext()),
      'FORBIDDEN_RBAC',
    );

    expect((await s.plans.view(plan.id))?.approvals.granted).toHaveLength(0);
    expect(s.probe.executed).toBe(0);
  });
});

describe('executor AC-2 planning, revalidation and plan purity', () => {
  it('AC-2 a planning:required action called directly returns 428 PLAN_REQUIRED with the auto-created plan', async () => {
    const s = setup();

    const outcome = await s.executor.run(purgeDef, input, createTestContext());

    if (outcome.kind !== 'planRequired') throw new Error('expected a plan');
    const problem = toProblem(planRequiredError(outcome.plan));
    expect(problem).toMatchObject({ code: 'PLAN_REQUIRED', status: 428 });
    expect(problem.detail).toContain(outcome.plan.id);
    expect(outcome.plan).toMatchObject({
      actionId: 'queues.purge',
      state: 'open',
      risk: 'critical',
      env: 'dev',
    });
    expect(await s.plans.view(outcome.plan.id)).toEqual(outcome.plan);
    expect(s.probe.executed).toBe(0);
    expect(s.audit.attempts).toHaveLength(0);
  });

  it('AC-2 revalidate drift is refused with 409 PLAN_STALE and execute() is not called', async () => {
    const s = setup();
    const plan = await makePlan(s);
    s.probe.drift = 'the queue became a quorum queue';

    const stale = await expectRefused(runPlan(s, plan), 'PLAN_STALE');

    expect(toProblem(stale).status).toBe(409);
    expect(stale.detail).toBe('the queue became a quorum queue');
    expect(s.probe.executed).toBe(0);
    expect(s.audit.attempts).toHaveLength(0);
    // Nothing was consumed: once the drift is gone the same plan runs.
    s.probe.drift = undefined;
    expect((await runPlan(s, plan)).kind).toBe('output');
  });

  it('AC-2 a changed BrokerProfile fingerprint is refused with PLAN_STALE', async () => {
    let fingerprint = 'fp-1';
    const s = setup({
      executor: {
        profiles: {
          resolve: () => Promise.resolve({ fingerprint, gates: [] }),
        },
      },
    });
    const plan = await makePlan(s);
    expect(plan.profileFingerprint).toBe('fp-1');
    fingerprint = 'fp-2';

    await expectRefused(runPlan(s, plan), 'PLAN_STALE');

    expect(s.probe.executed).toBe(0);
  });

  it('AC-2 plan() runs without any write port in its context', async () => {
    const s = setup();

    await makePlan(s);

    expect(s.probe.lastPlanContext).toBeDefined();
    expect('writes' in (s.probe.lastPlanContext ?? {})).toBe(false);
  });

  it('AC-2 only execute() receives the write ports', async () => {
    const s = setup();
    const plan = await makePlan(s);

    await runPlan(s, plan);

    expect(s.probe.lastExecuteContext?.writes).toBeDefined();
    expect(s.writeCalls).toEqual(['mgmt.send']);
  });
});

describe('executor happy path and the audit trail', () => {
  it('plans, then executes once, writes attempt and outcome, and purges the payload', async () => {
    const s = setup();
    const plan = await makePlan(s);

    const outcome = await runPlan(s, plan, { expectedDigest: plan.digest });

    expect(outcome).toEqual({
      kind: 'output',
      output: { purged: 12 },
      receiptId: 'rcpt-1',
    });
    expect(s.probe.executed).toBe(1);
    expect(s.audit.attempts).toHaveLength(1);
    expect(s.audit.outcomes).toHaveLength(1);
    expect(s.audit.attempts[0]).toMatchObject({
      actionId: 'queues.purge',
      planId: plan.id,
      planDigest: plan.digest,
      env: 'dev',
      risk: 'critical',
      principal: { id: 'user-1', surface: 'ui' },
      target: { kind: 'queue', name: 'orders' },
    });
    expect(s.audit.outcomes[0]).toMatchObject({ result: 'ok' });
    const row = await s.planRepository.get(plan.id);
    expect(row).toMatchObject({ state: 'executed', payload: null });
    expect(row?.digest).toBe(plan.digest);
  });

  it('never puts the input or the sensitive payload in an audit row', async () => {
    const s = setup();
    const plan = await makePlan(s);

    await runPlan(s, plan);

    const text = JSON.stringify([s.audit.attempts, s.audit.outcomes]);
    expect(text).not.toContain('secret body');
    expect(text).not.toContain('"input"');
  });

  it('a plan can be executed only once, even with a new key', async () => {
    const s = setup();
    const plan = await makePlan(s);
    await runPlan(s, plan);

    const second = await expectRefused(runPlan(s, plan), 'PLAN_STALE');

    expect(second.detail).toMatch(/already used/);
    expect(s.probe.executed).toBe(1);
  });

  it('two concurrent executes of one plan run execute() exactly once', async () => {
    const s = setup();
    const plan = await makePlan(s);

    const results = await Promise.allSettled([
      runPlan(s, plan),
      runPlan(s, plan),
      runPlan(s, plan),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(s.probe.executed).toBe(1);
  });

  it('a failing execute() marks the plan failed, audits the error and maps the code', async () => {
    const s = setup();
    const plan = await makePlan(s);
    s.probe.failWith = new AppError('BROKER_UNREACHABLE', { detail: 'down' });

    await expectRefused(runPlan(s, plan), 'BROKER_UNREACHABLE');

    expect(s.audit.outcomes[0]).toMatchObject({
      result: 'error',
      code: 'BROKER_UNREACHABLE',
    });
    expect((await s.plans.view(plan.id))?.state).toBe('failed');
    // The outcome of a failed mutation is unknown, so the plan is not offered again.
    await expectRefused(runPlan(s, plan), 'PLAN_STALE');
    expect(s.probe.executed).toBe(1);
  });

  it('an unexpected error from execute() becomes INTERNAL without its message', async () => {
    const s = setup();
    const plan = await makePlan(s);
    s.probe.failWith = new Error('password=hunter2 at /srv/secret');

    const error = await expectRefused(runPlan(s, plan), 'INTERNAL');

    expect(JSON.stringify(toProblem(error))).not.toContain('hunter2');
  });

  it('a result that breaks the output contract is INTERNAL', async () => {
    const s = setup();
    const liar = s.executor.registered().find((def) => def.id === 'ops.liar');
    if (liar === undefined) throw new Error('missing');

    const error = await expectRefused(
      s.executor.run(liar, {}, createTestContext()),
      'INTERNAL',
    );

    expect(error.detail).toMatch(/contract/);
  });
  it('a job action returns the job id', async () => {
    const s = setup();

    const outcome = await s.executor.run(
      startJobDef,
      { name: 'a' },
      createTestContext({ idempotencyKey: freshKey() }),
    );

    expect(outcome).toEqual({ kind: 'job', jobId: 'job-1' });
  });

  it('a query runs directly with no key, no plan and no audit row', async () => {
    const s = setup();

    const outcome = await s.executor.run(
      statDef,
      { name: 'orders' },
      createTestContext(),
    );

    expect(outcome).toEqual({ kind: 'output', output: { depth: 3 } });
    expect(s.audit.attempts).toHaveLength(0);
  });

  it('invalid input is VALIDATION_FAILED and names the field, not the value', async () => {
    const s = setup();

    const error = await expectRefused(
      s.executor.run(
        statDef,
        { name: 5, extra: 'topsecret' },
        createTestContext(),
      ),
      'VALIDATION_FAILED',
    );

    expect(error.detail).toContain('name');
    expect(error.detail).not.toContain('topsecret');
    expect(s.probe.executed).toBe(0);
  });

  it('optional planning: a clean direct call runs without a plan', async () => {
    const s = setup();

    const outcome = await s.executor.run(
      renameDef,
      { name: 'q' },
      createTestContext({ idempotencyKey: freshKey() }),
    );

    expect(outcome.kind).toBe('output');
    expect(s.probe.planned).toBe(1);
  });

  it('optional planning: a direct call that needs a consent gets a plan instead', async () => {
    const s = setup({}, ['rename-consent']);

    const outcome = await s.executor.run(
      renameDef,
      { name: 'q' },
      createTestContext({ idempotencyKey: freshKey() }),
    );

    if (outcome.kind !== 'planRequired') throw new Error('expected a plan');
    expect(outcome.plan.consentsRequired).toEqual(['rename-consent']);
    expect(s.probe.executed).toBe(0);
  });
});

describe('executor audit-attempt failure denies the action', () => {
  it('a failing attempt write denies a planned execute; execute() is not called', async () => {
    const s = setup();
    const plan = await makePlan(s);
    s.audit.failAttempts(true);

    const error = await expectRefused(runPlan(s, plan), 'INTERNAL');

    expect(error.detail).toMatch(/audit attempt/);
    expect(s.probe.executed).toBe(0);
    expect(s.writeCalls).toEqual([]);
    expect(s.audit.outcomes).toHaveLength(0);
    expect((await s.plans.view(plan.id))?.state).toBe('failed');
  });

  it('a failing attempt write denies a direct call', async () => {
    const s = setup();
    s.audit.failAttempts(true);

    await expectRefused(
      s.executor.run(
        pingDef,
        {},
        createTestContext({ idempotencyKey: freshKey() }),
      ),
      'INTERNAL',
    );

    expect(s.probe.executed).toBe(0);
  });

  it('a failing outcome write is reported on the result, not undone', async () => {
    const s = setup();
    const plan = await makePlan(s);
    s.audit.failOutcomes(true);

    const outcome = await runPlan(s, plan);

    expect(outcome).toMatchObject({
      kind: 'output',
      auditOutcomeFailed: true,
    });
    expect(s.probe.executed).toBe(1);
  });
});

describe('executor consents, typed phrase and digest', () => {
  it('a missing consent is CONSENT_REQUIRED; giving it lets the plan run', async () => {
    const s = setup({}, ['rename-consent']);
    const plan = await s.executor.plan(
      renameDef,
      { name: 'q' },
      createTestContext(),
    );

    const missing = await expectRefused(
      s.executor.execute(
        { planId: plan.id, consents: [], idempotencyKey: freshKey() },
        createTestContext(),
      ),
      'CONSENT_REQUIRED',
    );
    expect(missing.detail).toContain('rename-consent');
    expect(s.probe.executed).toBe(0);

    await s.executor.execute(
      {
        planId: plan.id,
        consents: ['rename-consent'],
        idempotencyKey: freshKey(),
      },
      createTestContext(),
    );
    expect(s.probe.executed).toBe(1);
  });

  it('prod needs the typed phrase, checked by the engine: a wrong or missing phrase is CONFIRMATION_MISMATCH', async () => {
    const s = setup();
    arm(s);
    const ctx = createTestContext({ env: 'prod' });
    const plan = await makePlan(s, ctx);
    expect(plan.confirmationPhrase).toBe('purge orders');

    await expectRefused(runPlan(s, plan, {}, ctx), 'CONFIRMATION_MISMATCH');
    await expectRefused(
      runPlan(s, plan, { confirmation: 'purge order' }, ctx),
      'CONFIRMATION_MISMATCH',
    );
    await expectRefused(
      runPlan(s, plan, { confirmation: 'PURGE ORDERS' }, ctx),
      'CONFIRMATION_MISMATCH',
    );
    expect(s.probe.executed).toBe(0);

    const outcome = await runPlan(
      s,
      plan,
      { confirmation: '  purge orders ' },
      ctx,
    );
    expect(outcome.kind).toBe('output');
  });

  it('an unset environment class means prod', async () => {
    const s = setup();
    arm(s);

    const plan = await s.executor.plan(purgeDef, input, {
      principal: createTestPrincipal(),
      mode: 'desktop',
    });

    expect(plan.env).toBe('prod');
    expect(plan.confirmationPhrase).toBe('purge orders');
  });

  it('an unknown environment class means prod, too', async () => {
    const s = setup();
    arm(s);

    const plan = await s.executor.plan(
      purgeDef,
      input,
      createTestContext({ env: 'banana' as never }),
    );

    expect(plan.env).toBe('prod');
  });

  it('a plan made in dev cannot be executed in prod', async () => {
    const s = setup();
    arm(s);
    const plan = await makePlan(s, createTestContext({ env: 'dev' }));

    await expectRefused(
      runPlan(s, plan, {}, createTestContext({ env: 'prod' })),
      'PLAN_STALE',
    );
    expect(s.probe.executed).toBe(0);
  });

  it('expectedDigest must be the plan digest the person reviewed', async () => {
    const s = setup();
    const plan = await makePlan(s);

    await expectRefused(
      runPlan(s, plan, { expectedDigest: 'f'.repeat(64) }),
      'PLAN_STALE',
    );
    expect(s.probe.executed).toBe(0);
  });

  it.each([
    ['risk', { risk: 'low' }],
    ['env', { env: 'dev' }],
    ['approvalsRequired', { approvalsRequired: 3 }],
    ['confirmationPhrase', { confirmationPhrase: null }],
    ['consentsRequired', { consentsRequired: ['x'] }],
    ['profileFingerprint', { profileFingerprint: 'fp-x' }],
    ['gatesJson', { gatesJson: '[]  ' }],
    ['warningsJson', { warningsJson: '[ ]' }],
    ['previewJson', { previewJson: '{"queue":"other"}' }],
    ['inputHash', { inputHash: 'f'.repeat(64) }],
  ] as const)(
    'a row edited in the database (%s) fails the digest seal and execute() is not called',
    async (_field, edits) => {
      const base = createMemoryPlanRepository();
      const tamper: { edit?: Partial<PlanRecord> } = {};
      const repository: PlanRepository = {
        ...base,
        get: async (id) => {
          const row = await base.get(id);
          return row !== undefined && tamper.edit !== undefined
            ? { ...row, ...tamper.edit }
            : row;
        },
      };
      const s = setup({ planRepository: repository });
      arm(s);
      const ctx = createTestContext({ env: 'prod' });
      const plan = await makePlan(s, ctx);
      tamper.edit = edits;

      await expectRefused(
        runPlan(s, plan, { confirmation: 'purge orders' }, ctx),
        'PLAN_STALE',
      );

      expect(s.probe.executed).toBe(0);
      expect(s.audit.attempts).toHaveLength(0);
    },
  );
  it('a payload that was replaced fails the seal, as does one bound to another plan', async () => {
    const s = setup();
    const first = await makePlan(s);
    const second = await makePlan(s);
    const firstRow = await s.planRepository.get(first.id);
    const secondRow = await s.planRepository.get(second.id);
    if (firstRow?.payload == null || secondRow?.payload == null) {
      throw new Error('missing');
    }
    // Swap in the other plan's valid ciphertext: AAD binds it to its own id.
    await s.planRepository.update(
      first.id,
      firstRow.version,
      { payload: secondRow.payload },
      s.clock.now(),
    );

    await expectRefused(runPlan(s, first), 'PLAN_STALE');

    const flipped = Uint8Array.from(secondRow.payload);
    flipped[flipped.length - 1] = (flipped.at(-1) ?? 0) ^ 1;
    const current = await s.planRepository.get(second.id);
    await s.planRepository.update(
      second.id,
      current?.version ?? 0,
      { payload: flipped },
      s.clock.now(),
    );
    await expectRefused(runPlan(s, second), 'PLAN_STALE');
    expect(s.probe.executed).toBe(0);
  });
});

describe('executor deny by default', () => {
  const cli = createTestPrincipal({
    kind: 'api-token',
    id: 'cli-1',
    surface: 'cli',
    roles: ['read-only'],
  });

  it('with no authorizer wired every request is FORBIDDEN_RBAC', async () => {
    const s = setup({ executor: { authorizer: denyAllAuthorizer } });

    await expectRefused(
      s.executor.run(statDef, { name: 'q' }, createTestContext()),
      'FORBIDDEN_RBAC',
    );

    expect(s.probe.executed).toBe(0);
  });

  it('a read-only token calling purge gets FORBIDDEN_RBAC, planning included (A-11)', async () => {
    const s = setup({
      executor: {
        authorizer: allowUiPrincipals(
          createRoleAuthorizer({ 'read-only': ['*.read'] }),
        ),
      },
    });
    const asCli = createTestContext({
      principal: cli,
      idempotencyKey: freshKey(),
    });

    const direct = await expectRefused(
      s.executor.run(purgeDef, input, asCli),
      'FORBIDDEN_RBAC',
    );
    await expectRefused(
      s.executor.plan(purgeDef, input, asCli),
      'FORBIDDEN_RBAC',
    );

    expect(direct.missingPermission).toBe('messages.purge');
    expect(s.probe.executed).toBe(0);
    // The same token may read.
    const read = await s.executor.run(statDef, { name: 'q' }, asCli);
    expect(read.kind).toBe('output');
  });
  it('allow-all does not extend to a delegate of the UI principal', async () => {
    const s = setup();
    const agent = createTestPrincipal({
      kind: 'mcp-client',
      id: 'agent-1',
      surface: 'mcp',
      unattended: true,
      onBehalfOf: createTestPrincipal(),
    });

    await expectRefused(
      s.executor.run(
        statDef,
        { name: 'q' },
        createTestContext({ principal: agent }),
      ),
      'FORBIDDEN_RBAC',
    );
  });

  it('a malformed principal is UNAUTHENTICATED', async () => {
    const s = setup();

    for (const principal of [
      undefined,
      null,
      {},
      createTestPrincipal({ kind: 'root' as never }),
      createTestPrincipal({ id: '' }),
    ]) {
      await expectRefused(
        s.executor.run(
          statDef,
          { name: 'q' },
          createTestContext({ principal: principal as never }),
        ),
        'UNAUTHENTICATED',
      );
    }
    expect(s.probe.executed).toBe(0);
  });

  it('an authorizer that answers anything but allowed:true is a refusal', async () => {
    const s = setup({
      executor: {
        authorizer: {
          authorize: () => Promise.resolve({ allowed: 'yes' } as never),
        },
      },
    });

    await expectRefused(
      s.executor.run(statDef, { name: 'q' }, createTestContext()),
      'FORBIDDEN_RBAC',
    );
  });

  it('permission is re-checked at execute: revoked since the plan was made', async () => {
    let granted = true;
    const s = setup({
      executor: {
        authorizer: {
          authorize: () =>
            Promise.resolve(
              granted
                ? { allowed: true }
                : { allowed: false, reason: 'revoked' },
            ),
        },
      },
    });
    const plan = await makePlan(s);
    granted = false;

    await expectRefused(runPlan(s, plan), 'FORBIDDEN_RBAC');

    expect(s.probe.executed).toBe(0);
  });

  it('an unattended principal only ever gets a plan for a mutation', async () => {
    const policyAllowsAll = {
      authorize: () => Promise.resolve({ allowed: true as const }),
    };
    const s = setup({ executor: { authorizer: policyAllowsAll } });
    const agent = createTestPrincipal({
      kind: 'mcp-client',
      id: 'agent-1',
      surface: 'mcp',
      unattended: true,
    });

    const outcome = await s.executor.run(
      pingDef,
      {},
      createTestContext({ principal: agent, idempotencyKey: freshKey() }),
    );

    expect(outcome.kind).toBe('planRequired');
    expect(s.probe.executed).toBe(0);
    if (outcome.kind !== 'planRequired') return;
    // ...and it cannot execute that plan itself.
    await expectRefused(
      runPlan(s, outcome.plan, {}, createTestContext({ principal: agent })),
      'FORBIDDEN_RBAC',
    );
    expect(s.probe.executed).toBe(0);
  });

  it('another principal cannot execute or read my plan', async () => {
    const s = setup({
      executor: {
        authorizer: createRoleAuthorizer({
          admin: ['*.*'],
          viewer: ['*.read'],
        }),
      },
    });
    const mine = createTestContext({
      principal: createTestPrincipal({ kind: 'team-user', roles: ['admin'] }),
    });
    const plan = await makePlan(s, mine);
    const other = createTestContext({
      principal: createTestPrincipal({
        id: 'user-2',
        kind: 'team-user',
        roles: ['viewer'],
      }),
    });

    await expectRefused(runPlan(s, plan, {}, other), 'FORBIDDEN_RBAC');
    await expectRefused(s.executor.getPlan(plan.id, other), 'FORBIDDEN_RBAC');

    expect(s.probe.executed).toBe(0);
    expect((await s.executor.getPlan(plan.id, mine)).id).toBe(plan.id);
  });

  it('a plan is bound to its requester even when the other principal may do everything', async () => {
    const s = setup({
      executor: {
        authorizer: { authorize: () => Promise.resolve({ allowed: true }) },
      },
    });
    const plan = await makePlan(s);
    const stranger = createTestContext({
      principal: createTestPrincipal({ id: 'user-2', kind: 'team-user' }),
    });

    const error = await expectRefused(
      runPlan(s, plan, {}, stranger),
      'FORBIDDEN_RBAC',
    );

    expect(error.detail).toMatch(/another principal/);
    expect(s.probe.executed).toBe(0);
    expect(s.audit.attempts).toHaveLength(0);
    expect((await s.plans.view(plan.id))?.state).toBe('open');
  });

  it('an unknown plan id is NOT_FOUND', async () => {
    const s = setup();

    await expectRefused(
      s.executor.execute(
        {
          planId: '01UNKNOWNPLANID0000000000' as PlanId,
          consents: [],
          idempotencyKey: freshKey(),
        },
        createTestContext(),
      ),
      'NOT_FOUND',
    );
  });

  it('the principal handed to an action is a frozen copy', async () => {
    const s = setup();
    const plan = await makePlan(s);
    const mine = createTestPrincipal({ roles: ['a'] });

    await runPlan(s, plan, {}, createTestContext({ principal: mine }));

    const seen = s.probe.lastExecuteContext?.principal;
    expect(seen).not.toBe(mine);
    expect(Object.isFrozen(seen)).toBe(true);
    expect(Object.isFrozen(seen?.roles)).toBe(true);
  });
});

describe('executor approvals', () => {
  const needsApproval: GuardrailPolicy = {
    decide: ({ risk }) =>
      Promise.resolve({
        risk,
        planning: 'required',
        approvalsRequired: 1,
        forbidLetBrokerHandle: false,
        extraConsents: [],
      }),
  };
  const everyoneMayDoAnything = {
    authorize: () => Promise.resolve({ allowed: true as const }),
  };
  const approver = createTestContext({
    principal: createTestPrincipal({
      kind: 'team-user',
      id: 'approver-1',
      display: 'Approver',
    }),
    mode: 'team',
  });

  function approvalSetup(): Setup {
    return setup({
      executor: {
        guardrails: needsApproval,
        authorizer: everyoneMayDoAnything,
      },
    });
  }

  it('a plan awaiting approval lives 24 hours; one approval from another principal lets it run', async () => {
    const s = approvalSetup();
    const plan = await makePlan(s);
    expect(plan.state).toBe('awaiting-approval');
    expect(plan.expiresAt - s.clock.now()).toBe(24 * 60 * 60_000);

    await expectRefused(runPlan(s, plan), 'APPROVAL_REQUIRED');
    s.clock.advance(60 * 60_000);
    const approved = await s.executor.approve(
      plan.id,
      'approve',
      approver,
      'ok',
    );

    expect(approved.state).toBe('approved');
    expect(approved.expiresAt - s.clock.now()).toBe(5 * 60_000);
    expect(approved.approvals.granted).toEqual([
      { by: 'approver-1', at: s.clock.now(), decision: 'approve' },
    ]);
    expect((await runPlan(s, approved)).kind).toBe('output');
    expect(s.probe.executed).toBe(1);
  });

  it('the requester cannot approve, and neither can an unattended principal', async () => {
    const s = approvalSetup();
    const plan = await makePlan(s);
    const agent = createTestContext({
      principal: createTestPrincipal({
        id: 'agent-9',
        kind: 'mcp-client',
        surface: 'mcp',
        unattended: true,
      }),
    });
    const actingForRequester = createTestContext({
      principal: createTestPrincipal({
        id: 'someone-else',
        kind: 'team-user',
        onBehalfOf: createTestPrincipal(),
      }),
    });

    await expectRefused(
      s.executor.approve(plan.id, 'approve', createTestContext()),
      'FORBIDDEN_RBAC',
    );
    await expectRefused(
      s.executor.approve(plan.id, 'approve', agent),
      'FORBIDDEN_RBAC',
    );
    await expectRefused(
      s.executor.approve(plan.id, 'approve', actingForRequester),
      'FORBIDDEN_RBAC',
    );
    await expectRefused(runPlan(s, plan), 'APPROVAL_REQUIRED');
    expect(s.probe.executed).toBe(0);
  });

  it('an approver needs the plans.approve permission and the action permission', async () => {
    const s = setup({
      executor: {
        guardrails: needsApproval,
        authorizer: createRoleAuthorizer({
          admin: ['*.*'],
          viewer: ['*.read'],
        }),
      },
    });
    const owner = createTestContext({
      principal: createTestPrincipal({ roles: ['admin'] }),
    });
    const plan = await makePlan(s, owner);
    const viewer = createTestContext({
      principal: createTestPrincipal({
        id: 'v',
        kind: 'team-user',
        roles: ['viewer'],
      }),
    });
    const admin2 = createTestContext({
      principal: createTestPrincipal({
        id: 'a2',
        kind: 'team-user',
        roles: ['admin'],
      }),
    });

    await expectRefused(
      s.executor.approve(plan.id, 'approve', viewer),
      'FORBIDDEN_RBAC',
    );
    expect((await s.executor.approve(plan.id, 'approve', admin2)).state).toBe(
      'approved',
    );
  });

  it('one rejection vetoes the plan and purges its payload', async () => {
    const s = approvalSetup();
    const plan = await makePlan(s);

    const rejected = await s.executor.approve(plan.id, 'reject', approver);

    expect(rejected.state).toBe('rejected');
    expect((await s.planRepository.get(plan.id))?.payload).toBeNull();
    await expectRefused(runPlan(s, plan), 'APPROVAL_REQUIRED');
    await expectRefused(
      s.executor.approve(
        plan.id,
        'approve',
        createTestContext({
          principal: createTestPrincipal({
            id: 'approver-2',
            kind: 'team-user',
          }),
        }),
      ),
      'APPROVAL_REQUIRED',
    );
    expect(s.probe.executed).toBe(0);
  });

  it('the same approver cannot approve twice to reach a higher count', async () => {
    const s = setup({
      executor: {
        guardrails: {
          decide: ({ risk }) =>
            Promise.resolve({
              risk,
              planning: 'required',
              approvalsRequired: 2,
              forbidLetBrokerHandle: false,
              extraConsents: [],
            }),
        },
        authorizer: everyoneMayDoAnything,
      },
    });
    const plan = await makePlan(s);

    const first = await s.executor.approve(plan.id, 'approve', approver);
    expect(first.state).toBe('awaiting-approval');
    const error = await expectRefused(
      s.executor.approve(plan.id, 'approve', approver),
      'VALIDATION_FAILED',
    );

    expect(toProblem(error).status).toBe(409);
    await expectRefused(runPlan(s, plan), 'APPROVAL_REQUIRED');
  });

  it('an approval written into the table without the key is refused, even in an approved plan', async () => {
    const s = approvalSetup();
    const plan = await makePlan(s);
    const row = await s.planRepository.get(plan.id);
    if (row === undefined) throw new Error('missing');
    const forged = (seal: string, digest = plan.digest) => ({
      by: 'approver-1',
      at: 1,
      decision: 'approve' as const,
      digest,
      seal,
    });

    for (const approval of [
      forged(''),
      forged('AAAA'),
      forged(Buffer.alloc(64).toString('base64')),
    ]) {
      const current = await s.planRepository.get(plan.id);
      await s.planRepository.update(
        plan.id,
        current?.version ?? 0,
        { state: 'approved', approvals: [approval] },
        s.clock.now(),
      );

      await expectRefused(runPlan(s, plan), 'PLAN_STALE');
    }
    expect(s.probe.executed).toBe(0);
  });

  it('a real approval moved to another approver, another decision or another plan is refused', async () => {
    const s = approvalSetup();
    const plan = await makePlan(s);
    const other = await makePlan(s);
    await s.executor.approve(plan.id, 'approve', approver);
    await s.executor.approve(other.id, 'approve', approver);
    const real = (await s.planRepository.get(plan.id))?.approvals[0];
    const elsewhere = (await s.planRepository.get(other.id))?.approvals[0];
    if (real === undefined || elsewhere === undefined) throw new Error('x');

    const edits = [
      { ...real, by: 'approver-2' },
      { ...real, decision: 'reject' as const },
      { ...real, at: real.at + 1 },
      { ...real, digest: 'f'.repeat(64) },
      { ...real, seal: elsewhere.seal },
    ];
    for (const edit of edits) {
      const current = await s.planRepository.get(plan.id);
      await s.planRepository.update(
        plan.id,
        current?.version ?? 0,
        { approvals: [edit] },
        s.clock.now(),
      );

      await expectRefused(runPlan(s, plan), 'PLAN_STALE');
    }
    expect(s.probe.executed).toBe(0);
    // The untouched approval still works.
    const current = await s.planRepository.get(plan.id);
    await s.planRepository.update(
      plan.id,
      current?.version ?? 0,
      { approvals: [real] },
      s.clock.now(),
    );
    expect((await runPlan(s, plan)).kind).toBe('output');
  });
  it('an approval by the person the requester acts for does not count either', async () => {
    const s = approvalSetup();
    const agent = createTestContext({
      principal: createTestPrincipal({
        id: 'agent-1',
        kind: 'mcp-client',
        surface: 'mcp',
        unattended: true,
        onBehalfOf: createTestPrincipal({ id: 'boss' }),
      }),
    });
    const plan = await makePlan(s, agent);

    await expectRefused(
      s.executor.approve(
        plan.id,
        'approve',
        createTestContext({ principal: createTestPrincipal({ id: 'boss' }) }),
      ),
      'FORBIDDEN_RBAC',
    );
  });
});

describe('executor policy changes between plan and execute', () => {
  it('a stricter guardrail decision makes the old plan stale', async () => {
    let strict = false;
    const policy: GuardrailPolicy = {
      decide: ({ risk }) =>
        Promise.resolve({
          risk,
          planning: 'required',
          approvalsRequired: 0,
          forbidLetBrokerHandle: false,
          extraConsents: strict ? ['new-consent'] : [],
        }),
    };
    const s = setup({ executor: { guardrails: policy } });
    const plan = await makePlan(s);
    strict = true;

    await expectRefused(runPlan(s, plan), 'PLAN_STALE');

    expect(s.probe.executed).toBe(0);
  });

  it('a guardrail denial at execute time wins (freeze, prod lock)', async () => {
    let frozen = false;
    const policy: GuardrailPolicy = {
      decide: ({ risk }) =>
        Promise.resolve({
          risk,
          planning: 'required',
          approvalsRequired: 0,
          forbidLetBrokerHandle: false,
          extraConsents: [],
          ...(frozen
            ? { denied: { code: 'FROZEN' as const, reason: 'frozen' } }
            : {}),
        }),
    };
    const s = setup({ executor: { guardrails: policy } });
    const plan = await makePlan(s);
    frozen = true;

    await expectRefused(runPlan(s, plan), 'FROZEN');
    await expectRefused(makePlan(s), 'FROZEN');
    expect(s.probe.executed).toBe(0);
  });

  it('a guardrail policy that throws denies the action', async () => {
    const s = setup({
      executor: {
        guardrails: { decide: () => Promise.reject(new Error('db down')) },
      },
    });

    await expectRefused(makePlan(s), 'INTERNAL');
  });
});

describe('executor failure modes of its parts', () => {
  it('a guardrail answer off its contract denies the action', async () => {
    for (const bad of [
      { planning: 'required', approvalsRequired: -1 },
      { planning: 'required', approvalsRequired: 1.5 },
      { planning: 'sometimes', approvalsRequired: 0 },
      { planning: 'required', approvalsRequired: 0, risk: 'tiny' },
      { planning: 'none', approvalsRequired: 0, extra: true },
      undefined,
      null,
    ]) {
      const s = setup({
        executor: {
          guardrails: {
            decide: ({ risk }) =>
              Promise.resolve({
                risk,
                forbidLetBrokerHandle: false,
                extraConsents: [],
                ...bad,
              } as never),
          },
        },
      });

      await expectRefused(makePlan(s), 'INTERNAL');
      expect(s.probe.executed).toBe(0);
    }
  });

  it('a failure to record the end of a run does not hide its result, and the plan stays consumed', async () => {
    const base = createMemoryPlanRepository();
    const repository: PlanRepository = {
      ...base,
      update: (id, version, patch, now) =>
        patch.state === 'executed' || patch.state === 'failed'
          ? Promise.reject(new Error('disk full'))
          : base.update(id, version, patch, now),
    };
    const s = setup({ planRepository: repository });
    const plan = await makePlan(s);

    const outcome = await runPlan(s, plan);

    expect(outcome.kind).toBe('output');
    expect(s.probe.executed).toBe(1);
    expect((await s.plans.view(plan.id))?.state).toBe('executing');
    await expectRefused(runPlan(s, plan), 'PLAN_STALE');
    expect(s.probe.executed).toBe(1);
  });

  it('a receipt sink that fails does not fail the call but flags it; one that works returns its id', async () => {
    const failing = setup({
      executor: { receipts: { record: () => Promise.reject(new Error('x')) } },
    });
    const ok = setup({
      executor: {
        receipts: { record: () => Promise.resolve('rcpt-1' as never) },
      },
    });

    const a = await runPlan(failing, await makePlan(failing));
    const b = await runPlan(ok, await makePlan(ok));

    expect(a).toEqual({
      kind: 'output',
      output: { purged: 12 },
      receiptFailed: true,
    });
    expect(b).toMatchObject({ kind: 'output', receiptId: 'rcpt-1' });
  });

  it('a profile resolver that throws a Problem surfaces it', async () => {
    const s = setup({
      executor: {
        profiles: {
          resolve: () =>
            Promise.reject(new AppError('BROKER_UNREACHABLE', { detail: 'x' })),
        },
      },
    });

    await expectRefused(makePlan(s), 'BROKER_UNREACHABLE');
  });
});
describe('executor gates', () => {
  it('a blocking gate from plan() is GATE_BLOCKED and no plan is stored', async () => {
    const probe = createProbe();
    const blocked = implementAction(purgeDef, {
      plan: () =>
        Promise.resolve({
          preview: {},
          gates: [
            {
              id: 'prod-lock',
              blocking: true,
              reason: 'Arm production first.',
              source: 'guardrails',
            },
          ],
          warnings: [],
          consentsRequired: [],
        }),
      revalidate: () => Promise.resolve('valid'),
      execute: () => {
        probe.executed += 1;
        return Promise.resolve({ purged: 0 });
      },
    });
    const s = createTestExecutor();
    s.executor.register(blocked);

    const error = await expectRefused(
      s.executor.plan(purgeDef, input, createTestContext()),
      'GATE_BLOCKED',
    );

    expect(error.gate).toMatchObject({ enabled: false, source: 'guardrails' });
    expect(probe.executed).toBe(0);
  });

  it('a blocking capability gate from the profile is CAPABILITY_MISSING (412)', async () => {
    const s = setup({
      executor: {
        profiles: {
          resolve: () =>
            Promise.resolve({
              fingerprint: 'fp',
              gates: [
                {
                  id: 'qq-only',
                  blocking: true,
                  reason: 'Needs a quorum queue.',
                },
              ],
            }),
        },
      },
    });

    const error = await expectRefused(makePlan(s), 'CAPABILITY_MISSING');

    expect(toProblem(error).status).toBe(412);
  });

  it('a block-severity warning in a draft blocks the plan', async () => {
    const blocked = implementAction(purgeDef, {
      plan: () =>
        Promise.resolve({
          preview: {},
          gates: [],
          warnings: [
            {
              id: 'W-X' as const,
              severity: 'block' as const,
              textKey: 'k',
              textVersion: 1,
            },
          ],
          consentsRequired: [],
        }),
      revalidate: () => Promise.resolve('valid'),
      execute: () => Promise.resolve({ purged: 0 }),
    });
    const s = createTestExecutor();
    s.executor.register(blocked);

    await expectRefused(makePlan(s as Setup), 'GATE_BLOCKED');
  });

  it('a draft that breaks its contract is INTERNAL', async () => {
    const broken = implementAction(purgeDef, {
      plan: () => Promise.resolve({ preview: {}, gates: 'none' } as never),
      revalidate: () => Promise.resolve('valid'),
      execute: () => Promise.resolve({ purged: 0 }),
    });
    const s = createTestExecutor();
    s.executor.register(broken);

    await expectRefused(makePlan(s as Setup), 'INTERNAL');
  });

  it('consent warnings add their id to the consents required', async () => {
    const withWarning = implementAction(purgeDef, {
      plan: () =>
        Promise.resolve({
          preview: {},
          gates: [],
          warnings: [
            {
              id: 'W-LOSS' as const,
              severity: 'consent' as const,
              textKey: 'k',
              textVersion: 1,
            },
          ],
          consentsRequired: ['typed'],
        }),
      revalidate: () => Promise.resolve('valid'),
      execute: () => Promise.resolve({ purged: 0 }),
    });
    const s = createTestExecutor();
    s.executor.register(withWarning);

    const plan = await makePlan(s as Setup);

    expect([...plan.consentsRequired].sort()).toEqual(['W-LOSS', 'typed']);
  });
});

describe('executor lifecycle states', () => {
  it('draining refuses new mutations and plans, still serves queries, and lets running work finish', async () => {
    const s = setup();
    const plan = await makePlan(s);
    s.executor.beginDrain();

    expect(s.executor.state()).toBe('draining');
    await expectRefused(makePlan(s), 'ENGINE_SHUTTING_DOWN');
    await expectRefused(runPlan(s, plan), 'ENGINE_SHUTTING_DOWN');
    await expectRefused(
      s.executor.run(
        pingDef,
        {},
        createTestContext({ idempotencyKey: freshKey() }),
      ),
      'ENGINE_SHUTTING_DOWN',
    );
    expect(
      (await s.executor.run(statDef, { name: 'q' }, createTestContext())).kind,
    ).toBe('output');
    expect(s.probe.executed).toBe(1);
  });

  it('frozen-partial refuses mutations with FROZEN and unfreezes', async () => {
    const s = setup();
    s.executor.freeze();

    expect(s.executor.state()).toBe('frozen-partial');
    await expectRefused(makePlan(s), 'FROZEN');
    expect(
      (await s.executor.run(statDef, { name: 'q' }, createTestContext())).kind,
    ).toBe('output');

    s.executor.unfreeze();
    expect(s.executor.state()).toBe('accepting');
    expect((await makePlan(s)).state).toBe('open');
  });

  it('stopped refuses everything and cannot be revived by unfreeze or drain', async () => {
    const s = setup();
    s.executor.stop();
    s.executor.unfreeze();
    s.executor.freeze();

    expect(s.executor.state()).toBe('stopped');
    await expectRefused(
      s.executor.run(statDef, { name: 'q' }, createTestContext()),
      'ENGINE_SHUTTING_DOWN',
    );
    expect(() => {
      s.executor.register(statImpl(createProbe()));
    }).toThrow();
  });

  it('stop() aborts the signal an action is running with', async () => {
    const probe = createProbe();
    let seen: AbortSignal | undefined;
    let release: () => void = () => undefined;
    const slow = implementAction(pingDef, {
      plan: () =>
        Promise.resolve({
          preview: {},
          gates: [],
          warnings: [],
          consentsRequired: [],
        }),
      revalidate: () => Promise.resolve('valid'),
      execute: async (_input, ctx) => {
        seen = ctx.signal;
        probe.executed += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { ok: true };
      },
    });
    const s = createTestExecutor();
    s.executor.register(slow);

    const running = s.executor.run(
      pingDef,
      {},
      createTestContext({ idempotencyKey: freshKey() }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(s.executor.inFlight()).toBe(1);
    s.executor.stop();
    release();
    await running;

    expect(seen?.aborted).toBe(true);
    expect(s.executor.inFlight()).toBe(0);
  });

  it('a deadline in the past aborts the call before it starts', async () => {
    const s = setup();

    await expectRefused(
      s.executor.run(
        pingDef,
        {},
        createTestContext({
          idempotencyKey: freshKey(),
          deadline: s.clock.now() - 1,
        }),
      ),
      'INTERNAL',
    );

    expect(s.probe.executed).toBe(0);
  });

  it('the number of open plans per principal is bounded', async () => {
    const s = setup({ store: { maxActivePerPrincipal: 2 } });
    await makePlan(s);
    await makePlan(s);

    const error = await expectRefused(makePlan(s), 'BUDGET_EXCEEDED');

    expect(error.retryable).toBe(true);
    // Another principal is not affected.
    await makePlan(
      s,
      createTestContext({ principal: createTestPrincipal({ id: 'user-2' }) }),
    );
  });
});
