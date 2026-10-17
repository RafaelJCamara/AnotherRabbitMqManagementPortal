# VERIFIED FACT SHEET — open-source RabbitMQ management & developer tool (as of 2026-10-16)

> Canonical verified facts (source-read, not yet lab-tested). This document wins over every pre-verification research doc. Content about a specific third-party product was removed under the docs policy ([ADR-034](../adr/ADR-034-docs-policy.md)).

**Legend.** Verdicts: ✓ confirmed · ✗ refuted · ~ nuanced (corrected statement given) · ? unverifiable. Confidence: H/M/L. Basis: **S** = source read at an exact tag, **D** = official docs, **RN** = release notes, **GH** = issue/PR, **R** = registry/API data, **M3** = third-party measurement, **ED** = re-checked by the editor in this pass. **Nothing here was lab-tested.** Every runtime claim is code- or doc-derived until the conformance matrix runs.

**URL shorthands.** `RS@tag:path` = https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/<tag>/<path> · `WEB:path` = https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/<path> · `RN x.y.z` = RS@main:release-notes/x.y.z.md · `QQ` = quorum queue, `CQ` = classic queue, `SAC` = single active consumer, `AC` = acquired_count, `DC` = delivery_count, `L` = effective delivery limit in QQ machine state.

---

## 0. Contradictions between agents, and how each was resolved

| # | Contradiction | Resolution (which evidence wins, and why) |
| --- | --- | --- |
| 0.1 | Does `PUT /api/vhosts/{v}` without `default_queue_type` keep the vhost's default queue type? One agent said it resets it (X4); another said only DQT is preserved (V12). | **It resets (ED, S, H).** At v4.3.6, `rabbit_vhost:put_vhost` calls `update/5`, which calls `vhost:new_metadata(D, T, undefined)`. That **injects `default_queue_type => rabbit_queue_type:default_alias()`** (vhost.erl L216-219). `update_metadata` strips DQT only when it is `<<"undefined">>`, `<<>>`, `null` or `nil`. `metadata_merger` keeps the current value only when the new one is `undefined`, a case this path never reaches. So DQT is overwritten with the node default, and description and tags become empty. V12 read the merger in isolation. Also: `tracing:false` calls `rabbit_trace:stop` on the serving node, and an omitted `tracing` does nothing (rabbit_vhost.erl@v4.3.6 L486-491). Runtime untested. |
| 0.2 | Does `/api/auth` exist in 4.2 and later? | **No (ED, S, H).** The dispatcher has `{"/auth", rabbit_mgmt_wm_auth}` at v4.1.8 L216. At v4.2.9 and v4.3.6 only `/auth/attempts/...` and `/auth/hash_password/...` remain. OAuth settings are published only via the unauthenticated `/js/oidc-oauth/bootstrap.js`, which calls `rabbit_mgmt_wm_auth:authSettings()`. 4.2.9 and 4.3.x add the server-side token proxy `/js/oidc-oauth/token-endpoint/:id`. The client-secret leak (≤4.2.8, ≤4.3.2) therefore goes through `bootstrap.js` on 4.2/4.3, and through `/api/auth` on ≤4.1. |
| 0.3 | Were delayed-retry policy keys available in 4.3.0? | **Arguments `x-delayed-retry-*` arrived in 4.3.0. Policy keys are accepted only from 4.3.1 (ED, RN 4.3.1 L52 "delayed retry-related policy keys are now accepted in policy definitions").** The 4.3.0 code already reads policies via `args_policy_lookup` (rabbit_quorum_queue.erl@v4.3.0 L1890-1899), but policy validation rejected the keys. |
| 0.4 | Default stream-browsing path: the stream protocol (tap agent), or AMQP (auth, engine and managed agents)? | **AMQP first.** Use our own rhea AMQP 1.0 adapter on 4.0+, and AMQP 0-9-1 `x-stream-offset` as the fallback and on 3.13. The stream protocol is an optional fast path once probes show it works. Why: `rabbitmq_stream` is not enabled by default; 5552 is often unreachable (managed services, tunnels, Kubernetes, with unresolvable advertised hosts); Amazon MQ has no streams at all; the project decision makes the stream client optional. |
| 0.5 | Peeking 4.3 QQs: server-side HTTP `/get` (competitors agent) or AMQP (semantics agent)? | **AMQP `basic.get` on an engine-owned dedicated connection is primary.** It allows the post-acquire guard: inspect `x-delivery-count` before returning, then stop or rescue a message that the return would drop. HTTP `/get` nacks every message automatically, so on 4.3 it drops over-limit arrivals and on 4.0-4.2 it spends budget. It also holds all bodies in handler memory with no server cap. The crash-isolation benefit is small because the engine already runs outside the browser. HTTP `/get` stays a fallback only (ackmode `ack_requeue_true`, count ≤50, full preflight). |
| 0.6 | Connections: "one dedicated connection per peek job" or "a single pooled connection per broker"? | **A small set of connections per broker profile, each with one role:** control, peek, publish/replay, consume/tap/stream. **At most one in-flight peek job per peek connection**, because connection-level errors (540, internal_error, frame errors) kill every channel, and on 4.3 the held QQ deliveries then become failed deliveries. Budget against the probed or provider limits (CloudAMQP shared allows 20/100 connections; Amazon MQ 4.x allows 10 consumers per channel). |
| 0.7 | QueueLens measured QQ returns going "to the back" on 3.13 and 4.1. Code says HEAD when a limit is set. | **Code wins provisionally (S, H).** TAIL happens only when the QQ is **unlimited** (3.13 with no limit; 4.0-4.2 with L = -1). QueueLens refuses QQs that have a limit, so its measurements were presumably on unlimited queues, which is consistent. Lab cell required. |
| 0.8 | Passive-declare permissions on 4.3. | Merged: 3.13.7, 4.0.9, 4.1.8 and 4.2.0-4.2.5 do **no check**; **4.2.6 and 4.3.0 require configure**; **4.2.7+, 4.3.1+, v4.4.x and main require any one of read, write or configure** (S, H). |
| 0.9 | Amazon MQ: "browse streams over AMQP" (auth agent) or "no streams" (managed agent)? | **No streams.** AWS: "Currently, Amazon MQ does not support streams." Hide the stream browser, and confirm with a probe. |
| 0.10 | Is the coders51 AMQP 1.0 JS client "official"? | ~ It is listed on WEB:client-libraries/amp-client-libraries.md among the libraries "the RabbitMQ team supports". The devtools page lists no Node client with the ✓ mark. Either way, its defects (§m) keep it out of the production path. |
| 0.11 | What does `x-delivery-limit = -1` do on 3.13? | **It drops or dead-letters on the first return (ED, S, H).** RS@v3.13.7 rabbit_fifo.erl L159 keeps the raw value (no conversion of negatives); rabbit_quorum_queue.erl L315 merges argument and policy with `min/2`; `return_one` (L1847-1863) discards when `DeliveryCount > DeliveryLimit`, so 1 > -1. An unset limit is `undefined`, and an integer is never greater than an atom in Erlang term order, so it never drops. "-1 means unlimited" holds only from 4.0. |
| 0.12 | Era detection relies on a `rabbitmq_4.3.0` feature flag. Does it exist? | **Yes (ED, S, H).** rabbit_core_ff.erl@v4.3.6 L223-227: `'rabbitmq_4.3.0'`, stability **stable** (not required). `rabbitmq_4.0.0`, `rabbitmq_4.1.0` and `rabbitmq_4.2.0` are **required**. A 4.3 cluster can therefore run with `rabbitmq_4.3.0` disabled. |
| 0.13 | Can the QQ machine version be seen over HTTP? | **Partly (ED, S, M).** `GET /api/queues/quorum/{v}/{q}/status` (vhost access) returns a "Machine Version" for each member. From 4.0.9 that value is `rabbit_fifo:version()` of **that node's code** (`key_metrics_rpc` override; 8 on 4.3.6). It is a per-node capability signal, not proof of the effective Raft machine version. On 3.13.7 it comes from Ra key metrics. A canary QQ remains the definitive test. |
| 0.14 | Stream header fidelity depends on the read protocol? | **No: streams lose them at write time (ED, D, H).** WEB:docs/conversions.md L44-46: streams store every message AMQP 1.0-encoded, whatever protocol published it. L156: AMQP 0-9-1 header values that are **arrays or tables** (keys without `x-`) are **not converted**, so streams drop them at write time on every read path. CQs and QQs store the original format and convert only when a different protocol consumes. |
| 0.15 | Does consumer timeout count toward the QQ limit? | It counts on 3.13 (when a limit is set) and on 4.0-4.2, because the channel is closed. **It does not count on 4.3+**: `return_multiple(..., false)` increments AC only (S, H). |
| 0.16 | Do Warren ("RabbitMQ 4 no longer counts a put-back"), Queue Studio ("never counts") and the dev.to table ("reject goes to the back") hold? | **True only on 4.3+, and incomplete even there (S, H).** See §b. |

---

## (a) RabbitMQ versions & support policy

| Series | Latest OSS GA (GitHub date) | Community end | Commercial end (indicative) | Status 2026-10-16 | Metadata store | Tool tier |
| --- | --- | --- | --- | --- | --- | --- |
| 3.13 | 3.13.7 (2024-08-26) | 2024-09-30 | 2029-12-31 | commercial only | Mnesia (Khepri experimental, no upgrade path) | Tier 2 |
| 4.0 | 4.0.9 (2025-04-14) | 2025-04-30 | **2026-09-30 (ended)** | fully unsupported | Mnesia default, Khepri opt-in (`khepri_db`) | Tier 3, best effort |
| 4.1 | 4.1.8 (2026-01-22) | 2026-01-31 | 2027-04-30 | commercial only | as 4.0 | Tier 2 |
| 4.2 | **4.2.9** (2026-07-20). 4.2.10 (2026-08-17) and 4.2.11 (2026-09-16) appear on release-information but return GitHub 404, so they are commercial-only | 2026-07-31 | 2030-06-30 | commercial only; OSS frozen at 4.2.9 | Khepri default for new deployments | Tier 1 |
| 4.3 | **4.3.6** (GitHub 2026-09-14; page says 16 Sept) | 2027-01-31 | 2028-04-30 | community-supported, current | **Khepri only**; upgrade only from 4.2.x with required flags | Tier 1 |
| 4.4 / 5.0 | none: `4.4.0-alpha.<sha>` (v4.4.x branch) and `5.0.0-alpha.<sha>` (main) from rabbitmq/server-packages. `4.3.7-alpha` exists, with draft notes | — | — | development | Khepri | nightly CI, allowed to fail |

Sources: https://www.rabbitmq.com/release-information ; https://api.github.com/repos/rabbitmq/rabbitmq-server/releases ; https://api.github.com/repos/rabbitmq/server-packages/releases ; RN 4.0.1 L12-13, RN 4.2.0 L106-133, RN 4.3.0 L81-131 (✓ H).

**Other version facts (all ✓ H, S).**
- QQ machine versions: ≤7 on 4.0-4.2; **8** on 4.3.x (`rabbit_fifo.erl@v4.3.6 L1255 version() -> 8`); 9 on main.
- Feature flags: `rabbitmq_4.0.0`, `4.1.0` and `4.2.0` are required; `rabbitmq_4.3.0` is stable, not required (ED).
- Unknown builds (4.2.10/4.2.11, Tanzu) may carry backports. **Treat them as 4.0-4.2 semantics** until conformance-tested. The public `v4.2.x` branch head (2026-10-14) still checks `acquired_count` (S, H).

**Version-specific hazards to encode as data (S/RN/GH, H).**

| Affected | Hazard | Fixed in |
| --- | --- | --- |
| 3.13 → 4.2.4 | With stats off, queues lack `policy`, `operator_policy`, `effective_policy_definition` and `delivery_limit` (#15182) | 4.2.5 / 4.3.0 (#15651) |
| ≤4.3.5 (and OSS 4.2.9) | `/api/channels[/{ch}]` returns **400** with stats off or with `?disable_stats=true` | 4.3.6 (#17198) |
| 4.2.6, 4.3.0 | Passive declares need configure permission | 4.2.7 / 4.3.1 |
| 4.3.0 | A topic binding with key `""` receives `""` publishes from *any* topic exchange | 4.3.1 plus feature flag `topic_binding_projection_v5` |
| 4.3.0-4.3.5 | Deleting an exchange that is an E2E destination of a consistent-hash exchange leaves a stale ring bucket: **silent loss**, and no `binding.deleted` event (#17255) | 4.3.6 (#17257) |
| 4.3.0-4.3.6 | Shovel reject loop (destination rejects are treated as non-failed returns) | 4.3.7, untagged (#17794) |
| 4.3.0+ | Non-described `rabbitmq:stream-*` AMQP 1.0 filters are silently dropped (`amqp_filter_set_bug` is denied by default; removed on main) | config `deprecated_features.permit.amqp_filter_set_bug=true` |
| 4.3.0-4.3.2 | `consumer_timeout = undefined` hits the assertion `true = is_integer(MS)`, failing consume/get | 4.3.3 (falls back to 24 h) |
| 4.1.4+ (all versions for description/tags) | A vhost PUT without DQT resets the DQT, description and tags (0.1) | — |
| ≤4.2.7, ≤4.3.1 | CORS accepts unvalidated request headers and `Origin: *` | 4.2.8 / 4.3.2 (#16544) |
| ≤4.2.8, ≤4.3.2 | Unauthenticated OAuth settings leak `oauth_client_secret` | 4.2.9 / 4.3.3 |
| ≤4.2.9, 4.3.0-4.3.2 | HTTP access log records OAuth users as `oauth_client_id` | 4.3.3 only (4.2 backport not merged) |
| v4.3.0-4.3.6, main | `canonicalize_delivery_limit` guard `is_integer(V) orelse V < 0` makes tick reconciliation ignore delivery-limit drift. Event-driven policy changes still apply. | open; worth reporting upstream |

**4.3 denials, behaviour at v4.3.6 (S, H).**
- A transient non-exclusive `queue.declare` fails with a **connection-level** `internal_error`.
- `x-queue-master-locator` gives `internal_error`, and the policy key is rejected.
- `basic.qos global=true` is **silently downgraded** to per-consumer.
- AMQP address v1 links are refused.
- CQv1 arguments (`x-queue-mode`, `x-queue-version=1`) are rejected.
- `ram_node_type` is removed.
- Permitting any of these requires `deprecated_features.permit.*` on **all** nodes.

---

## (b) Message-safety semantics

### b.1 Counters as clients see them (S, H)

| Version | AMQP 0-9-1 | AMQP 1.0 |
| --- | --- | --- |
| 3.13 | `x-delivery-count` = DC; `redelivered` = DC > 0 | the plugin maps settlements onto 0-9-1 methods |
| 4.0-4.2 | **`x-delivery-count` = AC** (the limit counter); `redelivered` = AC > 0 (rabbit_fifo_client.erl@v4.2.9 L241-258) | header `delivery-count` = DC, so 1.0 clients **cannot see** the budget |
| 4.3+ | `x-acquired-count` = AC; `x-delivery-count` = DC (absent while 0); `redelivered` = AC > 0 | `delivery-count` = DC |

**Header stamping.** QQs stamp these headers only on messages already returned at least once (`add_delivery_count_header`). A client-copied `x-delivery-count` therefore survives to the next delivery, so replays must strip it (S, M; lab).

### b.2 QQ version × settle-action matrix (S, H; RS tags v3.13.7, v4.0.0/4.0.9, v4.1.0/4.1.8, v4.2.0/4.2.9, v4.3.0-4.3.6, main)

Each cell shows: counters changed → counts toward L? → position.

| Action | 3.13 | 4.0-4.2 | 4.3+ / main |
| --- | --- | --- | --- |
| `basic.nack(requeue=true)`; AMQP 1.0 `released`; HTTP `/get ack_requeue_true` | DC+1 → counts only if L set (no default) → **TAIL if no limit**, HEAD if a limit is set | AC+1 → **counts** (default L=20; dropped or dead-lettered on the (L+1)th return) → HEAD, **TAIL if L=-1** | AC+1 → **no**, *unless DC is already > L* (then dropped or DLX'd now) → HEAD (priority ignored); DELAYED if delayed-retry is `all`/`returned` |
| `basic.reject(requeue=true)`; `modified(df=true, uh=false)`; HTTP `reject_requeue_true` | as nack (the 1.0 plugin maps `released` and `df=true` to reject(requeue)) | same `requeue` op as nack (`modified` → `#modify`, HEAD even when L=-1) | AC+1, DC+1 → **counts** → HEAD/DELAYED (`all`/`failed`) |
| `modified(df=false, uh=false)` | **plugin maps it to `basic.reject(requeue=false)`: DLX or drop (destructive)** | AC+1 → counts → HEAD; annotations merged | AC+1 → no (unless DC>L) → HEAD/DELAYED; `x-opt-delivery-time` honoured |
| `rejected`; `modified(uh=true)`; `nack/reject(requeue=false)` | DLX `rejected` or drop | AC+1, DC+1 → DLX/drop | same; DC is carried into a QQ DLQ (b.4) |
| Graceful `channel.close` / `connection.close` / AMQP 1.0 session end **while holding deliveries** | DOWN → DC+1 | DOWN → AC+1, DC+1 (counts) | **DOWN → AC+1, DC+1: a *failed* delivery that counts** (channel `terminate` notifies only CQ pids) |
| TCP loss / crash | as close, once detected (heartbeat; default 60 s) | same | same |
| Intra-cluster partition (`noconnection`) | immediate return, DC+1 | immediate, AC+1, DC+1 | `suspected_down`; after `consumer_disconnected_timeout` (60 s) AC+1 only |
| `basic.cancel` alone | returns nothing; deliveries stay settleable; the later close behaves as above | same | same |
| AMQP 1.0 detach with unsettled deliveries | n/a | `remove` → AC+1 → counts → HEAD | `remove` → AC+1 → no → HEAD |
| Consumer timeout | channel-level (global 1,800,000 ms, evaluated about every 60 s) → 406 close → counts | same → counts | QQ-level: `return_multiple(false)` → AC+1 → **no**. Then `basic.cancel` (if the client advertises `consumer_cancel_notify`, as amqplib does) or a 406 close; `basic.get` deliveries always get the 406 close; AMQP 1.0 gets `released` |
| HTTP `reject_requeue_false` / `ack_requeue_false` | DLX/drop / removed | same | same |

Evidence: `rabbit_fifo.erl@v4.2.9` L1954-1957 (`AcquiredCount > DeliveryLimit`) and `incr_msg/3` L3097-3111; `@v4.3.6` `return_one` L2348-2398 (`DeliveryCount > DeliveryLimit`), `incr_msg_headers` L3884-3899, `maybe_return_all` L1954-1972, consumer timeout L721-794; `rabbit_channel.erl@v4.2.9` `internal_reject` L1976-1985 (nack ≡ reject); `@v4.3.0` L1478-1486 (first split); `rabbit_amqp_session.erl@v4.3.6` L2129-2160; v3.13 plugin `rabbit_amqp1_0_session_process.erl@v3.13.7` L296-326; quorum_queue_SUITE `subscribe_redelivery_policy` @v4.2.9 (nack-based drop test). Docs: WEB:docs/quorum-queues/index.md and versioned_docs/version-4.2.

**Limit configuration nuances (S, H).**
- The default L=20 applies to QQs declared on 4.0+, or to older queues after any policy event. A 3.13-era QQ upgraded in place **stays unlimited** until a policy event, which then silently applies the effective limit.
- Policy merge: if either value is negative the larger wins, otherwise the minimum. -1 means unlimited only on 4.0+. **On 3.13, `x-delivery-limit=-1` drops on the first return (0.11).**
- Policy `delivery-limit` changes reach existing QQs through events on 3.13 and 4.0-4.2. #16035/#16036 only touch tick reconciliation, and that change is neutralised by the `orelse` bug.
- **Read the real L from `GET /api/queues/{v}/{q}` → `delivery_limit`** (machine state, `unlimited` or an integer; 4.0+; missing with stats off before 4.2.5).

### b.3 Classic queues (S, H)

- **Position:** a requeue returns the message to its **original SeqId position** with `redelivered=true`.
- **Limit:** none. `delivery-limit` is in `unsupported_policies`.
- **4.3+ failure counter:** incremented by reject, `modified(df=true)`, channel down and AMQP 1.0 detach. It is exposed only as the AMQP 1.0 `delivery-count`.
- **The 1.0 plugin on 3.13** maps `modified(df=false)` to reject(requeue=false), which is destructive.
- **Hazards after every requeue:** `maybe_drop_head` and `drop_expired_msgs` run, so returned messages at the head are dropped or dead-lettered first (`maxlen`/`expired`).
- **No consumer timeout from 4.3.0**, so held messages stay held until the client settles them or the connection ends. On ≤4.2 the timeout is channel-level, 30 min.
- **`basic.get`** ignores SAC and consumer priority and resets the `x-expires` idle timer.

### b.4 Dead-letter count carry-over (S, H; M3)

- **On 4.3.0-4.3.6 and main:**
  - `annotate_msg` copies DC and AC into annotations for both DLX strategies.
  - The target QQ seeds its header DC from them (`maybe_set_msg_delivery_count`, L2032-2044).
  - `return_one` checks DC > L on **every** return.
  - So a message dead-lettered for `delivery_limit` from a default-L source arrives with DC=21. In a default-L QQ DLQ, its **first return of any kind** (nack peek, released, `/get` Nack, timeout, close) drops it, or re-dead-letters it if the DLQ has a DLX.
- **Safe configurations:** DLQ L = -1, or L ≥ max(source L)+1, or a CQ or stream DLQ.
- **Publishers cannot inject DC** (`mc_amqp:essential_properties`).
- **On 4.0-4.2** the limit uses AC, which is not carried, so the DLQ grants a fresh budget of L. **3.13** has no carry-over code.
- **M3:** on 4.3.6, 21 abandoned deliveries led to `x-delivery-count 21` in the DLQ, and one `get`+nack emptied it: https://dev.to/viktorbaumann/your-quorum-dead-letter-queue-can-drop-the-dead-letters-x-delivery-count-travels-along-240n

### b.5 Delayed retry and consumer timeout on 4.3 (S, H)

**Delayed retry.**
- Arguments: `x-delayed-retry-type` = `disabled` (default) | `all` | `failed` | `returned`; `x-delayed-retry-min` (ms, required to enable); `x-delayed-retry-max` (defaults to min).
- Policy keys `delayed-retry-*`: **from 4.3.1**.
- Precedence: the policy's type beats the argument; an operator policy wins the type; `max()` applies to min and `min()` to max.
- Delay = `min(min × max(1, DC), max)`. A nack does not raise DC, so nack-peeks are delayed by about min each time.
- While delayed, a message is invisible to consumers, `basic.get` and the CLI peek. It still counts toward max-length and shows in `messages_delayed` / `next_delayed_at`.
- Separately, an AMQP 1.0 `modified` outcome carrying `x-opt-delivery-time` delays redelivery (4.3.0). Delayed **publish** is 4.4/main (#16583).

**Consumer timeout.**
- Default is 1,800,000 ms on every version.
- 4.3+: evaluated only by QQs. Resolution order: consumer argument `x-consumer-timeout` (or AMQP 1.0 `rabbitmq:consumer-timeout`), then min(queue argument, policy), then the global value.
- `undefined` no longer disables it (4.3.0-4.3.2 crash; 4.3.3+ 24 h). The docs claim that "undefined disables" is wrong for 4.3 (✗ M).
- main adds `consumer_timeout_response = notify_consumer | close_channel`.
- The global value is not visible over HTTP except via admin-only `/api/config/effective`.

### b.6 Streams, management `/get`, CLI peek (S, H)

**Streams.**
- `basic.get` → `{protocol_error, not_implemented}`, a **connection-level 540** that kills every channel on the connection.
- Settling only grants credit.
- Reading is non-destructive, except that *named* stream-protocol consumers store offsets and join SAC groups.

**Management `POST /api/queues/{v}/{q}/get`** (identical at v3.13.7-main):
- Opens a direct connection as the HTTP user and runs `basic.get` × Count, **holding all messages in handler memory**.
- Then settles each one individually:
  - `ack_requeue_true` → `basic.nack(requeue=true, multiple=false)`;
  - `reject_requeue_*` → `basic.reject`;
  - `ack_requeue_false` → auto-ack (destructive).
- **No server cap.** The UI defaults to count 1, truncate 50000, "Nack message requeue true".
- #13060 is an unconfirmed OOM report.
- If the handler dies mid-request, the held messages take the DOWN path (on 4.3 that counts; unverified).

**`rabbitmq-queues peek <q> <pos>`** is the **only side-effect-free CQ/QQ read**:
- QQ only: CQs return `classic_queue_not_supported`.
- Implemented as a Ra aux command, so no Raft write.
- Ready messages only: unacked, delayed and DLX-pending messages are invisible.
- Positional, with O(pos) cost.
- Needs Erlang-distribution (cookie) access.
- Its `x-delivery-count` is DC, not the AC that 4.0-4.2 limits use.

**No HTTP or AMQP 1.0 route reads messages without side effects.**
- The `/actions` route accepts no actions in 4.x.
- The AMQP 1.0 management node exposes queue metadata, purge and bindings only.
- Distribution modes: QQ and CQ `move`; stream `copy`.

### b.7 Other peek hazards (S/D, H)

- **SAC:**
  - QQ + SAC: `basic.get` is refused with **405 RESOURCE_LOCKED**, which closes the channel.
  - CQ + SAC: `basic.get` **bypasses** SAC, which can break ordering.
  - A browsing consumer can **become the active consumer**: as the first consumer, on failover, or on QQ 4.0+ via a higher `x-priority`.
- **Exclusive queues** owned by another connection: 405 for everyone, including the management API.
- **Auto-delete CQ:** a consuming peek deletes the queue when the last consumer leaves; `basic.get` never does.
- **4.3.0:** a passive declare by a read-only user on a channel that holds deliveries → 403 → channel closed → the held deliveries count as failed.
- **LavinMQ:** HTTP `ack_requeue_true` means reject *without* requeue unless the body also has `"requeue": true`; a missing ackmode means ack (S@v2.10.2 queues.cr L185-227).

### b.8 Recommended safe-peek algorithm

**1. Resolve the era per cluster, conservatively.**
- Any node < 4.0 → **3.13** rules.
- Any node < 4.3, or `rabbitmq_4.3.0` not enabled, or any QQ member status reporting Machine Version < 8 → **4.0-4.2** rules. A mixed 4.2/4.3 cluster keeps v7 behaviour.
- Otherwise → **4.3** rules (**4.4** when all nodes ≥ 4.4).
- Unknown or commercial builds → 4.0-4.2.
- Optional team-server canary: a throwaway QQ, then get+nack twice. v8 shows `x-acquired-count: 2` with no `x-delivery-count`; v7 shows `x-delivery-count: 2`.

**2. Preflight (HTTP only; touches no messages).**

| Check | Source | Effect |
| --- | --- | --- |
| Queue type, exclusivity, owner, `auto_delete` | `GET /api/queues/{v}/{q}` | exclusive and not ours → refuse; auto-delete → `basic.get` only |
| L | `.delivery_limit`, cross-checked against arguments and merged policies | mismatch → W-UPGRADED |
| DLX and DLQ topology | arguments/policies plus the routing simulator | 4.3+, QQ, finite L < max(source L)+1 → **W-OVERLIMIT, block by default** |
| Delayed retry | `.delayed_retry`, `.messages_delayed`, `.next_delayed_at` | type `all`/`returned` → W-DELAY |
| Length limit and overflow | `x-max-length*`, `x-overflow`, policies vs ready count | drop-head and ready+n ≥ 90% → W-DROPHEAD |
| TTL | `x-message-ttl` / `message-ttl` | hold ≤ TTL/4 |
| SAC, consumers, priorities | arguments, `.single_active_consumer_tag`, `consumer_details` | QQ-SAC with an active consumer → refuse; CQ-SAC → W-SAC-CQ |
| QQ health | `.leader`, `.members`, `.online` | no quorum → refuse |
| Size | `message_bytes_ready / messages_ready` | byte cap |

**3. Plan by type and era.**

| Queue / era | Method | Settle | Max hold | Caps (default/max) | Gates |
| --- | --- | --- | --- | --- | --- |
| CQ, all versions | 0-9-1 `basic.get`×n on a dedicated peek connection | one `nack(lastTag, multiple=true, requeue=true)`, then a `basic.qos` barrier, then close | target ≤5 s; abort at min(30 s, TTL/4, timeout−90 s on ≤4.2); **client watchdog mandatory on 4.3+** | 20 / 500, 16 MiB | exclusive, SAC, drop-head, TTL |
| QQ 3.13 | `basic.get`×n | nack (≡ reject; DC+1) | < channel timeout | 20 / 50 | always confirm (W-313); W-TAIL if unlimited; guard |
| QQ 4.0-4.2 | `basic.get`×n over 0-9-1 (the 1.0 path cannot see AC) | nack (≡ reject; **both count**) | < channel timeout | 20 / 50 (admin 200) | **always confirm W-BUDGET**; W-TAIL if L=-1; guard; no auto-refresh |
| QQ 4.3+ / main | `basic.get`×n; SAC queues only via a consumer when no consumer is active, with `x-consumer-timeout` = abort budget; AMQP 1.0 alternative: credit N + drain + `released` | `basic.nack(requeue)` / `released` only; **never** reject, `modified(df=true)`, `rejected`, or close while holding | ≤ min(30 s, QQ timeout/4, TTL/4) | 20 / 500, 16 MiB | W-OVERLIMIT blocks; W-DELAY; guard |
| Stream | 0-9-1 consume with `x-stream-offset` (prefetch ≤1000, manual ack), or AMQP 1.0 offset filter, or an anonymous stream-protocol consumer; **never `basic.get`** | ack/accept (credit only) | n/a | by count/bytes/time | info only |
| HTTP-only fallback | `/get` with `ack_requeue_true` only, count ≤50, truncate | server-side | request duration; client timeout above server work | 20 / 50 | same gates; never `reject_*` / `ack_requeue_false` |

**4. Guard and rescue.** A message is *doomed* if its return would drop it: 4.3+ when `x-delivery-count` > L; 4.0-4.2 when `x-delivery-count` (=AC) ≥ L; 3.13 with a limit when DC ≥ L. The user chooses before the peek:
- **(A) Let RabbitMQ handle it.** Forbidden for unattended or AI runs.
- **(B) Rescue.** Publish a copy with confirms on a *separate* connection to a durable classic quarantine queue, then ack the original.
- **(C) Raise the limit (admin).** Write a policy, wait for the `.delivery_limit` stat to show it, then nack. On 4.0-4.2 use a finite value, because -1 sends returns to the TAIL. Impossible if the argument or an operator policy caps it.
- **Default:** stop acquiring at the first doomed message.

**5. Warnings** (IDs kept in a registry, texts versioned): W-BUDGET, W-313, W-TAIL, W-OVERLIMIT, W-DELAY, W-REDELIVERED, W-HOLD, W-DROPHEAD, W-TTL, W-SAC-CQ, W-SAC-QQ, W-EXCLUSIVE, W-CRASH (4.3: if the connection breaks while holding, every held message gets DC+1), W-UPGRADED, W-MIXED, W-STREAM.

**6. Honest claims.**

| Claim | Allowed? |
| --- | --- |
| "Non-destructive / read-only" CQ or QQ peek | ✗ |
| "Non-destructive stream browsing" (anonymous readers) | ✓ |
| "Zero-side-effect QQ peek" | ✓ only via the optional node agent running `rabbitmq-queues peek` |
| "Side-effect-aware, version-aware peek" (headline) | ✓ |
| "Peeking doesn't use the delivery limit" | ✓ only for QQs on ≥4.3, with the over-limit exception stated |
| "Never drops messages" | ✗ |

---

## (c) Live capture (taps, firehose)

### c.1 Facts (S, H unless noted)

- **Default-exchange blind spot.** No binding may have `""` as source or destination (`check_not_default_exchange`, rabbit_channel.erl@v4.3.6 L1048-1050). A copied-binding tap never sees:
  - `sendToQueue` publishes to `""`;
  - AMQP 1.0 `/queues/{q}` targets;
  - STOMP `/queue`;
  - DLX `""` retries;
  - shovels or federation writing directly to a queue.
- **Diversion on single-destination exchange types:**
  - `x-consistent-hash`: takes its weight share; integer weight key; E2E diverts too.
  - `x-modulus-hash` (core since 4.3; earlier the sharding plugin): takes about 1/(N+1) and **remaps almost every key**, breaking per-key ordering and SAC partitioning.
  - `x-random`: takes 1/(N+1).
  - `x-local-random` (4.0+): the destination must be an existing classic queue with an empty key, so **E2E is impossible**; it diverts only messages published on the tap queue's node.
  - `x-recent-history`: replays its cache into a new tap.
- **Routability masking.** The AE is consulted only when an exchange's own destinations are empty; mandatory `basic.return` fires only when no queue was reached. A tap that matches more than the existing bindings do (`#`, fanout `""`, headers bindings **copied without arguments**, which match everything) silences the AE, returns and the unroutable counters.
  - rabtap's "without affecting actual message delivery" claim is ✗ as a general statement.
- **Publisher side effects of a tap:**
  - a backlog can raise memory or disk alarms, which block **all** publishers;
  - an inherited `reject-publish` makes **confirming publishers receive `basic.nack`** (it fires even if only one routed queue rejects);
  - a catch-all DLX policy sends tap overflow into production DLQs;
  - confirms now also wait for the tap queue;
  - on 4.2+, queue types can be disabled (check that classic is enabled);
  - on 4.3, taps must be **exclusive** (transient non-exclusive is denied).
- **Amazon MQ** cluster default policies set `max-length` + `overflow=reject-publish` with pattern `.*` (D). A classic-queue `x-overflow` **argument wins over the policy**, and `max-length` takes min(policy, argument).
- **Exclusive / auto-delete / non-durable declares become `classic`** even under a quorum default (vhost or node), via `rabbit_queue_type:is_compatible` (3.13.7, 4.2.9, 4.3.6; ✓ H for source, M for Amazon MQ until tested).
- **E2E orphans.** An auto-delete tap exchange orphans if the client dies between `exchange.bind` and `queue.bind`. Combined with #17255 (4.3.0-4.3.5), deleting it causes silent loss on consistent-hash exchanges.

### c.2 Tap modes

| Mode | Sees | Blind / risk | Needs | Min version |
| --- | --- | --- | --- | --- |
| A. Copied-binding shadow queue (default) | traffic routed via the target's bindings | default exchange; existing backlog; requeues; x-local-random on other nodes; binding drift (re-sync needed) | configure+write+read on the tap queue (explicit name within the user's regex, never `amq.`); read on each source exchange plus topic read; management tag to list bindings | all |
| B. Exchange-to-exchange (rabtap style) | everything routed through X | AE/mandatory masking; hash/random diversion; orphans; CHX bug <4.3.6 | configure/write on the tap exchange, read on X | all; **refuse on CHX <4.3.6 and on hash/random types** |
| C. Firehose `amq.rabbitmq.trace` | **default-exchange and unroutable publishes** (`routed_queues=[]`), deliver events | per node per vhost; not persisted; at-most-once; misses the stream protocol, dead-lettering and local shovels; exposes every body (PII); throughput drop | administrator; per-node enable | all |
| D. rabbitmq_tracing files | as C, written to node disk | fills disk; unbounded no-ack queue; ETS state lost on restart | administrator | all (node routes 3.13.7-main) |
| E. Web-STOMP `/exchange/X/key` | as A/B | as A/B; Origin rules on 4.3+ | plugin | all |
| F. Capture to a retention-limited stream (team) | as A/B, replayable | durable artefact needs cleanup; not an x-local-random destination | configure/write/read | all |

**Tap queue recipe (A/B/C).**
- `name = <prefix>.tap.<uuid>`, `durable=false`, `exclusive=true`, `auto_delete=true`.
- Arguments: `x-queue-type=classic`, `x-max-length=10000`, `x-overflow=drop-head`, `x-message-ttl=60000`, `x-expires`.
- Before declaring, simulate which user and operator policies match the name.
- Check `GET /api/health/checks/alarms`.
- `basic.qos(prefetch≈1000, global=false)`.
- Copy bindings **with their arguments**.
- Ack in batches, or no-ack.

### c.3 Firehose control (S, H)

- **Per node.** `rabbit_trace:start` sets the local app env `trace_vhosts` (default `[]` at boot) and refreshes only *local* channels and sessions.
- **The HTTP vhost toggle affects only the serving node** (`GET .tracing` is node-local too, so it flips behind a load balancer). It also rewrites metadata (0.1).
- **Cluster-wide enable over HTTP** is possible only through `rabbitmq_tracing`: `PUT /api/traces/node/{node}/{vhost}/{name}` → `rpc:call` → `rabbit_trace:start` on that node (X3 ✓ H).
- **CLI:** `rabbitmqctl trace_on -p V -n node`.
- **Trace content.** Traces are generated on the client connection's node. Publish traces carry the documented `exchange_name`, `routing_keys`, `properties` and `node`, plus undocumented `vhost`, `connection`, `channel`, `user` and `routed_queues`. Deliver traces carry `redelivered`.
- **Plugin is still shipped** at 4.3.6, v4.4.x and main.
- **Provider availability:** absent on Amazon MQ (no tracing plugin), LavinMQ (hard-coded false) and CloudAMQP shared; console toggle on CloudAMQP dedicated.

---

## (d) Streams: browsing capabilities

| Path / client | History | Offsets | Server-side filters | Broker | Gotchas |
| --- | --- | --- | --- | --- | --- |
| OSS management UI / HTTP | **no** (`get_message:false`, `purge:false`; `/get` → 540) | — | — | all | metadata only; oldest-message timestamp on the stream page (4.3.2+) |
| Tanzu Stream Browser | yes | offset, timestamp, head/tail, chunks | search | Tanzu 4.3+, closed | integrate if detected |
| AMQP 0-9-1 (amqplib 2.2.0) | yes, via `basic.consume` | `x-stream-offset`: first/last/next/long/timestamp (**seconds**)/interval | Bloom (`x-stream-filter`, `x-stream-match-unfiltered`, 3.13+); no stage-2 | 3.13+ | prefetch >0 (0 → PRECONDITION_FAILED); manual ack required (no-ack → `not_implemented`); no global QoS; **node must host a replica** ("does not have a running replica on the local node"); default offset `next`; deliveries carry an `x-stream-offset` header |
| AMQP 1.0, own spec-correct rhea adapter | yes | **described** `rabbitmq:stream-offset-spec`: AMQP timestamp (ms), first/last/next/interval, ulong | `rabbitmq:stream-filter` and `-match-unfiltered` (described, 4.0+); `amqp:properties-filter` / `application-properties-filter` 0x173/0x174 (**4.1+**); `sql-filter` 0x120 (**4.2+**); property and SQL are mutually exclusive | 4.0+ (3.13 plugin: unverified) | same replica rule; credit flow; must verify the applied filter-set in the attach reply |
| AMQP 1.0 via coders51 `rabbitmq-amqp-js-client` 1.0.0 | partly | first/last/next sent non-described → **ignored on 4.3+**; numeric/timestamp are BigInt → rhea encodes an empty map → **broken everywhere**; `offset(0n)` sends "numeric" | property and SQL OK; Bloom ignored on 4.3+ | CI on 4.2 only | no vhost (#95), credit 1000 (#94), link race (#96), unencoded addresses |
| Stream protocol (`rabbitmq-stream-js-client` 1.1.0, 2026-07-23) | yes | first/last/next/numeric/timestamp (correct) | Bloom 3.13+; no stage-2 | 3.9+ (filters 3.13+) | `rabbitmq_stream` plugin and 5552/5551 needed; `advertised_host` must resolve; `addressResolver` is **load-balancer mode only** (fixed endpoint, retry loop); no token refresh; anonymous consumers only (no name, no `storeOffset`, no `singleActive`) |
| STOMP / Web-STOMP | yes | `x-stream-offset` incl. `offset=N` and `timestamp=secs` | Bloom | 3.13+ | `ack:client` + `prefetch-count`; the only OSS browser-native path |

**Fidelity (ED):** streams store AMQP 1.0, so 0-9-1 non-`x-` table/array headers are lost at write (0.14).

**Providers:** Amazon MQ none · IBM AMQP 0-9-1 only · CloudAMQP dedicated opt-in plugin · Kubernetes Cluster Operator needs `additionalPlugins` (pod-DNS advertised hosts) · LavinMQ 0-9-1 plus `POST /api/queues/{v}/{q}/stream`.

---

## (e) Dead-letter headers & replay rules (S/RN, H)

- **No interpretation in 4.x.** 4.0+ ignores a client-published `x-death` (RN 4.0.1 L70-80). The copy stays visible as an opaque header until the next broker dead-lettering replaces it (`deaths_to_headers` → `set_table_value`). Broker annotation headers win over same-named client headers. **3.13 still interprets** published `x-death` (`headers_to_deaths`).
- **AMQP 0-9-1 format.** `x-death` = array of tables, one per {queue, reason}, **most recent first**. Fields:
  - `count` (long);
  - `reason` (`rejected`/`expired`/`maxlen`/`delivery_limit`);
  - `queue`;
  - `time` (timestamp in **seconds**, of the FIRST death for that pair);
  - `exchange`;
  - `routing-keys` (CC included, BCC excluded);
  - optional `original-expiration`.

  Also `x-first-death-queue/-reason/-exchange` (never modified afterwards) and `x-last-death-*` (updated each time).
- **AMQP 1.0 format.** Annotation `x-opt-deaths`: array of maps with keys `queue`, `reason` (symbol), `count` (ulong), `first-time`/`last-time` (ms), `exchange`, `routing-keys`, optional `ttl`. Plus the six first/last annotations.
- **Cycle rule.** Flag `message_containers_deaths_v2` (required from 4.3): a message is dropped only in fully automatic cycles, i.e. with no `rejected` death anywhere in the cycle.
- **Replay invariants:**
  - Strip `x-death`, `x-first/last-death-*`, `x-delivery-count`, `x-acquired-count`, an elapsed `expiration`, and `user_id` unless it matches the replay user. RabbitMQ rejects a mismatched `user_id` (validated-user-id).
  - Preserve logical message ids (MassTransit `messageId`, NServiceBus.MessageId, `rbs2-msg-id`, Celery `id`, ...), because inboxes and outboxes dedupe on them.
  - Edited messages get a new id plus a link header (the ServiceControl `EditOf` pattern).
  - Stamp namespaced provenance headers (`x-<tool>-replay-id`, `-count`, `-from`, `-at`, `-by`; switchable).
- **Destination resolution order:**
  1. the framework's explicit field;
  2. the newest `rejected`/`delivery_limit` `x-death` entry, skipping `expired` entries from known delay queues;
  3. a naming convention;
  4. Spring `x-original-*`, **with a fan-out warning**;
  5. a user mapping.

  Publish to the queue via the default exchange, with `mandatory`, and treat `basic.return` as failure. **Never route by `x-first-death-queue` alone.**
- **Mechanics:**
  - consume with manual ack;
  - publish with confirms;
  - **ack the source only after the confirm**;
  - token-bucket throttle plus canary;
  - pause when replayed ids reappear in the error queue;
  - journal for idempotency and audit;
  - "undo" = honest re-park of the journaled copy.
- **Transports for replay:**
  - Republishing from the engine gives fresh counters and resets the death history.
  - Local shovels (4.2+) forward the `mc` container with annotations, so DC carry-over and death history are likely kept (unverified).
  - Avoid shovels on 4.3.0-4.3.6 (reject loop).

---

## (f) Metrics availability (S/RN/D, H)

"Stats OFF" means any of: `management.disable_stats`, `management_agent.disable_metrics_collector`, `deprecated_features.permit.management_metrics_collection=false`, or per request `?disable_stats=true`.

| Data | Stats ON | OFF ≤4.2.4 | OFF 4.2.5 | OFF 4.2.6-4.2.9 | OFF 4.3.0-4.3.5 | OFF 4.3.6+ |
| --- | --- | --- | --- | --- | --- | --- |
| Rates / `message_stats` | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Queue message counts | ✓ | only with `enable_queue_totals` (config, or **`?enable_queue_totals=true`**: lists from 3.13.0, single queue from 3.13.1) | same | same | same | same |
| `policy`, `operator_policy`, `effective_policy_definition`, `delivery_limit` | ✓ | **missing** | ✓ | ✓ | ✓ | ✓ |
| Connection static info (peer, TLS, auth mechanism) | ✓ | ✗ | ✗ | ✓ (#16009) | ✓ | ✓ |
| `/api/channels` | ✓ | **400** | 400 | 400 | 400 | basic info |
| `/api/nodes` resources | ✓ | only name, type, running, being_drained (read at 4.3.6; older assumed) | ← | ← | ← | ← |
| `/api/overview` | ✓ | `object_totals` plus the `disable_stats` / `enable_queue_totals` flags | ← | ← | ← | ← |

- **Deprecation:** `management_metrics_collection` is still `permitted_by_default` at 4.2.9, 4.3.6, v4.4.x and main. Plan for its removal.
- **Prometheus** (per node; independent of management stats):
  - `/metrics` (aggregated; `prometheus.return_per_object_metrics=true` makes it per object);
  - `/metrics/per-object`;
  - `/metrics/detailed?family=&vhost=` (repeatable; present since 3.9.29);
  - **`queue=<regex>` from 4.3.0 only** (#15689; one value, ≤2,000 characters, invalid regex → 400);
  - `/metrics/memory-breakdown` from 4.0;
  - detailed metrics use the prefix `rabbitmq_detailed_`.
- **Prometheus auth:** with `prometheus.authentication.enabled`, the monitoring tag is required. Listeners appear as `http/prometheus` or `https/prometheus` in `/api/overview` `listeners` (visible to monitoring users and above).
- **Provider endpoints:**
  - Amazon MQ (4.2+): ports 16001-16003 per node, broker credentials, **no per-object**, scrape ≥60 s.
  - CloudAMQP dedicated: `https://<host>-0N.rmq.cloudamqp.com/metrics`.
  - Bitnami: 9419, off by default.
  - LavinMQ: 15692 bound to 127.0.0.1, `lavinmq_` prefix.
  - IBM: none.

---

## (g) Ops surface: HTTP-available vs CLI-only (S@v4.3.6 dispatcher L107-229, H)

**CLI-only (no HTTP route):**
- `rabbitmq-queues`: **peek**, grow_to_count, transfer_leadership, force_checkpoint, reclaim_quorum_memory.
- `rabbitmq-streams`: add/delete_replica, grow/shrink, **stream_status**, **restart_stream**, transfer_leadership, coordinator_status.
- Stream SAC groups: list_stream_consumer_groups, list_stream_group_consumers, activate_stream_consumer; plus reset_offset.
- `rabbitmq-upgrade`: drain, revive, await_online_quorum_plus_one.
- `rabbitmq-plugins`: enable, disable.
- `rabbitmqctl`: join_cluster, forget_cluster_node, reset, set_log_level, memory/disk watermarks.
- Diagnostics: log_tail.

**Corrections:**
- `delete_super_stream` and `create_super_stream` exist over the **stream protocol** (3.13+).
- HTTP `PUT /api/stream/super-streams/{v}/{name}` creates super streams, from 4.1.
- **`DELETE /api/reset[/{node}]` resets management statistics, not the node.**
- `/api/queues/{v}/{q}/actions` exists but rejects every action.

**HTTP-available:**
- **QQ replicas** add/delete/grow/shrink (admin; **405** when `management.restrictions.quorum_queue_replica_operations.disabled`).
- **QQ status**, which includes per-member Machine Version (0.13).
- **Rebalance:** `POST /api/rebalance/queues`, asynchronous, no dry-run.
- **Health checks** under `/api/health/checks/`:
  - ≤3.13: alarms, local-alarms, certificate-expiration, port-listener, protocol-listener, virtual-hosts, node-is-quorum-critical;
  - 4.0: metadata-store/initialized[/with-data];
  - 4.1: is-in-service, below-node-connection-limit, ready-to-serve-clients, quorum-queues-without-elected-leaders;
  - 4.3: reached-target-cluster-size.
- **Features and definitions:** feature-flag enable (admin), deprecated-features[/used], definitions GET/POST (admin; upload capped from 4.2.8/4.3.2), vhost CRUD, deletion protection (4.0+), vhost restart per node, cluster name.
- **Access control:** users (bulk delete), permissions, topic permissions, vhost and user limits, policies and operator policies (405 when `operator_policy_changes.disabled`; `/api/overview` `is_op_policy_updating_enabled`), parameters, `/api/config/effective` (admin; node-local Erlang terms; secret).
- **Connections and messages:** connection close (also by username), purge, `/get`, publish, auth attempts, `/api/users/{u}/queues` (4.3).
- **Plugin routes:** shovels (delete and restart need policymaker from 4.3.0), federation links, stream connections/consumers/publishers/tracking, tracing, top.
- **AMQP 1.0 management node (4.0+):** queues GET/PUT/DELETE, purge (`DELETE /queues/{q}/messages`), exchanges PUT/DELETE, bindings POST/GET/DELETE, `PUT /auth/tokens`. "GET queue" needs **no permission**.

**Audit facts:**
- `queue.purge` needs only **read** permission (0-9-1, AMQP 1.0 and HTTP).
- **No internal event is emitted for purges.**
- HTTP requests are not logged unless `management.http_log_dir` is set (per node, after restart).
- Events carry `user_who_performed_action` (OAuth: `preferred_username_claims`, default `[sub, client_id]`; Entra `sub` is pairwise).

---

## (h) Browser access / CORS (S/D, H)

- **CORS is opt-in.** `rabbit_mgmt_cors` sets ACAO only for an Origin listed in `management.cors.allow_origins` (empty by default).
  - Exact matches are echoed with `Allow-Credentials: true`; `*` returns ACAO `*` without credentials.
  - The server still executes the request; the browser enforces the policy.
  - `max_age` defaults to 1800, but the header is dropped when the preflight carries request headers (source quirk).
  - Hardened in 4.2.8 and 4.3.2: request headers validated, `Origin: *` rejected.
- **AMQP 1.0 over WebSocket is Tanzu-only.** OSS has only Web-STOMP and Web-MQTT; Origin validation arrived in 4.3.0 and `strict_origin_validation` in 4.4.
- **Chrome Local Network Access:** public → loopback fetch is gated since Chrome 142; **WebSockets since 147**. It is hard-disabled in Electron (electron#48655). Not a control we rely on.
- **Design consequence:** all broker I/O stays in the engine; never ask users to configure CORS or enable Web-STOMP.

---

## (i) Auth & connectivity (S/D, H unless noted)

**By protocol:**
- **HTTP:** `Authorization: Bearer <jwt>` works whenever the oauth2 backend is in the HTTP auth chain (`management.oauth_enabled` only controls the UI login). Basic with the JWT as password also works unless `management.disable_basic_auth=true`.
- **AMQP 0-9-1, AMQP 1.0 and streams:** SASL PLAIN with the JWT as password; the username is ignored.
- **Opaque tokens and introspection:** Tanzu only, so Google is unsupported.
- **Separate HTTP auth chain:** `http_dispatch.auth_backends` from **4.0.8/4.1.0**. Profiles need separate HTTP and AMQP credentials.
- **The documented `?token=` for `/api/definitions` does not exist in code** (✗ M; lab).

**Token expiry and renewal:**
- **AMQP 0-9-1:**
  - ≤4.2.5: not closed; new operations fail after the 60 s cache tick; **consumers keep running**.
  - **≥4.2.6 and 4.3.0:** closed with `320 CONNECTION_FORCED "credential expired"`; update-secret re-checks consumers. The 4.3 docs are stale.
  - Renewal: `connection.update-secret`.
- **AMQP 1.0:** 4.0 closes at expiry with no renewal; 4.1+ renews via `PUT /auth/tokens`; 3.13 plugin behaviour is unverified.
- **Stream:** re-sending SaslAuthenticate on the open connection, same username (3.13+); closes at expiry.
- **Username must stay the same** on every refresh (`mismatch_username_after_token_refresh`), so delegated mode needs per-user connections.

**Size limits:**
- Cowboy `max_header_value_length` is 4096, so Bearer headers over about 4 KB get **431**. Only `advanced.config` `cowboy_opts` fixes this.
- Pre-auth AMQP 0-9-1 frame: 4096 (≤4.0) or 8192 (4.1+).

**4.1+ UI change:** no default `resource`/`audience` parameters are sent (#12235); Entra and Auth0 need explicit endpoint parameters.

**4.4 draft:** strict OIDC discovery breaks UAA (`auth_oauth2.discovery.verify_issuer` / `verify_https_endpoints`).

**Weak defaults to lint:** `hostname_verification=none` (JWKS); `verify_aud=false` in the Okta template; ANONYMOUS on by default since 4.0 (maps to guest, loopback-only); no revocation checks; `iss` never validated.

**OAuth discovery for the tool:** unauthenticated `/js/oidc-oauth/bootstrap.js` (3.13-4.3; parse the JSON inside `set_oauth_settings(...)`); `/api/auth` only on ≤4.1 (0.2). Pin the issuer to the profile and confirm it with the user (SSRF/phishing defence).

**Desktop:**
- Default UI↔engine transport: **MessagePort** (`MessageChannelMain` between renderer and utilityProcess), so no TCP listener.
- OAuth: system browser, PKCE S256, loopback redirect `http://127.0.0.1:0/cb` (RFC 8252 §7.3/§8.3/§8.12). Refresh-token rotation or sender constraint (RFC 9700).
- Entra: "Mobile and desktop" platform (port ignored for localhost; SPA type gives 24 h refresh tokens and requires an Origin header). Okta and Auth0: ephemeral ports historically unsupported, so fall back to fixed ports or device code.
- Secrets: `safeStorage.*Async` in main (sync API removed in Electron 46), or `@napi-rs/keyring` 2.1.1 forced to Secret Service. Linux `basic_text` or keyutils → require a master password.
- CA handling: `NODE_EXTRA_CA_CERTS` and `NODE_OPTIONS` are ignored once the NodeOptions fuse is off, and Electron's Node uses BoringSSL. Load CAs in code with `tls.setDefaultCACertificates` (Node 24.5+) and `tls.getCACertificates('system')`; a per-connection `ca` **replaces** the defaults.
- HTTPS: Electron `net.fetch` in the utilityProcess gives system/PAC proxy, Kerberos/NTLM, OS trust store and smartcard client certs; undici is the portable path.
- macOS 15+: needs `NSLocalNetworkUsageDescription`.

**Local web:** bind 127.0.0.1; token in the URL fragment; Host/Origin allow-lists; Docker `-p 127.0.0.1:...` (published ports bypass ufw); always require the token inside containers.

**Team server:**
- OIDC BFF.
- Broker credential mode per connection: **delegated OAuth access tokens** (never ID tokens) > Vault/OpenBao dynamic users > personal LDAP credentials > service account (tool RBAC only).
- Own append-only audit is the system of record; user ID goes in the AMQP `connection_name`.
- **MCP:** `/mcp` is its own OAuth resource (RFC 9728/8707); **no token passthrough** (spec 2025-11-25 and 2026-07-28); tools reference connections only by human-created opaque IDs. CVE-2026-18655: a prompt injection steered credentials to an attacker's host in AWS's MCP server ≤2.0.23.

**Network:**
- **Dialer:** direct, SOCKS5 (`socks` 2.8.10), HTTP CONNECT, ssh2 1.17.0 (jump chains, agents, keyboard-interactive; **no OpenSSH certificates**, #1495), system OpenSSH `ssh -W`, Kubernetes port-forward (`@kubernetes/client-node` 2.0.0: pod only, one port per call).
- **Socket injection:** amqps via `tls.connect({socket})`, undici `connect`, rhea `connection_details`. Plain-TCP amqplib and the stream client cannot take a socket, so use a permission-protected Unix-socket forwarder.
- **Tunnels make clients "local"** (guest and ANONYMOUS work for any local process).
- **Streams behind a single tunnel:** use AMQP reads; the node must host a replica.

---

## (j) Managed-broker compatibility & capability probes

### j.1 Matrix (D/S, H unless noted; S = supported, P = partial, C = config/opt-in, B = blocked, U = probe)

| Capability | Amazon MQ 3.13 | Amazon MQ 4.2/4.3 | CloudAMQP shared | CloudAMQP dedicated | IBM | LavinMQ 2.10.2 | K8s operator | Bitnami |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Peek | S (AMQPS 5671) | S, **high risk** (default type quorum, L=20) | S/P (message quota counts consumes) | S | S | **P/hazard** (HTTP ackmode semantics; no QQs) | S | S |
| Tap | S (set `x-overflow`) | S/P (10 consumers/channel; queue limits; no x-local-random) | P (queue caps; temporary queues expire after 60 s) | S | S | S | S | S |
| Firehose | U→P (admin; node-local behind the NLB; no tracing plugin) | same | B | S/P | U | B | S/P | S/P |
| Event exchange | B | B | B/U | **S, on by default** | B | B | C | C |
| Prometheus | B (CloudWatch only) | S (16001-16003, no per-object) | B | S | B | P | S (scrape each pod) | C (9419) |
| Streams | B | **B** | U | C (plugin, 5551/5552) | P (0-9-1 only) | P | C | C |
| Shovels | P (dynamic; outbound verify_none) | S/P (local shovels; 30/node quota; verify_peer; no client certs) | U | S | S (no federation) | P (own schema) | C | C |
| Definitions | S | S (exclude AWS-owned objects) | B → synthetic | S | S for `admin`, B for service users | P | S | S |
| Operator-policy edit | **405 by default** | same | U | S | S | S (policymaker) | S | S |
| OAuth2 | S (public IdPs; no UAA, no opaque tokens) | S, plus HTTP auth backend, X.509/EXTERNAL, mTLS | B | C | U | C | C | C |

**Other provider facts:**
- **Amazon MQ:**
  - Administrator user; management on 443/15671; no 5672, 5552 or 15692.
  - Plugins are fixed. Not offered: event exchange, tracing, stream, MQTT/STOMP, custom plugins.
  - 4.x defaults on an m7g.large cluster: **10 consumers/channel**, **512 KiB messages**, 500 connections/node.
  - Provider-owned objects: `AWS-DEFAULT-POLICY-*`, `default_operator_policy_AWS_managed`, `monitoring-AWS-OWNED-DO-NOT-DELETE` (protected), and HA keys injected on 3.x clusters.
  - Versions: 4.3 since 2026-09-09 (What's New post 2026-09-10).
  - Auth timeline: OAuth 2025-09-03, LDAP 2025-11-17, HTTP auth 2026-01-06, mTLS 2026-01-08, private networking 2026-06-18.
- **CloudAMQP:** shared plans have no administrator rights, 20/100 connections, 200 channels per connection and a monthly message quota. 84codes claims "31,000+ Running Brokers" (RabbitMQ and LavinMQ combined; ~ M).
- **Kubernetes:** the Cluster Operator v2.23.1 runs `enable_feature_flag all`. The Topology Operator v1.20.4 re-asserts CR-owned objects on resync (default 10 h), so UI edits revert later, not immediately (~ M).
- **Bitnami:** frozen since 2025-08-28 (`bitnamilegacy`); chart appVersion 4.1.3.
- **ApsaraMQ** is not RabbitMQ: AMQP-only mode, and `basic.cancel` requeues messages already delivered.
- **Load balancers** front every managed cluster, so node-local results (firehose, local health, `config/effective`, Prometheus) are unreliable.

### j.2 Probe sequence (read-only; run on every connect)

Order: network → unauthenticated → identity → product → features.

1. **TLS:** check the handshake and SAN. Offer CA import and SNI override; never pin the leaf certificate.
2. **Host fingerprint:** `*.mq.<region>.amazonaws.com|on.aws`, `*.rmq*.cloudamqp.com`, `*.databases.appdomain.cloud`, `vpce-*`, `*.svc`.
3. **OAuth discovery:** `GET /js/oidc-oauth/bootstrap.js`; fall back to `/api/auth` (≤4.1); LavinMQ uses `/oauth/enabled`.
4. **Identity:** `GET /api/whoami` (tags drive every gate; `protected` is 4.2+).
5. **Overview:** `GET /api/overview` (`product_name`, `rabbitmq_version` — absent on LavinMQ, `default_queue_type` 4.0+, `is_op_policy_updating_enabled`, `disable_stats`, `enable_queue_totals`, `exchange_types`, `listeners` for monitoring+). Call it several times to detect a load balancer: differing `node` values.
6. **Extensions:** `GET /api/extensions` (`shovel.js`, `federation.js`, `stream.js`, `top.js`, `tracing.js`; `[]` means LavinMQ or a minimal broker).
7. **Nodes:** `GET /api/nodes?columns=name,running,enabled_plugins,auth_mechanisms,being_drained` (monitoring).
8. **Flags:** `GET /api/feature-flags` and `/api/deprecated-features/used`.
9. **Vendor fingerprints:** AWS policies and users, user `ibm`, `/api/queue-migration/status`.
10. **Exchanges:** `amq.rabbitmq.event` / `amq.rabbitmq.trace` existence.
11. **Prometheus:** discovery by adapter, then listeners, then default ports.
12. **AMQP handshake:** server properties, `channel_max`, `frame_max` (amqplib default 131072, which meets Amazon MQ's ≥8192).
13. **Write-shaped probes only on demand:** replica-op probe against a nonexistent queue (405 = restricted, 404 = allowed); tap dry-run.

**Status-code interpretation:**

| Status | Meaning |
| --- | --- |
| 401 `Login failed` | bad credentials |
| 401 `Not … user` | missing tag |
| 404 | endpoint or plugin absent |
| 405 `Broker settings disallow …` | provider restriction |
| 503 | health check failing |
| timeout / reset | port blocked |

**Limit error signatures** (connection, channel and consumer per-channel limits, message size, exchange/queue/vhost/shovel limits) are matched to show usage against limits.

---

## (k) Competitors (verified 2026-10-16)

### k.1 Matrix (R/D; traction self-reported where noted)

| Product | Licence / price | Delivery | Latest | QQ peek mechanism → correctness by era | Team features |
| --- | --- | --- | --- | --- | --- |
| HZN Queue Console (Huzen B.V., NL) | closed; Pro €12/mo or €99/yr; Team €79/seat/yr (min 5); 14-day trial | desktop; web "Q4 2026" | 1.0.5 (2026-09-14) | management API; 1.0.4 admitted that interrupted searches destroyed QQ messages; Spy Mode has no AMQPS | none |
| Queue Studio (Factodus, ES) | from $4/mo; 30-day trial; 82 downloads | JetBrains plugin | 1.0.2 | HTTP `/get` `ack_requeue_true`, ≤5,000; claims "never counts" → true only on 4.3+ | none |
| QueueExplorer 5 (Cogin) | $149/$249 perpetual | desktop | 5.0.99 Win / 5.0.98 Mac/Linux | consume and hold; returns by **session close** → counts on 4.0-4.2 **and 4.3** | none |
| Warren | closed; Community free; Team/Pro unreleased (one-time, prices unpublished) | self-hosted (Java/Spring) | 0.17.0 (2026-10-13); 2,823 Docker pulls | management API, asks first on risky QQs; "RabbitMQ 4 no longer counts" → ✗ on 4.0-4.2 | audit + masking in all editions; roles from Team; OIDC/four-eyes in Pro (unreleased) |
| QueueLens | **MIT**, 0★ | self-hosted web (FastAPI) | v0.19.2 (2026-10-10) | `basic_get` + nack; **refuses** limited QQs (even where 4.3 nack is free) | Viewer/Operator/Admin roles, attempt+outcome audit, masking; SSO only behind a proxy (experimental) |
| Qarote | open core (MIT CE + private EE); Cloud $99/mo yearly, ≤100 queues/broker | self-hosted + SaaS | v1.2.0 (GitHub) / v2.0 "upcoming" | v2.0 hides the browser behind the firehose | SSO/RBAC/audit paid |
| RabbitScout (MIT, 154★), RabbitLens (Apache, 91★), mq-studio (Apache, 89★), mqx (MIT, 4★) | free | web / desktop / CLI | — | HTTP `/get` or requeue | minimal |
| amazon-mq/mcp-server-rabbitmq (Apache) | free | MCP | v4.0.0 | "read-only" `get_messages` = HTTP `/get` and **also accepts `ack_requeue_false`** | flags only |
| Official UI 4.3.6 | MPL-2.0 | per cluster | — | "Get messages" defaults to Nack requeue (labelled destructive) → counts on 4.0-4.2 | OAuth SSO only, no audit |
| Next-gen official UI | — | — | prototypes shown 2026-09-23; "ship later, take a long time to evaluate" | — | — |

### k.3 Effective-policy precedence (S@v4.3.6, H)

**Step 1: operator policy merged with user policy.**
- message-ttl, max-length, max-length-bytes, expires → minimum.
- delivery-limit → negative rule (either negative: the larger; otherwise the minimum).
- overflow, queue-version, booleans → the operator value.

**Step 2: merged value resolved against the queue argument, per queue type.**

| Queue type | min(policy, argument) | Argument wins | Policy wins |
| --- | --- | --- | --- |
| Classic | expires, message-ttl, max-length, max-length-bytes | DLX, DLRK, overflow | — |
| Quorum | max-length, max-length-bytes, message-ttl, expires (3.13: policy wins), consumer-disconnected-timeout, delayed-retry-min/max; delivery-limit (negative rule) | DLX, DLRK, dead-letter-strategy | overflow, delayed-retry-type |
| Stream | — | — | retention and segment keys, initial-cluster-size |

**`effective_policy_definition` is policies only, NOT the effective queue setting.**

### k.4 Table stakes and white space

**Table stakes:**
- multi-cluster profiles with environment colours;
- CRUD with type-to-confirm;
- a message browser (JSON tree, binary/hex, search, export);
- side-effect disclosure;
- publish with templates;
- DLQ basics (`x-death` timeline, confirm-then-ack replay, throttle, park, dry run);
- spy;
- topology graph;
- stream offset/timestamp reads;
- effective-policy view;
- live charts;
- keychain credentials and no-telemetry pledges;
- SSH bastion;
- for team tools: RBAC, audit, masking, alerts, OIDC, Helm, PostgreSQL;
- a read-only MCP.

**White space (no competitor has it):**
- version-correct semantics across all eras, backed by a public conformance suite;
- a free, fully open-source team server;
- one engine and one UI for desktop, local web and team;
- admin plus messages plus ops in one product;
- a correct effective-config debugger;
- multi-framework DLQ decoding;
- an OSS stream browser with stage-2 filters;
- a routing simulator covering headers, E2E, AE and DLX, plus topology-as-code diff;
- governed MCP;
- a lint and upgrade advisor.

**Threats:** the next-gen official UI; AI-paced solo vendors (Warren: 10 minor releases in 9 days; QueueLens: 20 releases in 10 days); HZN web (Q4 2026); Warren Team/Pro.

---

## (l) Framework failure formats & decoder priorities (S at tags, H)

| Framework | Where failures go | Exception data | Retry/delay infrastructure (classify `expired` deaths here as scheduled, not failed) |
| --- | --- | --- | --- |
| MassTransit v8.5.10 (v9 wire-identical) | `{q}_error` (MT-Reason=fault), `{q}_skipped` (dead-letter) | `MT-Fault-ExceptionType`, `-Message`/`-StackTrace` (≤2048), `-InputAddress`, `-Timestamp`, `-ConsumerType`, `-MessageType`, `-RetryCount` (int), `MT-Host-*`; content type `application/vnd.masstransit+json` | v8 `{exchange}_delay` (plugin); v9.1+ `mt-delay-{ms}` + `mt-delay-return`, `MT-Original-RoutingKey`; `MT-Redelivery-Count` |
| NServiceBus (RabbitMQ transport 11.2.1) | `error` (often drained by ServiceControl) | `NServiceBus.ExceptionInfo.*`, `FailedQ`, `TimeOfFailure`, `ProcessingEndpoint` | `nsb.v2.delay-level-00..27` (28-bit routing keys); creates **policy `nsb.{q}.delivery-limit` = 100000**; `client_api=NServiceBus` |
| Spring AMQP 4.1.1 / Cloud Stream 5.0.3 | recoverer exchange (`error.` + key) / `{dest}.{group}.dlq` | `x-exception-message`, `x-exception-stacktrace` (**opt-in from 4.0.5/4.1.1**; binder always sets it), `x-original-exchange/-routingKey`, `retry-count` (3.2+); no class header | `{queue}.parkingLot`; `x-delay` |
| EasyNetQ 8.1.11 | `EasyNetQ_Default_Error_Queue` | JSON `Error` body envelope (type `EasyNetQ.SystemMessages.Error`) | `{exchange}_{dd_hh_mm_ss}` |
| Celery 5.6.3 | DLX only (`acks_late` + Reject) | none (`retries`, `id`, `task` headers) | `celery_delayed_0..27` (kombu 5.5+) |
| Symfony 8.1.9 | failure transport | stamps (`X-Message-Stamp-*` JSON, or inside PhpSerializer bodies) | `delays` → `delay_*_retry` |
| Rebus | `error` | `rbs2-error-details`, `rbs2-source-queue` (removes `x-delivery-count`) | — |
| Wolverine | `wolverine-dead-letter-queue` | `exception-*` only with enhanced dead-lettering | `attempts` |
| Laravel (vyuldashev 15.0.2) | `{q}.failed` | none (`failed_jobs` table); `laravel.attempts` table header | `{q}.delay.{ms}` |
| Dramatiq 2.2.1 | `{q}.XQ` (**7-day TTL**) | body `options.traceback`, `options.retries` | `{q}.DQ` |
| Sneakers/Kicks | `{q}-error` | `retry_info` JSON header | `{q}-retry` (counts via `x-death`) |
| Moleculer, Watermill, Brighter, NestJS, golevelup, FastStream, Hutch | various | Moleculer `x-error-*`; Watermill `*_poisoned`; others `x-death` only | NestJS `noAck` defaults to true (failures lost); golevelup REQUEUE default causes poison loops |

**Decoder releases:**
- **v1.0:** a generic broker layer (deaths, counts, infrastructure recognisers), MassTransit, Spring, NServiceBus, EasyNetQ, Celery.
- **v1.1:** Symfony, Rebus, Wolverine, Laravel, Dramatiq, Sneakers.
- **Later:** an SDK for the rest.

**Fingerprinting:** ServiceControl baseline (type + first frame), improved with root cause, first *application* frame and a message template; fall back to framework + type + `x-death[0]` reason/queue.

**Licence hygiene:** never copy MassTransit v9 (source-available) or Particular (RPL-1.5) code; build fixtures from v8 (Apache-2.0).

**Safe decoding:** never unpickle or PHP-unserialize objects.

**Delay plugin:** the official delayed-message plugin is archived (last commit 2026-09-24) with **no 4.3 build**. The CloudAMQP fork supports 4.3.3+ but does not migrate messages already delayed.

**MassTransit v9:** commercial since 9.0.0 (2026-01-06). v8 gets patches "through at least end of 2026". v8 outnumbers v9 downloads by about 4.6:1.

---

## (m) TypeScript engine stack facts & risk register

| Component | Fact (R/S, H) | Verdict |
| --- | --- | --- |
| **amqplib 2.2.0** (2026-09-28, MIT, 0 dependencies, provenance) | EXTERNAL, `updateSecret`, blocked/unblocked, server cancel (callback gets `null`), ConfirmChannel, `get`, `nack(requeue)`. Opt-in recovery with a user `setup()` callback. Heartbeat 0 disables. CI only on RabbitMQ 4.2 / Node 18-24. **84% of 2026 commits by one person.** Do not install `@types/amqplib`. | ✓ |
| **rabbitmq-amqp-js-client 1.0.0** (2026-06-25) | Defects: non-described stream filters (dropped on 4.3); BigInt offsets broken; no vhost (#95); credit fixed at 1000 (#94); link race (#96, ~20k misrouted messages); unencoded addresses; no purge; no typed EXTERNAL; `console.log` in constructors; `rhea: github:amqp/rhea` git dependency; no LICENSE file. | ~ (unfit for the production path) |
| **rhea 3.0.5** (Apache-2.0) | PLAIN, ANONYMOUS, XOAUTH2 and EXTERNAL (needs `enable_sasl_external` + TLS cert); default `credit_window` **1000**; no bigint encoding; decoder-hardening commits unreleased; one npm maintainer. | ~ |
| **rabbitmq-stream-js-client 1.1.0** | Offsets, Bloom, super streams, SAC, EXTERNAL. Its "OIDC" item is **npm trusted publishing**, not RabbitMQ OAuth. Load-balancer resolver only; no secret refresh. CI on RabbitMQ 4.0.5. ISC vs MIT licence mismatch. | ~ |
| @cloudamqp/amqp-client 4.1.1 | PLAIN only (no EXTERNAL); WebSocket; fixed the Node 24.18 `Buffer.poolSize` crash. | ✓ (contract-suite fallback) |
| Node | 24 enters maintenance 2026-10-20 (EOL 2028-04-30); 26 becomes LTS 2026-10-28. `node:sqlite` is a release candidate (24.15+), synchronous, FTS5, with Node 26 renames (DEP0210/0211); no maintained Kysely dialect (~30-line in-repo adapter); Drizzle supports it only in 1.0 RC. | ✓/~ |
| Electron | 40-45 bundle Node 24. **45 GA 2026-10-20** (Chromium 156, Node 24.22.0). 46: `utilityProcess.kill()` sends SIGTERM only; sync `safeStorage` removed. `utilityProcess.fork` only after `ready`. RunAsNode fuse off → `child_process.fork` throws. Playwright Electron support is experimental and needs the nodeCliInspect fuse. | ✓ |
| NestJS 12 (12.0.0 2026-08-27; 12.1.3) | ESM packages; Standard Schema `@Body({schema})`; platform-fastify pins fastify **5.12.5**; @nestjs/swagger 12 `standardSchemaConverter`; **nestjs-zod 5.5.0 does not support Nest 12**; **@nx/nest caps at <12**. | ~ |
| Orval 8.43.0 | Angular `httpClient` / `httpResource`; 43 minors in 2026, so pin exactly. | ✓ |
| Testcontainers 12.2.1 | The RabbitMQ module exposes no 5552 or 15692; Linux runners only (Windows runners can't run Linux containers; macOS runners have no Docker; brew offers rabbitmq 4.3.6). | ~ |
| Single executable | Node SEA `--build-sea` only on 25.5+/26; macOS x64 unsupported; Node 24 SEA needs CommonJS + postject. Do not ship one in v1. | ~ |
| Tauri | WebKitGTK on Tauri 2; Tauri 3 alpha has CEF on GTK4, but WebKitGTK 6 is still an open PR; with a Node sidecar only ~2.3-3× smaller than Electron. | ~ |

**Capability score:** TS libraries as shipped cover 7/17 needed capabilities, Go 16/17, .NET 13 ✓ (4 unverified). With our own rhea adapter, our own management client and a conformance CI, TS reaches 16/17. Estimated extra cost: 6-9 engineer-weeks.

**Risk register (L×I, then residual after mitigation):**

| Risk | Score | Residual |
| --- | --- | --- |
| JS AMQP 1.0 client defects (R1) | 25 | 6 |
| Peek side effects from library defaults: credit 1000, SAC `get` closes the channel (R4) | 20 | 4 |
| Broker version skew; no Node client tests 4.3 (R15) | 16 | 6 |
| No typed management client (R6) | 15 | 2 |
| amqplib bus factor (R3) | 12 | 6 |
| AI agents installing TS 7 or `@types/amqplib` (R10) | 12 | 2 |
| Supply chain / git dependencies (R11) | 10 | 4 |
| rhea single maintainer (R2) | 9 | 6 |
| Runtime drift (R7) | 9 | 4 |
| Throughput / GC (R12) | 9 | 4 |
| `node:sqlite` (R8) | 6 | 2 |
| NestJS 12 ecosystem (R9) | 6 | 2 |
| Stream client (R5) | 6 | 4 |
| Single executable (R13) | 6 | 2 |
| Licence hygiene (R14) | 5 | 1 |

**Pins:**

| Component | Pin |
| --- | --- |
| Node | 24.22.x (CI also 26.12) |
| Electron | 45.0.x (44.8.0 until GA) |
| TypeScript | **6.0.3** |
| NestJS | 12.1.3, swagger 12.0.2, cli 12.0.8 |
| AMQP 0-9-1 | amqplib 2.2.0 |
| AMQP 1.0 | rhea 3.0.5 + own adapter |
| Stream (optional) | stream client 1.1.0 |
| Persistence | kysely 0.29.6, pg 8.23.1 (fallback better-sqlite3 13.0.3) |
| Validation / contracts | zod 4.6.7, orval 8.43.0 |
| Tests | testcontainers 12.2.1, playwright 1.64.1 |

---

## (n) Angular / UI stack facts & licence table (R/S, H)

**Angular 22:**
- Released 2026-06-03; active until 2027-06, LTS until 2028-06; **one major every 12 months** (v23 ~June 2027).
- TypeScript **>=6.0 <6.1**. TS 7.0.2 is npm `latest` but has no compiler API.
- Zoneless by default (v21+); **OnPush by default** in v22.
- Signal Forms, resource and httpResource are `@publicApi 22.0`; `@angular/aria` is stable.
- Vitest is the CLI default.

**PrimeNG is out:**
- From 22.0.0 (2026-07-15) it is proprietary ("PrimeUI License"): key required, compiled-only, **no redistribution as a dev tool**, keys may not be published, no OSS programme.
- The 21.x MIT line peer-depends on Angular ^21.

**Monaco and Nx:**
- Monaco 0.57.0 has ESM tree-shakable entry points (0.56+). **ngx-monaco-editor-v2 22.0.5** is AMD-based and pins ^0.56, so avoid it.
- Nx 23.3 (MIT) supports Angular 20-22 (matrix lists ≤22.1), Vitest 3-5 and Playwright; the module-boundaries rule is free. Conformance and Owners need Nx **Enterprise**. **@nx/nest does not support NestJS 12.**

| Dependency | Version | Licence | Verdict |
| --- | --- | --- | --- |
| @angular/* + cdk + aria | 22.2.3 | MIT | allow |
| Spartan brain/cli/mcp | 1.7.0 | MIT (helm code copied in: keep the notice) | allow |
| Tailwind 4 / tailwind-merge / cva | — | MIT / MIT / Apache-2.0 | allow |
| AG Grid Community + angular | 36.2.0 | MIT (Enterprise features: context menu, clipboard, range selection, set filter, grouping, master/detail, status bar, Excel, Find) | allow (behind an adapter) |
| ag-grid-enterprise | — | commercial | **ban** |
| cytoscape | 3.34.4 | MIT (WebGL preview: straight/haystack/bezier edges, solid colours, provisional) | allow |
| **elkjs** | 0.12.0 | EPL-2.0 OR GPL-3.0+ | **conditional:** elect EPL-2.0; ship unmodified as a separate worker asset with the licence text and a source pointer |
| @dagrejs/dagre | 3.1.1 | MIT | allow (fallback) |
| @foblex/flow / ngx-vflow | 19.3.0 / 2.7.0 | MIT | allow |
| monaco-editor | 0.57.0 | MIT + ThirdPartyNotices | allow (own ESM wrapper) |
| uPlot | 1.6.32 (no npm release since 2025-03-14) | MIT | allow (pin/vendor) |
| echarts / zrender / ngx-echarts | 6.1.0 / 6.1.0 / 22.0.0 | Apache-2.0 (+NOTICE, d3 BSD) / BSD-3 / MIT | allow |
| transloco / @lucide/angular / tinykeys | 8.4.0 / 1.58.0 / 4.0.1 | MIT / ISC (+MIT for Feather icons) / MIT | allow |
| dompurify | 3.4.17 | MPL-2.0 OR Apache-2.0 | allow (elect Apache) |
| primeng ≥22, @primeui/*, apexcharts | — | proprietary / OEM | **ban** |
| electron | — | MIT + Chromium licences | electron-builder **≥26.16.1** keeps the licence files in the macOS .app |

---

## (o) Distribution & signing (D, H)

**macOS:**
- Apple Developer Program: **$99/yr**; the fee waiver excludes individuals.
- Sequoia removed the Control-click Gatekeeper override, so notarise every build.
- **Homebrew** disabled casks failing Gatekeeper from **2026-09-01**; Intel Macs are Tier 3 since 7.0.0, and Homebrew stops running on Intel in Sept 2027.

**Windows:**
- **Microsoft Store:** free registration (ID + selfie). **Store-signed MSIX never shows SmartScreen warnings.** MSI/EXE submissions need your own CA signature.
- **EV certificates no longer bypass SmartScreen.** Smart App Control blocks unsigned files that lack reputation.
- **Azure Artifact Signing:** $9.99/mo; **individuals must be in the US or Canada**; EU organisations are eligible.
- **SignPath Foundation (free):**
  - requires an OSI licence with no commercial dual-licensing;
  - MFA, GitHub-hosted runners and **manual approval per release**;
  - "SignPath Foundation" appears as publisher;
  - **"verifiable reputation"** required, and the project must already be released;
  - **"No hacking tools" clause** (risk for linter features that flag missing passwords);
  - privacy/opt-out rules for data sent to systems the user didn't specify;
  - NSIS is not a supported deep-signing container.
- **Certum Open Source certificate:** €49-69 (renewal and CI automation unverified).

**Linux:** Ubuntu 24.04 AppArmor breaks the Electron sandbox for AppImage (#42510 open). deb/rpm from electron-builder install an AppArmor profile.

**Free infrastructure:** GitHub Actions, GHCR (cosign keyless signing, SBOM), npm trusted publishing with provenance, immutable releases.

**Minimum cost for an EU individual:** ~**$99/yr** (Apple). Windows: Store MSIX, plus SignPath once reputable, or Certum.

---

## (p) Trademark & naming rules (D: WEB:src/pages/trademark-guidelines.md, H)

**Forbidden:**
- "RabbitMQ" in a product, company, binary, package, image, chart or org name (L165-172);
- variations such as **"RMQ"**, "MyRabbitMQ", "RabbitMQ Messaging", "RabbitMQ Guru" (L214-223);
- combination marks like "Foobar RabbitMQ" (L239-243) or "RabbitMQ Foobar";
- "RabbitMQ" or anything confusingly similar in a **domain** (L196-199);
- any use of the **logos**, which are reserved for Broadcom (L154);
- mascots (L209);
- endorsement or "official" claims;
- the mark in titles or metatags for SEO (L245-249).

**Sanctioned:** "<Name> for RabbitMQ" or "<Name>, RabbitMQ Edition" (L95-98, L170-171). "RabbitMQ-powered X" is reserved for noncommercial redistribution of official RabbitMQ bits.

**Attribution:** ® on first use, plus "RabbitMQ is a trademark of Broadcom, Inc. in the U.S. and other countries." (L251-256), plus a non-affiliation line.

**Grey area:** "Rabbit"-prefixed names and rabbit imagery are not explicitly regulated but are high-risk ("takeoff" and "confusingly similar"), and the namespace is crowded (Bunny, Hutch, Warren, ...).

**Listing on rabbitmq.com:** a one-line factual PR to rabbitmq-website `client-libraries/devtools.md`.
