# net-truststore

TLS trust for every outbound connection (M0-26, DC-44, blueprint 7.5): the bundled, system and organisation CAs, a profile's own CAs added on top, a server-name override, an explicit insecure switch, the TLS handshake over a connected socket, and certificate diagnostics.

Tags: `type:net`, `runtime:node`, `trust:critical` (CODEOWNERS sign-off). Imports `@app/contracts` (the error codes) and `@app/domain-model` (the `tls` fields of a BrokerProfile), and Node's `node:tls`, `node:net` and `node:crypto`. No third-party package.

## Public API

| Export                                          | Notes                                                                                                                                                                                                                                                                 |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createTrustStore({org?, includeSystem?, runtime?})` | `defaults` = bundled + system + organisation CAs (deduplicated, in that order); `sources` counts them (and `systemError` if the system store could not be read); `install()` makes `defaults` the process default (`tls.setDefaultCACertificates`); `forProfile(profile)`. |
| `TrustStore.forProfile({ca?, servername?, insecure?})` | Returns a `TlsTrust`: `ca` (defaults followed by the profile's CAs, never instead of them), `insecureOverride`, `verifyName(host, hint?)` (override, then hint, then host) and `connectOptions(host, hint?)` for `tls.connect({socket, ...})`.                            |
| `secureSocket(socket, trust, host, {hint?, signal?})` | The handshake over a connected socket. Resolves `{socket: TLSSocket, diagnostics}`; rejects with `NetworkError` (`TLS_UNTRUSTED` for a certificate problem, `BROKER_UNREACHABLE` for anything else) and destroys the socket.                                          |
| `diagnoseTlsSocket`, `describeCertificate`, `classifyTlsError`, `toProfileTls` | `CertDiagnostics` (verified, failure kind, verified name, SNI, SAN match, protocol, cipher, chain leaf first, expiry); `toProfileTls` gives `{verified, notAfter?, insecureOverride}` for `BrokerProfile.tls`.                                                       |
| `NetworkError`                                  | `code` (a contract `ErrorCode`), `detail` (safe to show), `retryable`, `tls` (`{nodeCode, verifiedName}`). See OQ-180.                                                                                                                                                  |
| `parseCertificates`, `validateServername`       | Import-time validation: PEM only, certificates only (a private key is refused without echoing it), size and count bounds.                                                                                                                                              |
| `@app/net-truststore/testing`                   | Test support, not part of the production API: an in-memory PKI (`createTestPki`, `issueCertificate`, any validity window and names) and `startTestTlsServer`. No key material is written to disk.                                                                       |

## Invariants

- **I-9, DC-44.** Trust is configured in code. A profile's `ca` is concatenated onto the defaults, because Node's per-connection `ca` option replaces them. Verification is Node's (`rejectUnauthorized: true`); it is off only when the profile says exactly `insecure: true`, and the result then carries `insecureOverride: true` for the UI banner and the BrokerProfile.
- **No leaf pinning.** A rotated leaf under the same CA verifies. `fingerprint256` in the diagnostics is for a person to read (OQ-184).
- **The name is explicit.** The verified name is the override, else the caller's hint, else the host; `checkServerIdentity` always checks that name, and SNI is sent for names but never for an IP address.
- **I-10.** Errors and diagnostics name hosts, codes and kinds; they never carry a PEM block or key. A CA import that holds a private key is refused.
- The minimum TLS version is 1.2 and is set in the secure context, not inherited from process flags.

Open questions: OQ-180, OQ-184, OQ-187, OQ-188 in [docs/open-questions.md](../../../docs/open-questions.md).

## Proof commands

```sh
pnpm nx test net-truststore
pnpm nx run-many -t lint typecheck test -p net-truststore
pnpm nx run net-dialer:it --versions=4.3.6   # lab broker, TLS variant; needs Docker
```
