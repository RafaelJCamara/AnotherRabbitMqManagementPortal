import { defineAction, registry, type PlanId } from '@app/contracts';
import { createRoleAuthorizer, implementAction } from '@app/kernel';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createTestEngine, type TestEngine } from './create-test-engine.ts';

const metaDef = registry.actions.find((action) => action.id === 'meta.get');
if (metaDef === undefined) throw new Error('meta.get is not registered');

const calls = { meta: 0, rename: 0, purge: 0 };

const metaImpl = implementAction(metaDef, {
  execute: () => {
    calls.meta += 1;
    return Promise.resolve({
      engineVersion: '0.0.0-test',
      apiVersion: 'v1' as const,
      mode: 'local' as const,
    });
  },
});

const renameDef = defineAction({
  id: 'spec.rename',
  kind: 'command',
  summary: 'Rename',
  input: z.strictObject({ cid: z.string().min(1) }),
  output: z.strictObject({ renamed: z.literal(true) }),
  permission: 'topology.admin',
  risk: 'low',
  planning: 'none',
  audit: 'attempt+outcome',
  target: (input) => ({ connectionId: input.cid as never }),
  http: { method: 'POST', path: '/spec-only/{cid}/rename' },
  since: '1.0',
});
const renameImpl = implementAction(renameDef, {
  plan: () =>
    Promise.resolve({
      preview: {},
      gates: [],
      warnings: [],
      consentsRequired: [],
    }),
  revalidate: () => Promise.resolve('valid' as const),
  execute: () => {
    calls.rename += 1;
    return Promise.resolve({ renamed: true as const });
  },
});

const purgeDef = defineAction({
  id: 'spec.purge',
  kind: 'command',
  summary: 'Purge',
  input: z.strictObject({ cid: z.string().min(1) }),
  output: z.strictObject({ purged: z.literal(true) }),
  permission: 'messages.purge',
  risk: 'critical',
  planning: 'required',
  audit: 'attempt+outcome',
  target: (input) => ({ connectionId: input.cid as never }),
  http: { method: 'POST', path: '/spec-only/{cid}/purge' },
  since: '1.0',
});
const purgeImpl = implementAction(purgeDef, {
  plan: () =>
    Promise.resolve({
      preview: {},
      gates: [],
      warnings: [],
      consentsRequired: [],
    }),
  revalidate: () => Promise.resolve('valid' as const),
  execute: () => {
    calls.purge += 1;
    return Promise.resolve({ purged: true as const });
  },
});

const extended = {
  actions: [...registry.actions, renameDef, purgeDef],
  topics: [],
};

let engine: TestEngine;
afterEach(async () => {
  calls.meta = 0;
  calls.rename = 0;
  calls.purge = 0;
  await engine.close();
});

describe('createTestEngine', () => {
  it('AC-1 inject sends the launch token and the router answers from the registry', async () => {
    engine = createTestEngine({ actions: [metaImpl] });

    const answer = await engine.inject({ path: '/meta' });

    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toEqual({
      engineVersion: '0.0.0-test',
      apiVersion: 'v1',
      mode: 'local',
    });
    expect(calls.meta).toBe(1);
  });

  it('AC-2 a request without the launch token, or with another one, is 401 and nothing runs', async () => {
    engine = createTestEngine({ actions: [metaImpl] });

    const none = await engine.inject({ path: '/meta', authenticated: false });
    const wrong = await engine.inject({
      path: '/meta',
      authenticated: false,
      headers: { authorization: `Bearer ${'a'.repeat(43)}` },
    });

    expect(none.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(calls.meta).toBe(0);
  });

  it('AC-3 a mutation is locked as prod until the launch-token user arms the connection', async () => {
    engine = createTestEngine({
      actions: [renameImpl],
      registry: extended,
    });
    const request = {
      method: 'POST',
      path: '/spec-only/c1/rename',
      payload: {},
      headers: { 'idempotency-key': 'spec-key-0001' },
    } as const;

    const locked = await engine.inject(request);
    expect(locked.statusCode).toBe(422);
    expect(locked.json()).toMatchObject({ code: 'GATE_BLOCKED' });
    expect(calls.rename).toBe(0);
    expect(engine.audit.attempts).toEqual([]);

    engine.arm('c1');
    const open = await engine.inject(request);
    expect(open.statusCode).toBe(200);
    expect(open.json()).toEqual({ renamed: true });
    expect(calls.rename).toBe(1);
    // Arming one connection opens no other.
    const other = await engine.inject({
      ...request,
      path: '/spec-only/c2/rename',
    });
    expect(other.statusCode).toBe(422);
  });

  it('AC-4 withArming lets a spec arm over HTTP, as the person at the UI does', async () => {
    engine = createTestEngine({
      actions: [renameImpl],
      registry: extended,
      withArming: true,
    });

    const armed = await engine.inject({
      method: 'POST',
      path: '/connections/c1/arm',
      payload: {},
      headers: { 'idempotency-key': 'spec-key-0002' },
    });
    expect(armed.statusCode).toBe(200);
    expect(armed.json()).toMatchObject({ armed: true, connectionId: 'c1' });

    const open = await engine.inject({
      method: 'POST',
      path: '/spec-only/c1/rename',
      payload: {},
      headers: { 'idempotency-key': 'spec-key-0003' },
    });
    expect(open.statusCode).toBe(200);
  });

  it('AC-5 a custom authorizer is honoured: no grant, no call, no audit row', async () => {
    engine = createTestEngine({
      actions: [metaImpl],
      authorizer: createRoleAuthorizer({}),
    });

    const answer = await engine.inject({ path: '/meta' });

    expect(answer.statusCode).toBe(403);
    expect(answer.json()).toMatchObject({ code: 'FORBIDDEN_RBAC' });
    expect(calls.meta).toBe(0);
  });

  it('AC-6 a run leaves the audit rows and the receipt the spec can read', async () => {
    engine = createTestEngine({ actions: [renameImpl], registry: extended });
    engine.arm('c1');

    await engine.inject({
      method: 'POST',
      path: '/spec-only/c1/rename',
      payload: {},
      headers: { 'idempotency-key': 'spec-key-0004' },
    });

    expect(engine.audit.attempts.map((row) => row.actionId)).toEqual([
      'spec.rename',
    ]);
    expect(engine.audit.outcomes).toMatchObject([
      { result: 'ok', attemptSeq: 1 },
    ]);
    expect(engine.receipts.records).toMatchObject([
      { actionId: 'spec.rename', result: 'ok' },
    ]);
  });

  it('AC-7 a plan made over HTTP executes under context(), and only for the launch-token user', async () => {
    engine = createTestEngine({ actions: [purgeImpl], registry: extended });
    engine.arm('c1');

    const answer = await engine.inject({
      method: 'POST',
      path: '/spec-only/c1/purge',
      payload: {},
    });
    expect(answer.statusCode).toBe(428);
    const planId = /\/plans\/([^/]+)$/.exec(
      String(answer.headers.location),
    )?.[1] as PlanId | undefined;
    if (planId === undefined) throw new Error('no plan in Location');
    expect(calls.purge).toBe(0);

    const stranger = engine.context({
      principal: { ...engine.principal, id: 'someone-else' },
    });
    await expect(
      engine.executor.execute(
        { planId, consents: [], idempotencyKey: 'spec-key-0005' },
        stranger,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_RBAC' });
    expect(calls.purge).toBe(0);

    const done = await engine.executor.execute(
      { planId, consents: [], idempotencyKey: 'spec-key-0006' },
      engine.context(),
    );
    expect(done).toMatchObject({ kind: 'output', output: { purged: true } });
    expect(calls.purge).toBe(1);
  });

  it('AC-8 an action in the registry that nothing registered is routed but denied', async () => {
    engine = createTestEngine({ actions: [], registry: extended });

    const answer = await engine.inject({ path: '/meta' });

    expect(answer.statusCode).toBeGreaterThanOrEqual(400);
    expect(calls.meta).toBe(0);
  });

  it('AC-10 every engine has its own 256-bit launch token, and one engine does not accept the other', async () => {
    engine = createTestEngine({ actions: [metaImpl] });
    const other = createTestEngine({ actions: [metaImpl] });

    expect(engine.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(other.token).not.toBe(engine.token);
    const crossed = await engine.inject({
      path: '/meta',
      authenticated: false,
      headers: { authorization: `Bearer ${other.token}` },
    });
    await other.close();

    expect(crossed.statusCode).toBe(401);
  });

  it('AC-9 the principal is the launch-token user and the engine never listens on a socket', () => {
    engine = createTestEngine({ actions: [] });

    expect(engine.principal).toMatchObject({
      kind: 'local-token',
      surface: 'ui',
      unattended: false,
    });
    expect(engine.app.server.listening).toBe(false);
  });
});
