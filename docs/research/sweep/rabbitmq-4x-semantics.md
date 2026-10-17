# RabbitMQ 4.x semantics and roadmap

> **Pre-verification research (2026-10-16).** Where this conflicts with [`docs/research/fact-sheet.md`](../fact-sheet.md), the fact sheet wins. Content about a specific third-party product was removed under the docs policy ([ADR-034](../../adr/ADR-034-docs-policy.md)).

_Research angle `rabbitmq-4x-semantics` · 2026-10-16_

## Executive summary

RabbitMQ changed a lot between 4.0 (September 2024) and 4.3 (2026-04-23, latest patch 4.3.6). 4.4 has not shipped yet, but quorum-queue features aimed at it are already merged on main. A tool that wants to be the default choice has to understand the versions, not only call the HTTP API.

1) **Many versions to support.** Commercial support runs to 2029 for 3.13 and to 2030 for 4.2. The tool needs a capability registry keyed on version, plugins and feature flags.

2) **Metadata store.** Khepri became the default for new clusters in 4.2.0. Mnesia was removed in 4.3.0. Metadata changes now need a majority of nodes online.

3) **AMQP 1.0.** It is a core protocol and has official clients for Java, .NET, Go, Python and JavaScript (the JS one is early-stage). Their topology API cannot list objects, so the HTTP API is still required.
   - AMQP 1.0 over WebSocket is Tanzu-only, so a browser on open-source RabbitMQ cannot speak AMQP.
   - The web edition therefore needs a server-side protocol gateway.

4) **No safe "peek" for classic or quorum queues.** Every peek takes the message and puts it back, and the stock UI's "Get messages" does the same. The effect on quorum queues depends on the version:
   - **4.0 to 4.2:** every put-back counts toward the delivery limit, which defaults to 20. After that the message is dead-lettered, or dropped if there is no dead-letter exchange.
   - **4.3 and later:** nack and AMQP 1.0 released are safe. basic.reject still counts. A message already dead-lettered for hitting the limit can be dropped from a quorum dead-letter queue on its first put-back.
   - Only the CLI command `rabbitmq-queues peek` has no side effects, and it has no HTTP or AMQP equivalent.
   - Streams are the only queue type you can read without removing anything. The open-source UI cannot browse them; Tanzu 4.3 sells a Stream Browser. That gap is an opening for this tool.

5) **Live capture has trade-offs.** Binding a temporary capture queue is cheap but has blind spots:
   - It cannot see messages published to the default exchange.
   - It changes the outcome for unroutable messages (alternate exchange, mandatory flag).
   - On hash or random exchanges it takes messages away from the real queues.
   - Firehose tracing sees everything, but it is per node and per vhost, resets on restart, and costs throughput.

6) **Re-publishing dead letters.** 4.x ignores the x-death header a client sends and overwrites it the next time the message is dead-lettered. The tool must write its own redrive headers.

7) **4.3 restrictions.** Several deprecated features are now denied by default (transient non-exclusive queues, global QoS, AMQP address v1). Passive declares need configure permission. Consumer timeouts apply only to quorum queues.

## Report

# RabbitMQ 4.x broker semantics for an advanced management and developer tool
Research date: 2026-10-16.
- **FACT**: sourced.
- **INFERENCE**: my reasoning from sources or code.
- **IDEA**: a proposal.
- Sources are given inline; "src" means RabbitMQ server source code on GitHub at the stated tag.

---

## 1. Version landscape the tool must support

| Series | First GA | Latest patch | Community support ends | Commercial support ends |
| --- | --- | --- | --- | --- |
| 3.13 | 2024 | 3.13.7 (2024-08-26) | 2024-09-30 | **2029-12-31** |
| 4.0 | 4.0.1 (2024-09-19) | 4.0.9 (2025-04-14) | 2025-04-30 | 2026-09-30 |
| 4.1 | 4.1.0 (2025-04-15) | 4.1.8 (2026-01-22) | 2026-01-31 | 2027-04-30 |
| 4.2 | 4.2.0 (27 Oct 2025) | 4.2.11 (2026-09-16) | 2026-07-31 | **2030-06-30** |
| 4.3 | 4.3.0 (2026-04-23) | 4.3.6 (2026-09) | 2027-01-31 | 2028-04-30 |
| 4.4 | not released; milestone-4.4.0 PRs merged on main | - | - | - |

**FACT.** Sources:
- https://www.rabbitmq.com/release-information
- https://github.com/rabbitmq/rabbitmq-server/releases (no 4.4 or 5.0 pre-release is listed)
- Amazon MQ has offered 4.3 since 2026-09-10: https://aws.amazon.com/about-aws/whats-new/2026/09/amazon-mq-rabbitmq-43/

**INFERENCE.** Enterprises will run 3.13 (which still has classic mirrored queues) and 4.2 for years. The tool must treat three semantic eras as first-class:
- 3.13
- 4.0 to 4.2 (old quorum-queue counting)
- 4.3 and later (new counting, Khepri only)

A version, plugin and feature-flag capability registry is therefore core architecture.

---

## 2. Changes by release that affect a tool

### 4.0
Source: https://github.com/rabbitmq/rabbitmq-server/releases/tag/v4.0.1
- Classic queue mirroring removed.
- CQv1 (classic queue storage v1) removed, except for the code needed to upgrade.
- AMQP 1.0 is now a core protocol that is always on; its plugin is a no-op.
- Quorum queues:
  - default `delivery-limit` is 20;
  - support priorities (2 levels);
  - single active consumer (SAC) respects consumer priorities.
- Khepri is "fully supported" but not the default.
- Client-published `x-death` headers are no longer interpreted.
- New `x-local-random` exchange: https://www.rabbitmq.com/docs/local-random-exchange

### 4.1
Source: https://github.com/rabbitmq/rabbitmq-server/releases/tag/v4.1.0
- AMQP property filter expressions for streams.
- Quorum-queue log reads offloaded to channels.
- Management UI shows AMQP 1.0 sessions and links, and gains a dark theme.
- Pre-auth `frame_max` raised to 8192 (`amqplib` must be 0.10.7 or later).
- MQTT maximum packet size default lowered to 16 MiB.
- Required feature flags are enabled automatically on boot.
- `rabbitmqctl force_reset` deprecated.

### 4.2
Source: https://github.com/rabbitmq/rabbitmq-server/releases/tag/v4.2.0
- Khepri is the default for **new** deployments.
- SQL filter expressions for streams.
- Direct Reply-To over AMQP 1.0.
- Incoming and outgoing message interceptors.
- `local` shovels.
- Queue types can be disabled.
- New `protected` user tag.
- Web MQTT and Web STOMP use HTTP/2 by default.
- **Breaking:** an AMQP 1.0 message with no header section is now treated as non-durable.

### 4.3
Sources: https://github.com/rabbitmq/rabbitmq-server/releases/tag/v4.3.0 and https://www.rabbitmq.com/blog/2026/04/23/rabbitmq-4.3-release

- **Metadata store.** Mnesia removed. Partition-handling settings are ignored. "a majority of nodes must be online at all times".
- **Deprecated features.**
  - Now denied by default: `transient_nonexcl_queues`, `global_qos`, `amqp_address_v1`, `amqp_filter_set_bug`, `queue_master_locator`.
  - `ram_node_type` removed.
  - CQv1 declarations fail.
- **Quorum queues** (Ra 3.x):
  - the delivery limit is based on `delivery-count` ("unlimited explicit message returns");
  - new `x-acquired-count` header;
  - delayed retry;
  - graceful consumer timeout;
  - 32 strict priority levels;
  - delivery limit can be changed by policy;
  - purge also removes pending at-least-once dead letters.
- **Consumer timeouts** "are no longer evaluated for classic queues and streams".
- **Permissions.** `configure` permission is now required for **passive** declares.
- **Exchanges.** `x-modulus-hash` moved into core.
- **AMQP 1.0.** The Rejected outcome now carries the queue and the reason (`maxlen` or `unavailable`). SAC activity changes are signalled to the client.
- **Management.**
  - UI shows delayed-retry state, per-priority counts and consumer-timeout state.
  - New `GET /api/users/{user}/queues`.
  - `GET /api/auth` removed.
  - `effective_policy_definition` is `{}` when no policy applies.
  - Deleting a shovel or restarting a federation link needs the `policymaker` tag.
- **Prometheus.** `/metrics/detailed?queue=<regex>`.
- **Upgrade.** In-place upgrade only from 4.2.x. Required feature flags:
  - `rabbitmq_4.2.0`
  - `rabbitmq_4.1.0`
  - `rabbitmq_4.0.0`
  - `khepri_db`
  - `quorum_queue_non_voters`
  - `message_containers_deaths_v2`

### 4.4 (unreleased)
- **FACT.** PR #16583 "QQ: v9" was merged on 2026-09-04: https://github.com/rabbitmq/rabbitmq-server/pull/16583. It adds:
  - **delayed delivery**: messages with a future `x-opt-delivery-time` go into a delayed bucket;
  - **deferral**: a consumer returns a message with the `modified` outcome plus `x-opt-deferral-token`, and later claims it by listing tokens in the FLOW-frame property `rabbitmq:deferred-tokens` (link capability `rabbitmq:deferred-tokens`; tokens up to 256 bytes);
  - per-node ingress byte tracking.
- **FACT.** Follow-up PRs carry the 4.4.0 milestone: https://github.com/rabbitmq/rabbitmq-server/pulls?q=is%3Apr+deferral
- **FACT.** The archived delayed-message-exchange README says "Starting with version 4.4, quorum queues natively support message delivery delay".
- **INFERENCE.** New quorum-queue message states (delayed, deferred) will be invisible to `basic.get`-style browsing.

---

## 3. Metadata store (Khepri)

**FACT** (https://www.rabbitmq.com/docs/metadata-store, https://www.rabbitmq.com/blog/2025/09/01/6-khepri-default):
- Version history:
  - 3.13: experimental;
  - 4.0: fully supported (3.13 clusters with Khepri enabled must upgrade blue/green);
  - 4.2: default for new deployments; existing Mnesia clusters stay on Mnesia until `khepri_db` is enabled, and that migration is irreversible;
  - 4.3: Khepri is the only store.
- Khepri uses Raft. Metadata changes such as declarations fail without a majority; reads still work on a minority.
- Health endpoints: `/api/health/checks/metadata-store/initialized` and `/with-data` (from `rabbit_mgmt_dispatcher.erl` on main).

**FACT** (https://github.com/rabbitmq/rabbitmq-server/discussions/14977): after Khepri was enabled on 4.2, `rabbitmq_delayed_message_exchange` made `GET /api/exchanges` return HTTP 500 until the plugin was re-enabled. The Kubernetes Cluster Operator auto-enables feature flags on upgrade.

**INFERENCE for the tool:**
- Show which metadata store is in use.
- Report "metadata unavailable (no majority)" as its own error class.
- Gate the `khepri_db` enable action behind a strong warning.

---

## 4. AMQP 1.0 and the official clients

**Addressing.** **FACT** (https://www.rabbitmq.com/docs/4.1/amqp, https://www.rabbitmq.com/docs/amqp):
- Address v2 targets: `/exchanges/:x/:rk`, `/exchanges/:x`, `/queues/:q`, `null`.
- Sources can only be `/queues/:q`. AMQP 1.0 cannot subscribe to an exchange without first declaring a queue and binding.
- v1 was deprecated in 4.0 and is denied by default in 4.3.

**Outcomes. FACT.**
- Publisher outcomes: `released` means the message was unroutable.
- Consumer outcomes:
  - `accepted` deletes the message;
  - `rejected` dead-letters it;
  - `released` requeues it;
  - `modified` with `undeliverable-here=true` dead-letters it, otherwise requeues it.
- `modified` can change annotations on quorum queues only, not classic queues.

**Clients. FACT** (https://www.rabbitmq.com/client-libraries/amqp-client-libraries): official AMQP 1.0 clients exist for:
- Java
- .NET
- Go
- Python
- JavaScript (https://github.com/coders51/rabbitmq-amqp-js-client: rhea-based, early-stage, about 9 stars)

All require RabbitMQ 4.0 or later.

**Topology over AMQP 1.0. FACT** (`rabbit_amqp_management.erl`): an HTTP-over-AMQP request/response link pair supports:
- `GET`, `PUT` and `DELETE` on `/queues/:q` (info includes `message_count`, `consumer_count`, `type`, `arguments`, `replicas`, `leader`);
- `DELETE /queues/:q/messages` (purge);
- `PUT` and `DELETE` on `/exchanges/:x`;
- `POST /bindings`, `GET /bindings?src&key&dstq|dste`, `DELETE /bindings/:seg`;
- `PUT /auth/tokens`.

It cannot list queues or exchanges and cannot manage policies, users, vhosts or permissions.

**INFERENCE.** The HTTP API remains mandatory for management. AMQP 1.0 is the best data plane: explicit outcomes, stream filters, and a faithful view of messages published over AMQP 1.0.

**WebSocket. FACT.** AMQP 1.0 over WebSocket (`rabbitmq_web_amqp`, example `ws://host:15678/ws`) is "a closed-source feature available exclusively in the commercial VMware Tanzu RabbitMQ" (4.1+): https://www.rabbitmq.com/blog/2025/04/16/amqp-websocket. The 4.3 AMQP docs still describe it as Tanzu-only.

**INFERENCE.** On open-source RabbitMQ a browser cannot use AMQP 0-9-1, AMQP 1.0 or the stream protocol. Its only direct options are:
- the HTTP API (needs `management.cors.allow_origins` or a same-origin proxy: https://www.rabbitmq.com/docs/management);
- Web STOMP;
- Web MQTT.

---

## 5. Quorum queues

### 5.1 Delivery counting (the key semantic for any browsing feature)

| Action on a quorum-queue message | 4.0 to 4.2: counter checked against the limit | 4.0 to 4.2: counts toward limit? | 4.3+: `x-delivery-count` | 4.3+: `x-acquired-count` | 4.3+: counts toward limit? |
| --- | --- | --- | --- | --- | --- |
| AMQP 0-9-1 `basic.nack` requeue=true | acquired_count +1 | **yes** | no | +1 | no* |
| AMQP 0-9-1 `basic.reject` requeue=true | acquired_count +1 | **yes** | **+1** | +1 | **yes** |
| AMQP 1.0 `released` | +1 | **yes** | no | +1 | no* |
| AMQP 1.0 `modified`, delivery-failed=false | +1 | **yes** | no | +1 | no* |
| AMQP 1.0 `modified`, delivery-failed=true | +1 | yes | +1 | +1 | yes |
| AMQP 1.0 `rejected` (dead-letters) | n/a | n/a | +1 | +1 | (dead-lettered) |
| Client crash or connection loss | +1 | yes | +1 | +1 | yes |
| Consumer timeout (4.3) | n/a | n/a | no | +1 | no |

\* The limit check still runs on every return; see "carry-over" below.

**FACT, verified in source code:**
- In 4.0.1 and 4.2.0, `rabbit_fifo:return_one` compares `acquired_count > DeliveryLimit`. `incr_msg` increments `acquired_count` on every return and `delivery_count` only when the delivery failed.
- In 4.2.0, `rabbit_fifo_client` sets the 0-9-1 header `x-delivery-count` to `acquired_count`. In 4.3.0 it maps `x-delivery-count` to `delivery_count` and adds `x-acquired-count`. In both, `redelivered` is true when `acquired_count > 0`.
- On main, `rabbit_channel` maps nack-requeue to `requeue` and reject-requeue to `settle(true,false)`, which means delivery failed. In 4.0.1 both mapped to `requeue`.
- The 4.3 table is documented at https://www.rabbitmq.com/docs/quorum-queues.

**FACT: 4.3 checks the limit on every return.** In 4.3.0 `return_one` compares `delivery_count > limit` whether or not the counter was incremented.

A community test on 4.3.6 (https://dev.to/viktorbaumann/your-quorum-dead-letter-queue-can-drop-the-dead-letters-x-delivery-count-travels-along-240n) reports the following. A message dead-lettered for `delivery_limit` arrives in a quorum dead-letter queue with its count already over 20. The next return is any nack, "peek" or crash, and that return drops it, unless the dead-letter queue has its own dead-letter exchange or a higher or -1 limit. Confidence: **medium**. This needs a test matrix.

**Other effects of a return:**
- Returned messages go to a "returns" queue and are redelivered in the order they were returned, **ignoring priority** (4.3 docs).
- The 4.2 docs say returns go "to the back of the queue if no delivery-limit is set" (https://www.rabbitmq.com/docs/4.2/quorum-queues).
- With 4.3 delayed retry, type `returned` delays explicit returns such as nack, and type `all` delays every return.

### 5.2 Other quorum-queue semantics

**Priorities. FACT.**
- 4.0 to 4.2: two internal levels (above 4 is high, 0 to 4 is normal), served 2:1.
- 4.3: 32 strict levels (0 to 31). No opt-in; a message with no priority is treated as 4. `x-max-priority` is ignored for quorum queues.

**Consumer timeout (4.3). FACT.**
- Set by consumer argument, `x-consumer-timeout`, policy key `consumer-timeout`, or the global `consumer_timeout`.
- When it fires: AMQP 1.0 clients get `DISPOSITION(released)`; AMQP 0-9-1 consumers get `basic.cancel` (if the client supports cancel notification), otherwise the channel is closed.
- `consumer_disconnected_timeout` defaults to 60 s.
- The docs disagree on the global default (30 min or undefined).

**Delayed retry (4.3). FACT.**
- Configured with `x-delayed-retry-type` (`disabled`, `all`, `failed`, `returned`), `x-delayed-retry-min` and `x-delayed-retry-max`, or the matching policy keys.
- Delay is `min(min*delivery_count, max)`.
- An AMQP 1.0 consumer can override it with `x-opt-delivery-time` in a `modified` outcome.

**Placement, membership and rebalancing. FACT.**
- Single active consumer: works on classic and quorum queues.
- Leader locator: `client-local` (default) or `balanced`.
- Continuous membership reconciliation:
  - config keys `quorum_queue.continuous_membership_reconciliation.*`;
  - policy key `target-group-size`;
  - queue argument `x-quorum-target-group-size`.
- Rebalance: `rabbitmq-queues rebalance quorum` or `/api/rebalance/queues`.

**HTTP API for replicas. FACT** (dispatcher):
- `/api/queues/quorum/:vhost/:q/status`
- `/api/queues/quorum/:vhost/:q/replicas/add` and `/replicas/delete`
- `/api/queues/quorum/replicas/on/:node/grow` and `/shrink`
- `/api/health/checks/node-is-quorum-critical`

**At-least-once dead-lettering. FACT.** Needs `dead-letter-strategy=at-least-once` and `overflow=reject-publish`.

**Stats fields in 4.3. FACT** (`rabbit_quorum_queue.erl`):
- `messages_ready_high`, `messages_ready_normal`, `messages_ready_returned`
- `messages_by_priority`
- `messages_delayed`, `next_delayed_at`
- `delivery_limit`, `delayed_retry`
- `messages_dlx`, `message_bytes_dlx`
- `members`, `online`, `leader`
- `single_active_consumer_tag`

**INFERENCE.** Every acquire and return on a quorum queue is a replicated Raft command, so bulk peeking costs disk I/O on every member.

**Known issue (from search snippet, verify).** A `delivery-limit: -1` *policy* reportedly causes policy re-application every 5 s and growth in segment files (issue #14202).

---

## 6. Classic queues

**FACT:**
- Only v2 storage remains.
- Mirroring removed in 4.0.
- A requeued message goes back to "its original position in its queue, if possible", with `redelivered=true` (https://www.rabbitmq.com/docs/confirms).
- No delivery limit.
- Annotations sent in a `modified` outcome are not supported.
- Since 4.3 no consumer timeout is enforced.

**INFERENCE.** A buggy browser holding unacknowledged classic-queue messages blocks them until its connection closes. The tool must auto-release them itself.

---

## 7. Streams and super streams

**Reading. FACT** (https://www.rabbitmq.com/docs/streams, `rabbit_stream_queue.erl`):
- Reading is non-destructive by design.
- Over AMQP 0-9-1, `basic.consume` takes `x-stream-offset`: `first`, `last`, `next`, an offset, a timestamp or an interval. It requires prefetch, manual acks (acks only grant credit) and no global QoS.
- **`basic.get` is "not supported by stream queues"**, so the management UI's "Get messages" is unavailable for streams.
- Over AMQP 1.0, the source filter set uses `rabbitmq:stream-offset-spec`, `rabbitmq:stream-filter`, `rabbitmq:stream-match-unfiltered`, `amqp:properties-filter`, `amqp:application-properties-filter` and `amqp:sql-filter` (constants from the Python client).
- STOMP supports `x-stream-offset` too: https://www.rabbitmq.com/docs/stomp

**Retention. FACT.** `max-age` and `max-length-bytes` are evaluated per segment; at least one segment always remains.

**Offset tracking, SAC and super streams. FACT.**
- Server-side offset tracking is available only through the stream protocol.
- SAC for streams has existed since 3.11.
- A super stream is a direct exchange with argument `x-super-stream=true`, partition streams, and bindings with argument `x-stream-partition-order` (`rabbit_stream_manager.erl`).

**Filtering. FACT** (https://www.rabbitmq.com/docs/stream-filtering):

| Stage | Introduced | Protocols | Notes |
| --- | --- | --- | --- |
| Bloom filter | 3.13 | all | `x-stream-filter-value`; false positives possible |
| AMQP property filters | 4.1 | AMQP 1.0 only | prefix and suffix matching |
| SQL filters | 4.2 | AMQP 1.0 only | `=, <>, <, >, AND, OR, NOT, IN, IS NULL, LIKE, BETWEEN`; header (priority only), properties, application-properties |

**Stream protocol. FACT** (https://www.rabbitmq.com/docs/stream):
- Ports 5552 and 5551 (TLS).
- `advertised_host` and `advertised_port` exist because clients connect to the node that hosts the leader or replica, which breaks behind Docker, NAT or port-forward.
- Official stream clients: Java, Go, .NET, Rust, Python (rstream). Node.js clients are community-maintained.
- 4.3 adds `stream.read_ahead`.

---

## 8. Shovels, federation, interceptors, delayed messages

**Shovels. FACT** (https://www.rabbitmq.com/docs/shovel, https://www.rabbitmq.com/docs/shovel-dynamic):
- Protocols: `amqp091`, `amqp10`, and `local` (4.2+, same cluster only, intra-cluster connections with internal AMQP 1.0 credit flow).
- `src-delete-after`: `never`, `queue-length` (the queue length measured at start) or a number. It cannot be combined with `no-ack`.
- `ack-mode`: `on-confirm` (safest), `on-publish` or `no-ack`.
- `dest-add-forward-headers` adds `x-shovelled`. `dest-add-timestamp-header` adds `x-shovelled-timestamp` (seconds) or, for AMQP 1.0, `creation_time` (ms).
- 4.3 adds `src-consumer-name`.

**Management UI "Move messages". FACT** (`queue.ejs`): it creates a shovel with:
- name `Move from <queue>`
- amqp091 on both sides
- prefetch 1000
- `src-delete-after=queue-length`
- `ack-mode=on-confirm`
- no forward headers
- offset `first` for streams

It requires the shovel management plugin and the policymaker tag.

**Federation. FACT.** Exchanges and queues are federated through the `federation-upstream` parameter and `federation-upstream-set` policy. Link status: `/api/federation-links`.

**Message interceptors. FACT** (https://www.rabbitmq.com/docs/message-interceptors):
- They are Erlang modules configured in `rabbitmq.conf`, so a client cannot toggle them.
- Built-ins add `x-opt-rabbitmq-received-time`, `x-routed-by`, `x-opt-rabbitmq-sent-time` and `x-opt-mqtt-client-id`.
- They run for AMQP 1.0, AMQP 0-9-1 and MQTT; stream-protocol messages bypass them.

**Delayed-message-exchange plugin. FACT** (https://github.com/rabbitmq/rabbitmq-delayed-message-exchange):
- Repository archived on 2026-09-24: "Team RabbitMQ no longer maintains this project".
- It is based on Mnesia and therefore incompatible with 4.3.
- It keeps one non-replicated copy and does not support the mandatory flag.
- Suggested alternatives: native quorum-queue delays in 4.4, TTL plus dead-lettering, or Tanzu delayed queues.

---

## 9. Deprecations, feature flags and upgrade gates

**FACT** (https://www.rabbitmq.com/docs/deprecated-features):
- Phases: permitted, denied, disconnected, removed.
- Config key pattern: `deprecated_features.permit.<name>`.
- Endpoints: `GET /api/deprecated-features` and `/used`. Some features cannot be detected (for example global QoS).
- `management_metrics_collection` is deprecated; Prometheus is recommended instead (https://www.rabbitmq.com/release-information/deprecated-features-list).

**Feature flags. FACT.** `GET /api/feature-flags` and `PUT /api/feature-flags/:name/enable`.

**INFERENCE.** An "upgrade readiness" scanner can be built entirely from these endpoints plus the topology.

---

## 10. Protocols reachable from a browser

**FACT:**
- MQTT 5.0 has been supported since 3.13 (https://www.rabbitmq.com/blog/2023/07/21/mqtt5).
- MQTT uses `amq.topic` and maps `/` to `.`.
- QoS 0 sessions use a pseudo queue type.
- The retained-message store is node-local.
- Web STOMP listens on `ws://host:15674/ws`. STOMP destinations are `/exchange/<x>/<pattern>` (exclusive, auto-delete subscriber queue), `/amq/queue/<q>` (existing queue) and `/topic`.
- 4.3 adds `allow_origins` for Web MQTT and Web STOMP.

**INFERENCE.** A STOMP `/exchange/...` subscription is a wire-tap available from the browser on open-source RabbitMQ, and STOMP plus `x-stream-offset` gives browser-side stream reading. Both need the Web STOMP plugin enabled.

---

## 11. Tanzu (commercial-only) features

**FACT** (https://techdocs.broadcom.com/us/en/vmware-tanzu/data-solutions/tanzu-rabbitmq-rpm/4-3/tanzu-rabbitmq-rpm-offering/site-release-notes.html, the 4.3 blog):
- AMQP 1.0 over WebSocket (4.1+).
- Warm Standby Replication and Schema Definition Sync.
- Delayed queues: `x-queue-type: delayed`, Raft plus RocksDB, headers `x-opt-delivery-time`, `x-opt-delivery-delay`, `x-delay`; introduced in 4.2.2.
- 4.3 Message Scheduler.
- **JMS queue type** with message selectors and **queue browsers** (4.3).
- **Stream Browser UI** (4.3): browse by offset or timestamp, view AMQP 1.0 sections, download ranges.
- **Linter** (4.3).
- Stream shovel protocol.
- Spark connector.

rabbitmqadmin v2 has commands for Schema Definition Sync and Warm Standby Replication: https://github.com/rabbitmq/rabbitmqadmin-ng

**INFERENCE.** Stream browsing and linting are paid features today, which makes them open-source differentiators for this tool.

---

## 12. Kubernetes operators

**Cluster Operator. FACT** (https://www.rabbitmq.com/kubernetes/operator/using-operator):
- Resource `RabbitmqCluster` (`rabbitmq.com/v1beta1`).
- Secret `<name>-default-user` with keys `username`, `password`, `host`, `port`, `connection_string`, `provider`, `type`.
- Service ports 5672, 15672, 15692 and 5552.

**Messaging Topology Operator. FACT** (https://github.com/rabbitmq/messaging-topology-operator):
- `v1beta1` kinds: Binding, Exchange, Federation, OperatorPolicy, Permission, Policy, Queue, SchemaReplication, Shovel, TopicPermission, User, Vhost.
- `v1alpha1` kind: SuperStream.
- Queue arguments are immutable after creation.
- `deletionPolicy` is `delete` or `retain`.

**Recent operator release (verify version).** The HTTP startup probe needs RabbitMQ 4.2.4+ or 4.3.0+, and the default image was bumped to 4.3.4 (https://github.com/rabbitmq/cluster-operator/releases).

---

## 13. Critical semantics

### 13.1 Non-destructive browsing

**Management HTTP API `POST /api/queues/{vhost}/{q}/get`.**
- **FACT** (`rabbit_mgmt_wm_queue_get.erl`, v4.0.0 and main):
  - It issues `count` × `basic.get` on an internal channel, then settles each message.
  - `ack_requeue_true` (UI label "Nack message requeue true") uses **basic.nack requeue=true**.
  - `reject_requeue_true` uses **basic.reject requeue=true**.
  - `ack_requeue_false` uses `no_ack` (destructive).
  - `reject_requeue_false` dead-letters or drops.
- **FACT.** The docs say the endpoint is "for development and troubleshooting only", and the UI warns "getting messages from a queue is a destructive action".

| Queue type | Truly non-destructive read? | Best available method | Side effects |
| --- | --- | --- | --- |
| Classic | No | get or consume, then nack/released requeue | Message invisible to consumers while held; `redelivered` set; position "original if possible"; no server-side timeout in 4.3 |
| Quorum, 4.0 to 4.2 | No | same | **Every return counts toward the limit (default 20)**; past it the message is dead-lettered (`delivery_limit`) or **dropped**; 0-9-1 `x-delivery-count` rises |
| Quorum, 4.3+ | No | nack or AMQP 1.0 `released` / `modified(df=false)`; **never `basic.reject`** | `x-acquired-count`+1 and `redelivered`; may be delayed under delayed-retry `returned`/`all`; carry-over drop risk in quorum dead-letter queues |
| Quorum, any version | Yes, CLI only | `rabbitmq-queues peek <queue> <position>` (leader aux command, read-only) | Needs Erlang distribution access to the node; **no HTTP or AMQP equivalent** (dispatcher route list, AMQP management ops) |
| Stream | Yes | AMQP 0-9-1 consume with offset, AMQP 1.0 offset-spec, stream protocol, STOMP | Read I/O only; never reuse an application's consumer name or SAC group or stored offset |
| Exclusive (any type) | No | n/a | Other connections get RESOURCE_LOCKED |

Notes on the table:
- `peek` source: https://www.rabbitmq.com/docs/man/rabbitmq-queues.8 and `rabbit_quorum_queue:peek/2` in src.

**INFERENCE: hazard checklist for a "safe peek" feature.**
- Settle within seconds.
- Never close a channel while it holds deliveries (that counts as a crash).
- Read the effective delivery limit and each message's counters before returning.
- Use AMQP 0-9-1 basic.get for SAC queues rather than consume.
- Warn that held messages create out-of-order processing when application consumers are active.

### 13.2 Live traffic capture

**Wire-tap** (how rabtap works: https://raw.githubusercontent.com/jandelgado/rabtap/master/README.md). A temporary exclusive classic queue is bound to the exchange, or to a tap exchange through an exchange-to-exchange (E2E) binding.

**Blind spots and side effects:**
1. **The default exchange cannot be tapped** ("tapping the default exchange is currently impossible"). Publishes made directly to a queue's name, and dead-lettering through `""`, are invisible.
2. **E2E chains.** RabbitMQ routes once over the union of bindings (https://www.rabbitmq.com/docs/exchanges), so a tap on a downstream exchange sees upstream traffic, with no duplicates.
3. **INFERENCE: taps can take messages away from real queues.**
   - `x-consistent-hash`, `x-modulus-hash` ("Hash mod N"; https://www.rabbitmq.com/docs/modulus-hash-exchange), `x-local-random` ("one of them will be picked at random") and the random exchange send each message to one destination.
   - A tap queue becomes one of those destinations and **steals messages**. Tap an upstream exchange instead, or use firehose.
4. **INFERENCE: taps change routing outcomes.**
   - Unroutable messages become routed, so the alternate exchange and the mandatory `basic.return` stop firing.
   - A tap queue with `overflow=reject-publish` can make publishers receive nacks. Use `max-length` with `drop-head` and a TTL.
5. **Queue constraints.**
   - **FACT.** 4.3 denies transient non-exclusive queues, so tap queues must be exclusive.
   - **FACT.** 4.2 can disable queue types; disabling classic queues breaks taps.
   - Declare `x-queue-type=classic` explicitly.
6. **AMQP 1.0** needs an explicit queue declaration and binding, because v2 sources are queues only.

**Firehose. FACT** (https://www.rabbitmq.com/docs/firehose, `rabbit_trace.erl`):
- Enabled "on a per-node, per-vhost basis" and not persisted across restarts.
- Throughput "will drop somewhat" while on.
- Routing keys: `publish.<exchange>` (the default exchange gives `publish.`) and `deliver.<queue>`.
- Headers: `exchange_name`, `routing_keys`, `properties`, `node`, `vhost`, `connection`, `channel`, `user`, `redelivered`, and **`routed_queues`** on publish.
- The state lives in node-local application environment.
- **INFERENCE** from `rabbit_vhost:put_vhost`: the HTTP API toggle `PUT /api/vhosts/{v}` `{"tracing":true}` only enables tracing on the node that serves the request.
- **INFERENCE:** stream-protocol publishes are probably not traced.

**`rabbitmq_tracing` plugin.**
- **FACT:** still shipped in 4.3. It writes per-node trace files and exposes `/api/traces` and `/api/trace-files` (`rabbit_tracing_mgmt.erl`).

**IDEA:** "capture to stream", where a stream with limited retention is bound as a shared, replayable team capture. It has the same routing caveats as a wire-tap.

### 13.3 Moving and copying messages, and dead-letter redrive

**Server-side move:**
- A dynamic shovel with `src-delete-after=queue-length` and `on-confirm` (the same design as the UI's Move).
- Prefer `local` shovels on 4.2+ within one cluster.
- Expect duplicates if a shovel restarts.

**Client-side redrive** (INFERENCE):
- Consume with manual acks.
- Publish with confirms and `mandatory`.
- Ack the source only after the confirm.
- Throttle.

**`x-death` in 4.x. FACT** (DLX docs, release notes, `mc_amqpl.erl`, `mc.erl`):
- `x-death` is an array of `{queue, reason, count, exchange, routing-keys, time, original-expiration}`, compressed per `{queue, reason}`.
- `x-first-death-queue/reason/exchange` is set once; `x-last-death-*` is updated on each death.
- AMQP 1.0 clients see `x-opt-deaths` (with `first-time`, `last-time`, `ttl`).
- Reasons: `rejected`, `expired`, `maxlen`, `delivery_limit`.
- **4.x keeps a client-published `x-death` as an opaque header and does not interpret it.** On the next dead-lettering, the broker's own record *replaces* the `x-death` header.

**INFERENCE.** A redrive tool must write its own headers (for example `x-redrive-count`, `x-redriven-from`, `x-redriven-at`). Spring Cloud Stream made the same move to custom retry headers.

**Conversions. FACT** (https://www.rabbitmq.com/docs/conversions):
- Messages are stored in their original protocol format; streams always store AMQP 1.0.
- 0-9-1 to 1.0: headers that are arrays or tables are **not converted**.
- 1.0 to 0-9-1: `amqp-value` and multiple-data bodies arrive as encoded binary with `type=amqp-1.0`.
- **IDEA:** the viewer should show which protocol it read the message through and flag lossy conversions.

---

## 14. Tool requirements table

| Feature | Protocol / API needed | Side effects / risks | Min RabbitMQ version |
| --- | --- | --- | --- |
| Topology list (queues, exchanges, bindings, policies) | HTTP API with `page_size` ≤500, `columns`, `disable_stats`, `enable_queue_totals` | Heavy on large clusters | any |
| Topology changes without HTTP | AMQP 1.0 management node | No listing, policies or users | 4.0 |
| Queue metrics, time series | HTTP stats (may be disabled or deprecated) or Prometheus `/metrics/detailed` (`family`, `vhost`, `queue` regex) | Per-object scrapes are expensive | Prometheus 3.8+; queue filter 4.3 |
| Peek, classic queue | 0-9-1 get/consume + nack, or AMQP 1.0 + `released`, or HTTP `ack_requeue_true` | Held messages invisible; `redelivered`; reordering | any |
| Peek, quorum queue (old counting) | same | **Each return counts toward the limit (20)**, then dead-letter or **drop** | 4.0 to 4.2 |
| Peek, quorum queue (new counting) | nack, `released` or `modified(df=false)`; never reject | `x-acquired-count`+1; delayed-retry may delay; DLQ carry-over drop | 4.3 |
| True peek, quorum queue | `rabbitmq-queues peek` (CLI, Erlang distribution) | None on messages; needs node access | 3.8+ |
| Browse stream | 0-9-1 `x-stream-offset` (prefetch + manual ack), AMQP 1.0 offset-spec, stream protocol, STOMP | None; read I/O; consumer-name collisions | 3.9+; Bloom 3.13; property filters 4.1; SQL 4.2 |
| Live tail (wire-tap) | Exclusive classic queue + binding or E2E | Cannot tap default exchange; changes AE/mandatory outcomes; steals from hash/random exchanges | any; 4.3 needs exclusive queue |
| Firehose | `rabbitmqctl trace_on -n <each node>` or HTTP vhost `tracing` (serving node only) + consume `amq.rabbitmq.trace` | Throughput cost; per node; not persisted | any |
| Trace files | `rabbitmq_tracing` HTTP endpoints | Disk usage on node | any (plugin) |
| Move all | Dynamic shovel via `/api/parameters/shovel` (`queue-length`, `on-confirm`) | Duplicates on restart; policymaker needed | any; `local` 4.2 |
| Copy | Consume + republish + requeue, or stream read | Quorum counters change; duplicates | any |
| Dead-letter redrive | Consume (manual ack) + publish (confirms, mandatory) | `x-death` not interpreted, overwritten on next death | 4.0 semantics |
| Dead-letter history | `x-death`, `x-first-death-*` / `x-last-death-*`; `x-opt-deaths` | Lossy across protocols | `x-opt-deaths` 4.x |
| Publish test message | 0-9-1 (mandatory + confirms), AMQP 1.0 (v2 address, explicit durable), HTTP publish (inefficient, `routed` flag) | AMQP 1.0 default non-durable | durable default 4.2; reject reason 4.3 |
| Quorum replica operations | `/api/queues/quorum/...`, `/api/rebalance/queues` | Availability during changes | 3.x+ (verify per endpoint) |
| Delayed retry, consumer timeout, strict priorities | Queue arguments or policies; HTTP stats | n/a | 4.3 |
| Delayed delivery, deferral | AMQP 1.0 `x-opt-delivery-time`, `x-opt-deferral-token`, FLOW `rabbitmq:deferred-tokens` | Unreleased | 4.4 |
| Browser-direct messaging | Web STOMP / Web MQTT (open source); AMQP over WebSocket (Tanzu) | Plugins must be enabled | n/a |
| Health, feature flags, deprecations | `/api/health/checks/*`, `/api/feature-flags`, `/api/deprecated-features/used` | Enabling a flag is irreversible | 3.13+ (verify) |

---

## 15. Architecture implications (INFERENCE)

1. **The web edition needs a server-side protocol gateway** (AMQP 0-9-1, AMQP 1.0, stream protocol). Pure-browser mode is limited to the HTTP API plus Web STOMP or Web MQTT, or AMQP 1.0 over WebSocket on Tanzu.
2. **Client coverage by language.** Go, .NET and Java have official clients for all three protocols. Rust has an official stream client but no official AMQP 1.0 client. Node's official-listed AMQP 1.0 client is early-stage, and its stream client is community-maintained. This weighs on the choice between Wails/Go, .NET, Tauri/Rust and Electron/Node.
3. **Metrics.** Treat Prometheus as the long-term metrics source and management stats as a fallback.
4. **Capability registry.** Every risky action should come from a registry keyed on version, queue type, plugins and permissions, and should say exactly what it will mutate.

## Feature ideas

| Idea | Persona | Priority | Size | Description | Evidence / inspiration |
| --- | --- | --- | --- | --- | --- |
| Capability registry and version gating | all | must | M | Detect broker version, Tanzu vs OSS, enabled plugins, feature flags, deprecated features in use and metadata store at connect time; gate every feature and risk explanation on that profile (3.13, 4.0-4.2, 4.3+, 4.4). | Semantics differ materially across 3.13/4.0-4.2/4.3 (QQ counting, Khepri-only, denied deprecated features); commercial support for 3.13 to 2029 and 4.2 to 2030 (rabbitmq.com/release-information). |
| Version-aware Safe Peek for quorum queues | developer | must | L | Peek via basic.nack or AMQP 1.0 released only (never basic.reject); read effective delivery-limit and per-message x-delivery-count/x-acquired-count first; refuse or warn when a return could dead-letter or drop the message (4.0-4.2 every return counts; 4.3 carry-over in DLQs); settle within seconds; show predicted counter changes before executing. | rabbit_fifo return_one in v4.0.1/v4.2.0 compares acquired_count; 4.3 docs counting table; rabbit_channel main maps reject-requeue to delivery_failed=true; dev.to DLQ carry-over report. |
| Safe Peek for classic queues | developer | must | M | Bounded acquire-and-release browsing with auto-release timers (no server-side consumer timeout on CQ since 4.3), redelivered-flag explanation and an ordering-impact warning when consumers are active. | confirms docs (requeue to original position if possible); 4.3 release notes (consumer timeouts not evaluated for classic queues). |
| Zero-side-effect QQ peek via CLI bridge | operator | could | M | When the desktop app has node access (local Docker, kubectl exec, SSH), run rabbitmq-queues peek per position to inspect quorum-queue messages without acquiring them. | rabbitmq-queues man page; rabbit_quorum_queue:peek/2 uses a read-only leader aux command; no HTTP/AMQP equivalent in the management dispatcher. |
| Optional companion broker plugin | platform | could | XL | Ship an optional open-source Erlang plugin exposing HTTP endpoints for read-only QQ peek (rabbit_quorum_queue:peek) and a bounded firehose ring buffer, for self-managed brokers where installing plugins is allowed. | Plugin extension points (management dispatcher, message interceptor behaviour); gap: no HTTP peek in OSS. |
| Stream Browser (OSS) | developer | must | L | Browse streams and super-stream partitions by first, last, next, offset or timestamp; tabular and per-message views of all AMQP 1.0 sections; export ranges; never store offsets under application consumer names. | basic.get not supported by stream queues (rabbit_stream_queue.erl), so the OSS UI cannot browse streams; Tanzu 4.3 sells a Stream Browser UI plugin. |
| Stream filter builder | developer | should | M | UI to compose Bloom filter values (x-stream-filter), AMQP property filters (4.1+) and SQL filter expressions (4.2+); explains which stages run on the server and which on the client, and the Bloom false-positive caveat. | rabbitmq.com/docs/stream-filtering; 4.1 and 4.2 release notes. |
| Stream consumer, offset-lag and SAC view | operator | should | M | Show stream connections, publishers and consumers (stream management endpoints), stored offsets, lag, and single-active-consumer groups for streams and super streams. | HTTP API /api/stream/connections, /publishers, /consumers; streams docs on server-side offset tracking and SAC. |
| Super stream topology view and creator | developer | could | S | Detect super streams (direct exchange with x-super-stream=true, bindings with x-stream-partition-order) and create or resize them over the HTTP API. | rabbit_stream_manager.erl super stream creation code. |
| Wire-tap live tail with safety preflight | developer | must | L | Exclusive classic tap queue (explicit x-queue-type=classic, max-length with drop-head, TTL) or E2E tap exchange. Preflight refuses to bind to x-consistent-hash, x-modulus-hash, x-local-random or random exchanges; warns about alternate exchange and mandatory flag effects, default-exchange blindness, and permission needs. | rabtap README; modulus-hash and local-random exchange docs; 4.3 denial of transient non-exclusive queues. |
| Queue spy by binding mirroring with gap report | developer | should | M | Mirror all bindings of a target queue onto a tap queue to see future traffic routed to it, and list what this cannot see (default-exchange direct publishes, dead-lettering via the default exchange, shovels or federation that publish directly). | Exchange-to-exchange routing semantics (union of bindings) in exchanges docs; default exchange restrictions. |
| Cluster-aware firehose capture mode | operator | should | M | Enable tracing on every node (not only the node serving the HTTP request), consume amq.rabbitmq.trace with publish.# or deliver.<queue> filters, use the routed_queues header to show where each message went, and auto-disable after N minutes with a throughput-cost banner. | firehose docs (per-node, per-vhost, not persistent, performance drop); rabbit_trace.erl and rabbit_vhost.erl source. |
| Routing simulator ('where did my message go?') | developer | must | M | Evaluate direct, topic, fanout and headers bindings, E2E chains, alternate exchanges, default exchange and hash exchanges from live topology for a given routing key and headers; optionally verify with a mandatory test publish or firehose. | exchanges docs; firehose routed_queues header; AMQP 1.0 released outcome for unroutable messages. |
| Browser-direct live tail via Web STOMP | developer | could | M | For the web edition without a gateway: STOMP /exchange/<x>/<pattern> subscriptions (auto-creates an exclusive auto-delete queue) for taps, and x-stream-offset for stream reading. | STOMP and Web STOMP docs (15674/ws, /exchange semantics, stream support). |
| Capture-to-stream for shared replay | all | could | M | Bind a retention-limited stream (max-age) to chosen exchanges as a team capture buffer that several people can replay without removing messages; shows the same routing caveats as a wire-tap. | Streams are non-destructive with segment-based retention (streams docs). |
| Redrive engine with confirms and own headers | developer | must | M | Republish to the original exchange and routing keys or the original queue with publisher confirms and mandatory, ack the source only after confirm, throttle, and stamp x-redrive-count, x-redriven-from and x-redriven-at because 4.x ignores client-sent x-death and overwrites it on the next death. | 4.0 release notes on x-death; mc_amqpl.erl deaths_to_headers overwrite; Spring Cloud Stream custom retry header. |
| Server-side 'Move all' via dynamic or local shovels | operator | must | M | One-click move using src-delete-after=queue-length and on-confirm, choosing the local protocol on 4.2+ within one cluster and amqp091 or amqp10 across clusters; progress via /api/shovels and automatic cleanup. | shovel-dynamic docs; management UI 'Move messages' implementation (queue.ejs); 4.2 local shovels. |
| Dead-letter safety lint | operator | must | S | Flag quorum DLQs with the default delivery-limit that receive delivery_limit dead letters (carry-over drop risk), quorum queues with no DLX (silent drops), and at-least-once dead-lettering without overflow=reject-publish. | QQ docs; dev.to carry-over report; at-least-once dead-lettering prerequisites. |
| Poison-message and delivery-limit dashboard | operator | should | M | Per quorum queue: effective delivery limit (argument, policy or operator policy), messages_ready_returned, messages_dlx and message_bytes_dlx, delayed counts, and the messages with the highest counters. | 4.3 rabbit_quorum_queue stats keys. |
| Editors for QQ 4.3 features | operator | should | M | Policy editors and visualizers for delayed retry (type, min, max, next_delayed_at), consumer timeout (argument, policy, global) and per-priority depth across 32 levels. | 4.3 release notes and blog; QQ docs. |
| QQ replica and leader manager | operator | should | M | Quorum status, add or delete member, grow or shrink by node, rebalance, membership-reconciliation settings (target-group-size), and a quorum-critical pre-maintenance check. | rabbit_mgmt_dispatcher routes /queues/quorum/... and /rebalance/queues; health check node-is-quorum-critical. |
| Version-aware policy debugger | all | must | M | Show all matching policies (pattern plus apply-to, including classic_queues, quorum_queues and streams), priority ties (chosen non-deterministically), operator-policy merges (lower numeric value wins), argument-vs-policy precedence per key, and the server-reported effective_policy_definition. | rabbitmq.com/docs/policies; 4.3 effective_policy_definition change. |
| Upgrade readiness and deprecation scanner | operator | must | M | Check deprecated features in use, required feature flags for the target version, CQv1 queues, mirroring policies, transient non-exclusive queues, global QoS, AMQP address v1, the khepri_db state, the archived delayed-message plugin, and the allowed upgrade path (4.2.x only to 4.3). | 4.3 release notes upgrade section; /api/deprecated-features/used; rabbitmqadmin v2 transformations. |
| Khepri and metadata-store health panel | operator | should | S | Show metadata store type, majority requirement and metadata-store health checks; classify 'no majority' errors; warn that enabling khepri_db is irreversible. | metadata-store docs; /health/checks/metadata-store/initialized routes. |
| Feature flag manager | operator | should | S | List flags with stability levels, enable them via the HTTP API, and show irreversibility warnings plus guidance on which flags must be enabled before an upgrade. | feature-flags docs; /api/feature-flags/:name/enable. |
| Health-check dashboard | operator | should | S | Run every /api/health/checks endpoint (alarms, virtual hosts, quorum queues without leaders, certificate expiry, listeners, ready-to-serve-clients, target cluster size) per node. | rabbit_mgmt_dispatcher route list. |
| Protocol-faithful message viewer | developer | should | M | Render AMQP 1.0 sections (header, annotations, properties, application properties, data/value/sequence body) or AMQP 0-9-1 properties and headers; let the user choose the read protocol and flag lossy conversions (array/table headers dropped, amqp-1.0 type bodies). | rabbitmq.com/docs/conversions. |
| Multi-protocol publisher | developer | must | M | Publish over AMQP 0-9-1 (mandatory, confirms, default exchange), AMQP 1.0 (v2 addresses, explicit durable header, outcomes including 4.3 reject reasons), the stream protocol (filter value, deduplication), or HTTP (with an inefficiency warning). | 4.2 durable-default change; 4.3 Rejected outcome info; HTTP publish docs. |
| RPC and Direct Reply-To tester | developer | could | S | Send request/reply exchanges using Direct Reply-To over AMQP 0-9-1, or over AMQP 1.0 on 4.2+, with timing. | 4.2 release notes (Direct Reply-To for AMQP 1.0). |
| Delayed messaging assistant | developer | could | M | Detect use of the archived delayed-message-exchange plugin and guide migration to TTL+DLX, Tanzu delayed queues or 4.4 QQ x-opt-delivery-time; compose delayed messages per target. | Archived plugin README (2026-09-24); Tanzu delayed queues docs; PR #16583. |
| Deferred-message view (4.4) | developer | could | L | Once 4.4 ships, show deferred and delayed QQ message counts and support claiming by deferral token over AMQP 1.0. | PR #16583 (rabbit_fifo v9: deferral tokens, delayed bucket); milestone 4.4.0. |
| Consumer inspector | developer | should | M | Per queue: consumers with prefetch, ack mode, SAC active flag, priority, 4.3 consumer-timeout state, and AMQP 1.0 sessions and links (/connections/:c/sessions). | 4.1 UI session and link details; dispatcher routes; consumers docs. |
| Metrics source abstraction | operator | must | M | Use management stats when present, detect a disabled metrics collector or the deprecated management_metrics_collection, and fall back to Prometheus /metrics/detailed (family, vhost, queue regex in 4.3) for time series. | management docs; prometheus docs; deprecated-features list. |
| Large-cluster-safe API usage | all | must | S | Always paginate (page_size up to 500), select columns, use disable_stats and enable_queue_totals, use regex filters, and use per-user queue listing on 4.3. | HTTP API reference; 4.3 GET /api/users/{user}/queues. |
| Permission-aware read-only mode with side-effect labels | team-security | must | S | Derive capabilities from /api/whoami and permissions; label every action as read, acquire (peek) or mutate; remember that 4.3 passive declares need configure permission. | 4.3 release notes (passive declare permission change). |
| Protected-objects awareness | team-security | should | S | Respect the protected user tag (4.2), vhost deletion protection and protected_users in bulk delete (4.3), with clear errors and no attempts to work around them. | 4.2 and 4.3 release notes; /vhosts/:vhost/deletion/protection route. |
| Event timeline via event exchange | team-security | could | M | Optionally consume amq.rabbitmq.event (plugin must be enabled) into a bounded queue to show topology changes, authentication failures and connection churn. | rabbitmq.com/docs/event-exchange. |
| Interceptor-based latency | developer | could | S | When interceptor annotations exist (x-opt-rabbitmq-received-time, x-opt-rabbitmq-sent-time, x-routed-by, timestamp_in_ms), compute time spent in the queue and show the routing node. | rabbitmq.com/docs/message-interceptors (4.2 outgoing timestamp). |
| Queue-type migration assistant | operator | should | L | Plan classic or mirrored queue to quorum queue migrations: detect unsupported features (exclusive, non-durable, global QoS, priority differences), use relaxed equivalence checks on redeclaration, and move data with local shovels. | QQ docs feature matrix; vhosts docs (relaxed_checks_on_redeclaration); 4.0 mirroring removal; 4.2 local shovels. |
| Export to Topology Operator CRDs with drift detection | platform | should | M | Generate Queue, Exchange, Binding, Policy, OperatorPolicy, User, Permission, TopicPermission, Vhost, Federation, Shovel, SchemaReplication (v1beta1) and SuperStream (v1alpha1) manifests; flag operator-managed objects before editing them. | messaging-topology-operator api/v1beta1 and api/v1alpha1. |
| Kubernetes discovery | platform | should | M | Discover RabbitmqCluster resources, read the <name>-default-user secret (with RBAC), and port-forward 15672, 5672 and 5552 with stream advertised-host handling. | Cluster Operator docs (secret keys, services). |
| Stream connectivity helper | developer | should | S | Detect advertised_host and advertised_port mismatches and use load-balancer mode or an address resolver when reaching streams through Docker, NAT or port-forward. | rabbitmq.com/docs/stream (advertised host and port rationale). |
| AMQP 1.0 topology fallback | platform | could | S | Declare, delete, purge, bind and fetch queue info over the AMQP 1.0 management node when the HTTP API is unavailable, with no listing. | rabbit_amqp_management.erl. |
| Tanzu feature detection | operator | could | S | Detect and display status for Warm Standby Replication, Schema Definition Sync, delayed queues, JMS queues and AMQP over WebSocket when present. | Broadcom 4.3 release notes; rabbitmqadmin-ng Tanzu commands. |
| OSS linter | operator | should | M | Anti-pattern checks: QQ without DLX, quorum DLQs at the default limit, equal-priority policy ties, global QoS, CQv1, transient queues, unbounded queues without max-length, streams without retention, ignored arguments (x-max-priority on QQ in 4.3), unbalanced leaders, connection churn. | Tanzu 4.3 Linter is commercial-only; checks derived from the docs. |
| QQ message-state explainer | all | should | S | Explain ready (high, normal, returned), unacknowledged, delayed, dead-letter pending and (4.4) deferred counts, and why browsing cannot see some of them. | 4.3 rabbit_quorum_queue stats keys; PR #16583. |
| Web-edition protocol gateway | platform | must | XL | A server-side component holding AMQP 0-9-1, AMQP 1.0 and stream connections for browser users, with per-user credentials and audit; pure-browser mode is limited to the HTTP API plus Web STOMP or MQTT (or Tanzu AMQP over WebSocket). | AMQP over WebSocket is Tanzu-only (2025-04-16 blog; 4.3 AMQP docs). |
| Backend language choice by official client coverage | platform | should | S | Choose the desktop and server backend stack where official clients cover AMQP 0-9-1, AMQP 1.0 and streams (Go, .NET, Java), rather than Rust (no official AMQP 1.0) or Node (early-stage AMQP 1.0, community stream client). | AMQP client libraries page; stream plugin docs (official stream clients); coders51 JS client maturity. |
| Triage annotations on quorum DLQs | developer | could | M | Use the AMQP 1.0 modified outcome with x- annotations (for example x-opt-triage) to tag dead letters on quorum queues without republishing; clearly labelled as a mutation. | rabbit_amqp_session.erl annotation validation (x- keys); modified annotations supported on QQ only. |
| MQTT and STOMP awareness | developer | could | S | Recognise MQTT QoS 0 pseudo-queues, the / to . topic mapping on amq.topic, node-local retained messages, and STOMP-created queues in topology views. | MQTT and STOMP docs. |

## Claims flagged for verification

- **[high]** In RabbitMQ 4.0-4.2 the quorum-queue delivery limit (default 20) is checked against acquired_count, which grows on EVERY return (basic.nack/basic.reject requeue, AMQP 1.0 released/modified). Peeking by acquire-and-return, including the management UI 'Get messages' with 'Nack message requeue true', uses up the budget; past it the message is dead-lettered with reason delivery_limit, or dropped if there is no DLX.
  - Why it matters: Any peek, spy or browse feature on 4.0-4.2 quorum queues can silently destroy data. These versions have commercial support to 2027 (4.1) and 2030 (4.2).
  - Sources: https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.0.1/deps/rabbit/src/rabbit_fifo.erl https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.0/deps/rabbit/src/rabbit_fifo.erl https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.0/deps/rabbit/src/rabbit_fifo_client.erl https://www.rabbitmq.com/docs/quorum-queues
- **[high]** From 4.3 the limit is based on delivery-count. basic.nack requeue, AMQP 1.0 released and modified(delivery-failed=false) increment only x-acquired-count. basic.reject requeue=true, modified(delivery-failed=true), AMQP 1.0 rejected and client crash or connection loss increment x-delivery-count.
  - Why it matters: Safe peeking on 4.3+ must use nack or released, never basic.reject. The management 'Reject requeue true' option is unsafe.
  - Sources: https://www.rabbitmq.com/docs/quorum-queues https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbit/src/rabbit_channel.erl https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.0/deps/rabbit/src/rabbit_fifo_client.erl https://github.com/rabbitmq/rabbitmq-server/releases/tag/v4.3.0
- **[medium]** In 4.3 the delivery-limit check runs on every return. A message dead-lettered for delivery_limit carries its count into a quorum DLQ, so a single later return there, even a nack-based peek, can drop or re-dead-letter it.
  - Sources: https://dev.to/viktorbaumann/your-quorum-dead-letter-queue-can-drop-the-dead-letters-x-delivery-count-travels-along-240n https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.0/deps/rabbit/src/rabbit_fifo.erl
- **[high]** The management HTTP API get endpoint maps ack_requeue_true to basic.nack(requeue=true) and reject_requeue_true to basic.reject(requeue=true), and fetches all N messages before returning them. Streams cannot be read this way because basic.get is not implemented for stream queues.
  - Why it matters: It sets the exact side effects of HTTP-based peeking per version and shows that stream browsing needs a messaging protocol.
  - Sources: https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/src/rabbit_mgmt_wm_queue_get.erl https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.0.0/deps/rabbitmq_management/src/rabbit_mgmt_wm_queue_get.erl https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbit/src/rabbit_stream_queue.erl
- **[high]** rabbitmq-queues peek (quorum queues only) is the only side-effect-free way to read a classic or quorum queue message in OSS RabbitMQ. It has no HTTP API route and no AMQP 1.0 management operation.
  - Why it matters: A remote or web tool cannot offer true non-destructive peek on CQ/QQ without CLI access or a custom broker plugin, which affects product promises and architecture.
  - Sources: https://www.rabbitmq.com/docs/man/rabbitmq-queues.8 https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/src/rabbit_mgmt_dispatcher.erl https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbit/src/rabbit_amqp_management.erl https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.0/deps/rabbit/src/rabbit_quorum_queue.erl
- **[high]** AMQP 1.0 over WebSocket (rabbitmq_web_amqp, 4.1+) is a closed-source feature of commercial VMware Tanzu RabbitMQ only; the 4.3 docs still describe it as Tanzu-only.
  - Why it matters: A browser-only client cannot speak AMQP to OSS brokers, so the web edition needs a server-side protocol gateway, or must limit itself to the HTTP API plus Web STOMP or Web MQTT.
  - Sources: https://www.rabbitmq.com/blog/2025/04/16/amqp-websocket https://www.rabbitmq.com/docs/amqp https://www.rabbitmq.com/client-libraries/amqp-client-libraries
- **[high]** Khepri became the default metadata store for new deployments in 4.2.0. Mnesia and the partition-handling strategies were removed in 4.3.0, and 4.3 can only be upgraded in place from 4.2.x with khepri_db and the other required feature flags enabled.
  - Why it matters: It drives cluster-health UX (a majority is needed for metadata changes), upgrade-readiness checks and support for older stores.
  - Sources: https://github.com/rabbitmq/rabbitmq-server/releases/tag/v4.2.0 https://github.com/rabbitmq/rabbitmq-server/releases/tag/v4.3.0 https://www.rabbitmq.com/docs/metadata-store
- **[medium]** Firehose tracing is enabled per node and per vhost and is not persisted. The HTTP API vhost {tracing:true} flag calls rabbit_trace:start only on the node serving the request. Trace messages include routed_queues on publish.
  - Why it matters: A capture feature built on the HTTP toggle will silently miss traffic on other nodes and must re-enable tracing after restarts.
  - Sources: https://www.rabbitmq.com/docs/firehose https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbit/src/rabbit_trace.erl https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbit/src/rabbit_vhost.erl
- **[high]** Wire-tap capture cannot see default-exchange publishes. Binding a tap queue to x-consistent-hash, x-modulus-hash or x-local-random exchanges diverts messages away from real queues, because each message goes to only one destination.
  - Why it matters: 'Non-intrusive' live spying is not universally non-intrusive; the tool needs preflight checks to avoid causing production incidents.
  - Sources: https://raw.githubusercontent.com/jandelgado/rabtap/master/README.md https://www.rabbitmq.com/docs/modulus-hash-exchange https://www.rabbitmq.com/docs/local-random-exchange https://www.rabbitmq.com/docs/exchanges
- **[high]** Since 4.0, RabbitMQ does not interpret a client-published x-death header. It is kept as an opaque header, and on the next dead-lettering the broker's own deaths record replaces it.
  - Why it matters: DLQ redrive by republishing breaks dead-letter history and retry counting; the tool must keep its own redrive headers.
  - Sources: https://github.com/rabbitmq/rabbitmq-server/releases/tag/v4.0.1 https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbit/src/mc_amqpl.erl https://www.rabbitmq.com/docs/dlx
- **[medium]** The rabbitmq-delayed-message-exchange plugin was archived on 2026-09-24 and is incompatible with 4.3 because Mnesia was removed. Native quorum-queue delayed delivery (x-opt-delivery-time) and deferral are merged for 4.4, which is not yet released.
  - Why it matters: Delayed-message tooling and migration guidance must target new mechanisms, and the 4.4 timing affects the roadmap.
  - Sources: https://github.com/rabbitmq/rabbitmq-delayed-message-exchange https://github.com/rabbitmq/rabbitmq-server/pull/16583 https://github.com/rabbitmq/rabbitmq-server/releases
- **[high]** 4.3 denies by default: transient non-exclusive queues, global QoS, AMQP address v1 and queue_master_locator. It also requires configure permission for passive declares and stops evaluating consumer timeouts for classic queues and streams.
  - Why it matters: Tool internals (temporary queues, QoS, AMQP 1.0 addressing, existence probes, auto-release timers) must follow 4.3 rules or break on current brokers.
  - Sources: https://github.com/rabbitmq/rabbitmq-server/releases/tag/v4.3.0 https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.3.0.md
- **[high]** Tanzu RabbitMQ 4.3 (commercial) added a Stream Browser UI, a configuration Linter, a JMS queue type with non-destructive queue browsers, and a Raft-backed message scheduler. OSS has none of these, and the OSS UI cannot read streams.
  - Why it matters: These are the clearest feature gaps an OSS-first tool can fill, and they set the bar the tool will be compared against.
  - Sources: https://www.rabbitmq.com/blog/2026/04/23/rabbitmq-4.3-release https://techdocs.broadcom.com/us/en/vmware-tanzu/data-solutions/tanzu-rabbitmq-rpm/4-3/tanzu-rabbitmq-rpm-offering/site-release-notes.html
- **[high]** Commercial support runs to 2029-12-31 for 3.13 and 2030-06-30 for 4.2, while OSS community support for 4.3 ends 2027-01-31.
  - Why it matters: A de facto tool must support at least three different semantic eras at the same time.
  - Sources: https://www.rabbitmq.com/release-information

## Open questions

- With quorum-queue delayed retry type 'returned' or 'all' (4.3), are messages returned by a browsing nack actually delayed when delivery_count is 0 (the formula min(min*delivery_count, max) suggests 0 ms)? Needs a test.
- Does the DLQ delivery-count carry-over (a message arriving with count above the limit and being dropped on its next return) also happen on 4.0-4.2 via acquired_count, and does a 4.3.x patch change it? Needs a test matrix for 4.0/4.1/4.2/4.3/4.4.
- Is a graceful channel close or consumer cancel with unacked quorum-queue deliveries counted as 'client crash' (delivery-count +1) in 4.3? This decides whether a browser that disconnects mid-peek is dangerous.
- Does basic.get on a single-active-consumer quorum or classic queue bypass the active consumer, and can a browsing basic.consume become the active consumer and starve the application?
- What is the default consumer timeout for quorum queues in 4.3? The consumers docs say 30 minutes; the QQ docs show consumer_timeout with default 'undefined'.
- Are exclusive queues declared without x-queue-type always classic when the vhost default queue type is quorum? The code inspection was inconclusive; declare x-queue-type=classic explicitly until verified.
- Do local shovels (4.2+) preserve internal dead-letter annotations (x-death history) and other message-container annotations better than amqp091 or amqp10 shovels?
- Does the firehose capture stream-protocol publishes, local-shovel transfers and MQTT QoS0 pseudo-queue deliveries?
- Exact 4.4 release date and final scope (delayed delivery, deferral, new HTTP stats fields for deferred and delayed messages); no 4.4 pre-release was visible on GitHub as of 2026-10-16.
- Will Broadcom open-source AMQP 1.0 over WebSocket, the Stream Browser or queue-browser semantics (distribution-mode copy) for non-JMS queue types? rabbit_amqp_session has per-queue-type distribution modes.
- The minimum versions of several HTTP endpoints (deprecated-features, quorum replica operations, some health checks) need per-version confirmation; this research verified the main-branch route list.
- The search budget ran out partway through this research (shared WebSearch limit); later findings come from direct fetches of primary sources. Some recent community reports, such as fix status for issue #14202 (delivery-limit -1 policy causing re-application every 5 s), were not checked.

## Sources

- https://www.rabbitmq.com/release-information
- https://github.com/rabbitmq/rabbitmq-server/releases
- https://github.com/rabbitmq/rabbitmq-server/releases/tag/v4.3.0
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.3.0.md
- https://www.rabbitmq.com/blog/2026/04/23/rabbitmq-4.3-release
- https://github.com/rabbitmq/rabbitmq-server/releases/tag/v4.2.0
- https://github.com/rabbitmq/rabbitmq-server/releases/tag/v4.1.0
- https://github.com/rabbitmq/rabbitmq-server/releases/tag/v4.0.1
- https://www.rabbitmq.com/blog/2025/04/15/rabbitmq-4.1.0-is-released
- https://www.rabbitmq.com/docs/quorum-queues
- https://www.rabbitmq.com/docs/4.2/quorum-queues
- https://www.rabbitmq.com/docs/4.1/quorum-queues
- https://www.rabbitmq.com/docs/next/quorum-queues
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.0.1/deps/rabbit/src/rabbit_fifo.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.0/deps/rabbit/src/rabbit_fifo.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.0/deps/rabbit/src/rabbit_fifo.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.0/deps/rabbit/src/rabbit_fifo_client.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.0/deps/rabbit/src/rabbit_fifo_client.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.0/deps/rabbit/src/rabbit_quorum_queue.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.0/deps/rabbit/src/rabbit_quorum_queue.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbit/src/rabbit_channel.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.0.1/deps/rabbit/src/rabbit_channel.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/src/rabbit_mgmt_wm_queue_get.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.0.0/deps/rabbitmq_management/src/rabbit_mgmt_wm_queue_get.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/src/rabbit_mgmt_dispatcher.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/priv/www/js/tmpl/queue.ejs
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/priv/www/js/tmpl/classic-queue-get-message.ejs
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_shovel_management/priv/www/js/shovel.js
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbit/src/rabbit_stream_queue.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbit/src/rabbit_trace.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbit/src/rabbit_vhost.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/src/rabbit_mgmt_wm_vhost.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_tracing/src/rabbit_tracing_mgmt.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbit/src/rabbit_amqp_management.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbit/src/rabbit_amqp_session.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbit/src/mc_amqpl.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbit/src/mc.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbit/src/rabbit_amqqueue.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_stream/src/rabbit_stream_manager.erl
- https://github.com/rabbitmq/rabbitmq-server/pull/16583
- https://github.com/rabbitmq/rabbitmq-server/pulls?q=is%3Apr+deferral
- https://github.com/rabbitmq/rabbitmq-server/discussions/14977
- https://github.com/rabbitmq/rabbitmq-delayed-message-exchange
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-delayed-message-exchange/main/README.md
- https://www.rabbitmq.com/docs/amqp
- https://www.rabbitmq.com/docs/4.1/amqp
- https://www.rabbitmq.com/client-libraries/amqp-client-libraries
- https://github.com/coders51/rabbitmq-amqp-js-client
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-amqp-python-client/main/rabbitmq_amqp_python_client/entities.py
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-amqp-python-client/main/rabbitmq_amqp_python_client/management.py
- https://www.rabbitmq.com/blog/2025/04/16/amqp-websocket
- https://www.rabbitmq.com/docs/streams
- https://www.rabbitmq.com/docs/stream
- https://www.rabbitmq.com/docs/stream-filtering
- https://www.rabbitmq.com/blog/2023/10/16/stream-filtering
- https://www.rabbitmq.com/blog/2024/12/13/amqp-filter-expressions
- https://www.rabbitmq.com/blog/2025/09/23/sql-filter-expressions
- https://www.rabbitmq.com/docs/dlx
- https://www.rabbitmq.com/docs/shovel
- https://www.rabbitmq.com/docs/shovel-dynamic
- https://www.rabbitmq.com/docs/federation
- https://www.rabbitmq.com/docs/firehose
- https://www.rabbitmq.com/docs/exchanges
- https://www.rabbitmq.com/docs/modulus-hash-exchange
- https://www.rabbitmq.com/docs/local-random-exchange
- https://raw.githubusercontent.com/jandelgado/rabtap/master/README.md
- https://www.rabbitmq.com/docs/management
- https://www.rabbitmq.com/docs/http-api-reference
- https://www.rabbitmq.com/docs/prometheus
- https://www.rabbitmq.com/docs/deprecated-features
- https://www.rabbitmq.com/release-information/deprecated-features-list
- https://www.rabbitmq.com/docs/feature-flags
- https://www.rabbitmq.com/docs/metadata-store
- https://www.rabbitmq.com/blog/2025/09/01/6-khepri-default
- https://www.rabbitmq.com/docs/man/rabbitmq-queues.8
- https://www.rabbitmq.com/docs/confirms
- https://www.rabbitmq.com/docs/consumers
- https://www.rabbitmq.com/docs/mqtt
- https://www.rabbitmq.com/blog/2023/07/21/mqtt5
- https://www.rabbitmq.com/docs/web-stomp
- https://www.rabbitmq.com/docs/stomp
- https://www.rabbitmq.com/docs/message-interceptors
- https://www.rabbitmq.com/docs/conversions
- https://www.rabbitmq.com/docs/policies
- https://www.rabbitmq.com/docs/vhosts
- https://www.rabbitmq.com/docs/plugins
- https://www.rabbitmq.com/docs/event-exchange
- https://www.rabbitmq.com/blog
- https://www.rabbitmq.com/kubernetes/operator/using-topology-operator
- https://www.rabbitmq.com/kubernetes/operator/using-operator
- https://github.com/rabbitmq/messaging-topology-operator
- https://github.com/rabbitmq/messaging-topology-operator/tree/main/api/v1beta1
- https://github.com/rabbitmq/messaging-topology-operator/tree/main/api/v1alpha1
- https://github.com/rabbitmq/cluster-operator/releases
- https://techdocs.broadcom.com/us/en/vmware-tanzu/data-solutions/tanzu-rabbitmq-rpm/4-3/tanzu-rabbitmq-rpm-offering/site-release-notes.html
- https://techdocs.broadcom.com/us/en/vmware-tanzu/data-solutions/tanzu-rabbitmq-rpm/4-2/tanzu-rabbitmq-rpm-offering/site-delayed-queues.html
- https://docs.vmware.com/en/VMware-Tanzu-RabbitMQ/4.0/vmware-rabbitmq-ova/standby-replication-without-k8s.html
- https://blogs.vmware.com/tanzu/introducing-vmware-tanzu-rabbitmq-4-2/
- https://github.com/rabbitmq/rabbitmqadmin-ng
- https://dev.to/viktorbaumann/your-quorum-dead-letter-queue-can-drop-the-dead-letters-x-delivery-count-travels-along-240n
- https://github.com/rabbitmq/rabbitmq-server/issues/14202
- https://aws.amazon.com/about-aws/whats-new/2026/09/amazon-mq-rabbitmq-43/
- https://cloudamqp.com/blog/cloudamqp-announcing-rabbitmq-version-4-2.html
