# testkit

Test support: the broker-lab helpers (M0-14), `createTestEngine` and the management-port fakes (M0-35). The scenario engine and the large synthetic fakes come with the work items that need them.

Tags: `type:test`, `runtime:node`.

## Public API

- `startBroker({ version, variant?, nodes?, build? })` starts a digest-pinned lab broker from `testing/broker-lab` and resolves with a `BrokerHandle`: `amqp`, `amqps` (TLS variant), `http`, `https` (TLS variant), `stream`, `streamTls` (TLS variant), `prometheus`, `digest`, `credentials`, `tls.ca` (TLS variant), `oauth` (OAuth variant), `toxiproxy` (3 nodes) and `stop()`. `variant` is `plain` (default), `tls` or `oauth`; `nodes` is `1` (default) or `3` (plain only).
- `verifyBroker(handle)` runs the M0-14 reachability, version and plugin checks and returns a list of `Check`s; it never throws.
- `waitForManagement(httpUrl, timeoutMs)` waits for `/api/overview` to answer.
- `signLabToken(handle.oauth, { subject, scope })` mints an RS256 token the OAuth variant accepts.
- `loadBrokerVersions()`, `findBroker(version)` read `testing/broker-lab/versions.json`.
- `createTestEngine({ actions, registry?, authorizer?, withArming? })` builds the real router over the real executor with memory audit, receipts and plan store, and returns `inject({ method, path, payload, headers, authenticated })` (below `/api/v1`, with the launch token), `executor`, `audit`, `receipts`, `writeCalls`, `arm(connectionId)`, `context()` and `close()`. Nothing listens on a socket. The router sends no environment class, so every call is prod and a mutation is locked until `arm(connectionId)` (OQ-283), unless its contract declares `scope: 'local'` and names no target (OQ-783); `withArming` also registers `ops.arm` so a spec can arm over HTTP. The HTTP spec of every generated action lives in `src/http/` and uses it.
- `createFakeMgmtRead(responses)` and `createFakeMgmtWrite(responses)` answer management-API requests from a table, through the schema each request carries, record every request, and refuse a path or `METHOD path` the table does not list.

- `createCaptureStack({ options?, now?, logger? })` (M1-09) opens the whole capture stack on one temporary SQLite file: every migration, the real repository and FTS5 index, the real AES-256-GCM field cipher over a `RotatingKeyRing` (`rotate()`, `forget(id)`) and the real `CaptureStore` of `svc-messages`. It returns `store`, `repo`, `handle`, `keys`, `fileBytes()` (the database file and its log, for leak and deletion checks), `checkpoint()` and `close()`. The specs in `src/captures/` and `perf:capture-ingest` use it.
- `src/golden/` and `src/it/{run-golden,golden-record.it}.ts` are the recorder of the golden fixtures (M0-25, `pnpm nx run adapter-mgmt-http:record-golden`): it starts a lab broker (or LavinMQ), seeds it from `testing/fixtures/seed.json`, asks the plan, scrubs the answers (`scrub.ts`, with its own spec and a planted canary secret) and writes `testing/fixtures/{mgmt,prometheus}`; `--check` compares shapes only (`skeleton.ts`). Nothing in it is exported from the package index.

The containers are driven through the `docker` CLI (no npm container library, OQ-80). Ports are published on loopback on random host ports, so parallel worktrees do not collide. Broker tests run on Linux only (blueprint section 12).

`src/broker-lab-cli.ts` is the command line behind the `broker-lab` targets; Node runs it directly (erasable TypeScript only, no build).
- `src/it/run-record.ts` is the command line behind `conformance:record` (M0-15): it starts a broker per version and runs the recorder of `apps/conformance` against it, handing the broker over in `LAB_BROKER`. `src/it/conformance.it.ts` (`pnpm nx run conformance:it`) runs the recorder and the raw drivers on a real broker. Neither writes `testing/lab-evidence/**`.
- `src/it/seed-lab.ts` (`pnpm nx run testkit:seed-lab -- [--queues=300 --vhosts=2 --exchanges=6 --bindings=4 --version=4.3.6 --no-build --existing=URL]`, OQ-822) starts a lab broker (or seeds the one `--existing` names), imports two vhosts, exchanges of four types, queues of three types and bindings by `POST /api/definitions`, prints the host, ports and login to type into the connection form, and removes the container on Ctrl+C. It makes no message, connection or consumer. `src/it/seed-plan.ts` is its Docker-free part (argument parsing and the definitions it will import), unit-tested in `seed-plan.spec.ts`; `src/it/seed-queues.ts` is the older single-purpose seeder of the scale runs.

## Invariants

- Dependencies follow the type:test row of blueprint 2.2; `pnpm nx lint testkit` enforces them.
- Nothing here writes `testing/lab-evidence/**` (I-14).
- No broker-version comparisons (I-3): a version is an exact key into `versions.json`.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p testkit broker-lab
pnpm nx run broker-lab:verify --versions=3.13.7,4.0.9,4.1.8,4.2.9,4.3.6   # needs a Docker daemon
```
