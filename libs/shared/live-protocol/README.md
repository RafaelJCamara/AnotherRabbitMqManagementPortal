# live-protocol

The pure state machines of the live protocol (ADR-005, blueprint 3.5): credit flow, per-topic QoS outboxes, gap and resume. The engine live hub (M0-33) and the UI live channel (M0-49) drive them; this library does no I/O, starts no timers and reads no clock. Time is an argument (`drain(now)`), so a test, a hub or a browser all behave the same on the WebSocket and on the MessagePort.

Tags: `type:pure`, `runtime:isomorphic`. Imports `@app/contracts` only (frame and `Qos` types).

## Public API

- `Credits`, `MAX_CREDITS` (`credits.ts`): one subscription's balance. `grant` saturates, `consume` throws at zero, so the balance cannot go negative.
- `createOutbox(qos, options)`, `LosslessOutbox`, `LatestOutbox`, `SampledOutbox`, and the types `Outbox`, `OutboxOptions`, `Sized`, `Take`, `Gap` (`outbox.ts`): the per-subscription outbox, bounded by items and bytes.
  - `lossless`: never drops. Items already sent stay (oldest evicted first) so a resumed client can be replayed. If the unsent items alone do not fit, the outbox overflows: one `gap` over every undelivered seq, then a `snapshot`.
  - `latest`: coalesced by key, paced at `maxHz`. With `flow: 'snapshot-delta'` the frames are `snapshot` then `delta` and a bounds hit is a gap plus snapshot; with `credit` flow the oldest key is dropped and counted in `dropped`.
  - `sampled`: every `sampleEvery`-th item, drop-oldest when full, counted in `dropped`; frames carry `sampledEvery`.
- `LiveSession`, `acceptHello`, `DEFAULT_SESSION_LIMITS` and the types `SessionLimits`, `SubSpec`, `TopicResolver`, `Received`, `Drained`, `SubscriptionView` (`session.ts`): one session. `receive(clientFrame)`, `publish(sid, item)`, `publishRemove(sid, key)`, `drain(now)` (frames plus `wakeAt`), `end`, `goaway`, `park`, `resume`, `close`.
- `ResumeRegistry`, `resumeOutbox`, `RESUME_WINDOW_MS`, `DEFAULT_MAX_PARKED` (`resume.ts`): a session survives transport loss for 30 s. `onDrop(id, session, reason)` tells the owner about a session forgotten unclaimed (`expired` or `evicted`) so it can stop what it holds (M0-33).

`SessionLimits` is `{maxSubs: 64, outboxBytes: 8 MiB, maxFrameBytes: 1 MiB}`.

## How the hub drives it

1. `hello` arrives: `acceptHello(registry, new LiveSession({...}), frame, now)`. It returns the session to use and the frames to send.
2. For each later client frame: `session.receive(frame)`; send `frames`; close the transport on `violation`.
3. When a topic produces an item for a subscription: `session.publish(sid, {value, bytes})` (the producer measures `bytes`).
4. After any of the above, and when a timer fires: `const {frames, wakeAt} = session.drain(now)`; send `frames`; arm a timer for `wakeAt` if it is not null.
5. On transport loss: `session.park(registry, now)`.

## Invariants

- No silent loss (I-13). Every seq the producer offered is carried by a frame, superseded by a newer value of the same key (`latest`), skipped on purpose and announced by `sampledEvery`, counted in `dropped`, or inside the range of a `gap` that is followed immediately by a `snapshot`.
- Every buffer is bounded by items and bytes (I-6): per outbox (`TopicDef.ring`), per frame (`maxFrameBytes`), per session (`outboxBytes`, shared by all outboxes), and the registry of parked sessions.
- Every `data`, `snapshot` and `delta` frame consumes exactly one credit; `gap`, `subok`, `end` and the rest do not. A subscription with no credit sends nothing and keeps its items in the outbox.
- `maxHz` spaces the frames of a subscription at least `1000 / maxHz` ms apart; the newest value is never lost, it waits for the next slot (`wakeAt`).
- Dependencies follow the type:pure row of blueprint 2.2; `pnpm nx lint live-protocol` enforces them.

Decisions that are not in the blueprint are open questions OQ-120 to OQ-126 in `docs/open-questions.md`.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p live-protocol
```

The tests are model-based (fast-check commands against a model of what the client must see): AC-1 (lossless overflow and resume), AC-2 (latest topic at 4 Hz), snapshot-delta convergence, credit accounting, and outbox accounting properties.
