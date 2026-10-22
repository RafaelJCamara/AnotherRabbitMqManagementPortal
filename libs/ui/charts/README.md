# ui-charts

Local SVG charts for the web UI (M1-54, MON-02): the pure draw maths and, in later slices of the work package, the components that use them (line and area chart, sparkline, data table). No charting dependency is used: the issue names uPlot, a new package is a protected-path change, and the maths here are small enough to prove with property tests (OQ-920). The confinement table of `eslint.config.mjs` still reserves this library for `uplot`, `echarts` and `ngx-echarts`, so a library can replace the renderer later without touching the pages.

Tags: `type:ui-lib`, `runtime:browser`. It is presentational: it knows nothing of the engine, the live protocol or Transloco. The host passes text, units and formatters in.

## Public API

Pure functions (`src/lib/draw/`), all tested with fast-check:

- `niceTicks(min, max, count)`, `niceStep(raw)`: ticks of 1, 2 or 5 times a power of ten that cover the data; a flat range is padded.
- `timeTicks(from, to, count)`, `timeStep`, `TIME_STEPS_MS`: epoch-aligned ticks on a round step from 1 s to 30 days.
- `yAxis(kind, dataMin, dataMax, height)` with `YScaleKind` `zero | fit | log` (`log` is a signed `log10(1 + |v|)`, so zero is drawn), `linearScale`, `symlog`.
- `downsample(points, from, to, columns)`: first, last, lowest and highest point per pixel column (M4), at most four per column, a spike is never lost.
- `pathOf`, `areaOf`, `segments`, `gapThreshold`: SVG path strings, broken where a series has a gap (three times the median interval), one decimal, no non-finite number.
- `nearestIndex`, `atOrBefore`, `stepCursor`: pointer and keyboard picking.
- `forecastOverlay`, `withOverlayRoom`, `OVERLAY_ROOM`: the drain line and the 95 % band on the zero line, clipped to the chart, from the numbers the engine sent; an unusable forecast gives no overlay.
- `formatValue`, `formatClock`: compact counts, bytes in KiB, rates with `/s`, never `NaN`.

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
pnpm nx test ui-charts --testNamePattern='AC-(1|2|3|4|5|6|12|13|14|15|16)'
pnpm nx run-many -t test -p web-gallery-check # the source scan of this library (charts-source.test.mjs)
```
