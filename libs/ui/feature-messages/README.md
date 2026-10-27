# feature-messages

The publish studio (M1-46, PUB-01 UI): compose one message in the web shell, with the contract's limits named at their fields. Later slices add sending with an honest outcome per copy, routing-key suggestions and the history (spec `docs/specs/M1-46.md`).

Tags: `type:ui-feature`, `runtime:browser`. Not `trust:critical`: the studio only builds an input; every guard stays in the engine (I-2).

## Status

Slice C of M1-46: the project, its `publish` Transloco scope, the connection token, the lazy route, the draft (in memory), the form (virtual host, exchange, routing key, properties, headers as a table or typed JSON, body in the code editor, copies, timeout) and `draftToInput`, which checks every bound of the contract before any call. **There is no Send yet and the studio makes no engine call**; Send, the plan dialog, the result panel and the outcome texts are slice D. The code editor is the `ui-editor` wrapper; until its Monaco entry exists (slice A2) the body falls back to a plain text box and says so.

## Public API

- `messagesRoutesFor(connection)` and `messagesRoutes`: the route the web shell mounts at `c/:cid/publish`. The app never imports this lazy library statically; it loads it with `loadChildren: () => import('@app/feature-messages').then((m) => m.messagesRoutesFor(() => inject(ActiveConnection).cid))`. The route provides `PUBLISH_CONNECTION` from that factory and the `publish` Transloco scope (a bundled-JSON `import()` loader; keys read `publish.<path>`). An address under the studio is not the studio's and falls through to the shell's not-found view.
- `PUBLISH_CONNECTION`: an injection token for a `Signal<ConnectionId | null>`. `null` means nothing is shown and nothing is asked.
- `MESSAGES_SCOPE`, `MESSAGES_SCOPE_LOADER`: the scope name and its loader (a spec replaces it). `@app/feature-messages/testing` has `markedMessagesScope`: the English file with every text replaced by `[[publish.<path>]]`, for specs of an app that mounts the studio.
- `draftToInput(cid, draft)`: the draft as the contract's `MessagesPublishInput` (`mandatory` and `confirm` are always `true`; nothing in the draft can turn them off), or every issue at its field (`vhost`, `exchange`, `routingKey`, `props.<name>`, `headers`, `headers.<row id>`, `body`, `copies`, `timeoutMs`). It mirrors the contract's bounds to name a field; the engine still decides everything.
- `PublishDraft`, `DraftIssue`, `HeaderRow`: the draft and its parts.
- Internal: `DraftStore` (one draft per connection in memory, at most 32; never storage, the address, a tab label or a log), `prefillFromQuery` (the three address parameters `vhost`, `exchange`, `routingKey`; any other is ignored and a value over 255 characters is refused by name), the header model (rows to the typed table and back, with a named problem per row), `<app-header-grid>`, `<app-props-form>`, `<app-editor-field>` (the code editor, or a plain text box when it cannot be loaded), `<app-field>`.

## Invariants

- Depends on ui-data, ui-design, ui-editor, ui-platform, contracts and pure; never on another feature (blueprint 2.2).
- All copy lives in `src/i18n/en.json`; templates contain bindings only (`@app/ui-no-raw-template-text`, `@app/honest-wording`).
- The draft is in memory only (R7). Header values and properties are typed in clear and can hold a secret, so they are never written anywhere.
- The UI never computes authorisation; this slice renders no gate and sends nothing.
- Contract values (limits, schemas) are read only through `publish/contract-values.ts`, never imported by a component or the route directly: the bundler's chunk order would otherwise build the publish schemas before zod's Trusted Types switch (OQ-1572, #304).
- Renders text through bindings, never `innerHTML` (`@app/no-inner-html`).

## Not done yet

Send, the plan dialog, the result panel (slice D); suggestions from bindings, which also reads the connection's default virtual host (slice E); history and "Send again" (slice F); the activity entry, command, budget exception and the real-browser check of the studio (slice G).

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p feature-messages   # AC-20 to AC-25 (the test target runs test-components first)
pnpm nx run web:test --include=apps/web/src/app/shell/publish-mount.spec.ts   # AC-19
```
