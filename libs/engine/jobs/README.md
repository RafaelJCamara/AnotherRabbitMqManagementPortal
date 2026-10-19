# jobs

Durable jobs (ADR-015, M0-31): async generators with a checkpoint, a lease, a throttle and a budgeted drain, run by one in-house `JobRunner` over a lease-shaped `JobStore`. The same runner and the same store contract serve desktop and local (SQLite) and the team server (Postgres, `FOR UPDATE SKIP LOCKED`). The budgeted shutdown that drains it is the `DrainCoordinator` in `@app/kernel`; the SQL stores are in `@app/persistence` (`kysely` is confined there, I-11).

Tags: `type:kernel`, `runtime:node`, `trust:critical`. Imports `@app/contracts`, `@app/kernel`, `@app/ports` and `zod`.

## Public API

| Export                                    | Notes                                                                                                                                                                                                                                           |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defineJob(def)`, `isDefinedJob`          | The only way to a `JobDef` (I-2). Checks the type (`module.verb`), the version, the zod schemas for input, checkpoint and output, the `resumable` flag, `run` and `onDrain`, and returns a frozen definition the runner will register. |
| `createJobRunner(options)`                | `register`, `submit`, `command`, `start`, `recover`, `drain`, `reopen`, `drainPhase`, `stats`. Options: `store`, `cipher`, `clock`, `timers`, `ids`, `writes` (all required), `logger`, `journal`, `owner`, `leaseMs`, `heartbeatMs`, `pollMs`, `maxConcurrent`, `maxAttempts`, `commandBudgetMs`, `settleReserveMs`, `recovery`, `autoResume`, `mayOverride`, `onEvent`, `onState`. |
| `LEASE_MS`, `HEARTBEAT_MS`                | 30 s and 10 s (blueprint 8).                                                                                                                                                                                                                    |
| `createTokenBucket(options)`              | `take(n, signal)` waits, in order, for `n` tokens; bounded waiters (I-6); time from the injected `Clock` and `Timers`.                                                                                                                          |
| `createMemoryJobStore()`                  | A `JobStore` in memory for specs; it passes the same contract as the SQL stores. `failNext(method)` makes a method reject.                                                                                                                      |
| `MAX_SEALED_BYTES`                        | 1 MiB: the most a sealed input, checkpoint or result may take.                                                                                                                                                                                  |
| Types                                     | `JobDef`, `JobContext`, `JobEvent`, `JobPreflight`, `JobStopReason`, `JobDrainEntry`, `JobRecoveryReport`, `JobRunnerStats`, `JobThrottle`, `OnDrainOutcome`, `JobRecord`, `JobState`.                                                           |

`JobContext.executorWrite` is the typed `ExecutorWrite` bundle of `@app/kernel` (the critique fix): a job body receives the write ports from the runner and from nowhere else.

## How a job lives

`submit(type, input, requester, {idempotencyKey, planHash})` seals the requester, the bound fields and the input and stores a `queued` job; the same requester and key return the same job, and the same key for other work is a 409. The runner claims a job (one runner at a time, 30 s lease renewed every 10 s), opens it, and runs it as the principal `job:<id>` acting for the requester. States: `queued`, `running`, `paused`, `paused-interrupted`, `awaiting-credentials`, `succeeded`, `failed`, `cancelled`. A job that throws `TOKEN_EXPIRED` or `UNAUTHENTICATED` waits in `awaiting-credentials` (ADR-015); any other error fails it with the error code (never the message).

`command(id, 'pause' | 'resume' | 'cancel', principal)` is for the requester, the person the requester acted for, and `mayOverride`; anyone else gets `NOT_FOUND`. `resume` runs the job's `preflight` first and refuses with `GATE_BLOCKED` when it blocks or throws.

## Invariants

- **Stopping is orderly (DC-04, DC-46).** When a job is asked to stop (`cancel`, a pause, `shutdown`, `suspend`, `emergency`) its `onDrain` runs first, to park what it holds and checkpoint, with `budget - settleReserveMs` to do it; only then is the job released: `paused-interrupted` for a drain, `paused` for a pause, `cancelled` for a cancel. A job that ignores its signal, or whose `onDrain` never ends, is released at the budget with `:on-drain-timeout` or `:on-drain-error` on its reason, and the drain reports it.
- **A stop wins over a return.** A job that returns after being stopped is not recorded as `succeeded`: it was cut short, and a resume continues it from its checkpoint (I-13, no silent loss).
- **Lease and fencing.** Every write of a running job (heartbeat, checkpoint, finish) is fenced by owner and attempt in the store, so a runner that lost the job cannot change it, even under the same owner name. A heartbeat the store refuses aborts the job at once; one the store does not answer is retried until the lease would have ended (30 s after the last answer), then the job is given up. The runner writes nothing about a job it lost; the store reaps it as `paused-interrupted` (`lease-expired`).
- **Nothing resumes by itself unless told to.** An interrupted job is `paused-interrupted` and waits for a person (desktop), or, with `autoResume: 'resumable'`, is queued again by `recover` when it declared itself `resumable` and its `preflight` allows it (team). `maxAttempts` (5) stops a job that keeps killing the engine.
- **The store sees ciphertext.** Input (with the requester and the bound fields), checkpoint and result are sealed with the `PayloadCipher`, bound to the job id; `openJobInput` refuses a row whose plaintext columns disagree with the envelope. Stored reasons are fixed phrases and error codes.
- **I-2.** `register` accepts only what `defineJob` returned. `tools/arch-tests` lets only `runner.ts` and `types.ts` of this project name the write ports; every other file here is checked like a service.
- **I-6.** Waiters of the token bucket, running jobs (`maxConcurrent`), sealed sizes and every store window are bounded.

Open questions: OQ-310 to OQ-319 in [docs/open-questions.md](../../../docs/open-questions.md).

## Proof commands

```sh
pnpm nx test jobs
pnpm nx run jobs:it --dialects=sqlite,pg
pnpm nx test kernel --testNamePattern=drain
pnpm nx run-many -t lint typecheck test -p jobs
```
