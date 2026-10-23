# deaths

The death-history normaliser (DLQ-02): x-death, x-opt-deaths and x-first/last-death-* as one bounded, provenance-tagged timeline.

Tags: `type:pure`, `runtime:isomorphic`.

## Public API

- Nothing yet. List every export of `src/index.ts` here.

## Invariants

- Dependencies follow the type:pure row of blueprint 2.2; `pnpm nx lint deaths` enforces them.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p deaths
```
