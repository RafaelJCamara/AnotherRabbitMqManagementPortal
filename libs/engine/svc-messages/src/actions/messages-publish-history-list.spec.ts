// M1-19 slice D: messages.publish-history.list. The generated base tests (contract, deny by default,
// a query leaves no audit row) keep their place over a seeded store; the tests named `M1-19 slice D`
// prove that the action reads only the caller's entries on the connection asked for, that every
// filter reaches the store, and that a window is bounded. The store itself is proved in
// internal/publish-history.spec.ts.
import { checkRegistry } from '@app/contracts';
import {
  AppError,
  createRoleAuthorizer,
  createTestContext,
  createTestExecutor,
  createTestPrincipal,
  denyAllAuthorizer,
  type TestExecutor,
} from '@app/kernel';
import { describe, expect, it } from 'vitest';

import { T0 } from './messages-publish-history.fixture';
import {
  createSubject,
  sampleInput,
} from './messages-publish-history-list.fixture';

const { def } = createSubject().action;
const KEY = 'generated-spec-key-0001';
const DAY = 24 * 60 * 60 * 1000;

/** Runs the action as `user` (user-1 by default) and resolves with its output. */
async function list(engine: TestExecutor, input: unknown, user = 'user-1') {
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

function setup() {
  const subject = createSubject();
  const engine = createTestExecutor();
  engine.executor.register(subject.action);
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

describe('messages.publish-history.list base', () => {
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

    await expect(list(engine, sampleInput)).rejects.toMatchObject({
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

describe('messages.publish-history.list (M1-19 slice D)', () => {
  it('M1-19 slice D: list answers the caller own entries on the connection asked for, newest first', async () => {
    const { engine, clock, record } = setup();
    await record({ routingKey: 'old' });
    clock.advance(1000);
    await record({ routingKey: 'new' });
    await record({ ownerId: 'user-2', routingKey: 'theirs' });
    await record({ connectionId: 'c2', routingKey: 'elsewhere' });

    const mine = await list(engine, { cid: 'c1' });
    const theirs = await list(engine, { cid: 'c1' }, 'user-2');
    const other = await list(engine, { cid: 'c2' });
    const none = await list(engine, { cid: 'c3' });

    expect(mine.entries.map((entry) => entry.routingKey)).toEqual([
      'new',
      'old',
    ]);
    expect(theirs.entries.map((entry) => entry.routingKey)).toEqual(['theirs']);
    expect(other.entries.map((entry) => entry.routingKey)).toEqual([
      'elsewhere',
    ]);
    expect(none.entries).toEqual([]);
    expect(mine.nextCursor).toBeUndefined();
  });

  it('M1-19 slice D: list holds the plain facts only, never a property, a header or the body', async () => {
    const { engine, record } = setup();
    await record({
      props: { correlationId: 'PROP-VALUE-1' },
      headers: { 'x-tenant': { t: 'string', v: 'HEADER-VALUE-1' } },
      body: new TextEncoder().encode('BODY-VALUE-1'),
    });

    const answer = await list(engine, sampleInput);

    expect(Object.keys(answer.entries[0] ?? {}).sort()).toEqual([
      'at',
      'bodyBytes',
      'bodySha256',
      'copies',
      'exchange',
      'expiresAt',
      'id',
      'routingKey',
      'summary',
      'vhost',
    ]);
    expect(JSON.stringify(answer)).not.toMatch(
      /PROP-VALUE-1|HEADER-VALUE-1|BODY-VALUE-1/,
    );
    expect(answer.entries[0]).toMatchObject({
      id: 'entry-1',
      vhost: '/',
      bodyBytes: 12,
    });
  });

  it('M1-19 slice D: list passes every filter to the store, and an empty exchange is the default exchange', async () => {
    const { engine, clock, record } = setup();
    await record({ vhost: '/', exchange: '', routingKey: 'orders.new' });
    clock.advance(DAY);
    await record({ vhost: '/', exchange: 'events', routingKey: 'orders.paid' });
    clock.advance(DAY);
    await record({ vhost: 'other', exchange: 'events', routingKey: 'billing' });
    const keys = async (input: object) =>
      (await list(engine, { cid: 'c1', ...input })).entries.map(
        (entry) => entry.routingKey,
      );

    expect(await keys({ vhost: 'other' })).toEqual(['billing']);
    expect(await keys({ exchange: 'events' })).toEqual([
      'billing',
      'orders.paid',
    ]);
    expect(await keys({ exchange: '' })).toEqual(['orders.new']);
    expect(await keys({ routingKeyPrefix: 'orders.' })).toEqual([
      'orders.paid',
      'orders.new',
    ]);
    expect(await keys({ routingKeyPrefix: 'ORDERS.' })).toEqual([]);
    expect(await keys({ from: T0 + DAY })).toEqual(['billing', 'orders.paid']);
    expect(await keys({ to: T0 + DAY })).toEqual(['orders.paid', 'orders.new']);
    expect(await keys({ from: T0 + DAY, to: T0 + DAY })).toEqual([
      'orders.paid',
    ]);
  });

  it('M1-19 slice D: list windows are bounded and a cursor continues without a gap or a repeat', async () => {
    const { engine, clock, record } = setup();
    for (let n = 0; n < 7; n += 1) {
      await record({ routingKey: `k${String(n)}` });
      clock.advance(10);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await list(engine, {
        cid: 'c1',
        limit: 3,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(page.entries.length).toBeLessThanOrEqual(3);
      seen.push(...page.entries.map((entry) => entry.routingKey));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== undefined);

    expect(pages).toBe(3);
    expect(seen).toEqual(['k6', 'k5', 'k4', 'k3', 'k2', 'k1', 'k0']);
    // Without a limit the window is 50 and a short history has no cursor.
    expect((await list(engine, sampleInput)).entries).toHaveLength(7);
  });

  it('M1-19 slice D: list refuses a limit outside 1 to 200, an unknown field and a cursor that is not one', async () => {
    const { engine, record } = setup();
    await record();

    for (const limit of [0, 201, 1.5]) {
      expect((await refusal(list(engine, { cid: 'c1', limit }))).code).toBe(
        'VALIDATION_FAILED',
      );
    }
    expect((await refusal(list(engine, { cid: 'c1', sort: 'asc' }))).code).toBe(
      'VALIDATION_FAILED',
    );
    expect(
      (await refusal(list(engine, { cid: 'c1', cursor: 'not a cursor' }))).code,
    ).toBe('VALIDATION_FAILED');
    expect(
      (await list(engine, { cid: 'c1', limit: 200 })).entries,
    ).toHaveLength(1);
  });

  it('M1-19 slice D: list never returns an expired entry, even before it is purged', async () => {
    const { engine, clock, history, record } = setup();
    await record({ routingKey: 'ages' });
    clock.advance(30 * DAY - 1);

    expect((await list(engine, sampleInput)).entries).toHaveLength(1);
    clock.advance(1);

    expect((await list(engine, sampleInput)).entries).toEqual([]);
    expect(history.size()).toBe(1);
  });
});
