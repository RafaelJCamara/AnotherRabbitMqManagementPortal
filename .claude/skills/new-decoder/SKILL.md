---
name: new-decoder
description: Add a dead-letter decoder for a messaging framework (built-in or declarative) with the decoder generator, including its header-registry entry and fixture folder. Use when supporting a new framework's failure and retry message format in the DLQ centre.
argument-hint: '<framework> --tier=builtin|declarative'
---

# /new-decoder

Decoders turn a framework's failed message into a `NormalizedFailure` and a replay plan (blueprint 11). They are **data first**: most frameworks are pure entries in `header-registry.json` interpreted by the declarative decoder; code is needed only for body envelopes and fingerprints.

## Availability

The `decoder` generator ships with **M0-08** (issue #8, "Base Nx generators"):

```sh
pnpm nx g @app/generators:decoder <framework> --tier=builtin|declarative
```

Documented effect (execution plan 2.5): a decoder skeleton, a header-registry entry and a fixture folder. The `decoders` library, `header-registry` and the DLQ service arrive with later work packages; check `pnpm nx g @app/generators:decoder --help` and `ls libs` first, and stop if they are missing on your base.

## Steps

1. Choose the tier: **builtin** (first-party code, runs in the worker pool with resource limits) or **declarative** (a manifest interpreted by the engine; timeout-safe regex engine and a JSONPath subset). Prefer declarative.
2. Sources of truth: `docs/research/framework-failure-formats.md` and the fixtures you can obtain from the framework's own tests or a fixture app. Never copy proprietary code or guess header names.
3. Run the generator once, then fill the header-registry entry: header mappings, queue naming conventions and delay-infrastructure patterns.
4. Fixtures first: real failure messages (headers and body) from the framework, one folder per version, including retry-delayed and poison cases. Tests assert the normalised output exactly.
5. **Never deserialise** pickle or PHP-serialised objects; show them as an opcode disassembly or tokens. Output is text only.
6. Copied `x-delivery-count` and framework retry counters need care: strip by default on replay unless the spec says otherwise (uncertainty U-19).
7. Respect limits: input <= 16 MiB, output <= 4 MiB of JSON, 250 ms per call for builtin decoders.
8. Verify: `pnpm nx run-many -t lint typecheck test -p decoders`, then `pnpm nx affected -t lint typecheck test`. Tests quote the AC id.
