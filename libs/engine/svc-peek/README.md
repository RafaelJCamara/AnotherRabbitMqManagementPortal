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
- `createPeekModule(deps)`: returns the `EngineModule` the composition root registers.
- `createPeekFakeDeps()` (`src/testing.ts`): fakes for the module's ports, for specs and the architecture manifest.

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

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p svc-peek
pnpm nx test svc-peek --testNamePattern=executor
```

The lab run against the five broker versions (`svc-peek:it`) is planned for slice C of M1-14 and needs a Docker daemon.
