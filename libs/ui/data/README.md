# ui-data

Typed access to the engine for the UI (ADR-003, blueprint 3.8 and 10): `EngineApi` (`call`, `plan`, `execute`), `engineResource`, the `LiveClient`, and the `HttpClient` interceptors. Types come from the zod schemas of `@app/contracts`; there is no client code generation. A feature talks to the engine through these and nothing else.

Tags: `type:ui-data`, `runtime:browser`. Imports `@app/contracts`, `@app/live-protocol` and `@app/ui-platform`.

## Public API

- **`EngineApi`** (`engine-api.ts`): `call(action, input)` builds the request from the action's HTTP binding and returns the typed output; `plan(action, input)` posts to `/api/v1/actions/{actionId}/plans`; `execute(action, planId, {consents, confirmation?, idempotencyKey?})` posts to `/api/v1/plans/{planId}/execute` and returns the output with its receipt, or a job. Types `EnginePlan`, `PlanGate`, `ExecuteRequest`, `ExecuteResult`.
- **`engineResource(action, () => input | undefined)`** (`engine-resource.ts`): `httpResource` plus `parse` for a `query` action. It refuses commands and peeks. `buildEngineRequest` (`engine-request.ts`) is the shared rule: path parameters come from the input, other fields are query parameters for GET and the JSON body otherwise.
- **`LiveClient`** (`live-client.ts`): `subscribe(topic, params, {credit?})` returns an `Observable<LiveEvent>` (`data`, `snapshot`, `delta`, `gap`, `status`, `reset`). Signals `state`, `engineVersion`, `goaway`; `stats` counts credit violations, stale and orphan frames, dropped items, gaps and reconnects. Config token `LIVE_CLIENT_CONFIG` (`initialCredit` 16, backoff, `afterRender`, `setTimer`).
- **Errors** (`errors.ts`): `EngineProblemError` carries the Problem, with `code`, `status`, `gate`, `warnings`, `retryable`, `correlationId`, `location` (the plan of a 428) and `synthetic` (the UI made the Problem up from the HTTP status). `isEngineProblem`, `parseProblem`, `syntheticProblem`. Carrier failures stay `TransportError` (ui-platform).
- **Interceptors** (`interceptors.ts`): `correlationInterceptor` (`x-request-id`), `authInterceptor` (engine credentials, same-origin paths only), `problemInterceptor`, and the chain `ENGINE_INTERCEPTORS`. `provideEngineData()` installs `HttpClient` with the chain on top of the engine transport.
- `ENGINE_PARSE`: in dev and test builds every answer and every live item is parsed against its zod schema; production builds skip it.

## Live protocol, client side

- One session per UI, opened on the first subscription. The client sends `hello`, waits for `welcome`, then sends `sub` with its initial credit.
- The credit balance is a `Credits` from `@app/live-protocol`, the class the engine session counts with. A frame that arrives with no credit left is counted (`creditViolations`) and still delivered.
- **Credit goes back after rendering.** Frames are delivered to subscribers at once; the credit for them is granted in the next animation frame (`afterRender`), one `credit` frame per subscription. A page that is not drawing grants nothing, so the engine keeps its items and each topic's QoS decides what is dropped and counted.
- `seq` is a cursor. A `data` or `delta` frame that is not newer than the last delivered is dropped and counted; a `snapshot` always replaces the state; loss is only ever announced by a `gap` frame.
- On transport loss the client reconnects with backoff and sends `hello{resume: {session, lastSeq}}`. If the engine resumes the session, credits restart at zero and the client grants its initial credit again (OQ-121); if not, subscribers get a `reset` event and the subscriptions are made again. After the allowed attempts every subscription fails with a `TransportError` and the state is `down`.

## Invariants

- No `fetch`, `XMLHttpRequest` or socket here (`@app/no-direct-fetch`); everything goes through `ENGINE_TRANSPORT`.
- The UI never computes authorisation: a gate or warning reaches the screen as the engine sent it, through `EngineProblemError`.
- Nothing unbounded (I-6, I-7): the live client holds no queue of its own, and credit bounds what the engine sends.
- No silent loss (I-13): gaps, drops, resets, stale frames and credit violations are events or counters.
- Dependencies follow the type:ui-data row of blueprint 2.2; `pnpm nx lint ui-data` enforces them.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p ui-data
```

Tests: AC-1 (`carrier-parity.spec.ts`: one component on the MessagePort and the WebSocket transport, identical results), AC-2 (`interceptors.spec.ts`: a Problem becomes a typed error with gate and warnings; `live-client.spec.ts`: credit only after a rendered batch). The LiveClient is tested against the real `LiveSession` through `@app/ui-platform/testing`.
