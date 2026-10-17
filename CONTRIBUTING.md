# Contributing

Thank you for helping. This project is built mostly by AI coding agents under human review, so the process is explicit.

## Issue-first
- **No work without a GitHub issue** ([ADR-033](docs/adr/ADR-033-github-as-system-of-record.md)). Work packages, spikes, lab cells, ADRs and bugs all start as issues, assigned to a milestone.
- Read the spec with `gh issue view <n>`; branch as `wi/<ID>-<slug>`; open a PR whose body contains `Closes #<n>`.
- Work discovered mid-task becomes a **new issue**, never silent scope creep.

## Conventional Commits
Commit messages (and PR titles, which become the squash commit) follow [Conventional Commits 1.0](https://www.conventionalcommits.org/): `<type>(<optional scope>): <summary>`, for example `feat(engine): add capability probe` or `fix!: reject empty vhost names` (a `!` or a `BREAKING CHANGE:` footer marks a breaking change).

- Types that appear in the changelog: `feat`, `fix`, `perf`, `revert`, `deps`, `docs`. Other types (`chore`, `ci`, `build`, `test`, `refactor`, `style`) are hidden.
- Mention the issue in the body or footer, for example `Closes #6`.

## Releases
The project has **one product version** (SemVer), managed by [release-please](https://github.com/googleapis/release-please) from the Conventional Commit history. A bot-maintained release PR collects the changelog and version bump; merging it is the human release gate. Until milestone M1 every release is an `alpha` pre-release. Nothing is published outside the private repository until the product name is decided ([ADR-029](docs/adr/ADR-029-product-name.md)). Contributors never edit versions or `CHANGELOG.md` by hand.

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
