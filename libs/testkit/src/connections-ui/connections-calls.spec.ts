// M0-52 AC-12, the end-to-end half: the calls the connections UI makes, sent through the real router over the real
// executor (`createTestEngine`) to the real actions of the connections service, with its in-memory fakes for the
// store, the sealer and the prober. The bodies are written the way the UI's form model builds them
// (`libs/ui/feature-connections/src/lib/form/form-model.ts`; this project is Node code and may not import it), with
// the header `EngineApi.call` sends for a command. The UI's own half (what the pages send, against a fake engine) is
// `connections-requests.component.spec.ts`. Every answer is parsed with the contract schema the UI parses it with.
// No browser and no real broker are involved.
import {
  connectionsCreate,
  connectionsDelete,
  connectionsGet,
  connectionsList,
  connectionsTestAmqp,
  connectionsTestHttp,
  connectionsUpdate,
  opsArm,
  opsDisarm,
} from '@app/contracts';
import { createCanaryScanner } from '@app/kernel';
import {
  createConnectionsCreateAction,
  createConnectionsDeleteAction,
  createConnectionsFakeDeps,
  createConnectionsGetAction,
  createConnectionsListAction,
  createConnectionsTestAmqpAction,
  createConnectionsTestHttpAction,
  createConnectionsUpdateAction,
} from '@app/svc-connections';
import { afterEach, describe, expect, it } from 'vitest';

import { createTestEngine, type TestEngine } from '../create-test-engine.ts';

const SECRET = 'CANARY-connections-ui-Qm7vT2xK9d';
const scanner = createCanaryScanner([SECRET]);
let engine: TestEngine;
let counter = 0;
/** What `EngineApi.call` does for a command: a fresh key of the engine's alphabet and length. */
const key = (): { 'idempotency-key': string } => ({
  'idempotency-key': `ui-calls-spec-${String((counter += 1)).padStart(4, '0')}`,
});

afterEach(async () => {
  await engine.close();
});

function connectionsEngine() {
  const deps = createConnectionsFakeDeps({ ownerId: 'local-token' });
  engine = createTestEngine({
    actions: [
      createConnectionsListAction(deps),
      createConnectionsGetAction(deps),
      createConnectionsCreateAction(deps),
      createConnectionsUpdateAction(deps),
      createConnectionsDeleteAction(deps),
      createConnectionsTestHttpAction(deps),
      createConnectionsTestAmqpAction(deps),
    ],
    withArming: true,
  });
  return deps;
}

/** A create as the form builds it (the shared login: the management login is the AMQP login). */
const CREATE = {
  name: 'Lab',
  envClass: 'prod',
  http: {
    host: 'mq.example',
    port: 15672,
    auth: { kind: 'basic', username: 'guest', password: SECRET },
  },
  amqp: {
    host: 'mq.example',
    port: 5672,
    auth: { kind: 'plain', username: 'guest', password: SECRET },
  },
} as const;

describe('the calls of the connections UI through the real router', () => {
  it('AC-12 a command without an idempotency key is refused, so the UI sends one; with it a production connection is created with nothing armed, and the answer holds no secret', async () => {
    connectionsEngine();
    const without = await engine.inject({
      method: 'POST',
      path: '/connections',
      payload: CREATE,
    });
    expect(without.statusCode).toBe(400);
    expect(without.json()).toMatchObject({
      code: 'VALIDATION_FAILED',
      detail: 'idempotencyKey is required.',
    });

    const created = await engine.inject({
      method: 'POST',
      path: '/connections',
      payload: CREATE,
      headers: key(),
    });
    expect(created.statusCode).toBe(200);
    const profile = connectionsCreate.output.parse(created.json()).profile;
    expect(profile.envClass).toBe('prod');
    expect(profile.http.auth.secret.isSet).toBe(true);
    expect(scanner.scan(created.body)).toEqual([]);

    // The list the switcher and the page read, and the one connection the page reads.
    const list = await engine.inject({
      method: 'GET',
      path: '/connections?limit=100',
    });
    expect(list.statusCode).toBe(200);
    const items = connectionsList.output.parse(list.json()).items;
    expect(items.map((p) => p.id)).toContain(profile.id);
    const one = await engine.inject({
      method: 'GET',
      path: `/connections/${profile.id}`,
    });
    expect(connectionsGet.output.parse(one.json()).profile.name).toBe('Lab');
    expect(scanner.scan(list.body)).toEqual([]);
    expect(scanner.scan(one.body)).toEqual([]);
  });

  it('AC-12 the two tests take the form draft or a saved id, answer 200 whatever the cause, and never repeat the password', async () => {
    const deps = connectionsEngine();
    const draft = {
      http: CREATE.http,
      amqp: CREATE.amqp,
    };
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
    expect(amqp.statusCode).toBe(200);
    expect(connectionsTestHttp.output.safeParse(http.json()).success).toBe(
      true,
    );
    expect(connectionsTestAmqp.output.safeParse(amqp.json()).success).toBe(
      true,
    );
    expect(scanner.scan(http.body)).toEqual([]);
    expect(scanner.scan(amqp.body)).toEqual([]);
    // A failed AMQP test is an answer with a cause, and the page shows it by code.
    deps.prober.amqpResult = { ok: false, failure: { reason: 'unreachable' } };
    const failed = await engine.inject({
      method: 'POST',
      path: '/connections/test-amqp',
      payload: { cid: 'c1' },
    });
    expect(failed.statusCode).toBe(200);
    const body = connectionsTestAmqp.output.parse(failed.json());
    expect(body.ok).toBe(false);
    expect(body.failure?.code).toBe('AMQP_PORT_BLOCKED');
  });

  it('AC-1 AC-8 an update and a delete are refused with the prod-lock gate and its fix, the unlock is ops.arm and is audited, and afterwards both go through', async () => {
    connectionsEngine();
    const change = { name: 'Renamed', http: { host: 'mq.example' } };
    const locked = await engine.inject({
      method: 'PATCH',
      path: '/connections/c1',
      payload: change,
      headers: key(),
    });
    expect(locked.statusCode).toBe(422);
    // What the page shows as sent, and what it reads to offer the unlock.
    expect(locked.json()).toMatchObject({
      code: 'GATE_BLOCKED',
      gate: {
        source: 'prod-lock',
        fix: { actionId: 'ops.arm', input: { connectionId: 'c1' } },
      },
    });
    const refusedDelete = await engine.inject({
      method: 'DELETE',
      path: '/connections/c1',
      headers: key(),
    });
    expect(refusedDelete.statusCode).toBe(422);

    // The unlock the dialog confirms: one ops.arm for that connection, with the attempt and the outcome recorded.
    const before = engine.audit.attempts.length;
    const armed = await engine.inject({
      method: 'POST',
      path: '/connections/c1/arm',
      headers: key(),
    });
    expect(armed.statusCode).toBe(200);
    const window = opsArm.output.parse(armed.json());
    expect(window.connectionId).toBe('c1');
    // The page counts the window from its length, so it must be the 15 minutes.
    expect(window.expiresAt - window.armedAt).toBe(15 * 60_000);
    expect(engine.audit.attempts.length).toBe(before + 1);
    expect(engine.audit.attempts.at(-1)?.actionId).toBe('ops.arm');
    expect(engine.audit.outcomes.length).toBeGreaterThan(0);

    const updated = await engine.inject({
      method: 'PATCH',
      path: '/connections/c1',
      payload: change,
      headers: key(),
    });
    expect(updated.statusCode).toBe(200);
    expect(connectionsUpdate.output.parse(updated.json()).profile.name).toBe(
      'Renamed',
    );
    const deleted = await engine.inject({
      method: 'DELETE',
      path: '/connections/c1',
      headers: key(),
    });
    expect(deleted.statusCode).toBe(200);
    expect(connectionsDelete.output.parse(deleted.json()).deleted).toBe(true);

    // Lock again is audited too and the lock is back.
    const disarmed = await engine.inject({
      method: 'POST',
      path: '/connections/c1/disarm',
      headers: key(),
    });
    expect(opsDisarm.output.parse(disarmed.json())).toMatchObject({
      armed: false,
      wasArmed: true,
    });
    expect(engine.audit.attempts.at(-1)?.actionId).toBe('ops.disarm');
  });

  it('AC-4 moving an address of a connection with a stored secret, without the secret, is refused as a validation problem the page shows as sent', async () => {
    connectionsEngine();
    const created = await engine.inject({
      method: 'POST',
      path: '/connections',
      payload: CREATE,
      headers: key(),
    });
    const { id } = connectionsCreate.output.parse(created.json()).profile;
    engine.arm(id);
    const moved = await engine.inject({
      method: 'PATCH',
      path: `/connections/${id}`,
      payload: { http: { host: 'other.example' } },
      headers: key(),
    });
    expect(moved.statusCode).toBe(400);
    expect(moved.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(scanner.scan(moved.body)).toEqual([]);
    // With the secret typed again it goes through.
    const again = await engine.inject({
      method: 'PATCH',
      path: `/connections/${id}`,
      payload: {
        http: {
          host: 'other.example',
          auth: { kind: 'basic', username: 'guest', password: SECRET },
        },
      },
      headers: key(),
    });
    expect(again.statusCode).toBe(200);
    expect(scanner.scan(again.body)).toEqual([]);
  });
});
