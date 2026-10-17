---
name: review-wp
description: Review a work-package PR or branch in a fresh session, as the independent reviewer. Re-runs the verification commands and checks the DoD, invariants, module boundaries, honest wording, dependency policy and test strength. Use for "review this PR", "review WP", or before merging any agent change.
argument-hint: '<PR number or branch>'
---

# /review-wp

You are the **reviewer**. Run this in a session that has never seen the writer's context. You do not edit the code under review and you do not approve your own work; a human merges.

## Steps

1. **Load the contract.** `gh pr view <n>`, the linked issue (`Closes #<n>`), `docs/specs/<WP-id>.md` if present. List the ACs and the verification commands.
2. **Get the code** without touching the writer's worktree: `gh pr checkout <n>` in your own worktree, then `pnpm install --frozen-lockfile`.
3. **Re-run verification** yourself: every command in the spec or issue, then `pnpm nx affected -t lint typecheck test build --base=origin/main` and `pnpm nx run supply-chain:gates`. Compare with the output pasted in the PR.
4. **AC to test map.** Each AC has exactly one named test that quotes its id, and that test fails when the behaviour is wrong. Run it, then read it.
5. **Test strength.** For each important assertion ask: would the obvious mutant survive (an inverted condition, a dropped barrier, a swallowed error, a skipped permission check)? Say which mutant you tried and what happened.
6. **Invariants I-1..I-14** (AGENTS.md section 2): does the change touch any? Mutations only through the executor, no version compares, bounded buffers, third-party confinement, secrets write-only, no silent loss, evidence untouched.
7. **Boundaries and structure.** Layer and runtime tags, the uniform service shape, a README per project, generated code not hand-edited, no `eslint-disable` without a linked issue.
8. **Wording and docs.** Honest wording (never "non-destructive" or "read-only" for queue reads), docs policy (ADR-034), docs updated with behaviour, decisions in an ADR.
9. **Dependencies and protected paths.** No new package outside the policy (catalog, exact pin, allow-list entry, ADR-027 log). The diff touches no protected path unless a maintainer made that change (`git diff --name-only origin/main` against `tools/agent-hooks/protected-paths.mjs`).
10. **Size.** At most 800 changed lines excluding generated files, fixtures and evidence, or the `oversize-approved` label.
11. **Trust-critical WPs** (`trust:critical` label or paths in CODEOWNERS): also run the `security-review` skill as the adversarial second reviewer, and state that a human CODEOWNERS approval is required.

## Output

Post one review (`gh pr review <n> --comment --body-file ...`) with: verdict (ready for human approval / changes requested), then findings, each marked **blocking** or **non-blocking** with file and line, the evidence (command output or the mutant you tried) and the fix you expect. Never use `--approve`.
