# Run the engine locally

How to start the engine in local mode with the web UI it serves, how to point it at a lab broker, and what works today and what does not. Written for a person running the repository, not for a release.

Status of this page: it describes the engine after issue #278 (it registers `svc-connections`, `svc-capabilities`, `svc-workspace` and `svc-explorer`) and issue #277 (the served page's CSP nonce). Wording follows AGENTS.md section 1: the product name is a placeholder, and nothing here claims a read of a message is harmless.

## Start

```sh
pnpm install --frozen-lockfile        # once
pnpm nx run engine:serve              # builds the engine and the web app, then starts the engine
```

The engine prints one line like

```text
http://127.0.0.1:4310/#t=<launch token>
```

Open it in a browser. The token is made at every start, exists only in that process and in that URL (the fragment is never sent to a server), and is in no log line. Stop with Ctrl+C: the engine drains (live clients are told to go, sweeps end, the database is closed) and exits.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ENGINE_PORT` | `4310` | The port on `127.0.0.1`. `0` lets the system choose; the URL says which. |
| `ENGINE_DATA_DIR` | `tmp/engine-data` | SQLite database, backups and the data-directory lock. Git-ignored. |
| `ENGINE_LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`. |

On the first start the command makes `tmp/engine-data.kek`, a random 32-byte key-encryption key (hex, private to your user), so the credential vault opens without a passphrase (nothing can type one yet, OQ-351). It is a development key: whoever can read that file and the database can read the stored credentials. Delete both to start from nothing. Only one engine can use a data directory at a time (a second start refuses with a lock error).

Without the helper: `pnpm nx build engine && pnpm nx build web`, then

```sh
node dist/apps/engine/main.mjs --mode=local --port=4310 --data-dir=tmp/engine-data --kek-file=tmp/engine-data.kek
```

## A broker to point it at

Any RabbitMQ with the management plugin works. Two quick ways to get a lab broker (Docker needed):

```sh
# The lab image of this repository, as the tests start it (a version from testing/broker-lab/versions.json).
# It prints the addresses and keeps the broker until Ctrl+C. Build the image first with
#   pnpm nx run broker-lab:images --versions=4.3.6      (or leave `build: true`)
node --input-type=module -e "
import { startBroker } from './libs/testkit/src/broker-lab.ts';
const broker = await startBroker({ version: '4.3.6', variant: 'plain' });
console.log(JSON.stringify({ amqp: broker.amqp, http: broker.http, credentials: broker.credentials }));
process.on('SIGINT', async () => { await broker.stop(); process.exit(0); });
setInterval(() => undefined, 1 << 30);
"

# Or the stock image: management on 15672, AMQP on 5672, login guest / guest.
docker run --rm -p 127.0.0.1:5672:5672 -p 127.0.0.1:15672:15672 rabbitmq:4.3.6-management
```

The lab broker chooses its ports and prints them; the stock image uses 5672 and 15672.

## Try the connection against it

`connections.test-http` and `connections.test-amqp` try an endpoint you type without saving it. They go through the Dialer and the real adapters. In a shell (PowerShell users: `Invoke-RestMethod` with the same URL, header and body):

```sh
TOKEN=<the token from the URL>
curl -s -X POST http://127.0.0.1:4310/api/v1/connections/test-http \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"draft":{"http":{"host":"127.0.0.1","port":15672,"auth":{"kind":"basic","username":"guest","password":"guest"}}}}'
```

A good answer is `{"ok":true, "broker":{"product":"RabbitMQ","version":"4.3.6",...}}`. A failure is an answer with a specific `failure.code` (`HTTP_AUTH_REFUSED`, `HTTP_UNREACHABLE`, `HTTP_NOT_MANAGEMENT`, ...), never a bare error.

## What works today

Registered and answering on a running engine (`Engine.served` lists them; the engine test `AC-1` fails if a contract action is neither served nor listed as unserved):

| Area | Actions and topics | Notes |
| --- | --- | --- |
| Meta, arming, diagnostics | `meta.get`, `ops.arm`, `ops.disarm`, `diagnostics.bundle` | |
| Connections | `connections.list`, `connections.get`, `connections.update`, `connections.delete`, `connections.test-http`, `connections.test-amqp`, `bundles.export` | See the limitation below: nothing can be created, so the list is empty. |
| Capabilities | `probe.run`, `profile.get` | Read the broker through the management API, build and cache a BrokerProfile in the engine's own database. |
| Explorer | `inventory.query` (queues, exchanges, connections, bindings), `overview.get`, `search.query`, live topic `explorer.window` | Windows are read from an engine-resident index that sweeps in the background and stops when nobody asks; reads only, no message is read. |
| Workspace | `views.list`, `settings.get`, `keybindings.get`, `layouts.get` | Reads. |

Every management request goes through the BrokerScheduler (a per-broker load budget; interactive work pre-empts background sweeps), every socket through the Dialer and the TrustStore, and a stored login is opened for one request and kept in no log or error.

## What does not work, and why

1. **No connection can be created on a running engine (known, left for the maintainer).** `connections.create` and `bundles.import` are commands that name no connection, so the router (which sends no environment class, OQ-283) treats them as production and the prod lock refuses them until a connection is armed, and there is nothing to arm. The same holds for `views.create`, `views.delete`, `settings.put` and `keybindings.put` (OQ-380) and, until the connection is armed, `layouts.put` (OQ-529). Each answers **422 `GATE_BLOCKED`** with `prod-lock`. The engine test `AC-5` pins this refusal. The guardrails are not changed by this build; the options are in OQ-380 and OQ-770. Until the maintainer rules, `probe.run`, `inventory.query` and the rest are reachable by the engine's tests (which seed a connection straight into the store) and not through the UI.
2. **The served page and the engine are not yet a usable product.** The shell and the explorer grids are built, but with no connection to open (item 1) the explorer shows its empty state. The Content-Security-Policy nonce of the served page (issue #277) has landed, so the page is styled under the real policy.
3. **Nothing that writes to a broker or reads a message is served.** Peek, publish, source, replay and the broker write ports are not wired (`CAPABILITY_MISSING`, `apps/engine/src/unwired-writes.ts`).
4. **Plans carry no BrokerProfile fingerprint or gates yet:** the executor's `ProfileResolver` is not wired (OQ-764). No served action needs one today.
5. **The diagnostics bundle holds no broker profile** (OQ-765).
6. A broker that answers 401 makes `probe.run` answer 401 `UNAUTHENTICATED` with the broker's reason; this is the action's current mapping and is easy to mistake for the launch token being refused (OQ-768).

## Problems

| Sign | Cause |
| --- | --- |
| `The web app is not built` | Run `pnpm nx build web` (the serve target does it). |
| `DataDirLockedError` | Another engine uses `tmp/engine-data`; stop it or set `ENGINE_DATA_DIR`. |
| `vault":"locked"` in the ready line | The key file is unreadable or does not match the database. Delete `tmp/engine-data` and `tmp/engine-data.kek` together. |
| 401 on every request | The token is from an earlier start. Use the URL of the current one. |
| `HTTP_EGRESS_DENIED` | Not expected in local mode (the egress policy allows all today); report it. |

## Proof commands

```sh
pnpm nx test engine                      # composed engine over fake ports, and the real adapters over loopback
pnpm nx run engine:smoke                 # the bundle as a process
pnpm nx run engine:serve                 # this page
```
