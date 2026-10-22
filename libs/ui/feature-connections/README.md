# feature-connections

Connection profiles in the page: list, create and edit with write-only secrets, separate management and AMQP tests, the capability card, the environment chrome and the audited unlock of a production connection (M0-52, CON-01 and CON-02, UI side). Working spec: [docs/specs/M0-52.md](../../../docs/specs/M0-52.md).

Tags: `type:ui-feature`, `runtime:browser`. Not `trust:critical`.

## Status

Slices C and D of M0-52: the project, its `connections` Transloco scope, the Problem view and alert, the form model, the confirmation dialog, the connection list, the connection page (environment chrome, addresses and logins with secrets as set or not set, the lock line with the unlock dialog, Delete behind the lock gate and its confirmation), the routes and the service that makes the calls. The form (create and edit), the tests, the capability card and the shell wiring follow in the next slices.

## Public API

- `CONNECTIONS_SCOPE` and `CONNECTIONS_SCOPE_LOADER`: the scope name and the token a spec replaces to see which key a view asked for. Keys read `connections.<path>`.
- `connectionsRoutes`: the child routes the web shell mounts at `/connections` (list, one connection; the form routes come with slice E). The parent route provides the `connections` Transloco scope.
- `@app/feature-connections/testing`: `markedConnectionsScope`, the English file with every text replaced by `[[connections.<path>]]`, for specs of an app that mounts the feature.

## Invariants

- Depends on ui-data, ui-design, ui-platform and contracts; never on another feature (blueprint 2.2).
- Secrets are write-only (I-10): a password, a token and a pasted URI are held in the form's own state only, built into a request at submit time, and sent only when typed; a saved profile reads back as set or not set. See `src/lib/form/form-model.ts`.
- All copy lives in `src/i18n/en.json` (the scope root); templates contain bindings only (`@app/ui-no-raw-template-text`, `@app/honest-wording`). No string says "read-only", "non-destructive", "without side effects" or "safe peek".
- Talks to the engine through `EngineApi`, never `fetch` or sockets (`@app/no-direct-fetch`). Engine text (names, reasons, messages) is rendered as text only (`@app/no-inner-html`).
- The engine is the authority on the prod lock: the page shows a lock gate from the profile's class and what its own `ops.arm` was answered (`lockGate` in `ui-data`), and shows the engine's refusal as sent.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p feature-connections   # test runs test-components (the component specs) first
```
