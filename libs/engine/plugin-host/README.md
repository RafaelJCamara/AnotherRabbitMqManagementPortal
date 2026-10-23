# plugin-host

The tier-1 worker pool (blueprint 11): bounded queue, bounded concurrency, a timeout and a memory limit per call, abort, and counted rejections. It hosts first-party code only.

Tags: `type:kernel`, `runtime:node`.

## Public API

- Nothing yet. List every export of `src/index.ts` here.

## Invariants

- Dependencies follow the type:kernel row of blueprint 2.2; `pnpm nx lint plugin-host` enforces them.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p plugin-host
```
