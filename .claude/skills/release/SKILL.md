---
name: release
description: Prepare and verify a release against the milestone release checklist. Reviews the release-please PR and the tag's CI, and lists what a human must do (signing, notarisation, publishing). Use when asked to prepare, check or cut a release. Never merges the release PR or publishes.
argument-hint: '<milestone or version>'
---

# /release

Releases are cut by **merging the release-please release PR, which is the human gate**. Versions and `CHANGELOG.md` are owned by release-please: never edit them by hand. `.github/workflows/release*.yml`, signing identities and publishing credentials are human-only. You prepare and verify; a maintainer decides and merges.

Until milestone M1 every release is an `alpha` pre-release, and nothing is published outside the private repository until the product name is decided (ADR-029, amendment A-22).

## Steps

1. **Find the release PR.** `gh pr list --search "release-please" --state open`. If none exists, check the `release-please` workflow run; known issue OQ-01 in `docs/open-questions.md` explains the current failure. Do not work around it by tagging or editing versions.
2. **Review the release PR:** version bump is the expected pre-release (`0.1.0-alpha.N` until M1, see OQ-04), the changelog lists the right commits, every `extra-files` target was bumped (`apps/desktop/package.json`, `apps/cli/package.json`, `packaging/helm/product/Chart.yaml`), ADR links resolve.
3. **Run the checklist** in [docs/plan/execution-plan.md](../../../docs/plan/execution-plan.md) section 6 ("Release checklist per milestone") and the milestone delta row. For each line record: done / not applicable yet / blocked, with evidence (a run URL or command output).
   - Conformance: Tier 1 and Tier 2 cells green, matrix regenerated (once the lab exists).
   - Full CI on the tag: `gh run list --branch main` for ci, dco, zizmor, osv-scanner and scorecard; unit, architecture, golden and contract suites; budgets; CodeQL and OSV clean; release-age exclusions reviewed.
   - Packaging per channel as it exists: desktop signing and notarisation, npm provenance, image digests, cosign, SBOM from the esbuild metafile, `fuse-check`, SHA256SUMS and attestations.
4. **Supply chain.** `pnpm nx run supply-chain:gates` is green on all three OSes in CI; every exclusion in `pnpm-workspace.yaml` has an ADR-027 log row and is still needed.
5. **Dry run** when relevant: `pnpm exec release-please release-pr --repo-url=<org>/<repo> --dry-run` (needs a token; do not store one).
6. **Hand over.** Write a checklist comment on the release PR (not an approval): what passed, what is blocked, and the human-only steps that remain (merge the release PR, approve protected environments, sign and notarise, publish the immutable release, bump taps and manifests, post-release smoke within 24 h, rollback plan).

Never: merge the release PR, push tags, publish, edit release workflows, or touch signing environments.
