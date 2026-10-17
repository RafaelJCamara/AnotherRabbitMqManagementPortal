# ADR-013: Kysely over node:sqlite and Postgres; one migration set; DDL/DML split

- **Status:** Accepted
- **Date:** 2026-10-16
- **Source:** design panel (final blueprint); see [docs/architecture/blueprint.md](../architecture/blueprint.md)

## Decision

Kysely 0.29.6 runs on an in-repo node:sqlite dialect (WAL, FTS5, better-sqlite3 fallback) and on pg 8.23.1. Migrations are written once with dialect helpers and tested on both dialects. Desktop backs up before migrating and refuses a newer schema. The team server runs migrations in a Helm hook Job under a DDL role. The app role is DML-only, and audit is INSERT/SELECT only.

## Rationale

No native addon on desktop or npx. A table-owning app role could bypass the audit triggers.

## Alternatives considered

Drizzle; PGlite; two migration sets; app-role migrations at startup.

## Consequences

Two dialects run in CI. A storage worker is added only if the I-5 SLO fails.

## Amendments

A-17: audit partitions pre-created by a DDL-role CronJob/pg_partman with a DEFAULT partition. A-18: expand/contract migrations; no helm rollback across schema versions; versioned export formats. See [docs/plan/amendments.md](../plan/amendments.md).
