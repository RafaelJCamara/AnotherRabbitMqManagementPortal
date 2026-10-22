# forecast

Pure metric math for the metrics engine (MON-05, blueprint section 8): counter rates, a time-weighted EWMA, an adaptive-window regression with an R2 gate, the drain ETA with a 95 % band and the time to a limit. No I/O, no clock, no randomness: the caller passes the points.

Tags: `type:pure`, `runtime:isomorphic`.

## Public API

- `Point { t, v }` (epoch ms, value) and `cleanSeries(points)`: finite, time-ordered, one point per timestamp; a copy.
- `counterRate(points, { maxGapMs? })`: per-second rates between samples of a counter, stamped at the later sample. A reset (the counter fell) and a gap are skipped, never a negative rate.
- `ewma(points, halfLifeMs)`: average that weighs by elapsed time. `drainEtaFromRates(backlog, inflow, outflow)`: backlog over net outflow.
- `linearFit(points)` and `tQuantile95(df)`: the least-squares fit (slope, fitted current value, R2, slope error) and the t quantile behind the band.
- `drainEta(points, options?)` and `timeToLimit(points, limit, 'falling' | 'rising', options?)` return a `LimitForecast`:
  - `ok`: `etaMs`, `band { lowMs, highMs | null }` (`null`: the slope could be flat within the band), `ratePerSec`, `r2`, `windowMs`, `points`;
  - `reached`: the latest value is already at the limit (for the drain ETA: an empty queue);
  - `moving-away`: flat, the wrong way, or further than the horizon (30 days);
  - `no-reliable-forecast`: no recent window reaches R2 0.95, with the best `r2`; never an ETA;
  - `insufficient-data`: fewer than 8 points or less than a minute, with what is needed.
- `DEFAULT_FORECAST_OPTIONS`: `minPoints` 8, `minSpanMs` 60 s, `minR2` 0.95, `horizonMs` 30 d, `shrink` 0.75.

## Invariants

- Dependencies follow the type:pure row of blueprint 2.2; `pnpm nx lint forecast` enforces them.
- The window is the longest recent suffix a straight line fits at the R2 gate; an untrusted fit is reported as such and carries no ETA (I-13).
- Outputs are finite: a non-finite input point is dropped, and an `ok` band is ordered `lowMs <= etaMs <= highMs` (property-tested).

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p forecast
```
