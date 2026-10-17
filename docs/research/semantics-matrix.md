# Peek semantics by RabbitMQ version and queue type

> **Verified research (2026-10-16).** Source read at exact release tags and primary docs; **not yet lab-tested**. The conformance suite (M0) confirms or corrects every runtime claim. Content about a specific third-party product was removed under the docs policy ([ADR-034](../adr/ADR-034-docs-policy.md)).

_Verification task `semantics-quorum-peek` · 2026-10-16_

## Summary

I read the source at exact tags (v3.13.7, v4.0.0/v4.0.9, v4.1.0/v4.1.8, v4.2.0/v4.2.9, v4.3.0–v4.3.6, and main @031917f = 4.4.0-dev, QQ machine v9). Quorum queues fall into three eras.

3.13: every return increments delivery_count (DC, shown as x-delivery-count). That covers nack, reject, released, close/crash and the channel-level consumer timeout. There is no default limit. Without a limit, nack and reject requeues move the message to the TAIL.

4.0–4.2: the default limit (20) is checked against acquired_count (AC), and every return increments it, including basic.nack and the management UI's default 'Nack message requeue true'. The AMQP 0-9-1 x-delivery-count header shows AC. Each peek therefore spends one attempt, and a message already at AC = L is dead-lettered or dropped by the peek itself. No remote API avoids this.

4.3+: the limit is checked against DC, which only failures increment: basic.reject(requeue), AMQP 1.0 rejected/modified(delivery-failed), and any exit of the channel, session or connection while it holds deliveries. Graceful channel.close, connection.close and basic.cancel-then-close all count as such exits. nack, released, modified(df=false), QQ consumer timeouts, partitions (after a 60 s grace) and AMQP 1.0 link detach only bump x-acquired-count.

Caveat: 4.3 tests DC > L on every return, and dead-lettering copies DC into the target quorum queue. A message dead-lettered at L+1 into a default-limit quorum DLQ is therefore dropped (or re-dead-lettered) by a single nack-based peek. This is confirmed in code for 4.3/main; on 4.0–4.2 and 3.13 the DLQ starts a fresh budget.

The management /get endpoint runs basic.get N times, then nacks (ack_requeue_true) or rejects each message. It has no count cap. rabbitmq-queues peek is the only side-effect-free classic/quorum read; it is QQ-only and needs Erlang-distribution access, and no HTTP or AMQP route exists.

Classic queues have no limit, requeue to the original position and set redelivered; 4.3 dropped their consumer timeouts. 4.3 delayed retry (types all|returned) hides nack-peeked messages for at least the minimum delay. Other hazards:
- drop-head length limits drop the returned messages first;
- TTL expiry on return;
- QQ SAC refuses basic.get (405), and classic-queue basic.get bypasses SAC;
- consume-based peeks can delete auto-delete queues;
- exclusive queues are unreadable from other connections.

The Queue Studio and Warren claim that nack is free on 4.x holds only on 4.3+.

The product must:
- be version-aware and settle only with nack or released;
- keep holds short, on dedicated connections;
- read the queue's real delivery_limit stat and check DLQ topology;
- describe itself as 'side-effect-aware', not 'non-destructive'. Only stream browsing and an agent-based QQ peek can honestly be called non-destructive.

## Verdicts

| ID | Verdict | Confidence | Verified statement |
| --- | --- | --- | --- |
| C1 | confirmed | high | Confirmed for every 4.0.x-4.2.x tag checked (v4.0.0, v4.0.9, v4.1.0, v4.1.8, v4.2.0, v4.2.9). return_one dead-letters (reason delivery_limit) or drops when the post-increment acquired_count is greater than L, i.e. on the (L+1)-th return; with L=20 a message can be delivered 21 times. incr_msg adds 1 to acquired_count on every return and adds 1 to delivery_count only when delivery_failed is true. basic.nack and basic.reject with requeue=true map to the same 'requeue' op (#return), AMQP 1.0 released maps to requeue, and modified(undeliverable_here=false) maps to #modify. Consumer-process exits (crash, TCP loss, graceful channel or connection close), noconnection and channel-level consumer-timeout closures all go through return_all (AC+1 and DC+1). In 4.0-4.2 the AMQP 0-9-1 x-delivery-count header IS acquired_count, and redelivered means AC > 0. The AMQP 1.0 header delivery-count shows only delivery_count (failures), so AMQP 1.0 clients cannot see the budget being spent. Nuances: (a) the default of 20 applies to queues declared on 4.0+ or reconfigured by a policy event; a 3.13-era QQ upgraded in place keeps 'unlimited', because convert_v3_to_v4 copies cfg. (b) With L = -1 (unlimited), the aux handler converts nack/reject/released returns into #requeue commands that re-append the message at the TAIL; #modify and consumer-down returns still go to the head. The conflicting claim is true only for 4.3+, and even there it is incomplete: graceful channel/connection close, AMQP 1.0 rejected and modified(df=true) also increment delivery-count. |
| C2 | confirmed | high | Confirmed for v4.3.0-v4.3.6 and main. return_one tests delivery_count > L, and incr_msg_headers increments AC on every return but DC only for failed deliveries.  AMQP 0-9-1 mapping: - basic.nack(requeue=true) -> requeue: AC only. - basic.nack(requeue=false) -> {modify,false,true}: dead-lettered with reason rejected, AC only. - basic.reject(requeue=true) -> {modify,true,false}: AC+DC. - basic.reject(requeue=false) -> discard: AC+DC, then dead-lettered.  AMQP 1.0 mapping: - released -> requeue: AC only. - modified(df=false, uh=false): AC only. - modified(df=true, uh=false): AC+DC. - rejected -> discard: AC+DC, then dead-lettered.  Other returns: - QQ consumer timeout returns via return_multiple(false): AC only. - Intra-cluster partition (noconnection) marks the consumer suspected_down; after consumer_disconnected_timeout (default 60 s) its messages return with AC only. - Any other DOWN of the consuming process goes cancel_consumer(down) -> return_all(true): AC+DC. This covers crashes and TCP loss, but also graceful channel.close, connection.close, AMQP 1.0 session end and connection close. The channel and session send nothing to QQs on close, and rabbit_fifo_client:close only evicts a cache. - basic.cancel alone sets the consumer to 'cancelled' and keeps its deliveries checked out (they can still be acked or nacked); a later close is the DOWN case above. - AMQP 1.0 link detach cancels with reason 'remove' -> return_all(false): AC only.  Per version: - 3.13: every one of these increments DC, which is the limit counter when a limit is set. - 4.0-4.2: every one increments AC, the limit counter; DOWN, noconnection and df=true also increment DC.  The conflicting claim is FALSE on 4.3+, but true on 3.13 and 4.0-4.2, where the channel-level timeout closes the channel and so counts. |
| C3 | nuanced | high | TRUE for 4.3.0-4.3.6 and main; FALSE for 4.0-4.2 and 3.13.  How it happens on 4.3+: - annotate_msg copies the header delivery_count (and acquired_count) into message annotations. Both dead-letter strategies call it: at-most-once in discard_or_dead_letter, at-least-once in rabbit_fifo_dlx. - mc:record_death preserves those annotations. - The target quorum queue's maybe_set_msg_delivery_count seeds its header delivery_count from the annotation on enqueue. - return_one then tests DC > L on every return, whether or not that return incremented DC.  Consequence: from a default-limit source (L=20), a message dead-lettered for delivery_limit arrives with DC = 21. In a default-limit QQ DLQ, its first return of ANY kind dead-letters it again (reason delivery_limit) or drops it if the DLQ has no DLX. That includes a nack/released/modified(df=false) peek, management 'Get messages' with Nack requeue, consumer timeout, partition timeout, close or crash.  What makes it safe: - the DLQ's effective limit is -1, or at least the largest carried count (at least max source L + 1); - or the DLQ is a classic queue or a stream. A DLX on the DLQ prevents loss but re-dead-letters the message; a cycle without a 'rejected' death is dropped by rabbit_dead_letter:detect_cycles.  Every dead-letter reason carries its count: rejected arrives with k+1 after k failures, expired and maxlen with whatever count they had.  On 4.0-4.2 the limit uses acquired_count, which is never carried or seeded, so the DLQ grants a fresh budget of L returns; the carried DC only appears in headers. 3.13 has no carry-over code. |
| C4 | confirmed | high | rabbit_mgmt_wm_queue_get.erl behaves the same at v3.13.7, v4.0.9, v4.2.9, v4.3.6 and main. - with_channel opens a direct AMQP connection and channel as the HTTP user. - basic_gets/6 runs basic.get Count times and holds every message unacknowledged in a list. no_ack is true only for ack_requeue_false. - maybe_return/3 then settles each message with a separate call:   - ack_requeue_true -> basic.nack(requeue=true, multiple=false), not reject;   - reject_requeue_true -> basic.reject(requeue=true);   - reject_requeue_false -> basic.reject(requeue=false), destructive;   - ack_requeue_false -> auto-ack, destructive. - The channel and connection are closed in an 'after' clause.  The server applies no cap on count. The UI form defaults to count 1, truncate 50000 and 'Nack message requeue true', and quorum queues use the same template. 4.2+ validates the ackmode (parse_ackmode/1); 3.13.7 and 4.0.9 used list_to_atom.  Per-message effect follows the version's nack or reject row: on 4.3+ only reject_requeue_true counts toward the limit, on 4.0-4.2 both count, and on 3.13 both increment DC and move the message to the TAIL when there is no limit. If the handler process dies mid-loop, the linked direct connection dies and the held messages return via the DOWN path.  Discussion #13060 is a user report of a memory spike or crash on 3.13.6, later 4.0.5, fetching more than 10K messages over 100 MB with automatic ack. Maintainers suspected the OOM killer; no bug was confirmed. It is plausible because the handler accumulates every payload and JSON-encodes them in one process. |
| C5 | confirmed | high | Confirmed for 3.13.7 through main. rabbit_quorum_queue:peek/2, which `rabbitmq-queues peek <queue> <position>` calls, is a Ra aux command on the leader. query_peek walks a copy of the machine state and ra_aux:log_fetch reads the body; no Raft command is written.  Limits of the CLI peek: - Quorum queues only: classic queues return classic_queue_not_supported and streams return not_quorum_queue. - Needs CLI or Erlang-distribution (cookie) access to a node. - One message per call at a 1-based position, at O(position) cost per call. - Sees only ready messages (returns first, then the priority queue). Unacked, 4.3+ delayed and DLX-pending messages are invisible. - Its x-delivery-count shows delivery_count, not the acquired_count that 4.0-4.2 limits use.  No remote route exists: - The management dispatcher (v4.2.9, v4.3.6, main) routes only /queues/:vhost/:queue, /contents, /get (basic.get-based) and /actions, and /actions has no actions left. - rabbit_amqp_management exposes queue metadata, purge and bindings, never message reads. - AMQP 1.0 copy (browse) distribution mode is supported only by streams; QQ and CQ are move-only.  Streams are non-destructive to read by design. |
| C6 | nuanced | high | (1) Delivery-limit via policy already reaches existing QQs on 4.0-4.2 (and 3.13). The event path is rabbit_policy -> rabbit_amqqueue:policy_changed -> notify_policy_changed -> rabbit_queue_type:policy_changed -> rabbit_quorum_queue:policy_changed -> update_machine_state(ra_machine_config(Q)), and rabbit_fifo:update_config overwrites delivery_limit. The v4.2.9 test applies delivery-limit=1 by policy to an existing queue and asserts the drop, and the 4.2 docs say policy changes take effect without redeclaring.  What 4.2 excluded was only the periodic tick reconciliation (maybe_apply_policies). PR #16035 (main, 2026-04-13, in the 4.4.0 notes) and backport #16036 (in v4.3.0, in the 4.3.0 notes) add delivery_limit to that comparison. Its guard, `is_integer(Value) orelse Value < 0`, maps every integer to undefined, so the reconciliation still ignores delivery-limit at v4.3.0-v4.3.6 and on main. The 4.4.0 note 'previously ... could not be updated from a policy' therefore overstates the change.  Side effect: any policy event on a 3.13-era queue upgraded to 4.x silently applies the effective limit (default 20) to it.  (2) consumer_timeout defaults to 1,800,000 ms (30 min) in the rabbit app env of 3.13.7, 4.2.9, 4.3.6 and main. Up to 4.2 the channel evaluates it for every queue type, about once a minute, honouring per-queue x-consumer-timeout or the consumer-timeout policy, and closes the channel with 406.  In 4.3+ only quorum queues evaluate it, with the same 30-min default. Resolution order: consumer argument x-consumer-timeout (or the AMQP 1.0 link property rabbitmq:consumer-timeout), then min(queue argument, policy), then the global value. 'undefined' no longer disables it: 4.3.0-4.3.2 hit a strict assertion (badmatch) on consume and get, and 4.3.3+ falls back to 24 h. main adds consumer_timeout_response = notify_consumer\|close_channel.  (3) Yes. Since 4.3.0, classic queues and streams have no consumer timeout: evaluate_consumer_timeout is gone from rabbit_channel, and rabbit_amqqueue_process never had it. The same holds on main. |
| C7 | confirmed | high | Classic queues, all versions: - A requeued message returns to its ORIGINAL position (merged by SeqId) and is marked redelivered=true. - There is no delivery limit: delivery-limit is an unsupported policy for classic queues and they take no x-delivery-limit argument. - 4.3+ keeps a per-message failure counter for reject, modified(df=true), channel down and AMQP 1.0 detach. It surfaces only as the AMQP 1.0 header delivery-count; AMQP 0-9-1 gets no header. - After every requeue, maybe_drop_head and drop_expired_msgs run, so peeked messages can be dead-lettered or dropped with reason maxlen or expired.  Single active consumer (SAC): - Quorum queue: basic.get is refused ({unsupported, single_active_consumer}) with channel error 405 RESOURCE_LOCKED. - Classic queue: basic.get BYPASSES SAC and takes the head while the active consumer runs, which can break its ordering. - A browsing consumer CAN become active: as the first or only consumer, on failover when the active one leaves, and on quorum queues 4.0+ by registering with a higher x-priority, which quiesces the current active consumer and then takes over.  Exclusive queues: basic.get and basic.consume go through with_exclusive_access_or_die, which gives 405 RESOURCE_LOCKED to every other connection, including the management API's direct connection. Only classic queues can be exclusive.  Auto-delete: basic.consume on an auto-delete classic queue deletes the queue when that consumer, as the last one, cancels or closes. basic.get never triggers this. |
| C8 | confirmed | high | Yes, when the delayed-retry type is all or returned.  Configuration (4.3.0+): - Arguments: x-delayed-retry-type = disabled (default) \| all \| failed \| returned; x-delayed-retry-min (ms, integer > 0, required; without it delayed retry is disabled); x-delayed-retry-max (ms, defaults to min). - Policy keys delayed-retry-type, delayed-retry-min and delayed-retry-max are accepted only from 4.3.1. - A policy's type beats the queue argument. An operator policy wins the type, max() applies to min and min() to max.  should_delay0 by type: - all: delays every return. - returned: delays only non-failed returns (basic.nack, released, modified(df=false), consumer timeout, disconnect timeout). - failed: delays only failed returns (reject, modified(df=true), close or crash).  The delay is min(min x max(1, delivery_count), max) ms from the return time; a nack does not raise delivery_count, so nack-peeks are delayed by about min each time.  While delayed, a message is not ready. Real consumers, basic.get and rabbitmq-queues peek cannot see it. It still counts toward max-length and shows as messages_delayed / next_delayed_at. When due it is promoted to the head of the returns queue.  Independently of the type, an AMQP 1.0 modified outcome carrying x-opt-delivery-time delays redelivery; that is already in the 4.3.0 code. 4.4/main adds delayed publish. |
| QS | nuanced | high | Technique: its README reads quorum queues 'over the HTTP API' and says they are marked redelivered and 'not counted'. That is POST /api/queues/{vhost}/{q}/get with ackmode=ack_requeue_true (basic.get xN + basic.nack(requeue=true)), with N capped at 5,000 by the plugin. Classic queues use AMQP with up to 65,535 held messages.  By version: - 4.3+ (QQ machine v8+): true. The peek adds 1 to AC, sets redelivered, and returns the message to the head, or delays it when delayed-retry is all or returned. It is false for messages already over the limit (C3 DLQ arrivals, or a limit lowered by policy): the nack drops or re-dead-letters them, so the marketplace line 'browsing does not drop messages' does not hold there. - 4.0-4.2: false. Every peek adds 1 to AC, which is exactly the limit counter, and messages at AC = L are dead-lettered or dropped by the peek. - 3.13: every peek adds 1 to DC; with no limit set (the 3.13 default), it moves the peeked messages to the tail.  No remote API makes a 4.0-4.2 QQ read free. The only options are the CLI peek (needs node access) or temporarily raising the limit by policy, which avoids the immediate drop but still spends the attempt. The 5,000 cap plausibly bounds management memory (#13060) and the hold window. |
| P1 | refuted | high | True only for 4.3.0+ (machine v8). On 4.0.x-4.2.x every return counts toward the limit (acquired_count), including deliberate basic.nack/basic.reject requeues, AMQP 1.0 released and the management UI's Nack-requeue default. 4.1 and 4.2 are still widely deployed, so a peek UI must model this. |
| P2 | refuted | high | On 4.3+, every return, reject included, goes into the QQ returns queue (HEAD, served before all ready messages and without priority) unless delayed retry applies. Tail placement only happens when the delivery limit is unlimited: on 4.0-4.2 with L=-1, or on 3.13 with no limit. In those cases it applies to nack, reject and released requeues alike, because the aux handler turns #return into #requeue. |
| P3 | nuanced | high | Only v4.3.0 requires configure permission for passive queue declares. From v4.3.1 (and in 4.4), any of configure, write or read is enough (check_any_resource_access_permitted).  This matters for peeking: on 4.3.0, a read-only user's passive declare on a channel that holds deliveries raises 403. That closes the channel, and on 4.3 the held deliveries then count as failed. |
| P4 | nuanced | medium | In 4.3.0 code: delayed REDELIVERY via x-opt-delivery-time in an AMQP 1.0 modified outcome, x-opt-deferral-token handling and assign_deferred commands. Also in 4.3.0: delayed retry (x-delayed-retry-*).  New in 4.4/main (#16583): delayed PUBLISH, i.e. an x-opt-delivery-time annotation or header honoured at enqueue time. main also moves the QQ machine to v9, with deferral claims. |
| P5 | nuanced | high | basic.reject and connection loss count in every version. Consumer timeout counts on 3.13 (when a limit is set) and on 4.0-4.2, because the channel is closed. It does not count on 4.3+, where the quorum queue returns timed-out messages with only x-acquired-count+1. |
| P6 | refuted | high | Neither the server handler nor the UI caps the count. The UI defaults to count=1 and truncates each payload to 50,000 bytes. Any count can be typed in or sent to the HTTP API, and the handler holds all of those messages in memory. |
| P7 | refuted | medium | On 4.3+ the QQ consume and dequeue path (rabbit_queue_type:get_consumer_timeout) does not accept undefined. 4.3.0-4.3.2 hit a strict assertion, 'true = is_integer(MS)', which fails consume and get for queues without a per-queue timeout; from code reading this applies to all queue types. 4.3.3+ logs a warning and uses 24 h. Disabling via undefined only works on 4.2 and earlier, at channel level. |

### Evidence

- **C1** (confirmed, high): rabbit_fifo.erl@v4.2.9 L1954-1957: 'case get_header(acquired_count, Header) of AcquiredCount when AcquiredCount > DeliveryLimit -> rabbit_fifo_dlx:discard([Msg], delivery_limit, DLH, DlxState0)'; incr_msg/3 L3097-3111 (acquired_count +1 always; delivery_count +1 only when DelFailed) https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.9/deps/rabbit/src/rabbit_fifo.erl . The same acquired_count check is at v4.0.0 L1855, v4.0.9 L1904, v4.1.0 L1907, v4.1.8 L1956 and v4.2.0 L1956. rabbit_channel.erl@v4.2.9 internal_reject L1976-1985: 'Op = case Requeue of false -> discard; true -> requeue end', used by both basic.nack (L1279-1282) and basic.reject (L1589-1591) https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.9/deps/rabbit/src/rabbit_channel.erl . rabbit_amqp_session.erl@v4.2.9 L2073-2095: released -> requeue, rejected -> discard, modified -> {modify, DelFailed, UndelHere, Anns}. rabbit_fifo_client.erl@v4.2.9 L241-258: mc:set_annotation(x-delivery-count, AcqCount), Redelivered = AcqCount > 0. DEFAULT_DELIVERY_LIMIT 20 in rabbit_quorum_queue.erl@v4.0.9 L111 and @v4.2.9 L131. Aux return converted to #requeue (tail) when delivery_limit = undefined: rabbit_fifo.erl@v4.2.9 L1036-1066; versioned_docs/version-4.2 quorum-queues 'returned to the back of the queue if no delivery-limit is set' https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/versioned_docs/version-4.2/quorum-queues/index.md . Official test quorum_queue_SUITE.erl@v4.2.9 subscribe_redelivery_policy: sets policy delivery-limit=1 on an existing QQ, does two basic.nack(requeue=true), the redelivery carries x-delivery-count 1, then asserts 0 messages and no redelivery https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.9/deps/rabbit/test/quorum_queue_SUITE.erl . 4.0 release notes: https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.0.1.md
- **C2** (confirmed, high): rabbit_fifo.erl@v4.3.6 (https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_fifo.erl):
- return_one/8 L2348-2398: 'case get_header(delivery_count, Header) of DeliveryCount when is_integer(DeliveryCount) andalso DeliveryCount > DeliveryLimit -> discard_or_dead_letter([Msg], delivery_limit, ...)'.
- incr_msg_headers L3884-3899.
- maybe_return_all L1954-1972: 'return_all(Meta, S0, Effects0, ConsumerKey, Consumer, Reason == down)'.
- handle_down L1041-1053.
- noconnection L563-605 and consumer_disconnected_timeout L607-640: return_all(..., false).
- evaluate_consumer_timeout L721-794: return_multiple(Meta, CKey, Con, MsgIdsSorted, false, ...).

rabbit_channel.erl@v4.3.6 (https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_channel.erl):
- L1249-1257: nack -> requeue.
- L1527-1534: reject -> settle(true, false).
- L2314-2316: settle/2 = {modify, DeliveryFailed, UndeliverableHere, #{}}.
- terminate L721-740 and channel.close L1152-1165: notify_queues only reaches classic pids (L2066-2074).
- L2825-2838: timeout release -> basic.cancel or close.

Other files:
- rabbit_fifo_client.erl@v4.3.6 close/1 L798-802.
- rabbit_amqp_session.erl@v4.3.6: settle_op_from_outcome L2129-2160, detach with reason remove L1255-1296, terminate L502-516.
- v4.3.0 rabbit_channel.erl L1478-1486 is the first tag with the nack/reject split (v4.0.9 L1547-1549 and v4.1.8 L1553-1555 still call reject(DeliveryTag, Requeue, ...)).
- Makefile@v4.3.6 L87: consumer_disconnected_timeout 60000.
- main is identical (rabbit_channel.erl@main L1291-1299 and L1573-1581; rabbit_fifo.erl@main L2099-2100 and L827).
- Docs table: https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/quorum-queues/index.md
- **C3** (nuanced, high): rabbit_fifo.erl@v4.3.6 (https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_fifo.erl):
- annotate_msg/2 L2325-2346.
- discard_or_dead_letter at_most_once (L4171+): 'ensure header delivery count is copied to the message container'.
- maybe_set_msg_delivery_count/2 L2032-2044, called from maybe_enqueue.
- return_one/8 L2348-2398.

Other 4.3.6 files:
- rabbit_fifo_dlx.erl@v4.3.6 L168 and L241: annotate_msg (at-least-once).
- mc.erl@v4.3.6 record_death/3: does not touch delivery_count.
- mc_amqp.erl@v4.3.6 essential_properties: a publisher cannot inject delivery-count.
- main is identical.

Contrast with older versions: rabbit_fifo.erl@v4.2.9 L1954 checks acquired_count, and annotate_msg there only copies delivery_count and anns; v3.13.7 has no maybe_set_msg_delivery_count.

Third-party measurement on 4.3.6 (author linked to the Warren competitor): 21 abandoned deliveries, the DLQ shows x-delivery-count 21, and 0 messages are left after one basic.get + nack peek. https://dev.to/viktorbaumann/your-quorum-dead-letter-queue-can-drop-the-dead-letters-x-delivery-count-travels-along-240n
- **C4** (confirmed, high): rabbit_mgmt_wm_queue_get.erl maybe_reject_or_nack/3, identical at all tags:
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v3.13.7/deps/rabbitmq_management/src/rabbit_mgmt_wm_queue_get.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/src/rabbit_mgmt_wm_queue_get.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/src/rabbit_mgmt_wm_queue_get.erl
It reads: 'ack_requeue_true -> basic.nack{multiple = false, requeue = true}' and 'reject_* -> basic.reject{requeue = ackmode_to_requeue(AckMode)}'.

Other evidence:
- rabbit_mgmt_util.erl@v4.3.6 with_channel L1038-1075.
- classic-queue-get-message.ejs@v4.3.6: ack_requeue_true is selected, count 1, truncate 50000.
- global.js@v4.3.6: the quorum queue type has get_message: true.
- main.js get_msgs: no cap.
- https://github.com/rabbitmq/rabbitmq-server/discussions/13060
- **C5** (confirmed, high): rabbit_quorum_queue.erl@v4.3.6 peek/2: ra:aux_command(LeaderPid, {peek, Pos}) https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_quorum_queue.erl

rabbit_fifo.erl@v4.3.6 handle_aux peek L1482-1495 and query_peek L1698-1707.

peek_command.ex@v4.3.6 (also present at v3.13.7, v4.0.9 and main) https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_cli/lib/rabbitmq/cli/queues/commands/peek_command.ex

rabbit_mgmt_dispatcher.erl L155-159 at v4.2.9, v4.3.6 and main https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/src/rabbit_mgmt_dispatcher.erl

rabbit_mgmt_wm_queue_actions.erl@main: action/4 returns {unknown, Else}.

rabbit_amqp_management.erl@main handle_http_req: GET queues/:q, DELETE queues/:q/messages, GET bindings https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbit/src/rabbit_amqp_management.erl

distribution_modes: QQ [move] (rabbit_quorum_queue.erl@v4.3.6 L642), CQ [move] (rabbit_classic_queue.erl L662), stream [copy] (rabbit_stream_queue.erl L1516).
- **C6** (nuanced, high): Policy path:
- rabbit_quorum_queue.erl@v4.2.9 L752-769: 'delivery_limit can't be updated from a policy and thus has to be excluded from the comparison'.
- rabbit_policy.erl@v4.2.9 L486-505.
- rabbit_amqqueue.erl@v4.2.9 notify_policy_changed -> rabbit_queue_type:policy_changed.
- rabbit_quorum_queue:policy_changed -> update_machine_state(ra_machine_config(Q)).
- quorum_queue_SUITE.erl@v4.2.9 subscribe_redelivery_policy.
- 4.2 docs: https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/versioned_docs/version-4.2/quorum-queues/index.md (L371-384).
- PR https://github.com/rabbitmq/rabbitmq-server/pull/16035 , diff https://patch-diff.githubusercontent.com/raw/rabbitmq/rabbitmq-server/pull/16035.diff , backport #16036.
- canonicalize_delivery_limit at v4.3.0 L910 and v4.3.6 L981-987: 'Value when is_integer(Value) orelse Value < 0 -> Config#{delivery_limit => undefined}'.
- release-notes 4.3.0.md and 4.4.0.md both cite #16035.

Consumer timeout:
- Makefile consumer_timeout 1800000 at v3.13.7 L90, v4.2.9 L90, v4.3.6 L86 and main L86.
- rabbit_queue_type.erl@v4.3.0 get_consumer_timeout: 'true = is_integer(MS)'; @v4.3.3 falls back to 86_400_000.
- consume/3 at v4.3.6 L547-553 reads the x-consumer-timeout consumer argument.
- rabbit_channel.erl@v4.2.9 L2854-2905 evaluate_consumer_timeout, removed in v4.3.6.
- rabbit.schema@main consumer_timeout_response.
- 4.3.0 notes, 'Consumer Timeouts are No Longer Evaluated for Classic Queues and Streams': https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.3.0.md
- consumers.md L426: https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/consumers.md
- **C7** (confirmed, high): Classic queue position and limits:
- rabbit_variable_queue.erl@v4.3.6 L73-74, 'Messages being requeued are returned to their position in the queue using their SeqId value'; requeue_merge L1833-1855; maybe_inc_delivery_count L1857-1868 https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_variable_queue.erl
- rabbit_variable_queue.erl@v3.13.7 L84 has the same comment.
- rabbit_classic_queue.erl@v4.3.6 capabilities L641-663.

rabbit_amqqueue_process.erl@v4.3.6:
- basic_get L1328-1345: no SAC check.
- requeue_and_run L929-943.
- stop_consumer / should_auto_delete L1419-1450.

Quorum queue SAC:
- rabbit_fifo.erl@v4.3.6 L397-399: dequeue under single_active returns an error.
- rabbit_fifo.erl@v4.3.6 L1917-1921: quiescing for a higher-priority consumer.

Channel checks:
- rabbit_channel.erl@v4.3.6 L1284-1292: with_exclusive_access_or_die.
- rabbit_channel.erl@v4.3.6 L2879-2885: resource_locked 'basic.get operations are not supported by quorum queues with single active consumer'.

Docs: consumers.md 'Initial SAC Selection' https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/consumers.md
- **C8** (confirmed, high): rabbit_quorum_queue.erl@v4.3.6 https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_quorum_queue.erl:
- L202-263: validators.
- L267-272: merge_policy_value.
- L1975-2001: get_delayed_retry_config.

rabbit_fifo.erl@v4.3.6:
- L2400-2422: should_delay, x-opt-delivery-time first.
- L2424-2436: should_delay0.
- L2437-2443: calculate_ready_at, 'Delay = min(Min * DeliveryCount, Max)'.
- L1744-1746: messages_ready_plus_delayed.
- The same code is present at v4.3.0 L2400-2432.

quorum_queue_SUITE.erl@v4.3.6 delayed_retry_returned: modified df=false is delayed, df=true is delivered immediately.

Release notes:
- 4.3.0, #13885: https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.3.0.md
- 4.3.1, 'delayed retry-related policy keys are now accepted': https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.3.1.md

Docs: quorum-queues Delayed Retry section.
- **QS** (nuanced, high): README: 'Quorum | Up to 5,000 messages over the HTTP API | Marked redelivered; does not count toward delivery-limit' https://raw.githubusercontent.com/drbenzin/queue-studio-docs/main/README.md

JetBrains Marketplace description: 'Peeking a quorum queue never counts toward its delivery-limit, so browsing does not drop messages' https://plugins.jetbrains.com/api/plugins/34454

Code evidence: as in C1, C2, C3 and C4.
- **P1** (refuted, high): C1 evidence: rabbit_fifo.erl@v4.2.9 L1954-1957, rabbit_channel.erl@v4.2.9 L1976-1985, quorum_queue_SUITE.erl@v4.2.9 subscribe_redelivery_policy (a nack-based test).

Competitor docs: https://warrenops.io/docs/quorum-queues.html
- **P2** (refuted, high): rabbit_fifo.erl@v4.3.6:
- return_one: State0#?STATE{returns = lqueue:in(Msg, Returns)}.
- take_next_msg: serves returns first.

rabbit_fifo_client.erl@v4.3.6 L1045-1052: the aux return path is commented out.

rabbit_fifo.erl@v4.2.9 L1036-1066 and @v3.13.7 L1007-1032: the aux requeue (tail) is used only when delivery_limit = undefined.

Docs, 'Redelivery of Returned Messages': https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/quorum-queues/index.md
- **P3** (nuanced, high): rabbit_channel.erl@v4.3.0 L2534: check_configure_permitted.

check_any_resource_access_permitted(QueueName is present at v4.3.1, v4.3.2, v4.3.3, v4.3.4 and v4.3.6.

4.3.1 release notes (#16272, #16085): https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.3.1.md
- **P4** (nuanced, medium): rabbit_fifo.erl@v4.3.0:
- L2400-2415: x-opt-delivery-time and x-opt-deferral-token in should_delay.
- L159 and L531: assign_deferred.

rabbit_fifo.erl@main:
- get_delivery_time/2.
- version() -> 9 (L1312).

4.4.0 notes: https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.4.0.md
- **P5** (nuanced, high): 4.3+:
- rabbit_fifo.erl@v4.3.6 L721-794: return_multiple(..., false, ...).

4.2 and earlier:
- rabbit_channel.erl@v4.2.9 L2870-2905: handle_consumer_timed_out closes the channel.
- The resulting DOWN goes through return_all(..., true).
- **P6** (refuted, high): Server: rabbit_mgmt_wm_queue_get.erl@v4.3.6 basic_gets/6, where Count comes from parse_int with no bound.

UI:
- classic-queue-get-message.ejs@v4.3.6: count 1, truncate 50000.
- main.js@v4.3.6 get_msgs.

- **P7** (refuted, medium): Code:
- rabbit_queue_type.erl@v4.3.0 / @v4.3.2 get_consumer_timeout(_, Q).
- rabbit_queue_type.erl@v4.3.3 / @v4.3.6 L950-975 (24 h fallback).

Release notes: 4.3.3.md (#16799).

Docs: consumers.md L471-477.

## Report

# Peek semantics for classic, quorum and stream queues in RabbitMQ 3.13 → 4.4-dev (source-verified 2026-10-16)

## 0. Scope, method, legend

- **Tags read** (from the GitHub tags API):
  - v3.13.7; v4.0.0 and v4.0.9; v4.1.0 and v4.1.8; v4.2.0 and v4.2.9; v4.3.0–v4.3.6.
  - v4.3.6 is the latest tag. `release-notes/4.3.7.md` exists on main but has no tag yet.
  - `main` @ 031917f (2026-10-16, "4.4.0 release notes updates").
- **QQ machine versions:**
  - 4.0–4.2: ≤ 7 (rabbit_fifo_v7 logic).
  - 4.3.x: **8** (`rabbit_fifo.erl@v4.3.6 version() -> 8`).
  - main: **9** (`rabbit_fifo.erl@main L1312`).
- **Method:** curl + grep of raw files at exact tags, release notes, the rabbitmq-website docs sources (curl gets a Cloudflare challenge on www.rabbitmq.com) and the official CT suites as behavioural evidence. No broker was run, so everything here is derived from code unless marked *measured (third party)*.
- **Legend:**

| Term | Meaning |
| --- | --- |
| AC | `acquired_count`, a per-message header in the QQ (4.0+). |
| DC | `delivery_count`. |
| L | Effective delivery limit in the QQ **machine state**; `undefined` means unlimited. |
| HEAD | The QQ `returns` queue, which is served before every other ready message. |
| TAIL | The message is re-appended to the end of the queue. |
| DELAYED | The 4.3+ delayed set. |
| ORIG | A classic queue's original SeqId position. |
| DLX/drop | Dead-lettered if a DLX is configured, otherwise deleted. |

- **What clients see:**

| Version | AMQP 0-9-1 | AMQP 1.0 |
| --- | --- | --- |
| 3.13 | `x-delivery-count` = DC; `redelivered` = DC > 0 | — |
| 4.0–4.2 | `x-delivery-count` = **AC**; `redelivered` = AC > 0 (rabbit_fifo_client.erl@v4.2.9 `add_delivery_count_header/2` L241-258) | header `delivery-count` = DC |
| 4.3+ | `x-acquired-count` = AC; `x-delivery-count` = DC (absent while DC = 0); `redelivered` = AC > 0 (rabbit_fifo_client.erl@v4.3.6 L246-269) | header `delivery-count` = DC |

## 1. Mechanisms by era (code citations)

### 1.1 RabbitMQ 3.13.7

Source: https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v3.13.7/deps/rabbit/src/rabbit_fifo.erl

- **Limit counter.** The limit is checked against DC, and every return increments DC. In `return_one/6` (L1847-1860): `Msg = update_msg_header(delivery_count, fun incr/1, 1, Msg0) ... DeliveryCount when DeliveryCount > DeliveryLimit -> rabbit_fifo_dlx:discard([Msg], delivery_limit, ...)`.
- **Default limit.** None: `maps:get(delivery_limit, Conf, undefined)` (L159).
- **Where returns go.**
  - Returns go to the Ra aux machine: `rabbit_fifo_client.erl@v3.13.7 send_command/5` L832-845.
  - With **no limit**, the aux handler turns `#return{}` into `#requeue{}` (L1007-1032). That re-appends the message with DC+1 (L250-275, `lqueue:in(?MSG(Idx, Header), Messages)`), so it goes to the TAIL.
  - With a limit set, the message goes to `returns` (HEAD).
  - Returns caused by a consumer going down use `return_all/5` and go to the HEAD.
- **AMQP 1.0 plugin mapping** (rabbitmq_amqp1_0, `rabbit_amqp1_0_session_process.erl@v3.13.7` L296-326):
  - `released` → `basic.reject(requeue=true)`.
  - `modified{delivery_failed=true}` → reject with requeue = not undeliverable_here.
  - any **other `modified` → `basic.reject(requeue=false)`**, which is destructive.
  - `rejected` → reject(false).
- **Consumer timeout.** Enforced by the channel (global `consumer_timeout` 1,800,000 ms, `deps/rabbit/Makefile@v3.13.7` L90). It closes the channel with 406.

### 1.2 RabbitMQ 4.0.0 – 4.2.9

The logic is identical at v4.0.0, v4.0.9, v4.1.0, v4.1.8, v4.2.0 and v4.2.9.

**Limit.**
- The default L is **20**: `-define(DEFAULT_DELIVERY_LIMIT, 20)` in rabbit_quorum_queue.erl@v4.0.9 L111 and @v4.2.9 L131.
- A negative value becomes `undefined` (rabbit_fifo.erl `update_config/2`).
- The check is on **AC** (rabbit_fifo.erl@v4.2.9 L1954-1957): `case get_header(acquired_count, Header) of AcquiredCount when AcquiredCount > DeliveryLimit -> rabbit_fifo_dlx:discard([Msg], delivery_limit, DLH, DlxState0)`.
- `incr_msg/3` (L3097-3111) always adds 1 to AC and adds 1 to DC only `when DelFailed`.

**How settle actions map.**
- AMQP 0-9-1: `basic.nack` and `basic.reject` both go through `internal_reject/4` with `Op = case Requeue of false -> discard; true -> requeue end` (rabbit_channel.erl@v4.2.9 L1976-1985). That calls `rabbit_fifo_client:return/3`, which sends `#return{}`, which runs `return(..., IncrDelCount = false, ...)` (rabbit_fifo.erl@v4.2.9 L293-301).
- AMQP 1.0 (rabbit_amqp_session.erl@v4.2.9 L2073-2095): `released` → `requeue`; `rejected` → `discard`; `modified` → `{modify, DelFailed, UndelHere, Anns}`. With `undeliverable_here=true` the message is dead-lettered.

**Where returns go.**
- Returns still pass through the aux machine (rabbit_fifo_client.erl@v4.2.9 L1045-1048).
- With L = `undefined` (`-1`), the aux handler rewrites the full message body into the Raft log as a `#requeue`, so it goes to the TAIL (rabbit_fifo.erl@v4.2.9 L1036-1066). This is documented in the 4.2 docs section "Repeatedly Requeued Deliveries".
- `#modify{}` is pipelined directly and goes to the HEAD.

**Consumer lifecycle.**
- When the consumer process goes down (crash, TCP loss, *graceful* channel or connection close), the path is `cancel_consumer(..., down)` → `maybe_return_all/6` → `return_all(..., Reason == down)`, giving AC+1 and DC+1 (L1596-1613).
- `noconnection` triggers an immediate `return_all(..., true)` (L542, L593).
- `basic.cancel` marks the consumer `cancelled`; its deliveries stay checked out.
- AMQP 1.0 detach uses reason `remove`, which runs `return_all(..., false)` (rabbit_amqp_session.erl@v4.2.9 L1208-1213).

**Consumer timeout.** `evaluate_consumer_timeout/1` in the channel closes the channel with 406 (rabbit_channel.erl@v4.2.9 L2854-2905). Per-queue values come from the `consumer-timeout` policy or the `x-consumer-timeout` argument.

**Official test.** `quorum_queue_SUITE.erl@v4.2.9 subscribe_redelivery_policy`:
- It applies the policy `delivery-limit=1` to an already declared QQ.
- It then calls `basic.nack(requeue=true)` twice.
- It asserts `x-delivery-count = 1` on the redelivery and that the message is then gone.

### 1.3 RabbitMQ 4.3.0 – 4.3.6 (machine v8) and main (v9)

**Limit.** The check is on **DC**. In `return_one/8` (rabbit_fifo.erl@v4.3.6 L2348-2398, identical on main): `case get_header(delivery_count, Header) of DeliveryCount when is_integer(DeliveryCount) andalso DeliveryCount > DeliveryLimit -> discard_or_dead_letter([Msg], delivery_limit, ...)`. `incr_msg_headers/3` (L3884-3899) behaves like `incr_msg/3` in 4.0–4.2.

**AMQP 0-9-1 mapping.** rabbit_channel.erl@v4.3.6; v4.3.0 is the first tag with this code.

| Method | Settle op | Effect |
| --- | --- | --- |
| `basic.nack` requeue=true | `requeue` (L1249-1257) | AC only |
| `basic.nack` requeue=false | `settle(false,true)` = `{modify,false,true,#{}}` | dead-lettered as `rejected`, AC only |
| `basic.reject` requeue=true | `settle(true,false)` = `{modify,true,false,#{}}` (L1527-1534, settle/2 L2314-2316) | AC + DC |
| `basic.reject` requeue=false | `discard` | AC + DC, dead-lettered |

v4.0.9 and v4.1.8 still had `reject(DeliveryTag, Requeue, false, State)`.

**Where returns go.**
- Returns are pipelined directly; the aux path is commented out (rabbit_fifo_client.erl@v4.3.6 L1045-1052).
- They always land in `returns` (HEAD) whatever L is, even unlimited.
- Returned messages lose their priority (docs section "Redelivery of Returned Messages").

**Consumer lifecycle.**
- **Any DOWN** other than `noconnection` runs `return_all(..., true)` (L1954-1972; handle_down L1041-1053). That covers graceful `channel.close` and `connection.close`, because the channel's `terminate/2` (L721-740) and `channel.close` (L1152-1165) send nothing to quorum queues (`notify_queues` only reaches classic pids, L2066-2074). It also covers AMQP 1.0 session end: `terminate/2`, rabbit_amqp_session.erl@v4.3.6 L502-516.
- `noconnection` marks the consumer `suspected_down` and starts the `consumer_disconnected_timeout` timer (60,000 ms; Makefile@v4.3.6 L87). When it fires, `return_all(..., false)` runs (L563-640).
- **Consumer timeout** (now evaluated by the quorum queue):
  - It runs `return_multiple(..., false, ...)` and sends `{released, QName, Tag, MsgIds, timeout}` (L721-794).
  - The channel then sends `basic.cancel` if the client advertises `consumer_cancel_notify`; otherwise it closes the channel with 406 (rabbit_channel.erl@v4.3.6 L2825-2838). `basic.get` deliveries take the close path.
  - AMQP 1.0 clients receive a `released` disposition.
- AMQP 1.0 detach uses reason `remove`, which runs `return_all(..., false)` (rabbit_amqp_session.erl@v4.3.6 L1255-1296).

**Delay.** `should_delay/5` (L2400-2443) checks an explicit `x-opt-delivery-time` in a `modified` outcome first, then the queue's `delayed_retry` setting (all / failed / returned).

**Docs vs code.** The docs table "When is delivery count incremented?" matches the code. Its "Client crash / Connection loss" row should read "any exit of the consuming channel/session/connection process, graceful or not".

**Official test.** `quorum_queue_SUITE.erl@v4.3.6 subscribe_redelivery_policy` was rewritten to use `simulate_consumer_crash` instead of `basic.nack`.

### 1.4 Dead-letter count carry-over (affects the limit only on 4.3+)

- `annotate_msg/2` copies the header's DC (and AC) into message annotations (rabbit_fifo.erl@v4.3.6 L2325-2346). Both dead-letter strategies call it:
  - at-most-once: `discard_or_dead_letter/4` (L4171+, "ensure header delivery count is copied to the message container");
  - at-least-once: `rabbit_fifo_dlx.erl@v4.3.6` L168 and L241.
- `mc:record_death/3` keeps those annotations.
- The target quorum queue seeds its own header from them in `maybe_set_msg_delivery_count/2` (L2032-2044, called from `maybe_enqueue`).
- Publishers cannot inject DC: `mc_amqp:essential_properties/2` ignores the incoming header's delivery-count.
- On 4.0–4.2 the same seeding code exists, but the limit uses AC, which is never carried, so it changes headers only. 3.13 has no such code.
- **Measured (third party, on 4.3.6):** a message abandoned 21 times arrives in the DLQ with x-delivery-count 21, and one basic.get+nack peek drops it. https://dev.to/viktorbaumann/your-quorum-dead-letter-queue-can-drop-the-dead-letters-x-delivery-count-travels-along-240n

### 1.5 Classic queues

- **Position on requeue.** "Messages being requeued are returned to their position in the queue using their SeqId value" (rabbit_variable_queue.erl@v3.13.7 L84, @v4.3.6 L73-74; `requeue_merge` @v4.3.6 L1833-1855).
- **Redelivered.** The flag is set (`is_delivered`).
- **4.3+ failure counter** (feature flag `rabbitmq_4.3.0`, settle_43 in rabbit_classic_queue.erl@v4.3.6 L341-354):
  - It is a per-SeqId map, incremented only for failed returns (`maybe_inc_delivery_count` L1857-1868).
  - It is exposed only as the AMQP 1.0 header delivery-count; mc_amqpl has no 0-9-1 mapping for it.
- **Every requeue** runs `maybe_drop_head/1` and `drop_expired_msgs/1` (rabbit_amqqueue_process.erl@v4.3.6 L929-943).
- **No delivery limit.** `delivery-limit` is listed in `unsupported_policies` and there is no `x-delivery-limit` argument (rabbit_classic_queue.erl@v4.3.6 L641-663).
- **basic.get** checks neither SAC nor priorities (rabbit_amqqueue_process.erl@v4.3.6 L1328-1345).
- **No consumer timeout from 4.3.0** (4.3.0 release notes, "Consumer Timeouts are No Longer Evaluated for Classic Queues and Streams").

### 1.6 Streams

- `basic.get` returns `{protocol_error, not_implemented, "basic.get not supported by stream queues ..."}` (rabbit_stream_queue.erl@v4.3.6 L607-609). 540 is a connection-level error in 0-9-1, so every channel on that connection dies.
- `settle/5`: "all settle reasons will give credit" (L711-723); settling does nothing else.
- For AMQP 1.0, streams use `copy`; quorum and classic queues are `move` only.

### 1.7 Management `/get` and the CLI peek

- `/get` (rabbit_mgmt_wm_queue_get.erl, the same at v3.13.7, v4.0.9, v4.2.9, v4.3.6 and main):
  1. Opens a direct connection and channel as the HTTP user.
  2. Calls `basic.get` Count times. `no_ack` is true only for `ack_requeue_false`.
  3. Holds every message (`basic_gets/6`).
  4. Settles each message separately: `ack_requeue_true` → `basic.nack{multiple=false, requeue=true}`; `reject_requeue_true` / `reject_requeue_false` → `basic.reject{requeue=...}`.
  5. Closes the channel and connection in an `after` clause (rabbit_mgmt_util.erl@v4.3.6 L1038-1075).

  Count has no cap. The UI form defaults to the ackmode "Nack message requeue true", count 1 and truncate 50000.
- `rabbitmq-queues peek`:
  - It calls `rabbit_quorum_queue:peek/2`, which runs `ra:aux_command(Leader, {peek, Pos})`, then `query_peek/2` on a state copy and `ra_aux:log_fetch`. Nothing is written to the Raft log.
  - It returns one ready message per call at a 1-based position.
  - Its `x-delivery-count` is DC.
  - Classic queues get "Cannot peek into a classic queue".
  - It needs Erlang-distribution access to a node.
- The HTTP API has no peek route (`rabbit_mgmt_dispatcher.erl` L155-159), and neither does the AMQP 1.0 management API.

## 2. (a) Version × settle-action matrix

Each cell reads: counters changed · counts toward L? · redelivered on next delivery · position after the return.

### 2.1 Quorum queues

| # | Action | 3.13.x | 4.0 – 4.2.x | 4.3.0 – 4.3.6 | main (4.4-dev) |
| --- | --- | --- | --- | --- | --- |
| 1 | basic.get + basic.nack(requeue=true) | DC+1 · counts only if L set (no default) · yes · **TAIL if no L (default)**, HEAD if L set | AC+1 (shown as x-delivery-count) · **counts** (AC>L ⇒ DLX/drop; default L=20) · yes · HEAD; **TAIL if L=-1** | AC+1 (x-acquired-count) · **no**, unless DC is already >L, in which case DLX/drop now · yes · HEAD (priority ignored); DELAYED if delayed-retry all/returned | = 4.3 |
| 2 | basic.get + basic.reject(requeue=true) | = row 1 | = row 1 (same `requeue` op) | AC+1, DC+1 · **counts** · yes · HEAD; DELAYED if all/failed | = 4.3 |
| 3 | consume + basic.nack(requeue) (multiple=true ok) | = row 1 | = row 1 | = row 1 | = 4.3 |
| 4 | consume + basic.reject(requeue) | = row 2 | = row 2 | = row 2 | = 4.3 |
| 5 | AMQP 1.0 `released` | plugin → basic.reject(requeue=true) = row 1 | `requeue` = row 1 (TAIL if L=-1) | = row 1 | = 4.3 |
| 6 | `modified` delivery-failed=false, undeliverable-here=false | plugin → basic.reject(requeue=**false**) ⇒ **DLX/drop (destructive)** | AC+1 · counts · yes · HEAD (even when L=-1); annotations merged into the message | AC+1 · no (unless DC>L) · yes · HEAD; DELAYED if all/returned, or until `x-opt-delivery-time` if annotated | = 4.3 |
| 7 | `modified` delivery-failed=true, undeliverable-here=false | plugin → reject(requeue=true) = row 1 | AC+1, DC+1 · counts · yes · HEAD | AC+1, DC+1 · counts · yes · HEAD; DELAYED if all/failed | = 4.3 |
| 8 | `rejected` (or `modified` undeliverable-here=true) | reject(requeue=false) ⇒ DLX `rejected`/drop | discard: AC+1, DC+1 ⇒ DLX/drop | same; DC is carried into a QQ DLQ (§1.4) | = 4.3 |
| 9 | Graceful `channel.close` while holding unacked | DOWN → DC+1 · counts if L · yes · HEAD | DOWN → AC+1, DC+1 · counts · yes · HEAD | DOWN → AC+1, DC+1 (a **failed** delivery) · **counts** · yes · HEAD; DELAYED if all/failed | = 4.3 |
| 10 | `connection.close` while holding unacked (also AMQP 1.0 session end or close) | = row 9 | = row 9 | = row 9 | = 4.3 |
| 11 | TCP drop or client crash | = row 9 once the broker notices (socket error or heartbeat timeout, default 60 s); messages are unavailable until then | = row 9 (same delay) | = row 9 (same delay) | = 4.3 |
| 11b | Intra-cluster partition (`noconnection` between the channel's node and the leader) | immediate return, DC+1 | immediate return, AC+1, DC+1 (counts) | consumer `suspected_down`; after `consumer_disconnected_timeout` (60 s), AC+1 only (does not count) | = 4.3 |
| 12 | basic.cancel, then close | cancel alone returns nothing (deliveries can still be acked or nacked); the close = row 9 | same | same | same |
| 12b | AMQP 1.0 detach with unsettled deliveries | n/a | `remove` → AC+1 · counts · HEAD | `remove` → AC+1 · no · HEAD | = 4.3 |
| 13 | Consumer timeout | channel-level (1,800,000 ms global; per-queue arg/policy since 3.12; checked about every 60 s) → 406 close → row 9 | same → row 9 (counts) | quorum-queue level: AC+1 only · **no** · HEAD/DELAYED (all, returned). Then basic.cancel (client advertises consumer_cancel_notify, as amqplib 2.2.0 does) or a 406 close; basic.get deliveries always get the 406 close; AMQP 1.0 gets `released` | = 4.3, plus `consumer_timeout_response = notify_consumer` (default) or `close_channel` |
| 14 | HTTP `/get` ack_requeue_true | N×basic.get held, then N×basic.nack(requeue=true, multiple=false): per message = row 1 (**TAIL by default**) | per message = row 1 (**counts**) | per message = row 1 (does not count; DLQ caveat) | = 4.3 |
| 15 | HTTP `/get` reject_requeue_true | = row 2 | = row 2 (counts) | = row 2 (**counts**) | = 4.3 |
| 16 | HTTP `/get` reject_requeue_false / ack_requeue_false | DLX/drop / removed | DLX/drop (AC+1, DC+1) / removed | same | same |

Notes:
- If the HTTP handler dies before it nacks, the held messages follow row 9.
- On 4.0–4.2 with L=-1, each nack re-appends the whole message body to the Raft log, which costs disk and replication.

### 2.2 Classic queues (no delivery limit in any version)

| Action | 3.13.x | 4.0 – 4.2.x | 4.3.x / main |
| --- | --- | --- | --- |
| nack(requeue) / released / basic.recover(requeue=true) | ORIG · redelivered · no counters | same | same; no counter change |
| reject(requeue) / modified(df=true) | ORIG · redelivered | same | ORIG · redelivered · CQ failure counter +1 (AMQP 1.0 delivery-count only) |
| modified(df=false) | plugin → reject(requeue=false) ⇒ **DLX/drop** | ORIG | ORIG |
| rejected / modified(uh=true) / nack(false) / reject(false) | DLX `rejected`/drop | same | same |
| channel or connection close, TCP drop, cancel+close | ORIG · redelivered | same | ORIG · counter +1 |
| AMQP 1.0 detach | n/a | ORIG | ORIG · counter +1 |
| Consumer timeout | channel-level 30 min → close → ORIG | same | **none**: messages stay held until settled or the connection ends |
| After any requeue | drop-head and TTL expiry run immediately: returned messages at the head can be dropped or dead-lettered (`maxlen`/`expired`) | same | same |
| basic.get | ignores SAC and consumer priority; resets the `x-expires` idle timer | same | same |

### 2.3 Streams (3.13+)

- basic.get gives 540 NOT_IMPLEMENTED, which closes the connection.
- Settling only grants credit.
- Reading never changes the stream. The only exceptions are optional server-side offset storage and the SAC group, both for *named* stream-protocol consumers.

## 3. (b) Verdicts in brief (details in `verdicts`)

| Claim | Verdict | One-line correction |
| --- | --- | --- |
| C1 | confirmed | 4.0–4.2 check AC (every return); x-delivery-count = AC; the conflicting claim is true only on 4.3+. Upgraded 3.13 queues can still be unlimited; L=-1 sends returns to the TAIL. |
| C2 | confirmed | Correct for 4.3+/main, and graceful channel/connection close also counts as failed. basic.cancel returns nothing. Detach and partition count AC only. Consumer timeout counts only on ≤4.2. |
| C3 | nuanced | True on 4.3+/main (both DLX strategies, every return type); false on 4.0–4.2 and 3.13. Safe if the DLQ's L is -1 or ≥ max source L + 1, or the DLQ is a CQ or stream. |
| C4 | confirmed | ack_requeue_true = basic.nack (one call per message, after all gets); there is no cap; #13060 is an unconfirmed OOM report. |
| C5 | confirmed | Only rabbitmq-queues peek (QQ, ready messages only, Erlang access) is side-effect-free; no HTTP or AMQP route exists. |
| C6 | nuanced | Policy changes already reached existing queues on 4.0–4.2. #16035/#16036 (in the 4.3.0 and 4.4.0 notes) only touch tick reconciliation and are neutralised by an `orelse` guard. The timeout default is 30 min everywhere; on 4.3+ only QQs enforce it; `undefined` no longer disables it. |
| C7 | confirmed | CQ: ORIG + redelivered, no limit. QQ-SAC refuses basic.get with 405; CQ-SAC lets basic.get bypass SAC. A browsing consumer can become the active one. Exclusive queues return 405 to other connections. |
| C8 | confirmed | `x-delayed-retry-type` = all or returned delays nack-peeks by ≥ `x-delayed-retry-min`; delayed messages are hidden from consumers, get and the CLI peek. |
| Queue Studio | nuanced | HTTP `/get` with ack_requeue_true, N ≤ 5,000. Free only on 4.3+, and even there over-limit messages are dropped. False on 4.0–4.2. |

## 4. (c) Safe-peek algorithm

### 4.1 Work out which semantics apply, per cluster and conservatively

```
nodes = GET /api/nodes   (or connection.start server-properties per node)
ff    = GET /api/feature-flags
era =  '3.13'  if any node < 4.0.0
       '4.0'   if any node < 4.3.0 or ff['rabbitmq_4.3.0'] != enabled
               (in a mixed 4.2/4.3 cluster, QQs keep the machine v7 rules)
       '4.3'   otherwise ('4.4' when all nodes >= 4.4.0)
```

Opt-in canary (team server): declare a throwaway QQ, publish one message, then get+nack twice. Machine v8+ shows `x-acquired-count: 2` and no `x-delivery-count`; v7 shows `x-delivery-count: 2`.

### 4.2 Preflight checks (HTTP API only, no messages touched)

| Check | Source | Effect on the plan |
| --- | --- | --- |
| Queue type | `GET /api/queues/{vh}/{q}` `.type` | Selects the plan (§4.3). |
| Exclusive and owner | `.exclusive`, `.owner_pid_details` | Another connection owns it → **refuse** (405 RESOURCE_LOCKED). |
| auto_delete | `.auto_delete` | Use basic.get only; **never** consume. |
| Effective delivery limit L (QQ) | `.delivery_limit` (tick-published machine state, `unlimited` or an integer; 4.0+). Cross-check against the computed value: arg `x-delivery-limit`, user policy and operator policy merged with `merge_policy_value` (both non-negative → min; one negative → max) then `resolve_delivery_limit` (same rule against the argument); missing → 20 on 4.0+, unlimited on 3.13. | Trust the stat. If the computed value differs, warn W-UPGRADED. |
| DLX configuration | arg `x-dead-letter-exchange` or policy `dead-letter-exchange`, `dead-letter-strategy` | Decides the wording: dead-lettered vs deleted. |
| DLQ topology | All queues whose DLX (plus `x-dead-letter-routing-key`) routes into this queue, using the routing simulator | 4.3+, this queue is a QQ, L is finite, and L < max(L_src)+1 for any QQ source → **W-OVERLIMIT, block by default**. |
| Delayed retry (4.3+) | `.delayed_retry`, `.messages_delayed`, `.next_delayed_at`; arguments and policies | type all/returned → W-DELAY (confirm). Delayed messages cannot be peeked. |
| Consumer timeout | arg `x-consumer-timeout`, policy `consumer-timeout`; the global value is not visible over HTTP, so assume 30 min (24 h fallback from 4.3.3) | Caps the hold time. |
| Length limit and overflow | `x-max-length`, `x-max-length-bytes`, `x-overflow` and policies vs `.messages_ready`, `.message_bytes_ready` | drop-head (the default) and ready + n ≥ 90 % of the limit → W-DROPHEAD (confirm). |
| TTL | `x-message-ttl` or policy `message-ttl` | W-TTL; hold time ≤ TTL/4. |
| SAC and consumers | arg `x-single-active-consumer`, `.single_active_consumer_tag`, `.consumers`, `consumer_details[].arguments.x-priority` | See §4.3. W-HOLD if any consumers exist. |
| Size | `.message_bytes_ready / .messages_ready` | Choose n so the byte cap holds. |
| QQ health | `.leader`, `.members`, `.online` | Need a quorum and a leader, or gets time out. |

### 4.3 Plan by queue type and era

| Type / era | Method | Settle | Max hold | Caps (default / max) | Gates |
| --- | --- | --- | --- | --- | --- |
| Classic, all versions | AMQP 0-9-1 `basic.get` ×n (no_ack=false) on a dedicated connection. Never consume on auto-delete queues. | `basic.nack(lastTag, multiple=true, requeue=true)`, then a `basic.qos` barrier, then close | Target ≤ 5 s; abort at min(30 s, TTL/4; on ≤4.2 also consumer_timeout − 90 s). On 4.3+ there is no server timeout, so a client watchdog is mandatory. | 20 / 500 messages; 16 MiB | Exclusive → refuse. W-SAC-CQ if SAC has an active consumer. W-DROPHEAD, W-TTL, W-HOLD. |
| Quorum, 3.13 | basic.get ×n; if SAC, consume only when no consumer is active | basic.nack (reject is equivalent; both add DC+1) | < channel consumer timeout | 20 / 50 | Always confirm: W-313. W-TAIL when there is no limit. Post-acquire guard: x-delivery-count ≥ L. |
| Quorum, 4.0–4.2 | Same as 3.13. AMQP 1.0 `released` is equivalent but cannot see AC, so prefer 0-9-1, where x-delivery-count = AC. | basic.nack (reject equivalent; **both count**) | < channel consumer timeout; a crash adds AC+DC | 20 / 50 (200 for admins) | **Always confirm W-BUDGET**. W-TAIL when L=-1. Post-acquire guard: x-delivery-count (=AC) ≥ L. Optional admin "protect" mode (§4.5 C). |
| Quorum, 4.3+ / main | Non-SAC: basic.get ×n. SAC: consume only when no consumer is active, with consumer argument `x-consumer-timeout` = the abort budget. Alternative: AMQP 1.0 receiver + `released`, or a detach, which returns everything with AC only. | `basic.nack(requeue=true)` / `released`. **Never** basic.reject, modified(df=true), rejected, or closing while holding deliveries. | ≤ min(30 s, effective QQ consumer timeout/4, TTL/4) | 20 / 500; 16 MiB | **W-OVERLIMIT blocks** unless the DLQ's L is raised first. W-DELAY. Post-acquire guard: x-delivery-count > L. W-CRASH info. |
| Stream, 3.13+ | 0-9-1 `basic.consume` with `x-stream-offset` (first/last/next/offset/timestamp/interval), prefetch ≤ 1000, ack each message; **or** an AMQP 1.0 receiver with a `rabbitmq:stream-offset-spec` filter (property filters from 4.1, SQL filters from 4.2); **or** an anonymous stream-protocol consumer (no name, no `storeOffset`, no `singleActive`). Never basic.get. | ack/accept (only grants credit), then cancel or detach | n/a | by count and bytes; prefer timestamp offsets on huge streams | Info only (W-STREAM). |
| HTTP-only fallback (no AMQP route) | `POST /get` with `ackmode=ack_requeue_true` only, `count ≤ 50`, `truncate` | done by the server | duration of the request; set the HTTP client timeout above the server work | 20 / 50 | The same gates. Never expose `reject_*` or `ack_requeue_false` in read flows. |

### 4.4 Execution protocol (engine, TypeScript-like)

```
async function peek(q, n):
  plan = preflight(q)                       // §4.2–4.3; may BLOCK or require consent
  conn = await openDedicatedConnection({heartbeat: 30})
                                            // never shared, never publishes
  ch = await conn.createChannel()
  deadline = now() + plan.maxHoldMs
  watchdog(deadline - 2000, () => flushAndClose(ch, conn))
                                            // flush = nack(all) + barrier + close
  copies = []
  for i in 1..min(n, plan.cap):
    m = await ch.get(q.name, {noAck: false}) // QQ: one synchronous Raft command
    if (!m) break
    guard(m, plan)                          // §4.5; may stop acquiring
    copies.push(snapshot(m))
    if (bytes(copies) > plan.maxBytes || now() > deadline - 2000) break
  ch.nack(lastDeliveredTag, /*allUpTo*/ true, /*requeue*/ true)
                                            // one frame; never reject
  await ch.prefetch(plan.prefetch)          // basic.qos is synchronous: the channel has processed the nack
  await ch.close(); await conn.close()
  return receipt(copies, era, deltas)       // AC/DC deltas per message, hold time, warnings shown
```

Further rules for the engine:
- **Separate connections.** Run "rescue" or replay publishes on a different connection. A connection that publishes can be blocked by a memory alarm, and then its nacks cannot be read either.
- **Lifecycle hooks.** On Electron `before-quit`, `powerMonitor 'suspend'`, team-server `SIGTERM` and job cancellation, run flush (nack + barrier) before closing anything.
- **No risky methods on a holding channel.** Never issue passive declares (403 on 4.3.0 for read-only users), stream gets (540) or other calls that can fail on a channel or connection that holds deliveries.
- **Locking.** Allow one peek per queue at a time; the team server holds a cluster-wide lock per queue.

### 4.5 Post-acquire guard and rescue

**When a fetched message is doomed.** Returning it would dead-letter or drop it if:
- 4.3+: `x-delivery-count` > L;
- 4.0–4.2: `x-delivery-count` (= AC) ≥ L;
- 3.13 with a limit: `x-delivery-count` ≥ L.

**What to do.** The user chooses in the consent dialog before the peek starts:

| Option | What happens | Notes |
| --- | --- | --- |
| A. Let RabbitMQ handle it | nack; the message is dead-lettered or deleted | Forbidden for unattended or AI runs. |
| B. Rescue | Publish a copy with publisher confirms, on a separate connection, to a tool-managed quarantine queue (classic, durable), then ack the original | — |
| C. Raise limit, then return (admin) | Write a policy that raises `delivery-limit`; wait until the `.delivery_limit` stat shows the new value; then nack | Impossible if the queue argument or an operator policy caps L (min rule). Only one policy applies, so clone the effective definition. On 4.0–4.2 use a **finite** value, because -1 sends returns to the TAIL. |

**Default.** Stop acquiring as soon as a doomed message appears. Apply B only if it was authorised in advance; otherwise refuse at preflight whenever W-OVERLIMIT or W-BUDGET-EDGE is likely.

### 4.6 Caps (recommended)

- **Count:** default 20 per peek; UI maximum 500 (CQ, QQ on 4.3+) or 50 (QQ on 3.13 / 4.0–4.2); engine hard cap 1,000.
- **Size:** 16 MiB of payload per peek; show 256 KiB per message, with on-demand full load, which is itself another peek.
- **Hold time:** target ≤ 5 s, hard abort at 30 s, and lower when consumer-timeout or TTL is lower.
- **Repeat peeks:** on QQ 3.13 or 4.0–4.2, every peek re-asks for consent; there is no auto-refresh.

### 4.7 User-facing warnings (exact text)

- **W-BUDGET (QQ 4.0–4.2):** "RabbitMQ {v} counts every return of a quorum-queue message against its delivery limit ({L}). Peeking uses 1 of each message's {L} delivery attempts. Messages that have already used {L} will be {dead-lettered to '{dlx}' | permanently deleted} by this peek."
- **W-313 (QQ 3.13):** "On RabbitMQ 3.13 every peek increases x-delivery-count. {This queue has a delivery limit of {L}: messages at {L} will be dead-lettered or deleted. | This queue has no delivery limit.}"
- **W-TAIL (3.13 without a limit / 4.0–4.2 with L = -1):** "This quorum queue has no delivery limit, so RabbitMQ {v} puts returned messages at the back: peeking moves these {n} messages behind {ready−n} others."
- **W-OVERLIMIT (QQ 4.3+):** "This queue receives dead-lettered messages from {sources}. Its delivery limit ({L}) is not higher than theirs, so messages that died for exceeding a delivery limit arrive with a count above {L}. RabbitMQ {deletes | dead-letters again} such messages on ANY return, including this peek. Set delivery-limit to -1 (or at least {max+1}) on this queue first."
- **W-DELAY (4.3+):** "Delayed retry is on ({type}, min {min} ms, max {max} ms). Messages returned by this peek are held back for at least {min} ms; consumers will not receive them during that time."
- **W-REDELIVERED (always, CQ and QQ):** "Peeked messages will reach their next consumer with redelivered=true{; x-acquired-count +1}."
- **W-HOLD:** "For up to {hold} s these messages are unavailable to consumers, which may process later messages first."
- **W-DROPHEAD:** "This queue is near its length limit ({ready}/{max}, overflow=drop-head). While the peek holds messages they don't count toward the limit; if publishers fill the gap, RabbitMQ will {delete | dead-letter (maxlen)} the oldest messages when the peek returns them, starting with the peeked ones."
- **W-TTL:** "Messages expire after {ttl}. Any message whose TTL passes during the peek will be {dead-lettered (expired) | deleted} when it is returned."
- **W-SAC-CQ:** "Single active consumer is on. basic.get bypasses it: the active consumer may process later messages before the peeked ones are returned, breaking strict ordering."
- **W-SAC-QQ:** "RabbitMQ refuses basic.get on quorum queues with single active consumer. Peeking registers a consumer that will be the active one while it runs; real consumers wait until it ends." Allowed only when no consumer is active.
- **W-EXCLUSIVE:** "This exclusive queue belongs to another connection; RabbitMQ does not allow reading it."
- **W-CRASH (4.3+, info):** "If this tool's connection breaks before the messages are returned, RabbitMQ counts it as a failed delivery (x-delivery-count +1) for every held message."
- **W-UPGRADED:** "RabbitMQ reports delivery limit '{stat}' for this queue, but its arguments and policies imply {computed}. The queue was probably created before 4.0, and any policy change that matches it will apply {computed}."
- **W-MIXED:** "Cluster nodes run different versions ({list}); quorum queues keep the older rules until every node is upgraded. Using {era} rules."
- **W-STREAM (info):** "Reading a stream does not remove or change messages."

## 5. (d) What the product can honestly claim

| Claim | Allowed? | Conditions |
| --- | --- | --- |
| "Non-destructive / read-only peek" for classic or quorum queues | **No** | Every AMQP or HTTP read sets redelivered, changes counters or order, and holds messages. |
| "Non-destructive stream browsing" | Yes | Anonymous readers only. |
| "Zero-side-effect quorum peek" | Yes, only through the optional node agent using `rabbitmq-queues peek` | Ready messages only; not on managed services or desktop without CLI access. |
| "Side-effect-aware, version-aware peek" | **Yes (headline)** | Show the side-effect receipt before and after each peek. |
| "Peeking does not use up the delivery limit" | Only for QQs on RabbitMQ ≥ 4.3 | Must add: "except messages already over their limit, which RabbitMQ deletes on any return; we check for this first". |
| "Never drops messages" | No | 4.3 over-limit arrivals, 4.0–4.2 budget edge, drop-head and TTL. |
| "Messages stay in the queue" | Yes | Qualified with the hazards in §4.7. |
| "Safer than the management UI's Get messages" | Yes | Nack only, short holds, preflight, caps and a receipt. |

## 6. Other findings worth acting on

1. **canonicalize_delivery_limit bug** (v4.3.0–v4.3.6 and main). The guard `is_integer(Value) orelse Value < 0` canonicalises every integer to `undefined`, so the tick-based reconciliation never notices delivery-limit drift. Event-driven policy changes still work. Worth filing upstream.
2. **4.3.0–4.3.2:** setting `{consumer_timeout, undefined}` fails the strict assertion `true = is_integer(MS)` in `rabbit_queue_type:get_consumer_timeout/2`, which can fail consumes and gets. From 4.3.3 it falls back to 24 h. The consumers doc still says `undefined` disables the timeout.
3. **Shovels on 4.3.0–4.3.6** return messages that the destination rejects as non-failed returns, which loops forever because nacks are free. The fix is in 4.3.7 (#17794), which is not tagged yet. This matters for move and replay features.
4. **Local shovels (4.2+)** forward the `mc` container with its annotations (`rabbit_local_shovel.erl@v4.3.6 set_annotations`). That probably carries DC into the destination QQ. AMQP 0-9-1 republishing (the management UI's "Move messages" uses `amqp:///`) gives a fresh count. Needs testing.
5. **Competitors.** Warren ("RabbitMQ 4 no longer counts a message put back on purpose"), Queue Studio ("never counts") are all wrong for at least one supported era. Getting all eras right is a credible differentiator.
6. **Hard-error coupling.** basic.get on a stream (540) or any other hard error kills every channel on the same connection. On 4.3, the quorum-queue deliveries held there turn into failed deliveries. Peeks need their own connection.

## Design implications

- Ship a data-driven semantics registry keyed by era (3.13 / 4.0-4.2 / 4.3+ / 4.4) x queue type x settle action (the matrix above). Drive every peek warning, button label, receipt and MCP/AI tool contract from it, and cover each cell with Testcontainers conformance tests against rabbitmq 3.13.7, 4.0.9, 4.1.8, 4.2.9, 4.3.6 and 4.4.x images.
- Resolve semantics per cluster, conservatively: the lowest node version plus the rabbitmq_4.3.0 feature flag. Treat mixed 4.2/4.3 clusters with 4.0-4.2 rules, because quorum queues keep machine v7 behaviour until every node is upgraded.
- The peek engine settles only with basic.nack(requeue=true) (amqplib channel.nack) or AMQP 1.0 released (rabbitmq-amqp-js-client requeue() without annotations). It must never use basic.reject, modified(df=true), rejected or discard(), never close while holding deliveries, and never offer HTTP reject_* or ack_requeue_false in read flows.
- Make peek a short, atomic, server-side job (acquire, copy, return within seconds) running in the Node engine (Electron utilityProcess or team server). The Angular UI only ever renders copies; deliveries never stay unacked across user think-time, HTTP requests or route changes.
- Use one dedicated AMQP connection per peek job that never publishes and runs nothing else. Then a hard error elsewhere (for example 540 from a stream basic.get), a memory-alarm block, or a 4.3.0 passive-declare 403 cannot turn held deliveries into failed deliveries.
- After a nack, send a synchronous basic.qos as a barrier before closing. Wire Electron before-quit, powerMonitor suspend and team-server SIGTERM to flush nacks first. Use a heartbeat of about 30 s and a client-side watchdog that aborts the hold, which is mandatory for classic queues on 4.3+ because they have no server timeout.
- Read a quorum queue's real delivery limit from the GET /api/queues 'delivery_limit' stat (machine state, 'unlimited' or an integer) instead of computing it, and surface any mismatch with arguments and policies, such as 3.13-era queues that are still unlimited. Warn in the policy editor that any matching policy change applies the effective limit (default 20) to such queues.
- Make DLQ topology analysis a prerequisite of peeking. On 4.3+, block peeks of quorum DLQs whose finite limit is not above every source's limit + 1. Offer a one-click fix (policy delivery-limit -1) and a linter rule ('dead letters at risk of deletion on first look').
- On 4.0-4.2 quorum queues, always ask for budget consent showing L and each message's attempts used after the peek. Use lower caps, no auto-refresh, and a post-acquire guard: if AC >= L, stop and rescue (copy to quarantine with publisher confirms, then ack) or let RabbitMQ handle it, per prior consent.
- Delayed-retry awareness (4.3+): read delayed_retry, messages_delayed and next_delayed_at, warn that nack-peeks hide messages for at least the minimum delay when the type is all or returned, and list delayed and scheduled (4.4) messages as not peekable.
- Run length-limit and TTL hazard checks before every classic or quorum peek. Returned messages sit at the head and are the first dropped by drop-head; messages whose TTL expires during the hold are dead-lettered or deleted on return. Size n and the hold time from the headroom and the TTL.
- Gate on SAC, exclusive and auto-delete:
- quorum queue with SAC: basic.get gives 405 and closes the channel, so peek with a consumer only when no consumer is active;
- classic queue with SAC: warn that basic.get breaks ordering;
- auto-delete queue: never use a consumer, always basic.get;
- exclusive queue owned by another connection: refuse.
- Build the stream browser as the flagship non-destructive path. Use anonymous readers only: no stream-protocol consumer names, no storeOffset, no singleActive. Use the x-stream-offset / AMQP 1.0 offset spec and filters (property filters 4.1+, SQL filters 4.2+), and never call basic.get on a stream.
- Offer an optional node agent (team-server sidecar with rabbitmq-queues CLI access) as a truly read-only quorum peek for ready messages, with positional paging limited to small N. Label it explicitly. It cannot be the default because it is unavailable on managed services and to desktop users.
- Implement an HTTP-only fallback that uses ack_requeue_true only, count <= 50 and truncate, with the same preflight. Set the client HTTP timeout above the server's work, because aborting a request can kill the handler and on 4.3 that counts as failed deliveries for the held messages (unverified).
- In the DLQ operations centre, replays should republish over AMQP 0-9-1/1.0 with publisher confirms, which gives fresh counters, and should avoid local shovels until counter carry-over has been tested. Deprioritise shovel-based moves on 4.3.0-4.3.6 (the reject-loop regression is fixed in 4.3.7).
- Produce a side-effect receipt for every peek: era, method, counters touched per message (AC/DC deltas), positions and hold time. Log it to the team-server audit trail and return it from MCP tools; AI agents need human approval whenever a gated hazard is present.
- Use honest wording everywhere: 'side-effect-aware peek' and 'messages stay in the queue', never 'non-destructive' or 'read-only' for classic or quorum queues. Reserve 'non-destructive' for stream browsing and the agent-based quorum peek. Advertise version-correct handling of 4.0-4.2 as a differentiator over Warren, Queue Studio.

## Open questions

- Empirically validate every matrix cell on real brokers (3.13.7, 4.0.9, 4.1.8, 4.2.9, 4.3.6 and 4.4.0 GA). Priorities: graceful channel.close and connection.close counting as a failed delivery on 4.3; tail placement on 3.13 (no limit) and on 4.0-4.2 (L=-1); 4.0-4.2 x-delivery-count equal to acquired_count.
- Can the effective quorum-queue machine version be observed over the HTTP API, for example via member or overview data? If not, is an opt-in canary quorum queue acceptable for team servers to detect v7 vs v8 semantics in mixed clusters?
- Does a local shovel (4.2+) carry the delivery_count annotation into a destination quorum queue, so that replaying DLQ messages with one would keep their exhausted budget? The code suggests it does.
- When a client or proxy aborts an HTTP POST /get mid-request, does cowboy kill the handler process and therefore close the direct channel while it holds messages? On 4.3 that would increment x-delivery-count for each of them.
- Under Raft leader changes, can the DOWN signal from a closing channel overtake a basic.nack the channel pipelined just before it, so that peeked messages count as failed even with the nack-then-close protocol?
- Confirm the canonicalize_delivery_limit 'orelse' bug in practice: the tick reconciliation ignores delivery-limit drift on 4.3.x and main. Also check whether 3.13-era quorum queues upgraded to 4.x stay 'unlimited' until a policy event, and whether the management delivery_limit stat reflects that.
- Confirm that consumer_timeout = undefined breaks consume and basic.get on 4.3.0-4.3.2 for all queue types (strict assertion), and that 4.3.3+ falls back to 24 h. Check whether the docs will be corrected.
- On managed offerings (Amazon MQ, CloudAMQP, Tanzu), which versions and feature flags are deployed, and does any expose rabbitmq-queues peek or a browse API, such as the Tanzu 4.3 JMS queue browsers?
- How should the UI present x-acquired-count for messages that arrived by dead-lettering? The v3-compat clause sets AC to the carried DC, which can look like local acquisitions.
- Re-run the code checks at the v4.4.0 tag once released: machine v9 deferral claims, delayed publish, and consumer_timeout_response.
- amqplib 2.2.x behaviour after a server-initiated basic.cancel (4.3 consumer timeout): are nacks of already-released delivery tags harmless? And does rhea's release() always send 'released' rather than 'modified' in rabbitmq-amqp-js-client 1.0.0?
- For classic queues whose head is paged to disk (delta), is the requeue position exactly the original SeqId, and how does a priority classic queue order requeued messages?

## Sources

- https://api.github.com/repos/rabbitmq/rabbitmq-server/tags?per_page=100
- https://api.github.com/repos/rabbitmq/rabbitmq-server/commits/main
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v3.13.7/deps/rabbit/src/rabbit_fifo.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v3.13.7/deps/rabbit/src/rabbit_fifo_client.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v3.13.7/deps/rabbit/src/rabbit_quorum_queue.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v3.13.7/deps/rabbitmq_amqp1_0/src/rabbit_amqp1_0_session_process.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v3.13.7/deps/rabbit/src/rabbit_variable_queue.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v3.13.7/deps/rabbit/Makefile
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v3.13.7/deps/rabbitmq_management/src/rabbit_mgmt_wm_queue_get.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v3.13.7/deps/rabbitmq_cli/lib/rabbitmq/cli/queues/commands/peek_command.ex
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.0.0/deps/rabbit/src/rabbit_fifo.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.0.0/deps/rabbit/src/rabbit_fifo_client.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.0.9/deps/rabbit/src/rabbit_fifo.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.0.9/deps/rabbit/src/rabbit_fifo_client.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.0.9/deps/rabbit/src/rabbit_quorum_queue.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.0.9/deps/rabbit/src/rabbit_channel.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.0.9/deps/rabbit/src/rabbit_amqp_session.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.0.9/deps/rabbitmq_management/src/rabbit_mgmt_wm_queue_get.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.0.9/deps/rabbitmq_management/priv/www/js/tmpl/queue.ejs
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.1.0/deps/rabbit/src/rabbit_fifo.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.1.8/deps/rabbit/src/rabbit_fifo.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.1.8/deps/rabbit/src/rabbit_fifo_client.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.1.8/deps/rabbit/src/rabbit_channel.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.0/deps/rabbit/src/rabbit_fifo.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.9/deps/rabbit/src/rabbit_fifo.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.9/deps/rabbit/src/rabbit_fifo_client.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.9/deps/rabbit/src/rabbit_quorum_queue.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.9/deps/rabbit/src/rabbit_channel.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.9/deps/rabbit/src/rabbit_amqp_session.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.9/deps/rabbit/src/rabbit_amqqueue.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.9/deps/rabbit/src/rabbit_policy.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.9/deps/rabbit/src/rabbit_queue_type.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.9/deps/rabbit/src/rabbit_policies.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.9/deps/rabbit/src/rabbit_queue_type_util.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.9/deps/rabbit/src/mc_amqp.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.9/deps/rabbit/src/rabbit_variable_queue.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.9/deps/rabbit/src/rabbit_amqqueue_process.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.9/deps/rabbit/test/quorum_queue_SUITE.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.9/deps/rabbit/Makefile
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.9/deps/rabbitmq_management/src/rabbit_mgmt_wm_queue_get.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.9/deps/rabbitmq_management/src/rabbit_mgmt_dispatcher.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.9/deps/rabbitmq_management/priv/www/js/tmpl/quorum-queue-stats.ejs
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.0/deps/rabbit/src/rabbit_fifo.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.0/deps/rabbit/src/rabbit_channel.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.0/deps/rabbit/src/rabbit_quorum_queue.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.0/deps/rabbit/src/rabbit_queue_type.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.1/deps/rabbit/src/rabbit_channel.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.2/deps/rabbit/src/rabbit_queue_type.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.3/deps/rabbit/src/rabbit_queue_type.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_fifo.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_fifo_client.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_quorum_queue.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_channel.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_amqp_session.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_queue_type.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_queue_type_util.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_policies.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_amqqueue.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_dead_letter.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_fifo_dlx.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_fifo_dlx_worker.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/mc.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/mc_amqp.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/mc_amqpl.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_classic_queue.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_variable_queue.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_amqqueue_process.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_queue_consumers.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_stream_queue.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_core_ff.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/Makefile
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/test/quorum_queue_SUITE.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_shovel/src/rabbit_local_shovel.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_cli/lib/rabbitmq/cli/queues/commands/peek_command.ex
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/src/rabbit_mgmt_wm_queue_get.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/src/rabbit_mgmt_dispatcher.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/src/rabbit_mgmt_util.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/priv/www/js/tmpl/classic-queue-get-message.ejs
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/priv/www/js/tmpl/quorum-queue-stats.ejs
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/priv/www/js/tmpl/queue.ejs
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/priv/www/js/global.js
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/priv/www/js/main.js
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/priv/www/js/dispatcher.js
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_amqp_management.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbit/src/rabbit_fifo.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbit/src/rabbit_channel.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbit/src/rabbit_quorum_queue.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbit/src/rabbit_amqqueue.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbit/src/rabbit_queue_type.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbit/src/rabbit_amqqueue_process.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbit/src/rabbit_amqp_management.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbit/priv/schema/rabbit.schema
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbit/Makefile
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/src/rabbit_mgmt_wm_queue_get.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/src/rabbit_mgmt_dispatcher.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/src/rabbit_mgmt_wm_queue_actions.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_cli/lib/rabbitmq/cli/queues/commands/peek_command.ex
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.0.1.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.1.0.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.2.0.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.3.0.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.3.1.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.3.2.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.3.3.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.3.7.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.4.0.md
- https://github.com/rabbitmq/rabbitmq-server/pull/16035
- https://patch-diff.githubusercontent.com/raw/rabbitmq/rabbitmq-server/pull/16035.diff
- https://github.com/rabbitmq/rabbitmq-server/pull/16036
- https://github.com/rabbitmq/rabbitmq-server/discussions/13060
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/quorum-queues/index.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/versioned_docs/version-4.2/quorum-queues/index.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/consumers.md
- https://www.rabbitmq.com/docs/quorum-queues
- https://dev.to/viktorbaumann/your-quorum-dead-letter-queue-can-drop-the-dead-letters-x-delivery-count-travels-along-240n
- https://dev.to/api/articles/viktorbaumann/your-quorum-dead-letter-queue-can-drop-the-dead-letters-x-delivery-count-travels-along-240n
- https://warrenops.io/docs/quorum-queues.html
- https://github.com/drbenzin/queue-studio-docs
- https://raw.githubusercontent.com/drbenzin/queue-studio-docs/main/README.md
- https://plugins.jetbrains.com/api/plugins/34454
- https://registry.npmjs.org/amqplib
- https://unpkg.com/amqplib@latest/lib/connect.js
- https://registry.npmjs.org/rabbitmq-amqp-js-client
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/main/src/delivery_context.ts
