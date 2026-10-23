# svc-messages

The messages engine service. M1-09 lands its capture store (MSG-10 core): the engine-side home of messages a person explicitly saves into the local workspace. Later work packages add the actions that fill and read it (peek, tap, import, export, publish, templates); this work package adds no action, topic or job and does no broker I/O.

Tags: `type:service`, `runtime:node`.

## Public API

- `createCaptureStore({ repo, sealer, newId, now?, logger?, options? })` returns the `CaptureStore`:
  - `create(ownerId, { kind, label, target, envClass?, persist, indexBodies?, retentionMs? })`: a **volatile** capture lives in a bounded ring in memory and is never written; a **saved** one is sealed in the database and expires (7 days by default). An unset environment class is `prod`, and `prod` never indexes bodies.
  - `append(ownerId, captureId, messages, { secretValues? })` seals, builds the redacted projection and offers each message to the ingest queue; it returns an `AppendReceipt` (accepted, and refused by reason). `flush()` resolves when everything accepted is written or counted lost.
  - `query(ownerId, { captureId, text?, exchange?, routingKey?, source?, contentType?, redelivered?, sizeMin?, sizeMax?, from?, to?, order?, limit, cursor? })` answers a window of at most 500 with a keyset cursor (I-7). `get` opens one message (properties, headers, and the body up to `maxBodyBytes`), `blob(ownerId, ref, offset, length)` reads a range of a large body (at most 4 MiB a call).
  - `save(ownerId, volatileId)` writes a volatile capture into a saved one; a second call adds only what is new. `remove`, `purgeExpired(limit)`, `list`, `capture`, `volatile`, `stats()`, `close()`.
- `MessagesModuleDeps` and `createMessagesModule(deps)`: the module shell the composition root will register when the first action exists.
- `createMemoryCaptureRepository()`, `createFakeSealer()`, `sampleMessage(n)`: fakes for specs. The real repository is `@app/persistence`'s `repos.captures`; the real sealer is `@app/secrets`' `createFieldCipher` (`FieldSealer` of `@app/ports`).

## How a message is stored

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

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p svc-messages
pnpm nx test svc-messages --testNamePattern=capture
pnpm nx test testkit --testNamePattern='capture stack'    # the real SQLite file, FTS5 index and AES-GCM cipher
pnpm nx run persistence:it --dialects=sqlite,pg           # the repository contract; pg needs a Docker daemon
pnpm nx run perf:capture-ingest
```

Open questions: OQ-980 to OQ-992 in [docs/open-questions.md](../../../docs/open-questions.md).
