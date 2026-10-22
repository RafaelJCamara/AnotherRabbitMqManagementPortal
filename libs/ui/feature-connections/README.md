# feature-connections

Connection profiles in the page (M0-52, CON-01 and CON-02, UI side): the list, the create and edit form with write-only secrets, the two tests (management API and AMQP) on their own, the capability card with the probe, the environment chrome and the audited unlock of a production connection. It makes a connection addable, testable, editable and deletable in the served app, where before it took `curl`. Working spec: [docs/specs/M0-52.md](../../../docs/specs/M0-52.md).

Tags: `type:ui-feature`, `runtime:browser`. Not `trust:critical` (it renders the prod lock; the lock is the engine's).

## What it does

| Page | Address | What is on it |
| --- | --- | --- |
| List | `/connections` | One row per connection (windows of 100, at most 200): name, `<app-env-chrome>`, management URL, AMQP address, a link to the connection and one that opens its explorer. |
| Add | `/connections/new` | Name, environment class (five radios; the strip above follows the choice), an optional pasted URI (masked, sent as typed), the management block and the AMQP block (host, port, TLS flag, login; "use the same login for AMQP" is on by default), the draft tests. |
| Connection | `/connections/:id` | The strip with the name, the lock line with **Unlock...** / **Lock again**, Open the explorer, Edit, **Delete...** (behind the lock gate), the addresses and logins (a secret only as "set" or "not set" with its date), the capability card with **Check capabilities**, the saved-connection tests. |
| Edit | `/connections/:id/edit` | The same form with what is stored; every secret empty ("set - leave empty to keep"); **Save changes** is behind the lock gate; a moved address asks for the secret again before sending (OQ-444). |

## Public API

- `connectionsRoutes`: the child routes the web shell mounts at `/connections` (outside `c/:cid`). The app never imports this lazy library statically: `loadChildren: () => import('@app/feature-connections').then((m) => m.connectionsRoutes)`. The parent route provides the `connections` Transloco scope (`provideConnectionsScope`, a bundled-JSON `import()` loader; keys read `connections.<path>`).
- `CONNECTIONS_SCOPE`, `CONNECTIONS_SCOPE_LOADER`: the scope name and the token a spec replaces to see which key a view asked for.
- `@app/feature-connections/testing`: `markedConnectionsScope`, the English file with every text replaced by `[[connections.<path>]]`, for specs of an app that mounts the feature.
- Internal: `ConnectionsService` (the only place the feature calls the engine: `connections.get/create/update/delete/test-http/test-amqp`, `probe.run`, `profile.get`; every change refreshes the shared `ConnectionDirectory`), the form model (`form/form-model.ts`, pure), `<app-confirm-dialog>`, `<app-problem-alert>`, `<app-connection-lock>`, `<app-test-panel>`, `<app-capability-section>`. The shared services it uses live in `ui-data`: `ConnectionDirectory` (the list) and `ArmingStore` with `lockGate` (the lock).

## How the lock is rendered

`ops.arm` is the only unlock and the engine records it (attempt, outcome). No action reports the arming state (OQ-530), so `ArmingStore` remembers what its own `ops.arm` was answered and counts the window from the answer's length against the page's clock. The gate of a mutating control (Save changes, Delete, and the future peek control) is built by `lockGate` from two engine facts, the profile's class (unset or unknown reads `prod`) and that store: closed with the reason, the source `prod-lock` and the engine's own fix `ops.arm`, or open. `<app-gated>` renders it. This is a display of the engine's rule, which the issue asks for (AC-1) and which OQ-795 records; **the engine stays the authority**: it locks every connection today, whatever its class (OQ-283, OQ-785), so on a development connection the first Save or Delete is refused with 422 `GATE_BLOCKED`, the page shows the Problem as sent and offers **Unlock this connection** because the Problem names `ops.arm` for that connection. Nothing is retried on its own and nothing is worked around.

## Invariants

- Depends on ui-data, ui-design, ui-platform, contracts and domain-model; never on another feature (blueprint 2.2). The capability card rules are therefore a copy of the explorer's (OQ-794).
- Secrets are write-only (I-10): a password, a token and a pasted URI are typed into masked, uncontrolled inputs (`<app-field [secret]>`), held in the form's own state, built into a request at submit time, and sent only when typed; a saved profile reads back as set or not set. The component specs plant a canary and scan the DOM, the URL, storage, the console output and every request path (`connection-form.component.spec.ts`, `connections-requests.component.spec.ts`).
- Every command carries an `Idempotency-Key` (made by `EngineApi.call`; found by the real-browser run: the engine refuses a command without one, OQ-819).
- All copy lives in `src/i18n/en.json` (the scope root); templates contain bindings only (`@app/ui-no-raw-template-text`, `@app/honest-wording`). No string says "read-only", "non-destructive", "without side effects" or "safe peek".
- Talks to the engine through `EngineApi`, never `fetch` or sockets (`@app/no-direct-fetch`). Engine text (names, reasons, messages, Problems) is rendered as text only (`@app/no-inner-html`).
- Bounded (I-6, I-7): windows of 100 connections, at most 200 kept; no list-all.
- Dialogs are labelled modals: Cancel first, Escape, Tab kept inside, focus restored, nothing pressable while a call runs; fields have labels and errors tied by `aria-describedby`.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p feature-connections ui-data web   # test runs test-components (the component specs) first
pnpm nx test testkit --testNamePattern=connections                           # AC-12: the same calls through the real router
pnpm nx test web-gallery-check                                               # AC-11, the source half: every key literal exists and is used
pnpm nx run web:budgets                                                      # AC-13: initial 224,536 bytes gzip; connection-form 6.5 kB, connection-page 4.8 kB, connection-list 1.7 kB gzip
```

## A recorded run (AC-14)

Real browser (the Playwright browser of the session, a viewport of about 930 x 860), the production web build served by `pnpm nx run engine:serve`, a stock `rabbitmq:4.3.6-management` container. Seen: the form was filled and the management and AMQP tests each answered against the broker (`RabbitMQ 4.3.6`, cluster, user, tag `administrator`, the broker's AMQP ports); **Add the connection** saved it (the first run failed with `idempotencyKey is required`, which is how the header was found and fixed); the connection page showed "set" for both secrets; **Check capabilities** ran the twelve probe steps and listed eight features with the engine's reasons for the two it could not see (event exchange, stream plugin); **Delete...** on a development connection was refused by the engine with 422 `GATE_BLOCKED` and the dialog showed it as sent with **Unlock this connection**; the unlock (`ops.arm`) put "Unlocked until ..." on the lock line and "Unlocked" in the status bar; **Edit** renamed the connection (the secret field said "set - leave empty to keep"); **Open the explorer** showed the real overview of the broker; a second connection was added from a pasted URI alone as production (nothing unlocked) and its page showed Delete closed with the reason and `prod-lock`; the switcher grouped the two by class and carried `/c/<id>/explorer/queues` over to the other; delete after the unlock removed the row. Not seen: a TLS endpoint, a refused login, the reconnect states, high contrast, a screen reader, other browsers. Playwright's own pointer clicks were intermittently swallowed in that session (script clicks always worked); it was not reproduced in the specs and is noted in OQ-820.

## Known limits

- The Playwright and axe spec (`pnpm nx e2e e2e-web --grep=@connections`, M0-60) does not exist yet; the specs are jsdom, the real router and the recorded run above.
- Object pages do not exist (M1-42), so the switcher's "does this address exist on the other connection" seam (`ADDRESS_EXISTS` in `apps/web`) is proved against a fake; any address that is not an explorer page falls back to the other connection's explorer root with a notice.
- TLS trust configuration, tunnels, auth providers, bundles, colours and team visibility are not in the form (M1-53 and later).
- The arming state is the page's memory: after a reload the page reads "locked" while the engine may still be armed (OQ-793).
