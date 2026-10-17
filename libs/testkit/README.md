# testkit

Test support. Today it holds the broker-lab helpers (M0-14); port fakes and `createTestEngine` come with the work items that need them.

Tags: `type:test`, `runtime:node`.

## Public API

- `startBroker({ version, variant?, nodes?, build? })` starts a digest-pinned lab broker from `testing/broker-lab` and resolves with a `BrokerHandle`: `amqp`, `amqps` (TLS variant), `http`, `https` (TLS variant), `stream`, `streamTls` (TLS variant), `prometheus`, `digest`, `credentials`, `tls.ca` (TLS variant), `oauth` (OAuth variant), `toxiproxy` (3 nodes) and `stop()`. `variant` is `plain` (default), `tls` or `oauth`; `nodes` is `1` (default) or `3` (plain only).
- `verifyBroker(handle)` runs the M0-14 reachability, version and plugin checks and returns a list of `Check`s; it never throws.
- `waitForManagement(httpUrl, timeoutMs)` waits for `/api/overview` to answer.
- `signLabToken(handle.oauth, { subject, scope })` mints an RS256 token the OAuth variant accepts.
- `loadBrokerVersions()`, `findBroker(version)` read `testing/broker-lab/versions.json`.

The containers are driven through the `docker` CLI (no npm container library, OQ-80). Ports are published on loopback on random host ports, so parallel worktrees do not collide. Broker tests run on Linux only (blueprint section 12).

`src/broker-lab-cli.ts` is the command line behind the `broker-lab` targets; Node runs it directly (erasable TypeScript only, no build).

## Invariants

- Dependencies follow the type:test row of blueprint 2.2; `pnpm nx lint testkit` enforces them.
- Nothing here writes `testing/lab-evidence/**` (I-14).
- No broker-version comparisons (I-3): a version is an exact key into `versions.json`.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p testkit broker-lab
pnpm nx run broker-lab:verify --versions=3.13.7,4.0.9,4.1.8,4.2.9,4.3.6   # needs a Docker daemon
```
