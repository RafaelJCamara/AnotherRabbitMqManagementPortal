# transport

The Fastify transport kit (M0-32, ADR-004, blueprint 3.3 and 7.2): routes derived from the action registry, authentication hooks, request guards and the static web UI. It is the one place where HTTP meets the `ActionExecutor`.

Tags: `type:transport`, `runtime:node`, `trust:critical` (CODEOWNERS sign-off). Imports `@app/contracts`, `@app/kernel`, `@app/live` and `@app/ports`; `fastify` and `ws` are confined to this project and `apps/engine`, and `node:net` is used only to tell a socket request from an injected one.

`buildApp` never listens. The composition root (M0-36) binds a socket, the MessagePort tunnel (M0-34) injects requests, and the live WebSocket (M0-33, below) upgrades through the same guards.

## Public API

| Export                                         | Notes                                                                                                                                                                                                                                                    |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `buildApp(registry, executor, auth, options?)` | A `FastifyInstance`. `auth` is `{mode, authenticators, publicOrigins?}`; `options` are `logger`, `ids`, `ui`, `csp` and `bodyLimit` (default 1 MiB). Runs `assertRegistry` first, so an invalid registry never serves.                                    |
| `createLocalTokenAuth(token)`                  | Authenticator for the launch token in `Authorization: Bearer`. Maps to the `local-token` UI principal.                                                                                                                                                  |
| `createCarrierAuth(secret)`                    | Authenticator for the per-boot carrier secret the tunnel sets. Maps to the `desktop-user` UI principal.                                                                                                                                                  |
| `CARRIER_HEADER`, `INTERNAL_HOST`              | `x-app-carrier` (the product name is still a placeholder, ADR-029) and the `engine.internal` Host the tunnel sets.                                                                                                                                       |
| `API_PREFIX`                                   | `/api/v1`.                                                                                                                                                                                                                                                |
| `contentSecurityPolicy(nonce)`, `NONCE_PLACEHOLDER`, `StaticUiOptions` | The default policy of spike S-04 and the `__CSP_NONCE__` token that `index.html` carries (in the `csp-nonce` meta tag and on `<app-root ngCspNonce>`; `pnpm nx run web-csp-check:csp-check` proves the page renders styled in a browser, #277). `StaticUiOptions` is `{roots: [N, N-1], engineVersion}`.                                                                                     |
| `httpError`, `sendProblem`, `PROBLEM_CONTENT_TYPE` | Problem answers for the transport and the services that add routes later.                                                                                                                                                                         |

## What a request goes through

One `onRequest` hook, in this order, for every route, `404` and `405` included:

1. A request id (the client's `x-request-id` only when it is a plain token) and a fresh CSP nonce; security headers on every response (`nosniff`, `no-referrer`, `same-origin` resource and opener policies, the CSP, `no-store`). No CORS header is ever sent.
2. **Carrier.** A request that arrived over a socket (`instanceof net.Socket`) and carries `x-app-carrier`, with any value, is `403`. Only an injected request can present the secret.
3. **Host and Origin** (`guards/host-origin.ts`). Host is a loopback name (any port) or a listed public origin, compared exactly. `engine.internal` is accepted for injected requests only. An Origin must be this Host spelled as an origin.
4. **Sec-Fetch-Site** (`guards/sec-fetch.ts`). Absent or `same-origin`; `none` only for a navigation to a public route.
5. **JSON-only** (`guards/json-only.ts`). A body is `application/json` (UTF-8) or `415`; a GET or HEAD body is `400`. `text/plain` has no parser.
6. **Authentication.** A route is private unless it says `config: {public: true}` (only the static UI does). Without a principal the answer is `401`. A carrier request never falls back to a bearer token, and a token in a URL, cookie or body is never read.

Then the route assembles the input (path parameters; the query for a GET, typed from the input schema; the JSON object body for the rest; a name given twice is `400`) and calls `executor.run`. Validation, authorisation, planning and audit are the executor's (I-2). A direct call that needs a plan is `428` with `Location: /api/v1/plans/{id}`; a job is `202` with its `Location`. A path bound to one method answers every other with `405` and `Allow`.

## Live WebSocket (M0-33)

`buildApp(..., {live: {hub}})` adds two things; the hub itself is `@app/live`.

- `POST /api/v1/live/tickets` is a private route: it answers `{ticket}`, 256 random bits, single use, valid 30 s, bound to the principal of the request.
- `GET /api/v1/live` upgrades on the HTTP server's `upgrade` event with `ws` in `noServer` mode. `ws` takes the event before Fastify, so no hook runs; `auth/admission.ts` is the one place both paths get their checks from (carrier, Host and Origin, Sec-Fetch, JSON-only, and for a request the credentials). The upgrade runs the guards, then requires `Sec-WebSocket-Protocol: app.v1, app.ticket.<t>` and redeems the ticket last, so a refusal for another reason does not burn it. Only `app.v1` is echoed. A refusal is a bare status line (`403` guards, `401` ticket, `404` path; OQ-336).
- Frames are JSON text, at most 64 KiB from the client; a binary frame closes the socket with 1003. Everything else (credits, outboxes, resume, limits) is the hub's; the socket is passed to `hub.attach` as it is.
- `preClose` terminates open sockets so `app.close()` does not wait for them. The listener is still the composition root's: the kit only listens for `upgrade` on the server it is given.

## Static UI

`StaticUiOptions.roots` are absolute asset directories, newest first. A file is looked up in N, then in N-1, so a tab still running the previous build keeps finding its lazy chunks after an upgrade; `index.html` comes from N only and gets the nonce of the response. Each URL segment must match `[A-Za-z0-9_@+=~-]` plus inner dots (no dotfile, no `..`, no separator, colon or percent after one decoding), and the file found must still lie inside its directory after links are resolved. Router addresses (no extension, `Accept: text/html`) get the app. `GET /bootstrap.json` states `{engineVersion, apiVersion, mode}` and nothing else. `/api` is never shadowed.

## Invariants

- **I-1, T1.** DNS rebinding, CSRF and cross-site requests are refused by the guards before the token is looked at; the token is the second line, not the first.
- **I-2.** The router calls `executor.run` and nothing else; it holds no write port.
- **I-9.** No outbound socket. The only listener is the one a test opens on `127.0.0.1:0`.
- **I-10.** The token and the carrier secret are compared in constant time, never read from a URL, never logged. A Problem's `detail` is fixed text; an unexpected failure is `INTERNAL` with no detail, logged through the redacting logger.
- **ADR-004.** The kit is at most 800 lines of code (`pnpm nx run transport:kit-loc
pnpm nx run transport:it --testNamePattern=live   # real listener, real WebSocket clients`). Specs and `src/testing/` do not count.

## Proof commands

```sh
pnpm nx test transport
pnpm nx run transport:kit-loc
pnpm nx run transport:it --testNamePattern=live   # real listener, real WebSocket clients
pnpm nx run-many -t lint typecheck -p transport
```

Open questions: OQ-280 to OQ-29x and, for the live endpoint, OQ-330 to OQ-339 in [docs/open-questions.md](../../../docs/open-questions.md).
