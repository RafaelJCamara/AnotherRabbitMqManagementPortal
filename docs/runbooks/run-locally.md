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

## Local web mode in detail (M0-59)

Local web mode is `--mode=local`. It binds `127.0.0.1` only, serves the built web UI, prints one launch URL with the token in the URL fragment, and keeps its data in `--data-dir` under the single-instance lock (a second engine on the same directory exits 75). Extra arguments after `engine:serve --` go to the engine:

```sh
pnpm nx run engine:serve -- --open        # also open the default browser at the launch URL
```

| Flag | Meaning |
| --- | --- |
| `--open` / `--no-open` | Open the default browser once the engine listens. The default is no browser. The token never appears on a command line: the engine opens a private redirect file in a temporary directory and removes it after 30 seconds. If no browser can be opened you get a warning and the URL to copy. |
| `--host=127.0.0.1` | The only accepted values are `127.0.0.1`, `::1` and `localhost`. `--host=0.0.0.0` (or any LAN address) is refused with exit 78 and guidance: outside loopback the engine would need real authentication and TLS, which it does not have yet (DC-36). To use it from another machine, tunnel: `ssh -L 4310:127.0.0.1:4310 user@host`. |
| `--token-file=<path>` | Use a fixed launch token from a file (32 to 512 characters of `A-Za-z0-9_-`, for example `openssl rand -base64 32 \| tr '+/' '-_' \| tr -d '=\n'`). Without it, a random token is made at every start. A bad file is a usage error (exit 64) that names the flag and prints neither the path nor the content. |
| `--public-origin=<origin>` | Only loopback-form origins (`http://127.0.0.1:9000`, `http://localhost:9000`) are accepted; anything else is refused (A-12). |

A page on another origin, or any other `Host`, cannot call the engine even with the token: a request whose `Host` is not `127.0.0.1`, `localhost` or `[::1]` (on any port) or a listed public origin is answered 403, so is an `Origin` that is not that same host, and so is `Sec-Fetch-Site: cross-site`. No response carries a CORS header.

## Container mode (ADR-016)

The container image (work package M0-64, not built yet) sets `APP_RUNTIME=container`. Until it exists you can try the runtime on your own machine with the bundle:

```sh
APP_RUNTIME=container APP_DATA_DIR=tmp/container-data node dist/apps/engine/main.mjs --mode=local --port=8765
```

In container mode the engine binds `0.0.0.0:8765` **inside the container's network namespace** (published traffic arrives there), so exposure is decided by how you publish the port, not by the engine:

```sh
docker run -p 127.0.0.1:8765:8765 -v app-data:/data -v ./secrets:/run/secrets:ro \
  -e APP_KEK_PATH=/run/secrets/kek -e APP_TOKEN_FILE=/run/secrets/token <image>
```

Publish on `127.0.0.1` only. **Do not** use `-p 8765:8765`, `-p 0.0.0.0:8765:8765` or `--network host`: a published port bypasses host firewalls such as ufw, and the token is then the only barrier. The engine prints a banner with the exact `docker run -p 127.0.0.1:HOSTPORT:8765` line before the launch URL.

| Rule | Behaviour |
| --- | --- |
| Token | Always required. `APP_TOKEN_FILE` (a file secret) is the safe form; `APP_TOKEN` works but `docker inspect` can show it; with neither, the engine makes one and prints it in the banner (it is in `docker logs`). |
| Host and Origin | Loopback names on any port (`127.0.0.1:9000`, `localhost:49152`, `[::1]:1`) so a port remap works; every other Host is 403. The Origin must be that Host as an origin. |
| `APP_PUBLIC_ORIGIN` | Loopback-form origins only; its port is the host port the banner and the URL use. A public name (`https://portal.example.com`) is refused until real authentication and https exist (A-12): use an SSH tunnel to the published loopback port. |
| Data and key | `/data` (a volume) holds the database and the lock. `APP_KEK_PATH` names a key-encryption-key file (a path; mount it as a secret). Without one the vault stays locked and stored passwords cannot be used. |
| Healthcheck | `node healthcheck.mjs` (`apps/engine/scripts/healthcheck.mjs`) asks `/healthz` on `127.0.0.1` (`APP_PORT` or `--port`, default 8765) and exits 0 only on `{"status":"ok"}`. |
| Reaching a broker on the host | Use `host.docker.internal` (Docker Desktop) or `--add-host=host.docker.internal:host-gateway` (Linux) as the broker host in the connection. |
| Unknown `APP_*` variable | A usage error (a misspelt setting is not ignored). Set only `APP_RUNTIME`, `APP_HOST`, `APP_PORT`, `APP_DATA_DIR`, `APP_KEK_PATH`, `APP_UI_DIR`, `APP_PUBLIC_ORIGIN`, `APP_TOKEN`, `APP_TOKEN_FILE` and `APP_LOG_LEVEL`. |

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
| Connections | `connections.create`, `bundles.import`, `connections.list`, `connections.get`, `connections.update`, `connections.delete`, `connections.test-http`, `connections.test-amqp`, `bundles.export` | A connection is added with `connections.create` (next section); the page has no form for it yet. `update` and `delete` name a connection, so on a production-classed one they need it armed (see below). |
| Capabilities | `probe.run`, `profile.get` | Read the broker through the management API, build and cache a BrokerProfile in the engine's own database. |
| Explorer | `inventory.query` (queues, exchanges, connections, bindings), `overview.get`, `search.query`, live topic `explorer.window` | Windows are read from an engine-resident index that sweeps in the background and stops when nobody asks; reads only, no message is read. |
| Workspace | `views.list`, `views.create`, `views.delete`, `settings.get`, `settings.put`, `keybindings.get`, `keybindings.put`, `layouts.get`, `layouts.put` | The writes except `layouts.put` run with nothing armed (they declare scope `local`). `layouts.put` names the connection, so on a production-classed one it is refused until the connection is armed. |

Every management request goes through the BrokerScheduler (a per-broker load budget; interactive work pre-empts background sweeps), every socket through the Dialer and the TrustStore, and a stored login is opened for one request and kept in no log or error.

## Add a connection

`connections.create` saves a connection profile in the engine's own database; it needs no arming, because it changes only the engine's state and never a broker (OQ-783). The password is sealed at once and is never returned or logged. Using the token from the URL:

```sh
TOKEN=<the token from the URL>
curl -s -X POST http://127.0.0.1:4310/api/v1/connections \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(date +%s)-lab" \
  -d '{"name":"Lab","envClass":"dev","http":{"host":"127.0.0.1","port":15672,"auth":{"kind":"basic","username":"guest","password":"guest"}},"amqp":{"host":"127.0.0.1","port":5672,"auth":{"kind":"plain","username":"guest","password":"guest"}}}'
```

PowerShell users send the same URL, headers and body with `Invoke-RestMethod`. The answer holds the profile with its `id`; open `/c/<id>/explorer` in the served page, or run `connections.test-http` and `connections.test-amqp` with `{"cid":"<id>"}` to check it. A pasted `amqp://` or `amqps://` URI in the `uri` field works too. Environment class `prod` is allowed: it only makes changes that name that connection need arming.

## The explorer in the served page (M0-54)

After `pnpm nx run engine:serve`, open the printed URL. The left tree lists the overview and the four kinds (queues, exchanges, connections, bindings) of a connection; the same pages are at `/c/<connection id>/explorer`, `/c/<id>/explorer/queues`, `.../exchanges`, `.../connections` and `.../bindings?vhost=%2F`. Each reads through `overview.get`, `profile.get`, `inventory.query` and the `explorer.window` topic. With no connection in the store the pages show the engine's answer for an unknown connection instead of rows, so add one first (next section). Saved views are saved and deleted by the engine without arming anything (they declare scope `local`). What the pages do with rows (windows, filters, sorts, freshness, the capability card) is proved in component specs against fakes and against the real router, not in a browser run.

## What does not work, and why

1. **The page has no form to add a connection yet** (the connections feature, M0-52, is not built). You add one through the engine's API, which is what that form will call (next section).
2. **Anything that names a connection is still locked on a production-classed one.** The router sends no environment class (OQ-283), so every connection counts as production, and `connections.update`, `connections.delete` and `layouts.put` answer **422 `GATE_BLOCKED`** (`prod-lock`, with the fix `ops.arm`) until the person arms that connection (`ops.arm`, 15 minutes). Only an action whose contract declares `scope: 'local'` (it changes only the engine's own state) and that names no connection skips the lock (OQ-783). Because `layouts.put` is still locked, a saved layout is not restored after a restart on an unarmed connection (OQ-529).
3. **The served page and the engine are not yet a usable product.** The shell and the explorer grids are built; the connection form is not (item 1). The Content-Security-Policy nonce of the served page (issue #277) has landed, so the page is styled under the real policy.
4. **Nothing that writes to a broker or reads a message is served.** Peek, publish, source, replay and the broker write ports are not wired (`CAPABILITY_MISSING`, `apps/engine/src/unwired-writes.ts`).
5. **Plans carry no BrokerProfile fingerprint or gates yet:** the executor's `ProfileResolver` is not wired (OQ-764). No served action needs one today.
6. **The diagnostics bundle holds no broker profile** (OQ-765).
7. A broker that answers 401 makes `probe.run` answer 401 `UNAUTHENTICATED` with the broker's reason; this is the action's current mapping and is easy to mistake for the launch token being refused (OQ-768).

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
pnpm nx run engine:it                    # the bundle against a lab broker (Docker): probe, profile, inventory, overview, tests
pnpm nx run engine:serve                 # this page
pnpm nx test engine --testNamePattern="M0-59"   # the local web mode and container mode criteria
```
