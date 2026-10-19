# Golden path: `tap.messages` (a live topic)

A stream of captured messages pushed to the UI against credit it grants, with the loss policy written down: the topic is `sampled`, its ring is bounded by items and bytes, and nothing in an item can carry a secret. It shows what the `topic` generator declares and what the generated spec holds the declaration to.

This page is executable. `tools/generators/e2e/golden-path.spec.ts` runs the `sh generate` block, writes every `file=` block over the generated file, and then runs lint, typecheck, test and `contracts:api-docs-check` on the result.

| Fact       | Value                                                        |
| ---------- | ------------------------------------------------------------ |
| Id         | `tap.messages`                                               |
| Flow       | `credit`: one `data` frame costs one credit                  |
| QoS        | `sampled`: every n-th item, with `sampledEvery` and counters |
| Permission | `tap.start`                                                  |
| Module     | `svc-tap` (`libs/engine/svc-tap`)                            |

## 1. Generate

```sh generate
pnpm nx g @app/generators:service-module svc-tap
pnpm nx g @app/generators:topic tap.messages --module=svc-tap --flow=credit --qos=sampled --permission=tap.start
```

The topic generator adds `libs/shared/contracts/src/registry/tap-messages-topic.ts` (listed in the registry's `topics` and exported from `@app/contracts`), `topics.tap-messages-topic.spec.ts` and its `.fixture.ts` in the module, and lists the topic in the module's `src/topics.ts`. It refuses a `latest` topic without `--max-hz`, a `sampled` topic on the `snapshot-delta` flow, a ring of zero, and a permission that is not `area.verb`.

The topic is a declaration. The provider that feeds it, and the subscription handling that counts credit, arrive with the live hub (M0-33): the generated spec has an `it.todo` for that, so the gap is visible and does not pass for a test.

## 2. The contract

An item is one captured message as the UI first sees it: a preview of at most 16 KiB, and a `bodyRef` to fetch the rest in chunks. The ring bounds what the engine holds for a slow client (I-6); when it overflows, the live protocol counts the drop and says so in the next frame (I-13).

```ts file=libs/shared/contracts/src/registry/tap-messages-topic.ts
// tap.messages: messages captured by a tap (sampled, credit).
import { z } from 'zod';

import { ConnectionIdSchema, ObjectKeySchema } from '../brands.ts';
import { defineTopic } from '../kit/define-topic.ts';

export const TapMessagesParamsSchema = z.strictObject({
  cid: ConnectionIdSchema,
  queue: ObjectKeySchema,
});

export const TapMessagesItemSchema = z.strictObject({
  /** Unique per captured message; also the key. */
  id: z.string().min(1),
  /** Epoch milliseconds, when the engine received the copy. */
  receivedAt: z.number().int(),
  /** The first 16 KiB of the body as text. */
  preview: z.string().max(16 * 1024),
  /** Fetch the whole body in 1 MiB chunks with this reference. */
  bodyRef: z.string().min(1).optional(),
});

export const tapMessagesTopic = defineTopic({
  id: 'tap.messages',
  params: TapMessagesParamsSchema,
  item: TapMessagesItemSchema,
  qos: 'sampled',
  flow: 'credit',
  permission: 'tap.start',
  key: (item) => item.id,
  ring: { items: 2000, bytes: 8 * 1024 * 1024 },
});
```

```ts file=libs/engine/svc-tap/src/topics.tap-messages-topic.fixture.ts
// What topics.tap-messages-topic.spec.ts checks. Edit this file, not the spec, as the topic grows.

/** Params that pass the topic's params schema. */
export const sampleParams = { cid: 'c1', queue: 'LwBvcmRlcnM' };

/** An item that passes the topic's item schema. */
export const sampleItem = {
  id: 'm-1',
  receivedAt: 1_700_000_000_000,
  preview: 'hello',
};
```

## 3. Prove it

```sh
pnpm nx run contracts:api-docs        # regenerates docs/api/asyncapi.v1.json; commit the result
pnpm nx run-many -t lint typecheck test -p svc-tap,contracts
pnpm nx run contracts:api-docs-check
```

The generated spec establishes, without being edited:

- The declaration passes the kit invariants: a bounded ring, a key, no write-only secret in the params or the item.
- The sample params travel in a `sub` frame and the sample item in a `data` frame that the live frame schemas accept (`sampledEvery` included, because the topic is sampled).
- An item has one stable key, so coalescing and removals agree.
- The module declares the topic.

## What to copy into your own topic

- Pick the QoS for the loss you can accept and write it in the contract: `lossless` (never dropped; a gap and a snapshot on overflow), `latest` (coalesced by key at `maxHz`), `sampled` (every n-th item, counted).
- Bound the ring in items and bytes, and keep an item small: a preview, and a reference to the rest.
- Never put a secret in a topic. `checkRegistry` rejects a write-only field in params or item, and the spec runs it.
