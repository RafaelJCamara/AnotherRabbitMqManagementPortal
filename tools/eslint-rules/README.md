# eslint-rules

Project-specific ESLint rules (M0-04). The plugin is registered as `@app` in `eslint.config.mjs`, so the rule ids are `@app/<rule>`. The `projectRules` table in that file says where each rule applies.

| Rule                        | Guards                    | Applies to                                                                                                    |
| --------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `no-broker-version-compare` | I-3, DC-01                | `libs/**`, `apps/**` except `libs/shared/semantics` and `libs/engine/svc-capabilities`                        |
| `no-mode-branching`         | ADR-001                   | `libs/engine/**`, `apps/engine/**` except `apps/engine/src/{entry,modes,modules}`                             |
| `bounded-buffers-only`      | I-6                       | `libs/engine/**`, `apps/engine/**` except `libs/engine/kernel/src/bounded` and specs                          |
| `explicit-zod-schemas`      | ADR-003                   | `libs/**`, `apps/**`                                                                                          |
| `no-inner-html`             | ADR-021                   | `libs/**`, `apps/**` (TypeScript) and UI templates                                                            |
| `no-direct-fetch`           | UI transport              | `apps/web`, `libs/ui` except `libs/ui/platform`                                                               |
| `honest-wording`            | DC-15                     | i18n JSON (`**/i18n/**`, `**/locales/**`) and UI string literals                                             |
| `ui-no-raw-template-text`   | i18n                      | Angular templates in `apps/web` and `libs/ui` (not `index.html`)                                              |

## Proof

- `pnpm nx test eslint-rules`: a RuleTester spec per rule.
- `pnpm nx test lint-selftest`: lints virtual files at real paths to prove the scoping in `eslint.config.mjs`.

## Notes

- Node loads the plugin as TypeScript (type stripping), so the sources use only erasable syntax and `.ts` import specifiers. There is no build step.
- The rules work on names and AST shapes. They never import zod, semver or Angular, so they work before those packages are installed.
- `package.json` points `main` at `src/index.ts` because Nx treats `tools/eslint-rules` as its workspace-plugin folder and loads it from there.
- Add a rule: create `src/rules/<name>.ts` and its spec, register it in `src/index.ts`, add it to `projectRules` in `eslint.config.mjs`, and add a path-scoping case to `tools/lint-selftest/src/project-rules.spec.ts`.
