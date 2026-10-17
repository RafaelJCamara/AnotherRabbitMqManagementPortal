# ADR-034: Docs policy (banned terms)

- **Status:** Accepted
- **Date:** 2026-10-16
- **Decided by:** maintainer

## Decision
Project documentation must not reference the specific third-party product named on the project's banned-terms list. This covers docs, `.github`, root Markdown, issue bodies and UI strings. Excluded:
- its name, domain and vendor;
- its pricing and release history;
- screenshots of it.

Research about it is not persisted. What was learned survives only as **unattributed product requirements**: for example, the M1 developer checklist and the "lessons from existing desktop tools" section of the plan.

## Enforcement
- Work package M0-04 adds the banned-terms list and a CI scan in `tools/docs-terms`, which is excluded from its own scan.
- Until then, the scan is run manually before each documentation commit.
- This ADR deliberately does not repeat the terms.

## Consequences
Comparative marketing is avoided. Competitor analysis keeps other named tools where useful.
