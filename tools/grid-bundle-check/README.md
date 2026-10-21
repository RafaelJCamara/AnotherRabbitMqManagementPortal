# grid-bundle-check

Proves what the public entry of `ui-grid` (M0-53) ships: AG Grid Community only, and only the modules the adapter names (AC-3, DC-50, DC-52, OQ-551).

Tags: `type:tooling`, `runtime:node`. Plain Node; it uses the `esbuild` that `@angular/build` ships, as `spikes/csp` does. It lives under `tools/` instead of `libs/ui/grid/bundle-check/` (the M0-53 spec's place) because `libs/ui/grid` is browser code and the lint rules forbid Node built-ins there.

## What it checks

`bundle-check.mjs` bundles `libs/ui/grid/src/index.ts` with its dependencies, writes the esbuild metafile to `dist/ui-grid-bundle-check/meta.json`, and fails when

- an input comes from `ag-grid-enterprise`, an `@ag-grid-enterprise/*` package, `ag-charts-enterprise` or another AG Grid package that is not `ag-grid-community`;
- the scan does not see `ag-grid-community` (a control: an empty scan proves nothing);
- `GRID_MODULE_NAMES` (what the adapter registers) is empty, holds `AllCommunityModule`, or names a module `ag-grid-community` does not export;
- the shipped-artefact gates of `tools/supply-chain` (`run-gates.ts --metafile=...`: licence, allow-list, pins) fail on that metafile.

It also prints the size of the adapter with AG Grid but without Angular, RxJS and tslib, to hold against the 200 kB gzip budget of a feature chunk.

## Proof commands

| Command                                  | What it proves                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------- |
| `pnpm nx run ui-grid:bundle-check`       | The build, the checks above and the supply-chain gates on the ui-grid metafile.   |
| `pnpm nx test grid-bundle-check`         | AC-3 on the real bundle, and the scan itself on planted Enterprise input paths.   |
