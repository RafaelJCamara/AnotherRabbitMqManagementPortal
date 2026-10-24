# svc-topology

Reads one vhost of a connected broker and answers the topology, routing-simulation, dead-letter and effective-config queries (reads only).

Tags: `type:service`, `runtime:node`.

## Public API

- `createTopologyModule(deps)`: returns the `EngineModule` the composition root registers.
- `TopologyModuleDeps` (`src/deps.ts`): the ports the module needs.
- `createTopologyFakeDeps()` (`src/testing.ts`): fakes for those ports, for specs, the architecture manifest and the HTTP specs.

## Invariants

- Never imports another service or an adapter; cross-service needs are ports wired in the composition root (blueprint 2.2).
- Every mutation is an `implementAction` file in `src/actions/`; nothing writes through a WritePort outside one (mutation funnel).
- Engine buffers are `BoundedRing` or `BoundedQueue` (`@app/bounded-buffers-only`).

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p svc-topology
```
