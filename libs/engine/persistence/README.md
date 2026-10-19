# persistence

Persistence for the engine (M0-21, ADR-013): [Kysely](https://kysely.dev) over an in-repo `node:sqlite` dialect (desktop and local) and over `pg` (team server), one ordered migration set for both, a backup before migrating and refusal of a newer schema.

Tags: `type:adapter`, `runtime:node`. `kysely`, `pg` and `node:sqlite` are confined to this project (I-11). Imports `@app/contracts` (the `Problem` type and ids) and `@app/ports` (the plan, idempotency, audit and receipt ports it implements); an adapter never imports the kernel.

## Public API

| Area       | Export                                                                          | Notes                                                                                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dialects   | `openSqlite({path, busyTimeoutMs?, readBigInts?})`, `openPg({connectionString, maxConnections?, onPoolError?})` | Each returns a `PersistenceHandle {dialect, db: Kysely<Database>, path, close()}`. SQLite opens in WAL mode with `busy_timeout=5000` and foreign keys on, on one connection serialised by a mutex. Postgres returns `BIGINT` as a number. |
| Helpers    | `columnTypes(dialect)` giving `t.id()`, `t.json()`, `t.epochMs()`, `t.bytes()`  | `TEXT`, `TEXT`, `BIGINT`, and `BLOB` or `BYTEA`. A migration receives them as `db.t`.                                                                                                                                 |
| Migrations | `migrations`, `Migration`, `SqlExecutor`                                        | `0001_core`: `settings`, `connection_profiles`, `blobs`. `0002_plans` (M0-29): `plans`, `idempotency_keys`. `0003_audit_receipts` (M0-30): `audit_events` (append-only: primary key on `seq`, unique `prev_hash`, triggers that reject UPDATE and DELETE, and TRUNCATE on Postgres) and `receipts`. `0004_data_keys` (M0-22): `data_keys`, the wrapped data keys (one active key per purpose by a partial unique index, `CHECK`s on the wrap kind and state, no column that can hold a key in the open). `0005_jobs` (M0-31): `jobs` (sealed `input`, `checkpoint` and `result`, a lease, `attempts`, a `CHECK` on the eight states, `UNIQUE (principal_id, idempotency_key)` and a partial unique index so one running job holds a concurrency key) and `job_events`. A migration is `{id, up(db)}` and calls `db.execute(sql)` once per statement.                              |
| Runner     | `createMigrationRunner({handle, migrations?, backupDir?, now?, correlationId?})` | `{latestVersion, currentVersion(), refuseNewer(), backup(), apply(), migrate()}`. `migrate()` is the start-up sequence.                                                                                              |
| Errors     | `SchemaTooNewError` (carries `.problem`), `MigrationHistoryError`               | `SchemaTooNewError.problem` is a contract `Problem` (`type: urn:problem:schema-too-new`, `code: INTERNAL`). The entry point reports it and exits.                                                                    |
| Repos      | `createRepositories(handle, {now?})` giving `settings`, `connectionProfiles`, `blobs`, `plans`, `idempotency`, `audit`, `receipts`, `dataKeys`, `jobs` | Async ports (`SettingsRepository`, `ConnectionProfileRepository`, `BlobRepository`; `PlanRepository` and `IdempotencyRepository` of `@app/ports`). Lists are keyset-paged and capped (I-7). `plans.update` is a compare-and-set on `version`; `idempotency.claim` is atomic per principal and key. The kernel's `PlanStore` owns the lifecycle and the encryption; this library only stores rows. `audit.append` refuses a row whose `seq` or `prevHash` exists (it returns false, the kernel's chain reads the head and retries); `executeRawStatement(handle, sql)` is for tests and repair tools only (OQ-279). `dataKeys` is the `DataKeyRepository` of `@app/ports`: it stores what a key wrap returned (`insert` returns false when the id exists or the purpose already has an active key), never a key in the open; the cryptography is `@app/secrets`. `jobs` is the `JobStore` of `@app/ports` (M0-31): it stores sealed jobs, claims with `FOR UPDATE SKIP LOCKED` on Postgres, fences every write of a running job by owner and attempt, and writes a `job_events` row in the transaction of each state change; the policy is `@app/jobs`. |

## How the engine starts (ADR-013, A-18)

1. `runner.refuseNewer()`: if the database holds a migration with a higher number than this engine's last one, throw `SchemaTooNewError`. Nothing is changed and no backup is taken.
2. `runner.backup()` (inside `migrate()`): desktop and local only, when a populated database has pending migrations: `VACUUM INTO <db>.v<NNNN>.<epochMs>.bak` next to the database file (or in `backupDir`). Postgres has no backup step here; the team server runs `apply()` in a Helm hook Job under a DDL role and relies on the operator's PITR.
3. `runner.apply()`: every pending migration in **one transaction** (all or nothing), recorded in `schema_migrations`. On Postgres a transaction-level advisory lock serialises concurrent runners. The schema version is the number of the last applied migration.

## Invariants

- **One migration set.** Migrations are plain SQL strings plus `db.t.*`; the same file runs on both dialects. A released migration is never edited (A-18, expand/contract): a change is a new migration. Key columns are `NOT NULL PRIMARY KEY` because SQLite lets a non-integer primary key be NULL.
- **No downgrade across schemas.** A newer schema is refused with a Problem; the remedy is a newer engine or a restore.
- **Async from day one (I-5).** Every repository method returns a Promise, so SQLite can move behind a storage worker if the event-loop SLO fails.
- **Bounded (I-6, I-7).** Repositories never list everything: `list` takes a `limit` (clamped to 1000) and a keyset cursor. The SQLite dialect does not stream.
- **No secrets stored by this library (I-10).** Blob bodies and JSON documents are stored as given; field encryption is `libs/engine/secrets` (M0-22), and the only keys stored here are wrapped (`data_keys`).
- **SQLite binding.** `node:sqlite` binds null, numbers, bigints, strings and bytes; booleans become 0 and 1 and anything else is a `TypeError`.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p persistence
pnpm nx run persistence:it --dialects=sqlite,pg   # needs a Docker daemon for pg (Postgres 16 and 18)
pnpm nx run persistence:it --dialects=sqlite      # no Docker
pnpm nx run persistence:it --dialects=pg --pg-versions=18
pnpm nx run jobs:it --dialects=sqlite,pg          # only the job-store contract (--filter="job store")
```

Test names quote the acceptance criterion they prove (`AC-1`, `AC-2`). The integration tests start `postgres:<version>` through the `docker` CLI (`src/testing/postgres-container.ts`); with `pg` selected and no daemon the run fails, it does not skip.

Open questions: OQ-160 to OQ-166 in [docs/open-questions.md](../../../docs/open-questions.md).
