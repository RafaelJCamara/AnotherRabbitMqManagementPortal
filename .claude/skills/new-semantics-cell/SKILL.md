---
name: new-semantics-cell
description: Add a code-derived cell to the semantics registry plus its linked lab-cell stub with the semantics-cell and conformance-cell generators. Use when a broker behaviour (era x queue type x protocol x action) needs a registry entry. Never sets lab-verified status or writes evidence.
argument-hint: '--era --queue-type --protocol --action --cf=<CF-id>'
---

# /new-semantics-cell

The registry is data tied to independent lab evidence (I-14, ADR-007). An agent adds a **`code-derived`** cell with citations and a CF id, plus a conformance-cell stub that CI will use to record evidence. An agent **never** flips a status to `lab-verified` or `lab-contradicted` and **never** touches `testing/lab-evidence/**` (the `guard-paths` hook blocks it).

## Availability

The `semantics-cell` and `conformance-cell` generators ship with **M0-08** (issue #8, "Base Nx generators"). The registry itself (`libs/shared/semantics`) arrives with M0-11 (core) and M0-12 / M0-13 (data); the conformance app and the lab with M0-14 onwards. Check first:

```sh
pnpm nx g @app/generators:semantics-cell --help
ls libs/shared/semantics
```

If either is missing on your base, stop and say so in your report.

## Documented command form (execution plan 2.5)

```sh
pnpm nx g @app/generators:semantics-cell --era --queue-type --protocol --action --cf=<CF-id>
pnpm nx g @app/generators:conformance-cell <CF-id>
```

Effect: a code-derived cell plus a linked lab-cell stub. Flag values (era, queue type, protocol and action names) come from the generator's `--help` and the registry's types, not from memory.

## Steps

1. The spec names the behaviour, the dimensions (era, queue type, protocol, action, limit state, delayed-retry) and the CF id. Without a CF id and a citation, stop and ask.
2. Gather **citations**: the semantics matrix (`docs/research/semantics-matrix.md`), the fact sheet, release notes or the broker source file and function. A cell without a citation is not allowed.
3. Run `semantics-cell`, then `conformance-cell <CF-id>`. The cell's `status` stays `code-derived` and `evidence` stays empty.
4. Check the neighbouring cells for contradictions; a missing cell must remain a `SemanticsGapError`, never a default.
5. Wording in warnings and docs is honest: "side-effect-aware peek".
6. Verify: `pnpm nx test semantics`, `pnpm nx run semantics:audit-cells --require=citations,conformance`, then `pnpm nx affected -t lint typecheck test`.
7. In the commit message, state that evidence will be recorded by CI (`conformance:record`, amendment A-20) and approved by a human, and request the `lab-evidence` / semantics code owner review.
