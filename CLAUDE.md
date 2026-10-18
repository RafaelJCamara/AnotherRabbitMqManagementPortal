@AGENTS.md

## Claude Code specifics

Keep this file under 200 lines. Shared rules live in AGENTS.md (imported above); path-scoped rules live in `.claude/rules/` and load when you touch matching files.

- **One WP per worktree.** `git worktree add ../wt/<WP-id> -b wi/<WP-id>-<slug> origin/main`. Land it by rebasing on `origin/main` and pushing to `main` (the maintainer uses no pull requests); never force-push.
- **Spec first.** Read the issue (`gh issue view <n>`) and `docs/specs/<WP-id>.md` if it exists. If neither has Given/When/Then and exact verification commands, run `/wp-spec` and stop for human approval.
- **Scaffold with skills,** never by hand-rolling module structure: `/new-action`, `/new-adapter`, `/new-ui-feature`, `/new-eslint-rule`, `/new-lint-rule`, `/new-decoder`, `/new-semantics-cell`. Workflow skills: `/wp-spec`, `/review-wp`, `/security-lane`, `/release`. If a skill names a generator that has not landed yet (AGENTS.md section 6 says which work package ships it), say so and stop; do not improvise it.
- **Hooks are on.** Every edit is formatted and linted (`post-edit`), protected paths and risky shell commands are blocked (`guard-paths`, `guard-bash`), and Stop runs the affected lint, typecheck and tests (`on-stop`). Fix the cause; never bypass a hook, edit `.claude/settings.json`, or add a `settings.local.json` that disables them.
- **Protected paths are human-only.** When a change needs one (a dependency, a release-age exclusion, CODEOWNERS, lab evidence), write down the exact proposed change in your report (or the issue) and ask a maintainer to apply it.
- **Run commands from the repository root** with absolute or root-relative paths; do not `cd` into subdirectories.
- **Finish** by running the spec's verification commands and pasting their output into the commit message or your report.
- **Reviews** always run in a fresh session with `/review-wp`. Trust-critical WPs also get an adversarial pass with the `security-review` skill.
- **Docs policy.** Never name the third-party product on the banned-terms list (ADR-034), and keep the honest wording rules (AGENTS.md section 1).
