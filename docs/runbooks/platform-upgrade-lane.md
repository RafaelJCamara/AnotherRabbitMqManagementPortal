# Runbook: platform upgrade lane (~10% of capacity)

| Platform | Target |
|---|---|
| Electron (from M2) | Within 4 weeks of each stable major. Only the latest 3 majors are supported |
| Angular / TypeScript | Within one month of GA. Angular 23 is expected around June 2027; move to TypeScript 7 only once Angular supports it |
| Node | Move the container and team images to Node 26 well before Node 24 reaches EOL (2028-04-30) |
| Nx, fastify | Nx 24 and fastify 6 as they land, each through an ADR-gated issue |

For every bump:
1. Open an issue.
2. Run the conformance suite and the deny-all egress E2E.
3. Check the bundle budgets.
4. Update the pins and the docs.

## Automation (M0-76, amendment A-25)

Step 1 no longer depends on someone noticing a release.

| Piece | What it does |
|---|---|
| [`platform-upgrade-lane.yml`](../../.github/workflows/platform-upgrade-lane.yml) | Runs on Mondays and on demand. Compares the pinned set with the registries and opens one `lane:platform` issue for each new stable major (Node, pnpm, Nx, Angular, TypeScript, Vitest, ESLint, Electron, fastify). It needs no GitHub App and no secret. A manual run is a dry run unless you clear `dry_run`; a run on any branch but the default one is always a dry run. |
| [`tools/platform-lane`](../../tools/platform-lane/README.md) | The detection and issue logic, with `node --test` self-tests (`pnpm nx run platform-lane:test`). `platforms.json` lists the pinned set, the runbook target of each platform and its compatibility checks. |
| [`platform_upgrade.yml`](../../.github/ISSUE_TEMPLATE/platform_upgrade.yml) | The issue form for a bump the workflow does not open, with the same checklist as the automatic issues. |
| [`renovate.json`](../../renovate.json) | Groups the packages of each platform, labels them `lane:platform` and sends their majors to the dependency dashboard for approval. Inactive until the Renovate GitHub App is installed (OQ-43). |

Rules the automation follows:

- It reads the pins from the repository (the pnpm catalog, `.nvmrc`, `packageManager`) and never copies them. Electron and fastify are not installed yet, so `platforms.json` carries their planned pin until the catalog has them.
- It proposes only a version older than `minimumReleaseAge` in `pnpm-workspace.yaml` (3 days). It never adds an exclusion; that stays a maintainer decision (ADR-027).
- Only even Node majors count. Odd majors are never promoted to LTS.
- It checks the `engines` and `peerDependencies` that packages publish to npm and puts the result in the issue. A failing check is a first filter, not a verdict. One check blocks: TypeScript 7 gets no issue until the latest `@angular/compiler-cli` accepts it, which is the rule in the table above.
- An issue is opened once per platform and major, open or closed. Closing it records the decision; the lane does not ask again until the next major.
- Steps 2 to 4 stay with the person who takes the issue. The conformance suite and the deny-all egress E2E are still planned work packages, so until they land the issue asks for the check to be recorded by hand.
