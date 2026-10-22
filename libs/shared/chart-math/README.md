# chart-math

The pure draw maths of the live charts (M1-54): no Angular, no DOM, no clock. `ui-charts` draws with it, and a Node tool (`perf:charts-50`) can measure it. Every function is proved with fast-check.

Tags: `type:pure`, `runtime:isomorphic`.

## Public API

- `niceTicks(min, max, count)`, `niceStep(raw)`: ticks of 1, 2 or 5 times a power of ten that cover the data; a flat range is padded.
- `timeTicks(from, to, count)`, `timeStep`, `TIME_STEPS_MS`: epoch-aligned ticks on a round step from 1 s to 30 days.
- `yAxis(kind, dataMin, dataMax, height)` with `YScaleKind` `zero | fit | log` (`log` is a signed `log10(1 + |v|)`, so zero is drawn), `linearScale`, `symlog`.
- `downsample(points, from, to, columns)`: first, last, lowest and highest point per pixel column (M4), at most four per column, a spike is never lost.
- `pathOf`, `areaOf`, `segments`, `gapThreshold`: SVG path strings, broken where a series has a gap (three times the median interval), one decimal, no non-finite number.
- `nearestIndex`, `atOrBefore`, `stepCursor`: pointer and keyboard picking.
- `forecastOverlay`, `withOverlayRoom`, `OVERLAY_ROOM`: the drain line and the 95 % band, clipped to the chart, from the numbers the engine sent; an unusable forecast gives no overlay.
- `formatValue`, `formatClock`: compact counts, bytes in KiB, rates with `/s`, never `NaN`.

## Invariants

- A value that is not finite never reaches a path; a series is never bridged over a gap; a missing value is never drawn as zero (R1 of `docs/specs/M1-54.md`).
- Dependencies follow the `type:pure` row of blueprint 2.2; `pnpm nx lint chart-math` enforces them.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p chart-math
pnpm nx test chart-math --testNamePattern='AC-(1|2|3|4|5|6)'
```
