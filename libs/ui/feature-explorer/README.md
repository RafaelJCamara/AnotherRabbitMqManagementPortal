# feature-explorer

The explorer of a connection: grids for queues, exchanges, connections and bindings with filters and saved views, and the cluster overview (M0-54, EXP-02 and EXP-03, UI side). It reads the inventory through `inventory.query`, follows the rows on screen through the `explorer.window` topic, and says in words whenever what it shows is loading, stale, partial or truncated. It reads no message and calls no action that changes the broker; its only commands keep a person's own saved views (`views.create`, `views.delete`).

Tags: `type:ui-feature`, `runtime:browser`. Not `trust:critical`.

## Status

Slice A of M0-54: the project, its `explorer` Transloco scope, the connection token and the lazy route table with a placeholder landing page. The data port, the grid page, the filters, the saved views, the overview and the capability card follow in slices B to H; the shell wiring is slice I. Nothing here has been proved against a real engine: `svc-explorer`, `svc-workspace` and `svc-capabilities` are not registered in the engine yet (OQ-441, OQ-472, OQ-669), so every proof runs against fakes.

## Public API

- `explorerRoutes`: the child routes the web shell mounts at `c/:cid/explorer` (a lazy `loadChildren`). The parent route provides the `explorer` Transloco scope (`provideExplorerScope`, a bundled-JSON `import()` loader; keys read `explorer.<path>`).
- `EXPLORER_CONNECTION`: an injection token for a `Signal<string | null>` with the connection id. The web shell provides it on the mounting route; a feature never imports `apps/web`. `null` means no content and no call.
- `EXPLORER_SCOPE`: the scope name.

## Invariants

- Depends on ui-data, ui-design, ui-lib (`ui-grid`), ui-platform, contracts, pure (`explorer-model`) and domain-model; never on another feature (blueprint 2.2). Only `ui-grid` imports AG Grid (I-11).
- All copy lives in `src/i18n/en.json` (the scope root); templates contain bindings only (`@app/ui-no-raw-template-text`, `@app/honest-wording`). No string says "read-only", "non-destructive", "without side effects" or "safe peek".
- Talks to the engine through EngineApi and the live client, never `fetch` or sockets (`@app/no-direct-fetch`).
- Renders untrusted text through bindings, never `innerHTML` (`@app/no-inner-html`).
- Bounded (I-6, I-7): 200-row blocks, 25 blocks, at most 500 followed keys and 48 KiB of key text per subscription; no list-all.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p feature-explorer   # test runs test-components (the component specs) first
```