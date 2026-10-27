# ADR-036: Credential providers, the TokenManager renewal model and the oidc Dialer purpose

- **Status:** Proposed
- **Date:** 2026-10-27
- **Issue:** #108 (M1-23, trust-critical); the working spec is [M1-23](../specs/M1-23.md)
- **Related:** [ADR-009](ADR-009-five-role-typed-connection-roles-with-proof-typed-settlement.md), [ADR-012](ADR-012-in-house-protocol-adapters-behind-ports.md), [ADR-014](ADR-014-field-encryption-covering-secrets-captures-plans-and-journal.md), [ADR-019](ADR-019-team-identity-oidc-bff-deny-by-default-rbac-four-eyes-approv.md), [ADR-007](ADR-007-data-driven-semantics-registry-tied-to-independent-lab-evide.md)

This ADR records what slices A to D of M1-23 built, as the Definition of Done asks, and the consequences that slice E and later work inherit. A human accepts it; until then it is a proposal. Where it says "source reading", the claim comes from reading broker source (see [the auth research notes](../research/auth-network-security.md), items V09 to V14, V21, V24 and V41) and has no lab evidence yet (U-14, M1-25).

## Context

A saved connection used to hold one sealed password per protocol. Broker OAuth needs more: a token that expires, is renewed on a live connection, and must keep naming the same broker user. The blueprint (section 7.5, DC-37 and DC-38) fixes the goals: pluggable credential providers, renewal at 75 % of the token's lifetime, an unchanged-username assertion, and a size warning before a token is used. The research notes show why one rule does not fit every protocol and version:

- AMQP 0-9-1 can renew an open connection with `connection.update-secret`. Up to 4.2.5 the broker does not close the connection at expiry: the permission cache is cleared on a timer and later permission-checked calls fail, while existing consumers keep receiving (V13). From 4.2.6 it closes with 320 `CONNECTION_FORCED` "credential expired" (V13).
- AMQP 1.0 closes at expiry from 4.0, and can be renewed with `PUT /auth/tokens` only from 4.1 (V09, V12). Streams renew by re-sending the SASL step with the same username, but the client library the plan names offers no renewal call (V10).
- Before authentication the 0-9-1 frame limit is 4,096 bytes up to 4.0 and 8,192 from 4.1 (V41); the HTTP `Authorization` header is limited to about 4,096 bytes by default (V14).
- The broker names an OAuth user from `preferred_username_claims`, default `sub` then `client_id` (V21).

Three repository rules shape the answer. A service cannot import an adapter or a socket library (AGENTS.md section 3, I-9, I-11). Broker-version behaviour is registry data, not code (I-3). Secrets are write-only after entry (I-10).

## Decision

### 1. Provider model

`svc-identity` (a `type:service`, `trust:critical` project) defines `CredentialProvider.acquire(request, signal)`, which returns an `IssuedCredential`: `password`, `bearer` (token, issue time, expiry or null, username or null) or `external`. A provider rejects with an `AppError` Problem and never carries a secret in it. Settings that are not secret are a strict zod union, `ProviderConfigSchema`, keyed by `kind`. Five kinds exist:

| Kind | What it does | Notes |
| --- | --- | --- |
| `password` | Returns the profile's stored login for `amqp` or `http`. | A locked vault is a `GATE_BLOCKED` Problem with fixed text and no user name (fail closed). |
| `static-token` | Reads `exp`, `iat` and the username claim from a stored JWT. | Never refreshed. A token that is not a readable JWT, or has no `exp`, is refused (`VALIDATION_FAILED`). |
| `token-command` | Runs a configured command and reads a JWT or a JSON `access_token` from stdout. | Absolute path required (no PATH search), argv array, no shell, 10 s and 16 KiB defaults with configured maxima, stdout capped even if the runner reports success. Failures carry fixed text, never stdout, stderr or the command line. |
| `x509-external` | Returns `{ kind: 'external' }` for AMQP. | Refused for HTTP: the management API has no certificate login (V24). |
| `client-credentials` | One RFC 6749 4.4 request through `TokenEndpointPort`. | Client id and secret go in the HTTP Basic field, never the URL. The endpoint is `https`, or `http` only for a loopback issuer. |

Common rules, applied by the shared bearer reader: a token is read as a JWT only to find `exp`, `iat` and the username claims (the broker verifies the signature; this code does not); a token already expired on arrival is `TOKEN_EXPIRED`; an expiry more than 366 days away, or one that overflows the millisecond range, is refused, so the manager never holds a token that never renews or ends. The username claims are a per-provider list defaulting to `['sub', 'client_id']`. Bearer is always preferred over Basic when building an HTTP `Authorization` value.

The stored secret is reached through a fourth port, `StoredLoginPort`, beside `TokenEndpointPort`, `CommandRunnerPort` and `ConnectionAuthPort` (all in `libs/engine/ports/src/identity.ts`). `apps/engine` implements it over the connections service's `configOf` and `openSecret`, because the sealed-row location belongs to `svc-connections`, which a service cannot import.

### 2. TokenManager

`createTokenManager({ providers, auth, capabilities, clock, timers, limits? })` holds one entry per (connection, protocol).

- **Single flight.** Callers that arrive during a renewal share it. The push to live connections starts only after the new credential is adopted, so a reconnect that asks `credentialFor` for its login during the push does not wait for itself. Every provider call and push is cut off after 30 s or at `dispose`.
- **Renewal plan.** The refresh point is `iat + floor(3 * (exp - iat) / 4)` in integer milliseconds, never earlier than 5 s after the start of the last refresh and never after `exp`. A future `iat` is read as the arrival time (clamped, not refused: refusing would reject a token the broker accepts). A token with no `exp` is held without a schedule. A renewal that does not expire later than the token it replaces is refused for a scheduled or on-demand renewal (it would loop); a renewal that drops an expiry the previous token had is refused for every reason.
- **Backoff and cooldown.** A failed attempt retries after 2 s, doubling to 60 s, at most 8 attempts per lifetime, and no retry falls on or after `exp`. The 5 s floor applies to the start of any on-demand renewal. A first token that failed leaves its entry behind with the failure count and wait, so twenty immediate requests make one provider call (`coolingRefusals`). There is no jitter, so tests can pin the schedule.
- **Username assertion (DC-37).** The first bearer token fixes the user name. A renewal with another name is refused as `username-changed`, one with no name as `failed`, both `UNAUTHENTICATED`; neither reaches `ConnectionAuthPort`, the old token keeps being used until its own expiry, and no automatic retry follows. The first name of each (connection, protocol) lives in a separate bounded table (4,096 names of at most 256 characters) that entry eviction never touches, so an entry evicted for room cannot let a new first token claim another user. A full table refuses a token that needs a new row; it never forgets an old one. A first token with an expiry and no name is refused, since every renewal of it would be.
- **`invalidate(connectionId, protocol?, { forgetUsername? })`.** Drops the cached credential, timers, failure count and wait, aborts a renewal or push in flight and discards its late result. A tracked entry keeps its expiry timer, because the live connection still holds the old token. The remembered name is kept unless asked. The manager methods take no principal; they must never be reachable through a route with a caller-chosen connection id.
- **Sweep.** One timer for the whole manager looks every 10 s at tracked entries and runs a refresh or an expiry deadline that is more than 1 s past, because monotonic timers do not notice a wall clock set forward or a machine that slept. Each such action is counted.
- **Renewal per protocol.** `amqp091`: `updateSecret` on the same connection. `amqp10`: `putAuthToken` when the registry says the endpoint exists, else `reconnect`. `stream`: `reconnect`. `http`: no push; the next `credentialFor` returns the new token. A missing sink for `amqp10` or `stream` falls back to `reconnect`, never to nothing. A 320 close of an `amqp091` entry acquires a fresh token and reconnects once (not again inside 5 s).
- **Expiry rule per protocol, from the registry.** If the broker is not proven to close at expiry, the engine cancels the consumers it holds itself when the token expires and publishes the count in the state; if it is proven to, the manager waits for the 320 close and rides through it. A mixed-version cluster, a missing profile, a `SemanticsGapError` or a `capabilities()` that throws or answers something other than an object all read as "nothing proven": the conservative branch. Each such read failure is counted (`capabilityErrors`).
- **Bounds (I-6, I-13).** 256 entries (an idle one is evicted oldest first, one with work in progress or a cooling wait is not), 32 listeners, 8 provider calls at once. Every refusal and every automatic action is counted in `stats()`.

### 3. Secrets handling

`SecretValue` wraps a secret; `toString`, `toJSON` and `util.inspect` print `[secret]` and `reveal()` is the only way to the value. Problems have fixed text and no `cause` that could carry a secret; calls to the command runner and the stored-login port are wrapped so a rejection that holds a command line becomes a fixed-text error. Size warnings carry byte counts and an i18n key, never token bytes, and the sizes are computed without building the header or login response, so no second copy of the token exists. `httpAuthorization` builds the header value only for a caller that needs it and throws `VALIDATION_FAILED` (fixed text) for a token outside printable ASCII or with a space, a Basic user name with a colon, or a control character, so it is not a header-injection sink; the future HTTP client must still validate what it writes.

### 4. Size preflight

A `Bearer <token>` header warns above 4,000 bytes (Basic by its encoded size). A PLAIN login response (`0x00 user 0x00 token`) plus a stated headroom of 1,024 bytes warns above 8,192 bytes when the registry says the broker allows it and 4,096 otherwise; AMQP 1.0 and streams are measured against 4,096. The wording says a request "may" fail, never that it will. A warning does not block the credential. The three rules behind it and behind the expiry rule are registry capability rules (`amqp091ClosesAtCredentialExpiry` `>=4.2.6`, `amqp10TokenRenewalEndpoint` `>=4.1.0`, `amqp091PreAuthFrame8192` `>=4.1.0`), written by hand in `auth-capabilities.data.ts` because the capability-rule schema has no status, evidence or CF id. Each cites the research notes and is a source reading. No cell was added and no status was changed (I-14).

### 5. The `oidc` Dialer purpose and the token endpoint adapter

`adapter-token-endpoint` is a new `type:adapter` project behind `TokenEndpointPort`. It dials only through the Dialer with purpose `oidc` and a TLS trust, never follows a redirect, reads at most 64 KiB, and maps a failure to a closed set (`unreachable`, `egress-denied`, `tls-untrusted`, `timeout`, `refused`, `malformed`, `too-large`). It uses Node's HTTP client over a socket the Dialer opens, the way `adapter-prometheus` does, not `undici`. No dependency is added, so the catalog, the allow-list and the confinement table are unchanged. For plain `http` it requires a loopback issuer by name and then checks the connected socket's remote address, and it destroys the socket before a byte is sent when the address is not loopback (the Dialer resolves names with the system resolver). The `oidc` purpose moves from `planned` to `active`, and its row on the generated outbound-calls page is narrowed to what exists: the token endpoint of an identity provider an administrator configured, on a credential acquisition or refresh, never until a client-credentials provider is configured. M1-24 widens the row when sign-in, discovery and the key set land. Issues #293 (pass an abort signal to `Dialer.dial`), #294 (one `DialerAgent` and a confinement row for `node:http`, `node:https`, `node:http2` and `node:dgram`) and #295 (map an identity provider's status to a reason) follow from this choice.

## Rationale

- Providers return data and Problems; the manager owns time. That keeps the five kinds testable with fakes and keeps timers, bounds and counters in one place that a reviewer can read.
- Fail closed everywhere the spec could have defaulted open: a locked vault, an unreadable token, a changed or missing user name, an unknown capability, an overflowing expiry, a full name table.
- The 75 % rule, the username assertion and the per-protocol renewal come from DC-37 and DC-38. The expiry rule is registry data so that I-3 holds and the lab (M1-25) can later correct a number without a code change.
- The name table is separate from the entries because the entries are evictable across tenants; a security review reproduced the chain (alice, an evicting connection, mallory accepted) on the first version before it was fixed.
- Node's HTTP client over the Dialer socket reuses a pattern the repository already has and avoids a new dependency and a new confinement entry.

## Alternatives considered

Only alternatives the spec or the open questions record are listed.

- **Reading the sealed credentials directly in `svc-identity`.** Rejected in favour of `StoredLoginPort`; the alternative was to copy the sealing constants into the service.
- **Provider settings in the stored connection config.** OQ-1455 proposes a new `credential_providers` table; the alternative is a `StoredConfig` v2 migration. Not decided in code yet.
- **`undici` in the adapter** (the spec's first plan, with a confinement entry) versus Node's HTTP client over the Dialer. The latter was built. `openid-client` was not used; the request is a small form POST.
- **A dedicated Problem code for a changed user name** (`IDENTITY_USERNAME_CHANGED`) was not added (it changes the contracts and `api-docs`); `UNAUTHENTICATED` is used (OQ-1456). A separate `IDP_ERROR` code for malformed or oversize identity-provider answers is open (OQ-1500, OQ-1501).
- **Accepting a first token with an expiry and no user name**, and then refusing every renewal, was the first default; it was replaced by refusing it at the first request (OQ-1505, OQ-1532).
- **Refusing a future `iat`** instead of clamping it: rejected because it would reject a token the broker accepts.
- **Pushing the new token inside the single flight** was rejected because a reconnect that asks for its login would wait for itself.
- **Timer-driven housekeeping as a `defineJob`** rather than a direct call through `ConnectionAuthPort` is a maintainer decision (OQ-1463).
- **Retrying every idempotent method after a 401** (RFC 9110) versus GET, HEAD and OPTIONS only: the narrower set was chosen because PUT and DELETE on the management API change broker state (OQ-1459).

## Consequences

- **The TokenManager is not wired.** Nothing in `apps/engine` builds it yet: no `ProviderLookup`, no `ConnectionAuthPort`, no `StoredLoginPort`, no command runner, and `adapter-amqp091` has no `updateSecret`. The `oidc` purpose is `active` because the adapter that dials it exists in the repository; nothing dials it until slice E. The ADR does not claim that renewal works on a real broker.
- **Not GA until the lab agrees (U-14).** The renewal and expiry rules, the frame limits and the 1,024-byte headroom are source readings. M1-25 records the real behaviour and replaces the constants. Until then no UI should offer the manager.
- **Vuln 3, the expiry watchdog.** On brokers up to 4.2.5 the broker does not close the connection at expiry. The manager cancels the consumers the engine holds itself at expiry. The slice C security review also asked for a watchdog of about 10 s that closes or suspends publishers whose token ran out; it needs a new `ConnectionAuthPort` method and is not built (OQ-1537 item 1).
- **TLS trust per identity provider (N3).** `createTokenEndpoint` binds one `TlsTrust` at construction, while the endpoint varies per profile. Until slice E decides between a trust per request and refusing the insecure-TLS override for `oidc`, a profile's own CA or insecure override would apply to every issuer the adapter calls.
- **The HTTP client must validate headers.** `httpAuthorization` and `isRetryableAfter401` are tested functions; nothing enforces the 401 rule until the HTTP client uses them (OQ-1537 item 6, OQ-1552).
- **The token command is code execution.** The provider and its limits exist; the runner is implemented in `apps/engine` and must be present only in delivery modes that run on the person's own machine (OQ-1460). If the gate is missing, whoever can save such a provider config can make the engine run a program. Whether the container runtime of the Docker web app counts as "the person's own machine" is not decided (a question in the slice E plan of the spec).
- **`invalidate` must be wired** on a profile edit or delete, a secret rotation, a vault lock and a prod lock, and the manager must not be exposed through a route with a caller-chosen connection id (OQ-1506, OQ-1534).
- **x509/EXTERNAL cannot connect yet.** The provider exists; the trust store has no client certificate and the profile schema has no `external` kind (OQ-1461).
- **AMQP 1.0 and stream renewal are seams only.** `adapter-amqp10` (M1-07) does not exist; with no sink the manager reconnects (OQ-1464).
- **Cost of bounds.** After 4,096 remembered (connection, protocol) names the manager refuses new first tokens until a profile deletion calls `invalidate(..., { forgetUsername: true })` (OQ-1533).
- **CODEOWNERS** already lists `svc-identity` and `adapter-token-endpoint`; the three capability rules still await CODEOWNERS sign-off or an RFC issue (OQ-1548).
