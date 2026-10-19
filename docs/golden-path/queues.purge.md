# Golden path: `queues.purge` (a two-phase command)

A command that removes messages for good: the case the action pipeline exists for. It shows the two halves of a two-phase action (`plan` reads, `execute` writes), the TOCTOU re-check, the typed confirmation, and what the generated tests prove about the audit trail.

This page is executable. `tools/generators/e2e/golden-path.spec.ts` runs the `sh generate` block, writes every `file=` block over the generated file, and then runs lint, typecheck, test and `contracts:api-docs-check` on the result.

| Fact       | Value                                                                  |
| ---------- | ---------------------------------------------------------------------- |
| Id         | `queues.purge`                                                         |
| Kind       | `command`: `POST /api/v1/connections/{cid}/queues/{qkey}/purge`        |
| Permission | `messages.purge`                                                       |
| Risk       | `critical`, planning `required`, audit `attempt+outcome`               |
| Exposure   | MCP mutating tool (plans only for an AI client), CLI `queues purge`    |
| Module     | `svc-admin` (`libs/engine/svc-admin`)                                  |

## 1. Generate

```sh generate
pnpm nx g @app/generators:service-module svc-admin
pnpm nx g @app/generators:ui-feature admin --route='/c/:cid/admin'
pnpm nx g @app/generators:action queues.purge --module=svc-admin --kind=command --http='POST /connections/{cid}/queues/{qkey}/purge' --permission=messages.purge --risk=critical --planning=required --mcp=mutating --cli='queues purge'
```

The generator refuses what it cannot make safe: a command without `--risk` and `--planning`, a `critical` action with `--planning=none`, a command bound to `GET`, a command presented as an MCP read tool. What it adds is the same set as in [explorer.queues.list](explorer.queues.list.md), with a `plan` and a `revalidate` stub and a unit spec that also checks plan purity, the audit attempt and outcome, and the receipt.

## 2. The contract

The target of a purge is a queue, named by an `ObjectKey` (vhost and name in one path segment, so the `/` vhost survives proxies). `confirm` makes the person type the queue's name in production: the engine compares it, the UI cannot skip it. The broker does not say how many messages a purge removed, so the output reports what the plan counted and says so in its name.

```ts file=libs/shared/contracts/src/registry/queues-purge.ts
// queues.purge: remove every message from a queue, for good.
import { z } from 'zod';

import { ConnectionIdSchema, ObjectKeySchema } from '../brands.ts';
import { defineAction } from '../kit/define-action.ts';
import { decodeObjectKey } from '../object-key.ts';

export const QueuesPurgeInputSchema = z.strictObject({
  cid: ConnectionIdSchema,
  qkey: ObjectKeySchema,
});

export const QueuesPurgeOutputSchema = z.strictObject({
  /** Messages the queue held when the plan was made. The broker does not report what it removed. */
  messagesAtPlan: z.number().int().nonnegative(),
});

export const queuesPurge = defineAction({
  id: 'queues.purge',
  kind: 'command',
  summary: 'Remove every message from a queue, for good',
  input: QueuesPurgeInputSchema,
  output: QueuesPurgeOutputSchema,
  permission: 'messages.purge',
  risk: 'critical',
  planning: 'required',
  confirm: {
    requiredWhen: (env) => env === 'prod',
    phrase: (input) => {
      try {
        return `purge ${decodeObjectKey(input.qkey).name}`;
      } catch {
        return 'purge';
      }
    },
  },
  audit: 'attempt+outcome',
  target: (input) => ({ connectionId: input.cid }),
  http: {
    method: 'POST',
    path: '/connections/{cid}/queues/{qkey}/purge',
  },
  mcp: {
    expose: true,
    mutating: true,
    title: 'Purge a queue',
    description:
      'Remove every message from a queue, for good. An AI client can only create the plan.',
  },
  cli: { command: 'queues purge' },
  since: '1.0',
});
```

## 3. The ports of the module

`plan` and `revalidate` read through the module's read port. `execute` does not get a write port from `deps`: the executor hands it `ctx.writes`, and only `implementAction` bodies can reach it (I-2).

```ts file=libs/engine/svc-admin/src/deps.ts
import type { MgmtReadPort } from '@app/ports';

/**
 * The ports this module needs, injected by the composition root. Writes are not here: an action
 * reaches the write ports through `ctx.writes` in `execute`, and nowhere else.
 */
export interface AdminModuleDeps {
  readonly mgmt: MgmtReadPort;
}
```

```ts file=libs/engine/svc-admin/src/testing.ts
// Fakes for the ports of this module, shared by its specs, by the architecture manifest
// (tools/arch-tests) and by the HTTP specs (libs/testkit). Give each port in deps.ts a fake here.
import type { AdminModuleDeps } from './deps';

/** A management API in which every queue is a quorum queue with 12 messages. */
const mgmt: AdminModuleDeps['mgmt'] = {
  get: (request) =>
    Promise.resolve(
      request.schema.parse({ type: 'quorum', messages: 12, consumers: 0 }),
    ),
  stream: () =>
    Promise.reject(new Error('the fake management API does not stream')),
};

export function createAdminFakeDeps(): AdminModuleDeps {
  return { mgmt };
}
```

## 4. The action

- `plan` reads the queue and returns the preview the person confirms. It makes no write; the unit spec runs it against write ports that throw.
- `revalidate` is the TOCTOU re-check: the same cheap read, and `{ stale }` when the thing the person approved is no longer the thing that would be purged. The executor turns that into 409 `PLAN_STALE`.
- `execute` re-decodes the key (the plan never carries more than the input), sends the broker request through `ctx.writes`, and answers in the contract's shape.

```ts file=libs/engine/svc-admin/src/actions/queues-purge.ts
// queues.purge: Remove every message from a queue, for good.
import {
  decodeObjectKey,
  queuesPurge,
  type ConnectionId,
  type ObjectKey,
} from '@app/contracts';
import { AppError, implementAction, type ActionImpl } from '@app/kernel';
import { z } from 'zod';

import type { AdminModuleDeps } from '../deps';

/** What the management API says about a queue that this action needs. */
const QueueSchema = z.object({
  type: z.string(),
  messages: z.number().int().nonnegative().optional(),
});

/** The ports this action reads through: a subset of the module's deps (src/deps.ts). */
export type QueuesPurgeDeps = Pick<AdminModuleDeps, 'mgmt'>;

/** A key that does not decode is the caller's mistake, not an engine failure. */
function queueOf(key: ObjectKey): { vhost: string; name: string } {
  try {
    return decodeObjectKey(key);
  } catch {
    throw new AppError('VALIDATION_FAILED', {
      detail: 'qkey is not a valid object key.',
    });
  }
}

const queuePath = (vhost: string, name: string): string =>
  `/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(name)}`;

export const createQueuesPurgeAction = (
  deps: QueuesPurgeDeps,
): ActionImpl<typeof queuesPurge> => {
  const read = (cid: ConnectionId, key: ObjectKey, signal: AbortSignal) => {
    const { vhost, name } = queueOf(key);
    return deps.mgmt
      .get(
        {
          connectionId: cid,
          path: queuePath(vhost, name),
          schema: QueueSchema,
          lane: 'interactive',
        },
        signal,
      )
      .then((queue) => ({ vhost, name, queue }));
  };

  return implementAction(queuesPurge, {
    plan: async (input, ctx) => {
      const { vhost, name, queue } = await read(
        input.cid,
        input.qkey,
        ctx.signal,
      );
      return {
        preview: {
          vhost,
          name,
          type: queue.type,
          messages: queue.messages ?? 0,
        },
        gates: [],
        warnings: [],
        consentsRequired: [],
      };
    },

    revalidate: async (plan, ctx) => {
      const { queue } = await read(plan.input.cid, plan.input.qkey, ctx.signal);
      return queue.type === plan.preview.type
        ? 'valid'
        : { stale: 'The queue type changed since the plan was made.' };
    },

    execute: async (input, ctx) => {
      const { vhost, name } = queueOf(input.qkey);
      await ctx.writes.mgmt.send(
        {
          connectionId: input.cid,
          method: 'DELETE',
          path: `${queuePath(vhost, name)}/contents`,
          schema: z.unknown(),
        },
        ctx.signal,
      );
      return { messagesAtPlan: ctx.plan?.preview.messages ?? 0 };
    },
  });
};
```

## 5. Prove it

```sh
pnpm nx run contracts:api-docs
pnpm nx run-many -t lint typecheck test -p svc-admin,feature-admin,contracts,testkit,arch-tests
pnpm nx run contracts:api-docs-check
```

What the generated tests now establish, without being edited:

- `plan()` ran against write ports that throw, and none was called (plan purity).
- A principal without `messages.purge` gets `FORBIDDEN_RBAC` and leaves no audit row, no receipt and no write call; with no authorizer wired, even the UI principal is refused (deny by default).
- A run leaves an audit attempt, then an outcome that names the attempt, and a receipt.
- Over HTTP a direct call is `428 PLAN_REQUIRED` with the plan in `Location`; executing that plan with the typed phrase returns the output. On a production connection the call is locked until a person arms it, which the HTTP spec does with `engine.arm('c1')`.

## What to copy into your own action

- `plan` and `revalidate` read through `deps`; `execute` writes through `ctx.writes` and through nothing else.
- State what is not known. The broker reports no count for a purge, so the output says `messagesAtPlan`.
- Validation of caller mistakes is `VALIDATION_FAILED`; only a broken engine is `INTERNAL`.
- Never name a secret, a message body or a header value in an error detail, a log line or a preview.
