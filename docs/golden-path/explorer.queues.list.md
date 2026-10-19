# Golden path: `explorer.queues.list` (a query)

The smallest complete endpoint: one query that reads a window of queues from the management API. It shows the whole route from the generator to a green `api-docs-check`, and the rules a query keeps: a bounded answer (I-7), reads only through a port (I-8), and no audit row because nothing changes.

This page is executable. `tools/generators/e2e/golden-path.spec.ts` runs the `sh generate` block, writes every `file=` block over the generated file, and then runs lint, typecheck, test and `contracts:api-docs-check` on the result. When this page and the generators disagree, that test fails.

| Fact        | Value                                                  |
| ----------- | ------------------------------------------------------ |
| Id          | `explorer.queues.list`                                 |
| Kind        | `query`: `GET /api/v1/connections/{cid}/queues`        |
| Permission  | `broker.read`                                          |
| Risk        | `none`, planning `none`, audit `none`                  |
| Exposure    | MCP read tool, CLI `queues list`, UI command           |
| Module      | `svc-explorer` (`libs/engine/svc-explorer`)            |

## 1. Generate

```sh generate
pnpm nx g @app/generators:service-module svc-explorer
pnpm nx g @app/generators:ui-feature explorer --route='/c/:cid/explorer'
pnpm nx g @app/generators:action explorer.queues.list --module=svc-explorer --kind=query --http='GET /connections/{cid}/queues' --permission=broker.read --mcp=read --cli='queues list'
```

The action generator adds, and refuses to overwrite anything:

- `libs/shared/contracts/src/registry/explorer-queues-list.ts`: the contract, listed in the registry and exported from `@app/contracts`.
- `libs/engine/svc-explorer/src/actions/explorer-queues-list.ts`: `createExplorerQueuesListAction`, an `implementAction` whose bodies fail with `INTERNAL` until you write them. It is listed in `src/actions/index.ts` and exported from the module.
- `explorer-queues-list.spec.ts` and `explorer-queues-list.fixture.ts` beside it: the unit spec (contract, deny by default, a query leaves no audit row) and what it runs.
- `libs/testkit/src/http/explorer-queues-list.http.spec.ts`: the same action through the real router with `createTestEngine().inject`.
- `libs/ui/feature-explorer/src/commands/explorer-queues-list.command.ts`: the UI command stub, with its title in the feature's i18n scope.
- One entry in `tools/arch-tests/src/registered-actions.ts`: the plan-purity manifest.

Run the tests now and they fail. That is the starting point, not a fault.

## 2. The contract

A window, never the whole inventory: `pageSize` is capped by the contract itself, so no caller, MCP client included, can ask for an unbounded list.

```ts file=libs/shared/contracts/src/registry/explorer-queues-list.ts
// explorer.queues.list: a window of the queues of a connection.
import { z } from 'zod';

import { ConnectionIdSchema } from '../brands.ts';
import { defineAction } from '../kit/define-action.ts';

/** The most queues one call returns (I-7: the UI never materialises an unbounded collection). */
export const QUEUE_WINDOW_MAX = 200;

export const ExplorerQueuesListInputSchema = z.strictObject({
  cid: ConnectionIdSchema,
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(QUEUE_WINDOW_MAX).optional(),
});

export const ExplorerQueueSchema = z.strictObject({
  vhost: z.string(),
  name: z.string(),
  type: z.string(),
  messages: z.number().int().nonnegative(),
});

export const ExplorerQueuesListOutputSchema = z.strictObject({
  items: z.array(ExplorerQueueSchema).max(QUEUE_WINDOW_MAX),
  page: z.number().int().min(1),
  pageCount: z.number().int().min(0),
  total: z.number().int().nonnegative(),
});

export const explorerQueuesList = defineAction({
  id: 'explorer.queues.list',
  kind: 'query',
  summary: 'List a window of the queues of a connection',
  input: ExplorerQueuesListInputSchema,
  output: ExplorerQueuesListOutputSchema,
  permission: 'broker.read',
  risk: 'none',
  planning: 'none',
  audit: 'none',
  target: (input) => ({ connectionId: input.cid }),
  http: { method: 'GET', path: '/connections/{cid}/queues' },
  mcp: {
    expose: true,
    mutating: false,
    title: 'List queues',
    description: 'List a window of the queues of a connection.',
  },
  cli: { command: 'queues list' },
  since: '1.0',
});
```

## 3. The ports of the module

A service reads the broker through ports its module is given, never through an adapter it imports. `deps.ts` names the port; `testing.ts` gives specs a fake. The composition root wires the real port, routed through the `BrokerScheduler` so that interactive work pre-empts background work (I-8).

```ts file=libs/engine/svc-explorer/src/deps.ts
import type { MgmtReadPort } from '@app/ports';

/**
 * The ports this module needs, injected by the composition root. The management port is the
 * scheduled one (`scheduleMgmtRead`): this module never talks to the adapter directly.
 */
export interface ExplorerModuleDeps {
  readonly mgmt: MgmtReadPort;
}
```

```ts file=libs/engine/svc-explorer/src/testing.ts
// Fakes for the ports of this module, shared by its specs, by the architecture manifest
// (tools/arch-tests) and by the HTTP specs (libs/testkit). Give each port in deps.ts a fake here.
import type { ExplorerModuleDeps } from './deps';

/** A management API that answers every window with one queue. */
const mgmt: ExplorerModuleDeps['mgmt'] = {
  get: (request) =>
    Promise.resolve(
      request.schema.parse({
        items: [{ vhost: '/', name: 'orders', type: 'quorum', messages: 12 }],
        page: 1,
        page_count: 1,
        total_count: 1,
      }),
    ),
  stream: () =>
    Promise.reject(new Error('the fake management API does not stream')),
};

export function createExplorerFakeDeps(): ExplorerModuleDeps {
  return { mgmt };
}
```

## 4. The action

`execute` is the only body. A query has no `plan` or `revalidate`: `implementAction` asks for them only for actions that change something. The answer is parsed against the contract by the executor, so an adapter that returns the wrong shape is an `INTERNAL` error and not a corrupt UI.

```ts file=libs/engine/svc-explorer/src/actions/explorer-queues-list.ts
// explorer.queues.list: List a window of the queues of a connection.
import { QUEUE_WINDOW_MAX, explorerQueuesList } from '@app/contracts';
import { implementAction, type ActionImpl } from '@app/kernel';
import { z } from 'zod';

import type { ExplorerModuleDeps } from '../deps';

const DEFAULT_PAGE_SIZE = 100;

/** The part of the management API's answer this action uses; the other fields are ignored. */
const QueuePageSchema = z.object({
  items: z.array(
    z.object({
      vhost: z.string(),
      name: z.string(),
      type: z.string(),
      messages: z.number().int().nonnegative().optional(),
    }),
  ),
  page: z.number().int(),
  page_count: z.number().int(),
  total_count: z.number().int(),
});

/** The ports this action reads through: a subset of the module's deps (src/deps.ts). */
export type ExplorerQueuesListDeps = Pick<ExplorerModuleDeps, 'mgmt'>;

export const createExplorerQueuesListAction = (
  deps: ExplorerQueuesListDeps,
): ActionImpl<typeof explorerQueuesList> =>
  implementAction(explorerQueuesList, {
    execute: async (input, ctx) => {
      const page = await deps.mgmt.get(
        {
          connectionId: input.cid,
          path: '/api/queues',
          query: {
            page: input.page ?? 1,
            page_size: Math.min(
              input.pageSize ?? DEFAULT_PAGE_SIZE,
              QUEUE_WINDOW_MAX,
            ),
            pagination: true,
          },
          schema: QueuePageSchema,
          lane: 'interactive',
        },
        ctx.signal,
      );
      return {
        items: page.items.map((queue) => ({
          vhost: queue.vhost,
          name: queue.name,
          type: queue.type,
          messages: queue.messages ?? 0,
        })),
        page: page.page,
        pageCount: page.page_count,
        total: page.total_count,
      };
    },
  });
```

## 5. Prove it

```sh
pnpm nx run contracts:api-docs        # regenerates docs/api/openapi.v1.json; commit the result
pnpm nx run-many -t lint typecheck test -p svc-explorer,feature-explorer,contracts,testkit,arch-tests
pnpm nx run contracts:api-docs-check
```

The generated tests now pass without being edited: the unit spec holds the contract to the kit invariants and proves the permission is enforced with deny by default; the HTTP spec proves the route, the 401 without the launch token, the 403 without the permission, the 400 on input that breaks the contract and the 405 on another method.

## What to copy into your own action

- The factory shape `create<Id>Action(deps)`: ports come in through `deps`, the module lists the factory, and a spec builds it over fakes.
- A bounded answer. Anything that lists inventory is a window with a cap in the contract.
- The port is the scheduled one. Nothing here knows the broker's address, credentials or protocol.
- Errors are `AppError` with a stable code. A broker failure the port maps to a Problem passes through untouched.
