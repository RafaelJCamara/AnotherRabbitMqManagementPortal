// M1-19 slice D: messages.publish-history.get. The generated base tests (contract, deny by default,
// a query leaves no audit row) keep their place over a seeded store; the tests named `M1-19 slice D`
// prove that the action asks the store for the caller's own entry on the connection asked for, that
// one text answers every reason for not finding it, and that what comes back fits the contract with
// its secrets masked. The masking and the sealing are proved in internal/publish-history.spec.ts
// (AC-11) and in messages-publish.spec.ts (AC-10, which reads a publish back through this action).
import { checkRegistry } from '@app/contracts';
import {
  AppError,
  createCanaryScanner,
  createRoleAuthorizer,
  createTestContext,
  createTestExecutor,
  createTestPrincipal,
  denyAllAuthorizer,
  REDACTED,
  type TestExecutor,
} from '@app/kernel';
import { describe, expect, it } from 'vitest';

import {
  createSubject,
  sampleInput,
} from './messages-publish-history-get.fixture';

const { def } = createSubject().action;
const KEY = 'generated-spec-key-0001';
const DAY = 24 * 60 * 60 * 1000;
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

/** Runs the action as `user` (user-1 by default) and resolves with its output. */
async function get(engine: TestExecutor, input: unknown, user = 'user-1') {
  const outcome = await engine.executor.run(
    def,
    input,
    createTestContext({
      principal: createTestPrincipal({ id: user }),
      idempotencyKey: KEY,
    }),
  );
  if (outcome.kind !== 'output') throw new Error(`got ${outcome.kind}`);
  return outcome.output;
}

/** A store with `entry-1` recorded as user-1 on c1, and the action registered on an executor. */
async function setup() {
  const subject = createSubject();
  const engine = createTestExecutor();
  engine.executor.register(subject.action);
  await subject.record();
  return { ...subject, engine };
}

async function refusal(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

describe('messages.publish-history.get base', () => {
  it('the contract passes the kit invariants and the sample input fits it', () => {
    expect(checkRegistry({ actions: [def], topics: [] })).toEqual([]);
    expect(def.input.safeParse(sampleInput).success).toBe(true);
  });

  it('a principal that does not hold messages.publish is refused before anything runs', async () => {
    const subject = createSubject();
    const engine = createTestExecutor({
      executor: {
        authorizer: createRoleAuthorizer({ operator: ['messages.publish'] }),
      },
    });
    engine.executor.register(subject.action);
    await subject.record();

    await expect(
      engine.executor.run(
        def,
        sampleInput,
        createTestContext({
          principal: createTestPrincipal({ roles: ['intruder'] }),
          idempotencyKey: KEY,
        }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_RBAC' });
    expect(engine.audit.attempts).toEqual([]);
  });

  it('with no authorizer wired every call is refused: deny by default', async () => {
    const subject = createSubject();
    const engine = createTestExecutor({
      executor: { authorizer: denyAllAuthorizer },
    });
    engine.executor.register(subject.action);
    await subject.record();

    await expect(get(engine, sampleInput)).rejects.toMatchObject({
      code: 'FORBIDDEN_RBAC',
    });
  });

  it('a principal that holds messages.publish is let through, and a read leaves no audit row and no receipt', async () => {
    const subject = createSubject();
    const engine = createTestExecutor({
      executor: {
        authorizer: createRoleAuthorizer({ operator: ['messages.publish'] }),
      },
    });
    engine.executor.register(subject.action);
    await subject.record();

    const outcome = await engine.executor.run(
      def,
      sampleInput,
      createTestContext({
        principal: createTestPrincipal({ roles: ['operator'] }),
        idempotencyKey: KEY,
      }),
    );

    expect(outcome.kind).toBe('output');
    if (outcome.kind === 'output') {
      expect(def.output.safeParse(outcome.output).success).toBe(true);
    }
    expect(engine.audit.attempts).toEqual([]);
    expect(engine.receipts.records).toEqual([]);
  });
});

describe('messages.publish-history.get (M1-19 slice D)', () => {
  it('M1-19 slice D: get answers the caller own entry with the data to send it again', async () => {
    const { engine, store, clock } = await setup();
    const id = await store.record({
      ownerId: 'user-1',
      connectionId: 'c1',
      vhost: 'billing',
      at: clock.now(),
      exchange: 'events',
      routingKey: 'orders.paid',
      copies: 3,
      summary: {
        confirmed: 2,
        nacked: 0,
        returned: 1,
        blocked: 0,
        timeout: 0,
        failed: 0,
        'not-sent': 0,
      },
      props: { contentType: 'application/json', deliveryMode: 2, priority: 4 },
      headers: { 'x-tenant': { t: 'string', v: 'acme' } },
      body: text('{"n":1}'),
    });

    const answer = await get(engine, { cid: 'c1', entryId: id });

    expect(def.output.safeParse(answer).success).toBe(true);
    expect(answer.entry).toMatchObject({
      id,
      vhost: 'billing',
      exchange: 'events',
      routingKey: 'orders.paid',
      copies: 3,
      summary: { confirmed: 2, returned: 1 },
      bodyBytes: 7,
    });
    expect(answer.entry.expiresAt).toBe(answer.entry.at + 30 * DAY);
    expect(answer.resend).toEqual({
      exchange: 'events',
      routingKey: 'orders.paid',
      props: { contentType: 'application/json', deliveryMode: 2, priority: 4 },
      headers: { 'x-tenant': { t: 'string', v: 'acme' } },
      body: { encoding: 'utf8', data: '{"n":1}' },
      copies: 3,
      masked: [],
    });
  });

  it('M1-19 slice D: get replaces what the mask recognises, names where, and keeps the secret out of the answer', async () => {
    const { engine, record } = await setup();
    const canary = {
      header: 'CANARY-header-Qw4n7TxB',
      body: 'CANARY-body-Zs2k9VcM',
      url: 'CANARY-url-Hj6p3LdE',
    };
    const id = await record({
      headers: { authorization: { t: 'string', v: `Bearer ${canary.header}` } },
      body: text(
        JSON.stringify({
          password: canary.body,
          callback: `https://svc:${canary.url}@example.test/hook`,
          keep: 'plain',
        }),
      ),
    });

    const answer = await get(engine, { cid: 'c1', entryId: id });

    expect(
      createCanaryScanner(Object.values(canary)).scan(JSON.stringify(answer)),
    ).toEqual([]);
    expect(answer.resend.headers?.authorization).toEqual({
      t: 'string',
      v: REDACTED,
    });
    expect(answer.resend.body?.data).toContain('"keep":"plain"');
    expect([...answer.resend.masked].sort()).toEqual([
      'body',
      'header:authorization',
    ]);
  });

  it('M1-19 slice D: get answers a value that grew when the mask replaced secrets in it', async () => {
    const { engine, record } = await setup();
    // 253 characters in, more out: each `password=x` becomes `password=[REDACTED]`. The answer must
    // still fit its contract, or the entry could never be opened.
    const grown = 'password=x '.repeat(23);
    const id = await record({
      props: { messageId: grown },
      headers: { note: { t: 'string', v: 'password=x '.repeat(5000) } },
    });

    const answer = await get(engine, { cid: 'c1', entryId: id });

    expect(grown.length).toBeLessThanOrEqual(255);
    expect(answer.resend.props.messageId?.length).toBeGreaterThan(255);
    expect(answer.resend.masked).toEqual(
      expect.arrayContaining(['prop:messageId', 'header:note']),
    );
    expect(JSON.stringify(answer)).not.toContain('password=x');
  });

  it('M1-19 slice D: get says why there is no body, and keeps its size and hash', async () => {
    const { engine, record } = await setup();
    const binary = await record({ body: Uint8Array.from([0, 255, 254, 1]) });
    const big = await record({ body: new Uint8Array(70 * 1024).fill(97) });

    const first = await get(engine, { cid: 'c1', entryId: binary });
    const second = await get(engine, { cid: 'c1', entryId: big });

    expect(first.resend.bodyOmitted).toBe('binary');
    expect(first.resend.body).toBeUndefined();
    expect(first.entry.bodyBytes).toBe(4);
    expect(second.resend.bodyOmitted).toBe('too-large');
    expect(second.entry.bodyBytes).toBe(70 * 1024);
    expect(second.entry.bodySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('M1-19 slice D: get answers NOT_FOUND with one text for another owner, another connection, an unknown id and an expired entry', async () => {
    const { engine, clock, record } = await setup();
    const theirs = await record({ ownerId: 'user-2' });
    const elsewhere = await record({ connectionId: 'c2' });
    const problems: AppError[] = [];

    problems.push(
      await refusal(get(engine, { cid: 'c1', entryId: theirs })),
      await refusal(get(engine, { cid: 'c1', entryId: elsewhere })),
      await refusal(get(engine, { cid: 'c1', entryId: 'no-such-entry' })),
    );
    // The right owner on the right connection can read their own, so the refusals are about scope.
    expect((await get(engine, sampleInput)).entry.id).toBe('entry-1');
    expect(
      (await get(engine, { cid: 'c1', entryId: theirs }, 'user-2')).entry.id,
    ).toBe(theirs);
    // The connection is the one asked for, not a fixed one: c2's own entry reads on c2 and not on c1,
    // and c1's entry does not read on c2.
    expect(
      (await get(engine, { cid: 'c2', entryId: elsewhere })).entry.id,
    ).toBe(elsewhere);
    problems.push(
      await refusal(get(engine, { cid: 'c2', entryId: 'entry-1' })),
    );
    clock.advance(30 * DAY);
    problems.push(await refusal(get(engine, sampleInput)));

    expect(problems.map((problem) => problem.code)).toEqual(
      problems.map(() => 'NOT_FOUND'),
    );
    expect(new Set(problems.map((problem) => problem.detail)).size).toBe(1);
  });

  it('M1-19 slice D: get refuses an unknown field, an entry id that is empty or too long, and a missing connection', async () => {
    const { engine } = await setup();

    for (const input of [
      { cid: 'c1', entryId: 'entry-1', extra: 1 },
      { cid: 'c1', entryId: '' },
      { cid: 'c1', entryId: 'x'.repeat(65) },
      { entryId: 'entry-1' },
    ]) {
      expect((await refusal(get(engine, input))).code).toBe(
        'VALIDATION_FAILED',
      );
    }
  });
});
