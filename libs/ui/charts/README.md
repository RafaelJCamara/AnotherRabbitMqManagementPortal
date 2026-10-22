# ui-charts

Local SVG charts for the web UI (M1-54, MON-02): the components (line and area chart, sparkline, data table) over the pure draw maths of `@app/chart-math`. No charting dependency is used: the issue names uPlot, a new package is a protected-path change, and the maths here are small enough to prove with property tests (OQ-920). The confinement table of `eslint.config.mjs` still reserves this library for `uplot`, `echarts` and `ngx-echarts`, so a library can replace the renderer later without touching the pages.

Tags: `type:ui-lib`, `runtime:browser`. It is presentational: it knows nothing of the engine, the live protocol or Transloco. The host passes text, units and formatters in.

## Public API

The pure draw maths (nice ticks, time ticks, y scales, M4 downsampling, gap-breaking paths, picking, the forecast overlay, value formatting) are `@app/chart-math` (`libs/shared/chart-math`), so Node tools can use them; the components import them.

Components (standalone, OnPush, signals; the host passes every text in ChartLabels and formats nothing for them):

- `<app-line-chart>` (`LineChart`): inputs `title`, `series` (`ChartSeries[]`), `domain` (the visible time range), `labels`, `yScale` (`zero | fit | log`), `kind` (`line | area`), `forecast` and `forecastSeries` (the overlay), `summary` (the throttled live-region text), `width`, `height`, `locale`. A legend of `aria-pressed` toggles (each series has its own colour token, dash and marker), a series that is not reported listed with its reason and drawn as nothing, a time cursor that is a horizontal `slider` (Left, Right, PageUp, PageDown, Home, End, Escape; its value text is the readout), a pointer readout that is not announced, and the data table alternative.
- `<app-sparkline>` (`Sparkline`): `points`, `name` (the accessible name, with its value), `seriesStyle`, `width`, `height`; nothing to operate.
- `<app-chart-table>` (`ChartTable`): a `<details>` with a real table, newest first, at most 100 rows, a missing value said and never zero; the rows are built only while it is open.
- `DASHES`, `MARKERS`, `styleOf`, `markerPath`: the six series styles; the colours are the `--ds-color-chart-1` to `-6` tokens of `ui-design`.

## Invariants

- No new dependency; no `innerHTML`; no animation or transition outside `prefers-reduced-motion: no-preference` (checked by `tools/web-gallery-check`).
- A value that is not finite never reaches a path; a series is never bridged over a gap; a missing value is never drawn as zero (R1 of `docs/specs/M1-54.md`).
- Dependencies follow the `type:ui-lib` row of blueprint 2.2; `pnpm nx lint ui-charts` enforces them.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p ui-charts
pnpm nx test ui-charts --testNamePattern='AC-(12|13|14|15|16)'
pnpm nx run-many -t test -p web-gallery-check # the source scan of this library (charts-source.test.mjs)
```
