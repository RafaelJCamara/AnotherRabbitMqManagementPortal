// The connection actions of M0-44 through the real router: what a client sees for the acceptance
// criteria, for the production lock and for secrets (I-10). The per-action specs next to this one
// are the generated golden-path checks.
import {
  bundlesExport,
  connectionsTestAmqp,
  connectionsTestHttp,
  connectionsUpdate,
} from '@app/contracts';
import { createCanaryScanner } from '@app/kernel';
import {
  createBundlesExportAction,
  createConnectionsFakeDeps,
  createConnectionsTestAmqpAction,
  createConnectionsTestHttpAction,
  createConnectionsUpdateAction,
} from '@app/svc-connections';
import { afterEach, describe, expect, it } from 'vitest';

import { createTestEngine, type TestEngine } from '../create-test-engine.ts';

const KEY = 'connections-http-spec-0001';
const SECRET = 'CANARY-http-spec-Xk3pL9wQ2m';
const scanner = createCanaryScanner([SECRET]);
let engine: TestEngine;

afterEach(async () => {
  await engine.close();
});

describe('connections over HTTP', () => {
  it('HTTP-1 AC-2 with HTTP ok and the AMQP port blocked, POST /connections/test-amqp answers "AMQP port blocked" with the AMQP gates closed, and the password in the draft is not in the answer', async () => {
    const deps = createConnectionsFakeDeps({ ownerId: 'local-token' });
    engine = createTestEngine({
      actions: [
        createConnectionsTestHttpAction(deps),
        createConnectionsTestAmqpAction(deps),
      ],
    });
    deps.prober.amqpResult = { ok: false, failure: { reason: 'unreachable' } };
    const draft = { uri: `amqps://svc:${SECRET}@mq.example:5671/%2Fprod` };

    const http = await engine.inject({
      method: 'POST',
      path: '/connections/test-http',
      payload: { draft },
    });
    const amqp = await engine.inject({
      method: 'POST',
      path: '/connections/test-amqp',
      payload: { draft },
    });

    expect(http.statusCode).toBe(200);
    expect(connectionsTestHttp.output.parse(http.json())).toMatchObject({
      ok: true,
      target: { url: 'https://mq.example:15671' },
    });
    expect(amqp.statusCode).toBe(200);
    const body = connectionsTestAmqp.output.parse(amqp.json());
    expect(body.failure?.message).toMatch(/^AMQP port blocked/);
    expect(Object.values(body.gates).every((gate) => !gate.enabled)).toBe(true);
    // The probes got the login, and no answer, audit row or receipt has it.
    expect(JSON.stringify(deps.prober.httpCalls)).toContain(SECRET);
    expect(scanner.scan(http.body)).toEqual([]);
    expect(scanner.scan(amqp.body)).toEqual([]);
    expect(
      scanner.scan(
        JSON.stringify([
          engine.audit.attempts,
          engine.audit.outcomes,
          engine.receipts.records,
        ]),
      ),
    ).toEqual([]);
  });

  it('HTTP-2 changing a saved connection is locked in production until it is armed (the router sends no environment class), and the answer holds no secret', async () => {
    const deps = createConnectionsFakeDeps({ ownerId: 'local-token' });
    engine = createTestEngine({
      actions: [createConnectionsUpdateAction(deps)],
    });
    const change = {
      amqp: { auth: { kind: 'plain', username: 'svc', password: SECRET } },
    };

    const locked = await engine.inject({
      method: 'PATCH',
      path: '/connections/c1',
      payload: change,
      headers: { 'idempotency-key': KEY },
    });
    expect(locked.statusCode).toBe(422);
    expect(locked.json()).toMatchObject({
      code: 'GATE_BLOCKED',
      gate: { source: 'prod-lock', fix: { actionId: 'ops.arm' } },
    });
    expect(scanner.scan(locked.body)).toEqual([]);
    expect(await deps.store.credentials('c1')).toEqual([]);

    engine.arm('c1');
    const done = await engine.inject({
      method: 'PATCH',
      path: '/connections/c1',
      payload: change,
      headers: { 'idempotency-key': `${KEY}-2` },
    });
    expect(done.statusCode).toBe(200);
    expect(
      connectionsUpdate.output.parse(done.json()).profile.amqp.auth,
    ).toEqual({
      kind: 'plain',
      username: 'svc',
      secret: { isSet: true, updatedAt: expect.any(Number) as number },
    });
    expect(scanner.scan(done.body)).toEqual([]);
    expect(
      scanner.scan(
        JSON.stringify([
          engine.audit.attempts,
          engine.audit.outcomes,
          engine.receipts.records,
        ]),
      ),
    ).toEqual([]);
    expect(
      (await deps.store.credentials('c1')).map((row) => row.protocol),
    ).toEqual(['amqp']);
  });

  it('HTTP-3 AC-2 POST /bundles/export answers a bundle with no secret, for a connection that has some', async () => {
    const deps = createConnectionsFakeDeps({ ownerId: 'local-token' });
    engine = createTestEngine({
      actions: [
        createConnectionsUpdateAction(deps),
        createBundlesExportAction(deps),
      ],
    });
    engine.arm('c1');
    await engine.inject({
      method: 'PATCH',
      path: '/connections/c1',
      payload: {
        http: { auth: { kind: 'bearer', token: SECRET } },
        amqp: { auth: { kind: 'plain', username: 'svc', password: SECRET } },
      },
      headers: { 'idempotency-key': KEY },
    });

    const exported = await engine.inject({
      method: 'POST',
      path: '/bundles/export',
      payload: {},
    });

    expect(exported.statusCode).toBe(200);
    const { bundle } = bundlesExport.output.parse(exported.json());
    expect(bundle.profiles).toHaveLength(1);
    expect(bundle.profiles[0]?.amqp.auth).toEqual({
      kind: 'plain',
      username: 'svc',
    });
    expect(scanner.scan(exported.body)).toEqual([]);
  });
});
