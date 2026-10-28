# feature-messages

The publish studio (M1-46, PUB-01 UI): compose one message in the web shell, with the contract's limits named at their fields, send it, and read what the broker did with each copy. Later slices add routing-key suggestions and the history (spec `docs/specs/M1-46.md`).

Tags: `type:ui-feature`, `runtime:browser`. Not `trust:critical`: the studio only builds an input and shows what the engine answers; every guard stays in the engine (I-2).

## Status

Slices C and D of M1-46. C: the project, its `publish` Transloco scope, the connection token, the lazy route, the draft (in memory), the form (virtual host, exchange, routing key, properties, headers as a table or typed JSON, body in the code editor, copies, timeout) and `draftToInput`, which checks every bound of the contract before any call. D: Send, the plan dialog, the prod lock strip, the result panel with one text per copy, and the Problem states (including the engine that cannot publish yet). The code editor is the `ui-editor` wrapper; until its Monaco entry exists (slice A2) the body falls back to a plain text box and says so.

## Public API

- `messagesRoutesFor(connection)` and `messagesRoutes`: the route the web shell mounts at `c/:cid/publish`. The app never imports this lazy library statically; it loads it with `loadChildren: () => import('@app/feature-messages').then((m) => m.messagesRoutesFor(() => inject(ActiveConnection).cid))`. The route provides `PUBLISH_CONNECTION` from that factory and the `publish` Transloco scope (a bundled-JSON `import()` loader; keys read `publish.<path>`). An address under the studio is not the studio's and falls through to the shell's not-found view.
- `PUBLISH_CONNECTION`: an injection token for a `Signal<ConnectionId | null>`. `null` means nothing is shown and nothing is asked.
- `MESSAGES_SCOPE`, `MESSAGES_SCOPE_LOADER`: the scope name and its loader (a spec replaces it). `@app/feature-messages/testing` has `markedMessagesScope`: the English file with every text replaced by `[[publish.<path>]]`, for specs of an app that mounts the studio.
- `draftToInput(cid, draft)`: the draft as the contract's `MessagesPublishInput` (`mandatory` and `confirm` are always `true`; nothing in the draft can turn them off), or every issue at its field (`vhost`, `exchange`, `routingKey`, `props.<name>`, `headers`, `headers.<row id>`, `body`, `copies`, `timeoutMs`). It mirrors the contract's bounds to name a field; the engine still decides everything.
- `PublishDraft`, `DraftIssue`, `HeaderRow`: the draft and its parts.
- Internal: `DraftStore` (one draft per connection in memory, at most 32; never storage, the address, a tab label or a log), `prefillFromQuery` (the three address parameters `vhost`, `exchange`, `routingKey`; any other is ignored and a value over 255 characters is refused by name), the header model (rows to the typed table and back, with a named problem per row), `<app-header-grid>`, `<app-props-form>`, `<app-editor-field>` (the code editor, or a plain text box when it cannot be loaded), `<app-field>`.
- Internal (slice D): `SendFlow` (one per studio: plan, then execute; at once when the plan asks nothing; one request in flight; cancelled when the page is left), `planNeeds` / `needsReview` (what a plan asks, read as sent), `<app-plan-dialog>` (gates that block, warnings, approvals missing, consents as checkboxes, the phrase; Execute opens only when everything the plan asks is given and nothing blocks), `<app-lock-strip>` (the prod lock from the connection's class and this page's `ArmingStore`, with the unlock dialog), `<app-result-panel>` (every copy once, the seven counts, success only when the engine says every copy was confirmed), `outcome-text` (the words of an outcome), `problem` and `<app-problem-alert>` (the Problem as sent plus a fixed hint by code), `<app-dialog>` (the modal frame, a copy of the connections pages' by precedent #281).

## Invariants

- Depends on ui-data, ui-design, ui-editor, ui-platform, contracts and pure; never on another feature (blueprint 2.2).
- All copy lives in `src/i18n/en.json`; templates contain bindings only (`@app/ui-no-raw-template-text`, `@app/honest-wording`). No sentence about a publish says delivered, consumed, safe, read-only, non-destructive or undo (R5; asserted over the whole file by AC-29).
- The draft is in memory only (R7). Header values and properties are typed in clear and can hold a secret, so they are never written anywhere, and no header value, property or body text appears in the plan dialog, the result panel, an announcement, the address, the document title, storage or a console call (AC-35).
- The UI never computes authorisation. It shows the gates and the lock as the engine's rule (`lockGate`, the arming window), a plan's requirements as sent, and a closed control with its reason; the engine decides and checks all of it again.
- A copy that was `returned`, `nacked`, timed out or not sent is never folded into success. A Problem before any outcome shows no result and keeps the form.
- Contract values (limits, schemas, the publish action) are read only through `publish/contract-values.ts`, never imported by a component or the route directly: the bundler's chunk order would otherwise build the publish schemas before zod's Trusted Types switch (OQ-1572, #304). `pnpm nx run web-csp-check:csp-check` is the guard.
- Renders text through bindings, never `innerHTML` (`@app/no-inner-html`).

## Not done yet

Suggestions from bindings, which also reads the connection's default virtual host (slice E); history and "Send again" (slice F); the activity entry, command, budget exception and the real-browser check of the studio (slice G). The engine does not route plans and executions yet (OQ-191, OQ-282), so Send falls back to calling the action itself when the plan route is "no such route" (see `send-flow.ts`).

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p feature-messages   # AC-20 to AC-36 (the test target runs test-components first)
pnpm nx test testkit --testNamePattern="M1-46"                # AC-27 and AC-31 through the real router
pnpm nx run web:test --include=apps/web/src/app/shell/publish-mount.spec.ts   # AC-19
pnpm nx run web-csp-check:csp-check                           # needs Chrome or Edge; 0 reports
```
