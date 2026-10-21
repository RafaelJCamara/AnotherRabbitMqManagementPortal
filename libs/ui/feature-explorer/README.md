# feature-explorer

The explorer of a connection: grids for queues, exchanges, connections and bindings with filters and saved views, and the cluster overview (M0-54, EXP-02 and EXP-03, UI side). It reads the inventory through `inventory.query`, follows the rows on screen through the `explorer.window` topic, and says in words whenever what it shows is loading, stale, partial or truncated. It reads no message and calls no action that changes the broker; its only commands keep a person's own saved views (`views.create`, `views.delete`).

Tags: `type:ui-feature`, `runtime:browser`. Not `trust:critical`.

## Status

Slices A to J of M0-54: the project, its `explorer` Transloco scope, the connection token, the lazy route table, the engine-backed data port, the inventory grid page (columns, the freshness banner, live feed line), the filter bar, the saved views, the cluster overview, the capability card, the web shell mounting with its tree source and the one chunk-budget exception (AC-24, AC-25), and the proof slice: the request allow-list spec (AC-28, `explorer-requests.spec.ts`), the same calls through the real router (`libs/testkit/src/explorer-ui/explorer-calls.spec.ts`) and the Node perf harness (`pnpm nx run perf:explorer-ui-20k`, AC-26). The pages run in specs against the model's fake data port or the fake engine, and the calls are checked against the real router with the services' in-memory fakes. No browser time is claimed: AC-27 (interaction time in a browser) is planned until the browser driver and issue #277 are available.

## Public API

- `explorerRoutes` and `explorerRoutesFor(connection)`: the child routes the web shell mounts at `c/:cid/explorer`. The app never imports this lazy library statically, so it loads it with `loadChildren: () => import('@app/feature-explorer').then((m) => m.explorerRoutesFor(() => inject(ActiveConnection).cid))`; `explorerRoutesFor` provides `EXPLORER_CONNECTION` from that factory. The parent route provides the `explorer` Transloco scope (`provideExplorerScope`, a bundled-JSON `import()` loader; keys read `explorer.<path>`).
- `@app/feature-explorer/testing`: `markedExplorerScope`, the English file with every text replaced by `[[explorer.<path>]]`, for specs of an app that mounts the explorer (provide it as `EXPLORER_SCOPE_LOADER`).
- `EXPLORER_CONNECTION`: an injection token for a `Signal<string | null>` with the connection id. The web shell provides it on the mounting route; a feature never imports `apps/web`. `null` means no content and no call.
- `EXPLORER_SCOPE`: the scope name.
- Pages (lazy, one chunk): `InventoryPage` (`<app-inventory-page [kind] [vhost]>`: the filter bar, a banner that says what the list is, and `<app-data-grid>` over a window source of `explorer-model`), `InventoryRoute` (kind from the route data, `?vhost=` for bindings), `FilterBar` and `FacetPicker` (disclosure panels; a text change applies after 200 ms or on Enter, any other change at once; only the contract's filter with the facets that apply to the kind; chips that remove themselves; caps refuse with a reason), `FreshnessBanner` (what the last answer's freshness said: loading, stale, truncated, dropped, incomplete, hazards and the engine's reason as sent; the live feed: following, paused, ended with its Problem; a failed window with its Problem; a count-free polite announcement of the state).
- Overview (`lib/overview`, the route's empty path): `OverviewPage` (totals as the broker sent them, an absent one reads "not reported"; messages with their source in words, the time they describe and "partial" when the sum is; rates, or why they are unavailable and no number; the nodes as a table; alarms: an active one is an alert naming node and resource, none says none is reported, unknown says the state could not be read and is never worded as none; the inventory freshness as the grid banner words it), `OverviewStore` (one `overview.get` on open and one per press of Refresh after a 10 s floor; never a timer-driven call; a failed read keeps the last answer, marked as earlier).
- Capability card (`CapabilityCard`, a region of the overview): one row per gate of the profile, in id order, as the engine sent it: open only for `enabled: true`, otherwise "Not available" (a string, a missing field and a non-object are closed), with the engine's reason and source as sent; a source is a link only when it is an absolute https URL without credentials (`rel="noopener noreferrer"`); a profile that is absent, failed, empty or unreadable says the capabilities are not known, never "available". It has no control and computes no authorisation.
- Saved views (`lib/views`): `ViewsControl` (a disclosure: list of the person's views of the kind, apply, save the current filters and columns, replace, delete after an inline confirmation; Save and Delete are `<app-gated>` from the profile's `allowedActions`, closed with a stated reason when the action is not listed or the profile is not known; what a view names and the kind cannot apply is listed; an engine refusal is shown as sent; focus returns to the button), `ViewsStore` (`views.list`, `views.create`, `views.delete`; replace is create then delete) and `ProfileStore` (`profile.get` parsed with `BrokerProfileSchema`; anything else is unknown). The applied view lives in `?view=`.
- Internal: `createEngineExplorerData(api, live)` (`lib/data`): the `ExplorerData` port over `EngineApi` and `LiveClient`; and a spec testbed (`lib/testing`) that runs the real `EngineApi` and live client over the fake engine with the inventory answered by the model's fake.

## Invariants

- Depends on ui-data, ui-design, ui-lib (`ui-grid`), ui-platform, contracts, pure (`explorer-model`) and domain-model; never on another feature (blueprint 2.2). Only `ui-grid` imports AG Grid (I-11).
- All copy lives in `src/i18n/en.json` (the scope root); templates contain bindings only (`@app/ui-no-raw-template-text`, `@app/honest-wording`). No string says "read-only", "non-destructive", "without side effects" or "safe peek".
- Talks to the engine through EngineApi and the live client, never `fetch` or sockets (`@app/no-direct-fetch`).
- Renders untrusted text through bindings, never `innerHTML` (`@app/no-inner-html`).
- Bounded (I-6, I-7): 200-row blocks, 25 blocks, at most 500 followed keys and 48 KiB of key text per subscription; no list-all.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p feature-explorer   # test runs test-components (the component specs) first
pnpm nx test testkit --testNamePattern=AC-28                  # the calls of the UI through the real router
pnpm nx test web-gallery-check                                # AC-25, the source half: every key literal exists and is used
pnpm nx run perf:explorer-ui-20k                              # AC-26: interactions, engine plus adapter in Node (no rendering)
```

## Known limits

- The two view commands, `views.create` and `views.delete`, answer 422 `GATE_BLOCKED` from a running engine today (the prod lock has no connection to arm, OQ-380), so a view cannot be saved or deleted against the real engine yet. The control shows the engine's Problem as sent and loses nothing (AC-19, against the fake engine); `views.list` works.
- A running engine cannot create a connection yet (see `docs/runbooks/run-locally.md`), so the explorer pages show their empty and error states there until a connection exists.