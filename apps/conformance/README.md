# conformance

The conformance suite: one cell per conformance id, run against recorded lab evidence and a live broker.

Tags: `type:test`, `runtime:node`.

## Public API

- Nothing: the cells are specs in `src/cells/`.

## Invariants

- Every cell asserts that the live run matches the recorded evidence and that the registry cell matches it (blueprint 5.2).
- Evidence in `testing/lab-evidence/` is recorded by a separate job and committed by a human; a cell never writes it.
- This project may import amqplib (third-party confinement, blueprint 2.4).

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p conformance
```
