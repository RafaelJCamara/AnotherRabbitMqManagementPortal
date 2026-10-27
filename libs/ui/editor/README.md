# ui-editor

The Monaco editor wrapper (M1-46, ADR-021, S-04). It owns what has to exist before any Monaco module runs under the enforced policy (`require-trusted-types-for 'script'`, `style-src 'self' 'nonce-N'`, `worker-src 'self'`): the two Trusted Types policies, `MonacoEnvironment` and the `<style>` nonce hook, and the loader that installs them and only then imports Monaco. Features see a narrow facade and never a Monaco type.

Tags: `type:ui-lib`, `runtime:browser`. `monaco-editor` may be imported only here (I-11, the confinement table of `eslint.config.mjs`).

## Status

Slices A1 and B of M1-46: the environment, the loader and the components, all proved against a fake host. **There is no `monaco-editor` package in the workspace yet.** `loadMonaco()` therefore rejects with `EditorLoadError('not-bundled')` and the components report it through `loadFailed`; slice A2 (after a maintainer adds the dependency, OQ-1509, and rules on OQ-232) adds the trimmed Monaco entry, the workers, the implementation of `EditorHost` over Monaco and the real-browser check (AC-7 to AC-11, and AC-15, the keyboard way out). The shape of `EditorHost` is settled against the fake host only and may still change when A2 meets the real API (OQ-1538).

## Public API

- **`installEditorEnvironment(realm?)`** (`environment/monaco-environment.ts`): idempotent per realm (the page by default). Creates the policies `app-worker-url` and `app-monaco-html` (none when the page has no Trusted Types), sets `MonacoEnvironment.getWorker` and `createTrustedTypesPolicy`, and installs the `<style>` nonce hook. A policy that was created is reused when the call is repeated after a failure, so a name is never created twice. The CSP is never loosened: no `blob:` worker, no `unsafe-eval`.
- **`EDITOR_WORKER_PATHS`** (`environment/trusted-types.ts`): the only script URLs the worker policy mints (`/workers/editor.worker.js`, `/workers/json.worker.js`). A URL must be the listed path, or that path on the page's own origin, and equal what the URL parser makes of it: no other origin, query, fragment, credentials, `..`, encoded or backslash form. A realm without Trusted Types applies the same check before `new Worker`. Slice A2 replaces the fixed names with content-hashed ones generated at build time (OQ-1512).
- **Monaco policy hook**: every policy Monaco asks for (about ten names, one twice, different per release) is answered from the two allowed policies, so the CSP `trusted-types` list stays at stable names. HTML goes through `app-monaco-html`, script URLs through the worker policy.
- **Style nonce hook** (`environment/style-nonce.ts`, internal): gives each `<style>` element made through `createElement` the page nonce from `<meta name="csp-nonce">` and no other element; with no nonce nothing is patched. It patches the prototype that owns `createElement`, once.
- **`createMonacoLoader({ install?, importHost })`, `loadMonaco()`, `MONACO_LOADER`** (`loader.ts`): `load()` is single flight (concurrent callers share one attempt and one host), installs the environment on every attempt before importing the Monaco entry, keeps a success and does not cache a failure. Failures are `EditorLoadError` with a `code`: `environment`, `module` or `not-bundled`. Specs provide `MONACO_LOADER` with a fake host.
- **`<app-code-editor>`** (`CodeEditor`): inputs `value` (two-way `model`), `language`, `readOnly`, `ariaLabel` (required), `hint` (a sentence under the editor, for example how to leave it with the keyboard), `schema` (JSON Schema, applied only while the language is `json`), `maxBytes`, `markers`; outputs `valueChange`, `overLimit`, `markersDropped`, `ready`, `loadFailed`. `valueChange` fires for edits and never for a value set from outside or for text the editor rewrote while taking it. `overLimit` carries the UTF-8 byte count while the value is over `maxBytes` and `0` once when it is back within; the text is never truncated. At most `EDITOR_MAX_MARKERS` (100) markers are shown and the rest are counted in `markersDropped`. The component creates nothing if it is destroyed before the lazy load resolves, and disposes the editor, its model and its listener once otherwise. Labels arrive as inputs: the library has no strings.
- **`<app-diff-editor>`** (`DiffEditor`): inputs `original`, `modified` (two-way), `language`, `ariaLabel`; outputs `modifiedChange`, `ready`, `loadFailed`. The original side is never editable (the host must honour `originalEditable: false`); both models are disposed with the editor.
- **Theme bridge** (`theme-bridge.ts`, internal): `ThemeService.resolved()` as `vs`, `vs-dark` or `hc-black`; an unknown mode is `vs`. Editors apply it with `EditorHost.setTheme` when it changes, without being recreated (high contrast is always the dark one, OQ-1539).
- **Schema registry** (`schema.ts`, internal): Monaco's JSON diagnostics options are global, so a registry keeps one entry per model URI and gives `SchemaPort.setSchemas` the whole list on every change; removing a model that has no entry calls nothing.
- **Facade types** (`facade.ts`): `EditorLanguage`, `EditorMarker`, `EditorOptions`, `EditorHandle`, `DiffEditorOptions`, `DiffEditorHandle`, `EditorHost`, `EditorThemeName`, `JsonSchema`, `SchemaEntry`, `SchemaPort`, `EditorDisposable`, `MonacoLoader`. `EditorRealm` is exported for tests.
- **`@app/ui-editor/testing`** (`testing.ts`): `fakeHost` (the recording fake host the component specs use) and `provideFakeLoader`, for the specs of a feature that uses the editor (M1-46 slice C); never part of the production API.

## Invariants

- The order is the contract: environment first, then Monaco, in one single-flight promise. Nothing else may import Monaco statically (OQ-1513).
- The policy list is a fixed set per build. The worker policy cannot start an arbitrary script (S-04).
- No Monaco type or value crosses the public API. No `innerHTML` (ADR-021).
- A value is never truncated or rewritten by this library; going over a limit is reported, not enforced (the feature blocks Send).
- This library writes nothing to storage and sends nothing anywhere.
- Dependencies follow the type:ui-lib row of blueprint 2.2; `pnpm nx lint ui-editor` enforces them.

## Not proved yet

Monaco inside the Angular application builder, its trimmed size, its use of storage, the worker policy in a real browser and `.ttf` served as `application/octet-stream` are slice A2 (AC-7 to AC-11). The component specs use a recording fake host: they prove what the components ask of the facade, not what Monaco does with it (global theme and JSON options, line-ending rewrites, layout on resize, the keyboard way out, AC-15). `app://` (M2-P15), Firefox and Safari are not verified.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p ui-editor   # AC-1 to AC-6 (jsdom, fake realm and fake host), AC-12 to AC-14, AC-16 to AC-18
# the test target runs test-components first: the component specs go through the Angular builder (signal inputs need its AOT compile)
```
