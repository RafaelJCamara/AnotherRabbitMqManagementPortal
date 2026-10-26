# svc-messages

The messages engine service. M1-09 landed its capture store (MSG-10 core): the engine-side home of messages a person explicitly saves into the local workspace; later work packages add the actions that fill and read it (peek, tap, import, export, templates). M1-19 lands the publish engine (PUB-01, PUB-02): the action `messages.publish`, which sends copies of one message on a dedicated publish lease and reports what the broker did with each, and the publish history with its two reads. The capture store has no action, topic or job and does no broker I/O; the publish action reaches the broker only through the executor's lease.

Tags: `type:service`, `runtime:node`.

## Public API

- `createCaptureStore({ repo, sealer, newId, now?, logger?, options? })` returns the `CaptureStore`:
  - `create(ownerId, { kind, label, target, envClass?, persist, indexBodies?, retentionMs? })`: a **volatile** capture lives in a bounded ring in memory and is never written; a **saved** one is sealed in the database and expires (7 days by default). An unset environment class is `prod`, and `prod` never indexes bodies.
  - `append(ownerId, captureId, messages, { secretValues? })` seals, builds the redacted projection and offers each message to the ingest queue; it returns an `AppendReceipt` (accepted, and refused by reason). `flush()` resolves when everything accepted is written or counted lost.
  - `query(ownerId, { captureId, text?, exchange?, routingKey?, source?, contentType?, redelivered?, sizeMin?, sizeMax?, from?, to?, order?, limit, cursor? })` answers a window of at most 500 with a keyset cursor (I-7). `get` opens one message (properties, headers, and the body up to `maxBodyBytes`), `blob(ownerId, ref, offset, length)` reads a range of a large body (at most 4 MiB a call).
  - `save(ownerId, volatileId)` writes a volatile capture into a saved one; a second call adds only what is new. `remove`, `purgeExpired(limit)`, `list`, `capture`, `volatile`, `stats()`, `close()`.
- `createMessagesModule({ history, sealer, newId, clock, logger })` returns the module the composition root registers (`apps/engine/src/modules/index.ts`): the three actions below, built over one history store, which also purges expired entries once when the module starts.
- `createMessagesPublishAction`, `createMessagesPublishHistoryListAction`, `createMessagesPublishHistoryGetAction`, `createPublishHistory`, `maskMessage`: the pieces `createMessagesModule` assembles, exported for the architecture manifest and the specs.
- `createMemoryCaptureRepository()`, `createMemoryPublishHistory()`, `createFakeSealer()`, `sampleMessage(n)`, `createMessagesFakeDeps()`, `createMessagesFakeModuleDeps()`: fakes for specs. The real repository is `@app/persistence`'s `repos.captures`; the real sealer is `@app/secrets`' `createFieldCipher` (`FieldSealer` of `@app/ports`).

## Publish and its history (M1-19)

| Action | HTTP | What it does |
| --- | --- | --- |
| `messages.publish` | `POST /connections/{cid}/messages/publish` | Sends 1 to 100 copies of one message, one at a time, on one `PublishLease` (confirm channel, always `mandatory`), released exactly once. Each copy is `confirmed`, `nacked`, `returned` (the broker's reply code, for example `NO_ROUTE`), `blocked`, `timeout`, `failed` or `not-sent`; `allConfirmed` is true only when every copy was confirmed. A medium-risk command with optional planning; the prod lock applies. |
| `messages.publish-history.list` | `GET /connections/{cid}/messages/publish-history` | A keyset window (1 to 200, 50 by default, newest first) of the caller's own publishes on that connection, filtered by vhost, exchange, routing-key prefix and time. Plain facts only: no property, header or body. |
| `messages.publish-history.get` | `GET /connections/{cid}/messages/publish-history/{entryId}` | One entry and the data to send it again, with every secret the mask recognised replaced; `masked` names where. |

- **Permission.** The three actions use `messages.publish`; there is no history permission. History is per owner, so only a publisher has any, and `get` returns a stored (masked) message body. The two reads leave no audit row and no receipt (queries); the publish has its attempt and outcome rows and a receipt, none of which holds a body.
- **What is stored (H2, H3).** Plain columns: owner, connection, vhost, time, exchange, routing key, copy count, the per-outcome counts, body size and sha256. One sealed document (the vault's field cipher, `publish_history.data_sealed`, the row id in the AAD): the properties, headers and body **after masking**. The unmasked secret is never written, so nothing can be unmasked later. A locked vault stores nothing; the publish still happened and the answer says `historyRecorded: false`. A body that is not UTF-8 text, or is over 64 KiB, is not kept (`bodyOmitted`; size and sha256 are).
- **The mask has a limit.** It replaces credential keys at any depth, credentialed URIs, secret query parameters, JWTs and bearer values. A secret with no recognisable shape (a bare token in free text, a plain property value) is not caught, so a re-send is a starting point, not a copy. A run of more than 1,024 characters without a space is replaced by `[long]` (OQ-1481 is open).
- **Scope (H4).** The owner is the principal. Another owner's entry, another connection's entry, an expired entry and an unknown id all answer `NOT_FOUND` with one text. History reads do not check that the connection exists: an unknown connection id has an empty history.
- **Retention (H5).** 30 days from the publish. Expired rows are never returned, and are purged (at most 200 a pass) after every write and when the module starts. There is no timer, no way to clear history by hand and no retention setting (OQ-1443, OQ-1448).
- **Recording never changes the publish.** If the row cannot be written, the answer is the same except `historyRecorded: false` and a fixed-text log line (I-13). A call that sent nothing records nothing.
- **In the composed engine** the module is registered, so the two reads work. Writes are not wired yet (OQ-357, OQ-771): `messages.publish` answers `CAPABILITY_MISSING` after the prod lock, until a ConnectionManager is wired. The lab run against a real broker is slice E (`svc-messages:it`, planned).

## How a message is stored (the capture store)

| Part | Where | How |
| --- | --- | --- |
| Body up to 64 KiB | `captured_messages.body_sealed` | AES-256-GCM, fresh nonce, AAD `captured_messages:body_sealed:<id>` |
| Body 64 KiB to 16 MiB | `capture_blob_chunks` | sha256 of the plaintext is the address; 256 KiB chunks, each sealed (AAD `capture_blob_chunks:sealed:<sha256>.<n>`); reference-counted; equal bodies are stored once |
| Body over 16 MiB | not kept | the row says `omitted`, with size and hash, and the capture counts it |
| Properties and headers | `captured_messages.meta_sealed` | one sealed JSON document |
| Routing facts | plain columns | exchange, routing key, source, content type, size, time, hash |
| Searchable text | `meta_text`, `body_text`, the index | the **redacted projection** (below), never the sealed values |

The projection is built from the kernel's redaction (credential keys at any depth, credentialed URIs, secret query parameters, JWTs, bearer values) plus the `secretValues` the caller names, removed in every encoding the canary scanner knows. Outside `prod` it holds the body as text (JSON bodies as keys and values) and the redacted scalar header values; in `prod` it holds metadata and header names only.

## Invariants

- Never imports another service or an adapter; the repository, the sealer and the id source are ports (`@app/ports`) wired by the composition root (blueprint 2.2).
- **No plaintext fallback (I-10).** A locked vault stores nothing and the caller gets `GATE_BLOCKED`. No error, log line or Problem carries a body, a header, a key or a place name.
- **Bounded (I-6, I-7).** The ingest queue and a volatile ring are `BoundedQueue` and `BoundedRing`; windows are at most 500; one seal is at most 256 KiB; hashing and sealing give the loop a turn every megabyte or 3 ms.
- **No silent loss (I-13).** A refused message is in the receipt and on the capture (`droppedQueue`, `droppedQuota`, `droppedLimit`, `omittedBodies`); a ring eviction is `evicted`; a failed write is `lostToError` in `stats()`.
- **Off the main loop (I-5).** The store writes in batches of one transaction each, sized to stay within 5 ms (halved after a slow transaction); on SQLite the repository runs in a worker thread (`apps/engine/src/workers/capture.ts`).
- Any action that stores or reads captures goes through the `ActionExecutor` (I-2) and takes the owner from its principal. The store has no authorisation of its own.
- **Secrets are write-only (I-10).** A publish's body, header values and property values are in no audit row, receipt, log line, Problem or plan preview; the history holds them only after masking, sealed. A lease type is named only in an `implementAction` module or a spec.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p svc-messages
pnpm nx test svc-messages --testNamePattern=capture
pnpm nx test svc-messages --testNamePattern=publish        # the publish action, the mask, the history store, the two reads
pnpm nx test testkit --testNamePattern=publish             # the three routes through the real router
pnpm nx test engine --testNamePattern="M1-19"              # the composed engine serves them; publish is unwired
pnpm nx run contracts:api-docs-check
pnpm nx test testkit --testNamePattern='capture stack'    # the real SQLite file, FTS5 index and AES-GCM cipher
pnpm nx run persistence:it --dialects=sqlite,pg           # the repository contract; pg needs a Docker daemon
pnpm nx run perf:capture-ingest
```

Open questions: OQ-980 to OQ-994 (capture store) and OQ-1438 to OQ-1450, OQ-1481 and OQ-1502 to OQ-1504 (publish) in [docs/open-questions.md](../../../docs/open-questions.md). The working spec of the publish engine is [docs/specs/M1-19.md](../../../docs/specs/M1-19.md).
