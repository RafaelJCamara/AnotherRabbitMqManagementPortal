import { defineAction } from '@app/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AppError } from '../problem/problem.ts';
import { implementAction } from './implement-action.ts';
import { createLocalWritesTrap } from './local-trap.ts';
import {
  createTestContext,
  createTestExecutor,
  type TestExecutor,
} from './testing.ts';
import type { ExecuteContext, ExecutorWrite } from './types.ts';

// OQ-783, the runtime half: a `scope: 'local'` action is handed a `writes` bundle in which every
// access throws, whatever the module's source looks like (the arch test only reads syntax).

const shape = {
  kind: 'command',
  summary: 'Change only the engine-local state',
  input: z.strictObject({}),
  output: z.strictObject({ ok: z.boolean() }),
  permission: 'ops.local-trap',
  risk: 'low',
  planning: 'none',
  audit: 'attempt+outcome',
  target: () => ({}),
  since: '1.0',
} as const;

const localDef = defineAction({ ...shape, id: 'ops.local-trap', scope: 'local' });
const brokerDef = defineAction({ ...shape, id: 'ops.broker-trap' });

let keys = 0;
const run = (t: TestExecutor, def: typeof localDef  ) => {
  keys += 1;
  return t.executor.run(
    def,
    {},
    createTestContext({
      idempotencyKey: `trap-key-${String(keys).padStart(6, '0')}`,
    }),
  );
};

async function failureOf(work: Promise<unknown>): Promise<AppError> {
  const error = await work.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

type Execute = (ctx: ExecuteContext) => unknown;

function localWith(t: TestExecutor, execute: Execute): void {
  t.executor.register(
    implementAction(localDef, {
      plan: () =>
        Promise.resolve({
          preview: {},
          gates: [],
          warnings: [],
          consentsRequired: [],
        }),
      revalidate: () => Promise.resolve('valid'),
      execute: async (_input, ctx) => {
        await Promise.resolve(execute(ctx as ExecuteContext));
        return { ok: true };
      },
    }),
  );
}

async function expectStopped(t: TestExecutor): Promise<void> {
  const error = await failureOf(run(t, localDef));
  expect(error.code).toBe('INTERNAL');
  expect(error.message).toContain("declares scope 'local'");
  expect(error.message).toContain(localDef.id);
  // No audit success and no success receipt: the outcome row and the receipt say `error`.
  expect(t.audit.outcomes).toHaveLength(1);
  expect(t.audit.outcomes[0]).toMatchObject({
    result: 'error',
    code: 'INTERNAL',
  });
  expect(t.receipts.records.at(-1)).toMatchObject({ result: 'error' });
  expect(t.writeCalls).toEqual([]);
}

describe('createLocalWritesTrap', () => {
  it('AC-1 every kind of access throws an INTERNAL Problem and marks the trap tripped', () => {
    const accesses: ((writes: ExecutorWrite) => unknown)[] = [
      (w) => w.mgmt,
      (w) => (w as unknown as Record<symbol, unknown>)[Symbol.iterator],
      (w) => 'mgmt' in w,
      (w) => Object.keys(w),
      (w) => Object.getOwnPropertyDescriptor(w, 'mgmt'),
      (w) => {
        (w as unknown as Record<string, unknown>).mgmt = 1;
      },
      (w) => Reflect.get(w, 'connections'),
      (w) => Object.getPrototypeOf(w) as unknown,
      (w) => JSON.stringify(w),
    ];
    for (const access of accesses) {
      const trap = createLocalWritesTrap('x.y');
      expect(trap.tripped()).toBe(false);
      expect(() => access(trap.writes)).toThrow(AppError);
      expect(trap.tripped()).toBe(true);
    }
  });
});

describe('the executor and a scope local action', () => {
  it('AC-2 reaching ctx.writes by property access fails the call at runtime, with a stated error', async () => {
    const t = createTestExecutor();
    localWith(t, (ctx) => ctx.writes.mgmt.send({} as never, ctx.signal));
    await expectStopped(t);
  });

  it('AC-3 reaching ctx["writes"] by element access (literal and computed key) fails the same way', async () => {
    const literal = createTestExecutor();
    localWith(literal, (ctx) => {
      const bag = ctx as unknown as Record<string, ExecutorWrite>;
      return bag.writes?.connections;
    });
    await expectStopped(literal);

    const computed = createTestExecutor();
    localWith(computed, (ctx) => {
      const key = ['wri', 'tes'].join('');
      const bag = ctx as unknown as Record<string, ExecutorWrite>;
      return bag[key]?.mgmt;
    });
    await expectStopped(computed);
  });

  it('AC-4 Reflect.get(ctx, "writes") fails as soon as the bundle is used', async () => {
    const t = createTestExecutor();
    localWith(t, (ctx) => {
      const writes: ExecutorWrite = Reflect.get(ctx, 'writes');
      return writes.mgmt;
    });
    await expectStopped(t);
  });

  it('AC-5 an action that catches the trap error and carries on is still failed and audited as an error', async () => {
    const t = createTestExecutor();
    localWith(t, (ctx) => {
      try {
        return ctx.writes.mgmt;
      } catch {
        return undefined;
      }
    });
    await expectStopped(t);
  });

  it('AC-6 a local action that never touches writes runs normally and is audited as a success', async () => {
    const t = createTestExecutor();
    localWith(t, () => undefined);

    const outcome = await run(t, localDef);

    expect(outcome).toMatchObject({ kind: 'output', output: { ok: true } });
    expect(t.audit.outcomes[0]).toMatchObject({ result: 'ok' });
    expect(t.writeCalls).toEqual([]);
  });

  it('AC-7 an action that does not declare local scope still gets the real write ports', async () => {
    const t = createTestExecutor();
    t.executor.register(
      implementAction(brokerDef, {
        plan: () =>
          Promise.resolve({
            preview: {},
            gates: [],
            warnings: [],
            consentsRequired: [],
          }),
        revalidate: () => Promise.resolve('valid'),
        execute: async (_input, ctx) => {
          await ctx.writes.mgmt.send({} as never, ctx.signal);
          return { ok: true };
        },
      }),
    );

    const outcome = await run(t, brokerDef);

    expect(outcome).toMatchObject({ kind: 'output', output: { ok: true } });
    expect(t.writeCalls).toEqual(['mgmt.send']);
  });
});
