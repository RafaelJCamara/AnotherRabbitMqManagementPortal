# ADR-021: Angular 22 UI stack and rules

- **Status:** Accepted
- **Date:** 2026-10-16
- **Source:** design panel (final blueprint); see [docs/architecture/blueprint.md](../architecture/blueprint.md)

## Decision

The UI is zoneless and OnPush, with signals and SignalStore 22.0.1. Components come from Spartan brain 1.7.0 helm copies, Aria, CDK and Tailwind 4. Other pieces:
- grids: AG Grid Community 36.2 behind an adapter, using the engine-windowed infinite model;
- graphs: Cytoscape with an unmodified ELK worker asset;
- editor: our own Monaco ESM wrapper;
- charts: uPlot and ECharts;
- commands: a tinykeys registry that also drives native menus.
The UI never computes authorisation, innerHTML is banned, rings live outside the signal graph, and a dev gallery replaces Storybook. The engine retains N-1 hashed chunks, and the UI does a controlled reload on ChunkLoadError.

## Rationale

Required by DC-50 to DC-52. The engine-computed gates keep UI logic out of the trust boundary, and skew handling prevents ChunkLoadError loops.

## Alternatives considered

PrimeNG (proprietary since 22); Angular Material; ngx-monaco-editor-v2 (AMD); an engine-link worker from day one.

## Consequences

We own the grid context menu, clipboard and status bar, plus the helm copies.

## Addendum: CSP and Trusted Types for the heavy libraries (spike S-04, M0-20)

- **Date:** 2026-10-18
- **Evidence:** [docs/architecture/s-04-csp-trusted-types.md](../architecture/s-04-csp-trusted-types.md); `pnpm nx e2e spikes-csp`.

Decision: Trusted Types are **enforced** (`require-trusted-types-for 'script'` plus a `trusted-types` allow-list), not report-only. AG Grid Community 36.2, Monaco 0.57 (ESM workers) and the unmodified `elk-worker.min.js` run with zero violations in Chrome and Edge 155 over `http://127.0.0.1` and `http://localhost`. The `app://` run is M2-P15.

The policy that supersedes blueprint 7.1 (nonce `N` per response, sent as a header on every response):

```
default-src 'none'; script-src 'self'; style-src 'self' 'nonce-N'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; worker-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; require-trusted-types-for 'script'; trusted-types app-worker-url app-monaco-html dompurify
```

Web modes add `frame-ancestors 'none'`; the product shell adds `angular` to `trusted-types`. Differences from 7.1: `style-src-attr 'unsafe-inline'` (Monaco's inline style attributes), `base-uri 'self'` (Angular's `<base href>`), no `blob:` in `worker-src`, and the `trusted-types` allow-list.

Rules this adds for `ui-grid` and `ui-editor`:
- AG Grid gets `styleNonce`; its string expressions (`valueGetter: '...'`) are never used (they call `new Function`).
- Monaco gets a `<style>` nonce hook, `MonacoEnvironment.getWorker` through the `app-worker-url` policy, and `MonacoEnvironment.createTrustedTypesPolicy` routed to `app-monaco-html`; all three load before the Monaco modules (Angular `polyfills`).
- ELK is constructed with a `workerFactory` that uses `app-worker-url`.
- `unsafe-eval` and `unsafe-inline` for scripts are never added.

Status: proposed until a maintainer accepts it and folds the CSP string into `docs/plan/amendments.md` and blueprint 7.1 (OQ-231).

## Addendum: boot, i18n loader and bundle budget method (web shell, M0-51)

- **Date:** 2026-10-21
- **Evidence:** [docs/specs/M0-51.md](../specs/M0-51.md); `pnpm nx test web`; `pnpm nx run web:budgets`.

Decisions (OQ-526, OQ-534, OQ-537, OQ-539; proposed until a maintainer accepts them):

- **Boot.** `bootApp()` runs `bootstrapPlatform()` first. If it throws, the app starts a minimal "cannot start" view (no router, no HTTP, no engine call) that names the class of the failure by `BootstrapError` code and offers a reload; the error text is never shown, because it can carry a URL. Only when the platform is set up does the app start with `providePlatform`, `provideEngineData` and the router.
- **Translations.** Transloco with English files bundled as JSON and loaded by `import()` as lazy chunks, through inline scope loaders. The default HTTP loader is not used: it would pass through the engine transport, `fetch` is banned outside `libs/ui/platform`, and the CSP allows scripts from `'self'` only. Three scopes: `shell`, `status`, `system`. A route lists every scope its views use, because scopes provided in a child injector replace those of the parent.
- **Budgets.** `web:budgets` gzips (level 6) every script, modulepreload and stylesheet that `index.html` loads from its own origin; 1 kB is 1,000 bytes; the initial total must be at most 350,000 bytes and a lazy chunk at most 200,000. An output that cannot be read or references nothing fails. The Angular raw-size budgets in `project.json` stay as a coarse backstop.
- **Layout document (OQ-535, OQ-529).** The shell owns the document it stores through `layouts.put` (the engine keeps it as a bounded JSON object and never reads it). A strict zod schema with `version: 1`, at most 3 editor groups, 30 tabs per group, 60 tabs, 512-character addresses and 120-character labels, pixel sizes clamped to the window by `fitLayout`. A tab address must stay under `/c/<cid>/` after the URL parser has normalised it; anything else is dropped on load. A stored document that cannot be used (absent, invalid, newer version, over a cap, a failed load) shows the default layout and a notice, and is not overwritten until the person changes the layout. A change applies at once and is saved after 1,500 ms without another change, plus a best-effort flush when the page becomes hidden; a failed save keeps the layout in memory and shows the engine's Problem as sent.

## Addendum: the grid adapter (M0-53 slices A to E, spike S-14, partial)

- **Date:** 2026-10-21
- **Evidence:** [docs/architecture/s-14-ag-grid-infinite-100k.md](../architecture/s-14-ag-grid-infinite-100k.md); [docs/specs/M0-53.md](../specs/M0-53.md); `pnpm nx run-many -t lint typecheck test -p ui-grid`; `pnpm nx run ui-grid:bundle-check`.

Decisions (OQ-541, OQ-551, OQ-552, OQ-700 to OQ-706; proposed until a maintainer accepts them):

- **One package, our component.** `ag-grid-community` only; `<app-data-grid>` calls `createGrid` itself, with an explicit list of nine Community modules instead of `AllCommunityModule`. No `ag-grid-angular`, no Enterprise module (checked by `ui-grid:bundle-check` on the metafile).
- **Windows.** Block size 200, at most 25 blocks resident, two requests in flight, live changes applied once per 100 ms to the rows on screen, a reload at most once every 5 s. A new source aborts the requests in flight.
- **What the adapter owns.** The context menu, the clipboard, the column chooser and the status bar (the commercial tier's), the selection set (row ids, capped at 5,000), the column state (plain JSON) and the theme bridge from the design tokens. Cells are text; there is no cell renderer, no `innerHTML`, no string expression, no font or other fetch.
- **Measured so far.** The adapter without Angular is 214,025 bytes gzip, over the 200,000-byte lazy-chunk budget (OQ-701). The browser numbers (frame rate, heap, the run under the enforced S-04 policy) are not measured: the `perf` project does not exist yet.

Status: proposed. S-14 stays open until `perf:grid-100k` runs; a version bump of `ag-grid-community` re-runs it and `spikes-csp`.

## Addendum: the explorer's bundle numbers and the grid chunk limit (M0-54 slice I)

- **Date:** 2026-10-21
- **Evidence:** [docs/specs/M0-54.md](../specs/M0-54.md); `pnpm nx run web:budgets`; `pnpm nx test web-budgets`. Measured on a production build of the worktree on Windows (gzip level 6, 1 kB is 1,000 bytes).

Decisions (OQ-757; proposed until a maintainer accepts them):

- **Measured.** With the explorer mounted at `c/:cid/explorer`, the initial bundle is 216,373 bytes gzip (it was 208,154 before: the app imports the explorer's route table and its connection token statically, the pages stay lazy) against the 350,000 limit. The explorer's pages (the overview, the capability card, the four grids, the filter bar and the saved views) and AG Grid Community are one lazy chunk of 219,724 bytes gzip (780,820 raw). The adapter alone was 214,025 bytes gzip without Angular (the M0-53 addendum), so no feature that shows a grid can sit under the 200,000-byte lazy limit.
- **The narrowest exception.** `tools/web-budgets` gives one chunk a higher limit: the chunk that contains AG Grid's own class name (`ag-root-wrapper`) may be at most 240,000 bytes gzip (the measured size and room for the next grid features). Every other lazy chunk keeps the 200,000 limit, and the exception is a ceiling too (a test checks that a marked chunk above it fails). It is not a relaxation of the budget: the alternatives are a shared lazy grid chunk (already the case: all four kinds share it) or another grid, which stay open until the maintainer picks (OQ-757).
- **The app never imports the explorer statically except its route table.** `apps/web` mounts `explorerRoutesFor(() => inject(ActiveConnection).cid)` from a `loadChildren`; the library is lazy and the module-boundary rule forbids any other static import of it.

Status: proposed. A change of `ag-grid-community` or of the explorer's grid features re-measures the chunk; at 240,000 the exception stops being enough and needs its own decision.