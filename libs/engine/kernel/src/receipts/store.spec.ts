import type { ActionId, PlanId } from '@app/contracts';
import { describe, expect, it } from 'vitest';

import type { ExecutionRecord } from '../actions/hooks.ts';
import {
  createMemoryReceiptRepository,
  createTestPrincipal,
} from '../actions/testing.ts';
import { createManualClock } from '../clock/clock.ts';
import { createIdGenerator } from '../ids/ids.ts';
import { createReceiptStore, MAX_RECEIPT_DETAIL_BYTES } from './store.ts';

function setup() {
  const clock = createManualClock(1_700_000_000_000);
  const repository = createMemoryReceiptRepository();
  const store = createReceiptStore({
    repository,
    clock,
    ids: createIdGenerator({ clock }),
  });
  return { clock, repository, store };
}

function execution(over: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    actionId: 'queues.purge' as ActionId,
    principal: createTestPrincipal(),
    correlationId: 'corr-1',
    env: 'prod',
    risk: 'critical',
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_000_250,
    result: 'ok',
    ...over,
  };
}

describe('receipt store: every execution is recorded (I-13)', () => {
  it('AC-1 receipt: records who, what, the plan, the result and the audit row, and reads it back', async () => {
    const { store, clock } = setup();

    const id = await store.record(
      execution({
        planId: 'plan-1' as PlanId,
        planDigest: 'd'.repeat(64),
        auditSeq: 7,
        principal: createTestPrincipal({
          id: 'agent',
          onBehalfOf: createTestPrincipal({ id: 'boss' }),
        }),
        detail: { perMessage: [{ position: 1, outcome: 'kept' }] },
      }),
    );

    expect(await store.get(id)).toEqual({
      id,
      actionId: 'queues.purge',
      planId: 'plan-1',
      planDigest: 'd'.repeat(64),
      principalId: 'agent',
      onBehalfOfId: 'boss',
      correlationId: 'corr-1',
      env: 'prod',
      risk: 'critical',
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_000_250,
      result: 'ok',
      code: null,
      jobId: null,
      auditSeq: 7,
      detail: { perMessage: [{ position: 1, outcome: 'kept' }] },
      createdAt: clock.now(),
    });
  });

  it('AC-1 receipt: ids are unique and an unknown id reads as undefined', async () => {
    const { store } = setup();

    const a = await store.record(execution());
    const b = await store.record(execution());

    expect(a).not.toBe(b);
    expect(await store.get('nope' as never)).toBeUndefined();
  });

  it('AC-1 receipt: an error result keeps its code', async () => {
    const { store } = setup();

    const id = await store.record(
      execution({ result: 'error', code: 'BROKER_UNREACHABLE' }),
    );

    expect(await store.get(id)).toMatchObject({
      result: 'error',
      code: 'BROKER_UNREACHABLE',
    });
  });

  it('AC-1 receipt: a store that cannot write rejects, so the executor can flag it', async () => {
    const { store, repository } = setup();
    repository.failInserts(true);

    await expect(store.record(execution())).rejects.toThrow('receipt store');
  });

  it('AC-1 receipt: a detail too large to keep is refused, not cut (no silent loss)', async () => {
    const { store, repository } = setup();

    await expect(
      store.record(
        execution({ detail: { blob: 'x'.repeat(MAX_RECEIPT_DETAIL_BYTES) } }),
      ),
    ).rejects.toThrow(/too large/);

    expect(repository.rows.size).toBe(0);
  });

  it('AC-1 receipt: secrets in the detail are masked by key and by value (I-10)', async () => {
    const { store, repository } = setup();
    const canary = 'S3cr3t-canary';

    const id = await store.record(
      execution({
        detail: {
          password: canary,
          body: canary,
          headers: { authorization: `Bearer ${canary}aaaaaaaa` },
          note: `amqp://u:${canary}@host/vhost`,
          nested: [{ token: canary }, `?apikey=${canary}`],
        },
        principal: createTestPrincipal({ id: `amqp://u:${canary}@h` }),
      }),
    );

    expect(JSON.stringify([...repository.rows.values()])).not.toContain(canary);
    expect((await store.get(id))?.detail).toMatchObject({
      password: '[REDACTED]',
      body: '[REDACTED]',
    });
  });

  it('AC-1 receipt: purgeBefore deletes old receipts only, up to the limit', async () => {
    const { store, clock } = setup();
    await store.record(execution());
    await store.record(execution());
    clock.advance(1_000);
    const young = await store.record(execution());

    expect(await store.purgeBefore(clock.now(), 1)).toBe(1);
    expect(await store.purgeBefore(clock.now(), 10)).toBe(1);
    expect(await store.get(young)).toBeDefined();
  });
});
