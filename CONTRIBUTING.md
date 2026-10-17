# Contributing

Thank you for helping. This project is built mostly by AI coding agents under human review, so the process is explicit.

## Issue-first
- **No work without a GitHub issue** ([ADR-033](docs/adr/ADR-033-github-as-system-of-record.md)). Work packages, spikes, lab cells, ADRs and bugs all start as issues, assigned to a milestone.
- Read the spec with `gh issue view <n>`; branch as `wi/<ID>-<slug>`; open a PR whose body contains `Closes #<n>`.
- Work discovered mid-task becomes a **new issue**, never silent scope creep.

## Definition of Done
- Every acceptance criterion (Given/When/Then) maps to a named test, and the issue's verification commands pass.
- Docs in `docs/` are updated in the same PR when behaviour changes; decisions go through an ADR ([docs/adr/README.md](docs/adr/README.md)).
- Honest wording: never call a classic/quorum-queue read "non-destructive"; peeks are "side-effect-aware" (see the fact sheet).
- Trust-critical paths (auth, secrets, peek executor, semantics data, lab evidence, Electron main/preload, release workflows) need code-owner review.

## Sign-off (DCO)
Every commit needs a `Signed-off-by:` line ([Developer Certificate of Origin](https://developercertificate.org/)); we do not use a CLA. Agent-authored commits carry a `Co-Authored-By` trailer; the accountable human adds `Signed-off-by` when approving.

## AI-assisted contributions
Allowed and expected. A human reviews every agent PR; specs must be explicit; agents never write lab evidence (it is recorded by CI only).

## Docs policy
Documentation must not reference the third-party products on the project's banned-terms list ([ADR-034](docs/adr/ADR-034-docs-policy.md)).

## Code of Conduct
See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
