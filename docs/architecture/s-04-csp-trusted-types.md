# S-04: CSP and Trusted Types with AG Grid, Monaco and ELK (M0-20)

Result of spike S-04. **Decision: go, with changes. Trusted Types are enforced** (not report-only), under a policy that differs from blueprint 7.1 in four places. The harness is `spikes/csp`; `pnpm nx e2e spikes-csp` reproduces every claim below (21 scenarios, about 90 s).

## What was verified, and what was not

| Verified in a real browser | Not verified |
| --- | --- |
| Chrome 155.0.8059.82 and Edge 155.0.4283.45 on Windows 11, headless, driven over the DevTools protocol. | The `app://` origin and Electron itself (moved to M2-P15 by the issue; see "Desktop `app://`" below). |
| Origins `http://127.0.0.1:<port>` and `http://localhost:<port>` (the two local-web origins), CSP as response headers. | macOS and Linux (the harness has no OS-specific code; CI has not run it). |
| AG Grid Community 36.2.0 (infinite row model), Monaco 0.57.0 (editor, JSON worker, suggest, hover, colorize), the unmodified `elk-worker.min.js` of elkjs 0.12.0 (SHA-256 checked against the package). | Cytoscape and ECharts (M2-P15), the real `libs/ui/{grid,graph,editor}` adapters, Angular's own sanitiser policy (the stub shell does not trigger it). |
| The existing `apps/web` Angular 22.2.3 build served under the policy. | Firefox and Safari. A browser without Trusted Types ignores `require-trusted-types-for`; that code path is untested. |
| Enforced and `Content-Security-Policy-Report-Only` delivery. | CSP delivered through `<meta http-equiv>` (the harness uses headers; see "Delivery"). |

## Final policy

Per response, with a fresh nonce (`N`). One line, as sent:

```
default-src 'none'; script-src 'self'; style-src 'self' 'nonce-N'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; worker-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; require-trusted-types-for 'script'; trusted-types app-worker-url app-monaco-html dompurify
```

Web modes (local web, container, team server) add `frame-ancestors 'none'`; it is header-only and does not break anything (`recommended-frame-ancestors`). The product shell adds the Angular policy name `angular` to `trusted-types` (Angular's sanitiser creates `angular`, and `angular#unsafe-bypass` only for `bypassSecurityTrust*`, which lint bans; read from `@angular/core` 22.2.3, not exercised by the stub shell).

**Result against the acceptance criterion:** the blueprint policy verbatim does **not** give zero violations (Monaco, about 80 `style-src-attr` reports per page load, and its lines mis-position). The policy above gives **zero violations, enforced and report-only, on both origins, with all three libraries working** (`recommended`, `recommended-localhost`, `recommended-report-only`). Report-only is therefore not needed as a fallback; it stays available as a rollout switch.

### Changes against blueprint 7.1

| Directive | Blueprint | Final | Why (scenario) |
| --- | --- | --- | --- |
| `style-src-attr` | absent (falls back to `style-src`) | `'unsafe-inline'` | Monaco renders every editor line with `innerHTML` containing `style="top:..;height:.."`. A nonce cannot be put on an attribute and the values change per line, so no hash works. Without it the lines overlap and Monaco is unusable (`blueprint-verbatim`, `no-style-attr`). AG Grid and ELK need no inline style attributes. |
| `base-uri` | `'none'` | `'self'` | Angular's `<base href="/">` is blocked by `'none'` (`angular-shell-base-uri-none`) and the router needs it for deep links. `'self'` still stops base injection to another origin. |
| `worker-src` | `'self' blob:` | `'self'` | No library creates a `blob:` worker: Monaco and ELK load their scripts from `'self'` (`recommended` has no `blob:`; adding it changes nothing, `worker-src-blob`). |
| `trusted-types` | absent | `app-worker-url app-monaco-html dompurify` | Without the directive any policy name is accepted, which defeats the allow-list the blueprint promises. |

Unchanged and confirmed: `default-src 'none'`, `script-src 'self'` (no `unsafe-eval`, no `unsafe-inline`: all three libraries run), `style-src 'self' 'nonce-N'`, `font-src 'self'` (AG Grid and Monaco fonts are same-origin files), `connect-src 'self'`, `frame-src 'none'`, `object-src 'none'`, `form-action 'none'`. `img-src` needs `data:` (Monaco's error squiggle is a `data:` SVG, `no-img-data`); it does not need `blob:` for these libraries (`img-src-self-data`), and `blob:` stays only for product features such as payload previews.

## Trusted Types

Enforcement holds with the three libraries once the UI owns three small pieces. The allow-list names exactly the policies that exist:

| Policy | Created by | Role |
| --- | --- | --- |
| `app-worker-url` | our code | `createScriptURL` for `new Worker(...)`, which is a sink. Accepts only same-origin URLs on a fixed path list (Monaco editor and JSON workers, the ELK worker), so it cannot start an arbitrary script. |
| `app-monaco-html` | our code | One identity `createHTML` that Monaco's ten internal policies are routed through. |
| `dompurify` | Monaco's bundled sanitiser | Created lazily on the first Markdown render (a hover or suggestion documentation). It appears late, so a missing name shows only when that path runs (`no-dompurify-name`). |
| `angular` | Angular | Added by the product shell (see above). |

- **AG Grid creates no policy and needs none**; it uses no HTML sink in normal operation.
- **ELK**: the unmodified `elk-worker.min.js` runs under `script-src 'self'` with the policy on the worker response too. Only the API shim `elk-api.js` calls `new Worker(string)`, so it is given a `workerFactory` that uses `app-worker-url` (`no-worker-policy`).
- **Monaco's own policy names are unstable.** 0.57 creates ten (`editorViewLayer`, `tokenizeToString`, `standaloneColorizer`, ...), one of them twice (`defaultWorkerFactory`), plus `domSanitizeN` on a stale-realm recovery path. Listing them needs `'allow-duplicates'` and breaks on any release that renames one (`monaco-native-names`, `monaco-native-names-allow-duplicates`). `MonacoEnvironment.createTrustedTypesPolicy` (present in 0.57) routes all of them through `app-monaco-html`, so the allow-list stays at one stable name. Monaco's own policies are identity functions, so Trusted Types add no sanitisation inside Monaco; they still stop every other sink in the page.
- **AG Grid string expressions are blocked.** A column with `valueGetter: 'data.size * 2'` makes AG Grid call `new Function`, which is a `TrustedScript` sink (15 reports, `ag-grid-string-expression`) and would also need `unsafe-eval`. The grid adapter must use function getters only. Never add `unsafe-eval`.

## Required library configuration

1. **AG Grid**: pass `styleNonce` in the grid options (it injects 25 `<style>` elements; `no-grid-nonce`). Register only the community modules.
2. **Monaco styles** (no nonce option exists in 0.57): Monaco creates its `<style>` elements (theme token colours, widgets) with `document.createElement('style')`. Install a small hook that sets `element.nonce` on every created `<style>` before Monaco loads (`style-nonce.js`; `no-monaco-style-nonce`: 4 reports and lost token colours without it). It patches `Document.prototype.createElement` for `style` only.
3. **Monaco workers**: `MonacoEnvironment.getWorker` returns `createWorker(url, { type: 'module' })` through `app-worker-url`; worker files are separate entry points served from `'self'` (`editor.worker`, `json.worker`).
4. **Load order**: `MonacoEnvironment` (with `createTrustedTypesPolicy`) and the `<style>` hook must be in place **before** the Monaco modules run, because Monaco creates its policies in static initialisers. In the Angular build this means the `polyfills` entry, not `main.ts`; in the harness it is a `bootstrap.js` module script before `main.js`. Putting them in the main bundle fails silently: Monaco created its own ten policies and the allow-list refused them.
5. **ELK**: copy `elk-worker.min.js` unmodified to a static asset; use `new ELK({ workerUrl, workerFactory })`.
6. **Angular shell**: `ngCspNonce="N"` on the root element so Angular's own `<style>` carries the nonce; `<base href="/">` stays. The build must not inline critical CSS (`optimization.styles.inlineCritical: false`): that adds an un-nonced `<style>` and an `onload` handler. The stub shell has no styles, so this is argued from the builder's documented behaviour and not exercised.

## Delivery

Send the policy as an HTTP response header on **every** response, not only on `index.html`. By the CSP specification a dedicated worker started from a URL takes its policy from its own script response, so a policy in `index.html` alone would not constrain the Monaco and ELK workers; a `<meta http-equiv>` also cannot carry `frame-ancestors`. The harness always sends the header and does not test the negative cases (meta only, header only on the document). The nonce is per response, exposed to scripts through `<meta name="csp-nonce">`; it gates only styles, because `script-src` has no nonce. The work-packages text for the desktop shell ("index.html carries the CSP") should read "the protocol handler adds the header to each response".

## Desktop `app://` (not verified)

The scheme must be registered with `protocol.registerSchemesAsPrivileged` (standard, secure, `supportFetchAPI`; probably `corsEnabled` for module scripts and workers) for `'self'`, module workers and `fetch` to resolve to `app://main`; `bypassCSP` must stay false. That the matrix gives the same results under a custom scheme is expected, not shown. M2-P15 re-runs this matrix inside Electron 44 with the real adapters.

## Risks

- **`style-src-attr 'unsafe-inline'`** allows style attributes from markup injection (UI redress, `background: url()` limited by `img-src`). Mitigations already in the design: no `innerHTML` (lint, ADR-021), enforced Trusted Types (every HTML sink needs a policy-minted value), `script-src 'self'`. If a maintainer rejects it, the editor has to change (OQ-232).
- **Global `createElement` patch.** It is small and style-only but global; keep it in the editor adapter's entry and remove it when Monaco supports a nonce.
- **Upgrades change policy names and styles.** Monaco and AG Grid bumps must re-run `pnpm nx e2e spikes-csp` (or its successor in `ui-editor`/`ui-grid`); the Renovate lane should treat these three packages as needing it.
- **Monaco 0.57.0 bundles `dompurify` 3.4.15**, which has two low advisories on `IN_PLACE` sanitising (GHSA-p98j-92pf-mc4p, GHSA-6688-9rhm-gjv2). Whether Monaco reaches that path is not checked; osv-scanner will flag it when Monaco becomes a dependency.
- **The three libraries are not in the catalog.** The harness installs them to `tmp/` with install scripts off and `npm --before` (3 days). Promoting them needs catalog pins, allow-list entries and a licence-gate pass: AG Grid Community, Monaco and the transitive `ag-stack`, `ag-charts-types`, `marked` are MIT; `dompurify` is `MPL-2.0 OR Apache-2.0`; elkjs is `EPL-2.0 OR GPL-3.0-or-later` (named exception, DC-51).
- **Bundle size.** The harness imports the full `editor.main` (2.7 MB minified chunk, all languages), not the trimmed wrapper ADR-021 budgets (1.1 MB). It says nothing about the budget.

## Reproduce

`pnpm nx e2e spikes-csp`. See [spikes/csp/README.md](../../spikes/csp/README.md). Scenario ids are in `spikes/csp/scripts/scenarios.mjs`; each states what it removes and what must break.
