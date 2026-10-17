# ADR-027 exclusion log

Every exact-version entry in `minimumReleaseAgeExclude` and `trustPolicyExclude` in [pnpm-workspace.yaml](../../pnpm-workspace.yaml) has exactly one row in the table below. `nx run supply-chain:gates` fails (rule `pin.exclusion-unlogged`) when an entry has no row, and (rule `pin.exclusion-not-exact`) when an entry is not `name@x.y.z`. See [ADR-027](ADR-027-supply-chain-gates-with-a-reviewed-release-age-exclusion-lis.md).

## How to add an entry

1. Add the exact `name@version` to the relevant list in `pnpm-workspace.yaml`. Never use ranges, globs or a bare package name.
2. Add one row here: the setting, the entry in backticks, when it was published, why it is needed, and the approver.
3. Once the version is older than the cutoff (3 days) or no longer resolved, remove both the entry and, if you like, mark the row as pruned. A monthly hygiene job flags `minimumReleaseAgeExclude` entries older than 30 days.

Approval is by the maintainer until CODEOWNERS lands (M0-07); after that the manifest files require code-owner review.

Dates are UTC. `Published` comes from the npm registry `time` field.

## Log

| Setting                   | Entry                                     | Published        | Reason                                                                                          | Approved by |
| ------------------------- | ----------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------- | ----------- |
| `minimumReleaseAgeExclude` | `@angular/common@22.2.3`                  | 2026-10-14 23:45 | Angular 22.2.3 is the fact-sheet pin (M0-01, S-11). Younger than 3 days when M0-02 landed.      | maintainer  |
| `minimumReleaseAgeExclude` | `@angular/compiler@22.2.3`                | 2026-10-14 23:40 | Same Angular 22.2.3 release train.                                                              | maintainer  |
| `minimumReleaseAgeExclude` | `@angular/compiler-cli@22.2.3`            | 2026-10-14 23:40 | Same Angular 22.2.3 release train.                                                              | maintainer  |
| `minimumReleaseAgeExclude` | `@angular/core@22.2.3`                    | 2026-10-14 23:41 | Same Angular 22.2.3 release train.                                                              | maintainer  |
| `minimumReleaseAgeExclude` | `@angular/forms@22.2.3`                   | 2026-10-14 23:40 | Same Angular 22.2.3 release train.                                                              | maintainer  |
| `minimumReleaseAgeExclude` | `@angular/language-service@22.2.3`        | 2026-10-14 23:40 | Same Angular 22.2.3 release train.                                                              | maintainer  |
| `minimumReleaseAgeExclude` | `@angular/platform-browser@22.2.3`        | 2026-10-14 23:41 | Same Angular 22.2.3 release train.                                                              | maintainer  |
| `minimumReleaseAgeExclude` | `@angular/router@22.2.3`                  | 2026-10-14 23:41 | Same Angular 22.2.3 release train.                                                              | maintainer  |
| `minimumReleaseAgeExclude` | `@angular/build@22.2.3`                   | 2026-10-15 18:33 | Angular CLI 22.2.3 release train (pinned in the catalog).                                       | maintainer  |
| `minimumReleaseAgeExclude` | `@angular/cli@22.2.3`                     | 2026-10-15 18:34 | Angular CLI 22.2.3 release train (pinned in the catalog).                                       | maintainer  |
| `minimumReleaseAgeExclude` | `@angular-devkit/architect@0.2202.3`      | 2026-10-15 18:33 | Transitive of `@angular/cli` 22.2.3; same release.                                              | maintainer  |
| `minimumReleaseAgeExclude` | `@angular-devkit/core@22.2.3`             | 2026-10-15 18:35 | Angular CLI 22.2.3 release train (pinned in the catalog).                                       | maintainer  |
| `minimumReleaseAgeExclude` | `@angular-devkit/schematics@22.2.3`       | 2026-10-15 18:35 | Angular CLI 22.2.3 release train (pinned in the catalog).                                       | maintainer  |
| `minimumReleaseAgeExclude` | `@schematics/angular@22.2.3`              | 2026-10-15 18:33 | Angular CLI 22.2.3 release train (pinned in the catalog).                                       | maintainer  |
| `minimumReleaseAgeExclude` | `vitest@5.0.5`                            | 2026-10-15 14:29 | Vitest 5.0.5 is the S-11 toolchain-proof pin (catalog).                                         | maintainer  |
| `minimumReleaseAgeExclude` | `@vitest/mocker@5.0.5`                    | 2026-10-15 14:27 | Transitive of `vitest` 5.0.5; same release.                                                     | maintainer  |
| `minimumReleaseAgeExclude` | `@vitest/spy@5.0.5`                       | 2026-10-15 14:28 | Transitive of `vitest` 5.0.5; same release.                                                     | maintainer  |
| `minimumReleaseAgeExclude` | `@astrojs/internal-helpers@0.13.0`        | 2026-10-15 14:45 | Required by the docs site (`@astrojs/starlight` and `astro`, M0-06); no older version satisfies the range. | maintainer  |
| `minimumReleaseAgeExclude` | `@astrojs/markdown-satteri@0.4.4`         | 2026-10-15 14:46 | Required by the docs site (`@astrojs/starlight` and `astro`, M0-06); no older version satisfies the range. | maintainer  |
| `minimumReleaseAgeExclude` | `@astrojs/prism@4.1.0`                    | 2026-10-15 14:45 | Required by the docs site (`astro`, M0-06); no older version satisfies the range. | maintainer  |
| `trustPolicyExclude`      | `@octokit/endpoint@9.0.6`                | 2025-02-14       | Legacy 9.x line pulled by `release-please` (via `@octokit/rest` 20, M0-06). pnpm reports a trust downgrade because newer releases carry stronger trust evidence than this older line. | maintainer  |
| `trustPolicyExclude`      | `semver@5.7.2`                           | 2023-07-10       | Legacy 5.x line pulled by `release-please` (via `conventional-changelog-writer` and `normalize-package-data`, M0-06). Same reason as `semver@6.3.1`. | maintainer  |
| `trustPolicyExclude`      | `semver@6.3.1`                            | 2023-07-10       | Legacy 6.x line pulled by `@babel/core` (via `@nx/js`). The release pre-dates npm provenance, so pnpm reports a trust downgrade against newer majors; it is three years old, so a takeover is not plausible. | maintainer  |

## Not excluded

The 9 transitive packages that were also younger than 3 days when M0-02 landed (`@astrojs/mdx`, `baseline-browser-mapping`, `electron-to-chromium`, `es-module-lexer`, `i18next`, `node-releases`, `qs`, `sync-child-process`, `undici`) were not excluded. The lockfile was moved to the newest mature versions with `pnpm update <names> --depth Infinity`. This is the preferred fix: exclusions are for pins we must have, not for transitive drift.

## Named gate exceptions

These live in `tools/supply-chain` (`licence-gate.ts`, `pin-gate.ts`) with a reason next to each, and are listed here so review sees them in one place. They are separate from the pnpm exclusions above.

| Gate         | Exception                                                                    | Reason                                                                                                                                 |
| ------------ | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| licence      | `elkjs` declared `EPL-2.0` (dev/build and shipped)                           | DC-50 named exception: unmodified ELK worker asset.                                                                                    |
| licence      | `union@0.5.0` declared `Unknown` (dev/build)                                 | `package.json` has no licence field; the shipped `LICENSE` is MIT text. Pulled by `http-server` via `@nx/web`.                         |
| licence      | `@img/sharp-*` declared `LGPL-3.0-or-later` or `Apache-2.0 AND LGPL-3.0-or-later` (dev/build) | sharp prebuilt binaries bundle libvips. Docs-site image tooling pulled by `astro`; build-time only. The shipped gate stays exact DC-50. |
| licence      | `spdx-exceptions` declared `CC-BY-3.0` (dev/build)                           | SPDX exception list data, pulled by `release-please`. Not shipped.                                                                     |
| pin          | `typescript@4.9.5` as a transitive lockfile entry                            | Direct dependency of `release-please`. The catalog and the workspace stay on 6.0.3; any other transitive copy still fails.             |

## Known limits

- The dev/build licence gate reads `pnpm licenses list --json`, which only sees packages installed on the current OS. Packages reachable only through optional dependencies (other platforms' native binaries, wasm fallbacks) are skipped by the coverage check, so the three-OS CI matrix is what covers them.
- The shipped-artefact gate (`checkShippedLicences`) is implemented and self-tested. It has no real input until a build produces the bundled-package list (esbuild metafile, Angular stats, electron-builder file list). Run it with `node tools/supply-chain/run-gates.ts --shipped=<json>`.
