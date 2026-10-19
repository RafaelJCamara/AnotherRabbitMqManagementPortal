---
name: new-action
description: Scaffold a new engine action (HTTP endpoint, with MCP and CLI exposure and a UI command stub) with the action generator, then implement plan/revalidate/execute. Use when adding an endpoint, command, query, peek or job action to a service module.
argument-hint: '<ns.verb> --module=<svc> --kind=<kind> ...'
---

# /new-action

All mutations and message touches go through the `ActionExecutor` (I-2). An action is one `implementAction(...)` file in a service module; never hand-roll one.

## Availability

The `action` generator shipped with **M0-35** ("Action, topic and job generators with golden-path examples"), together with `topic` and `job`. Check that your base has it:

```sh
pnpm nx g @app/generators:action --help
```

If the command is unknown on your base, stop and say so in your report. Do not write the files by hand and do not guess the generator's behaviour.

## Documented command form (the generator's `--help` is authoritative)

```sh
pnpm nx g @app/generators:action <ns.verb> --module=<svc> \
  --kind=query|command|peek|job \
  --http='POST /connections/{cid}/...' --permission=<p> --risk=<r> \
  --planning=none|optional|required [--mcp=none|read|mutating] [--cli='...']
```

Example: `pnpm nx g @app/generators:action queues.purge --module=svc-admin --kind=command --http="POST /connections/{cid}/queues/{qkey}/purge" --permission=messages.purge --risk=critical --planning=required --mcp=mutating --cli="queues purge"`.

## What it creates (blueprint section 4)

1. the contract file (`libs/shared/contracts/src/registry/<id>.ts`), added to the registry and exported from `@app/contracts`;
2. `create<Id>Action(deps)` in the module's `src/actions/`: an `implementAction` whose `plan` / `revalidate` / `execute` stubs fail with `INTERNAL`, listed in `src/actions/index.ts`;
3. a unit spec and its fixture beside it (contract, plan purity, deny by default, audit attempt and outcome, receipt) over `@app/kernel` test helpers;
4. an HTTP spec in `libs/testkit/src/http/` through `createTestEngine().inject` (a service project cannot import the testkit);
5. a UI command stub in the module's feature (`--feature`, or `none`);
6. an entry in the plan-purity manifest of `tools/arch-tests`.

The generated tests fail until the action is implemented. That is intended. It refuses a mutation without `--risk` and `--planning`, a high or critical action that is not planned, a mutating command presented as an MCP read tool, GET on anything but a query, and it never overwrites a file.

Its sibling generators are `topic` (a live topic, `docs/golden-path/tap.messages.md`) and `job` (a durable job definition in a module).

## Steps

1. Confirm the spec (`/wp-spec`) names the action id, kind, permission (from the RBAC catalogue, blueprint 7.3, `area.verb`), risk, planning mode and exposure. Read the matching golden path in `docs/golden-path/`: query `explorer.queues.list`, two-phase `queues.purge`, credit topic `tap.messages`.
2. Run the generator once, then `pnpm install` if it touched `package.json`.
3. Describe the real input and output in the contract, and give the fixture a value for every new required field.
4. Implement `plan` (reads only; the unit spec runs it against write ports that throw), `revalidate` (cheap TOCTOU preflight) and `execute` (with the abort signal; writes only through `ctx.writes`). Name the ports the action needs in the module's `src/deps.ts` and give them fakes in `src/testing.ts`. Errors are Problem objects.
5. Make every generated test pass without weakening it. Add the failure-path cases the spec lists.
6. `pnpm nx run contracts:api-docs`, then verify: `pnpm nx affected -t lint typecheck test` and `pnpm nx run contracts:api-docs-check`. Paste the output in the commit message.
7. A new permission or a mutating MCP exposure makes the WP trust-critical: say so in your report.
