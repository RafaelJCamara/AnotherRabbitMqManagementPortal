import {
  defineAction,
  type ActionDef,
  type EnvClass,
  type ErrorCode,
} from '@app/contracts';
import type { Principal } from '@app/ports';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { allowUiPrincipals } from '../actions/authorizer.ts';
import { createActionExecutor } from '../actions/executor.ts';
import type { GuardrailInput } from '../actions/hooks.ts';
import { implementAction } from '../actions/implement-action.ts';
import {
  createProbe,
  peekDef,
  peekImpl,
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
} from '../actions/test-actions.ts';
import {
  checkPlanPurity,
  createAesGcmTestCipher,
  createMemoryAuditRepository,
  createMemoryIdempotencyRepository,
  createMemoryPlanRepository,
  createMemoryReceiptRepository,
  createRecordingWrites,
  createTestContext,
  createTestPrincipal,
  type MemoryAuditRepository,
  type MemoryReceiptRepository,
} from '../actions/testing.ts';
import { createPlanStore } from '../actions/plan-store.ts';
import { createAuditChain, type AuditChain } from '../audit/chain.ts';
import { createManualClock, type ManualClock } from '../clock/clock.ts';
import { createIdGenerator } from '../ids/ids.ts';
import { AppError } from '../problem/problem.ts';
import { createReceiptStore } from '../receipts/store.ts';
import { createArmActions } from './ops-actions.ts';
import { ARM_WINDOW_MS, createGuardrails, type Guardrails } from './policy.ts';

const MINUTE = 60_000;
const CONNECTION = 'c1';
const input = { connectionId: CONNECTION, name: 'orders' };

/** The real parts, wired the way a composition root would wire them, over memory stores. */
interface World {
  executor: ReturnType<typeof createActionExecutor>;
  guardrails: Guardrails;
  chain: AuditChain;
  auditRows: MemoryAuditRepository;
  receiptRows: MemoryReceiptRepository;
  clock: ManualClock;
  probe: Probe;
  writeCalls: readonly string[];
}

let keys = 0;
const freshKey = (): string => {
  keys += 1;
  return `guardrail-key-${String(keys).padStart(6, '0')}`;
};

function world(armWindowMs?: number): World {
  const clock = createManualClock(1_700_000_000_000);
  const ids = createIdGenerator({ clock });
  const guardrails = createGuardrails({
    clock,
    ...(armWindowMs === undefined ? {} : { armWindowMs }),
  });
  const auditRows = createMemoryAuditRepository();
  const receiptRows = createMemoryReceiptRepository();
  const chain = createAuditChain({ repository: auditRows });
  const recording = createRecordingWrites();
  const executor = createActionExecutor({
    plans: createPlanStore({
      repository: createMemoryPlanRepository(),
      cipher: createAesGcmTestCipher(),
      clock,
      ids,
    }),
    idempotency: createMemoryIdempotencyRepository(),
    authorizer: allowUiPrincipals(),
    audit: chain,
    guardrails: guardrails.policy,
    receipts: createReceiptStore({ repository: receiptRows, clock, ids }),
    writes: recording.writes,
    clock,
    ids,
  });
  const probe = createProbe();
  executor.register(
    purgeImpl(probe),
    peekImpl(probe),
    renameImpl(probe),
    pingImpl(probe),
    statImpl(probe),
    startJobImpl(probe),
    ...createArmActions(guardrails.arming),
  );
  return {
    executor,
    guardrails,
    chain,
    auditRows,
    receiptRows,
    clock,
    probe,
    writeCalls: recording.calls,
  };
}

const person = createTestPrincipal();
const prodCtx = (over: Partial<Parameters<typeof createTestContext>[0]> = {}) =>
  createTestContext({ env: 'prod', ...over });

async function refusalOf(work: Promise<unknown>): Promise<AppError> {
  const error = await work.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

/** What a synchronous call throws, or undefined. */
function thrown(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  return undefined;
}

async function expectBlocked(work: Promise<unknown>): Promise<AppError> {
  const error = await refusalOf(work);
  expect(error.code).toBe('GATE_BLOCKED');
  expect(error.gate).toMatchObject({ enabled: false, source: 'prod-lock' });
  expect(error.detail).toMatch(/^prod-lock/);
  return error;
}

const getDef = (w: World, id: string): ActionDef => {
  const found = w.executor.registered().find((def) => def.id === id);
  if (found === undefined) throw new Error(`not registered: ${id}`);
  return found;
};

function arm(w: World, who: Principal = person, connection = CONNECTION) {
  return w.executor.run(
    getDef(w, 'ops.arm'),
    { connectionId: connection },
    createTestContext({
      principal: who,
      env: 'prod',
      idempotencyKey: freshKey(),
    }),
  );
}

describe('guardrail prod lock: a prod or unset connection is locked until armed', () => {
  it.each([
    ['a command', purgeDef as ActionDef, input],
    ['a peek', peekDef as ActionDef, input],
  ])(
    'AC-2 guardrail: planning %s on prod that is not armed is GATE_BLOCKED prod-lock',
    async (_name, def, body) => {
      const w = world();

      const error = await expectBlocked(w.executor.plan(def, body, prodCtx()));

      expect(error.gate?.fix).toEqual({
        actionId: 'ops.arm',
        input: { connectionId: CONNECTION },
      });
      expect(w.probe.executed).toBe(0);
      expect(w.auditRows.rows).toHaveLength(0);
    },
  );

  it('AC-2 guardrail: planning a job on prod that is not armed is GATE_BLOCKED prod-lock', async () => {
    const w = world();

    await expectBlocked(w.executor.plan(startJobDef, { name: 'a' }, prodCtx()));

    expect(w.probe.executed).toBe(0);
  });

  it('AC-2 guardrail: a peek is a mutation to the lock: armed it can be planned, unarmed it cannot', async () => {
    const w = world();
    await expectBlocked(w.executor.plan(peekDef, input, prodCtx()));

    await arm(w);

    expect((await w.executor.plan(peekDef, input, prodCtx())).state).toBe(
      'open',
    );
  });

  it('AC-2 guardrail: a direct call on prod that is not armed is blocked too, and nothing runs', async () => {
    const w = world();

    await expectBlocked(
      w.executor.run(pingDef, {}, prodCtx({ idempotencyKey: freshKey() })),
    );

    expect(w.probe.executed).toBe(0);
    expect(w.writeCalls).toEqual([]);
    expect(w.auditRows.rows).toHaveLength(0);
  });

  it('AC-2 guardrail: an unset environment class is prod, so it is locked', async () => {
    const w = world();

    await expectBlocked(
      w.executor.plan(purgeDef, input, {
        principal: person,
        mode: 'desktop',
      }),
    );
  });

  it('AC-2 guardrail: an unknown environment class is prod, so it is locked', async () => {
    const w = world();

    await expectBlocked(
      w.executor.plan(
        purgeDef,
        input,
        createTestContext({ env: 'banana' as never }),
      ),
    );
  });

  it('AC-2 guardrail: the policy itself reads a class it does not know as prod', async () => {
    const { policy } = createGuardrails({ clock: createManualClock(1) });

    const decision = await policy.decide(
      decideInput(purgeDef, { env: 'banana' as EnvClass }),
    );

    expect(decision.denied).toMatchObject({ code: 'GATE_BLOCKED' });
  });

  it.each(['staging', 'test', 'dev', 'local'] as const)(
    'AC-2 guardrail: %s is not locked',
    async (env) => {
      const w = world();

      const outcome = await w.executor.run(
        pingDef,
        {},
        createTestContext({ env, idempotencyKey: freshKey() }),
      );

      expect(outcome.kind).toBe('output');
      expect(w.probe.executed).toBe(1);
    },
  );

  it('AC-2 guardrail: a query is never locked, armed or not', async () => {
    const w = world();

    const outcome = await w.executor.run(statDef, { name: 'q' }, prodCtx());

    expect(outcome).toMatchObject({ kind: 'output', output: { depth: 3 } });
  });

  it('AC-2 guardrail: a "query" that declares a mutating MCP tool is locked like a command', async () => {
    const w = world();
    const sneaky = defineAction({
      id: 'queues.sneaky',
      kind: 'query',
      summary: 'Called a query, changes things',
      input: z.strictObject({ connectionId: z.string() }),
      output: z.strictObject({ ok: z.boolean() }),
      permission: 'queues.read',
      risk: 'high',
      planning: 'none',
      audit: 'attempt+outcome',
      target: (i) => ({ connectionId: i.connectionId as never }),
      mcp: { expose: true, mutating: true, title: 't', description: 'd' },
      since: '1.0',
    });
    w.executor.register(
      implementAction(sneaky, {
        plan: () =>
          Promise.resolve({
            preview: {},
            gates: [],
            warnings: [],
            consentsRequired: [],
          }),
        revalidate: () => Promise.resolve('valid'),
        execute: () => {
          w.probe.executed += 1;
          return Promise.resolve({ ok: true });
        },
      }),
    );

    await expectBlocked(
      w.executor.run(
        sneaky,
        { connectionId: CONNECTION },
        prodCtx({ idempotencyKey: freshKey() }),
      ),
    );

    expect(w.probe.executed).toBe(0);
  });

  it('AC-2 guardrail: a call with no connection to arm is locked, with no fix offered', async () => {
    const w = world();

    const error = await expectBlocked(
      w.executor.run(
        renameDef,
        { name: 'q' },
        prodCtx({ idempotencyKey: freshKey() }),
      ),
    );

    expect(error.gate?.fix).toBeUndefined();
  });

  it('AC-2 guardrail: the lock is checked again at execute: a plan made while armed is refused after the window', async () => {
    // A 2 minute window, so the plan (5 minutes) is still good when the lock has closed.
    const w = world(2 * MINUTE);
    await arm(w);
    const plan = await w.executor.plan(purgeDef, input, prodCtx());
    w.clock.advance(2 * MINUTE);

    await expectBlocked(
      w.executor.execute(
        {
          planId: plan.id,
          consents: [],
          idempotencyKey: freshKey(),
          confirmation: 'purge orders',
        },
        prodCtx(),
      ),
    );

    expect(w.probe.executed).toBe(0);
    expect(w.writeCalls).toEqual([]);
  });

  it('AC-2 guardrail: the lock closed by a disarm between plan and execute wins over the plan', async () => {
    const w = world();
    await arm(w);
    const plan = await w.executor.plan(purgeDef, input, prodCtx());
    await w.executor.run(
      getDef(w, 'ops.disarm'),
      { connectionId: CONNECTION },
      createTestContext({ env: 'prod', idempotencyKey: freshKey() }),
    );

    await expectBlocked(
      w.executor.execute(
        {
          planId: plan.id,
          consents: [],
          idempotencyKey: freshKey(),
          confirmation: 'purge orders',
        },
        prodCtx(),
      ),
    );

    expect(w.probe.executed).toBe(0);
  });
});

describe('guardrail arming: 15 minutes, per person and connection, explicit re-arm', () => {
  it('AC-2 guardrail: after arming, mutations are allowed for 15 minutes and not a millisecond longer', async () => {
    const w = world();
    const armed = await arm(w);
    expect(armed).toMatchObject({
      kind: 'output',
      output: {
        armed: true,
        connectionId: CONNECTION,
        armedAt: w.clock.now(),
        expiresAt: w.clock.now() + ARM_WINDOW_MS,
      },
    });
    const run = () =>
      w.executor.run(pingDef, {}, prodCtx({ idempotencyKey: freshKey() }));
    // The ping action has no connection to arm; purge does.
    const plan = () => w.executor.plan(purgeDef, input, prodCtx());

    expect((await plan()).state).toBe('open');
    w.clock.advance(ARM_WINDOW_MS - 1);
    expect((await plan()).state).toBe('open');
    w.clock.advance(1);
    await expectBlocked(plan());
    await expectBlocked(run());
  });

  it('AC-2 guardrail: an armed prod connection lets a plan run end to end', async () => {
    const w = world();
    await arm(w);
    const plan = await w.executor.plan(purgeDef, input, prodCtx());

    const outcome = await w.executor.execute(
      {
        planId: plan.id,
        consents: [],
        idempotencyKey: freshKey(),
        confirmation: 'purge orders',
      },
      prodCtx(),
    );

    expect(outcome).toMatchObject({ kind: 'output', output: { purged: 12 } });
    expect(w.probe.executed).toBe(1);
  });

  it('AC-2 guardrail: arming again after the window is explicit, and starts a new 15 minutes', async () => {
    const w = world();
    await arm(w);
    w.clock.advance(14 * MINUTE);
    // Re-arming while armed does not stack: it is 15 minutes from now.
    await arm(w);
    w.clock.advance(14 * MINUTE);
    expect(w.guardrails.arming.status(person, CONNECTION)).toMatchObject({
      armed: true,
    });
    w.clock.advance(MINUTE);
    expect(w.guardrails.arming.status(person, CONNECTION)).toEqual({
      armed: false,
    });
    await expectBlocked(w.executor.plan(purgeDef, input, prodCtx()));

    await arm(w);

    expect((await w.executor.plan(purgeDef, input, prodCtx())).state).toBe(
      'open',
    );
  });

  it('AC-2 guardrail: the window can be shortened for tests but never made longer than 15 minutes', () => {
    const clock = createManualClock(1_000);
    const long = createGuardrails({ clock, armWindowMs: 24 * 60 * MINUTE });
    const short = createGuardrails({ clock, armWindowMs: 5_000 });

    expect(long.arming.arm(person, 'c').expiresAt - 1_000).toBe(ARM_WINDOW_MS);
    expect(short.arming.arm(person, 'c').expiresAt - 1_000).toBe(5_000);
  });

  it('AC-2 guardrail: arming one connection does not open another', async () => {
    const w = world();
    await arm(w, person, 'c-other');

    const error = await expectBlocked(
      w.executor.plan(purgeDef, input, prodCtx()),
    );

    expect(error.gate?.fix?.input).toEqual({ connectionId: CONNECTION });
  });

  it('AC-2 guardrail: no choice of ids can make two different person and connection pairs one arming', () => {
    const { arming } = createGuardrails({ clock: createManualClock(1) });
    const first = createTestPrincipal({ id: 'a\u0000b' });
    const second = createTestPrincipal({ id: 'a' });

    arming.arm(first, 'c');

    expect(arming.status(second, 'b\u0000c').armed).toBe(false);
    expect(arming.status(first, 'c').armed).toBe(true);
  });

  it('AC-2 guardrail: arming is personal: another person is still locked', async () => {
    const w = world();
    await arm(w);
    const other = createTestContext({
      env: 'prod',
      principal: createTestPrincipal({ id: 'user-2', kind: 'local-token' }),
    });

    await expectBlocked(w.executor.plan(purgeDef, input, other));
    expect((await w.executor.plan(purgeDef, input, prodCtx())).state).toBe(
      'open',
    );
  });

  it('AC-2 guardrail: disarm locks again at once, and says whether it was armed', async () => {
    const w = world();
    await arm(w);

    const first = await w.executor.run(
      getDef(w, 'ops.disarm'),
      { connectionId: CONNECTION },
      createTestContext({ env: 'prod', idempotencyKey: freshKey() }),
    );
    const second = await w.executor.run(
      getDef(w, 'ops.disarm'),
      { connectionId: CONNECTION },
      createTestContext({ env: 'prod', idempotencyKey: freshKey() }),
    );

    expect(first).toMatchObject({ output: { armed: false, wasArmed: true } });
    expect(second).toMatchObject({ output: { armed: false, wasArmed: false } });
    await expectBlocked(w.executor.plan(purgeDef, input, prodCtx()));
  });

  it('AC-2 guardrail: a clock that jumps back does not stretch the window', async () => {
    const w = world();
    await arm(w);

    w.clock.setNow(w.clock.now() - 1);

    expect(w.guardrails.arming.status(person, CONNECTION).armed).toBe(false);
    await expectBlocked(w.executor.plan(purgeDef, input, prodCtx()));
  });

  it('AC-2 guardrail: the number of armed connections is bounded, and expired ones make room', () => {
    const clock = createManualClock(1_000);
    const { arming } = createGuardrails({ clock });
    for (let i = 0; i < 1000; i += 1) arming.arm(person, `c-${String(i)}`);

    expect(thrown(() => arming.arm(person, 'one-too-many'))).toMatchObject({
      code: 'BUDGET_EXCEEDED',
    });
    // Re-arming one already armed needs no room.
    expect(arming.arm(person, 'c-5').armed).toBe(true);
    clock.advance(ARM_WINDOW_MS);
    expect(arming.arm(person, 'one-too-many').armed).toBe(true);
  });
});

describe('guardrail arming: only a person can arm, and an AI client cannot mutate prod', () => {
  const agent = createTestPrincipal({
    kind: 'mcp-client',
    id: 'agent-1',
    surface: 'mcp',
    unattended: true,
  });
  const delegate = createTestPrincipal({
    kind: 'team-user',
    id: 'delegate-1',
    onBehalfOf: person,
  });
  const job = createTestPrincipal({
    kind: 'job',
    id: 'job-runner',
    surface: 'job',
    unattended: true,
    onBehalfOf: person,
  });

  it.each([
    ['an MCP client', agent],
    ['a delegate of the person', delegate],
    ['a job', job],
    [
      'an unattended principal on the CLI',
      createTestPrincipal({ id: 'cli', surface: 'cli', unattended: true }),
    ],
    [
      'a system principal',
      createTestPrincipal({ id: 'sys', kind: 'system', surface: 'system' }),
    ],
    [
      'a job that claims the UI surface',
      createTestPrincipal({ id: 'j', kind: 'job', surface: 'ui' }),
    ],
    [
      'an MCP client that claims the CLI surface',
      createTestPrincipal({ id: 'm', kind: 'mcp-client', surface: 'cli' }),
    ],
  ] as const)(
    'AC-2 guardrail: %s cannot arm (FORBIDDEN_RBAC), and nothing is armed',
    async (_name, who) => {
      const w = world();
      const everything = {
        authorize: () => Promise.resolve({ allowed: true as const }),
      };
      const open = createActionExecutor({
        ...optionsOf(w),
        authorizer: everything,
      });
      open.register(...createArmActions(w.guardrails.arming));
      const armDef = getDef(w, 'ops.arm');

      const error = await refusalOf(
        open.run(
          armDef,
          { connectionId: CONNECTION },
          createTestContext({
            principal: who,
            env: 'prod',
            idempotencyKey: freshKey(),
          }),
        ),
      );

      expect(error.code).toBe<ErrorCode>('FORBIDDEN_RBAC');
      expect(w.guardrails.arming.status(person, CONNECTION).armed).toBe(false);
      expect(w.guardrails.arming.status(who, CONNECTION).armed).toBe(false);
      expect(() => w.guardrails.arming.arm(who, CONNECTION)).toThrow();
    },
  );

  it('AC-2 guardrail: a person on the CLI can arm', () => {
    const w = world();

    expect(
      w.guardrails.arming.arm(
        createTestPrincipal({ id: 'dev', kind: 'api-token', surface: 'cli' }),
        'c',
      ).armed,
    ).toBe(true);
  });

  it('AC-2 guardrail: an AI client has no mutations on prod even when the person it acts for is armed', async () => {
    const w = world();
    await arm(w);
    const asAgent = createActionExecutor({
      ...optionsOf(w),
      authorizer: { authorize: () => Promise.resolve({ allowed: true }) },
    });
    asAgent.register(purgeImpl(createProbe()));
    const forPerson = createTestPrincipal({
      kind: 'mcp-client',
      id: 'agent-2',
      surface: 'mcp',
      unattended: true,
      onBehalfOf: person,
    });

    const error = await refusalOf(
      asAgent.plan(
        purgeDef,
        input,
        createTestContext({ principal: forPerson, env: 'prod' }),
      ),
    );

    expect(error.code).toBe('GATE_BLOCKED');
    expect(error.gate?.source).toBe('prod-lock');
  });

  it('AC-2 guardrail: a job that acts for an armed person is not locked out, and is still made to plan', async () => {
    const w = world();
    await arm(w);
    const asJob = createActionExecutor({
      ...optionsOf(w),
      authorizer: { authorize: () => Promise.resolve({ allowed: true }) },
    });
    asJob.register(purgeImpl(createProbe()));

    const outcome = await asJob.run(
      purgeDef,
      input,
      createTestContext({
        principal: job,
        env: 'prod',
        idempotencyKey: freshKey(),
      }),
    );

    // Not GATE_BLOCKED: the person is armed, and an unattended principal only ever plans.
    expect(outcome.kind).toBe('planRequired');
  });

  it('AC-2 guardrail: a job with no person behind it is locked on prod', async () => {
    const w = world();
    const nobody = createTestPrincipal({
      kind: 'system',
      id: 'cron',
      surface: 'system',
      unattended: true,
    });
    const open = createActionExecutor({
      ...optionsOf(w),
      authorizer: { authorize: () => Promise.resolve({ allowed: true }) },
    });
    open.register(purgeImpl(createProbe()));

    await expectBlocked(
      open.plan(
        purgeDef,
        input,
        createTestContext({ principal: nobody, env: 'prod' }),
      ),
    );
  });
});

describe('guardrail arming is audited: every arm and disarm leaves rows and a receipt', () => {
  it('AC-2 audit: arm writes an attempt row before it runs and an outcome row after, linked to a receipt', async () => {
    const w = world();

    const outcome = await arm(w);

    expect(w.auditRows.rows.map((row) => [row.phase, row.actionId])).toEqual([
      ['attempt', 'ops.arm'],
      ['outcome', 'ops.arm'],
    ]);
    const [attempt, closing] = w.auditRows.rows;
    expect(attempt).toMatchObject({
      actorId: 'user-1',
      surface: 'ui',
      env: 'prod',
      risk: 'low',
    });
    expect(JSON.parse(attempt?.targetJson ?? '{}')).toEqual({
      connectionId: CONNECTION,
    });
    expect(closing).toMatchObject({
      attemptSeq: 1,
      result: 'ok',
      receiptId: (outcome as { receiptId?: string }).receiptId,
    });
    expect(w.receiptRows.rows.size).toBe(1);
    expect(await w.chain.verify()).toMatchObject({ ok: true, rows: 2 });
  });

  it('AC-2 audit: disarm is audited the same way', async () => {
    const w = world();
    await arm(w);

    await w.executor.run(
      getDef(w, 'ops.disarm'),
      { connectionId: CONNECTION },
      createTestContext({ env: 'prod', idempotencyKey: freshKey() }),
    );

    expect(w.auditRows.rows.map((row) => [row.phase, row.actionId])).toEqual([
      ['attempt', 'ops.arm'],
      ['outcome', 'ops.arm'],
      ['attempt', 'ops.disarm'],
      ['outcome', 'ops.disarm'],
    ]);
    expect(w.receiptRows.rows.size).toBe(2);
  });

  it('AC-2 audit: when the audit store is down nothing can be armed (arming is fail closed too)', async () => {
    const w = world();
    w.auditRows.failAppends(true);

    const error = await refusalOf(arm(w));

    expect(error.code).toBe('INTERNAL');
    expect(w.guardrails.arming.status(person, CONNECTION).armed).toBe(false);
  });

  it('AC-2 audit: a refused arm (an AI client asked) writes no row and arms nothing', async () => {
    const w = world();

    await refusalOf(
      arm(
        w,
        createTestPrincipal({
          kind: 'mcp-client',
          id: 'agent-1',
          surface: 'mcp',
          unattended: true,
        }),
      ),
    );

    expect(w.auditRows.rows).toHaveLength(0);
  });

  it('AC-2 guardrail: arm and disarm plan() read only (plan purity)', async () => {
    const w = world();
    const impls = createArmActions(w.guardrails.arming);

    const failures = await checkPlanPurity(
      impls.map((impl) => ({ impl, input: { connectionId: CONNECTION } })),
    );

    expect(failures).toEqual([]);
  });
});

describe('guardrail policy keeps the rules of the stand-in', () => {
  it('AC-2 guardrail: a typed phrase, a plan for a high-risk change on staging, and a plan for an unattended principal', async () => {
    const { policy } = createGuardrails({ clock: createManualClock(1) });

    const phrase = await policy.decide(decideInput(purgeDef, { env: 'dev' }));
    const staging = await policy.decide(
      decideInput(renameDef, { env: 'staging', risk: 'high' }),
    );
    const agent = await policy.decide(
      decideInput(pingDef, {
        env: 'dev',
        principal: createTestPrincipal({ unattended: true }),
      }),
    );
    const plain = await policy.decide(decideInput(pingDef, { env: 'dev' }));

    expect(phrase.planning).toBe('required');
    expect(staging.planning).toBe('required');
    expect(agent.planning).toBe('required');
    expect(plain.planning).toBe('none');
    expect(plain).toMatchObject({ approvalsRequired: 0, extraConsents: [] });
  });
});

describe("guardrail scope 'local': the one declared way past the lock for an action with no target (OQ-783)", () => {
  const localShape = {
    kind: 'command',
    summary: 'Change only the engine-local state',
    input: z.strictObject({}),
    output: z.strictObject({ ok: z.boolean() }),
    permission: 'ops.local-ping',
    risk: 'low',
    planning: 'none',
    audit: 'attempt+outcome',
    since: '1.0',
  } as const;
  const localDef = defineAction({
    ...localShape,
    id: 'ops.local-ping',
    target: () => ({}),
    scope: 'local',
  });
  /** The same action without the declaration. */
  const undeclaredDef = defineAction({
    ...localShape,
    id: 'ops.undeclared-ping',
    target: () => ({}),
  });
  /** A broken contract: it declares local scope and names a broker connection. */
  const liarDef = defineAction({
    ...localShape,
    id: 'ops.liar-ping',
    target: () => ({ connectionId: CONNECTION as never }),
    scope: 'local',
  });

  const impl = (def: ActionDef, w: World) =>
    implementAction(def as typeof localDef, {
      plan: () =>
        Promise.resolve({
          preview: {},
          gates: [],
          warnings: [],
          consentsRequired: [],
        }),
      revalidate: () => Promise.resolve('valid'),
      execute: () => {
        w.probe.executed += 1;
        return Promise.resolve({ ok: true });
      },
    });

  function localWorld(): World {
    const w = world();
    w.executor.register(
      impl(localDef, w),
      impl(undeclaredDef, w),
      impl(liarDef, w),
    );
    return w;
  }
  const call = (w: World, def: ActionDef, env: EnvClass = 'prod') =>
    w.executor.run(
      def,
      {},
      createTestContext({ env, idempotencyKey: freshKey() }),
    );

  it('AC-783-1 a local action with no target runs on prod with nothing armed, and is audited', async () => {
    const w = localWorld();

    const outcome = await call(w, localDef);

    expect(outcome).toMatchObject({ kind: 'output', output: { ok: true } });
    expect(w.probe.executed).toBe(1);
    expect(w.auditRows.rows).toHaveLength(2);
    expect(w.auditRows.rows[0]).toMatchObject({ actionId: 'ops.local-ping' });
  });

  it('AC-783-2 the same action WITHOUT the declaration stays 422 GATE_BLOCKED on prod, with no fix', async () => {
    const w = localWorld();

    const error = await expectBlocked(call(w, undeclaredDef));

    expect(error.gate?.fix).toBeUndefined();
    expect(w.probe.executed).toBe(0);
    expect(w.auditRows.rows).toHaveLength(0);
  });

  it('AC-783-3 a local action does not unlock a broker action: a targeted command is still locked until armed', async () => {
    const w = localWorld();
    await call(w, localDef);

    await expectBlocked(w.executor.plan(purgeDef, input, prodCtx()));
    await expectBlocked(w.executor.plan(peekDef, input, prodCtx()));

    expect(w.guardrails.arming.status(person, CONNECTION).armed).toBe(false);
  });

  it('AC-783-4 a local action is still authorised: a refusal is FORBIDDEN_RBAC and nothing runs or is audited', async () => {
    const w = localWorld();
    const denying = createActionExecutor({
      ...optionsOf(w),
      authorizer: {
        authorize: () => Promise.resolve({ allowed: false, reason: 'no' }),
      },
    });
    denying.register(impl(localDef, w));

    const error = await refusalOf(
      denying.run(
        localDef,
        {},
        createTestContext({ env: 'prod', idempotencyKey: freshKey() }),
      ),
    );

    expect(error.code).toBe<ErrorCode>('FORBIDDEN_RBAC');
    expect(w.probe.executed).toBe(0);
    expect(w.auditRows.rows).toHaveLength(0);
  });

  it('AC-783-5 an AI client still has no mutations on prod, local or not', async () => {
    const w = localWorld();
    const everything = createActionExecutor({
      ...optionsOf(w),
      authorizer: { authorize: () => Promise.resolve({ allowed: true }) },
    });
    everything.register(impl(localDef, w));
    const agent = createTestPrincipal({
      kind: 'mcp-client',
      id: 'agent-3',
      surface: 'mcp',
      unattended: true,
    });

    const error = await refusalOf(
      everything.plan(
        localDef,
        {},
        createTestContext({ principal: agent, env: 'prod' }),
      ),
    );

    expect(error.code).toBe('GATE_BLOCKED');
    expect(error.gate?.source).toBe('prod-lock');
    expect(w.probe.executed).toBe(0);
  });

  it('AC-783-6 a contract that declares local but names a target is refused by the executor, before anything runs', async () => {
    const w = localWorld();

    for (const env of ['prod', 'dev'] as const) {
      const error = await refusalOf(call(w, liarDef, env));

      expect(error.code).toBe<ErrorCode>('INTERNAL');
      expect(error.detail).toMatch(/scope 'local' but named a target/);
    }
    expect(w.probe.executed).toBe(0);
    expect(w.auditRows.rows).toHaveLength(0);
  });

  it('AC-783-7 the policy alone is closed too: a local scope with a target, on a peek or a job, or any other value, is locked', async () => {
    const { policy } = createGuardrails({ clock: createManualClock(1) });
    const none = { target: {} };
    const wrongScope = { ...localDef, scope: 'global' } as unknown as ActionDef;

    const decisions = await Promise.all([
      policy.decide(decideInput(liarDef, { target: liarDef.target({}) })),
      policy.decide(decideInput(localDef, { target: { vhost: '/' } })),
      policy.decide(decideInput(localDef, { target: { name: 'q' } })),
      policy.decide(decideInput({ ...localDef, kind: 'peek' }, none)),
      policy.decide(decideInput({ ...localDef, kind: 'job' }, none)),
      policy.decide(decideInput(wrongScope, none)),
      policy.decide(decideInput(undeclaredDef, none)),
    ]);

    for (const decision of decisions) {
      expect(decision.denied).toMatchObject({ code: 'GATE_BLOCKED' });
    }
    expect(
      (await policy.decide(decideInput(localDef, none))).denied,
    ).toBeUndefined();
  });

  it('AC-783-8 an action name is never the key: a different id with the same declaration behaves the same', async () => {
    const { policy } = createGuardrails({ clock: createManualClock(1) });
    const renamed = defineAction({
      ...localShape,
      id: 'connections.create',
      target: () => ({}),
    });

    const decision = await policy.decide(decideInput(renamed, { target: {} }));

    expect(decision.denied).toMatchObject({ code: 'GATE_BLOCKED' });
  });
});

// ---- helpers -------------------------------------------------------------------------------

function decideInput(
  def: ActionDef,
  over: Partial<GuardrailInput> = {},
): GuardrailInput {
  return {
    def,
    input: input,
    risk: 'critical',
    env: 'prod',
    principal: person,
    target: { connectionId: CONNECTION as never },
    mutating: def.kind !== 'query',
    ...over,
  };
}

function optionsOf(w: World): Parameters<typeof createActionExecutor>[0] {
  const clock = w.clock;
  const ids = createIdGenerator({ clock });
  return {
    plans: createPlanStore({
      repository: createMemoryPlanRepository(),
      cipher: createAesGcmTestCipher(),
      clock,
      ids,
    }),
    idempotency: createMemoryIdempotencyRepository(),
    authorizer: allowUiPrincipals(),
    audit: w.chain,
    guardrails: w.guardrails.policy,
    receipts: createReceiptStore({
      repository: w.receiptRows,
      clock,
      ids,
    }),
    writes: createRecordingWrites().writes,
    clock,
    ids,
  };
}
