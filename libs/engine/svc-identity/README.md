# svc-identity

Credential providers and the TokenManager: where a broker login comes from, its renewal and its expiry rules.

Tags: `type:service`, `runtime:node`, `trust:critical`.

## Public API

- `createIdentityModule(deps)`: returns the `EngineModule` the composition root registers.
- `IdentityModuleDeps` (`src/deps.ts`): the ports the module needs.
- `createIdentityFakeDeps()` (`src/testing.ts`): fakes for those ports, for specs, the architecture manifest and the HTTP specs.
- Credential providers (M1-23, slice A): `createPasswordProvider`, `createStaticTokenProvider`, `createTokenCommandProvider` and `createX509ExternalProvider`, each a `CredentialProvider` that returns an `IssuedCredential` or rejects with an `AppError` of fixed text. `ProviderConfigSchema` is the strict union of their non-secret settings.
- The client-credentials provider (M1-23, slice B): `createClientCredentialsProvider` asks the configured token endpoint for an access token through `TokenEndpointPort` (the `adapter-token-endpoint` project implements it), with a fixed-text Problem per failure and a bounded wait. `ProviderConfigSchema` gains the `client-credentials` kind: an `https` endpoint (plain `http` only on a loopback host), a client id, an optional scope and audience; the client secret stays in the profile's sealed credential.
- The TokenManager (M1-23, slice C): `createTokenManager({ providers, auth, capabilities, clock, timers, limits? })`. `credentialFor` returns the credential of a profile and protocol with a `generation`; `track` registers a live connection so its token is renewed at 75 % of the lifetime and pushed to it (`updateSecret` for AMQP 0-9-1, `putAuthToken` or a reconnect for AMQP 1.0, a reconnect for streams, nothing for HTTP); `refreshAfterUnauthorized` is one renewal after a 401, a no-op for a stale generation; `state` and `subscribe` report `valid`, `refreshing`, `failed`, `expired` or `username-changed` with a fixed-text Problem. A renewal whose user name differs or is missing is refused and never reaches the connection. Callers share one renewal in flight; failures back off 2 s doubling to 60 s with at most 8 attempts per lifetime; entries, listeners, concurrent provider calls and every wait are bounded and every refusal is counted (`stats()`). `isRetryableAfter401` allows GET, HEAD and OPTIONS only. The pure rules (`refreshPoint`, `plannedRefreshAt`, `backoffDelayMs`, `renewalActionFor`, `expiryRuleFor`) are exported and tested apart from the manager.
- `SecretValue`: a secret that prints `[secret]` in `String`, `JSON.stringify` and `util.inspect`; `reveal()` is the one way to the value.
- `readTokenClaims`: reads `exp`, `iat` and the user name claim of a JWT. It checks no signature; the broker does.
- Ports (in `@app/ports`, `identity.ts`): `StoredLoginPort`, `CommandRunnerPort`, `TokenEndpointPort` and `ConnectionAuthPort`; the composition root implements them.

## Invariants

- Never imports another service or an adapter; cross-service needs are ports wired in the composition root (blueprint 2.2).
- Every mutation is an `implementAction` file in `src/actions/`; nothing writes through a WritePort outside one (mutation funnel).
- Secrets are write-only (I-10): a secret lives in a `SecretValue`, and no provider puts one, a user name, a command line or a command's output into an error.
- This project imports no socket library and no adapter (I-9, layering); the token request and the command run behind ports.
- Engine buffers are `BoundedRing` or `BoundedQueue` (`@app/bounded-buffers-only`). The TokenManager holds credentials in memory only, keeps at most `maxEntries` of them, and a token, a secret or the text a provider or the connection layer sent is never in its state, errors or `cause`.
- Time and timers come from the injected `Clock` and `Timers`; nothing in this project sleeps or reads `Date.now()`.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p svc-identity
```
