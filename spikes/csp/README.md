# spikes/csp

Spike S-04 (M0-20): can the blueprint CSP with `require-trusted-types-for 'script'` run AG Grid Community, Monaco and the ELK worker? The result and the recommended policy are in [docs/architecture/s-04-csp-trusted-types.md](../../docs/architecture/s-04-csp-trusted-types.md).

This is throwaway tooling. Nothing in it ships, and nothing may import it.

## Purpose

A small page loads AG Grid Community 36.2.0 (infinite row model), Monaco 0.57.0 (ESM workers, JSON language) and the unmodified `elk-worker.min.js` of elkjs 0.12.0. A zero-dependency driver serves it under a matrix of CSP strings, opens it in a real headless Chrome or Edge over the DevTools protocol, and reports every CSP and Trusted Types violation. Each scenario states what it expects, so the matrix is a regression test of the findings.

## Run

```
pnpm nx e2e spikes-csp
```

This installs the three libraries into `tmp/csp-spike/deps` (outside the workspace, `npm --ignore-scripts --before=<3 days ago>`), builds the page into `dist/spikes-csp` with the esbuild that `@angular/build` ships, builds `apps/web` (for the Angular shell scenarios) and runs every scenario (about 90 s). It needs Chrome, Edge or Chromium; set `CSP_SPIKE_BROWSER` to a binary to choose one.

Useful options of `node spikes/csp/scripts/run.mjs`: `--list`, `--only=recommended,blueprint-verbatim`, `--verbose` (console messages and violation sources). Set `CSP_SPIKE_MINIFY=0` when running `build.mjs` to read stack frames. Results are also written to `tmp/csp-spike/results.json`.

## Invariants

- No product dependency is added. The libraries live in `tmp/`, not in the catalog or `package.json` (OQ-230).
- `spikes/csp` is the only place besides `libs/ui/{grid,graph,editor}` allowed to import the three libraries (`eslint.config.mjs`, confinement).
- `elk-worker.min.js` is copied byte for byte and its SHA-256 is checked (DC-51).

## Proof

`pnpm nx e2e spikes-csp` (needs a browser and network on the first run) and `pnpm nx lint spikes-csp`.
