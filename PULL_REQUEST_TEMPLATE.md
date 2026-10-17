## Summary

<!-- What changes and why, in a few lines. -->

Closes #<!-- issue number; ADR-033: no work without an issue -->

## Acceptance criteria

<!-- One line per Given/When/Then from the issue, with the test or command that proves it. -->

- [ ]

## Verification

<!-- Paste the commands from the issue's Verification section and their result. -->

```sh
pnpm nx run-many -t build test typecheck
```

## Checklist

- [ ] The PR title is a [Conventional Commit](CONTRIBUTING.md#conventional-commits) (it becomes the squash commit and drives the release notes).
- [ ] Every commit has a `Signed-off-by:` line (DCO). Agent-authored commits also carry a `Co-Authored-By:` trailer.
- [ ] A human has reviewed any AI-generated changes.
- [ ] Docs under `docs/` are updated for any behaviour change; decisions go through an ADR.
- [ ] No new dependency, or it is exact-pinned in the `pnpm-workspace.yaml` catalog and referenced as `catalog:`.
- [ ] No lab evidence was written by hand (CI records it).
- [ ] Trust-critical paths touched (auth, secrets, peek executor, semantics data, lab evidence, Electron main/preload, release workflows) are called out for code-owner review.
