import { describe, expect, it } from 'vitest';

import { createManualClock } from '../clock/clock.ts';
import { createIdGenerator } from '../ids/ids.ts';
import { AppError } from '../problem/problem.ts';
import {
  computePlanDigest,
  createPlanStore,
  DEFAULT_PLAN_TTL,
  type DigestFields,
  type NewPlan,
} from './plan-store.ts';
import {
  createAesGcmTestCipher,
  createMemoryPlanRepository,
} from './testing.ts';
import type { ActionId } from '@app/contracts';

const actionId = 'queues.purge' as ActionId;

function newPlan(overrides: Partial<NewPlan> = {}): NewPlan {
  return {
    actionId,
    input: { name: 'orders', bytes: Uint8Array.of(1, 2), count: 3n },
    sensitivePayload: { body: 'secret' },
    principalId: 'user-1',
    onBehalfOfId: null,
    profileFingerprint: 'fp-1',
    env: 'prod',
    risk: 'critical',
    gates: [],
    warnings: [],
    consentsRequired: ['b', 'a'],
    confirmationPhrase: 'purge orders',
    approvalsRequired: 0,
    preview: { messages: 12, big: 5n },
    ...overrides,
  };
}

function setup(options: { maxActivePerPrincipal?: number } = {}) {
  const clock = createManualClock(1_000_000);
  const repository = createMemoryPlanRepository();
  const cipher = createAesGcmTestCipher();
  const store = createPlanStore({
    repository,
    cipher,
    clock,
    ids: createIdGenerator({ clock }),
    ...options,
  });
  return { clock, repository, cipher, store };
}

async function code(work: Promise<unknown>): Promise<string | undefined> {
  const error = await work.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  return error instanceof AppError ? error.code : undefined;
}

describe('executor plan-store lifecycle', () => {
  it('a new plan lives 5 minutes; one awaiting approval lives 24 hours', async () => {
    const { store, clock } = setup();

    const open = await store.create(newPlan());
    const awaiting = await store.create(newPlan({ approvalsRequired: 1 }));

    expect(open.state).toBe('open');
    expect(open.expiresAt - clock.now()).toBe(DEFAULT_PLAN_TTL.interactiveMs);
    expect(DEFAULT_PLAN_TTL.interactiveMs).toBe(5 * 60_000);
    expect(awaiting.state).toBe('awaiting-approval');
    expect(awaiting.expiresAt - clock.now()).toBe(24 * 60 * 60_000);
  });

  it('a plan is expired from its expiry instant on, and the payload is purged', async () => {
    const { store, clock, repository } = setup();
    const plan = await store.create(newPlan());

    clock.advance(DEFAULT_PLAN_TTL.interactiveMs - 1);
    expect((await store.view(plan.id))?.state).toBe('open');
    clock.advance(1);
    expect((await store.view(plan.id))?.state).toBe('expired');

    expect((await repository.get(plan.id))?.payload).toBeNull();
    expect(await code(store.open(plan.id))).toBe('PLAN_EXPIRED');
    expect(await code(store.start(plan.id))).toBe('PLAN_EXPIRED');
  });

  it('sweep expires every due plan and keeps the digest', async () => {
    const { store, clock, repository } = setup();
    const a = await store.create(newPlan());
    const b = await store.create(newPlan({ approvalsRequired: 1 }));
    clock.advance(10 * 60_000);

    expect(await store.sweep()).toBe(1);

    expect((await repository.get(a.id))?.state).toBe('expired');
    expect((await repository.get(a.id))?.digest).toBe(a.digest);
    expect((await repository.get(b.id))?.state).toBe('awaiting-approval');
  });

  it('start moves a plan to executing once; finish purges the payload and keeps the digest', async () => {
    const { store, repository } = setup();
    const plan = await store.create(newPlan());

    await store.start(plan.id);
    expect(await code(store.start(plan.id))).toBe('PLAN_STALE');
    await store.finish(plan.id, 'executed');

    const row = await repository.get(plan.id);
    expect(row).toMatchObject({ state: 'executed', payload: null });
    expect(row?.digest).toBe(plan.digest);
    expect(await code(store.finish(plan.id, 'executed'))).toBe('PLAN_STALE');
    expect(await code(store.open(plan.id))).toBe('PLAN_STALE');
  });

  it('concurrent starts: exactly one wins', async () => {
    const { store } = setup();
    const plan = await store.create(newPlan());

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => store.start(plan.id)),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('an unknown plan id is NOT_FOUND', async () => {
    const { store } = setup();

    expect(await store.view('nope' as never)).toBeUndefined();
    expect(await code(store.start('nope' as never))).toBe('NOT_FOUND');
    expect(await code(store.open('nope' as never))).toBe('NOT_FOUND');
  });

  it('bounds the open plans of a principal', async () => {
    const { store } = setup({ maxActivePerPrincipal: 1 });
    await store.create(newPlan());

    expect(await code(store.create(newPlan()))).toBe('BUDGET_EXCEEDED');
    expect(
      await code(store.create(newPlan({ principalId: 'user-2' }))),
    ).toBeUndefined();
  });

  it('a payload over the limit is refused', async () => {
    const clock = createManualClock(1);
    const store = createPlanStore({
      repository: createMemoryPlanRepository(),
      cipher: createAesGcmTestCipher(),
      clock,
      ids: createIdGenerator({ clock }),
      maxPayloadBytes: 64,
    });

    const error = await store
      .create(newPlan({ sensitivePayload: 'x'.repeat(200) }))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).status).toBe(413);
  });

  it('refuses a plan holding a value that cannot be stored faithfully', async () => {
    const { store } = setup();

    expect(
      await code(store.create(newPlan({ input: { when: new Date() } }))),
    ).toBe('INTERNAL');
  });
});

describe('executor plan-store sealing', () => {
  it('opens to the same input and payload, bigint and bytes included', async () => {
    const { store } = setup();
    const plan = await store.create(newPlan());

    const opened = await store.open(plan.id);

    expect(opened.input).toEqual({
      name: 'orders',
      bytes: Uint8Array.of(1, 2),
      count: 3n,
    });
    expect(opened.sensitivePayload).toEqual({ body: 'secret' });
    expect(opened.view.preview).toEqual({ messages: 12, big: 5n });
  });

  it('keeps the input and the payload out of the stored row in the clear', async () => {
    const { store, repository } = setup();
    const plan = await store.create(newPlan());

    const row = await repository.get(plan.id);
    const text = JSON.stringify({ ...row, payload: undefined });

    expect(text).not.toContain('secret');
    expect(Buffer.from(row?.payload ?? []).toString('latin1')).not.toContain(
      'secret',
    );
    expect(Buffer.from(row?.payload ?? []).toString('latin1')).not.toContain(
      'orders',
    );
  });

  it('the digest does not depend on the order of consents, and covers every bound field', () => {
    const fields: DigestFields = {
      actionId,
      inputHash: 'i',
      payloadHash: null,
      principalId: 'p',
      onBehalfOfId: null,
      profileFingerprint: null,
      env: 'prod',
      risk: 'high',
      approvalsRequired: 0,
      confirmationPhrase: null,
      consentsRequired: ['a', 'b'],
      gatesJson: '[]',
      warningsJson: '[]',
      previewJson: '{}',
    };
    const base = computePlanDigest(fields);

    expect(computePlanDigest({ ...fields, consentsRequired: ['b', 'a'] })).toBe(
      base,
    );
    const changed: Partial<typeof fields>[] = [
      { actionId: 'x.y' as ActionId },
      { inputHash: 'j' },
      { payloadHash: 'h' },
      { principalId: 'q' },
      { onBehalfOfId: 'q' },
      { profileFingerprint: 'f' },
      { env: 'dev' },
      { risk: 'low' },
      { approvalsRequired: 1 },
      { confirmationPhrase: 'go' },
      { consentsRequired: ['a'] },
      { gatesJson: '[{}]' },
      { warningsJson: '[{}]' },
      { previewJson: '{"a":1}' },
    ];
    for (const change of changed) {
      expect(computePlanDigest({ ...fields, ...change })).not.toBe(base);
    }
  });

  it('a ciphertext moved to another plan row does not open (AAD binds the id)', async () => {
    const { store, repository, clock } = setup();
    const a = await store.create(newPlan());
    const b = await store.create(newPlan());
    const rowA = await repository.get(a.id);
    const rowB = await repository.get(b.id);

    await repository.update(
      b.id,
      rowB?.version ?? 0,
      { payload: rowA?.payload ?? null },
      clock.now(),
    );

    expect(await code(store.open(b.id))).toBe('PLAN_STALE');
    expect(await code(store.open(a.id))).toBeUndefined();
  });

  it('a payload sealed with another key does not open', async () => {
    const clock = createManualClock(1);
    const repository = createMemoryPlanRepository();
    const ids = createIdGenerator({ clock });
    const writer = createPlanStore({
      repository,
      cipher: createAesGcmTestCipher(),
      clock,
      ids,
    });
    const reader = createPlanStore({
      repository,
      cipher: createAesGcmTestCipher(),
      clock,
      ids,
    });
    const plan = await writer.create(newPlan());

    expect(await code(reader.open(plan.id))).toBe('PLAN_STALE');
  });

  it('a plan whose payload is gone while still live is PLAN_STALE', async () => {
    const { store, repository, clock } = setup();
    const plan = await store.create(newPlan());
    const row = await repository.get(plan.id);
    await repository.update(
      plan.id,
      row?.version ?? 0,
      { payload: null },
      clock.now(),
    );

    expect(await code(store.open(plan.id))).toBe('PLAN_STALE');
  });
});

describe('executor plan-store approvals', () => {
  it('needs the required number of distinct approvers; the last one restarts a 5 minute window', async () => {
    const { store, clock } = setup();
    const plan = await store.create(newPlan({ approvalsRequired: 2 }));
    clock.advance(60_000);

    const one = await store.approve(plan.id, 'a1', 'approve');
    clock.advance(60_000);
    const two = await store.approve(plan.id, 'a2', 'approve', 'looks fine');

    expect(one.state).toBe('awaiting-approval');
    expect(two.state).toBe('approved');
    expect(two.expiresAt - clock.now()).toBe(5 * 60_000);
    expect(two.approvals.granted.map((g) => g.by)).toEqual(['a1', 'a2']);
  });

  it('refuses the requester, a person the requester acts for, a repeat and a late decision', async () => {
    const { store } = setup();
    const plan = await store.create(
      newPlan({ approvalsRequired: 1, onBehalfOfId: 'boss' }),
    );

    expect(await code(store.approve(plan.id, 'user-1', 'approve'))).toBe(
      'FORBIDDEN_RBAC',
    );
    expect(await code(store.approve(plan.id, 'boss', 'approve'))).toBe(
      'FORBIDDEN_RBAC',
    );
    await store.approve(plan.id, 'a1', 'approve');
    expect(await code(store.approve(plan.id, 'a2', 'approve'))).toBe(
      'PLAN_STALE',
    );
  });

  it('refuses a plan that is not awaiting approval', async () => {
    const { store } = setup();
    const plan = await store.create(newPlan());

    expect(await code(store.approve(plan.id, 'a1', 'approve'))).toBe(
      'PLAN_STALE',
    );
  });

  it('records the digest each approver saw and rejects an over-long note', async () => {
    const { store, repository } = setup();
    const plan = await store.create(newPlan({ approvalsRequired: 1 }));

    expect(
      await code(store.approve(plan.id, 'a1', 'approve', 'x'.repeat(501))),
    ).toBe('VALIDATION_FAILED');
    await store.approve(plan.id, 'a1', 'approve', 'ok');

    expect((await repository.get(plan.id))?.approvals).toEqual([
      expect.objectContaining({
        by: 'a1',
        decision: 'approve',
        digest: plan.digest,
        note: 'ok',
      }),
    ]);
  });

  it('concurrent approvals from different approvers are all recorded', async () => {
    const { store } = setup();
    const plan = await store.create(newPlan({ approvalsRequired: 3 }));

    await Promise.all(
      ['a1', 'a2', 'a3'].map((by) => store.approve(plan.id, by, 'approve')),
    );

    expect((await store.view(plan.id))?.state).toBe('approved');
  });

  it('an expired plan cannot be approved', async () => {
    const { store, clock } = setup();
    const plan = await store.create(newPlan({ approvalsRequired: 1 }));
    clock.advance(25 * 60 * 60_000);

    expect(await code(store.approve(plan.id, 'a1', 'approve'))).toBe(
      'PLAN_EXPIRED',
    );
  });
});
