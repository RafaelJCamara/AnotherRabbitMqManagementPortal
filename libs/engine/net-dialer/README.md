# net-dialer

The single outbound socket path (M0-26, I-9, DC-43): direct TCP and TLS dialing, a connect-time egress policy hook, a one-client local forwarder and a connector for undici. SSH, SOCKS5 and HTTP CONNECT routes and the SSRF policy come later (M1-22, M3-09).

Tags: `type:net`, `runtime:node`, `trust:critical` (CODEOWNERS sign-off). Imports `@app/net-truststore`, the `DialerPort` type from `@app/ports` (which `Dialer` extends) and Node's `node:net`. No third-party package: the undici connector follows undici's `connect` contract with local types (OQ-185).

## Public API

| Export                                     | Notes                                                                                                                                                                                                                                                                             |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createDialer({policy?, resolver?, purposes?, connectTimeoutMs?, log?})` | A `Dialer`: `check(target)`, `connect(target, route, signal?)`, `dial(target, route, signal?)` and `forwarder(target, route, signal?)`. The route must be `{kind: 'direct'}`; any other route is `VALIDATION_FAILED` until M1-22.                                          |
| `DialTarget`                               | `{host, port, purpose, servername?, tls?}`. With `tls` (a `TlsTrust` from `TrustStore.forProfile`) the socket is a verified `TLSSocket`; without it, plain TCP. `purpose` is a short identifier (`mgmt-http`, `amqp`) that the policy and the logs see.                       |
| `dial()` result                            | `{socket, tls?}`; `tls` is the handshake outcome (`CertDiagnostics`). Record `toProfileTls(tls)` on the BrokerProfile (`verified`, `notAfter`, `insecureOverride`). `connect()` returns the socket only (the `DialerPort` shape; a `Socket` is a `Duplex`).                                              |
| `check(target)`                            | Resolves and evaluates the policy without connecting: `{allowed, reason?, resolved}`.                                                                                                                                                                                              |
| `forwarder(target, route)`                 | Opens the upstream, then listens on a private Unix socket (Windows named pipe) for exactly one client and pipes it through. For libraries that cannot take a socket. Plain bytes only: a target with `tls` is refused. Closes after the client or 30 seconds.                |
| `EgressPolicy`, `allowAllPolicy`           | The hook: `evaluate({host, port, purpose, addresses})`. Only an answer with `allowed === true` allows; a throw, a rejection or any other answer denies (`EGRESS_DENIED`). The default allows everything until M3-09 (OQ-182).                                                |
| `createUndiciConnector({dialer, purpose, tls})` | A `connect` function for `new Agent({connect})`: `https:` origins use `tls`, `http:` origins are plain, a Unix socket path is refused, HTTP/1.1 only.                                                                                                                  |
| `Resolver`, `systemResolver`               | Name resolution (`dns.lookup` with every address); replaced in tests.                                                                                                                                                                                                              |
| `PURPOSES`, `isRegisteredPurpose(id)`      | The purpose registry (M0-69): every reason the product dials, as data (id, feature, destination, trigger, default, status). `createDialer({purposes: isRegisteredPurpose})` refuses any other purpose with `EGRESS_DENIED` before it resolves anything. The docs page `security/outbound-calls` is generated from it. |

## Invariants

- **I-9.** This is the one place a socket to a broker or an identity provider is opened, and `eslint.config.mjs` confines `node:net` and `node:tls` to it (OQ-183).
- **DC-43, DNS rebinding.** A name is resolved once. The policy sees every resolved address, and the connection uses exactly those addresses (`approvedLookup` refuses any other name). An IP literal skips DNS, so it is evaluated before connecting. A denial happens before any socket exists.
- **DC-44.** TLS goes through `@app/net-truststore`; the Dialer adds no way to skip verification other than the profile's explicit `insecure` switch, and logs a warning (host, port, purpose, whether the chain verified) when it is used.
- **I-12, the outbound-calls list.** `src/purposes.ts` is the complete list of outbound calls; a spec fails when a source file dials a purpose that is not on it, and `pnpm nx run net-dialer:outbound-calls` writes the docs page from it (`outbound-calls-check` fails on drift, so a hand edit or a new purpose without a regenerated page is caught). Anything that phones home is off by default (OQ-406).
- **No new listeners.** The forwarder uses a Unix socket or named pipe only, never a TCP port (OQ-186).
- Errors are `NetworkError` with a contract code and a safe detail (OQ-180); the connect timeout covers resolution, TCP and the handshake, and a caller's `AbortSignal` rejects with the caller's own reason.

Open questions: OQ-180 to OQ-190 (OQ-181: the port does not carry `tls` yet) and OQ-406 (the registry) in [docs/open-questions.md](../../../docs/open-questions.md).

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p net-dialer net-truststore
pnpm nx run net-dialer:outbound-calls         # regenerate apps/docs/.../security/outbound-calls.md from the registry
pnpm nx run net-dialer:outbound-calls-check   # fail when the page differs from the registry
pnpm nx run net-dialer:it --versions=4.3.6   # lab broker, TLS variant; needs Docker and openssl
```

The integration test lives in `libs/testkit/src/it/net-dialer.it.ts` because a `type:net` project may not import `type:test` code (OQ-187). It fails, rather than skips, when no Docker daemon runs.
