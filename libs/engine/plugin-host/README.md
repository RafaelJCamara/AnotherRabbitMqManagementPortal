# plugin-host

The tier-1 worker pool (blueprint 11, M1-10): first-party code runs in `node:worker_threads` workers, off the main loop, with a bounded queue, a time budget and a memory limit per call, abort, and a counter for every job that did not complete. It is generic: it knows a worker module URL and a three-message convention, not what the worker does. The payload codecs are the first user ([`@app/decoders`](../decoders/README.md)); the QuickJS sandbox of tier 3 will live here too (the `quickjs-emscripten` confinement row already names this project).

Tags: `type:kernel`, `runtime:node`. A service can use it without importing an adapter; the composition root joins it with the worker's owner.

## Public API

| Export                        | Notes                                                                                                                                                                                                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createWorkerPool(options)`   | `run(input, {signal?, timeoutMs?})` **never rejects** and returns `{ok: true, value}` or `{ok: false, reason}`; `stats()`; `close()`. Options: `workerUrl` (required), `size` (1 to 8, default 2), `maxQueue` (default 64), `maxQueuedBytes`, `timeoutMs` (250), `startTimeoutMs` (5 s), `resourceLimits` (64 MB old generation, 16 MB young), `sizeOfInput`, `maxInputBytes` (16 MiB), `sizeOfOutput`, `maxOutputBytes` (4 MiB), `workerData`, `execArgv`, `onEvent`. |
| `RejectReason`, `REJECT_REASONS` | `timeout`, `out-of-memory`, `aborted`, `queue-full`, `input-too-large`, `output-too-large`, `worker-error`, `closed`.                                                                                                                                        |
| `PoolStats`, `PoolEvent`, `PoolOutcome`, `RunOptions`, `WorkerPool`, `WorkerPoolOptions` | Types. `PoolEvent`s carry reasons and sizes only.                                                                                                                                                         |

## The worker convention

A worker module posts `{type: 'ready'}` once loaded; for `{type: 'job', id, input}` it answers `{type: 'result', id, value}` or `{type: 'failure', id}`. It imports only what Node can resolve itself (no `@app/*` aliases). `@app/decoders` ships one (`worker-entry.ts`, with `codecPoolOptions()`); the composition root passes it in. Bundling it is a second esbuild entry of `apps/engine` (OQ-1202).

## Invariants

- **Off the main loop (I-5).** Nothing of a job runs on the engine's thread; a spec holds a worker in a busy loop until the main loop has made 50 turns, and another decodes 16 MiB while counting turns.
- **Bounded (I-6).** At most `size` workers, at most `maxQueue` jobs and `maxQueuedBytes` bytes waiting, an input and an output size limit, a time budget from the moment a worker holds the job, a memory limit per worker. A full queue rejects at once with `queue-full`.
- **Counted, not silent (I-13).** Every rejection, termination and failed start is in `stats()` by reason, and `queueHighWater` proves the queue bound.
- **The engine stays healthy.** A worker that times out, runs out of memory, exits, throws, lies about an id or fails to start is terminated and replaced by the next job; nothing else is affected. A start that fails is not retried in a loop.
- **No payload bytes (I-10).** Events and stats carry counts and codes; the worker gets an empty environment and no inherited node options. A sink that throws does not stop the pool.
- Worker threads are not a security boundary (blueprint 11): this pool hosts first-party code only.

Open questions: OQ-1200 (no `piscina`), OQ-1202, OQ-1203 in [docs/open-questions.md](../../../docs/open-questions.md).

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p plugin-host testkit
```
