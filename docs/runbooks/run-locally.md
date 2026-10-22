# Run the engine locally

How to start the engine in local mode with the web UI it serves, how to get a lab broker with something in it, a first session to walk through with a checklist, and what works today and what does not. Written for a person running the repository, not for a release.

Status of this page: it describes the engine and the web app after the connections pages (M0-52), the explorer pages (M0-54) and the first-run changes of OQ-821 to OQ-823. What each sentence rests on is said where it matters: "seen" means a recorded run in a real browser against a real broker (`libs/ui/feature-connections/README.md`, "A recorded run"); "proved with fakes" means component specs, the real router over in-memory services, or a headless-browser run over a fake data port. **The first-run flow below and the seed helper have not yet been run against a real engine and broker by their author**: the first session is that run. Wording follows AGENTS.md section 1: the product name is a placeholder, and nothing here claims a read of a message is harmless.

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

On the first start the command makes `tmp/engine-data.kek`, a random 32-byte key-encryption key (hex, private to your user), so the credential vault opens without a passphrase (nothing can type one yet, OQ-351). It is a development key: whoever can read that file and the database can read the stored credentials. Delete both to start from nothing (connections, saved views and unlocks are gone with them). Only one engine can use a data directory at a time (a second start refuses with a lock error). A token belongs to one start: after a restart, open the new URL (an old tab answers 401 to everything).

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

## A lab broker with something in it

Needs a Docker daemon. One command starts a lab broker (the digest-pinned image of `testing/broker-lab`, RabbitMQ 4.3.6 by default), fills it, prints what to type into the connection form, and keeps it until Ctrl+C:

```sh
node libs/testkit/src/it/seed-lab.ts                     # 300 queues over 2 vhosts, 6 exchanges each
pnpm nx run testkit:seed-lab -- --queues=2000 --vhosts=3   # the same through Nx, with options
node libs/testkit/src/it/seed-lab.ts --help
```

The first run builds the lab image, which takes a while; later runs can add `--no-build`. The helper reports its plan first (nothing else is created):

| Option | Default | What it does |
| --- | --- | --- |
| `--queues=N` | 300 | Queues in all, spread evenly over the vhosts. A block of ten is seven classic, two quorum and one stream queue (1 to 100000). |
| `--vhosts=N` | 2 | Vhosts to create: `shop`, `billing`, `shipping`, `audit`, then `lab-5` and on (1 to 8). The default vhost `/` stays empty on purpose, so the empty-list state can be seen. |
| `--exchanges=N` | 6 | Exchanges per vhost, cycling direct, topic, fanout and headers (0 to 50), named `ex.<type>.<nn>`. |
| `--bindings=N` | 4 | Queues each exchange is bound to, plus one binding from the first exchange to each other exchange of the vhost (0 to 20). |
| `--version=X.Y.Z` | 4.3.6 | Any version of `testing/broker-lab/versions.json`. |
| `--existing=URL` | | Seed the broker whose management URL you give (with `--user` and `--password`, default `guest`) instead of starting one. Nothing is stopped at the end. |

It imports the definitions through the management API (`POST /api/definitions`, in blocks of 2,500), gives the login a permission on each new vhost (a login sees a vhost's queues only with one), waits until the broker's own queue count has caught up, and then prints a block like this (the ports are chosen by Docker and differ at every start):

```text
Ready. In the app, open "Add a connection" and type:
  Name:                 Lab seed (any name)
  Environment class:    development
  Management host:      127.0.0.1
  Management port:      <printed>
  Management login:     guest / guest
  AMQP host and port:   127.0.0.1 / <printed>   (virtual host / )
  Leave TLS off, and keep "use the same login for AMQP" on.
```

Ctrl+C stops the broker and removes the container (and its volumes). If the process is ever killed without cleaning up, the helper printed the exact `docker rm --force --volumes <name>` line at the start. It creates no message, no connection and no consumer: the Connections list stays empty until a client connects. What is unit-tested without Docker is the command line and the definitions (`libs/testkit/src/it/seed-plan.spec.ts`); that a real broker accepts them, and the Ctrl+C teardown on Windows, are for you to see (OQ-822).

Any other RabbitMQ with the management plugin works too, for example the stock image (management on 15672, AMQP on 5672, login guest / guest):

```sh
docker run --rm -p 127.0.0.1:5672:5672 -p 127.0.0.1:15672:15672 rabbitmq:4.3.6-management
```

and `--existing=http://127.0.0.1:15672` seeds it.

## A first session

Three terminals or tabs: the engine, the broker, the browser.

```sh
# 1. the engine (prints the launch URL)
pnpm install --frozen-lockfile
pnpm nx run engine:serve

# 2. a broker with data (prints the values for the form)
node libs/testkit/src/it/seed-lab.ts
```

Then:

1. Open the launch URL from terminal 1. With no connection, the page says so and links to **Connections**.
2. **Add a connection**, type the values terminal 2 printed. Use the two **Test** buttons under the form first (management API and AMQP): each answers on its own, and the management test also reports the broker's AMQP ports, which the form can fill in. Choose **Add the connection**.
3. The form saves the connection and then probes it once ("Saved. Checking what the broker offers..."), so that the explorer can list it; the page then opens on the connection. If the probe fails, the connection is still saved and its page offers **Check capabilities**.
4. On the connection page: the addresses, "set" for the passwords (never the password itself), the capability card (a row per feature, with the engine's reason for any it cannot offer) and **Open the explorer**.
5. In the explorer: the overview, then the queues, exchanges, connections and bindings from the tree on the left. Entity details (M1-42): press Enter, double-click or right-click a grid row to open that queue, exchange, connection or binding as a tab (Overview, Routing, Config and Consumers show what the inventory carries; the other tabs are listed disabled with their reason); the address (/c/<id>/queues/<key>/routing) survives a reload, and switching connection carries it over when the object exists there.

If a page of the explorer says "This connection has not been checked yet" instead of a list, the connection has no stored capabilities (it was never probed); press **Check capabilities and load** and it loads (OQ-821).

### What to try

Tick off what works; note what does not (the exact words on the screen and the time are the most useful part of a report).

- [ ] **Connections page.** The list shows the new row with its environment strip; The two **Test** buttons (management and AMQP) answer with the broker's product and version, or with a specific cause; the capability card lists the features with reasons.
- [ ] **Overview.** Product and version, totals (queues, exchanges, connections, channels, consumers; a total the broker did not send reads "not reported"), message sums with where they come from, nodes, alarms, the capability card, and the freshness of the inventory the sums rest on. **Refresh** closes for ten seconds after a read; nothing refreshes by itself.
- [ ] **Queues.** About 300 rows in two vhosts; the counts line ("N of M rows"); scroll; sort by a header (one column at a time); filter by name (applies after a pause or on Enter), by queue type (classic, quorum, stream), by virtual host, by state, with or without consumers, minimum messages; the filter chips remove themselves; the **Columns** chooser; select rows and copy.
- [ ] **Freshness banner.** Right after the first open it may say "Loading the inventory: N of about M loaded" until the first sweep finishes; afterwards "Updated <time>". It must never say "no rows" while loading.
- [ ] **Live follow.** The line "Following N rows live." (the engine's `explorer.window` topic). Change a number on the broker (the broker's own management page is at the origin the helper printed) and watch whether the row follows. Proved only with fakes so far.
- [ ] **Exchanges.** The twelve seeded ones plus the broker's built-in ones, by type.
- [ ] **Connections list.** Expected to be empty ("No client is connected to this broker.") unless a client connects; the app's own **Test** buttons open a connection only for a moment, so do not expect to catch one.
- [ ] **Bindings.** Choose one virtual host (`shop` or `billing`); the seeded bindings are among the rows. Bindings are read on demand and are not followed live; the page says so.
- [ ] **The empty vhost.** Filter queues by virtual host `/`: "No rows match these filters" with the chip that causes it. The empty-broker sentence ("This broker has no queues.") shows for a live list with no filter at all, which needs a broker with no queues: start the helper with `--queues=1` and delete it in the broker's page, or point a second connection at an empty broker.
- [ ] **Saved views.** Save the current filters and columns, reload the page, apply it, delete it (a delete asks first). These run with nothing unlocked.
- [ ] **The switcher.** Add a second connection (for example as production, or from a pasted URI); the switcher groups by class and carries the address over to the other connection.
- [ ] **Edit and delete.** Both are refused until you **Unlock** the connection (see below); after the unlock the same action goes through. The unlock is recorded in the audit log and the status bar shows "Unlocked".
- [ ] **Edge states.** Stop the broker (Ctrl+C in terminal 2) and press **Refresh** on the overview: the engine's Problem as sent and, when its code is `BROKER_UNREACHABLE`, a line saying the engine could not reach the broker (not yet seen against a real stopped broker). A connection with a wrong password shows the broker's refusal after the probe or the first read, with a line that names both possible causes (see "What does not work" item 6). Restart the engine and keep the old tab: every call answers 401 until you open the new URL.
- [ ] **Keyboard.** Tab through the filter bar, the grid and the dialogs; a dialog traps focus and Escape closes it.

What was seen in a real browser before this change (recorded in the connections README): the form, both tests against a stock 4.3.6 broker, the create, the probe's twelve steps, the unlock, the edit, the delete after the unlock, the production class, the switcher and the real overview. The grids against a real engine with a real broker, the live follow, the first-run prompt and the probe right after a create have **not** been seen; the grids' speed was measured in a headless browser over a fake data port (`pnpm nx run perf:explorer-ui-20k-browser`).

## What works today

Registered and answering on a running engine (`Engine.served` lists them; the engine test `AC-1` fails if a contract action is neither served nor listed as unserved):

| Area | Actions and topics | Notes |
| --- | --- | --- |
| Meta, arming, diagnostics | `meta.get`, `ops.arm`, `ops.disarm`, `diagnostics.bundle` | |
| Connections | `connections.create`, `bundles.import`, `connections.list`, `connections.get`, `connections.update`, `connections.delete`, `connections.test-http`, `connections.test-amqp`, `bundles.export` | Added in the page (`/connections`) or with `connections.create` (below). `create` declares scope `local` (it changes only the engine's own store), so it runs with nothing unlocked, in any environment class. `update` and `delete` name a connection, so they need it unlocked (below). |
| Capabilities | `probe.run`, `profile.get` | Read the broker through the management API, build and cache a BrokerProfile in the engine's own database. Until `probe.run` has stored one, `profile.get` and `inventory.query` answer 404; the pages handle that (see "A first session"). |
| Explorer | `inventory.query` (queues, exchanges, connections, bindings), `overview.get`, `search.query`, live topic `explorer.window` | Windows are read from an engine-resident index that sweeps in the background and stops when nobody asks; reads only, no message is read. `overview.get` asks the broker directly and needs no stored profile. |
| Workspace | `views.list`, `views.create`, `views.delete`, `settings.get`, `settings.put`, `keybindings.get`, `keybindings.put`, `layouts.get`, `layouts.put` | The writes except `layouts.put` run with nothing unlocked (they declare scope `local`). `layouts.put` names the connection, so it is refused until the connection is unlocked (OQ-784). |

Every command carries an `Idempotency-Key`: the engine refuses a command without one, and the web app's `EngineApi` makes one per call (found in the first browser run, OQ-819). Every management request goes through the BrokerScheduler (a per-broker load budget; interactive work pre-empts background sweeps), every socket through the Dialer and the TrustStore, and a stored login is opened for one request and kept in no log or error.

## Unlock a connection

`connections.update`, `connections.delete` and `layouts.put` name a connection. The router sends no environment class (OQ-283), so the engine treats every connection as production and answers **422 `GATE_BLOCKED`** (source `prod-lock`, fix `ops.arm`) until that connection is unlocked. In the page: **Unlock...** on the connection's page (or **Unlock this connection** in the dialog that shows the engine's refusal), a confirmation, then `ops.arm` for 15 minutes; **Lock again** ends it. The unlock is recorded in the audit log. After a page reload the page reads "locked" even if the engine still holds your unlock (no action reports the state, OQ-793/OQ-530); unlocking again is harmless.

## Add a connection with curl

`connections.create` saves a connection profile in the engine's own database; it needs no unlock. The password is sealed at once and is never returned or logged. Using the token from the URL (a command needs the header `Idempotency-Key`, 8 to 128 characters of `A-Za-z0-9._:~-`, one per call):

```sh
TOKEN=<the token from the URL>
curl -s -X POST http://127.0.0.1:4310/api/v1/connections \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(date +%s)-lab" \
  -d '{"name":"Lab","envClass":"dev","http":{"host":"127.0.0.1","port":15672,"auth":{"kind":"basic","username":"guest","password":"guest"}},"amqp":{"host":"127.0.0.1","port":5672,"auth":{"kind":"plain","username":"guest","password":"guest"}}}'
```

PowerShell users send the same URL, headers and body with `Invoke-RestMethod`. The answer holds the profile with its `id`. A connection made this way has not been probed: either open `/connections/<id>` and press **Check capabilities**, open `/c/<id>/explorer/queues` and press **Check capabilities and load**, or `POST /api/v1/connections/<id>/probe` (no body). `connections.test-http` and `connections.test-amqp` try an endpoint without saving it (`{"draft":{...}}`) or a saved one (`{"cid":"<id>"}`); a failure is an answer with a specific `failure.code` (`HTTP_AUTH_REFUSED`, `HTTP_UNREACHABLE`, `HTTP_NOT_MANAGEMENT`, ...), never a bare error.

## What does not work, and why

1. **TLS trust, tunnels and other login providers are not in the connection form** (M1). The form's TLS flag uses the system's certificate authorities only; a broker with a private authority is answered `TLS_UNTRUSTED`.
2. **Edit, delete and the layout save need an unlock** (above). Because `layouts.put` is still unlock-only (OQ-784, OQ-529), the arrangement of the panels is kept in memory and is not restored after a restart; the shell shows the engine's Problem and a retry. This is the lock behaving as built, not a fault of the page.
3. **No message is read or written.** Peek, publish, source, replay and the broker write ports are not wired (`CAPABILITY_MISSING`, `apps/engine/src/unwired-writes.ts`). The explorer lists objects only; the capability card says what a feature would need.
4. **The grids, the live follow and the first-run flow are proved with fakes** (component specs, the real router over in-memory services, a headless-browser speed run over a fake data port). Whether they behave against your broker is what the first session finds out.
5. **Plans carry no BrokerProfile fingerprint or gates yet:** the executor's `ProfileResolver` is not wired (OQ-764). No served action needs one today. The diagnostics bundle holds no broker profile (OQ-765).
6. **A broker that refuses the stored login answers `UNAUTHENTICATED` (401)**, the same code the engine uses for a bad launch token (OQ-768). The pages show the engine's Problem and a line that names both causes: if the overview or the connection page still opens, it is the broker's refusal (check the login on the connection page); if nothing opens, open the URL the engine printed at its start.
7. **When the first sweep of the inventory fails** (broker down, login refused) the list says "The inventory is not being read" and points at the overview, because the sweep's own Problem is not part of the inventory answer (OQ-823); the overview asks the broker directly and shows its answer.
8. **The Connections list is empty on the seeded broker** until a client connects (above).

## Problems

| Sign | Cause |
| --- | --- |
| `The web app is not built` | Run `pnpm nx build web` (the serve target does it). |
| `DataDirLockedError` | Another engine uses `tmp/engine-data`; stop it or set `ENGINE_DATA_DIR`. |
| `vault":"locked"` in the ready line | The key file is unreadable or does not match the database. Delete `tmp/engine-data` and `tmp/engine-data.kek` together. |
| 401 on every request | The token is from an earlier start. Use the URL of the current one. |
| "This connection has not been checked yet" | The connection has no stored capabilities. Press **Check capabilities and load**. |
| The probe fails with a Problem | Read the Problem as sent and the line under it; the broker's own page at its management origin shows whether the login works. |
| `seed-lab` says it needs a Docker daemon | Start Docker, or give `--existing=<management URL>` of a broker you run yourself. |
| A `broker-lab-...` container is left after a crash | Remove it with the `docker rm --force --volumes <name>` line the helper printed at its start (`docker ps --filter label=io.broker-lab.run` lists them). |
| `HTTP_EGRESS_DENIED` | Not expected in local mode (the egress policy allows all today); report it. |

## Proof commands

```sh
pnpm nx test engine                      # composed engine over fake ports, and the real adapters over loopback
pnpm nx run engine:smoke                 # the bundle as a process
pnpm nx run engine:it                    # the bundle against a lab broker (Docker): probe, profile, inventory, overview, tests
pnpm nx run engine:serve                 # this page
pnpm nx test engine --testNamePattern="M0-59"   # the local web mode and container mode criteria
pnpm nx test testkit --testNamePattern="SEED|FIRST-RUN"   # the seed plan, and the first run through the real router
pnpm nx run-many -t lint typecheck test -p feature-explorer feature-connections   # the pages (first-run, edge states)
```
