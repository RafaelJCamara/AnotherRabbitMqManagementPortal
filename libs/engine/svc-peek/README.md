# svc-peek

Peek executor: a short, atomic, engine-side peek that never returns messages by closing (M1-14, blueprint 5.5, DC-03/04/05/11). One execution takes a bounded number of deliveries with sequential `basic.get`, then ends the hold with one `nack(lastUnackedTag, multiple, requeue)`, one `basic.qos` barrier, the journal settle, and the lazy lease release. The watchdog ends a hold at the hard abort. A hold that cannot end cleanly is an incident, and its lease is released `poisoned`.

Tags: `type:service`, `runtime:node`, `trust:critical`.

## Public API

- `createPeekExecutor(ports)` (`src/internal/executor.ts`): returns a `PeekExecutor`.
  - `execute(lease, plan, hooks, signal)`: runs one hold and resolves with `ExecutionResult`.
  - `flushAll('shutdown' | 'suspend')`: stops every running hold; resolves after each one has released its lease.
  - `reconcileInterrupted()`: marks the `acquiring` rows a crashed process left as `incident` (`interrupted`). It never touches the broker.
- `ExecutorPorts`: the journal (`HoldJournalRepository`, `@app/ports`), a clock, an id source, the queue sealer (ADR-014), and timers.
- `ExecutionHooks`: the guard (returns `doomed` or `not-doomed`) and the copy. M1-15 and M1-16 supply the real ones.
- `quarantineName(prefix)`, `buildQuarantineSpec(name, vhost, type)`, `conformsToSpec(found, spec)`, `ensureQuarantine(args, signal)` (`src/internal/quarantine.ts`, M1-13 slice A): the rescue preflight's quarantine queue. The name is `${prefix}.quarantine` with the prefix injected by the composition root (a bad prefix throws `RangeError` at start). The spec is literal (A-5): durable, not auto-delete, `x-overflow: reject-publish`, no max-length, never `drop-head`; classic by default, quorum with `x-delivery-limit: -1` as the fallback where classic is disabled. `ensureQuarantine` reuses a conforming queue, never touches a queue of another shape, and otherwise sends one `PUT /api/queues/{vhost}/{name}` through the `send` its caller passes. The peek action (M1-16) calls it from `execute()` with `ctx.writes.mgmt.send`.
- `PeekEvidencePort` (`@app/ports`, `peek-evidence.ts`): the DLX sources and the effective configuration of the peeked queue, as `routing.dlx-sources` and `queues.effective-config` answer them. The composition root implements it over the query actions; this project sees only the port (a service never imports a service, OQ-1468).
- `createPeekPreflight({mgmt, evidence, clock, limits?})` (`src/internal/preflight.ts`, M1-13 slice B, DC-06): `run({connectionId, vhost, queue, principal}, signal)` fills the planner's `PeekPreflight` with HTTP GET requests only: the queue row (one read, timed for `rttMs`, floor 1 ms), the consumer list for a single-active-consumer queue only, and the dead-letter evidence and effective configuration through the `PeekEvidencePort`. Its deps hold the read port and the evidence port and nothing that can write (I-2); every read is on the `interactive` lane (I-8) and counted against `maxReads` (9). A field the broker did not send stays absent; an unreadable consumer list, a cut list or an unreadable evidence answer fails closed (a busy single-active-consumer queue, incomplete evidence). The outcome holds numbers, names and closed codes only (I-10). The management rows it parses are in `src/internal/preflight-rows.ts`.
- `createPeekModule(deps)`: returns the `EngineModule` the composition root registers.
- `createPeekFakeDeps()` (`src/testing.ts`): fakes for the module's ports (a scripted management API and a fake evidence port, `src/internal/preflight-fakes.ts`), for specs and the architecture manifest.

## States

`idle` → `acquiring` → `returning` → `settled`, or `incident` from any state that can reach it (`src/internal/state-machine.ts`). The rescue and guard states of M1-13 and M1-15 join this table then.

## Invariants

- The journal row is `acquiring` before the first `get` and leaves `acquiring` exactly once (`settled` or `incident`).
- `nack` names only a tag the execution took, so it never hits a 406 unknown-tag.
- On a quorum queue the barrier is not enough (OQ-215): the executor reads the ready count before the first `get` and, after the barrier, waits up to `QUORUM_RETURN_WAIT_MS` (10 s) for it to be back, reporting `returnConfirmedAfterMs`. If it is not, the hold is an `incident` (`return-unconfirmed`, `returned: 0`) and the lease stays healthy. Classic queues return at the barrier.
- A `get` that is still outstanding when the hold ends poisons the lease: its delivery cannot be held on a reused channel.
- Holds are bounded: the count, the bytes and the target time are checked before each `get`; the watchdog ends the hold at `hardAbortMs` (at most 30 s, the planner's cap); at most `maxActive` holds run at once (I-6).
- Without a guard nothing is acquired (fail closed). A doomed message stops the loop and is returned with the others; M1-14 applies no disposition.
- A copy failure stops the loop and returns the holds (no silent loss, I-13).
- `reconcileInterrupted` never calls the broker; each window is bounded (I-7).
- The executor is reached only through an `implementAction` module (I-2). Its wiring is M1-16.
- Never imports another service or an adapter (blueprint 2.2); the copy goes through a port.
- The quarantine code names no write port, lease or connection manager: it takes `send` as an argument, so the architecture test (I-2) needs no exemption for it (M1-13 AC-25).
- A quarantine queue of the right name but another shape (non-durable, another type, any extra argument) is reported `wrong-shape` and is never reused, changed or deleted (A-5). Its outcome holds closed codes only, never the broker's text (I-10).

- The peek preflight never throws a non-Problem: a missing, refused or malformed queue is a Problem (`NOT_FOUND`, `FORBIDDEN_BROKER`, `BROKER_ERROR`) without the broker's text; an evidence failure is `evidence-unavailable`, never a hazard-free answer; a list past its bound is cut and counted, and a cut consumer list counts as an active consumer (M1-13 AC-1 to AC-7).

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p svc-peek
pnpm nx test svc-peek --testNamePattern=executor
pnpm nx test svc-peek --testNamePattern=preflight   # the quarantine spec (slice A: AC-22 to AC-24) and the peek preflight (slice B: AC-1 to AC-7)
pnpm nx test arch-tests --testNamePattern=M1-13     # AC-25
```

The lab run against the five broker versions (`svc-peek:it`) is planned for slice C of M1-14 and needs a Docker daemon.
