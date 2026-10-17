---
name: new-adapter
description: Scaffold a new protocol or I/O adapter library behind a port with the adapter generator, including its third-party confinement entry and contract-suite hook. Use when adding an adapter (broker protocol, store, notifier, client) that wraps an npm package.
argument-hint: '<name> --port=<Port> --confine=<npm-pkg>'
---

# /new-adapter

Adapters implement a port and are the **only** place their third-party package may be imported (I-11). Never create an adapter library by hand.

## Availability

The `adapter` generator ships with **M0-08** (issue #8, "Base Nx generators", `tools/generators`). Check first:

```sh
pnpm nx g @app/generators:adapter --help
```

If the command is unknown on your base, stop and say so in the PR.

## Documented command form (execution plan 2.5)

```sh
pnpm nx g @app/generators:adapter <name> --port=<Port> --confine=<npm-pkg>
```

It creates a `type:adapter` library, a port implementation skeleton, a contract-suite hook and the confinement entry. M0-08's acceptance criterion: with `--confine=left-pad` the entry is added and lint rejects `left-pad` everywhere else.

## Steps

1. Confirm the port exists (`ports`, Read/Write split, role-typed leases) and the spec says which package is confined.
2. **Dependency first.** The package must be an exact catalog entry with a `deps-allowlist.json` entry, a clean release-age check and an allowed licence. Those files are protected: write the proposed lines in the PR and ask a maintainer to apply them (AGENTS.md section 4). Do not run `pnpm add` of an unlisted package; `guard-bash` blocks it.
3. Run the generator. Check the confinement entry it added to `eslint.config.mjs` (names and allowed locations) against blueprint 2.4, and that nothing else may import the package.
4. Implement the port. Imports allowed: contracts, pure, ports, and `net-*` only. Never import another adapter or a service. Sockets go through the Dialer (I-9).
5. Hook the library into the shared adapter contract suite (the same suite runs against every implementation of the port). Add the failure paths: timeouts, partial writes, reconnects, bounded buffers (I-6).
6. Keep the README (purpose, public API, invariants, proof commands) the generator created up to date.
7. Verify: `pnpm nx run-many -t lint typecheck test -p <name>`, `pnpm nx run supply-chain:gates`, then `pnpm nx affected -t lint typecheck test build`.
