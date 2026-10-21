# svc-workspace

The workspace engine service (M0-47): what the UI remembers for a person, persisted by engine actions. It owns saved views (filters, columns and sort of a grid, bound to no connection), the layout of each connection profile, settings (a strict, zod-validated set of keys: an unknown key is `VALIDATION_FAILED`) and keybinding overrides. Everything is keyed by the calling principal, so in the team server one person's workspace is not another's.

Actions: `layouts.get` and `layouts.put` (`/connections/{cid}/layout`), `views.list`, `views.create` and `views.delete` (`/views`), `settings.get` and `settings.put` (`/settings`), `keybindings.get` and `keybindings.put` (`/keybindings`). Every collection is bounded: views per person, layouts per person, keybinding overrides and document sizes have caps in the contracts (`libs/shared/contracts/src/registry/workspace.ts`), and `views.list` answers in windows (I-6, I-7).

Tags: `type:service`, `runtime:node`.

## Public API

- `createWorkspaceModule(deps)`: returns the `EngineModule` the composition root registers. Registered in `apps/engine/src/modules/index.ts` (issue #278). The writes answer 422 `GATE_BLOCKED` through the real router until OQ-380 is ruled on.
- `WorkspaceModuleDeps` (`src/deps.ts`): the ports the module needs: `workspace` (the `WorkspaceRepository` port of `@app/ports`, implemented by `@app/persistence`) and `newId` (a ULID source).
- `createWorkspaceFakeDeps()` (`src/testing.ts`): an in-memory workspace store with the semantics of the real one, for specs, the architecture manifest and the HTTP specs.
- `create<Action>Action(deps)` for each action above, for the testkit and the architecture manifest.

## Invariants

- Never imports another service or an adapter; cross-service needs are ports wired in the composition root (blueprint 2.2).
- Every mutation is an `implementAction` file in `src/actions/`; nothing writes through a WritePort outside one (mutation funnel). The workspace commands write only the caller's own UI state, so each has risk `none`, planning `none` and audit `attempt+outcome`.
- Engine buffers are `BoundedRing` or `BoundedQueue` (`@app/bounded-buffers-only`).
- A person's rows are never visible to another: every repository call carries the owner, and deleting another person's view is `NOT_FOUND`.
- The theme and density are not engine settings: the UI keeps them in the browser (OQ-348).

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p svc-workspace
pnpm nx run persistence:it --dialects=sqlite,pg
```
