# Runbook: backup and restore

**Container**
1. Stop the container. SIGTERM drains held deliveries first.
2. Back up the `/data` volume, and the KEK separately.
3. To restore, put both back, then start the container.

The engine refuses a database schema newer than its own binary. Use "export everything" before downgrading.

**Team server (M5)**
- Back up Postgres. Audit-chain anchors are stored outside the database.
- Never `helm rollback` across schema versions; restore from a backup instead.
- A nightly restore drill runs in CI.
