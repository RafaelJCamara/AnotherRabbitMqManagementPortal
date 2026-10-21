# web-csp-check

Proves, in a real browser, that the production web build **renders styled under the real Content-Security-Policy** when the real engine serves it (issue #277). A unit test cannot show this: the CSP is applied by the browser to the page the engine sends, so the check starts the built engine bundle in local mode, opens the pages at 1280x720 and reads what Chrome reports.

Tags: `type:tooling`, `runtime:node`. Plain Node, no dependencies: a small DevTools-protocol driver on Node's built-in WebSocket (`cdp.mjs`, modelled on the S-04 harness in `spikes/csp`).

## What it checks

For `/c/csp-check/explorer` (the shell) and `/` (the "no connection" view):

- the shell is `display: grid` with two or more columns, and the workspace is to the right of the activity bar (an unstyled shell collapses to one column);
- the page has no horizontal scroll;
- the page carries a `csp-nonce` meta tag and the app root's `ngCspNonce` has the same value;
- **zero** CSP and Trusted Types reports: `securitypolicyviolation` events, `Audits` issues (`ContentSecurityPolicyIssue`), and console, log and exception text that names a CSP or Trusted Types refusal.

Other console errors are printed as `other` lines for information; they do not fail the run. A screenshot of each page goes to `dist/csp-check/`.

## No browser, no proof

The browser is taken from `CSP_CHECK_BROWSER`, then `PERF_BROWSER`, then `CSP_SPIKE_BROWSER`, then Chrome or Edge in their default locations (Windows, macOS) or on `PATH` (Linux). If none is found the run prints `csp-check SKIPPED ... Nothing was proved` and exits 0; with `CSP_CHECK_REQUIRE_BROWSER` set (CI should) it exits 1. A set variable whose path does not exist is "no browser", not a fall-through.

## Proof commands

| Command                                  | What it proves                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `pnpm nx test web-csp-check`             | The judgement (each failure mode), the browser search, the skip message, and that `apps/web/src/index.html` carries the placeholder the transport replaces, in the meta tag and on the app root. |
| `pnpm nx run web-csp-check:csp-check`    | Builds `web` and `engine`, serves the build from the engine bundle and checks it in the browser.        |

## How the nonce reaches Angular

`libs/engine/transport` mints one nonce per response and sends it in `Content-Security-Policy` (`style-src 'self' 'nonce-N'`) and, in `index.html`, replaces the placeholder `__CSP_NONCE__` in `<meta name="csp-nonce">` and in `<app-root ngCspNonce>`. Angular puts the attribute's value on the `<style>` elements of component styles; the grid (`GRID_STYLE_NONCE`) falls back to `CSP_NONCE` and then to the meta tag (OQ-552). The policy is not loosened: no `unsafe-inline`, no `unsafe-eval`, `connect-src 'self'`, Trusted Types enforced.

zod probes `new Function('')` whenever it builds an object schema, which Trusted Types refuse and report. `@app/contracts` therefore switches zod to `jitless` in any realm that has the `trustedTypes` API, as its first import (`no-dynamic-code-init.ts`); `apps/web/src/main.ts` imports it first as well.
