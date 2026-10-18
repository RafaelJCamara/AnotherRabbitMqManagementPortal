// Actions used by the specs of the action layer. Not part of the public API.
import { defineAction } from '@app/contracts';
import { z } from 'zod';

import { implementAction } from './implement-action.ts';
import type { ActionContext, ExecuteContext } from './types.ts';

export interface Probe {
  /** How many times `execute` ran: the number every refusal test pins at zero. */
  executed: number;
  planned: number;
  revalidated: number;
  /** What `revalidate` answers; set it to simulate drift. */
  drift: string | undefined;
  /** Throw from execute with this error, when set. */
  failWith: Error | undefined;
  /** The context the last `plan()` call received. */
  lastPlanContext: ActionContext | undefined;
  lastExecuteContext: ExecuteContext | undefined;
  /** Plain reads of the broker, made by `plan()`. */
  reads: number;
}

export function createProbe(): Probe {
  return {
    executed: 0,
    planned: 0,
    revalidated: 0,
    drift: undefined,
    failWith: undefined,
    lastPlanContext: undefined,
    lastExecuteContext: undefined,
    reads: 0,
  };
}

export const purgeDef = defineAction({
  id: 'queues.purge',
  kind: 'command',
  summary: 'Purge a queue',
  input: z.strictObject({ connectionId: z.string(), name: z.string() }),
  output: z.strictObject({ purged: z.number() }),
  permission: 'messages.purge',
  risk: 'critical',
  planning: 'required',
  confirm: {
    requiredWhen: (env) => env === 'prod',
    phrase: (input) => `purge ${input.name}`,
  },
  audit: 'attempt+outcome',
  target: (input) => ({
    connectionId: input.connectionId as never,
    kind: 'queue',
    name: input.name,
  }),
  since: '1.0',
});

export function purgeImpl(probe: Probe) {
  return implementAction(purgeDef, {
    plan: (input, ctx) => {
      probe.planned += 1;
      probe.reads += 1;
      probe.lastPlanContext = ctx;
      return Promise.resolve({
        preview: { queue: input.name, messages: 12 },
        gates: [],
        warnings: [],
        consentsRequired: [],
        sensitivePayload: { note: 'secret body' },
      });
    },
    revalidate: () => {
      probe.revalidated += 1;
      return Promise.resolve(
        probe.drift === undefined ? 'valid' : { stale: probe.drift },
      );
    },
    execute: async (_input, ctx) => {
      probe.executed += 1;
      probe.lastExecuteContext = ctx;
      if (probe.failWith !== undefined) throw probe.failWith;
      await ctx.writes.mgmt.send({} as never, ctx.signal);
      return { purged: 12 };
    },
  });
}

/** A low-risk command whose plan is optional and can ask for a consent. */
export const renameDef = defineAction({
  id: 'queues.rename',
  kind: 'command',
  summary: 'Rename a queue',
  input: z.strictObject({ name: z.string() }),
  output: z.strictObject({ name: z.string() }),
  permission: 'queues.update',
  risk: 'low',
  planning: 'optional',
  audit: 'attempt+outcome',
  target: (input) => ({ name: input.name }),
  since: '1.0',
});

export function renameImpl(probe: Probe, consents: string[] = []) {
  return implementAction(renameDef, {
    plan: () => {
      probe.planned += 1;
      return Promise.resolve({
        preview: {},
        gates: [],
        warnings: [],
        consentsRequired: consents,
      });
    },
    revalidate: () => Promise.resolve('valid'),
    execute: (input) => {
      probe.executed += 1;
      return Promise.resolve({ name: input.name });
    },
  });
}

/** A command with no plan step of its own (planning none), as a low-risk toggle might be. */
export const pingDef = defineAction({
  id: 'ops.ping',
  kind: 'command',
  summary: 'Touch something harmless',
  input: z.strictObject({}),
  output: z.strictObject({ ok: z.boolean() }),
  permission: 'ops.ping',
  risk: 'none',
  planning: 'none',
  audit: 'attempt+outcome',
  target: () => ({}),
  since: '1.0',
});

export function pingImpl(probe: Probe) {
  return implementAction(pingDef, {
    plan: () =>
      Promise.resolve({
        preview: {},
        gates: [],
        warnings: [],
        consentsRequired: [],
      }),
    revalidate: () => Promise.resolve('valid'),
    execute: () => {
      probe.executed += 1;
      return Promise.resolve({ ok: true });
    },
  });
}

export const statDef = defineAction({
  id: 'queues.stat',
  kind: 'query',
  summary: 'Read queue statistics',
  input: z.strictObject({ name: z.string() }),
  output: z.strictObject({ depth: z.number() }),
  permission: 'queues.read',
  risk: 'none',
  planning: 'none',
  audit: 'none',
  target: (input) => ({ name: input.name }),
  http: { method: 'GET', path: '/queues/{name}/stat' },
  since: '1.0',
});

export function statImpl(probe: Probe) {
  return implementAction(statDef, {
    execute: () => {
      probe.executed += 1;
      return Promise.resolve({ depth: 3 });
    },
  });
}

export const startJobDef = defineAction({
  id: 'jobs.start',
  kind: 'job',
  summary: 'Start a long job',
  input: z.strictObject({ name: z.string() }),
  output: z.strictObject({ done: z.boolean() }),
  permission: 'jobs.start',
  risk: 'medium',
  planning: 'optional',
  audit: 'attempt+outcome',
  target: (input) => ({ name: input.name }),
  since: '1.0',
});

export function startJobImpl(probe: Probe) {
  return implementAction(startJobDef, {
    plan: () =>
      Promise.resolve({
        preview: {},
        gates: [],
        warnings: [],
        consentsRequired: [],
      }),
    revalidate: () => Promise.resolve('valid'),
    execute: () => {
      probe.executed += 1;
      return Promise.resolve({ jobId: 'job-1' as never });
    },
  });
}

/** Declares a wrong output, to prove the executor checks results against the contract. */
export const liarDef = defineAction({
  id: 'ops.liar',
  kind: 'query',
  summary: 'Returns the wrong shape',
  input: z.strictObject({}),
  output: z.strictObject({ ok: z.boolean() }),
  permission: 'ops.read',
  risk: 'none',
  planning: 'none',
  audit: 'none',
  target: () => ({}),
  since: '1.0',
});

export function liarImpl() {
  return implementAction(liarDef, {
    execute: () => Promise.resolve({ ok: 'yes' } as never),
  });
}
