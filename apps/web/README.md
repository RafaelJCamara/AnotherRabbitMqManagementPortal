# web

The Angular web app (`type:app`, `runtime:browser`): standalone components, zoneless, OnPush, signals. It talks to the engine only through `EngineApi` and the live channel of `@app/ui-data`, never with `fetch` or sockets of its own (I-1).

Status: the shell of M0-51 (IDE layout, status bar, layout persistence, Transloco) is landing in slices. This README grows with them. Today the app boots through `bootApp`, has Transloco with three scopes, the `c/:cid` route table with a shell host (activity bar, sidebar, workspace outlet, bottom panel, status bar slot) whose layout is stored per connection profile, the design system providers (`@app/ui-design`) and the dev-only gallery. The sidebar holds the explorer tree and the workspace holds the editor groups with their tabs. Real status data and skew handling are later slices.

## Public API

None. The app is an entry point, not a library. Inside it:

- `boot/boot.ts`: `bootApp(env?, hooks?)` sets up the platform (`bootstrapPlatform`), then starts `App` with `appConfig(setup)`. If the platform cannot be set up it starts `BootFailed` instead (no router, no HTTP, no engine call; the cause class and a reload button, never the error text). `hooks` exist for specs.
- `i18n/`: `provideI18n()` (Transloco, English, the `system` scope), `provideScopes(...)` (a route lists every scope its views use: scopes in a child injector replace those of the parent), `SCOPE_LOADERS` (the lazy `import()` of `i18n/en/{shell,status,system}.json`), `bindDocumentTitle()`.
- `shell/shell.routes.ts`: `c/:cid` (lazy host, `explorer` child, unknown children show the not-found view) and the no-connection fallback. `ActiveConnection` holds the validated connection id.
- `shell/layout/`: the layout document and its caps (`ShellLayoutSchema`, `SHELL_LAYOUT_LIMITS`, `parseLayout`, `defaultLayout`, `isSafeTabUrl`), the pure changes a person can make (`layout-ops.ts`: `openTab`, `splitEditor`, sizes, toggles; a change that breaks a cap is refused with a reason), `fitLayout` (the sizing rules for a window) and `ShellLayoutStore` (`layouts.get` and `layouts.put`, the idle-delay save, the flush when the page is hidden, the notice, the refusal and the save state as signals). `LAYOUT_TIMER` and `VIEWPORT` are tokens so specs drive a manual clock and a fixed window.
- `shell/tabs`: `WorkspaceTabs` (open, activate and close tabs, split, rotate and close groups, resize a group splitter; it joins the pure changes of `layout-ops.ts` to the router so a shown tab and the address agree), `<app-tab-strip>` (WAI-ARIA tabs, one tab stop, Delete closes) and `<app-editor-groups>` (the groups and their splitters; the routed view is in the active group).
- `shell/explorer-tree`: `ExplorerTreeSource` and `EXPLORER_TREE_SOURCE` (the default source is the connection's own root node; M0-54 provides a real one) and `<app-explorer-tree>` (WAI-ARIA tree, at most 500 rows).
- `shell/splitter`, `shell/activity-bar`, `shell/bottom-panel`, `shell/notices`: the WAI-ARIA window splitter, the activity bar (entries that have a route, plus the sidebar and panel toggles), the bottom panel (tabs and a labelled empty state) and the notices (why a stored layout was not used, which change was refused, the engine's own words when a save failed).

## Invariants

- The dev gallery is not in a production build (`__DEV_GALLERY__` is false there).
- The initial bundle is at most 350 kB gzip (`INITIAL_LIMIT` in `tools/web-budgets`); a lazy chunk is at most 200 kB gzip.
- A start-up failure of the platform never reaches the engine and never shows the error text (AC-1).
- Every visible string is a Transloco key or engine data; no key of `i18n/en/*.json` is unused (AC-2). The files are bundled chunks, not fetched: the HTTP loader is not used (OQ-526).
- A connection id that is not a plain route token leaves the connection unset (AC-4, OQ-689).
- A stored layout is never trusted: it is parsed, never throws, and a tab address that could leave `/c/<cid>/` is dropped (AC-6). A stored layout that could not be used is kept until the person changes the layout.
- Every collection in the layout is bounded; a change past a cap is refused with a visible reason, never applied in part and never by evicting (AC-8, I-6, I-13).
- A failed save keeps the layout in memory and shows the engine's Problem as sent; a burst of changes is one `layouts.put` (AC-7, OQ-529).
- Tabs and the tree are operable by keyboard with the WAI-ARIA roles: one tab stop per strip and per tree, roving focus, closing the active tab moves focus to a neighbour (AC-10).
- The shell cells shrink and clip (`min-width: 0`, `overflow: hidden`) and `fitLayout` clamps stored sizes to the window, so the page has no horizontal scroll (AC-9).

## Proof commands

| Command                                          | What it proves                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `pnpm nx run-many -t lint typecheck test -p web` | Specs (AC-1, AC-2, AC-4 to AC-10), types and lint (raw template text, honest wording).                               |
| `pnpm nx run web:budgets`                        | Production build, then the gzip budgets (`tools/web-budgets`).                                                      |
| `pnpm nx run web-gallery-check:gallery-absent`   | The gallery is absent from production.                                                                              |
| `pnpm nx e2e e2e-web --grep=@shell` (planned)    | The browser proof of AC-9 and the axe run; `apps/e2e-web` is M0-60. Interim: `fitLayout` spec and the style checks. |
