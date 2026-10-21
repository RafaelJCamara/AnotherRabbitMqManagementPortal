# web

The Angular web app (`type:app`, `runtime:browser`): standalone components, zoneless, OnPush, signals. It talks to the engine only through `EngineApi` and the live channel of `@app/ui-data`, never with `fetch` or sockets of its own (I-1).

Status: the shell of M0-51 (IDE layout, status bar, layout persistence, Transloco) is landing in slices. This README grows with them. Today the app boots through `bootApp`, has Transloco with three scopes, the `c/:cid` route table with a shell host (activity bar with the Explorer entry, workspace outlet, status bar slot), the design system providers (`@app/ui-design`) and the dev-only gallery. The layout document, tabs, tree, real status data and skew handling are later slices.

## Public API

None. The app is an entry point, not a library. Inside it:

- `boot/boot.ts`: `bootApp(env?, hooks?)` sets up the platform (`bootstrapPlatform`), then starts `App` with `appConfig(setup)`. If the platform cannot be set up it starts `BootFailed` instead (no router, no HTTP, no engine call; the cause class and a reload button, never the error text). `hooks` exist for specs.
- `i18n/`: `provideI18n()` (Transloco, English, the `system` scope), `provideScopes(...)` (a route lists every scope its views use: scopes in a child injector replace those of the parent), `SCOPE_LOADERS` (the lazy `import()` of `i18n/en/{shell,status,system}.json`), `bindDocumentTitle()`.
- `shell/shell.routes.ts`: `c/:cid` (lazy host, `explorer` child, unknown children show the not-found view) and the no-connection fallback. `ActiveConnection` holds the validated connection id.

## Invariants

- The dev gallery is not in a production build (`__DEV_GALLERY__` is false there).
- The initial bundle is at most 350 kB gzip (`INITIAL_LIMIT` in `tools/web-budgets`); a lazy chunk is at most 200 kB gzip.
- A start-up failure of the platform never reaches the engine and never shows the error text (AC-1).
- Every visible string is a Transloco key or engine data; no key of `i18n/en/*.json` is unused (AC-2). The files are bundled chunks, not fetched: the HTTP loader is not used (OQ-526).
- A connection id that is not a plain route token leaves the connection unset (AC-4, OQ-689).

## Proof commands

| Command                                          | What it proves                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------ |
| `pnpm nx run-many -t lint typecheck test -p web` | Specs (AC-1, AC-2, AC-4), types and lint (raw template text, honest wording).  |
| `pnpm nx run web:budgets`                        | Production build, then the gzip budgets (`tools/web-budgets`).                 |
| `pnpm nx run web-gallery-check:gallery-absent`   | The gallery is absent from production.                                         |
