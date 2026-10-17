---
name: new-action
description: Scaffold a new engine action (HTTP endpoint, with MCP and CLI exposure and a UI command stub) with the action generator, then implement plan/revalidate/execute. Use when adding an endpoint, command, query, peek or job action to a service module.
argument-hint: '<ns.verb> --module=<svc> --kind=<kind> ...'
---

# /new-action

All mutations and message touches go through the `ActionExecutor` (I-2). An action is one `implementAction(...)` file in a service module; never hand-roll one.

## Availability

The `action` generator ships with **M0-35** ("Action, topic and job generators with golden-path examples"), which depends on the base generators (M0-08), the `ActionExecutor` (M0-29) and the transport (M0-32). It is not part of M0-08. Check first:

```sh
pnpm nx g @app/generators:action --help
```

If the command is unknown on your base, stop and say so in the PR. Do not write the files by hand and do not guess the generator's behaviour.

## Documented command form (execution plan 2.5; the generator's `--help` is authoritative once it exists)

```sh
pnpm nx g @app/generators:action <ns.verb> --module=<svc> \
  --kind=query|command|peek|job \
  --http='POST /connections/{cid}/...' --permission=<p> --risk=<r> \
  --planning=none|optional|required [--mcp=none|read|mutating] [--cli='...']
```

Example: `pnpm nx g @app/generators:action queues.purge --module=svc-admin --kind=command --http="POST /connections/{cid}/queues/{qkey}/purge" --permission=messages.purge --risk=critical --planning=required --mcp=mutating --cli="queues purge"`.

## What it creates (per M0-35 and blueprint section 4)

1. the contract file, added to the registry index;
2. an `implementAction` with `plan` / `revalidate` / `execute` stubs that throw `NotImplemented`;
3. the module registration;
4. a unit spec with testkit fakes (plan purity, deny-by-default, audit attempt and outcome, receipt);
5. an HTTP spec through `createTestEngine().inject`;
6. a UI command stub.

The generated tests fail until the action is implemented. That is intended.

## Steps

1. Confirm the spec (`/wp-spec`) names the action id, kind, permission (from the RBAC catalogue, blueprint 7.3), risk, planning mode and exposure. Use the golden-path examples in `docs/golden-path/` (query `explorer.queues.list`, two-phase `queues.purge`, credit topic `tap.messages`) once M0-35 adds them.
2. Run the generator once. Run `pnpm install` and re-check the catalog if it touched `package.json`.
3. Implement `plan` (reads only; the unit spec enforces it with throwing `WritePort` fakes), `revalidate` (cheap TOCTOU preflight) and `execute` (with the abort signal, deadline and role-typed leases). Errors are Problem objects.
4. Make every generated test pass without weakening it. Add the failure-path cases the spec lists.
5. Verify: `pnpm nx affected -t lint typecheck test` and `pnpm nx run contracts:api-docs-check` (the latter once the contracts kit lands). Paste the output in the PR.
6. A new permission or a mutating MCP exposure makes the WP trust-critical: say so in the PR.
