# S-11 toolchain proof (M0-01)

Result of the workspace scaffold: Nx 23.3.0, pnpm 12.14.0, TypeScript 6.0.3, Angular 22.2.3 and Vitest 5.0.5 build and test together. Verified locally on Windows; the three-OS matrix runs in `.github/workflows/toolchain-proof.yml` (replaced by the CI skeleton in M0-05).

## Pins

| Tool       | Version | Where                                       |
| ---------- | ------- | ------------------------------------------- |
| pnpm       | 12.14.0 | `packageManager` in `package.json`          |
| Node       | 24.22.0 | `.nvmrc`; `engines` is `>=24.15`            |
| TypeScript | 6.0.3   | `pnpm-workspace.yaml` catalog (only 1 copy) |
| Nx + @nx/* | 23.3.0  | catalog                                     |
| Angular    | 22.2.3  | catalog (`@angular/*`, `@angular/build`)    |
| Vitest     | 5.0.5   | catalog                                     |

Every dependency is declared once in the catalog with an exact version and referenced as `catalog:`.

## Findings

1. **Generators install Angular 22.1, not 22.2.** `@nx/angular` 23.3.0 writes `~22.1.0` ranges and Vitest 4. The catalog overrides these to the pinned versions; run `pnpm install` after any generator and re-check the catalog.
2. **`@nx/vitest` generators reject Vitest 5 next to `@angular/build`.** Nx assumes `@angular/build` peers on Vitest 4 or below, but 22.2.3 declares `^4.0.8 || ^5.0.0`. The guard only blocks generators, so projects created with `--unitTestRunner=none` get a hand-written `vitest.config.mts` and a `test` target that runs `vitest run`. The Angular app uses `@angular/build:unit-test` (generator option `vitest-angular`).
3. **TypeScript 6 breaks generator output.** `baseUrl` is deprecated (TS5101), so `tsconfig.base.json` has none; `paths` resolve without it under `moduleResolution: bundler`. `verbatimModuleSyntax` requires `import type` in the generated Angular config and routes.
4. **`typecheck` targets are explicit.** `tsc --noEmit` for libraries and the engine, `ngc --noEmit` for the web app so templates are checked.
5. **pnpm 12 blocks dependency build scripts.** `allowBuilds` currently allows only `nx`; M0-02 owns the full supply-chain configuration.
