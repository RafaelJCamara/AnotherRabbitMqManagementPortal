# contracts

`@app/contracts`: the one contract registry (ADR-003, blueprint 3.1). Each capability is declared once, in zod 4, and everything else is derived from it: the router, the MCP tools, the CLI, the UI client and the two committed specs. Tags: `type:contracts`, `runtime:isomorphic`. The only runtime dependency is `zod`; no Node builtins.

## Public API

| Area      | Exports                                                                                                                                                                  | File                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Kit       | `defineAction`, `ActionDef`, `InputOf`, `OutputOf`, `defineTopic`, `TopicDef`, `ParamsOf`, `ItemOf`                                                                      | `src/kit/define-action.ts`, `src/kit/define-topic.ts`      |
| Invariants | `checkRegistry` (all violations), `assertRegistry` (throws), `Registry`, `Violation`                                                                                    | `src/kit/invariants.ts`                                    |
| Ids       | `ConnectionId`, `ActionId`, `TopicId`, `PlanId`, `JobId`, `ReceiptId`, `FeatureId`, `ObjectKey`, `Permission`, `WarningId`, `CellId`, `ConformanceId` (types and schemas) | `src/brands.ts`                                            |
| ObjectKey | `encodeObjectKey(vhost, name)`, `decodeObjectKey(key)`                                                                                                                   | `src/object-key.ts`                                        |
| Errors    | `ErrorCode`, `Problem`, `GateDecision`, `WarningRef` (types and schemas)                                                                                                 | `src/errors.ts`                                            |
| Frames    | `ClientFrame`, `ServerFrame` (live protocol), `PortFrame` (desktop MessagePort), `CtlFrame` (main to engine)                                                             | `src/live-frames.ts`, `src/port-frames.ts`, `src/ctl-frames.ts` |
| Bridge    | `PlatformBridge` v1 (`BRIDGE_VERSION`), `AppInfo`, `SaveTarget`                                                                                                          | `src/bridge.ts`                                            |
| Config    | `EnvClass`, `Risk`, `EngineMode`, `Qos`                                                                                                                                  | `src/config/env.ts`                                        |
| Secrets   | `secretInput()` (a write-only string), `SecretStatusSchema` (`isSet`, `updatedAt`), `hasSecretField`, `SECRET_MAX_CHARS`                                                 | `src/secret.ts`                                            |
| Registry  | `registry`: every action and topic the engine serves                                                                                                                     | `src/registry/`                                            |
| Emitters  | `emitOpenApi`, `emitAsyncApi`, `emitSpecs`, `specDrift`                                                                                                                  | `src/emit/`                                                |

The kit (define-\*, invariants, emitters) is about 560 lines, under the 800 line cap in blueprint section 4. A bigger kit needs a new ADR.

## Adding an action

Declare it with `defineAction` in the registry, add it to `src/registry/index.ts`, then regenerate the specs:

```
pnpm nx run contracts:api-docs        # writes docs/api/openapi.v1.json and asyncapi.v1.json
pnpm nx run contracts:api-docs-check  # regenerates in memory and fails on any difference
```

The `action` and `topic` generators (M0-35) will do the first two steps; until they land, follow `src/registry/meta.ts`.

## Invariants

Enforced by `checkRegistry`, which both emitters call first, so an invalid registry never produces a spec:

- every endpoint (method and path, ignoring parameter names) is exactly one action; ids are unique and look like `namespace.verb`;
- every `{param}` in a path is a required field of the input;
- GET is bound to `kind: 'query'` only and carries flat inputs (scalars and arrays of scalars);
- a mutating action (`command`, `job`, `peek`, or `mcp.mutating`) has `audit: 'attempt+outcome'`;
- a secret is write-only (I-10): no secretInput() field in an action output, in a topic's params or items, in a path parameter or in any field of a GET;
- a topic is bounded (`ring.items` and `ring.bytes` positive integers), has a positive `maxHz` when set, and has `key()` when its flow is `snapshot-delta`.

Other rules: schemas are explicit (`@app/explicit-zod-schemas`: no `z.any()`, no loose objects), and the emitters reject schemas that need `$ref` or `$defs` (recursive types) until a spec needs them.

## Generated specs

`docs/api/openapi.v1.json` (OpenAPI 3.1, server `/api/v1`) and `docs/api/asyncapi.v1.json` (AsyncAPI 3.0: the live channel with `ClientFrame` and `ServerFrame`, plus one channel per topic) are committed. They come from `z.toJSONSchema` (draft 2020-12) with sorted keys, so regeneration is byte-for-byte reproducible. The docs site renders the OpenAPI document. `PortFrame` and `CtlFrame` are not in the specs: they never leave the machine.

The emitter script lives in `tools/api-docs` because this library may not use `node:fs`.

## Proof commands

```
pnpm nx run-many -t typecheck lint test -p contracts api-docs
pnpm nx run contracts:api-docs-check
pnpm nx build docs
```
