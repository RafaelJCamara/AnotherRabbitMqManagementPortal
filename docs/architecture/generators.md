# Nx generators

> M0-08. The plugin is `tools/generators`, imported as `@app/generators`. Run a generator with `pnpm nx g @app/generators:<name> ...`. Agents scaffold with these instead of inventing structure: every project a generator makes already satisfies the workspace rules (tags, module boundaries, confinement, the `@app/*` lint rules), and `pnpm nx test generators` proves it.

## What a generated project looks like

Every generator that creates a project goes through one function (`scaffoldLibrary`), so they all have the same shape:

| File                                                 | Content                                                                                                                                                                       |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project.json`                                       | Tags (`type:*`, `runtime:*`, `trust:critical` when asked) and explicit `lint`, `typecheck` and `test` targets.                                                                  |
| `tsconfig.json`, `tsconfig.lib.json`, `tsconfig.spec.json` | Solution-style, extending `tsconfig.base.json`. `typecheck` is `tsc --noEmit` for libraries (`ngc --noEmit` for UI libraries, so templates are checked).                   |
| `vitest.config.mts`                                  | Hand-written. The Nx Vitest generators refuse Vitest 5 ([S-11](s-11-toolchain-proof.md), OQ-24), so no generator calls them. `resolve.tsconfigPaths` resolves `@app/*` aliases. |
| `README.md`                                          | Purpose, tags, public API, invariants and proof commands (blueprint 2.4).                                                                                                      |
| `src/index.ts` and a spec                            | The public API, and a test that pins it.                                                                                                                                      |
| `tsconfig.base.json` path alias                      | `@app/<project>`, kept sorted.                                                                                                                                                 |

Project names are kebab-case and equal the directory name. Projects live below `apps`, `libs`, `tools`, `testing` or `packaging`: those are the only directories `eslint.config.mjs` scans for confinement zones, so a generator refuses any other place.

## Commands

The forms below are the ones in the [execution plan, section 2.5](../plan/execution-plan.md). Skills and agents use them as written.

| Generator          | Command                                                                                                                                    | Creates                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `library`          | `pnpm nx g @app/generators:library <name> --type=<layer> [--runtime=<r>] [--directory=<dir>] [--import-path=<alias>] [--trust-critical]`   | A library of any layer (`type:*`), with the layer's usual directory and runtime. A runtime the layer cannot have is refused (for example `type:pure` is always `runtime:isomorphic`).              |
| `service-module`   | `pnpm nx g @app/generators:service-module svc-<name> [--trust-critical]`                                                                   | `type:service`, `runtime:node` in `libs/engine/`, in the uniform service shape: `module.ts` (`createXModule(deps)`), `actions/`, `topics.ts`, `jobs/`, `internal/`.                                |
| `adapter`          | `pnpm nx g @app/generators:adapter <name> --port=<Port> [--confine=<npm-pkg>[,<npm-pkg>]]`                                                | `type:adapter`, `runtime:node` in `libs/engine/adapter-<name>`, a port implementation skeleton and the contract-suite hook. With `--confine`, a confinement row (below).                            |
| `ui-feature`       | `pnpm nx g @app/generators:ui-feature <name> --route='/c/:cid/<seg>'`                                                                      | `type:ui-feature`, `runtime:browser` in `libs/ui/feature-<name>`: lazy route, standalone component and an `i18n/en.json` scope.                                                                    |
| `eslint-rule`      | `pnpm nx g @app/generators:eslint-rule <id> [--invariant=<text>] [--paths=libs,apps]`                                                      | A rule and its RuleTester spec in `tools/eslint-rules`, the registration in `src/index.ts`, the `projectRules` entry in `eslint.config.mjs`, a README row and a `tools/lint-selftest` case.        |
| `lint-rule`        | `pnpm nx g @app/generators:lint-rule <id> --severity=<info\|warn\|error> --since=<ver>`                                                    | A broker lint rule (DC-56) in `libs/shared/lint-rules` with fixtures per broker version and a spec that runs them.                                                                                  |
| `decoder`          | `pnpm nx g @app/generators:decoder <framework> --tier=<builtin\|declarative>`                                                              | A header-registry entry and a fixture folder; for `builtin` also a decoder skeleton in `libs/engine/decoders`.                                                                                      |
| `semantics-cell`   | `pnpm nx g @app/generators:semantics-cell --era=<e> --queue-type=<q> --protocol=<p> --action=<a> --cf=<CF-id> [--limit=<l>] [--delayed-retry=<d>]` | A code-derived cell in `libs/shared/semantics`, linked to the conformance id.                                                                                                                      |
| `conformance-cell` | `pnpm nx g @app/generators:conformance-cell <CF-id>`                                                                                       | The lab-cell stub for that id in `apps/conformance`.                                                                                                                                               |
| `migration`        | `pnpm nx g @app/generators:migration <name>`                                                                                               | The next numbered migration (`NNNN_name`) in `libs/engine/persistence`, with its spec.                                                                                                              |
| `action`           | `pnpm nx g @app/generators:action <ns.verb> --module=<svc> --kind=query\|command\|peek\|job --permission=<p> [--http='POST /connections/{cid}/...'] [--risk=<r>] [--planning=none\|optional\|required] [--mcp=none\|read\|mutating] [--cli='...'] [--summary=<text>] [--feature=<ui-feature>\|none]` | An engine action (M0-35): the contract, an `implementAction` factory whose bodies fail, its registrations, a unit spec, an HTTP spec in the testkit, a UI command stub and the plan-purity manifest entry. See [Actions, topics and jobs](#actions-topics-and-jobs). |
| `topic`            | `pnpm nx g @app/generators:topic <ns.name> --module=<svc> --flow=credit\|snapshot-delta --qos=lossless\|latest\|sampled --permission=<p> [--max-hz=<n>] [--ring-items=<n>] [--ring-bytes=<n>]` | A live topic: the contract with a bounded ring, its registrations and a spec that holds it to the kit invariants and the live frames. |
| `job`              | `pnpm nx g @app/generators:job <ns.name> --module=<svc> [--resumable=false]`                                                               | A durable job definition in the module's `src/jobs/`, with a spec that fails until `run()` and `onDrain()` are written. |

Add `--dry-run` to any command to see the files without writing them.

## Actions, topics and jobs

The three generators of M0-35 add to an existing `service-module` (and, for the UI command stub, an existing `ui-feature`); they create no project. Worked examples that the end-to-end test runs verbatim are in [docs/golden-path/](../golden-path/): [`explorer.queues.list`](../golden-path/explorer.queues.list.md) (a query), [`queues.purge`](../golden-path/queues.purge.md) (a two-phase command) and [`tap.messages`](../golden-path/tap.messages.md) (a topic).

- **Checked first, written never half.** Every option is validated before the first file is written, so a refusal leaves the tree untouched. A mutation must state `--risk` and `--planning`; `high` and `critical` must be planned; `--mcp=read` is only for a query; `GET` is only for a query; the path may only use the characters the router accepts; a summary may not call a read of messages non-destructive or read-only (DC-15). The id, the endpoint and every file name must be free: a generator never overwrites.
- **The service shape.** A service module now has `src/deps.ts` (the ports the module needs), `src/testing.ts` (fakes for them, exported as `create<X>FakeDeps`), and `src/actions/index.ts` with `actionFactories` and `createActions(deps)`. An action file exports `create<Id>Action(deps)`; the stub is declared with a typed parameter list and an arrow that ignores it, so that it compiles and lints as it is, and turning it into `(deps) => implementAction(...)` is the only change a port needs.
- **Where the specs live.** The unit spec and its fixture sit beside the action and use the test helpers of `@app/kernel`, because a `type:service` project may not import the `type:test` testkit. The HTTP spec sits in `libs/testkit/src/http/` and builds the engine with `createTestEngine({ actions })`, which is the real router, executor, prod lock, audit and receipts over memory (OQ-320). `engine.arm('c1')` opens the prod lock for the launch-token user, because the router sends no environment class.
- **Tests that fail on purpose.** The stub bodies fail with an `INTERNAL` Problem. The checks that hold whatever the action does (the contract, deny by default) pass at once; the ones that need the action (plan purity, audit and receipt, the HTTP answers) fail until it is written.
- **Registrations.** The contract goes into `libs/shared/contracts/src/registry/index.ts` and `src/index.ts`; the factory into the module's `actionFactories` and its index; one entry into `tools/arch-tests/src/registered-actions.ts`. The committed API documents are not regenerated by the generator: run `pnpm nx run contracts:api-docs`, and `contracts:api-docs-check` fails until you do.
- **Jobs and topics.** A job is made with `defineJob` of `@app/jobs` (M0-31); its stub reaches no port, and its spec runs it against a context whose write ports throw. A topic is a declaration: the live hub (M0-33) owns the provider, and the generated spec carries an `it.todo` for it.

## Rules the generators enforce

- **Tags.** `service-module` always gives `type:service` and `runtime:node`; `adapter` gives `type:adapter` and `runtime:node`; `ui-feature` gives `type:ui-feature` and `runtime:browser`. `--trust-critical` adds `trust:critical`, which marks paths that need human CODEOWNERS sign-off (blueprint 2.1). CODEOWNERS itself is a separate file; add the new path there.
- **Confinement (blueprint 2.4).** `adapter --confine=left-pad` adds `{ names: ['left-pad'], only: ['libs/engine/adapter-<name>'] }` to the `confinement` table in `eslint.config.mjs`. The baseline rule then rejects the import in every other project, and `tools/lint-selftest` still validates the table. A package that already has a row is never widened by a generator: that is a policy change, so edit the table by hand and get it reviewed. The generator also warns when the package is not in `tools/supply-chain/deps-allowlist.json`; the dependency itself still goes through the security lane (exact catalog version, allow-list entry, 3-day release-age gate).
- **Lab evidence is never written.** `conformance-cell` only creates a spec stub with two `it.todo` assertions (live run matches recorded evidence, registry cell matches recorded evidence). Evidence in `testing/lab-evidence/` is recorded by a separate job and committed by a human (I-14). A new semantics cell is `code-derived` with `effect: null` and no evidence; a lookup treats a null effect as a gap and fails closed.
- **Generated code is formatted.** Files are formatted with Prettier using the workspace options before they are written, so `prettier --check .` stays green.

## Libraries that generators create on first use

`lint-rule`, `decoder`, `semantics-cell`, `conformance-cell` and `migration` add to a library that does not exist yet in M0. The first run creates it, with the type definitions the generated code needs (also listed in [core-interfaces](core-interfaces.md)); later runs append. The work package that owns the library adopts it and replaces the stand-in types with the real contracts (OQ-61).

| Generator          | Library                                                                         |
| ------------------ | ------------------------------------------------------------------------------- |
| `lint-rule`        | `libs/shared/lint-rules` (`type:pure`)                                          |
| `decoder`          | `libs/engine/decoders` (`type:adapter`), `libs/sdk/header-registry` (`type:sdk`) |
| `semantics-cell`   | `libs/shared/semantics` (`type:pure`, `trust:critical`)                         |
| `conformance-cell` | `apps/conformance` (`type:test`)                                                |
| `migration`        | `libs/engine/persistence` (`type:adapter`, adopted by M0-21: the generator now only appends migrations) |

## Gotchas

- **Version-like values.** The Nx CLI turns `--era=4.3` and `--since=4.3` into numbers. The generators accept that, but `4.10` arrives as `4.1`: write a release with a patch part (`--since=4.10.0`) (OQ-62).
- **Names.** `service-module demo` and `service-module svc-demo` both give `svc-demo`; the same holds for `adapter-` and `feature-`.
- **Do not run the Nx Vitest or Angular library generators** for workspace projects. They write Vitest 4 and Angular 22.1 ranges (S-11 findings 1 and 2). Use `library`.

## Proof

`pnpm nx test generators` runs two things:

1. `generators:unit`: for each generator, a test on the generated tree (Nx `createTreeWithEmptyWorkspace`) with snapshots of the files, tags and README, plus checks of the edits to `eslint.config.mjs`, `tsconfig.base.json` and the registries.
2. `generators:e2e`: two suites. `generated-projects.spec.ts` copies the policy files, this plugin and the libraries a service compiles against (contracts, kernel, ports) into a temporary workspace, runs every generator through the real `nx g` CLI, then runs `lint`, `typecheck` and `test` on every generated project through its own targets (full lint: module boundaries, confinement and the `@app/*` rules), checks Prettier, and shows that `left-pad` is rejected outside the adapter and a service cannot import an adapter. The temporary workspace is deleted afterwards and the checkout is never touched. Set `GENERATORS_E2E_KEEP=1` to keep it for debugging.
   `golden-path.spec.ts` copies the whole product (router, testkit, architecture tests and the API emitter are real) and runs the pages of [docs/golden-path/](../golden-path/) verbatim: the `sh generate` blocks are the commands, each `file=` block is written over the file it names. It shows the generated tests fail until the work is done (AC-1: a generated action fails with its own "not implemented" Problem while its deny-by-default checks pass, over the unit spec and through the real router), that the API documents are drift until `contracts:api-docs` runs, and that the implemented actions pass lint, typecheck, test and `contracts:api-docs-check` and are Prettier-clean (AC-2). A page that drifts from the generators fails here.

## Adding a generator

1. Create `tools/generators/src/<name>/{generator.ts,schema.json,schema.ts,generator.spec.ts}` and register it in `generators.json` and `src/index.ts`. Write files through `Writer` and projects through `scaffoldLibrary`, and edit existing policy tables with the helpers in `src/shared/` (`appendToArray` parses the file; do not use regular expressions on `eslint.config.mjs`).
2. Add the flags to `schema.json` with the names the skills will use; `src/plugin.spec.ts` pins the flag names of the execution plan.
3. Add the generator to the e2e in `e2e/generated-projects.spec.ts` if it creates a project.
