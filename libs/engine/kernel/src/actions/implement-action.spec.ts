import { defineAction } from '@app/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { implementAction, isImplementedAction } from './implement-action.ts';
import { createProbe, statDef, statImpl, purgeImpl } from './test-actions.ts';
import {
  checkPlanPurity,
  createTestPrincipal,
  WriteDuringPlanError,
} from './testing.ts';
import type { ExecuteContext } from './types.ts';

const base = {
  summary: 's',
  input: z.strictObject({}),
  output: z.strictObject({}),
  permission: 'a.b',
  risk: 'low',
  planning: 'none',
  audit: 'attempt+outcome',
  target: () => ({}),
  since: '1.0',
} as const;

const draft = () =>
  Promise.resolve({
    preview: {},
    gates: [],
    warnings: [],
    consentsRequired: [],
  });
const valid = () => Promise.resolve('valid' as const);
const done = () => Promise.resolve({});

describe('executor implementAction', () => {
  it('returns a frozen implementation the executor accepts, and nothing else is accepted', () => {
    const impl = statImpl(createProbe());

    expect(isImplementedAction(impl)).toBe(true);
    expect(Object.isFrozen(impl)).toBe(true);
    expect(isImplementedAction({ ...impl })).toBe(false);
    expect(isImplementedAction(Object.create(impl) as object)).toBe(false);
    expect(isImplementedAction(new Proxy(impl, {}))).toBe(false);
    expect(isImplementedAction(JSON.parse(JSON.stringify(impl)))).toBe(false);
    expect(isImplementedAction(null)).toBe(false);
    expect(isImplementedAction('impl')).toBe(false);
    expect(impl.def).toBe(statDef);
  });

  it('refuses a mutating action that does not audit attempt and outcome', () => {
    for (const kind of ['command', 'peek', 'job'] as const) {
      for (const audit of ['none', 'outcome'] as const) {
        const def = defineAction({ ...base, id: 'a.b', kind, audit });
        expect(() =>
          implementAction(def, {
            plan: draft,
            revalidate: valid,
            execute: done,
          }),
        ).toThrow(/audit/);
      }
    }
  });

  it('refuses a mutating action without plan() or revalidate(), whatever its planning says', () => {
    const def = defineAction({
      ...base,
      id: 'a.b',
      kind: 'command',
      planning: 'none',
    });

    expect(() =>
      implementAction(def, { revalidate: valid, execute: done }),
    ).toThrow(/plan\(\)/);
    expect(() => implementAction(def, { plan: draft, execute: done })).toThrow(
      /revalidate\(\)/,
    );
    expect(() => implementAction(def, { execute: done })).toThrow(TypeError);
  });

  it('refuses a query that declares planning but has no plan() or revalidate()', () => {
    const def = defineAction({
      ...base,
      id: 'a.b',
      kind: 'query',
      audit: 'none',
      planning: 'optional',
    });

    expect(() => implementAction(def, { execute: done })).toThrow(/plan\(\)/);
  });

  it('refuses an implementation without execute()', () => {
    const def = defineAction({
      ...base,
      id: 'a.b',
      kind: 'query',
      audit: 'none',
    });

    expect(() => implementAction(def, {} as never)).toThrow(/execute/);
  });

  it('accepts a plain query with only execute()', () => {
    const def = defineAction({
      ...base,
      id: 'a.b',
      kind: 'query',
      audit: 'none',
    });

    expect(isImplementedAction(implementAction(def, { execute: done }))).toBe(
      true,
    );
  });
});

describe('executor plan purity harness', () => {
  const sample = (impl: ReturnType<typeof purgeImpl>) => ({
    impl,
    input: { connectionId: 'c1', name: 'orders' },
  });

  it('passes a plan() that only reads', async () => {
    expect(await checkPlanPurity([sample(purgeImpl(createProbe()))])).toEqual(
      [],
    );
  });

  it('passes an action with no plan() to violate', async () => {
    expect(
      await checkPlanPurity([
        { impl: statImpl(createProbe()), input: { name: 'q' } },
      ]),
    ).toEqual([]);
  });

  const cheat = (swallow: boolean) =>
    implementAction(defineAction({ ...base, id: 'x.cheat', kind: 'command' }), {
      plan: async (_input, ctx) => {
        // A plan() that casts its context to reach for a write port.
        const { writes } = ctx as unknown as ExecuteContext;
        try {
          await writes.mgmt.send({} as never, ctx.signal);
        } catch (error) {
          if (!swallow) throw error;
        }
        return { preview: {}, gates: [], warnings: [], consentsRequired: [] };
      },
      revalidate: valid,
      execute: done,
    });

  it('fails a plan() that calls a write port and lets the error out', async () => {
    const failures = await checkPlanPurity([{ impl: cheat(false), input: {} }]);

    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toContain('mgmt.send');
    expect(new WriteDuringPlanError('x').name).toBe('WriteDuringPlanError');
  });

  it('fails a plan() that calls a write port and swallows the error', async () => {
    const failures = await checkPlanPurity([{ impl: cheat(true), input: {} }]);

    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toMatch(/swallowed/);
  });

  it('fails a plan() that throws for another reason', async () => {
    const broken = implementAction(
      defineAction({ ...base, id: 'x.broken', kind: 'command' }),
      {
        plan: () => Promise.reject(new Error('NotImplemented')),
        revalidate: valid,
        execute: done,
      },
    );

    const failures = await checkPlanPurity([{ impl: broken, input: {} }]);

    expect(failures).toEqual([
      { actionId: 'x.broken', reason: 'NotImplemented' },
    ]);
    expect(createTestPrincipal().id).toBe('user-1');
  });
});
