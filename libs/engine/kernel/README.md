# kernel

Primitives shared by every engine module (M0-16): configuration loading, a redacting logger, a clock and id generator, Problem mapping, and the bounded buffers of I-6. Later work packages add the rest of the kernel (scheduler, executor, plan store) beside these.

Tags: `type:kernel`, `runtime:node`. Imports `@app/contracts` (types and schemas), `@app/ports` (types and `LANES`), `zod`, `yaml` and `pino`. `pino` is confined to this project (I-11).

## Public API

| Area      | Export                                                                                                           | Notes                                                                                                                                                                                                                                                              |
| --------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bounded` | `BoundedRing<T>`, `BoundedQueue<T>`                                                                              | `{maxItems, maxBytes, sizeOf?, onDrop?}`; `stats()` gives `{items, bytes, dropped, droppedBytes, maxItems, maxBytes}`. Ring: `add` evicts the oldest. Queue: `offer` refuses a new item that does not fit. Both: `shift`, `peek`, `drain`, `toArray`, `clear`. |
| `scheduler` | `BrokerScheduler`, `scheduleMgmtRead`, `scheduleMgmtWrite`, `schedulePromScrape`, `isOverloadError`, `DEFAULT_AIMD`, `Timers`, `systemTimers`, `createManualTimers` | I-8. `run({connectionId, lane, signal?, dedupeKey?}, task)` and `holdSlot(...)` (a slot held while a body is read). Lanes `interactive` > `live` > `background`; background is 1 in flight per broker (not configurable) and 64 globally; AIMD on the pause between background requests (x2 after 3 overload signals: 429, 5xx, unreachable, or p50 latency above 2x baseline; -50 ms per healthy answer); keyed GETs are single-flighted and cached 2 s. Bounded queues refuse with `BUDGET_EXCEEDED` and count the drop. `snapshot()` is the metrics surface. |
| `clock`   | `Clock`, `systemClock`, `createManualClock`                                                                      | `now()` is wall time, `monotonic()` never goes back. Engine code takes a `Clock`, never `Date.now()`.                                                                                                                                                               |
| `ids`     | `createIdGenerator`, `isUlid`, `ulidTimestamp`                                                                   | Monotonic ULIDs, v4 UUIDs, and `planId`, `jobId`, `receiptId`, `correlationId`. Clock and randomness are injectable.                                                                                                                                               |
| `problem` | `AppError`, `toProblem`, `PROBLEM_STATUS`, `problemType`                                                         | Throw `AppError(code, {detail, ...})`; `toProblem(err, {correlationId})` returns a contract `Problem`. Unknown errors become `INTERNAL` with no detail.                                                                                                              |
| `log`     | `createLogger`, `withCorrelation`, `redactText`, `redactValue`, `isSensitiveKey`, `REDACTED`                     | pino 10.4.0 JSON lines, redacted before they reach the sink.                                                                                                                                                                                                        |
| `config`  | `loadConfig`, `envVarName`, `ConfigError`                                                                        | `loadConfig(schema, {envPrefix, env, file, defaults})`; precedence env > `*_FILE` > file > defaults.                                                                                                                                                                |

## Invariants

- **I-6.** Every buffer is bounded by items and bytes, and every drop is counted (`dropped`, `droppedBytes`) and reported to `onDrop`. The classes live in `src/bounded`, the one place `@app/bounded-buffers-only` does not apply. Their add methods are named `add` and `offer` because the rule rejects `.push` on anything named like a buffer.
- **I-8.** The scheduler is the only code that runs management and Prometheus HTTP work. At most one background request per broker is ever in flight, and interactive work never waits for background work (it may wait for other interactive work when the lane is at its cap). Cached results are shared between callers: treat them as immutable. `src/scheduler/broker-scheduler.spec.ts` carries AC-1 and AC-2, a model test over random lanes, brokers and outcomes, and the cancellation, queue-full and shutdown cases.
- **I-10.** Secrets do not reach logs or Problems. The logger masks, on the finished line, values of keys such as `authorization`, `cookie`, `password`, `token`, `secret`, `x-*` credential headers, `body` and `payload`, and scrubs credentialed URIs (AMQP, HTTP, shovel and federation), secret query parameters, JWTs and Bearer values in every string. `toProblem` redacts `detail` and never copies the message or stack of an unknown error. `ConfigError` names keys and rules, never values. Redaction errs towards masking too much.
- **I-11.** `pino` (and `pino-*`) may be imported only here; other projects use the `Logger` interface.
- **Config.** Unknown keys are rejected in every source (environment, file, defaults), even when the schema would strip them. Environment variables are `PREFIX_SECTION__KEY` (`APP_SERVER__PUBLIC_URL` is `server.publicUrl`); `..._FILE` reads the value from a file. Text from the environment or a file is converted to the number, boolean, array (JSON) or object (JSON) the schema asks for.

Open questions: OQ-110 to OQ-116 (kernel) and OQ-170 to OQ-178 (scheduler) in [docs/open-questions.md](../../../docs/open-questions.md).

## Proof commands

```sh
pnpm nx test kernel
pnpm nx test kernel --testNamePattern=scheduler
pnpm nx run-many -t lint typecheck test -p kernel
```
