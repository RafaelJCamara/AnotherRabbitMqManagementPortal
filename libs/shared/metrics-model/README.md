# metrics-model

The pure model behind the live charts (M1-54, MON-02 and MON-05 UI): the bounded series ring, the session that joins `metrics.query` history with `metrics.live` points, the explanations of an engine status, the forecast view and the chart definitions. No Angular, no rxjs, no DOM, no clock and no timer: it is driven by the events it is given, so every rule is a plain test.

Tags: `type:pure`, `runtime:isomorphic`. It imports `@app/contracts` (types, the metric ids and the forecast schema) and `@app/forecast` (`counterRate`). `feature-explorer` maps `EngineApi` and the live client to the `MetricsData` port.

## Public API

- `MetricsData` (`query`, `forecast`, `follow`): the port; `LiveFeedEvent` is what the live topic sends a follower.
- `SeriesRing`: one ring per series, at most 1,000 points and 16,000 bytes (two `float64` per point), times strictly ascending, every point it does not keep counted (`evicted`, `stale`; `pushed = length + evicted + stale`). I-6, I-13.
- `createMetricsSession(data, {cid, series, queues?})` returns `{state, onState, pause, resume, reload, destroy}`. It follows the live topic first, buffers the newest live item per series until the history is in, reads the history once (at most 50 series, 720 points, `rate: false`: counters stay raw), joins the two by time without a seam, then keeps following. A series the engine does not hold is `not-reported` with no points, never a zero; a `gap` or `reset` asks for the history again once (coalesced) and is counted; `pause` freezes the view while the rings keep receiving and counts what waits; the summary of the live region changes at most once per 15 s of data time unless a state that matters changes. States: `loading`, `ready`, `empty`, `error` (the Problem as received), and for the live part `connecting`, `following`, `ended`.
- `explainStatus(status)`: the engine's `status` as codes the page words (`no-source`, `loading`, `stale`, `unavailable`, `fallback-*`, `approximate`, `partial` with its reason, `dropped-*` with counts); anything this version does not know is `unknown-state`, never silence.
- `forecastView(forecast)`: the five forecast states as a view; an `ok` that cannot be trusted and anything the contract does not describe is `unavailable` (fail closed, never an invented ETA).
- `clusterCharts(nodes)`, `queueCharts(queue)`, `seriesOf`, `chartData`: which charts a page shows and which series each draws (counters as per-second rates, derived on the client); `RANGES`, `LATER_RANGES`, `rangeOf`, `domainOf`: the time ranges (the hot hour; longer ones are listed for later).
- `refKey(ref)`: the stable key of a series reference.
- `@app/metrics-model/testing`: `createFakeMetricsData` (history and forecast answers a spec sets, one controllable live topic, failures and held answers), `seriesResult`, `liveItem`, `statusItem`, `quietStatus`.

## Invariants

- Bounded (I-6): every ring, at most 50 series, at most 720 history points, one pending live item per series.
- No silent loss (I-13): evictions, ignored points, gaps and engine drops are counted and exposed.
- No invented data: a missing series has no points; a forecast that is not usable is `unavailable`.
- Dependencies follow the `type:pure` row of blueprint 2.2; `pnpm nx lint metrics-model` enforces them.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p metrics-model
pnpm nx test metrics-model --testNamePattern='AC-(7|8|9|10|11|17)'
```
