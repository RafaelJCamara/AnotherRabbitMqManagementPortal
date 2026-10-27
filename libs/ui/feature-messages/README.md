# feature-messages

The publish studio: compose one message, send N copies through messages.publish, see an honest outcome per copy, browse the history.

Tags: `type:ui-feature`, `runtime:browser`.

## Public API

- `messagesRoute`: the lazy route the web shell mounts at `/c/:cid/publish`.

## Invariants

- Depends on ui-data, ui-design, ui-lib, ui-platform, contracts and pure; never on another feature (blueprint 2.2).
- All copy lives in `src/i18n/*.json`; templates contain bindings only (`@app/ui-no-raw-template-text`, `@app/honest-wording`).
- Talks to the engine through EngineApi and the LiveChannel, never `fetch` or sockets (`@app/no-direct-fetch`).
- Renders untrusted text through bindings, never `innerHTML` (`@app/no-inner-html`).

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p feature-messages
```
