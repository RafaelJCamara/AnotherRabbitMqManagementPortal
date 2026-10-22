# svc-metrics

Prometheus-first, demand-driven metrics per broker with management sampling as the fallback: the ScrapePlanner, the bounded hot store, the collector, the forecast and the metrics.query, metrics.forecast and metrics.live surfaces (MON-01, MON-05).

Tags: `type:service`, `runtime:node`.

## Public API

- `createMetricsModule(deps)`: returns the `EngineModule` the composition root registers.
- `MetricsModuleDeps` (`src/deps.ts`): the ports the module needs.
- `createMetricsFakeDeps()` (`src/testing.ts`): fakes for those ports, for specs, the architecture manifest and the HTTP specs.

## Invariants

- Never imports another service or an adapter; cross-service needs are ports wired in the composition root (blueprint 2.2).
- Every mutation is an `implementAction` file in `src/actions/`; nothing writes through a WritePort outside one (mutation funnel).
- Engine buffers are `BoundedRing` or `BoundedQueue` (`@app/bounded-buffers-only`).

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p svc-metrics
```
