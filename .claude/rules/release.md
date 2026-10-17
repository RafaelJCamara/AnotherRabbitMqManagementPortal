---
paths:
  - '.github/**'
  - 'packaging/**'
  - 'tools/supply-chain/**'
  - 'pnpm-workspace.yaml'
  - 'release-please-config.json'
---

# Release and supply-chain rules

Applies to CI, packaging, release configuration and the supply-chain gates. Trust-critical: owner review. Source: blueprint 14 and 7.6, ADR-027, execution plan sections 1 and 6.

- **Every GitHub Action is pinned by full commit SHA** with a version comment (`nx run supply-chain:actions-pinned`). Workflows start with `permissions: {}` and grant the minimum per job. zizmor must stay clean.
- **Release workflows are human-only.** `.github/workflows/release*.yml` is a protected path: propose the change, a maintainer applies it. Signing, notarisation and publishing credentials live in protected environments with required reviewers.
- **One product version.** release-please owns versions and `CHANGELOG.md`. Never edit them by hand. The release PR is the human gate; agents never merge it.
- **Release order:** full CI and the conformance gate, build matrix, sign and notarise, regenerate update metadata (`latest.yml`, blockmaps after signing), `fuse-check` and the licence gate, notices and SBOM generated **from the esbuild metafile** (not the lockfile), checksums and attestations, draft then immutable publish.
- **Supply-chain keys in `pnpm-workspace.yaml`** (release-age, trust policy, `blockExoticSubdeps`, `strictDepBuilds`, `allowBuilds`, `overrides`) are human-only. Never weaken the 3-day release-age gate. Exact-version exclusions need an ADR-027 log row and owner approval.
- **New dependency:** exact catalog version, `deps-allowlist.json` entry, licence on the allow-list, no git or tarball source. `pnpm nx run supply-chain:gates` must pass.
- **Security lane (under 24 h):** override plus exact exclusion plus log line (owner-approved), rebuild **every** bundled artefact, conformance smoke, patch release. Use `/security-lane`.
- **Gates self-test themselves:** a change to a gate needs a planted-violation case in its self-test (`gates-selftest`, `actions-pinned-selftest`).
- Mentions of the product name stay as the placeholder until ADR-029 is accepted; nothing is published outside the private repository before then (amendment A-22).
