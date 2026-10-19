// The kernel's PlanStore (M0-29) over the real field cipher of @app/secrets (M0-22). The kernel and
// the adapter may not import each other, so this is where the two meet: the cipher the vault hands
// out has to satisfy the PayloadCipher port, and a plan payload has to be bound to its plan.
import { randomBytes } from 'node:crypto';

import type { ActionId } from '@app/contracts';
import {
  AppError,
  createIdGenerator,
  createManualClock,
  createMemoryPlanRepository,
  createPlanStore,
  type NewPlan,
} from '@app/kernel';
import {
  createCtlDeliveredWrap,
  createDataKeyVault,
  createMemoryDataKeyRepository,
  SecretsError,
} from '@app/secrets';
import { describe, expect, it } from 'vitest';

const SECRET_BODY = 'topsecret-publish-body-7f3a';

function newPlan(overrides: Partial<NewPlan> = {}): NewPlan {
  return {
    actionId: 'messages.publish' as ActionId,
    input: { exchange: 'orders' },
    sensitivePayload: { body: SECRET_BODY },
    principalId: 'user-1',
    onBehalfOfId: null,
    profileFingerprint: 'fp-1',
    env: 'prod',
    risk: 'high',
    gates: [],
    warnings: [],
    consentsRequired: [],
    confirmationPhrase: null,
    approvalsRequired: 0,
    preview: { size: 1 },
    ...overrides,
  };
}

async function setup() {
  const vault = createDataKeyVault({
    repository: createMemoryDataKeyRepository(),
    wraps: [createCtlDeliveredWrap()],
  });
  await vault.open({ dek: new Uint8Array(randomBytes(32)) });
  const clock = createManualClock(1_000_000);
  const repository = createMemoryPlanRepository();
  const store = createPlanStore({
    repository,
    // The port is the kernel's; the vault's cipher is structurally the same, with no import between them.
    cipher: vault.payloads,
    clock,
    ids: createIdGenerator({ clock }),
  });
  return { vault, repository, store };
}

describe('plans sealed by the vault', () => {
  it('AC-1 a plan payload is ciphertext at rest and opens back to what was sealed', async () => {
    const { store, repository } = await setup();

    const plan = await store.create(newPlan());

    const row = await repository.get(plan.id);
    const stored = Buffer.from(row?.payload ?? new Uint8Array());
    expect(stored.byteLength).toBeGreaterThan(0);
    expect(stored.includes(Buffer.from(SECRET_BODY))).toBe(false);
    const opened = await store.open(plan.id);
    expect(JSON.stringify(opened)).toContain(SECRET_BODY);
  });

  it('AC-1 a payload copied from one plan into another does not open', async () => {
    const { store, repository } = await setup();
    const a = await store.create(
      newPlan({ sensitivePayload: { body: 'for A' } }),
    );
    const b = await store.create(
      newPlan({ sensitivePayload: { body: 'for B' } }),
    );
    const rowA = await repository.get(a.id);
    const rowB = await repository.get(b.id);
    expect(rowA?.payload).toBeTruthy();

    // Someone with write access to the table swaps the ciphertext of A into B.
    await repository.update(
      b.id,
      rowB?.version ?? 0,
      { payload: rowA?.payload ?? null },
      1,
    );

    const failure = await store.open(b.id).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).code).toBe('PLAN_STALE');
  });

  it('a locked vault stops plans being sealed or opened instead of using a stale key', async () => {
    const { store, vault } = await setup();
    const plan = await store.create(newPlan());

    vault.lock();

    const creating = await store.create(newPlan()).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(creating).toBeInstanceOf(SecretsError);
    expect((creating as SecretsError).code).toBe('VAULT_LOCKED');
    const opening = await store.open(plan.id).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(opening).toBeDefined();
    expect(JSON.stringify(opening)).not.toContain(SECRET_BODY);
  });
});
