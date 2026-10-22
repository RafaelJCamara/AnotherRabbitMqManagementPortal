# perf-grid-page

The harness page of `perf:grid-100k` (M0-53 AC-1, AC-4, AC-16): a bare Angular app that mounts the real `<app-data-grid>` of `ui-grid` on a fake engine window of 100,000 rows (`createFakeWindowSource` of `@app/ui-grid/testing`, 15 ms an answer), plus the hooks the Node driver reads through the DevTools protocol (`window.__grid`). It is built, served and driven by `apps/perf` (`src/grid-100k/`); it is never shipped.

Tags: `type:test`, `runtime:browser`. It is a project of its own, and not a folder of `perf`, because `perf` is `runtime:node` and may not import the browser-only `ui-grid` and `ui-design` (`eslint.config.mjs`); the two sides therefore do not import each other, and the driver checks at run time that the page serves the rows it expects.

## Public API

- None. `src/main.ts` bootstraps `HarnessApp` (`src/harness-app.ts`). The page offers `window.__grid` (`state()`: the grid's block, row and request counts; `policy()`: the nonce, the `<style>` elements and the theme; `startSampling()`; `setTheme()`; `setDensity()`), shaped by `src/contract.ts`.
- Self-check knobs in the query string (`?jank=60`, `?leak`, `?violate`) make the page worse on purpose, so that each gate of the run can be shown to fail (see `apps/perf/README.md`). A normal run sets none.

## Invariants

- The page contains no cell renderer, no `innerHTML` and no string expression of its own; the grid is the real one and its rows are text.
- The harness server (`apps/perf/src/grid-100k/server.ts`) puts the nonce on the page: `index.html` carries the engine's placeholder (`__CSP_NONCE__`) on the `csp-nonce` meta tag and on the root element, as the engine's static route does.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck -p perf-grid-page
pnpm nx build perf-grid-page          # dist/apps/perf-grid-page/browser
pnpm nx run perf:grid-100k            # builds this page, then drives it in Chrome or Edge
```
