# svc-ops

The operations engine service. Today it owns one action, `diagnostics.bundle` (M0-69, DC-59): a redacted diagnostics bundle that the engine writes to a local file the person chose. The prod lock's `ops.arm` and `ops.disarm` live in the kernel (`guardrails/ops-actions.ts`), and later operations work (emergency revoke, maintenance freeze) belongs here.

Tags: `type:service`, `runtime:node`, `trust:critical` (CODEOWNERS sign-off).

## Public API

- `createOpsModule(deps)`: returns the `EngineModule` the composition root registers.
- `OpsModuleDeps` (`src/deps.ts`): `diagnostics` (`DiagnosticsSources`: `versions`, `logs`, `profiles`, `audit`, `secretValues`), `files` (a `FileTokenSink`) and `clock`.
- `createOpsFakeDeps(options)`, `createMemoryFileSink`, `createFakeSources`, `createSampleProfile`, `createAuditRow` (`src/testing.ts`): fakes for those ports, for specs, the architecture manifest and the HTTP specs.
- `createDiagnosticsBundleAction(deps)`: `POST /diagnostics/bundle` with `{fileToken, logLines?}`; the answer is `{bytes, sha256, sections, omitted}`, never the content.

## The diagnostics bundle

One JSON document: `format`, `schemaVersion`, `createdAt`, `versions`, `logs` (the newest lines, oldest first, with `held` and `dropped`), `profiles` (a summary of each BrokerProfile), `audit` (the newest rows) and `omitted` (receipts and incidents, which cannot be collected yet, with the reason; OQ-403).

| Layer | What it does |
| --- | --- |
| Allow-list | A profile and an audit row are copied field by field (`summariseProfile`, `summariseAudit`): no user name, node names, URLs, actor, target or detail. A field added to either later is not in the bundle until someone chooses it. |
| Secret values | Every value from `secretValues()` (the launch token) is removed, with its JSON-escaped, percent-encoded, hex and base64 forms, from every string and key, **before** the kernel's redaction, so a redaction that eats part of a secret (a value that contains `?token=...`) does not leave the rest of it behind. |
| Kernel redaction | `scrubJson`: sensitive keys, credentialed URIs, JWTs and bearer values; a string over 2,048 characters becomes a marker. |

Bounds (I-6, I-7): 1,000 log lines by default and 5,000 at most (4 MiB of serialised lines), 50 profiles, 200 audit rows. A cut is reported as `truncated` in the answer, and a log ring that evicted lines reports `dropped` (I-13). The scrub is done in time slices of 5 ms, so a hostile log line cannot hold the event loop (I-5).

## Invariants

- **I-10.** The bundle contains no secret: the tests plant canary secrets (`createCanaryScanner` of `@app/kernel`, which also finds a re-encoded value) in logs, in profiles and in free text, and scan the file the sink received. The answer never carries content.
- **Tokens, not paths.** The service sees an opaque `fileToken` (the contract limits it to `[A-Za-z0-9_-]{16,128}`) and a `FileTokenSink`. An unknown or spent token is `NOT_FOUND`; a sink that fails gives a fixed-sentence `INTERNAL` Problem, so a path in the host's message never reaches the renderer.
- **Audited.** The action is audited `attempt+outcome` (it is a query, OQ-402) and needs `diagnostics.export`.
- Never imports another service or an adapter; cross-service needs are ports wired in the composition root (blueprint 2.2).
- Every mutation is an `implementAction` file in `src/actions/`; nothing writes through a WritePort outside one (mutation funnel). This module's only write is the file sink.

Open questions: OQ-402 to OQ-405 in [docs/open-questions.md](../../../docs/open-questions.md).

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p svc-ops
pnpm nx test svc-ops --testNamePattern=diagnostics
```
