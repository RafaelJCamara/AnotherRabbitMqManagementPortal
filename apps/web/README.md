# web

The Angular web app (`type:app`, `runtime:browser`): standalone components, zoneless, OnPush, signals. It talks to the engine only through `EngineApi` and the live channel of `@app/ui-data`, never with `fetch` or sockets of its own (I-1).

Status: the shell of M0-51 (IDE layout, status bar, layout persistence, Transloco) is landing in slices. This README grows with them. Today the app holds the root view, the design system providers (`@app/ui-design`) and the dev-only gallery.

## Public API

None. The app is an entry point, not a library.

## Invariants

- The dev gallery is not in a production build (`__DEV_GALLERY__` is false there).
- The initial bundle is at most 350 kB gzip (`INITIAL_LIMIT` in `tools/web-budgets`); a lazy chunk is at most 200 kB gzip.

## Proof commands

| Command                                         | What it proves                                                  |
| ----------------------------------------------- | --------------------------------------------------------------- |
| `pnpm nx run-many -t lint typecheck test -p web` | Specs, types and lint of the app.                               |
| `pnpm nx run web:budgets`                       | Production build, then the gzip budgets (`tools/web-budgets`). |
| `pnpm nx run web-gallery-check:gallery-absent`  | The gallery is absent from production.                          |
