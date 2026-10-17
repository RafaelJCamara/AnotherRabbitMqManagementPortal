---
name: security-lane
description: Run the expedited security lane (under 24 h) for a vulnerable dependency or a semantic-correctness bug: triage, reachability, proposed override and exact exclusion for a maintainer to apply, rebuild of every bundled artefact, gates, patch release. Use when OSV-Scanner, Renovate or an advisory reports a vulnerability.
argument-hint: '<advisory id or package@version>'
---

# /security-lane

Follows [docs/runbooks/security-lane.md](../../../docs/runbooks/security-lane.md) and blueprint 14.3. The policy edits are **human-only**: overrides and release-age exclusions in `pnpm-workspace.yaml`, `tools/supply-chain/deps-allowlist.json` and `docs/adr/ADR-027-log.md` are protected paths, and the `guard-paths` hook blocks agent edits to them. Prepare the change; a maintainer applies it. Never weaken the release-age gate.

## Steps

1. **Intake.** Record the advisory (OSV, Renovate, GitHub advisory or private report). Open a private security advisory or a `type:security` issue; link the OSV ids already tracked in `osv-scanner.toml` and `docs/open-questions.md`.
2. **Reachability.** Find where the package is used (`pnpm why <pkg>`): build or docs tooling only, or shipped in a bundle (engine, CLI, desktop, image)? Say which, with evidence.
3. **Choose the fix.** Prefer the smallest exact-version fix: a patched release, or an `overrides` entry. If the patched version is younger than 3 days, an **exact** `minimumReleaseAgeExclude` entry (`name@x.y.z`, never a range) is needed.
4. **Write the proposal** in the issue or PR, ready to paste:
   - the `overrides` / `minimumReleaseAgeExclude` lines for `pnpm-workspace.yaml`;
   - the ADR-027 log row (setting, entry, publish time from the registry, reason, approver);
   - the `deps-allowlist.json` entry if a new direct dependency is involved;
   - the `osv-scanner.toml` ignore to delete once fixed.
   Ask the maintainer to apply the protected-path edits.
5. **After the maintainer's change:** `pnpm install` (never hand-edit `pnpm-lock.yaml`), then `pnpm nx run supply-chain:gates`.
6. **Rebuild every bundled artefact** that could contain the vulnerable code (engine bundle, web, and later the CLI, desktop and image): `pnpm nx run-many -t build`. Bundles bake in the vulnerable code, so a lockfile bump alone is not a fix.
7. **Verify:** `pnpm nx run-many -t build test typecheck lint`; run the conformance smoke when the lab exists; re-run OSV-Scanner locally if available.
8. **Release:** a patch release through release-please (Conventional Commit `fix(deps): ...`). Never edit versions or the changelog by hand. Publish an advisory if users are affected.
9. **Semantic-correctness bugs** (a wrong registry cell) follow this lane too, with the corrected cell and recorded evidence in place of a dependency change.
10. Prune: remove exclusions and OSV ignores as soon as they are no longer needed; a monthly job flags exclusions older than 30 days.

Report: what was vulnerable, reachability, the exact proposal, what you verified, and what remains for a human.
