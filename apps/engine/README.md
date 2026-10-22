# engine

The engine process (M0-36, ADR-001, blueprint 1): one esbuild bundle, `dist/apps/engine/main.mjs`, that runs as the desktop utility process, as the local web server and, from M3, as the team server. It is the composition root: it wires the kernel, the executor, the audit chain, the job runner, the live hub, persistence, the key vault and the transport, and nothing else knows which mode runs.

Tags: `type:app`, `runtime:node`. Trust-critical (blueprint 2.1); it holds the only code that binds a socket, takes the data-directory lock and decides what each mode may do.

```sh
node dist/apps/engine/main.mjs --mode=local --port=0 --data-dir=/path/to/data   # prints the launch URL once
node dist/apps/engine/main.mjs --mode=desktop                                    # the Electron main process sends ctl:init
```

## Layout

| Path                     | Role                                                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`            | Starts `entry/main.ts`.                                                                                                                                               |
| `src/entry/`             | Flags (`args.ts`), the control channel (`ctl.ts`), start (`start.ts`), signals, exit codes and failure lines (`main.ts`), the version (`version.ts`). May name modes.  |
| `src/compose-core.ts`    | `composeEngine(options)`: the wiring, the startup order and the drain phases. Takes a `ModeProfile`; never compares the mode with anything (`@app/no-mode-branching`). |
| `src/modes/`             | `desktop.ts`, `local.ts`, `team.ts`: each builds a `ModeProfile` (storage, key wraps, authenticators, authorisation, listener, job recovery). May name modes.         |
| `src/modules/`           | The modules the engine ships and the factory that gives each its capabilities: `meta`, `ops`, `svc-ops`, `svc-connections`, `svc-capabilities`, `svc-workspace`, `svc-explorer` (issue #278) and `svc-metrics` (M1-26). `EngineModule` carries actions, jobs, live topics and drain phases. |
| `src/broker/`            | The broker-facing ports, built once by `composeEngine` (`createBrokerPorts`): the management client (behind the BrokerScheduler), the target resolver (stored profile, opened login, TrustStore, cached BrokerProfile), the error mapper (`MgmtHttpError` to `AppError`), the Prometheus scrape client with its resolver (`prom.ts`: only the endpoints the cached BrokerProfile lists, the connection login only for provider endpoints) and error mapper, the wire probe and the connection prober. Every socket is the Dialer's. |
| `scripts/serve.mjs`      | The `engine:serve` command: the built engine in local mode with the built web app ([run-locally](../../docs/runbooks/run-locally.md)). Extra arguments go to the engine (`-- --open`). |
| `scripts/healthcheck.mjs` | The container HEALTHCHECK client: `/healthz` on `127.0.0.1`, exit 0 only on ok (M0-59). |
| `src/entry/env.ts`, `src/entry/open-browser.ts` | The `APP_*` environment layer and the `--open` browser opener (M0-59). |
| `src/modes/web-binding.ts` | Host, port, token, public origins and banner of the local web mode, native and container (M0-59). |
| `src/data-dir-lock.ts`   | The one-engine-per-data-directory lock.                                                                                                                               |
| `src/reconcile.ts`       | Reconciliation at start: jobs for real, the other records of blueprint 1.5 as named `pending` steps.                                                                  |
| `src/unwired-writes.ts`  | The write ports of this build: every one refuses until the adapters land.                                                                                             |
| `src/log-tail.ts`        | The newest log lines, in a `BoundedRing`, for the diagnostics bundle (M0-69).                                                                                         |
| `src/data-dir-bundles.ts` | Where a bundle goes in local mode: `<data dir>/diagnostics/bundle-<token>.json`, exclusive create, private, at most 20 files (OQ-404).                               |
| `src/testing/egress-guard.mjs` | The Node preload of the deny-all egress run: it refuses and records every connection, name lookup, datagram socket and child process (OQ-400).               |
| `src/optional-addon-absent.ts` | The build-time stand-in for the optional native add-ons of `ws` and `pg`.                                                                                       |

## Startup order

`lock` (data-dir lock) then `migrate` (refuse a newer schema, back up, migrate) then `vault` (open the data-key vault) then `trust-store` (the CA set of every later outbound connection) then `reconcile` then `listen` (modes that have a socket) then `ready`. Each step is logged with its time; `engine.steps` lists the ones that ran. A failure at any step undoes the earlier ones (socket, database, lock) before it rethrows. `ready` is the `engine.ready` log line and, when a supervisor holds a control channel, `ctl:ready {contract, schemaHash}` (OQ-352).

## Modes

| Mode      | Storage                                   | Key wraps                                          | Authentication              | Listener               | Jobs at start                                  |
| --------- | ----------------------------------------- | -------------------------------------------------- | --------------------------- | ---------------------- | ---------------------------------------------- |
| `desktop` | SQLite in the data dir of `ctl:init`      | `ctl-delivered` (the key main sends, then zeroed)  | per-boot carrier secret     | none (tunnel, M0-34)   | interrupt all running; none resumes by itself  |
| `local`   | SQLite `engine.db` in `--data-dir`        | file KEK (`--kek-file`), keyring (absent), passphrase | the launch token, one UI principal | `127.0.0.1:--port` | interrupt all running; none resumes by itself  |
| `team`    | refuses to start until M3, before it opens or binds anything | | | | |

`desktop` and `local` take the data-directory lock. A listener outside loopback is refused by `composeEngine` itself, except for the container namespace (next section).

## Local web mode and container mode (M0-59, ADR-016)

`--mode=local` is the local web mode. Where it listens and how it is reached is decided in `src/modes/web-binding.ts` (pure, tested without a socket); `src/entry/env.ts` reads the `APP_*` variables with the kernel's `loadConfig` (the placeholder product prefix is `APP`, ADR-029). A flag wins over its variable.

| Flag | Variable | Native (default) | Container (`APP_RUNTIME=container`) |
| --- | --- | --- | --- |
| `--host` | `APP_HOST` | `127.0.0.1`, `::1` or `localhost`; any other value is refused (exit 78) with the SSH-tunnel and container guidance | `0.0.0.0` (default), `::` or loopback; nothing else |
| `--port` | `APP_PORT` | `0` (the system picks) | `8765` |
| `--data-dir` | `APP_DATA_DIR` | required | `/data` |
| `--kek-file` | `APP_KEK_PATH` | optional file KEK | optional file KEK (a path; without one the vault stays locked) |
| `--token-file` | `APP_TOKEN_FILE` (or `APP_TOKEN`) | a made token if absent | a made token if absent (printed in the banner) |
| `--public-origin` | `APP_PUBLIC_ORIGIN` | loopback-form origins only (A-12) | loopback-form origins only; sets the host port in the banner |
| `--open` / `--no-open` | - | `--open` opens the default browser (default: no) | refused: there is no browser |
| `--ui-dir` | `APP_UI_DIR` | the web build next to the bundle | the same |
| `--log-level` | `APP_LOG_LEVEL` | `info` | `info` |

Container mode is the one exception to "no bind outside loopback" (DC-36): the bind is the container's own namespace, so the wildcard is not a LAN exposure; what is exposed is decided by `docker run -p 127.0.0.1:HOSTPORT:8765`. The mode file sets `listener.containerNamespace`, and `composeEngine` accepts a non-loopback host only with that flag **and** an authenticator. The token is always required; the Host allow-list is the transport's (loopback names on any port plus the listed public origins, exact match); the Origin must be that Host as an origin. A non-loopback `PUBLIC_ORIGIN` is refused until real authentication and https exist (A-12). The banner (console only, before the launch URL) prints the exact `docker run -p 127.0.0.1:...` line and the publishes the docs forbid. The HEALTHCHECK is `node healthcheck.mjs` (`scripts/healthcheck.mjs`, copied into the image by M0-64): it asks `/healthz` on `127.0.0.1` and exits 0 only on `{"status":"ok"}`.

`--open` never puts the token on a command line: the engine writes a private one-page redirect file in a fresh temporary directory (`src/entry/open-browser.ts`), gives the platform opener (`rundll32`, `open`, `xdg-open`) that file's path, and removes the file after 30 s. A browser that cannot be opened is a warning; the URL is still printed.

## Invariants

- **ADR-001.** Mode logic lives in `entry/`, `modes/` and `modules/` only. `entry.spec.ts` scans the other files for a mode name, and lint enforces the rule.
- **I-1, T1.** The only listener is `127.0.0.1` in local mode (or the container namespace of ADR-016, with the token mandatory); every request, `/healthz` included, passes the Host, Origin and Sec-Fetch guards, and every route but the health checks and the static UI needs the launch token.
- **I-8.** Services get the management API only as `scheduleMgmtRead(adapter, scheduler)` with its errors mapped to Problems; the raw adapter is handed to nothing else. A draft endpoint tried by `connections.test-*` has no connection id and is read once on its own client.
- **I-10.** A stored login is opened by the resolver for one request (a locked vault, or a credential sealed for another row, fails closed with `GATE_BLOCKED` before any request) and is in no log line, error or cache.
- **Guardrails are not wired around.** The prod lock, arming and the authorizer are the kernel's and the mode's; a command that names no connection and does not declare `scope: 'local'` still answers 422 `GATE_BLOCKED` on a running engine; the ones that do declare it (`connections.create`, `bundles.import`, `views.create`, `views.delete`, `settings.put`, `keybindings.put`) run with nothing armed (OQ-783), and a command that names a connection is locked until it is armed.
- **I-2.** Actions run through the `ActionExecutor`; the write ports it hands them refuse (`CAPABILITY_MISSING`) until an adapter is wired.
- **I-12, no phone-home.** The bundle starts and serves with nothing configured and makes no outbound connection: `egress.smoke.spec.ts` runs it under the egress guard for 15 s in `engine:smoke` and for 10 minutes in `engine:egress`, and fails on any connection, name lookup, datagram socket or child process. It also fails if an analytics, crash-reporting, tracing or updater package is bundled. The guard covers the JavaScript surface; a network-less container run is the second layer (OQ-400).
- **I-10.** The launch token is printed once to the console (the URL fragment is never sent to a server) and is in no log line; a delivered data key is zeroed after the vault used it; a failed start prints a reason and a safe detail, never a message of an unknown error.
- **I-13.** Reconciliation that is not done is announced as `pending` in the ready line, never reported done.
- **Fail closed.** A newer schema, a key that does not open the stored one, a second engine on the data directory and an unreadable lock stop the start and leave the database, the lock and the socket as they were.
- **Shutdown.** SIGINT, SIGTERM and `ctl:shutdown` run the `DrainCoordinator` (gate, jobs, flush within 2 s by default), then close the socket, the database and the lock, then exit 0; a stuck drain exits 1 after its budget plus 3 s.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p engine
pnpm nx build engine          # dist/apps/engine/main.mjs and meta.json
pnpm nx run engine:smoke      # the bundle as a process: local and desktop start, lock refusal, team refusal, metafile, egress guard
pnpm nx run engine:egress     # the same egress soak for 10 minutes (EGRESS_SOAK_SECONDS=600)
pnpm nx run engine:it         # the bundle as a process against a lab broker; needs a Docker daemon (libs/testkit/src/it/engine.it.ts)
pnpm nx run engine:serve      # build the engine and the web app, start local mode, print the launch URL
pnpm nx run engine:serve -- --open   # the same, and open the default browser at the launch URL
pnpm nx test engine --testNamePattern="M0-59"   # the web-mode and container-mode criteria (no build needed)
pnpm nx run supply-chain:gates
```

Test names quote the acceptance criterion they prove (`AC-1`: local boot, lock, desktop and team; `AC-2`: no mode branching and the metafile). `compose-services.spec.ts` and `broker/*.spec.ts` quote the criteria of [M0-ENGINE-WIRING](../../docs/specs/M0-ENGINE-WIRING.md) (the service modules on the composed engine, the real adapters over loopback).

Open questions: OQ-350 to OQ-359 and OQ-400 to OQ-409 (privacy and egress), and OQ-764 to OQ-771 (what the composition root wires and what it leaves unwired) in [docs/open-questions.md](../../docs/open-questions.md).
