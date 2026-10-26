# adapter-token-endpoint

The token endpoint client: one RFC 6749 4.4 client-credentials request over a socket the Dialer opens (purpose `oidc`), with a bounded response and no echo of the body.

Tags: `type:adapter`, `runtime:node`, `trust:critical`.

## Public API

- `createTokenEndpoint({ dialer, trust, route?, timeoutMs? })`: the `TokenEndpointPort` implementation. It never rejects: every outcome is a token or one closed reason (`refused`, `unreachable`, `timeout`, `egress-denied`, `tls-untrusted`, `malformed`, `too-large`).
- `parseTokenResponse(bytes)`: the strict reading of a 200 answer (RFC 6749 5.1).
- `DIAL_PURPOSE` (`oidc`), `MAX_RESPONSE_BYTES` (64 KiB) and `DEFAULT_TIMEOUT_MS`.

## Invariants

- Imports only contracts, pure, ports and `net-*` projects (blueprint 2.2); never a service or another adapter. It uses Node's HTTP client over the Dialer's socket, so no third-party package is added or confined.
- Every socket comes from the Dialer with the purpose `oidc`, which is on the outbound-calls page (I-9, I-12). A host the egress policy refuses gets no socket; an https issuer is verified against the TrustStore's trust. Plain `http` is accepted only for a loopback issuer; a login in the URL is refused.
- The client secret is sent only in the HTTP Basic `Authorization` field (RFC 6749 2.3.1), never in the URL or the body, and is in no error (I-10). A failure is a closed reason; the issuer's answer is never copied into it.
- The answer is read up to 64 KiB and the whole exchange has a deadline (I-6). A redirect is never followed. There is no keep-alive pool and no retry: the TokenManager decides when to ask again.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p adapter-token-endpoint
pnpm nx run net-dialer:outbound-calls-check
```
