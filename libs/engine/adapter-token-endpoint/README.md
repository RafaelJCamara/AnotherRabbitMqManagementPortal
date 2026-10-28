# adapter-token-endpoint

The token endpoint client: one RFC 6749 4.4 client-credentials request over a socket the Dialer opens (purpose `oidc`), with a bounded response and no echo of the body.

Tags: `type:adapter`, `runtime:node`, `trust:critical`.

## Public API

- `createTokenEndpoint({ dialer, trustStore, route?, timeoutMs? })`: the `TokenEndpointPort` implementation. It never rejects: every outcome is a token or one closed reason (`refused`, `unreachable`, `timeout`, `egress-denied`, `tls-untrusted`, `malformed`, `too-large`).
- `parseTokenResponse(bytes)`: the strict reading of a 200 answer (RFC 6749 5.1).
- `DIAL_PURPOSE` (`oidc`), `MAX_RESPONSE_BYTES` (64 KiB), `MAX_TLS_CA_ENTRIES` (8) and `DEFAULT_TIMEOUT_MS`.

## Invariants

- Imports only contracts, pure, ports and `net-*` projects (blueprint 2.2); never a service or another adapter. It uses Node's HTTP client over the Dialer's socket, so no third-party package is added or confined.
- Every socket comes from the Dialer with the purpose `oidc`, which is on the outbound-calls page (I-9, I-12). A host the egress policy refuses gets no socket; an https issuer is verified against the TrustStore's trust. Plain `http` is accepted only for a loopback issuer: the name must be loopback (`isLoopbackHost` of `@app/ports`, the same function the provider config uses) and, after the dial, the address the socket reached must be too (`isLoopbackAddress`); otherwise the socket is destroyed before a byte is sent and the reason is `egress-denied`. A login in the URL is refused. The `Host` header is the URL's host, with the scheme's default port left out.
- The client secret is sent only in the HTTP Basic `Authorization` field (RFC 6749 2.3.1), never in the URL or the body, and is in no error (I-10). A failure is a closed reason; the issuer's answer is never copied into it.
- The answer is read up to 64 KiB and the whole exchange has a deadline (I-6). A redirect is never followed. There is no keep-alive pool and no retry: the TokenManager decides when to ask again.
- **TLS trust per identity provider (N3, OQ-1559).** The adapter holds a `TrustStore`, not a trust. For each https request it builds `forProfile({ ca })` from `TokenRequest.tlsCa` (the CAs of the provider that sent the request, at most 8, added to the defaults) and keeps nothing, so a CA configured for one provider is never used for another issuer. The insecure-TLS override does not exist for `oidc`: the request type has no field for it, the adapter never passes `insecure` or a server name, and a trust that has the override is refused as `tls-untrusted` before any socket is opened. A CA that does not parse, or more than 8, is `malformed`. This is a working default (OQ-1559) a maintainer may overrule; the Dialer itself does not refuse a verification-off trust for `oidc` (a follow-up question).

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p adapter-token-endpoint
pnpm nx run net-dialer:outbound-calls-check
```
