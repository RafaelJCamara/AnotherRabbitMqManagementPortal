// M1-46 slice D, the end-to-end half: the calls the publish studio makes, sent through the real router over the real
// executor (`createTestEngine`) to the real publish and history actions of `svc-messages`, over a scripted lease. The
// bodies are written the way the studio builds them (`libs/ui/feature-messages/src/lib/publish/draft-to-input.ts` and
// `send-flow.ts`; this project is Node code and may not import them), with the header `EngineApi.call` sends for a
// command. The UI's own half (what the studio shows of each answer, against a fake engine) is
// `libs/ui/feature-messages/src/lib/publish/*.component.spec.ts`. Every answer is parsed with the contract schema the
// UI parses it with. No browser and no real broker are involved: a broker that confirms or returns waits for M1-19
// slice E and the connection wiring.
import {
  messagesPublish,
  messagesPublishHistoryList,
  ProblemSchema,
} from '@app/contracts';
import {
  AppError,
  createLogger,
  createManualClock,
  type ExecutorWrite,
} from '@app/kernel';
import {
  mintConfirmedCopyProof,
  type ConnectionManager,
  type PublishOutcome,
} from '@app/ports';
import {
  createFakeSealer,
  createMemoryPublishHistory,
  createMessagesPublishAction,
  createMessagesPublishHistoryListAction,
  createPublishHistory,
} from '@app/svc-messages';
import { afterEach, describe, expect, it } from 'vitest';

import { createTestEngine, type TestEngine } from '../create-test-engine.ts';

let engine: TestEngine;
let counter = 0;
/** What `EngineApi.call` does for a command: a fresh key of the engine's alphabet and length. */
const key = (): { 'idempotency-key': string } => ({
  'idempotency-key': `publish-ui-spec-${String((counter += 1)).padStart(4, '0')}`,
});

afterEach(async () => {
  await engine.close();
});

interface LeaseCall {
  readonly exchange: string;
  readonly routingKey: string;
  readonly options: { mandatory: true; timeoutMs: number };
}

/** A manager whose one lease answers each copy with the next scripted outcome and records what it was asked. */
function scriptedWrites(script: readonly PublishOutcome[]): {
  writes: ExecutorWrite;
  calls: LeaseCall[];
} {
  const calls: LeaseCall[] = [];
  const unused = (): never => {
    throw new Error('this spec takes a publish lease only');
  };
  const connections: ConnectionManager = {
    peek: unused,
    source: unused,
    observe: unused,
    budget: unused,
    usage: unused,
    publish: () =>
      Promise.resolve({
        publish: (exchange, routingKey, _body, _props, options) => {
          calls.push({ exchange, routingKey, options });
          const step = script[calls.length - 1];
          if (step === undefined) throw new Error('the script ran out');
          return Promise.resolve(step);
        },
        blocked: () => false,
        release: () => Promise.resolve(),
      }),
  };
  return { writes: { mgmt: {} as ExecutorWrite['mgmt'], connections }, calls };
}

/** The writes of the engine today: asking for a publish connection is refused (`apps/engine/src/unwired-writes.ts`). */
function unwiredWrites(): ExecutorWrite {
  const unwired = (what: string): AppError =>
    new AppError('CAPABILITY_MISSING', {
      detail: `${what} is not available in this build: no broker adapter is wired.`,
    });
  return {
    mgmt: { send: () => Promise.reject(unwired('Broker management writes')) },
    connections: {
      peek: () => Promise.reject(unwired('A peek connection')),
      source: () => Promise.reject(unwired('A source connection')),
      publish: () => Promise.reject(unwired('A publish connection')),
      observe: () => Promise.reject(unwired('An observe connection')),
      budget: () => [],
      usage: () => ({ inUse: 0, max: 0, queued: 0, brokerMax: null }),
    },
  };
}

/** The history store the publish action records into and the list action reads from, as the module builds them. */
function historyStore() {
  let n = 0;
  return createPublishHistory({
    history: createMemoryPublishHistory(),
    sealer: createFakeSealer(),
    newId: () => {
      n += 1;
      return `entry-${String(n)}`;
    },
    clock: createManualClock(1_700_000_000_000),
    logger: createLogger({ level: 'silent' }),
  });
}

/** The body of the studio's send: the input without `cid` (it is in the path), `mandatory` and `confirm` always true. */
const SENT = {
  vhost: '/',
  exchange: '',
  routingKey: 'orders',
  props: { contentType: 'text/plain' },
  body: { encoding: 'utf8', data: 'hello' },
  copies: 1,
  mandatory: true,
  confirm: true,
  timeoutMs: 5000,
} as const;

const PATH = '/connections/c1/messages/publish';
const HISTORY = '/connections/c1/messages/publish-history';

function engineOver(writes: ExecutorWrite) {
  const store = historyStore();
  engine = createTestEngine({
    actions: [
      createMessagesPublishAction({
        recorder: store,
        logger: createLogger({ level: 'silent' }),
      }),
      createMessagesPublishHistoryListAction({ store }),
    ],
    writes,
  });
}

describe('the calls of the publish studio through the real router', () => {
  it('M1-46 AC-27 shows returned: NO_ROUTE through the real router, not success', async () => {
    const { writes, calls } = scriptedWrites([
      { outcome: 'returned', reason: 'NO_ROUTE' },
    ]);
    engineOver(writes);
    engine.arm('c1');

    const sent = await engine.inject({
      method: 'POST',
      path: PATH,
      payload: SENT,
      headers: key(),
    });
    expect(sent.statusCode).toBe(200);
    const output = messagesPublish.output.parse(sent.json());
    // The answer the studio renders: the copy is `returned: NO_ROUTE`, and nothing is a success.
    expect(output.copies).toEqual([
      { index: 0, outcome: 'returned', reason: 'NO_ROUTE' },
    ]);
    expect(output.summary).toMatchObject({ returned: 1, confirmed: 0 });
    expect(output.allConfirmed).toBe(false);
    expect(output.historyRecorded).toBe(true);
    // The lease saw `mandatory: true` and the studio's timeout; the exchange is the default exchange.
    expect(calls).toEqual([
      {
        exchange: '',
        routingKey: 'orders',
        options: { mandatory: true, timeoutMs: 5000 },
      },
    ]);

    // The history the studio reads after a send has the entry, with the same counts.
    const listed = await engine.inject({ method: 'GET', path: HISTORY });
    expect(listed.statusCode).toBe(200);
    const history = messagesPublishHistoryList.output.parse(listed.json());
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]).toMatchObject({
      id: output.historyId,
      exchange: '',
      routingKey: 'orders',
      copies: 1,
      summary: { returned: 1, confirmed: 0 },
    });
  });

  it('every outcome the studio words reaches it from the router, one per copy, in order', async () => {
    const confirmed: PublishOutcome = {
      outcome: 'confirmed',
      proof: mintConfirmedCopyProof({ destination: 'orders', confirmedAt: 1 }),
    };
    const { writes } = scriptedWrites([
      confirmed,
      { outcome: 'nacked' },
      { outcome: 'returned', reason: 'NO_ROUTE' },
      { outcome: 'timeout' },
    ]);
    engineOver(writes);
    engine.arm('c1');
    const sent = await engine.inject({
      method: 'POST',
      path: PATH,
      payload: { ...SENT, copies: 4 },
      headers: key(),
    });
    const output = messagesPublish.output.parse(sent.json());
    expect(output.copies.map((copy) => [copy.index, copy.outcome])).toEqual([
      [0, 'confirmed'],
      [1, 'nacked'],
      [2, 'returned'],
      [3, 'timeout'],
    ]);
    expect(output.allConfirmed).toBe(false);
  });

  it('M1-46 AC-31 says so when the engine cannot publish yet and keeps the draft', async () => {
    engineOver(unwiredWrites());

    // The prod lock comes first: a connection nobody armed is refused with GATE_BLOCKED and the unlock as the fix.
    const locked = await engine.inject({
      method: 'POST',
      path: PATH,
      payload: SENT,
      headers: key(),
    });
    expect(locked.statusCode).toBeGreaterThanOrEqual(400);
    expect(ProblemSchema.parse(locked.json())).toMatchObject({
      code: 'GATE_BLOCKED',
    });

    // Armed: the publish is refused because no publish connection is wired. It is a Problem the studio shows as
    // sent; no copy is reported and nothing is recorded.
    engine.arm('c1');
    const unwired = await engine.inject({
      method: 'POST',
      path: PATH,
      payload: SENT,
      headers: key(),
    });
    expect(unwired.statusCode).toBe(412);
    const problem = ProblemSchema.parse(unwired.json());
    expect(problem.code).toBe('CAPABILITY_MISSING');
    expect(unwired.json()).not.toHaveProperty('copies');

    // The history stays readable and empty.
    const listed = await engine.inject({ method: 'GET', path: HISTORY });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ entries: [] });
  });

  // The studio plans first and falls back to the direct call when the plan route is "no such route" (send-flow.ts).
  // This pins the premise. When the engine routes plans (OQ-191, OQ-282), delete this test and the fallback.
  it('the plan route is not served by the engine yet, so the studio falls back to the direct call', async () => {
    engineOver(unwiredWrites());
    const plan = await engine.inject({
      method: 'POST',
      path: '/actions/messages.publish/plans',
      payload: { cid: 'c1', ...SENT },
    });
    expect(plan.statusCode).toBe(404);
    expect(ProblemSchema.parse(plan.json())).toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });
});
