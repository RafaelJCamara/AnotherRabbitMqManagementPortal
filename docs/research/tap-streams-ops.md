# Taps, firehose, streams, metrics and the ops surface

> **Verified research (2026-10-16).** Source read at exact release tags and primary docs; **not yet lab-tested**. The conformance suite (M0) confirms or corrects every runtime claim. Content about a specific third-party product was removed under the docs policy ([ADR-034](../adr/ADR-034-docs-policy.md)).

_Verification task `semantics-tap-streams-ops` · 2026-10-16_

## Summary

I checked all ten claim groups against source code at exact tags (mainly v4.3.6, compared with 3.13.7, 4.0.x, 4.1.x, 4.2.0–4.2.9, 4.3.0–4.3.5 and the v4.4.x/main branches), release notes, docs, GitHub issues and npm. Nothing was lab-tested. Most claims hold. Several need correction, and a few new hazards came up.

Taps. A spy that copies the target queue's bindings never sees default-exchange traffic, because the broker refuses any binding to "". It takes messages away from the real queues on x-consistent-hash, x-modulus-hash and x-random. x-modulus-hash also remaps almost every routing key. On x-local-random only a classic queue can be bound (exchange-to-exchange is rejected), and it diverts only messages published on the tap's node. The alternate exchange and mandatory returns stop firing only when the tap matches more than the existing bindings do. So rabtap's "delivery untouched" claim is false in general. New hazard: on 4.3.0–4.3.5, deleting a tap exchange bound to a consistent-hash exchange leaves a stale ring bucket that silently drops messages (#17255, fixed in 4.3.6).

Firehose. Tracing is per node and per vhost, held in memory, and the HTTP vhost toggle affects only the node serving the request. The rabbitmq_tracing plugin is still shipped in 4.3.6, v4.4.x and main. Its node-targeted routes (/api/traces/node/{node}/...) give an HTTP-only tool a way to trace every node. A PUT /api/vhosts with only tracing also overwrites the vhost's description and tags. From 4.1.x it apparently resets the default queue type too (seen in source only).

Streams. The JS AMQP 1.0 client linked from rabbitmq.com (coders51 v1.0.0) has three gaps:
- It sends stream offsets and Bloom filters in a legacy format that 4.3 ignores by default, so consumers start at "next".
- It cannot encode numeric or timestamp offsets at all.
- It has no vhost selection, purge or SASL EXTERNAL.

The stream-protocol client is the safer primary path. AMQP 1.0 is needed only for property filters (4.1+) and SQL filters (4.2+). Reading streams over 0-9-1 needs prefetch above 0 and manual acks, and the connection must be on a node that hosts a replica.

4.3 restrictions. From 4.3.1, passive declares need any one permission; only 4.3.0 and 4.2.6 required configure. Global QoS is silently downgraded rather than rejected.

Metrics with stats disabled. What breaks depends on the patch: missing policy fields were fixed in 4.2.5 and 4.3.0, static connection info appears from 4.2.6 and 4.3.0, and the channels endpoints return 400 until 4.3.6. /api/nodes loses all resource stats. Queue totals can be requested per call with ?enable_queue_totals=true.

Versions. 4.3.6 is the current release. Open-source 4.2 stops at 4.2.9; 4.2.10 and 4.2.11 are commercial-only. Commercial support for 4.0 ended on 2026-09-30. 4.4.0 and 5.0.0 exist only as alpha builds.

## Verdicts

| ID | Verdict | Confidence | Verified statement |
| --- | --- | --- | --- |
| T1b | refuted | high | Only partly true. On direct, topic, fanout and headers exchanges, an exchange-to-exchange tap adds a destination and does not remove messages from existing queues. It is not side-effect-free: (a) The tap exchange is a destination of the source exchange. Broad keys make every message routed and silence the source's alternate exchange, mandatory basic.return and unroutable counters. Broad keys are '#', fanout '', and headers with empty arguments, which rabtap always uses for headers. (b) On x-consistent-hash (an integer weight key is required), x-modulus-hash and x-random, the tap exchange becomes one of the single-choice destinations and takes messages. Modulus-hash also remaps keys. x-local-random rejects the binding. (c) If the client dies between exchange.bind and queue.bind, the auto-delete tap exchange never auto-deletes, because auto-delete triggers only when it loses its last binding as a source. It then keeps changing routing; on hash and random exchanges its share of messages goes nowhere. (d) On 4.3.0 to 4.3.5, deleting an exchange that is the destination of an exchange-to-exchange binding from a consistent-hash exchange leaves a stale ring bucket that silently drops messages, and no binding.deleted event is emitted (#17255, fixed in 4.3.6 by #17257). |
| T2 | nuanced | high | Confirmed with additions. - Firehose state is a per-node application-environment list (rabbit.trace_vhosts, default [] at boot). rabbit_trace:start/1 updates only the local node and refreshes only local channels, AMQP 1.0 sessions and non-AMQP connections. So tracing is per node and per vhost, and is lost on restart. - PUT /api/vhosts/{v} with {tracing:true} runs rabbit_vhost:put_vhost on the node that serves the request, so only that node traces. The tracing field returned by GET /api/vhosts/{v} also reflects only the serving node. rabbitmqctl trace_on is likewise per node (-n). - Trace messages are generated on the node of the publishing or consuming connection. - Publish traces carry exchange_name, routing_keys, properties and node, plus vhost, connection, channel, user and routed_queues. routed_queues is empty for unroutable messages. The docs table omits the last five fields. Deliver traces carry redelivered. - Trace messages are published at-most-once. - Not traced: stream-protocol publishes and reads, dead-lettering, and local shovels. - Docs: 'performance will drop somewhat'. - rabbitmq_tracing is still shipped (deps at v4.3.6, v4.4.x and main; release notes 4.3.0 list a tracing-plugin fix). - Its HTTP API has node-targeted routes (/api/traces/node/{node}/{vhost}/{name}, /api/trace-files/node/{node}/...) that rpc:call rabbit_tracing_traces on the chosen node, which calls rabbit_trace:start. An HTTP-only, admin-tagged client CAN therefore enable tracing on every node when the plugin is enabled. Plugin trace definitions live in ETS and are also lost on restart. - Side effect: PUT /api/vhosts/{v} with only {tracing:true} also rewrites description to '' and tags to []. In source from 4.1.x on, it also rewrites default_queue_type to the node default. |
| T3 | confirmed | high | Confirmed. Release notes 4.0.1: 'RabbitMQ 4.x will not interpret this x-death header anymore when clients (re-)publish a message'. In 3.13.x the broker parsed a published x-death into its deaths annotation (headers_to_deaths/recover_deaths); 4.0+ has no such code. Behaviour of a client-published x-death in 4.x: - It is kept as an opaque header and delivered verbatim to 0-9-1 consumers until the next dead-lettering. - At that point mc:record_death starts a fresh history (count 1, because there is no broker deaths annotation) and sets x-first-death-*. - mc_amqpl:protocol_state then replaces the header with set_table_value. Broker annotation headers win over same-named client headers, because annotations are prepended and then deduplicated with lists:usort. AMQP 0-9-1 format: header x-death is an array of tables, one per {queue, reason} pair, most recent first. Fields: - count (long) - reason (longstr: rejected \| expired \| maxlen \| delivery_limit) - queue (longstr) - time (timestamp in seconds, of the FIRST death for that pair) - exchange (longstr) - routing-keys (array of longstr; CC included, BCC excluded) - optional original-expiration (longstr) Alongside the array there are longstr headers x-first-death-queue, x-first-death-reason and x-first-death-exchange (never modified afterwards) and x-last-death-queue, x-last-death-reason and x-last-death-exchange (updated on each dead-lettering). AMQP 1.0 format: message annotation x-opt-deaths is an array of maps with symbol keys: - queue (string) - reason (symbol) - count (ulong) - first-time and last-time (timestamp, milliseconds) - exchange (string) - routing-keys (array of string) - optional ttl (uint) The six x-first-death-* and x-last-death-* values are message annotations. A client-supplied x-opt-deaths is likewise kept until the broker records a death, and then replaced. It is converted into an x-death header for 0-9-1 consumers but never interpreted. Feature flag message_containers_deaths_v2 (stable in 3.13–4.2, required from 4.3.0) fixes death ordering and cycle detection. |
| T4 | nuanced | high | Deprecated features: CONFIRMED, plus more. 4.3.0 moved amqp_address_v1, amqp_filter_set_bug, global_qos, queue_master_locator and transient_nonexcl_queues from permitted_by_default to denied_by_default, and removed ram_node_type. CQv1 queue arguments (x-queue-mode, x-queue-version=1) are rejected and Mnesia is removed. Effects seen in source (v4.3.6): - A transient non-exclusive queue.declare fails with protocol_error internal_error (connection-level) unless deprecated_features.permit.transient_nonexcl_queues=true is set on ALL nodes. - An x-queue-master-locator argument fails with internal_error, and the queue-master-locator policy key is rejected. - basic.qos global=true is NOT rejected; it is silently downgraded to per-consumer prefetch. - AMQP address v1 links are refused. - Legacy non-described rabbitmq:stream-* filter values are silently dropped. Passive declares: INCORRECT for current 4.3. - 4.3.0 and 4.2.6 required configure. - 4.3.1+ and 4.2.7+ accept ANY one of configure, write or read on the resource (docs: 'Starting with RabbitMQ 4.3.1 ... at least one permission'). - 4.2.5 and earlier, 4.1.8, 4.0.9 and 3.13.7 had no permission check for passive declares. Consumer timeouts: CONFIRMED. From 4.3, delivery-acknowledgement timeouts are evaluated only by quorum queues; a new consumer_disconnected_timeout setting also exists for them. Classic queues and streams never time out consumers. |
| T5 | nuanced | high | Broker side: CONFIRMED. - The open-source UI has get_message:false and purge:false for streams. - basic.get on a stream returns protocol_error not_implemented, which is a connection-level error in 0-9-1. HTTP /get uses basic.get, so it fails the same way. - Tanzu RabbitMQ 4.3 ships a closed-source Stream Browser. - Stage-2 AMQP filter expressions are AMQP 1.0 only (property filters from 4.1.0, SQL from 4.2.0, mutually exclusive). Bloom filters (3.13+) work over AMQP 1.0, 0-9-1, the stream protocol and STOMP. Correction for 0-9-1: - A per-consumer prefetch above 0 is mandatory, otherwise PRECONDITION_FAILED. - Manual acknowledgement is mandatory; no_ack gives not_implemented. - Global QoS is rejected. - x-stream-offset is optional (the default is next) but needed to read history. - The connection must be on a node that hosts a stream replica ('does not have a running replica on the local node'). JS AMQP 1.0 client (coders51 rabbitmq-amqp-js-client 1.0.0, 2026-06-25, ISC, linked from rabbitmq.com): - Supported in its API: stream offsets (first, last, next, numeric, timestamp), Bloom values, match-unfiltered, properties and application-properties filters, and SQL filters. - Settlement: accept, discard (rejected or modified with delivery-failed and undeliverable-here) and requeue (released or modified without failure). - Management: declare and delete queues and exchanges, queue info (leader, replicas, counts), bind and unbind (unbind only for bindings without arguments). - OAuth token refresh via PUT /auth/tokens, also used on reconnect. - Missing: purge, vhost selection (issue #95 open; no hostname option, so it always uses the default vhost), and a SASL EXTERNAL option (rhea has enable_sasl_external, but the typed API does not expose it). Critical encoding defects, found by reading the source: - Offset-spec, Bloom values and match-unfiltered are sent as non-described filter values. 4.0 accepts them, 4.1–4.2 accept them because amqp_filter_set_bug is permitted, and 4.3+ silently ignores them by default, so consumers start at next. - Numeric and timestamp offsets are BigInt values. rhea's wrap has no bigint branch and encodes them as an empty map, so they are ignored on every version. Offset.offset(0n) sends the string 'numeric'. - Publisher and consumer addresses are not percent-encoded. - deliveryLimit maps to x-max-delivery-limit, which is not a RabbitMQ argument; the broker uses x-delivery-limit. - The client offers the removed lazy and CQv1 arguments. - rhea is pulled from GitHub HEAD. - Its CI tests only against rabbitmq:4.2-management. |
| T6 | nuanced | high | (a) CONFIRMED. management_metrics_collection is declared with deprecation_phase => permitted_by_default on v4.2.9, v4.3.6, v4.4.x and main. It can be disabled with management_agent.disable_metrics_collector=true or deprecated_features.permit.management_metrics_collection=false. (b) NUANCED. With stats disabled, queue responses lacked policy, operator_policy, effective_policy_definition and delivery_limit (#15182). #15651 fixed this in 4.2.5 AND 4.3.0. Affected versions: 3.13.x, 4.0.x, 4.1.x and 4.2.0–4.2.4. (c) CONFIRMED. /api/channels and /api/channels/{ch} returned 400 'Stats in management UI are disabled on this node' whenever stats were disabled, including per request via ?disable_stats=true, through 4.3.5. 4.3.6 returns basic info (#17198). Open-source 4.2.9 still returns 400. Static connection info with stats disabled arrived in 4.2.6 and 4.3.0 (#16009). (d) NUANCED. With stats disabled, message counts are returned only when enable_queue_totals is true. That can be set by config (management.enable_queue_totals=true) OR per request with ?enable_queue_totals=true: on list endpoints from 3.13.0, and on the single-queue endpoint from 3.13.1. Also with stats disabled, /api/nodes returns only name, type, running and being_drained (no memory, file-descriptor, disk or alarm data), and /api/overview returns only object totals plus the disable_stats and enable_queue_totals flags. (e) /metrics/detailed with repeatable family and vhost parameters exists in all supported series (present at v3.9.29). The queue=<regex> filter (one value only; an invalid regex gives 400) was added in 4.3.0 (#15689, merged 2026-03-11). It does not appear in any 4.2.x release notes. /metrics/memory-breakdown exists from 4.0. Prometheus endpoints work regardless of the management stats setting. |
| T7 | nuanced | high | Mostly confirmed for 4.3.6. No HTTP route exists for: - rabbitmq-queues peek, grow_to_count, transfer_leadership, force_checkpoint and reclaim_quorum_memory. - rabbitmq-streams add_replica, delete_replica, grow, shrink, stream_status, restart_stream, transfer_leadership and coordinator_status. - Stream single-active-consumer group listing and activation, and reset_offset. - rabbitmq-upgrade drain, revive and await_online_quorum_plus_one. - rabbitmq-plugins enable and disable. - join_cluster, forget_cluster_node and node reset. - set_log_level, memory and disk watermarks, and log_tail. Corrections: - delete_super_stream is not CLI-only. The stream protocol has create_super_stream and delete_super_stream commands (since 3.13), and the same result can be composed from HTTP partition-queue and exchange deletes. HTTP adds PUT /api/stream/super-streams/{v}/{name} for creation only, from 4.1. - DELETE /api/reset[/{node}] resets management statistics (rabbit_mgmt_storage), not a node. - /api/queues/{v}/{q}/actions exists but accepts no action in 4.x. - Stream status is partly visible through queue details and the stream protocol's stream_stats. The operations that do have HTTP routes are listed in the report. |
| T8 | confirmed | high | Confirmed. - AMQP 0-9-1 queue.purge checks only read on the queue, the same at 3.13.7, 4.0.9 and 4.3.6. - AMQP 1.0 management DELETE /queues/{q}/messages checks read. - HTTP DELETE /api/queues/{v}/{q}/contents needs a management-tagged user with vhost access, then runs queue.purge as that user, so it needs read. - Neither the classic queue process nor the quorum queue purge path calls rabbit_event. The documented internal-event routing keys contain no purge event; they cover queue.created and queue.deleted, binding.*, consumer.*, policy.*, parameter.*, vhost.*, user.*, permission.*, alarm.*, and shovel and federation status. - Separately: the AMQP 1.0 'get queue' operation needs no permission. - The HTTP API logs no requests by default. management.http_log_dir enables per-node access logs after a plugin or node restart. |
| T9 | nuanced | high | CORS is opt-in, not a server-side refusal. - rabbit_mgmt_cors adds Access-Control-Allow-Origin only when the request's Origin is listed in management.cors.allow_origins, which is empty by default. - A listed origin is echoed back with Access-Control-Allow-Credentials: true. A configured '*' returns ACAO '*' without credentials. - The server still runs cross-origin requests. Browsers refuse to expose the responses and block non-simple requests at preflight. - Preflights advertise the module's allowed methods and echo the requested headers. - management.cors.max_age defaults to 1800 s, but in source the max-age header is dropped whenever the preflight carries Access-Control-Request-Headers. 4.3.2 and 4.2.8 hardened CORS: requested headers are now validated (cow_http_hd) and an Origin value of '*' is rejected ('null' already was). The same releases stopped putting internal error details in 500 response bodies and capped the size of definitions uploads. AMQP 1.0 over WebSocket is Tanzu-only: the docs for 4.3 and Next say so, and there is no rabbitmq_web_amqp in the open-source deps at v4.3.6, v4.4.x or main. The open-source browser-native protocols are Web-STOMP and Web-MQTT. From 4.3.0 they validate Origin via web_stomp.allow_origins and web_mqtt.allow_origins, and 4.4 adds strict_origin_validation. |
| T10 | nuanced | high | Latest open-source GitHub releases: - 3.13.7 (2024-08-26) - 4.0.9 (2025-04-14) - 4.1.8 (2026-01-22) - 4.2.9 (2026-07-20) - 4.3.6 (published 2026-09-14; the release-information page says 16 Sept 2026) rabbitmq.com/release-information also lists 4.2.10 (17 Aug 2026) and 4.2.11 (16 Sept 2026). Their GitHub tags and releases do not exist (404), so they are commercial-only builds made after 4.2 community support ended. Support end dates (community / commercial, indicative): - 3.13: 30 Sept 2024 / 31 Dec 2029 - 4.0: 30 Apr 2025 / 30 Sept 2026 (no support of any kind remains) - 4.1: 31 Jan 2026 / 30 Apr 2027 - 4.2: 31 Jul 2026 / 30 Jun 2030 - 4.3: 31 Jan 2027 / 30 Apr 2028 There are no 4.4 or 5.0 beta or rc tags. rabbitmq/server-packages publishes rolling alpha builds: - 4.4.0-alpha.<sha> from the v4.4.x branch (for example 2026-10-13 to 15) - 5.0.0-alpha.<sha> from main (2026-10-15/16) - 4.3.7-alpha from v4.3.x, which also has draft 4.3.7 release notes Khepri: - 3.13: experimental, with no in-place upgrade path to 4.0. - 4.0 and 4.1: fully supported, opt-in via feature flag khepri_db. - 4.2.0: default for new deployments; upgraded clusters keep Mnesia. - 4.3.0: the only metadata store. Mnesia is removed, and in-place upgrades are allowed only from 4.2.x with the required flags, including khepri_db. |
| X1 | nuanced | high | Static connection info (peer address, TLS details, auth mechanism) is returned with stats disabled from both 4.2.6 and 4.3.0 (#16009). Versions before that omit it. |
| X2 | nuanced | high | 4.3.6 is the latest; GitHub published it on 2026-09-14 and the release-information page dates it 16 Sept 2026. The 4.2 series is no longer patched in open source: community support ended on 31 Jul 2026, and the open-source line stops at 4.2.9. 4.2.10 and 4.2.11 are listed but are not public on GitHub (commercial-only). 4.4.0 and 5.0.0 exist only as alpha builds, and 4.3 is Khepri-only. Both of those parts are confirmed. |
| X3 | confirmed | high | With rabbitmq_tracing enabled, an administrator can use node-targeted routes: - PUT /api/traces/node/{node}/{vhost}/{name} with pattern, format and max_payload_bytes - DELETE on the same path - GET /api/trace-files/node/{node}/{name} Each call rpc:calls rabbit_tracing_traces on that node, which calls rabbit_trace:start(VHost) there. This works through any management endpoint, so a load balancer is not a problem. The routes are present from 3.13.7 through main. Trace definitions are held in ETS and lost on restart. Each trace also writes a file on that node's local disk. |
| X4 | nuanced | medium | On every version, accept_content defaults a missing description to '' and missing tags to '', and the update merges them over the existing values, so both are wiped. From a 4.1.x patch onward (present at v4.1.4, absent at v4.1.0 and 4.0.9), vhost:new_metadata(D, T, undefined) also injects default_queue_type set to the node default. The merger keeps the current queue type only when the new value is undefined, so a PUT that omits default_queue_type apparently resets a vhost's default queue type (for example quorum) to the node default. This last point is from reading source only and is untested. Safe pattern: GET the vhost, then PUT back description, tags, default_queue_type and tracing together. |
| X5 | refuted | medium | On 4.3.x defaults: - Offset.first(), Offset.last() and Offset.next(), Bloom filterValues and matchUnfiltered are sent as non-described filter-set values and dropped by the broker because amqp_filter_set_bug is denied. The consumer attaches at the default offset, next. - Offset.offset(n) and Offset.timestamp(d) carry BigInt values, which rhea encodes as an empty map, so they are ignored on every version. - Only property filters and SQL filters, which use wrap_described with descriptors 0x173, 0x174 and 0x120, are encoded correctly. Workarounds: set deprecated_features.permit.amqp_filter_set_bug = true on the broker, patch the client to send described values with ulong or timestamp types, or use the stream protocol. |

### Evidence

- **T1** (nuanced, high): rabbit_channel.erl@v4.3.6 L1048-1050: check_not_default_exchange raises protocol_error(access_refused, 'operation not permitted on the default exchange'). It is applied to both source and destination at L1849 in binding_action_with_checks (L1839-1861), which also does check_write_permitted on the destination (L1847), check_read_permitted on the source (L1850) and check_read_permitted_on_topic (L1855). https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_channel.erl
Same file L2191-2202: process_routing_mandatory(true, [] ...) calls basic_return(no_route).
rabbit_exchange.erl@v4.3.6 L419-439: route1 with process_alternate(X, []) reads the alternate-exchange only when that exchange's own result is empty. https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_exchange.erl
Consistent hash @v4.3.6: L52-72 route (jump_consistent_hash returns a single [Queue]) and L94-110 validate_binding (integer weight). https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_consistent_hash_exchange/src/rabbit_exchange_type_consistent_hash.erl
Modulus hash @v4.3.6 L41-52: rabbit_router:match_routing_key(Name, ['_']) then lists:nth(Hash rem Len + 1, DestinationsSorted). https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_exchange_type_modulus_hash.erl
Modulus-hash docs: 'if you add or remove queues (changing N), the routing for almost all keys will be reshuffled'. https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/modulus-hash-exchange.md
Release notes 4.3.0 L236-240: x-modulus-hash moved into core. Before that it was rabbitmq_sharding/src/rabbit_sharding_exchange_type_modulus_hash.erl (present at v4.2.0).
Local random @v4.3.6: L45-55 route (filter_local_queue requires node(Pid) =:= node(); rand:uniform picks one) and L86-106 validate_binding (rabbit_amqqueue:lookup(Dest) must be rabbit_classic_queue, otherwise 'Destination not found'; a non-empty key is not permitted). The file is absent at v3.13.7 and present at v4.0.0. https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_exchange_type_local_random.erl
x-random @v4.3.6 L39-46: one random destination. https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_random_exchange/src/rabbit_exchange_type_random.erl
Headers @v4.3.6: L31-46 (no x-match means match_all) and L64-65 (match_all([], _, _) -> true). https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_exchange_type_headers.erl
Recent-history add_binding replays the cache (L70-92). https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_recent_history_exchange/src/rabbit_exchange_type_recent_history.erl
rabtap pkg/tap.go: ExchangeBind(..., amqp.Table{}), with a TODO noting that all messages sent to headers exchanges are always seen. https://raw.githubusercontent.com/jandelgado/rabtap/master/pkg/tap.go
Max-length docs L57-65: reject-publish triggers basic.nack, even when only one of several routed queues rejects. https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/maxlength/index.md
Topic empty-key bug: release notes 4.3.1 L23-29 (#16271; the fix needs feature flag topic_binding_projection_v5). https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/release-notes/4.3.1.md
- **T1b** (refuted, high): rabtap README L72-73: 'tap to messages being sent to exchanges using RabbitMQ exchange-to-exchange bindings without affecting actual message delivery'. https://raw.githubusercontent.com/jandelgado/rabtap/master/README.md
rabtap pkg/tap.go setupTap: a fanout tap exchange (auto-delete), ExchangeBind with amqp.Table{}, then CreateQueue(non-durable, auto-delete, exclusive); TODO comments on headers and on cleanup after connection loss. https://raw.githubusercontent.com/jandelgado/rabtap/master/pkg/tap.go
Issue #17255: 'stale bucket in the hash ring that keeps routing to the deleted exchange, causing silent message loss', 4.3.x regression. https://github.com/rabbitmq/rabbitmq-server/issues/17255
Release notes 4.3.6: 'Deleting an exchange did not delete the bindings that pointed to it as a destination' (#17255, #17257). https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/release-notes/4.3.6.md
Exchange-type sources as in T1.
- **T2** (nuanced, high): rabbit_trace.erl@v4.3.6:
- L100-110 start/1.
- L124-143 update_config: application:set_env(rabbit, trace_vhosts, VHosts), then rabbit_amqp_session:list_local(), rabbit_networking:local_non_amqp_connections() and rabbit_channel:refresh_config_local/0.
- L59-72 tap_in adds vhost, connection, channel, user and {routed_queues, array, RoutedQs}.
- L151-170 trace calls rabbit_queue_type:publish_at_most_once.
- L172-185 headers exchange_name, routing_keys, properties, node.
https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_trace.erl
deps/rabbit/Makefile@v4.3.6 L53: {trace_vhosts, []}.
rabbit_vhost.erl@v4.3.6: L450-491 put_vhost ends with 'case Trace of true -> rabbit_trace:start(Name)' (L486-490); L759 i(tracing) = rabbit_trace:enabled (local). https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_vhost.erl
rabbit_mgmt_wm_vhost.erl@v4.3.6: L66 parses tracing; L67-68 description and tags default to ''; L75 calls put_vhost; L129-130 is_authorized_admin. https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/src/rabbit_mgmt_wm_vhost.erl
trace_on_command.ex@v4.3.6: :rabbit_misc.rpc_call(node_name, :rabbit_trace, :start, [vhost]). https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_cli/lib/rabbitmq/cli/ctl/commands/trace_on_command.ex
rabbit_channel.erl@v4.3.6 L1234-1237: tap_in runs right after rabbit_exchange:route for every publish.
Zero rabbit_trace calls at v4.3.6 in rabbit_stream_reader.erl, rabbit_dead_letter.erl, rabbit_fifo_dlx_worker.erl and rabbit_local_shovel.erl.
Firehose docs: 'on a per-node, per-vhost basis', 'performance will drop somewhat', 'the firehose state is not persistent'. https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/firehose.md
Tracing plugin:
- rabbit_tracing_mgmt.erl@v4.3.6 L14-23 routes, including /traces/node/:node/:vhost/:name.
- rabbit_tracing_util.erl apply_on_node: rpc:call(Node, Mod, Fun, Args).
- rabbit_tracing_traces.erl L60-65 calls rabbit_trace:start(VHost); state is ETS (L46-47).
https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_tracing/src/rabbit_tracing_mgmt.erl
vhost.erl@v4.3.6 L216-219: new_metadata(D, T, undefined) injects default_queue_type => rabbit_queue_type:default_alias(). L178-196: merge_with keeps the current value only when the new one is undefined. The injection is present at v4.1.4 and absent at v4.1.0 and v4.0.9. https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/vhost.erl
- **T3** (confirmed, high): Release notes 4.0.1 L70-80. https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/release-notes/4.0.1.md
mc_amqpl.erl@v3.13.7 L691-754: headers_to_deaths/recover_deaths. https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v3.13.7/deps/rabbit/src/mc_amqpl.erl
mc_amqpl.erl@v4.0.0: no client x-death parsing. https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.0.0/deps/rabbit/src/mc_amqpl.erl
mc.erl@v4.3.6: L389-452 record_death (first death sets x-first-death-* and x-last-death-*; later deaths update only x-last-*); L493-507 is_cycle_v2. https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/mc.erl
mc_amqpl.erl@v4.3.6: L446-483 protocol_state (deaths_to_headers, x- annotations turned into headers, dedup); L582-598 deaths_to_headers (set_table_value); L625-649 death_table; L167-168 x-opt-deaths becomes x-death. https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/mc_amqpl.erl
mc_amqp.erl@v4.3.6: L474-512 (client x-opt-deaths is filtered only when the broker has a deaths annotation); L692-717 encode_deaths. https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/mc_amqp.erl
DLX docs L310-365. https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/dlx.md
rabbit_core_ff.erl@v4.2.9 L187-192 (stable), and the required list in release notes 4.3.0 L122-131.
- **T4** (nuanced, high): Release notes 4.3.0: L23-44 (transient non-exclusive denied), L63-69 (consumer timeouts), L137-147 (deprecation phases), L291-294 (passive configure). https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/release-notes/4.3.0.md
Release notes 4.3.1 L35-38: passive declares allowed with any permission (#16272, #16085). https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/release-notes/4.3.1.md
rabbit_channel.erl passive queue.declare check by tag:
- check_configure_permitted at v4.3.0 (L2534) and v4.2.6.
- check_any_resource_access_permitted at v4.2.7, v4.2.9, v4.3.1-v4.3.6 (L2586 at v4.3.6), v4.4.x and main.
- No check at v3.13.7, v4.0.9, v4.1.8, v4.2.0 and v4.2.5.
At v4.3.6, L875-895 tries read, then write, then configure; L2690-2699 is the passive exchange.declare.
rabbit_channel.erl@v4.3.6: L242-246 global_qos denied_by_default; L1454-1470 downgrades to global=false when not permitted.
rabbit_amqqueue.erl@v4.3.6: L114-119; L225-245 {protocol_error, internal_error, Warning}.
rabbit_classic_queue.erl@v4.3.6 L109-146: queue-master-locator.
rabbit_amqp_session.erl@v4.3.6 L21-38: amqp_address_v1 and amqp_filter_set_bug denied_by_default.
Consumers docs: 'Starting with RabbitMQ 4.3, delivery acknowledgement timeouts are only supported by quorum queues.' https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/consumers.md
Access-control docs, passive declarations section. https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/access-control.md
- **T5** (nuanced, high): global.js@v4.3.6 L1019-1029: QUEUE_TYPE['stream'].actions {get_message:false, purge:false}. https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/priv/www/js/global.js
rabbit_stream_queue.erl@v4.3.6:
- L606-609 dequeue gives not_implemented 'basic.get not supported by stream queues'.
- L332-347: prefetch 0 gives precondition_failed; no_ack gives not_implemented; global qos gives not_implemented.
- L396-399 local-replica requirement.
- L404-410 parse_offset_arg(undefined) -> next.
https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_stream_queue.erl
4.3 release blog, 'Stream Browser' section. https://www.rabbitmq.com/blog/2026/04/23/rabbitmq-4.3-release
Stream-filtering docs: L131 and the comparison table L946 (Bloom: AMQP 1.0, AMQP 0.9.1, Stream protocol, STOMP; Stage 2: AMQP 1.0). https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/stream-filtering.md
Release notes 4.1.0 L20-25 and L164-170; release notes 4.2.0 L42-54.
rabbit_amqp_session.erl:
- @v4.3.6 L3303-3357: described offset-spec types, and L3350-3357 drops non-described rabbitmq:stream-* values unless amqp_filter_set_bug is permitted.
- @v4.1.8 L35-38: permitted_by_default.
- @v4.0.9 L3005-3069: keyfind_unpack_described accepts plain values.
JS client @v1.0.0:
- src/consumer.ts createConsumerFilterFrom: filters[STREAM_OFFSET_SPEC] = offset.toValue(), with no wrap_described for offset, Bloom or match-unfiltered.
- src/utils.ts Offset.toValue returns a bigint or a string.
- src/environment.ts and src/rhea_wrapper.ts: no vhost/hostname option.
- src/management.ts: no purge; buildUnbindEndpointFrom args=; x-max-delivery-limit.
- src/message.ts: addresses without encodeURIComponent.
- src/delivery_context.ts: outcomes.
- package.json: rhea github:amqp/rhea.
https://github.com/coders51/rabbitmq-amqp-js-client and https://registry.npmjs.org/rabbitmq-amqp-js-client
rhea lib/types.js wrap (L477-517): no bigint branch, falls through to wrap_map. lib/terminus.js L53: filter is a symbolic_map. https://raw.githubusercontent.com/amqp/rhea/main/lib/types.js
Quorum queue arguments rabbit_quorum_queue.erl@v4.3.6 L615-635: x-delivery-limit.
Issue #95: 'Add virtual host support to EnvironmentParams' (open). https://api.github.com/repos/coders51/rabbitmq-amqp-js-client/issues
- **T6** (nuanced, high): rabbit_mgmt_agent_config.erl L13-17 at v4.3.6, v4.4.x and main. https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.4.x/deps/rabbitmq_management_agent/src/rabbit_mgmt_agent_config.erl
Issue #15182. https://github.com/rabbitmq/rabbitmq-server/issues/15182
PR #15651 (merged 2026-03-06). https://github.com/rabbitmq/rabbitmq-server/pull/15651
Release notes 4.2.5 L93-97. https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/release-notes/4.2.5.md
Release notes 4.2.6 L116-118 and release notes 4.3.0 L435 (#16009).
Release notes 4.3.6, channels fix (#8240, #17198). https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/release-notes/4.3.6.md
rabbit_mgmt_wm_channels.erl: @v4.3.5 L28-40 calls bad_request when disable_stats; @v4.3.6 L46-51 uses filter_conn_ch_list.
rabbit_mgmt_util.erl@v4.3.6 L163-179: disable_stats/enable_queue_totals read the query string or the config.
rabbit_mgmt_wm_queues.erl@v4.3.6 L76-99.
Release notes 3.13.1 L130-136.
rabbit_mgmt_wm_nodes.erl@v4.3.6 L32-46.
rabbit_mgmt_wm_overview.erl@v4.3.6 L35-95.
Management docs L1217-1235. https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/management/index.md
Prometheus docs L541-596. https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/prometheus/index.md
PR #15689. https://github.com/rabbitmq/rabbitmq-server/pull/15689
rabbit_prometheus_dispatcher.erl at v3.9.29 through v4.2.0 (detailed and per-object; memory-breakdown from v4.0.9).
- **T7** (nuanced, high): rabbit_mgmt_dispatcher.erl@v4.3.6 L107-229, the full route list. https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/src/rabbit_mgmt_dispatcher.erl
rabbit_mgmt_wm_reset.erl@v4.3.6 L32-37: rabbit_mgmt_storage:reset_all().
rabbit_mgmt_wm_queue_actions.erl@v4.3.6 L54-55: unknown action returns bad_request.
rabbit_mgmt_wm_quorum_queue_replicas_add_member.erl@v4.3.6 L54-60: admin only, 405 when replica operations are disabled.
CLI command modules via the GitHub contents API at v4.3.6: deps/rabbitmq_cli/lib/rabbitmq/cli/{queues,streams,upgrade}/commands, and the deps/rabbitmq_stream/src Elixir.RabbitMQ.CLI.Ctl.Commands.* files (ActivateStreamConsumer, Add/DeleteSuperStream, ListStreamConsumerGroups, ListStreamGroupConsumers, ResetOffset).
rabbit_stream_reader.erl@v4.3.6 L2932 create_super_stream and L3007 delete_super_stream.
rabbit_stream_super_stream_mgmt.erl: PUT only, present from v4.1.8 (404 at v4.0.9).
Plugin routes: rabbit_shovel_mgmt_*.erl, rabbit_federation_mgmt.erl, rabbit_top_extension.erl and rabbit_tracing_mgmt.erl at v4.3.6.
- **T8** (confirmed, high): rabbit_channel.erl@v4.3.6 L2625-2628: check_read_permitted(QueueName...), the same at v3.13.7 and v4.0.9.
rabbit_amqp_management.erl@v4.3.6 L255-266: check_resource_access(QName, read, ...). https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_amqp_management.erl
rabbit_mgmt_wm_queue_purge.erl@v4.3.6 L25-33: queue.purge with is_authorized_vhost.
rabbit_amqqueue_process.erl@v4.3.6 L1472-1476 and rabbit_quorum_queue.erl@v4.3.6 L1410-1412: no rabbit_event call.
Access-control docs, permission tables (queue.purge = read; AMQP 1.0 'get queue' has no permission). https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/access-control.md
Logging docs, internal events list (lines 970-1039). https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/logging.md
Management docs L1121-1131: 'RabbitMQ nodes do not log any HTTP API requests by default'. https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/management/index.md
- **T9** (nuanced, high): rabbit_mgmt_cors.erl@v4.3.6: set_headers; handle_options L43-70 (ReqData2 is built from ReqData0, so access-control-max-age is lost when request headers are present); match_origin L72-95. https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/src/rabbit_mgmt_cors.erl
The Origin '*' rejection and header validation are absent at v4.3.1 and v4.2.7 and present at v4.2.8 and v4.3.2.
rabbitmq_management.schema@v4.3.6 L359-378: management.cors.allow_origins, management.cors.allow_origins.$name, management.cors.max_age.
Release notes 4.3.2 L111-121 (#16544). https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/release-notes/4.3.2.md
Release notes 4.2.8 L87-90.
AMQP docs L300 'VMware Tanzu RabbitMQ supports AMQP 1.0 over WebSocket', identical in versioned_docs/version-4.3/amqp.md. https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/amqp.md
GitHub contents API deps listings at v4.3.6, v4.4.x and main (rabbitmq_web_mqtt and rabbitmq_web_stomp only).
Release notes 4.3.0 Web MQTT and Web STOMP sections, and release notes 4.4.0 draft L322-370. https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.4.x/release-notes/4.4.0.md
- **T10** (nuanced, high): GitHub API tags. https://api.github.com/repos/rabbitmq/rabbitmq-server/tags?per_page=100
GitHub API releases. https://api.github.com/repos/rabbitmq/rabbitmq-server/releases?per_page=100
releases/tags/v4.2.10 and v4.2.11 return 404. https://github.com/rabbitmq/rabbitmq-server/releases/tag/v4.2.11
Release-information table. https://www.rabbitmq.com/release-information
server-packages releases API (names such as 'RabbitMQ 4.4.0-alpha.f14bc105', 'RabbitMQ 5.0.0-alpha.6e3f598a', 'RabbitMQ 4.3.7-alpha.257b3f4f'). https://api.github.com/repos/rabbitmq/server-packages/releases
Branches v4.3.x, v4.4.x and main; release-notes directory listings (4.3.7.md on v4.3.x; 4.4.0.md on v4.4.x and main; 5.0.0.md on main).
Release notes 4.2.0 L106-133 (Khepri default). https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/release-notes/4.2.0.md
Release notes 4.3.0 L81-91 and L113-131.
Release notes 4.0.1 L12-13 and L211-216.
Release notes 3.13.0 L15.
- **X1** (nuanced, high): Release notes 4.2.6 L116-118. https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/release-notes/4.2.6.md
Release notes 4.3.0 L435 (#16009).
- **X2** (nuanced, high): See the T10 evidence. https://www.rabbitmq.com/release-information
https://api.github.com/repos/rabbitmq/server-packages/releases
- **X3** (confirmed, high): rabbit_tracing_mgmt.erl@v4.3.6 L14-23. https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_tracing/src/rabbit_tracing_mgmt.erl
rabbit_tracing_util.erl@v4.3.6 apply_on_node: rpc:call(Node, Mod, Fun, Args). https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_tracing/src/rabbit_tracing_util.erl
rabbit_tracing_traces.erl@v4.3.6: L60-65 calls rabbit_trace:start; L46-47 ETS.
rabbit_tracing_wm_trace.erl@v4.3.6: is_authorized_admin.
Count of /node/ routes is 5 at v3.13.7, v4.0.9, v4.1.8, v4.2.0 and v4.2.9.
- **X4** (nuanced, medium): rabbit_mgmt_wm_vhost.erl@v4.3.6 L61-75. https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/src/rabbit_mgmt_wm_vhost.erl
rabbit_vhost.erl@v4.3.6: L381-383 update; L323-345 update_metadata (removes default_queue_type only when it is 'undefined', '', null or nil). https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_vhost.erl
vhost.erl@v4.3.6 L178-196 and L216-235. https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/vhost.erl
vhost.erl at v4.1.0 vs v4.1.4.
rabbit_mgmt_http_SUITE.erl@v4.3.6 L596-626: the tests use only the default queue type, so they would not catch this.
- **X5** (refuted, medium): src/consumer.ts and src/utils.ts at v1.0.0. https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/src/consumer.ts
rhea types.wrap (no bigint branch) and terminus filter: symbolic_map. https://raw.githubusercontent.com/amqp/rhea/main/lib/types.js
rabbit_amqp_session.erl@v4.3.6 L3303-3357: parse_filters, the legacy clause and the deprecated-feature check. https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_amqp_session.erl
rabbit_stream_queue.erl@v4.3.6 L404-410: default next.
The client's docker-compose uses rabbitmq:4.2-management, and its e2e tests only use Offset.first().

## Report

# RabbitMQ verification for the planned tool: live capture, streams, dead-letter headers, 4.3 restrictions, metrics, operations, access, versions (2026-10-16)

## 0. Method and notation

Everything below comes from reading code. No broker was run. Code was read at exact tags with read-only `curl` and `gh api` calls:
- mainly `v4.3.6`
- compared against `v3.13.7`, `v4.0.0` and `v4.0.9`, `v4.1.0`, `v4.1.4` and `v4.1.8`, `v4.2.0` through `v4.2.9`, `v4.3.0` through `v4.3.5`
- the `v4.4.x` and `main` branches

Notation:

| Short form | Meaning |
| --- | --- |
| `rs@TAG:path Lx-y` | https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/TAG/path, with line numbers as fetched |
| `web:path` | https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/path |
| `RN x.y.z` | `rs@v4.3.6:release-notes/x.y.z.md` |

Labels:

| Label | Meaning |
| --- | --- |
| **[S]** | Read in source code |
| **[D]** | Documentation |
| **[RN]** | Release notes |
| **[GH]** | GitHub issue or pull request |

---

## 1. Verdicts T1–T10, plus new findings X1–X5

### T1. Live tap side effects: NUANCED (mostly confirmed, with sharper conditions)

**(1) A copied-binding tap cannot see default-exchange traffic. CONFIRMED [S].**
- `rs@v4.3.6:deps/rabbit/src/rabbit_channel.erl L1048-1050`: `check_not_default_exchange(#resource{kind = exchange, name = <<"">>}) -> rabbit_misc:protocol_error(access_refused, "operation not permitted on the default exchange", [])`.
- The check is applied to both source and destination in `binding_action_with_checks` (L1849).
- So the tap never sees:
  - direct-to-queue publishes (`basic.publish` to `""`, such as amqplib `sendToQueue`)
  - AMQP 1.0 `/queues/{q}` targets
  - STOMP `/queue` and `/amq/queue`
  - dead-lettering through DLX `""` (a common retry pattern)
  - shovels or federation writing to a queue.
- Its published code is `bindQueue(queue, binding.source, binding.routingKey)`, which passes no binding arguments.

**(2) Taps divert messages on single-destination exchange types. CONFIRMED, with details [S].**

| Exchange type | What the tap does | Source |
| --- | --- | --- |
| `x-consistent-hash` | Route returns exactly one destination (`jump_consistent_hash` picks a bucket). A tap with weight W takes W divided by the total weight of the hash space. The binding key must be an integer weight. Exchanges may be destinations, so exchange-to-exchange (E2E) taps divert too. | `rs@v4.3.6:deps/rabbitmq_consistent_hash_exchange/src/rabbit_exchange_type_consistent_hash.erl L52-72, L94-110` |
| `x-modulus-hash` | `Destinations = rabbit_router:match_routing_key(Name, ['_'])` … `lists:nth(Hash rem Len + 1, DestinationsSorted)`. The tap takes about 1/(N+1) of messages. Because N changes, almost every routing key moves to a different queue, which breaks per-key ordering and single-active-consumer partition designs. Docs: "if you add or remove queues (changing N), the routing for almost all keys will be reshuffled". Moved into core in 4.3.0; before that it came from `rabbitmq_sharding`. | `rs@v4.3.6:deps/rabbit/src/rabbit_exchange_type_modulus_hash.erl L41-52`; `web:docs/modulus-hash-exchange.md`; RN 4.3.0 L236-240 |
| `x-random` | Picks one random destination among all bindings (OSS plugin), so the tap takes 1/(N+1). | `rs@v4.3.6:deps/rabbitmq_random_exchange/src/rabbit_exchange_type_random.erl L39-46` |
| `x-local-random` (since 4.0) | `validate_binding` requires the destination to be an existing **classic queue** with an empty key. Otherwise it fails with "Destination not found" or "Non empty binding … key not permitted", raised as PRECONDITION_FAILED. **E2E taps are therefore impossible.** A tap queue competes only for messages published on its own node (`filter_local_queue` checks `node(Pid) =:= node()`). Publishes on other nodes are invisible to it. | `rs@v4.3.6:deps/rabbit/src/rabbit_exchange_type_local_random.erl L45-55, L86-124` |
| `x-recent-history` | `add_binding` replays cached messages into the new tap. The tap shows history first, then live messages. | `.../rabbit_exchange_type_recent_history.erl L70-92` |

**(3) "Any tap turns unroutable messages into routed ones." NUANCED [S].**
- The alternate exchange (AE) is checked per exchange, and only when that exchange's own destinations (queues or exchanges) are empty. Source: `rs@v4.3.6:deps/rabbit/src/rabbit_exchange.erl L419-439`, `process_alternate(X, [])`.
- A mandatory `basic.return` fires only when no queue was reached. Source: `rabbit_channel.erl L2191-2202`, `process_routing_mandatory(true, [] …) -> basic_return(… no_route)`. Otherwise the broker counts `messages_unroutable_dropped`.
- So a tap changes routability only if it matches messages that no existing binding already routes:
  - **Always** for exchange-wide taps: `#` on topic, `""` on fanout, or headers with no arguments.
  - **Never** for an exact copy of an existing queue binding, with three exceptions:
    - headers bindings copied **without** their arguments
    - the 4.3.0 topic empty-key bug (RN 4.3.1 L23-29: a queue bound with `""` receives `""` publishes from **any** topic exchange; the fix needs feature flag `topic_binding_projection_v5`)
    - the target's binding being removed while the tap remains.
- When routability does change, the tap also hides unroutable-message counters and alerts.

**(4) Headers exchanges need the binding arguments copied. CONFIRMED [S].**
- `rs@v4.3.6:deps/rabbit/src/rabbit_exchange_type_headers.erl L31-46, L64-65`: with no `x-match`, the exchange uses `match_all`, and `match_all([], _, _) -> true`. The binding key is ignored.
- A tap must copy `arguments`, including `x-match` with `all`, `any`, `all-with-x` or `any-with-x`, plus the header pairs.
- Both therefore see **all** traffic on headers exchanges and silence that exchange's AE.

**Further side effects [S]/[D]:**
- A tap backlog can trigger memory or disk alarms, which block **all** publishers in the cluster.
- `x-overflow=reject-publish`, set directly or inherited from a catch-all policy, makes confirming publishers receive `basic.nack` (`web:docs/maxlength/index.md L57-65`).
- A catch-all dead-letter-exchange policy sends tap overflow into production dead-letter queues.
- Publisher confirms now also wait for the tap queue.
- On 4.2+, an operator can disable queue types, including classic (RN 4.2.0 L238-242).
- On 4.3, transient non-exclusive queues are denied, so tap queues must be exclusive.

### T1b. "Exchange-to-exchange taps (rabtap) leave delivery untouched": REFUTED as a general claim

- rabtap (`https://raw.githubusercontent.com/jandelgado/rabtap/master/pkg/tap.go`) declares an auto-delete fanout tap exchange.
- It then calls `ExchangeBind(tapExchange, bindingKey, exchange, false, amqp.Table{})` and adds a non-durable, auto-delete, exclusive queue.
- Its README (L72-73) says "without affecting actual message delivery". That is true only in the narrow sense that queues on direct, topic, fanout and headers exchanges keep their messages.

It is false in these cases:
- **Alternate exchange and mandatory.** The tap exchange is a destination of the source exchange. With broad keys, the source's AE and mandatory returns stop working.
- **Diversion.** The tap exchange takes messages on CHX, modulus-hash and x-random exchanges, and the binding is rejected on x-local-random.
- **Orphaned tap exchanges.** If the client dies between `exchange.bind` and `queue.bind`, the tap exchange never auto-deletes. Auto-delete triggers only when an exchange loses its last *source* binding. Routing stays changed for good, and on hash or random exchanges that share of messages goes nowhere.
- **Consistent-hash regression on 4.3.0–4.3.5 [GH].** Deleting an exchange that is the destination of an E2E binding from a consistent-hash exchange "keeps routing to the deleted exchange, causing silent message loss", and no `binding.deleted` event is emitted. Reported in https://github.com/rabbitmq/rabbitmq-server/issues/17255, fixed in 4.3.6 (#17257, RN 4.3.6).

### T2. Firehose: NUANCED (core claims confirmed, plus an HTTP route to every node and a metadata-overwrite risk)

**Per node, per vhost, not persisted. CONFIRMED [S][D].**
- `rs@v4.3.6:deps/rabbit/src/rabbit_trace.erl L100-143`: `start/1` runs `update_config`, which calls `application:set_env(rabbit, trace_vhosts, VHosts)`. It then refreshes only *local* channels (`rabbit_channel:refresh_config_local/0`), local AMQP 1.0 sessions and local non-AMQP connections.
- The default is `{trace_vhosts, []}` (`deps/rabbit/Makefile L53`), so the setting is lost at boot.
- Docs (`web:docs/firehose.md`): "on a per-node, per-vhost basis" and "the firehose state is not persistent".
- `rabbitmqctl trace_on` is also per node: `rpc_call(node_name, :rabbit_trace, :start, [vhost])`.

**The HTTP vhost flag affects only the node serving the request. CONFIRMED [S].**
- `rs@v4.3.6:deps/rabbitmq_management/src/rabbit_mgmt_wm_vhost.erl L61-75` calls `rabbit_vhost:put_vhost(... Trace ...)` locally.
- `rabbit_vhost.erl L486-490` then runs `case Trace of true -> rabbit_trace:start(Name)`.
- `GET` reports `tracing` from `rabbit_trace:enabled/1` on the serving node (`rabbit_vhost.erl L759`), so behind a load balancer the flag appears to flip between requests.
- The request requires the administrator tag (`is_authorized_admin`, L129-130).
- Each trace is generated on the node of the publishing or consuming connection (`rabbit_channel.erl L1234-1237`, called right after routing).

**Trace contents. CONFIRMED [S].**
- Publish traces (`tap_in`, L59-72) carry:
  - the documented `exchange_name`, `routing_keys`, `properties` and `node`
  - and the undocumented `vhost`, `connection`, `channel`, `user` and **`routed_queues`**. `routed_queues` is empty for unroutable messages.
- Deliver traces carry `redelivered`.
- Traces are published with `rabbit_queue_type:publish_at_most_once`, so they can be lost.
- Not traced (no `rabbit_trace` calls at v4.3.6):
  - stream-protocol traffic (`rabbit_stream_reader.erl`)
  - dead-lettering (`rabbit_dead_letter.erl`, `rabbit_fifo_dlx_worker.erl`)
  - local shovels (`rabbit_local_shovel.erl`).
- Traced: AMQP 0-9-1, AMQP 1.0, MQTT, and STOMP (through 0-9-1 channels up to 4.3; natively in 4.4).
- Cost (docs): "performance will drop somewhat". Each traced message is converted to 0-9-1 and published again inside the channel process.

**Is `rabbitmq_tracing` still shipped? YES.**
- It is in `deps` at v4.3.6, v4.4.x and main, and RN 4.3.0 L665-669 lists a fix for it.
- **New (X3):** its HTTP API has node-targeted routes. They are `/api/traces/node/{node}/{vhost}/{name}` and `/api/trace-files/node/{node}/{name}` (`rabbit_tracing_mgmt.erl L14-23`).
- These routes call `rpc:call(Node, rabbit_tracing_traces, create, …)`, which runs `rabbit_trace:start` **on that node** (`rabbit_tracing_util.erl`, `rabbit_tracing_traces.erl L60-65`).
- So an HTTP-only administrator **can** enable tracing across the whole cluster.
- Trace definitions are kept in ETS (lost on restart). Each trace writes a file on that node's disk, fed by an unbounded no-ack queue.

**New (X4): metadata overwrite.** `PUT /api/vhosts/{v}` with only `{"tracing":true}`:
- resets `description` to `""` and `tags` to `[]` on every version, because the defaults are filled in at L67-68 and then merged;
- also appears to reset `default_queue_type` to the node default from 4.1.4 onward. `vhost:new_metadata(D, T, undefined)` injects `default_alias()`, and the merger keeps the current value only when the new one is `undefined`. This is from source only and untested.

### T3. x-death interpretation and formats: CONFIRMED

RN 4.0.1 L70-80: "RabbitMQ 4.x will not interpret this `x-death` header anymore when clients (re-)publish a message". In 3.13.7 the broker did interpret it (`mc_amqpl.erl L691-754`, `headers_to_deaths`/`recover_deaths`); 4.0.0 has no such code.

What happens to a client-published `x-death` in 4.x:
1. It is delivered **verbatim** (opaque) to 0-9-1 consumers until the next dead-lettering. AMQP 1.0 consumers do not see it as deaths.
2. At the next dead-lettering, `mc:record_death` (`rs@v4.3.6:deps/rabbit/src/mc.erl L389-452`) starts a **new** history with count 1, because the message has no broker deaths annotation. It also sets the `x-first-death-*` headers again.
3. `mc_amqpl:protocol_state` (L446-483) **replaces** the header (`set_table_value`, L582-598).
4. Broker annotation headers override same-named client headers (they are prepended, then deduplicated with `lists:usort`).

Format over **AMQP 0-9-1** (`death_table`, L625-649; `web:docs/dlx.md L310-365`):

```
x-death: array of tables, one per {queue, reason}, MOST RECENT FIRST
  count               long
  reason              longstr   rejected | expired | maxlen | delivery_limit
  queue               longstr
  time                timestamp (seconds) = FIRST death for this {queue,reason}
  exchange            longstr   exchange before this first death
  routing-keys        array of longstr (CC included, BCC excluded)
  original-expiration longstr   (optional, when per-message TTL was set)
x-first-death-queue / -reason / -exchange    longstr, never modified afterwards
x-last-death-queue  / -reason / -exchange    longstr, updated on each dead-letter
```

Format over **AMQP 1.0** (`rs@v4.3.6:deps/rabbit/src/mc_amqp.erl L692-717`):

```
message-annotation x-opt-deaths: array of map (symbol keys), most recent first
  queue string | reason symbol | count ulong | first-time timestamp(ms)
  last-time timestamp(ms) | exchange string | routing-keys array<string> | ttl uint (optional)
message-annotations x-first-death-{queue,reason,exchange}, x-last-death-{queue,reason,exchange} (utf8)
```

- A client-supplied `x-opt-deaths` is kept until the broker records a death, then replaced (L485-486).
- It is converted into an `x-death` header for 0-9-1 consumers (`mc_amqpl.erl L167-168`), but never interpreted.
- 0-9-1 lacks `last-time`. 0-9-1 `time` is the first death, in seconds.
- Feature flag `message_containers_deaths_v2` (stable in 3.13–4.2, required from 4.3.0) fixes the ordering of deaths and cycle detection. The cycle rule is: drop the message only in fully automatic cycles, meaning no `rejected` reason anywhere in the cycle.

### T4. 4.3 restrictions: NUANCED

**Deprecated features. CONFIRMED, plus more.** RN 4.3.0 L137-147: `amqp_address_v1`, `amqp_filter_set_bug`, `global_qos`, `queue_master_locator` and `transient_nonexcl_queues` move to `denied_by_default`, and `ram_node_type` is removed. CQv1 arguments (`x-queue-mode`, `x-queue-version=1`) are now rejected, and Mnesia is removed.

What each denial does at v4.3.6 [S]:

| Feature | Behaviour when denied | Source |
| --- | --- | --- |
| transient non-exclusive queue | `{protocol_error, internal_error, Warning}`, a **connection-level** error. Opt-in requires `deprecated_features.permit.transient_nonexcl_queues=true` on **all** nodes. | `rabbit_amqqueue.erl L114-119, L225-245, L2119-2129` |
| `x-queue-master-locator` argument | `internal_error` | `rabbit_classic_queue.erl L109-146` |
| `queue-master-locator` policy key | Rejected: "use of deprecated queue-master-locator argument is not permitted" | `rabbit_classic_queue.erl L109-146` |
| `basic.qos global=true` | **Silently downgraded** to per-consumer prefetch, not rejected | `rabbit_channel.erl L1454-1470` |
| AMQP address v1 | Link refused: "RabbitMQ AMQP address version 1 is unsupported" | `rabbit_amqp_session.erl L21-33` |
| non-described `rabbitmq:stream-*` filter values | Silently dropped | `rabbit_amqp_session.erl L3350-3357` |

**Passive declares need configure. REFUTED for current 4.3.**

| Versions | Check on passive `queue.declare` / `exchange.declare` |
| --- | --- |
| 3.13.7, 4.0.9, 4.1.8, 4.2.0–4.2.5 | none |
| 4.2.6, **4.3.0** | `check_configure_permitted` |
| 4.2.7+, **4.3.1+**, v4.4.x, main | `check_any_resource_access_permitted` (read, then write, then configure; `rabbit_channel.erl@v4.3.6 L2586, L875-895, L2690-2699`) |

RN 4.3.1 L35-38 and `web:docs/access-control.md`: "Starting with RabbitMQ `4.3.1`, passive declarations require the user to have **at least one permission**".

**Consumer timeouts. CONFIRMED.**
- RN 4.3.0 L63-69.
- `web:docs/consumers.md`: "Starting with RabbitMQ 4.3, delivery acknowledgement timeouts are only supported by quorum queues".
- Quorum queues also gain `consumer_disconnected_timeout`.

### T5. Streams and the JS AMQP 1.0 client: NUANCED

**Broker side. CONFIRMED.**
- The OSS UI defines `QUEUE_TYPE["stream"].actions = {get_message:false, purge:false}` (`rs@v4.3.6:deps/rabbitmq_management/priv/www/js/global.js L1019-1029`).
- `basic.get` fails with `{protocol_error, not_implemented, "basic.get not supported by stream queues"}` (`rabbit_stream_queue.erl L606-609`). In AMQP 0-9-1 that is a **connection** error.
- Tanzu RabbitMQ 4.3 adds a commercial Stream Browser that browses by offset, timestamp or head/tail, shows chunks and segments, and allows selective download (https://www.rabbitmq.com/blog/2026/04/23/rabbitmq-4.3-release).
- Stage-2 AMQP filter expressions work only over AMQP 1.0: property filters from 4.1.0 (RN 4.1.0 L20-25), SQL from 4.2.0 (RN 4.2.0 L42-54), and the two are mutually exclusive.
- Bloom filters (3.13+) work over AMQP 1.0, 0-9-1, the stream protocol and STOMP (`web:docs/stream-filtering.md L946`).

**Reading a stream over 0-9-1. NUANCED** (`rabbit_stream_queue.erl L332-410`):
- A per-consumer prefetch above 0 is **mandatory**; prefetch 0 gives PRECONDITION_FAILED.
- Manual ack is **mandatory**; `no_ack` gives `not_implemented`.
- Global QoS gives `not_implemented`.
- `x-stream-offset` is optional (`undefined -> next`) but needed to read history.
- The channel must be on a node with a local replica, otherwise: "stream … does not have a running replica on the local node".

**JS AMQP 1.0 client: coders51 `rabbitmq-amqp-js-client` 1.0.0** (npm, 2026-06-25, ISC; linked from `web:client-libraries/amqp-client-libraries.md`; source at https://github.com/coders51/rabbitmq-amqp-js-client, tag v1.0.0, identical to main):

| Capability | Status in v1.0.0 | Where |
| --- | --- | --- |
| Stream offset API (first/last/next/numeric/timestamp) | API exists, but **first/last/next are sent as non-described values**. They work on 4.0–4.2 and are **ignored by default on 4.3+**, so the consumer starts at `next`. `numeric` and `timestamp` are BigInt; rhea's `types.wrap` has no bigint branch and encodes them as an **empty map**, so they are ignored on every version. `Offset.offset(0n)` sends `"numeric"`. | `src/consumer.ts` `createConsumerFilterFrom`; `src/utils.ts` `Offset.toValue`; https://raw.githubusercontent.com/amqp/rhea/main/lib/types.js L477-517 |
| Bloom `filterValues`, `matchUnfiltered` | Same legacy encoding, so ignored on 4.3+ by default | `src/consumer.ts` |
| Property and application-properties filters | OK (described 0x173 and 0x174) | `src/consumer.ts` |
| SQL filter | OK (described 0x120, key `sql-filter`) | `src/consumer.ts` |
| Outcomes | accept; `discard()` sends rejected; `discard(ann)` sends modified(delivery-failed true, undeliverable-here true); `requeue()` sends **released**; `requeue(ann)` sends **modified**(delivery-failed false, undeliverable-here false). Modified(delivery-failed true, undeliverable-here false) is not offered. | `src/delivery_context.ts` |
| Management | Declare and delete queues and exchanges, `getQueueInfo` (leader, replicas, message and consumer counts), bind and unbind. Unbind uses `args=` empty, so bindings with arguments cannot be removed. **No purge.** `deliveryLimit` maps to `x-max-delivery-limit`, which is **not** a RabbitMQ argument (the broker uses `x-delivery-limit`, see `rabbit_quorum_queue.erl L615-635`). The client still offers `lazy` mode and CQv1 arguments, which 4.3 rejects. | `src/management.ts`, `src/queue.ts` |
| OAuth token refresh | Yes: `connection.refreshToken()` sends PUT `/auth/tokens`, and reconnects reuse the new token | `src/connection.ts`, `src/management.ts` |
| SASL EXTERNAL | Not exposed. rhea supports `enable_sasl_external`, but `EnvironmentParams` and `TlsParams` do not include it. | `src/environment.ts`, rhea `lib/connection.js L378-413` |
| Vhost selection | **No.** No `hostname: vhost:<name>` option exists, so the client always uses the default vhost. Issue #95, "Add virtual host support", is open. | `src/rhea_wrapper.ts` |
| Addresses | Management paths are percent-encoded, but **publisher and consumer `/queues/{name}` and `/exchanges/{name}/{key}` addresses are not** | `src/message.ts L50-62` |
| Supply chain | `"rhea": "github:amqp/rhea"`, an unpinned git dependency. CI broker is `rabbitmq:4.2-management`. | `package.json`, `docker-compose.yml` |

Broker parse logic behind the encoding problem:
- `rs@v4.3.6:deps/rabbit/src/rabbit_amqp_session.erl L3303-3357`: only described `rabbitmq:stream-offset-spec`, `-filter` and `-match-unfiltered` values are accepted. The legacy clause is used only if `amqp_filter_set_bug` is permitted, which is denied by default in 4.3 and was permitted in 4.1.8 and 4.2.9.
- `@v4.0.9 L3005-3069`: 4.0 accepted plain values via `keyfind_unpack_described`.

### T6. Metrics: NUANCED

See the table in section 4. Key corrections:
- The policy-field fix landed in **4.2.5** as well as 4.3.0.
- `?enable_queue_totals=true` works **per request**, not only through configuration.
- With stats disabled, `/api/nodes` loses all resource fields.
- The queue-name filter on `/metrics/detailed` was added in 4.3.0 (#15689).

### T7. Operations surface: NUANCED (mostly confirmed)

See section 5. Corrections:
- `delete_super_stream` is also available over the **stream protocol** (`rabbit_stream_reader.erl@v4.3.6 L2932, L3007`).
- HTTP can create super streams from 4.1.
- `DELETE /api/reset` resets **management statistics**, not the node.

### T8. Purge permissions and audit: CONFIRMED

- `rabbit_channel.erl@v4.3.6 L2625-2628` checks only read for `queue.purge`; the same is true at v3.13.7 and v4.0.9.
- The AMQP 1.0 management purge checks read (`rabbit_amqp_management.erl L255-266`).
- The HTTP purge needs a management-tagged user with vhost access, then runs `queue.purge` as that user (`rabbit_mgmt_wm_queue_purge.erl L25-33`).
- No `rabbit_event` is emitted for purges: the classic path (`rabbit_amqqueue_process.erl L1472-1476`) and the quorum path (`rabbit_quorum_queue.erl L1410-1412`) emit none. The list of internal events in `web:docs/logging.md` has no purge entry.
- HTTP access logging is off by default. `management.http_log_dir` enables it per node after a restart (`web:docs/management/index.md L1121-1131`).

### T9. Browser access: NUANCED

**CORS.**
- `rs@v4.3.6:deps/rabbitmq_management/src/rabbit_mgmt_cors.erl` sends CORS headers only for an `Origin` listed in `management.cors.allow_origins` (or `.N`). The default list is empty.
- An exact-match origin is echoed back with `Access-Control-Allow-Credentials: true`. A configured `*` returns ACAO `*` with no credentials.
- The broker does not refuse cross-origin requests; the browser enforces the policy.
- `management.cors.max_age` defaults to 1800 s.
- Quirk found in source: `handle_options` builds `ReqData2` from `ReqData0`, so `access-control-max-age` is dropped whenever the preflight carries `Access-Control-Request-Headers`.

**4.3.2 and 4.2.8 hardening** (RN 4.3.2 L111-121, #16544):
- `Access-Control-Request-Headers` is now validated.
- An `Origin: *` header is rejected.
- 500 responses no longer include internal error details.
- Definitions multipart uploads are capped in size.

**AMQP 1.0 over WebSocket** is Tanzu-only:
- `web:docs/amqp.md L300` and `versioned_docs/version-4.3/amqp.md` say so.
- There is no `rabbitmq_web_amqp` in the OSS `deps` at v4.3.6, v4.4.x or main.
- The only OSS browser-native protocols are Web-STOMP and Web-MQTT. They gained Origin validation in 4.3.0 (`web_stomp.allow_origins`, `web_mqtt.allow_origins`), and 4.4 adds `strict_origin_validation`.

### T10. Versions: NUANCED. See the matrix in section 6.

### X1–X5. New findings (details in the verdicts)

| ID | Finding |
| --- | --- |
| X1 | Static connection info is visible with stats disabled from **4.2.6** and 4.3.0. |
| X2 | Open-source 4.2 stopped at 4.2.9; 4.2.10 and 4.2.11 are commercial-only. |
| X3 | The tracing plugin's node-targeted HTTP routes can enable tracing on any node. |
| X4 | A partial `PUT /api/vhosts/{v}` overwrites the vhost's metadata. |
| X5 | The JS AMQP 1.0 client cannot reliably start a stream read at a chosen offset. |

---

## 2. TAP-MODES table

| Mode | Mechanism | Blind spots | Side effects | Preflight checks | Permissions needed | Min version |
| --- | --- | --- | --- | --- | --- | --- |
| **B. Exchange-to-exchange tap** (rabtap) | Auto-delete fanout tap exchange. `exchange.bind(dest=tapX, src=X, key, args)`. Exclusive auto-delete queue bound to tapX. | Default exchange (cannot be a source). x-local-random (binding rejected). With rabtap's empty arguments, headers exchanges cannot be filtered. Otherwise sees everything routed through X. | Broad keys (`#`, `""`, headers without arguments) route every message, which silences X's AE and mandatory returns and hides unroutable metrics. Diverts on CHX (integer key), modulus-hash and x-random. Leftover tap exchange if the client dies mid-setup, which changes routing permanently. **4.3.0–4.3.5:** deleting the tap exchange leaves a stale CHX bucket, causing **silent loss**, and no `binding.deleted` event (#17255). | As A. Refuse E2E on hash and random types, and refuse any CHX E2E below 4.3.6. Periodically sweep `__tap-exchange-for-*` leftovers. | configure on the tap exchange and queue. write on the tap exchange (E2E destination) and queue. read on X and on tapX. read on the queue. | All |
| **C. Firehose** (`amq.rabbitmq.trace`) | Enable **per node per vhost** with `rabbitmqctl trace_on -p V -n N`, or `PUT /api/traces/node/{node}/{vhost}/{name}` (tracing plugin). `PUT /api/vhosts/{v} {"tracing":true}` affects only the serving node and overwrites metadata. Bind an exclusive queue with `publish.#` and/or `deliver.#`. | Untraced nodes (each trace comes from the client connection's node). Stream protocol. Dead-lettering. Local shovels. Everything after a node restart. Other vhosts. Trace publishes are at-most-once. | **Sees default-exchange and unroutable publishes** (`routed_queues=[]`), which no other mode does. Throughput drop. Exposes every message body in the vhost (PII). Trace-queue backlog causes alarms. The trace exchange is shared with other tracers. | Tracing plugin present (`/api/extensions`). Administrator rights. Node list. Memory headroom. PII consent. Lease with automatic off. Re-check after restarts and on every node. | HTTP: **administrator** tag (`is_authorized_admin`) for the vhost PUT and for `/api/traces`. CLI: Erlang cookie. Consumer: configure and write on its queue, read on `amq.rabbitmq.trace`, read on its queue. | All. Node-targeted trace routes exist 3.13.7–main. Native AMQP 1.0 session tracing from 4.0. |
| **D. Trace files** (rabbitmq_tracing) | `PUT /api/traces/node/{node}/{vhost}/{name}` with `pattern`, `format` (json or text) and `max_payload_bytes`. Download with `GET /api/trace-files/node/{node}/{name}`. | As C | Files fill the node's disk. The plugin consumes into an unbounded queue with no-ack. Trace definitions are in ETS and lost on restart. | As C, plus disk headroom | administrator | All |
| **E. STOMP / Web-STOMP subscribe** to `/exchange/X/key` | The plugin creates an exclusive auto-delete queue bound to X | As A/B | As A/B | Plugin enabled; Origin rules on 4.3+ | As A | All (Web-STOMP is the only OSS browser-native tap) |
| **F. Capture to a stream** (shared, replayable team capture) | Bind a retention-limited stream instead of a temporary queue; read it with the stream protocol | As A/B | As A/B. Leaves a durable artefact that must be cleaned up. Cannot be an x-local-random destination. | As A, plus `x-max-age` and `x-max-length-bytes` limits | configure, write and read on the stream | All |

**Recommended tap-queue recipe (A, B and C):**

```
queue.declare(
  name = "<allowed-prefix>.tap.<uuid>",
  durable = false, exclusive = true, auto_delete = true,
  arguments = {
    "x-queue-type":  "classic",
    "x-max-length":  10000,
    "x-overflow":    "drop-head",
    "x-message-ttl": 60000
  })
```
- Before declaring, simulate which user and operator policies would match that name.
- Then `basic.qos(prefetch=1000, global=false)`.
- Copy the bindings, including their arguments.
- Consume, then ack in batches of N, or use no-ack.
- Close the channel on stop, which deletes the exclusive queue.

---

## 3. STREAM-BROWSING capability table

| Path / client | Reads history? | Offset specs | Server-side filtering | Broker versions | Gotchas |
| --- | --- | --- | --- | --- | --- |
| OSS management UI / HTTP API | **No.** The UI has `get_message:false`. `POST /api/queues/{v}/{s}/get` uses `basic.get`, which fails with `not_implemented`. | — | — | all | Metadata only: queue details, `GET /api/stream/{v}/{s}/tracking`, and the oldest-message timestamp on the stream page (4.3.2+). |
| Tanzu Stream Browser (commercial) | Yes | Absolute offset, timestamp, head/tail, segment and chunk views | Search | Tanzu 4.3+ | Closed source (https://www.rabbitmq.com/blog/2026/04/23/rabbitmq-4.3-release) |
| AMQP 0-9-1 (`amqplib` 2.2.0, 2026-09-28) | Yes, via `basic.consume` | `x-stream-offset`: `first`, `last`, `next`, a long offset, a timestamp in **seconds** (amqplib `{'!':'timestamp', value}`), or an interval such as `"1h"` (`web:docs/streams.md L184-202`) | Bloom with `x-stream-filter` and `x-stream-match-unfiltered` (3.13+). No Stage 2. | 3.13+ | Per-consumer prefetch above 0 required. Manual ack required (no-ack closes the connection with 540). No global QoS. Must connect to a **node that hosts a replica**. Default offset is `next`. Deliveries carry an `x-stream-offset` header. **Never use `basic.get`**, which closes the connection. |
| AMQP 1.0 with a spec-correct encoder (own rhea layer) | Yes | Filter-set **described** `rabbitmq:stream-offset-spec`: AMQP timestamp (ms), utf8/symbol `first`, `last`, `next` or an interval, or a ulong offset | `rabbitmq:stream-filter` and `-match-unfiltered` (4.0+). `amqp:properties-filter` and `amqp:application-properties-filter` (**4.1+**). `amqp:sql-filter` (**4.2+**); property and SQL filters are mutually exclusive. | 4.0+ (AMQP 1.0 is core). On 3.13 the plugin has no v2 addresses or management node. | Same replica-node rule. Credit-based flow control. On 4.3+, legacy non-described `rabbitmq:stream-*` values are dropped silently unless `deprecated_features.permit.amqp_filter_set_bug = true`. |
| AMQP 1.0 via `rabbitmq-amqp-js-client` 1.0.0 | **Partly** | first/last/next: work on 4.0–4.2, **ignored on 4.3+**. numeric/timestamp: **broken everywhere** (BigInt). | Property and SQL filters work. Bloom has the same legacy problem. | CI tests 4.2 only | No vhost (#95). No purge. No SASL EXTERNAL. Addresses not encoded. rhea pulled from git HEAD. |
| Stream protocol (`rabbitmq-stream-js-client` 1.1.0, 2026-07-23, ISC) | Yes | first, last, next, numeric, timestamp (correct encoding in `src/requests/subscribe_request.ts`) | Bloom (3.13+, broker capability checked). No Stage 2. | Streams 3.9+; filtering 3.13+ | Needs the `rabbitmq_stream` plugin (not enabled by default), port 5552/5551 reachable, and `advertised_host` set correctly. The client has `addressResolver` for load balancers. Supports single active consumer, super streams (create and delete), stored offsets and stream stats. |
| STOMP / Web-STOMP | Yes | `x-stream-offset`: `first`, `last`, `next`, `offset=N`, `timestamp=secs` | Bloom (`x-stream-filter`) | 3.13+ | Needs `ack:client` and `prefetch-count` (`web:docs/stomp.md L591-629`). The only OSS browser-native read path. |

---

## 4. METRICS-AVAILABILITY table (by version and stats setting)

"Stats OFF" means any one of:
- `management.disable_stats = true`
- `management_agent.disable_metrics_collector = true`
- `deprecated_features.permit.management_metrics_collection = false`
- per request: `?disable_stats=true`

| Data | Stats ON (all) | OFF: 3.13 / 4.0 / 4.1 / 4.2.0–4.2.4 | OFF: 4.2.5 | OFF: 4.2.6–4.2.9 (OSS) | OFF: 4.3.0–4.3.5 | OFF: 4.3.6+ | Alternative |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Message rates (`message_stats`), charts | yes | no | no | no | no | no | Prometheus |
| Queue message counts | yes | only with `enable_queue_totals`: config or **`?enable_queue_totals=true`** (list endpoints from 3.13.0, single-queue endpoint from 3.13.1) | same | same | same | same | Prometheus `queue_coarse_metrics`. AMQP 1.0 management `GET /queues/{q}` (4.0+, no permission needed). Passive declare (ready count only). |
| `policy`, `operator_policy`, `effective_policy_definition`, `delivery_limit` on queues | yes | **missing** (#15182) | yes (#15651) | yes | yes | yes | `GET /api/policies` and evaluate locally |
| Connection static info (peer address, TLS, auth mechanism) | yes | missing | missing | yes (#16009) | yes | yes | — |
| `/api/channels`, `/api/channels/{ch}` | yes | **400** "Stats in management UI are disabled on this node" | 400 | 400 | 400 | basic info (#17198) | — |
| `/api/nodes` resource fields (memory, file descriptors, sockets, disk, alarms) | yes | only `name`, `type`, `running`, `being_drained` (seen at v4.3.6; earlier versions assumed the same, not verified) | ← | ← | ← | ← | Prometheus; `/api/health/checks/alarms` and `local-alarms` |
| `/api/overview` totals and rates | yes | only `object_totals` (queues, exchanges, connections) plus the flags `disable_stats` and `enable_queue_totals` | ← | ← | ← | ← | Prometheus |
| Deprecated feature `management_metrics_collection` | `permitted_by_default` on v4.2.9, v4.3.6, **v4.4.x and main** (`rabbit_mgmt_agent_config.erl L13-17`) |  |  |  |  |  | Plan for its eventual removal |

The "←" cells mean the same as the cell to their left.

**Prometheus** (per node; independent of the management stats setting):
- `/metrics` is aggregated by default; `prometheus.return_per_object_metrics=true` makes it per object.
- `/metrics/per-object` is available.
- `/metrics/detailed?family=…&vhost=…`, with both parameters repeatable, exists in all supported series (present since 3.9.29).
- **`queue=<regex>`** on `/metrics/detailed` was added in **4.3.0** (#15689). Only one value is allowed; an invalid regex returns 400. It is not in any 4.2.x release notes.
- `/metrics/memory-breakdown` exists from 4.0.
- Detailed metrics use the prefix `rabbitmq_detailed_`.
- Source: `web:docs/prometheus/index.md L541-596`.

**Capability probe:** `GET /api/overview` returns `rabbitmq_version`, `disable_stats`, `enable_queue_totals`, `exchange_types` and `default_queue_type` (`rabbit_mgmt_wm_overview.erl L35-55`).

---

## 5. Operations surface at 4.3.6

### 5.1 CLI-only (no HTTP route)

Source: `rabbit_mgmt_dispatcher.erl@v4.3.6 L107-229` plus all plugin dispatchers.

| Tool | Commands with no HTTP route |
| --- | --- |
| `rabbitmq-queues` | **peek** (quorum queues only, no side effects), grow_to_count, transfer_leadership, force_checkpoint, reclaim_quorum_memory, check_if_new_quorum_queue_replicas_have_finished_initial_sync |
| `rabbitmq-streams` | **add_replica, delete_replica**, grow, shrink, **stream_status**, **restart_stream**, transfer_leadership, coordinator_status |
| Stream plugin CLI | **list_stream_consumer_groups, list_stream_group_consumers, activate_stream_consumer** (single-active-consumer groups), reset_offset |
| `rabbitmq-upgrade` | **drain, revive**, await_online_quorum_plus_one, post_upgrade |
| `rabbitmq-plugins` | **enable, disable**, set |
| `rabbitmqctl` | **join_cluster, forget_cluster_node, reset / force_reset**, stop_app / start_app, update_cluster_nodes, rename_cluster_node, force_boot, **set_log_level**, **set_vm_memory_high_watermark, set_disk_free_limit**, close_all_connections, list_unresponsive_queues, set_channel_interceptor_priorities (4.3.6), eval |
| `rabbitmq-diagnostics` | **log_tail / log_tail_stream**, consume_event_stream, observer, runtime_thread_stats, and others |

Corrections to the claimed list:
- `delete_super_stream`, `add_super_stream` and stream statistics are available over the **stream protocol** (`rabbit_stream_reader.erl L2932, L3007`). A super stream can also be removed through HTTP by deleting its partition queues and its exchange.
- Super-stream creation has an HTTP route from 4.1 (`PUT /api/stream/super-streams/{v}/{name}`).
- `DELETE /api/reset[/{node}]` resets **management statistics** only (`rabbit_mgmt_storage:reset_all`), not the node.

### 5.2 Operations available over HTTP (4.3.x)

**Quorum queues**

| Route | Access | Min version |
| --- | --- | --- |
| `POST /api/queues/quorum/{v}/{q}/replicas/add` | admin | ≤3.13.7 |
| `DELETE /api/queues/quorum/{v}/{q}/replicas/delete` | admin | ≤3.13.7 |
| `POST /api/queues/quorum/replicas/on/{node}/grow` | admin | ≤3.13.7 |
| `DELETE /api/queues/quorum/replicas/on/{node}/shrink` | admin | ≤3.13.7 |
| `GET /api/queues/quorum/{v}/{q}/status` | vhost access | ≤3.13.7 |
| `POST /api/rebalance/queues` | admin | ≤3.13.7 |

The four replica operations return **405** when `management.restrictions.quorum_queue_replica_operations.disabled = true`.

**Health checks** (each health route is listed under the first version where it appears)

| Route | Min version |
| --- | --- |
| `alarms`, `local-alarms`, `certificate-expiration/{within}/{unit}`, `port-listener/{port}`, `protocol-listener/{protocols}`, `virtual-hosts`, `node-is-quorum-critical` | ≤3.13.7 |
| `metadata-store/initialized`, `metadata-store/initialized/with-data` | 4.0 |
| `is-in-service`, `below-node-connection-limit`, `ready-to-serve-clients`, `quorum-queues-without-elected-leaders/{all-vhosts \| vhost/{v}}[/pattern/{p}]` | 4.1 |
| `reached-target-cluster-size` | 4.3 |
| legacy `/api/healthchecks/node[/{node}]`, `/api/aliveness-test/{v}` | ≤3.13.7 |

All health-check routes except the legacy ones sit under `/api/health/checks/`.

**Cluster and feature management**

| Route | Access | Notes |
| --- | --- | --- |
| `GET /api/feature-flags`, `PUT /api/feature-flags/{name}/enable` | admin for enable |  |
| `GET /api/deprecated-features`, `GET /api/deprecated-features/used` |  | Read-only; permitting a deprecated feature needs `rabbitmq.conf` on **all** nodes |
| `GET` / `POST /api/definitions[/{v}]` | admin | Upload size capped from 4.3.2 and 4.2.8 |
| `PUT` / `DELETE /api/vhosts/{v}` | admin |  |
| `POST` / `DELETE /api/vhosts/{v}/deletion/protection` |  | 4.0+ |
| `POST /api/vhosts/{v}/start/{node}` | admin | Restarts the vhost on a node |
| `PUT /api/cluster-name` |  |  |
| Users and `POST /api/users/bulk-delete`, permissions and topic permissions, vhost and user limits, policies and operator policies, parameters and global parameters |  | Operator policies can be locked with `management.restrictions.operator_policy_changes.disabled` |
| `GET /api/config/effective` | admin |  |
| `GET` / `DELETE /api/auth/attempts/{node}[/source]` |  |  |
| `GET /api/users/{user}/queues` |  | 4.3 |

**Clients and messages**

| Route | Notes |
| --- | --- |
| `DELETE /api/connections/{name}` |  |
| `DELETE /api/connections/username/{user}` |  |
| `DELETE /api/queues/{v}/{q}/contents` | Purge; needs read |
| `POST /api/queues/{v}/{q}/get` | Destructive get, implemented with `basic.get` |
| `POST /api/exchanges/{v}/{x}/publish` |  |
| `POST /api/queues/{v}/{q}/actions` | Exists, but rejects every action in 4.x |

**Plugin routes**

| Plugin | Routes |
| --- | --- |
| Shovel | `GET /api/shovels[/{v}]`, `GET` / `DELETE /api/shovels/vhost/{v}/{name}`, `/api/shovels/vhost/{v}/{name}/restart` (deletes need the policymaker tag from 4.3.0) |
| Federation | `GET /api/federation-links[/{v}]`, `.../state/down`, `/api/federation-links/vhost/{v}/{id}/{node}/restart` (policymaker from 4.3.0) |
| Stream management | `GET /api/stream/connections`, `/consumers`, `/publishers`; `GET` / `DELETE /api/stream/connections/{v}/{name}`; `GET /api/stream/{v}/{q}/tracking`; `PUT /api/stream/super-streams/{v}/{name}` (4.1+) |
| Tracing | `/api/traces[/node/{node}][/{v}[/{name}]]`, `/api/trace-files[/node/{node}][/{name}]` |
| Top | `/api/top/{node}`, `/api/top/ets/{node}`, `/api/process/{pid}` |

**AMQP 1.0 management node (4.0+)** (`rabbit_amqp_management.erl@v4.3.6 L84-410`):
- queues: GET, PUT, DELETE
- purge: `DELETE /queues/{q}/messages`
- exchanges: PUT, DELETE
- bindings: POST, GET, DELETE
- `PUT /auth/tokens`

There is nothing for users, vhosts, policies or cluster operations.

---

## 6. VERSION-SUPPORT matrix (as of 2026-10-16)

| Series | Latest OSS GA (GitHub publish date) | Latest on release-information | Community support ends | Commercial support ends (indicative) | Status today | Metadata store | Semantics markers relevant to the tool | Suggested tool tier |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 3.13 | 3.13.7 (2024-08-26) | 3.13.7 | 30 Sept 2024 | 31 Dec 2029 | Commercial only | Mnesia (Khepri experimental; no upgrade path to 4.0 while Khepri is enabled) | Client `x-death` **interpreted**. AMQP 1.0 only via plugin (no v2 addresses, no management node). No x-local-random. Passive declares unchecked. Stats-off removes policy fields and returns 400 on channels. Bloom filters available. | Tier 2 |
| 4.0 | 4.0.9 (2025-04-14) | 4.0.9 | 30 Apr 2025 | **30 Sept 2026 (ended)** | Fully unsupported | Mnesia default; Khepri supported (`khepri_db`, opt-in) | AMQP 1.0 in core, address v1 permitted, plain filter values accepted. Client `x-death` no longer interpreted. x-local-random. | Tier 3 (best effort) |
| 4.1 | 4.1.8 (2026-01-22) | 4.1.8 | 31 Jan 2026 | 30 Apr 2027 | Commercial only | as 4.0 | Property filters. `amqp_filter_set_bug` permitted. Super-stream HTTP PUT. New health checks. From 4.1.4, vhost update injects the default queue type. | Tier 2 |
| 4.2 | **4.2.9** (2026-07-20) | **4.2.11** (16 Sept 2026; 4.2.10 on 17 Aug 2026). Not on GitHub (404): commercial-only | 31 Jul 2026 | 30 Jun 2030 | Commercial only; OSS frozen at 4.2.9 | **Khepri default for new deployments** | SQL filters. Queue types can be disabled. Local shovels. 4.2.5 policy-fields fix. 4.2.6 static connection info, passive declares need configure. 4.2.7 passive declares need any permission. 4.2.8 CORS hardening. Channels still return 400 with stats off at 4.2.9. | Tier 1 |
| 4.3 | **4.3.6** (2026-09-14; page says 16 Sept) | 4.3.6 | 31 Jan 2027 | 30 Apr 2028 | **Community supported (current)** | **Khepri only** (upgrade only from 4.2.x) | Deprecated features denied. Quorum queue machine v8 (delivery-count limit, delayed retry, consumer timeout on quorum queues only). Modulus-hash in core. `/metrics/detailed?queue=`. Erlang ≥ 27. Known bugs: 4.3.0 topic `""`; 4.3.0–4.3.5 CHX destination deletion; channels 400 until 4.3.6. 4.3.7 in alpha. | Tier 1 |
| 4.4 | none (alpha builds `4.4.0-alpha.<sha>`, 2026-10-13..15, from `rabbitmq/server-packages`) | — | — | — | Development (`v4.4.x` branch) | Khepri | Draft notes: quorum-queue delayed and deferred messages, stream start offset other than 0, `POST /api/auth/hash_password` replaces the GET, `GET /api/init`, Unix-socket listeners, native STOMP | Nightly CI |
| 5.0 | none (`5.0.0-alpha.<sha>`, 2026-10-15/16, from `main`) | — | — | — | Development | Khepri | `rabbitmq_amqp1_0` no-op plugin removed | Nightly CI |

Sources:
- https://www.rabbitmq.com/release-information
- https://api.github.com/repos/rabbitmq/rabbitmq-server/releases
- https://api.github.com/repos/rabbitmq/server-packages/releases
- Khepri status: RN 4.0.1 L12-13, RN 4.2.0 L106-133, RN 4.3.0 L81-91
- `rs@v4.4.x:release-notes/4.4.0.md`, `rs@main:release-notes/5.0.0.md`

### 6.1 Version-specific hazards to encode in the tool

| Affected | Hazard | Fixed in | Source |
| --- | --- | --- | --- |
| 3.13, 4.0, 4.1, 4.2.0–4.2.4 | Stats-off removes `policy`, `operator_policy`, `effective_policy_definition` and `delivery_limit` | 4.2.5 / 4.3.0 | #15182, #15651 |
| up to 4.3.5 (OSS 4.2.9 too) | `/api/channels` returns 400 with stats off, or whenever `?disable_stats=true` is sent | 4.3.6 | #17198 |
| 4.2.6, 4.3.0 | Passive declares need configure | 4.2.7 / 4.3.1 (any permission) | #16085, #16272 |
| 4.3.0 (and later until the flag is enabled) | A topic-exchange binding with `""` receives `""` publishes from **any** topic exchange | 4.3.1 + flag `topic_binding_projection_v5` | RN 4.3.1, #16425 |
| 4.3.0–4.3.5 | Deleting an E2E destination exchange leaves a stale CHX bucket (**silent loss**), with no `binding.deleted` event | 4.3.6 | #17255, #17257 |
| 4.3.0+ | Non-described `rabbitmq:stream-*` filters ignored (affects the JS AMQP client) | config: `deprecated_features.permit.amqp_filter_set_bug = true` | `rabbit_amqp_session.erl` |
| 4.1.4+ | `PUT /api/vhosts` without `default_queue_type` appears to reset it (source-read); every version resets description and tags | — | `vhost.erl` |
| up to 4.2.7, up to 4.3.1 | CORS accepts unvalidated request headers and `Origin: *` | 4.2.8 / 4.3.2 | #16544 |

---

## 7. Remaining uncertainties

All of these need lab confirmation:
- whether the JS client starts at "next" on 4.3.6 and fails to encode BigInt offsets
- whether a vhost PUT resets the default queue type
- whether *auto-delete* of a tap exchange, as opposed to an explicit DELETE, triggers the 4.3.0–4.3.5 CHX bucket bug
- how much flow-control back-pressure a slow tap queue puts on publishers.

None of these was tested; all are inferred from reading source.

## Design implications

- Tap engine: plan the tap before creating it. Build a TapPlan per target listing the source exchanges, their types and their binding arguments.
- By default, refuse any source of type x-consistent-hash, x-modulus-hash, x-random, x-local-random or an unknown plugin type, unless the user explicitly accepts that messages will be diverted.
- Never use an exchange-to-exchange tap on a consistent-hash exchange below 4.3.6, because removing it there causes silent message loss (#17255).
- Prefer shadow-queue (copied-binding) taps over exchange-to-exchange taps.
- Declare tap queues with an explicit name inside the user's configure-permission regex. Do not use server-named amq.gen-* queues; the 'amq.' prefix is reserved anyway.
- Arguments: x-queue-type=classic, exclusive, auto-delete, non-durable, x-max-length (for example 10k), x-overflow=drop-head, x-message-ttl.
- First simulate which user and operator policies would match that name. Warn about inherited reject-publish (publishers get nacks), a dead-letter-exchange policy (tap overflow would land in production DLQs) or max-length.
- Check GET /api/health/checks/alarms before starting.
- Copy bindings exactly, including arguments (headers x-match and header pairs). Keep them in sync while the tap runs, via polling or the event exchange.
- Badge two things in the UI: the default-exchange blind spot, and AE/mandatory/unroutable-metric masking whenever a tap matches more than the existing bindings do.
- Offer Firehose mode as the only way to see direct-to-queue and unroutable publishes.
- Firehose controller:
- When rabbitmq_tracing is present, enable tracing per node via PUT /api/traces/node/{node}/{vhost}/{name}. Otherwise generate one rabbitmqctl trace_on -n <node> command per node.
- Never toggle tracing via PUT /api/vhosts/{v}: it affects only the serving node and overwrites description and tags (and possibly the default queue type).
- Track state per node, because it is lost on restart. Re-verify after node restarts.
- Run tracing on a lease with automatic switch-off. In team mode require the admin role, an approval step and PII masking.
- If the tool writes vhost settings at all, always GET, merge and PUT back description, tags, default_queue_type and tracing together. Add an integration test that a non-default default queue type survives the round trip.
- DLQ data model:
- Parse x-death (0-9-1): count, reason, queue, time (seconds, first death), exchange, routing-keys, original-expiration. Entries are most recent first.
- Parse x-opt-deaths (AMQP 1.0): adds first-time and last-time in milliseconds, and ttl.
- Parse x-first-death-* and x-last-death-* into one normalized history.
- On 4.0+, mark a client-supplied x-death as untrusted: it is delivered verbatim until the next dead-lettering, then replaced. On 3.13 the broker still interprets it.
- On replay, stamp the tool's own headers (replay id, replay count, original death summary as JSON), because 4.x restarts the death history and cycle detection after a republish.
- Stream browser architecture:
- Primary path: the stream protocol via rabbitmq-stream-js-client 1.1.0, with addressResolver for load balancers. It covers offsets, Bloom filters, single active consumer and super streams.
- Use AMQP 1.0 only for Stage-2 property filters (4.1+) and SQL filters (4.2+), through an in-house spec-conformant rhea layer. Offset-spec must be a described value, with ulong for offsets and AMQP timestamp in milliseconds.
- Fallback over 0-9-1: per-consumer prefetch above 0, manual acks, and x-stream-offset, connected to a node that hosts a replica. Find replica nodes with GET /api/queues/{v}/{s} or the AMQP 1.0 GET /queues/{q}.
- Never send basic.get or HTTP /get to a stream; it closes the connection.
- Do not ship coders51 rabbitmq-amqp-js-client 1.0.0 unpatched for stream reads. Either fork it, or wrap rhea directly with a pinned commit. Fixes needed:
- described filter values
- BigInt offset encoding
- percent-encoded addresses
- vhost via the open frame's hostname 'vhost:<name>' (issue #95)
- purge
- SASL EXTERNAL
- the x-delivery-limit argument name
- removal of the lazy and CQv1 options
Submit the fixes upstream. Until they ship, advise users that deprecated_features.permit.amqp_filter_set_bug=true makes 4.3 accept the legacy filter encoding.
- Capability detection at connect time:
- Read /api/overview (rabbitmq_version, disable_stats, enable_queue_totals, exchange_types, default_queue_type), /api/extensions, /api/feature-flags, /api/deprecated-features/used and the node list.
- Gate every feature on the combination of version, feature flags and stats mode, using the known-bug table in the report as data.
- Example: hide the channels view, or show a degraded one, when stats are off on versions below 4.3.6. Expect missing policy fields with stats off below 4.2.5.
- Metrics strategy:
- List views: query with ?disable_stats=true&enable_queue_totals=true. This is cheap and works on 3.13+. Never send disable_stats to /api/channels below 4.3.6.
- Rates and node resources: take them from Prometheus scraped per node, for example /metrics/detailed?family=queue_coarse_metrics&vhost=…, adding queue=<regex> on 4.3+. With stats off, /api/nodes returns only name, type, running and being_drained.
- Treat management_metrics_collection as permitted today but deprecated (it is still permitted on the 4.4.x and main branches).
- Existence probes and least privilege:
- Prefer the HTTP GET or the AMQP 1.0 management GET /queues/{q}; the docs say it needs no permission.
- Use passive declares only knowing the per-version rules: no check up to 4.2.5, configure on 4.2.6 and 4.3.0, any permission on 4.2.7+ and 4.3.1+.
- Surface permission errors as missing-permission hints, not as broker errors.
- Rules for the engine's own 4.3 behaviour:
- Never declare transient non-exclusive queues; on 4.3 this causes a connection-level internal_error.
- Never rely on global QoS; on 4.3 it is silently ignored.
- Never emit queue-master-locator.
- Use AMQP address v2 with percent-encoding.
- Detect a disabled classic queue type (possible from 4.2) before offering taps.
- On 4.3+ enforce an engine-side hold timeout for any consumer holding unacked classic-queue messages, because the broker no longer times them out.
- Operations panel:
- Implement the HTTP-covered operations natively: quorum-queue replica add/delete/grow/shrink (handle 405 when operators have disabled them), rebalance, the health checks for each version, feature-flag enable, definitions export/import, vhost restart and deletion protection, connection close, shovel and federation restart, super-stream create (4.1+) and tracing.
- Present CLI-only actions (peek, drain/revive, plugins, stream replica operations, single-active-consumer groups, join/forget/reset, log level, watermarks, log tail) as copyable runbooks or through an optional, separately installed node agent.
- Label DELETE /api/reset as 'reset management statistics'.
- Audit and RBAC in the team server:
- Be the system of record for every purge, get, publish, tap and firehose action it performs. The broker emits no purge event and logs no HTTP requests by default.
- Apply stricter RBAC than the broker, because purge needs only read permission on the broker.
- Optionally ingest amq.rabbitmq.event so other actors' topology and user changes appear (they include user_who_performed_action). Recommend management.http_log_dir to operators.
- Web, npx and team modes: keep all broker I/O in the engine. CORS is opt-in and empty by default, and open-source brokers cannot speak AMQP to a browser (AMQP over WebSocket is Tanzu-only). Do not ask users to configure management.cors.* or to enable Web-STOMP.
- Test matrix: 3.13.7, 4.0.9, 4.1.8, 4.2.9 and 4.3.6 in CI, plus nightly 4.3.7-alpha, 4.4.0-alpha and 5.0.0-alpha builds from rabbitmq/server-packages. Treat 4.2.10 and 4.2.11 as commercial builds with unknown fixes. Treat 4.0 as end-of-life: still supported by the tool, but at best effort.
- Linter and upgrade-advisor rules taken from these findings:
- queue-master-locator in policies or arguments (breaks on 4.3)
- transient non-exclusive queues
- clients using global QoS
- AMQP address v1 clients or legacy filter encodings
- x-queue-mode or x-queue-version=1 arguments
- exchange-to-exchange bindings from consistent-hash exchanges on 4.3.0–4.3.5
- topic bindings with an empty key on 4.3.x without topic_binding_projection_v5
- permitted deprecated features in use (/api/deprecated-features/used)
- leftover __tap-exchange-for-* exchanges

## Open questions

- Lab test on 4.3.6 and 4.2.9: does rabbitmq-amqp-js-client 1.0.0 with Offset.first() attach at 'next' on 4.3 and at 'first' on 4.2? Do Offset.offset(n) and Offset.timestamp(d) encode as an empty map and get ignored everywhere?
- Lab test: does PUT /api/vhosts/{v} with only {tracing:true} reset a non-default default_queue_type (for example quorum) on 4.1.4+? It does reset description and tags.
- Does auto-delete of a rabtap-style tap exchange, as opposed to an explicit DELETE, hit the 4.3.0–4.3.5 path that leaves a stale consistent-hash bucket? Do the commercial 4.2.10 and 4.2.11 builds share any of the 4.3 regressions or fixes (#17198, #17257, #16544)?
- How much back-pressure does a slow or backed-up classic tap queue put on production publishers through internal flow control? What default max-length and prefetch give a negligible impact (needs a load test)?
- Does setting {rabbit, [{trace_vhosts, [<<"/">>]}]} in advanced.config enable the firehose at boot (persistent tracing)? Would that be considered supported?
- Which Prometheus per-queue metric families remain populated when management_agent.disable_metrics_collector=true? What exactly does /api/nodes return with stats disabled on 3.13, 4.0 and 4.1 (only v4.3.6 was read)?
- On managed brokers (Amazon MQ, CloudAMQP, Kubernetes operator), are rabbitmq_tracing, rabbitmq_stream (port 5552 and advertised host), rabbitmq_event_exchange and administrator-only HTTP routes available? Is the firehose permitted at all?
- Do local shovels (4.2+) carry the broker's deaths annotation, which would preserve x-death history and cycle detection when used for DLQ redrive? Republishing through a client resets them.
- What HTTP status and body does POST /api/queues/{v}/{stream}/get return on each version, given that basic.get on a stream closes the internal connection?
- Behind a load balancer, how often does an AMQP 0-9-1 or 1.0 stream consumer land on a node without a replica? Does the tool need per-node addressing, or should it require the stream protocol with addressResolver?
- Tap semantics for x-jms-topic (selector arguments) and the Tanzu JMS and delayed queue types were not verified.

## Sources

- https://api.github.com/repos/rabbitmq/rabbitmq-server/tags?per_page=100
- https://api.github.com/repos/rabbitmq/rabbitmq-server/releases?per_page=100
- https://api.github.com/repos/rabbitmq/rabbitmq-server/branches?per_page=100
- https://github.com/rabbitmq/rabbitmq-server/releases/tag/v4.2.11
- https://api.github.com/repos/rabbitmq/server-packages/releases
- https://github.com/rabbitmq/server-packages/releases
- https://www.rabbitmq.com/release-information
- https://www.rabbitmq.com/release-information/deprecated-features-list
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/release-information/deprecated-features-list.md
- https://www.rabbitmq.com/blog/2026/04/23/rabbitmq-4.3-release
- https://raw.githubusercontent.com/jandelgado/rabtap/master/README.md
- https://raw.githubusercontent.com/jandelgado/rabtap/master/pkg/tap.go
- https://api.github.com/repos/jandelgado/rabtap/releases
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_channel.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.0/deps/rabbit/src/rabbit_channel.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.1/deps/rabbit/src/rabbit_channel.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.6/deps/rabbit/src/rabbit_channel.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.7/deps/rabbit/src/rabbit_channel.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.9/deps/rabbit/src/rabbit_channel.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v3.13.7/deps/rabbit/src/rabbit_channel.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.0.9/deps/rabbit/src/rabbit_channel.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.1.8/deps/rabbit/src/rabbit_channel.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_exchange.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_exchange_type_local_random.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_exchange_type_modulus_hash.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_exchange_type_headers.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_consistent_hash_exchange/src/rabbit_exchange_type_consistent_hash.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_random_exchange/src/rabbit_exchange_type_random.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_recent_history_exchange/src/rabbit_exchange_type_recent_history.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_trace.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v3.13.7/deps/rabbit/src/rabbit_trace.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/Makefile
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_vhost.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/vhost.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.1.0/deps/rabbit/src/vhost.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.1.4/deps/rabbit/src/vhost.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.0.9/deps/rabbit/src/vhost.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/src/rabbit_mgmt_wm_vhost.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/test/rabbit_mgmt_http_SUITE.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_cli/lib/rabbitmq/cli/ctl/commands/trace_on_command.ex
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_tracing/src/rabbit_tracing_mgmt.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_tracing/src/rabbit_tracing_util.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_tracing/src/rabbit_tracing_traces.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_tracing/src/rabbit_tracing_consumer.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_tracing/src/rabbit_tracing_wm_trace.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/firehose.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/mc.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/mc_amqpl.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v3.13.7/deps/rabbit/src/mc_amqpl.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.0.0/deps/rabbit/src/mc_amqpl.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/mc_amqp.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.9/deps/rabbit/src/rabbit_core_ff.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/dlx.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/release-notes/3.13.0.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/release-notes/3.13.1.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/release-notes/4.0.1.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/release-notes/4.1.0.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/release-notes/4.2.0.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/release-notes/4.2.5.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/release-notes/4.2.6.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/release-notes/4.2.8.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/release-notes/4.3.0.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/release-notes/4.3.1.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/release-notes/4.3.2.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/release-notes/4.3.6.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.4.x/release-notes/4.4.0.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/5.0.0.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_amqqueue.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_classic_queue.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_queue_location.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_queue_type.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_quorum_queue.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_amqqueue_process.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_amqp_session.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.1.8/deps/rabbit/src/rabbit_amqp_session.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.0.9/deps/rabbit/src/rabbit_amqp_session.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_amqp_management.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/amqp10_common/include/amqp10_filter.hrl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_stream_queue.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_stream/src/rabbit_stream_reader.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_stomp/src/rabbit_stomp_processor.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.4.x/deps/rabbitmq_stomp/src/rabbit_stomp_processor.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_shovel/src/rabbit_local_shovel.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/priv/www/js/global.js
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/priv/www/js/tmpl/queue.ejs
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management_agent/src/rabbit_mgmt_agent_config.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.4.x/deps/rabbitmq_management_agent/src/rabbit_mgmt_agent_config.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management_agent/src/rabbit_mgmt_agent_config.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management_agent/priv/schema/rabbitmq_management_agent.schema
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/priv/schema/rabbitmq_management.schema
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/src/rabbit_mgmt_util.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/src/rabbit_mgmt_wm_queues.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/src/rabbit_mgmt_wm_queue.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.5/deps/rabbitmq_management/src/rabbit_mgmt_wm_channels.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/src/rabbit_mgmt_wm_channels.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.9/deps/rabbitmq_management/src/rabbit_mgmt_wm_channels.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/src/rabbit_mgmt_wm_nodes.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/src/rabbit_mgmt_wm_overview.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/src/rabbit_mgmt_dispatcher.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v3.13.7/deps/rabbitmq_management/src/rabbit_mgmt_dispatcher.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.1.8/deps/rabbitmq_management/src/rabbit_mgmt_dispatcher.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/src/rabbit_mgmt_wm_reset.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/src/rabbit_mgmt_wm_queue_actions.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/src/rabbit_mgmt_wm_quorum_queue_replicas_add_member.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/src/rabbit_mgmt_wm_queue_purge.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/src/rabbit_mgmt_cors.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.1/deps/rabbitmq_management/src/rabbit_mgmt_cors.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.8/deps/rabbitmq_management/src/rabbit_mgmt_cors.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_stream_management/src/rabbit_stream_super_stream_mgmt.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_stream_management/src/rabbit_stream_tracking_mgmt.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_shovel_management/src/rabbit_shovel_mgmt_shovel.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_federation_management/src/rabbit_federation_mgmt.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_top/src/rabbit_top_extension.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.0/deps/rabbitmq_prometheus/src/rabbit_prometheus_dispatcher.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v3.9.29/deps/rabbitmq_prometheus/src/rabbit_prometheus_dispatcher.erl
- https://api.github.com/repos/rabbitmq/rabbitmq-server/contents/deps?ref=v4.3.6
- https://api.github.com/repos/rabbitmq/rabbitmq-server/contents/deps?ref=v4.4.x
- https://api.github.com/repos/rabbitmq/rabbitmq-server/contents/deps?ref=main
- https://api.github.com/repos/rabbitmq/rabbitmq-server/contents/deps/rabbitmq_cli/lib/rabbitmq/cli/streams/commands?ref=v4.3.6
- https://api.github.com/repos/rabbitmq/rabbitmq-server/contents/deps/rabbitmq_cli/lib/rabbitmq/cli/queues/commands?ref=v4.3.6
- https://api.github.com/repos/rabbitmq/rabbitmq-server/contents/deps/rabbitmq_cli/lib/rabbitmq/cli/upgrade/commands?ref=v4.3.6
- https://api.github.com/repos/rabbitmq/rabbitmq-server/contents/release-notes?ref=v4.3.x
- https://github.com/rabbitmq/rabbitmq-server/issues/15182
- https://github.com/rabbitmq/rabbitmq-server/pull/15651
- https://github.com/rabbitmq/rabbitmq-server/pull/15689
- https://github.com/rabbitmq/rabbitmq-server/issues/17255
- https://github.com/rabbitmq/rabbitmq-server/issues/16425
- https://github.com/rabbitmq/rabbitmq-server/pull/16271
- https://github.com/rabbitmq/rabbitmq-server/pull/16272
- https://github.com/rabbitmq/rabbitmq-server/pull/16085
- https://github.com/rabbitmq/rabbitmq-server/pull/17198
- https://github.com/rabbitmq/rabbitmq-server/pull/16544
- https://github.com/rabbitmq/rabbitmq-server/pull/16009
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/stream-filtering.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/streams.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/stomp.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/amqp.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/versioned_docs/version-4.3/amqp.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/access-control.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/logging.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/event-exchange.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/local-random-exchange.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/modulus-hash-exchange.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/maxlength/index.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/consumers.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/management/index.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/prometheus/index.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/client-libraries/amqp-client-libraries.md
- https://github.com/coders51/rabbitmq-amqp-js-client
- https://registry.npmjs.org/rabbitmq-amqp-js-client
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/src/consumer.ts
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/src/utils.ts
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/src/environment.ts
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/src/connection.ts
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/src/rhea_wrapper.ts
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/src/management.ts
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/src/delivery_context.ts
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/src/message.ts
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/src/queue.ts
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/src/binding.ts
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/package.json
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/README.md
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/main/docker-compose.yml
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/test/e2e/consumer.test.ts
- https://api.github.com/repos/coders51/rabbitmq-amqp-js-client/issues?state=all
- https://raw.githubusercontent.com/amqp/rhea/main/lib/types.js
- https://raw.githubusercontent.com/amqp/rhea/main/lib/terminus.js
- https://raw.githubusercontent.com/amqp/rhea/main/lib/connection.js
- https://raw.githubusercontent.com/amqp/rhea/main/lib/filter.js
- https://registry.npmjs.org/rhea
- https://registry.npmjs.org/rabbitmq-stream-js-client
- https://raw.githubusercontent.com/coders51/rabbitmq-stream-js-client/main/src/requests/subscribe_request.ts
- https://raw.githubusercontent.com/coders51/rabbitmq-stream-js-client/main/src/client.ts
- https://raw.githubusercontent.com/coders51/rabbitmq-stream-js-client/main/README.md
- https://registry.npmjs.org/amqplib
- https://raw.githubusercontent.com/amqp-node/amqplib/main/lib/codec.js
