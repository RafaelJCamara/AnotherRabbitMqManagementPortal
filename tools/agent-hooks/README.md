# agent-hooks

Deterministic guard-rails for coding agents (M0-07). Four Claude Code hooks, wired in [`.claude/settings.json`](../../.claude/settings.json), written as plain Node ESM (`.mjs`): no shell syntax, no dependencies beyond the repository's own `prettier`, `eslint` and `nx`, so they behave the same on Windows, macOS and Linux.

## Protocol

Claude Code runs a hook with one JSON object on stdin (`tool_name`, `tool_input.file_path`, `tool_input.command`, `cwd`, `stop_hook_active`, ...).

- **Exit 0:** continue.
- **Exit 2:** `stderr` is shown to the agent. For `PreToolUse` and `Stop` the action is blocked; for `PostToolUse` the agent sees the message and must fix the cause.
- Any other exit code is a non-blocking error, so the hooks never exit 1 on purpose.

| Hook | Event and matcher | Behaviour |
| --- | --- | --- |
| `guard-paths.mjs` | `PreToolUse` `Edit\|Write\|MultiEdit\|NotebookEdit` | Exits 2 with `human-only path` for protected paths. Fails closed on an unparsable payload. |
| `guard-bash.mjs` | `PreToolUse` `Bash` | Exits 2 for unlisted or unpinned `pnpm add/up`, bulk updates and `--latest`, `--no-verify`, `git push` to main or any force push, global installs. Sees through `bash -c`, `env`, `sudo`, `&&`, `;`. |
| `post-edit.mjs` | `PostToolUse` `Edit\|Write\|MultiEdit` | `prettier --write`, then `eslint --fix --max-warnings=0` on the edited file; exits 2 with what is left. |
| `on-stop.mjs` | `Stop` (timeout 900 s) | Exits 0 when `stop_hook_active` is set or nothing changed. Otherwise runs `nx affected -t lint typecheck test --base=origin/main --parallel=3` (plus `contracts:api-docs-check` when contracts changed and the target exists); exits 2 with a summary on failure. |

Helpers: `lib.mjs` (stdin, root and path handling), `protected-paths.mjs` (the protected-path list, shared by the hook, the tests and AGENTS.md).

## Protected paths

`testing/lab-evidence/**`, `.github/workflows/release*.yml`, `CODEOWNERS` (also under `.github/` and `docs/`), the supply-chain keys of `pnpm-workspace.yaml` (release-age gate, trust policy, build allow-list, overrides; the `catalog` is not protected), `tools/supply-chain/deps-allowlist.json`, `docs/adr/ADR-027-log.md`, and the guard files themselves (`.claude/settings.json`, the hook scripts). Matching is case-insensitive and also catches another checkout's copy of a protected path.

## Proof commands

```sh
pnpm nx test agent-hooks
node tools/agent-hooks/post-edit.mjs < tools/agent-hooks/fixtures/edit.json        # exit 2: no-explicit-any
node tools/agent-hooks/guard-paths.mjs < tools/agent-hooks/fixtures/guard-edit-lab-evidence.json   # exit 2: human-only path
```

## Notes and limits

- The tests use `node --test` (like `tools/supply-chain`). They run the real prettier and eslint on throwaway files in `tools/agent-hooks/tmp-*` (removed afterwards; a crashed run can leave one behind, delete it) and a fake `nx` in a temporary git repository.
- `AGENT_HOOKS_ROOT` points the hooks at another repository root. It exists only so the tests can use a throwaway repository.
- `fixtures/` is excluded from the project's `lint` target (it holds a deliberate lint error); the hooks still lint it, which is what the verification command shows.
- Outside `nx`, `@nx/enforce-module-boundaries` has no project graph and skips itself, so `post-edit` does not check module boundaries; `nx lint` and the Stop hook do.
- The guards are guard-rails against honest mistakes and drifting agents, not a sandbox. `guard-bash` tokenizes the command; it does not execute or expand shell syntax. CODEOWNERS review and CI remain the real controls.
- `.claude/settings.json` runs the hooks as `node "$CLAUDE_PROJECT_DIR/tools/agent-hooks/<hook>.mjs"` so they work when the agent's working directory is a subfolder.
