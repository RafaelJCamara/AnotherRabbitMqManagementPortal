// M1-19 slice A: messages.publish over a scripted lease. The generated base tests (contract,
// plan purity, deny by default, audit) keep their place without an AC id; AC-1 to AC-10 of
// docs/specs/M1-19.md are the tests named `M1-19 AC-n`.
//
// The scripted lease lives in this file on purpose: building a `confirmed` outcome needs
// `mintConfirmedCopyProof`, which only specs and the lease itself may import (A-9, arch test), and
// a lease type may be named only by an action module or a spec (I-2).
import { checkRegistry, MessagesPublishOutputSchema } from '@app/contracts';
import {
  AppError,
  checkPlanPurity,
  createLogger,
  createRoleAuthorizer,
  createTestContext,
  createTestExecutor,
  createTestPrincipal,
  createWiredExecutor,
  denyAllAuthorizer,
  type ExecutorContext,
  type ExecutorWrite,
} from '@app/kernel';
import {
  mintConfirmedCopyProof,
  type ConnectionManager,
  type PublishLease,
  type PublishOutcome,
} from '@app/ports';
import { describe, expect, it } from 'vitest';

import { createMemoryPublishRecorder } from '../testing';
import { createSubject, sampleInput } from './messages-publish.fixture';

const subject = createSubject;
const { def } = createSubject();

// --- The scripted lease ------------------------------------------------------------------------

const confirmed = (): PublishOutcome => ({
  outcome: 'confirmed',
  proof: mintConfirmedCopyProof({ destination: 'orders', confirmedAt: 1 }),
});
const returned = (reason = 'NO_ROUTE'): PublishOutcome => ({
  outcome: 'returned',
  reason,
});
const nacked = (): PublishOutcome => ({ outcome: 'nacked' });
const timedOut = (): PublishOutcome => ({ outcome: 'timeout' });
const blocked = (): PublishOutcome => ({ outcome: 'blocked' });

/** What `lease.publish` does for one copy: answer, or throw this. */
type Step = PublishOutcome | { readonly throws: Error };

/** What the adapter throws: an Error with a contract `code` and its own safe `detail`. */
const adapterError = (
  code: string,
  detail?: string,
  message = 'the adapter failed',
): Error => Object.assign(new Error(message), { code, detail });

interface PublishCall {
  readonly exchange: string;
  readonly routingKey: string;
  readonly body: Uint8Array;
  readonly props: Record<string, unknown>;
  readonly options: { mandatory: true; timeoutMs: number };
}

/** A manager that hands out one scripted lease, and counts what was asked of it. */
function createScript(
  steps: readonly Step[],
  hooks: { afterCall?: (index: number) => void } = {},
) {
  const calls: PublishCall[] = [];
  const requests: { cid: string; vhost: string; principalId: string }[] = [];
  const count = { leases: 0, releases: 0 };
  const lease: PublishLease = {
    publish(exchange, routingKey, body, props, options) {
      const index = calls.length;
      calls.push({ exchange, routingKey, body, props, options });
      hooks.afterCall?.(index);
      const step = steps[index];
      if (step === undefined) {
        return Promise.reject(new Error('the script ran out of steps'));
      }
      return 'throws' in step
        ? Promise.reject(step.throws)
        : Promise.resolve(step);
    },
    blocked: () => false,
    release() {
      count.releases += 1;
      return Promise.resolve();
    },
  };
  const unused = (): never => {
    throw new Error('this spec takes a publish lease only');
  };
  const connections: ConnectionManager = {
    peek: unused,
    source: unused,
    observe: unused,
    budget: unused,
    usage: unused,
    publish(cid, vhost, principal) {
      count.leases += 1;
      requests.push({ cid, vhost, principalId: principal.id });
      return Promise.resolve(lease);
    },
  };
  const writes: ExecutorWrite = {
    mgmt: {} as ExecutorWrite['mgmt'],
    connections,
  };
  return { calls, requests, count, writes };
}

type Script = ReturnType<typeof createScript>;

/** The wired executor (real audit chain, receipts, prod lock) with the action and a script. */
function setup(
  script: Script,
  options: {
    lines?: string[];
    recorder?: ReturnType<typeof createMemoryPublishRecorder>;
  } = {},
) {
  const recorder = options.recorder ?? createMemoryPublishRecorder();
  const logger = createLogger({
    level: 'trace',
    sink: { write: (line) => options.lines?.push(line) },
  });
  const engine = createWiredExecutor({
    executor: { writes: script.writes, logger },
  });
  engine.executor.register(subject({ recorder, logger }));
  let keys = 0;
  const context = (over: Partial<ExecutorContext> = {}): ExecutorContext => {
    keys += 1;
    return createTestContext({
      idempotencyKey: `publish-spec-${String(keys)}`,
      ...over,
    });
  };
  /** Runs the action as a dev call; resolves with its output or rejects with its Problem. */
  const publish = async (
    input: unknown,
    over: Partial<ExecutorContext> = {},
  ) => {
    const outcome = await engine.executor.run(def, input, context(over));
    if (outcome.kind !== 'output') throw new Error(`got ${outcome.kind}`);
    return outcome.output;
  };
  return { engine, recorder, context, publish };
}

const withCopies = (copies: number) => ({ ...sampleInput, copies });

/** `depth` tables nested in each other, a number at the bottom. */
function nestedTables(depth: number): unknown {
  let value: unknown = { t: 'long', v: 1 };
  for (let level = 0; level < depth; level += 1) {
    value = { t: 'table', v: [{ name: `n${String(level)}`, value }] };
  }
  return value;
}

async function refusal(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

// --- The generated base ------------------------------------------------------------------------

describe('messages.publish base', () => {
  const KEY = 'generated-spec-key-0001';

  it('M1-19 base: the contract passes the kit invariants and the sample input fits it', () => {
    expect(checkRegistry({ actions: [def], topics: [] })).toEqual([]);
    expect(def.input.safeParse(sampleInput).success).toBe(true);
  });

  it('M1-19 base: plan() reads only, and its preview holds no body or header value', async () => {
    expect(
      await checkPlanPurity([{ impl: subject(), input: sampleInput }]),
    ).toEqual([]);
    const draft = await subject().plan?.(
      def.input.parse({
        ...sampleInput,
        headers: { 'x-token': { t: 'string', v: 'HEADER-VALUE-123' } },
        body: { encoding: 'utf8', data: 'BODY-VALUE-12345' },
      }),
      {
        principal: createTestPrincipal(),
        mode: 'desktop',
        env: 'dev',
        correlationId: 'c',
        signal: new AbortController().signal,
        now: () => 0,
      },
    );
    expect(draft?.preview).toEqual({
      exchange: '',
      routingKey: 'orders',
      copies: 1,
      bodyBytes: 16,
      headerCount: 1,
    });
  });

  it('M1-19 base: a principal that does not hold messages.publish is refused before anything runs', async () => {
    const script = createScript([confirmed()]);
    const engine = createTestExecutor({
      executor: {
        authorizer: createRoleAuthorizer({ operator: ['messages.publish'] }),
        writes: script.writes,
      },
    });
    engine.executor.register(subject());
    const ctx = createTestContext({
      principal: createTestPrincipal({ roles: ['intruder'] }),
      idempotencyKey: KEY,
    });

    await expect(
      engine.executor.run(def, sampleInput, ctx),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_RBAC' });

    expect(engine.audit.attempts).toEqual([]);
    expect(script.count.leases).toBe(0);
  });

  it('M1-19 base: with no authorizer wired every call is refused: deny by default', async () => {
    const script = createScript([confirmed()]);
    const engine = createTestExecutor({
      executor: { authorizer: denyAllAuthorizer, writes: script.writes },
    });
    engine.executor.register(subject());

    await expect(
      engine.executor.run(
        def,
        sampleInput,
        createTestContext({ idempotencyKey: KEY }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_RBAC' });

    expect(script.count.leases).toBe(0);
  });

  it('M1-19 base: a run leaves an audit attempt, then an outcome that names it, and a receipt', async () => {
    const script = createScript([confirmed()]);
    const { engine, publish } = setup(script);

    await publish(sampleInput);

    expect(engine.auditRows.rows.map((row) => row.phase)).toEqual([
      'attempt',
      'outcome',
    ]);
    expect(engine.auditRows.rows[1]).toMatchObject({
      actionId: def.id,
      result: 'ok',
      attemptSeq: 1,
    });
    expect([...engine.receiptRows.rows.values()]).toMatchObject([
      { actionId: def.id, result: 'ok' },
    ]);
  });
});

// --- AC-1 to AC-10 -----------------------------------------------------------------------------

describe('messages.publish (M1-19 slice A)', () => {
  it('M1-19 AC-1 publish reports returned NO_ROUTE, not success, when mandatory finds no binding', async () => {
    const script = createScript([returned('NO_ROUTE')]);
    const { publish } = setup(script);

    const output = await publish(sampleInput);

    expect(output.copies).toEqual([
      { index: 0, outcome: 'returned', reason: 'NO_ROUTE' },
    ]);
    expect(output.allConfirmed).toBe(false);
    expect(output.summary).toMatchObject({ returned: 1, confirmed: 0 });
    // The lease saw a mandatory publish, the message as typed, on the connection and vhost asked for.
    expect(script.calls).toHaveLength(1);
    expect(script.calls[0]?.options).toEqual({
      mandatory: true,
      timeoutMs: 5_000,
    });
    expect(script.calls[0]).toMatchObject({
      exchange: '',
      routingKey: 'orders',
    });
    expect(new TextDecoder().decode(script.calls[0]?.body)).toBe('hello');
    expect(script.calls[0]?.props).toEqual({ contentType: 'text/plain' });
    expect(script.requests).toEqual([
      { cid: 'c1', vhost: '/', principalId: 'user-1' },
    ]);
  });

  it('M1-19 AC-2 publish distinguishes confirmed, nacked and returned per copy', async () => {
    const script = createScript([confirmed(), nacked(), returned()]);
    const { publish } = setup(script);

    const output = await publish(withCopies(3));

    expect(output.copies.map((copy) => [copy.index, copy.outcome])).toEqual([
      [0, 'confirmed'],
      [1, 'nacked'],
      [2, 'returned'],
    ]);
    expect(output.summary).toEqual({
      confirmed: 1,
      nacked: 1,
      returned: 1,
      blocked: 0,
      timeout: 0,
      failed: 0,
      'not-sent': 0,
    });
    expect(output.allConfirmed).toBe(false);
    // Plain JSON that passes the contract, with no proof object in it.
    const wire: unknown = JSON.parse(JSON.stringify(output));
    expect(wire).toEqual(output);
    expect(MessagesPublishOutputSchema.safeParse(wire).success).toBe(true);
    expect(JSON.stringify(output)).not.toMatch(/proof|destination|confirmedAt/);
  });

  it('M1-19 AC-3 publish refuses to switch mandatory or confirms off', async () => {
    const script = createScript([confirmed(), confirmed()]);
    const { publish } = setup(script);

    for (const off of [{ mandatory: false }, { confirm: false }]) {
      const error = await refusal(publish({ ...sampleInput, ...off }));
      expect(error.code).toBe('VALIDATION_FAILED');
    }
    expect(script.count.leases).toBe(0);

    // Left out, both default to true and the lease is told so.
    await publish(sampleInput);
    expect(script.calls.map((call) => call.options.mandatory)).toEqual([true]);
    // Said out loud, true is accepted.
    await publish({ ...sampleInput, mandatory: true, confirm: true });
    expect(script.calls.map((call) => call.options.mandatory)).toEqual([
      true,
      true,
    ]);
  });

  it.each([
    ['timeout', timedOut, /no confirm in time/],
    ['blocked', blocked, /nothing was sent/],
  ])(
    'M1-19 AC-4 publish stops after a timeout or a blocked connection and lists the rest as not-sent (%s)',
    async (_name, stopper, reason) => {
      const script = createScript([confirmed(), stopper(), confirmed()]);
      const { publish } = setup(script);

      const output = await publish(withCopies(5));

      expect(output.copies.map((copy) => copy.outcome)).toEqual([
        'confirmed',
        _name,
        'not-sent',
        'not-sent',
        'not-sent',
      ]);
      expect(output.copies[1]?.reason).toMatch(reason);
      expect(output.copies.map((copy) => copy.index)).toEqual([0, 1, 2, 3, 4]);
      expect(output.copies[2]?.reason).toBeDefined();
      expect(script.calls).toHaveLength(2);
      expect(output.allConfirmed).toBe(false);
      expect(output.summary).toMatchObject({
        confirmed: 1,
        [_name]: 1,
        'not-sent': 3,
      });
      // A timeout is worded as uncertain, never as a failure to deliver.
      if (_name === 'timeout') {
        expect(output.copies[1]?.reason).toMatch(/may still have routed/);
      }
    },
  );

  it('M1-19 AC-5 publish bounds copies, body, headers, properties and wait before taking a lease', async () => {
    const script = createScript(Array.from({ length: 200 }, confirmed));
    const { publish } = setup(script);
    const manyHeaders = (n: number) =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [
          `h${String(i)}`,
          { t: 'bool', v: true },
        ]),
      );
    const refused: [string, unknown][] = [
      ['copies', { ...sampleInput, copies: 101 }],
      [
        'utf8 body',
        {
          ...sampleInput,
          body: { encoding: 'utf8', data: 'a'.repeat(1_048_577) },
        },
      ],
      [
        'base64 body',
        {
          ...sampleInput,
          body: {
            encoding: 'base64',
            data: Buffer.alloc(1_048_577).toString('base64'),
          },
        },
      ],
      [
        'not base64',
        { ...sampleInput, body: { encoding: 'base64', data: 'not base64!' } },
      ],
      ['headers', { ...sampleInput, headers: manyHeaders(65) }],
      ['depth', { ...sampleInput, headers: { deep: nestedTables(9) } }],
      ['property', { ...sampleInput, props: { mandatory: true } }],
      ['wait', { ...sampleInput, timeoutMs: 99 }],
      ['wait long', { ...sampleInput, timeoutMs: 30_001 }],
    ];

    for (const [name, input] of refused) {
      const error = await refusal(publish(input));
      expect(error.code, name).toBe('VALIDATION_FAILED');
      expect(script.count.leases, name).toBe(0);
    }

    // The same limits, exactly at the bound, are accepted: nothing above is refused by accident.
    const atTheLimit = {
      ...sampleInput,
      copies: 100,
      timeoutMs: 100,
      body: {
        encoding: 'base64',
        data: Buffer.alloc(1_048_576).toString('base64'),
      },
      headers: { ...manyHeaders(63), deep: nestedTables(8) },
    };
    const output = await publish(atTheLimit);
    expect(output.copies).toHaveLength(100);
    expect(script.calls[0]?.body.byteLength).toBe(1_048_576);
    expect(script.calls[0]?.options.timeoutMs).toBe(100);
    expect(script.count.leases).toBe(1);
  });

  it('M1-19 AC-6 publish releases its lease exactly once on every path', async () => {
    // A run to the end.
    const ok = createScript([confirmed(), returned()]);
    await setup(ok).publish(withCopies(2));
    expect(ok.count).toEqual({ leases: 1, releases: 1 });

    // A throw on copy 0: the call fails, the lease is still released.
    const first = createScript([{ throws: adapterError('BROKER_ERROR') }]);
    await refusal(setup(first).publish(withCopies(3)));
    expect(first.count).toEqual({ leases: 1, releases: 1 });

    // A throw on copy 2: the call answers, the lease is released.
    const third = createScript([
      confirmed(),
      confirmed(),
      { throws: adapterError('BROKER_ERROR') },
    ]);
    await setup(third).publish(withCopies(4));
    expect(third.count).toEqual({ leases: 1, releases: 1 });

    // An abort between copies: the rest is not sent, the lease is released.
    const controller = new AbortController();
    const aborted = createScript([confirmed(), confirmed(), confirmed()], {
      afterCall: (index) => {
        if (index === 1) controller.abort();
      },
    });
    const output = await setup(aborted).publish(withCopies(4), {
      signal: controller.signal,
    });
    expect(output.copies.map((copy) => copy.outcome)).toEqual([
      'confirmed',
      'confirmed',
      'not-sent',
      'not-sent',
    ]);
    expect(aborted.calls).toHaveLength(2);
    expect(aborted.count).toEqual({ leases: 1, releases: 1 });

    // A lease that will not close cleanly does not change the answer.
    const lines: string[] = [];
    const stubborn = createScript([confirmed()]);
    const lease = await stubborn.writes.connections.publish(
      'c1' as never,
      '/',
      createTestPrincipal(),
      new AbortController().signal,
    );
    lease.release = () => Promise.reject(new Error('close failed'));
    const closed = await setup(stubborn, { lines }).publish(sampleInput);
    expect(closed.allConfirmed).toBe(true);
    expect(lines.join('')).toContain('did not close cleanly');
  });
});
