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
| `src/modules/`           | The modules the engine ships (`meta`, `ops` today) and the factory that gives each its capabilities. Services are added here, in M1.                                  |
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

`desktop` and `local` take the data-directory lock. A listener outside loopback is refused by `composeEngine` itself.

## Invariants

- **ADR-001.** Mode logic lives in `entry/`, `modes/` and `modules/` only. `entry.spec.ts` scans the other files for a mode name, and lint enforces the rule.
- **I-1, T1.** The only listener is `127.0.0.1` in local mode; every request, `/healthz` included, passes the Host, Origin and Sec-Fetch guards, and every route but the health checks and the static UI needs the launch token.
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
pnpm nx run supply-chain:gates
```

Test names quote the acceptance criterion they prove (`AC-1`: local boot, lock, desktop and team; `AC-2`: no mode branching and the metafile).

Open questions: OQ-350 to OQ-359 and OQ-400 to OQ-409 (privacy and egress) in [docs/open-questions.md](../../docs/open-questions.md).
