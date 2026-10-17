# ADR-027: Supply-chain gates with a reviewed release-age exclusion list and a security lane

- **Status:** Accepted
- **Date:** 2026-10-16
- **Source:** design panel (final blueprint); see [docs/architecture/blueprint.md](../architecture/blueprint.md)

## Decision

pnpm 12.14 is configured with:
- exact catalog pins;
- minimumReleaseAge 4320 (3 days) with strict mode;
- an exact-version minimumReleaseAgeExclude list, each entry recorded in an ADR log with CODEOWNERS sign-off;
- trustPolicy no-downgrade, blockExoticSubdeps, strictDepBuilds and allowBuilds;
- an agent dependency allow-list.
Security lane: an OSV or Renovate alert leads to a pnpm override plus an exact exclusion, then a rebuild of every bundled artefact, then a patch release.

## Rationale

The gate otherwise blocks fixes (fastify 5.12.6/7) and current fact-sheet pins (Spartan 1.7.0, Angular 22.2.3). Bundling bakes vulnerable code into artefacts.

## Alternatives considered

Floating ranges; a release-age gate with no exceptions; lockfile-only notices.

## Consequences

The exclusion list needs a monthly hygiene check, and CODEOWNERS review is a human dependency.

## Amendments

A-19: licence gate split into a shipped-artefact gate and a dev/build lockfile gate. Set minimumReleaseAgeIgnoreMissingTime: false. See [docs/plan/amendments.md](../plan/amendments.md).
