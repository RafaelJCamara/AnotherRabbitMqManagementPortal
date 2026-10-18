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
