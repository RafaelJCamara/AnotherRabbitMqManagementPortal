# Managed and restricted brokers

> **Verified research (2026-10-16).** Source read at exact release tags and primary docs; **not yet lab-tested**. The conformance suite (M0) confirms or corrects every runtime claim. Content about a specific third-party product was removed under the docs policy ([ADR-034](../adr/ADR-034-docs-policy.md)).

_Verification task `managed-brokers` · 2026-10-16_

## Summary

I read the documentation and source code only; I did not run any brokers. The finding: every planned feature works on self-hosted RabbitMQ and on Kubernetes or Tanzu deployments, with some plugins to switch on. Managed services break the features that need plugins, and they add hard limits. The core that needs no plugin works on every RabbitMQ-based provider: safe peek, tap, republish from our engine with confirms, and topology export built from list endpoints. ApsaraMQ is not RabbitMQ and is the exception.

Amazon MQ (3.13, 4.2 and 4.3; RabbitMQ 4 only on m7g instances):
- You get an administrator user, the standard management API on ports 443 and 15671, and AMQPS on 5671. AMQP 1.0 is also available on 4.x.
- Plugins are limited to management, dynamic shovels, federation, consistent-hash, JMS (4.x), Prometheus (4.2+, on per-node ports 16001–16003 with broker credentials) and the auth plugins.
- There is no event exchange, no tracing plugin, no MQTT/STOMP, no custom plugins, and no stream support at all.
- Operator-policy edits return HTTP 405 by default.
- 4.x brokers create quorum queues by default (delivery limit 20) and ship low default limits: 10 consumers per channel, 512 KiB messages, 100–500 connections per node on small clusters.
- Tap queues still work: RabbitMQ 3.13.7–4.3.6 makes exclusive or auto-delete queues classic when the default type is quorum. Taps must set x-overflow=drop-head, though. Otherwise the AWS reject-publish default policy could make production publishers receive nacks.

CloudAMQP:
- Dedicated plans are close to self-hosted. The event exchange and Prometheus are on by default (scraped at https://host-0N/metrics). The stream plugin is opt-in, with ports 5551/5552.
- Shared plans are tenant vhosts with no administrator rights: no definitions, users, firehose or Prometheus. Limits are 20–100 connections and 100–1,000 queues, plus a monthly message quota that also counts peeked messages.

LavinMQ is not a drop-in replacement:
- On its HTTP get endpoint, RabbitMQ's ack_requeue_true means reject without requeue. The message is lost or dead-lettered unless the request also sends requeue:true.
- It has no AMQP 1.0, stream protocol, firehose, event exchange, feature flags, health checks or quorum-queue endpoints.

IBM Messages for RabbitMQ has a fixed plugin set (no federation, Prometheus, event exchange or stream plugin) and an IBM-issued CA certificate.

Load balancers in every managed cluster, and Kubernetes Services, send each request to whichever node they pick. This makes node-local behaviour unpredictable: the firehose toggle, health checks, /api/config/effective and Prometheus. The Cluster Operator turns on all feature flags itself. The Topology Operator puts back its own objects (resync every 10 h by default). Bitnami images stopped updating on 2025-08-28, so older brokers will stay common.

Decision: keep the no-plugin core. Make firehose, event-exchange audit, Prometheus history, the stream protocol and shovel redrive optional extras, switched on by a mandatory capability probe at connect time. Also add AWS, CloudAMQP and Kubernetes adapters, plus CA import, SNI override and SOCKS5 support.

## Verdicts

| ID | Verdict | Confidence | Verified statement |
| --- | --- | --- | --- |
| V01 | confirmed | high | Amazon MQ for RabbitMQ 4 brokers (4.2 and 4.3, m7g only) default to queue type quorum: a declare without x-queue-type creates a quorum queue, and those queues get the open-source default delivery-limit of 20. Classic queues remain declarable explicitly but are non-replicated. |
| V02 | nuanced | high | Only the in-place path 3.13 -> 4.2 exists (4.3 is reachable only from 4.2; m7g instance type required). The upgrade eligibility check blocks (RABBITMQ_BROKER_NOT_UPGRADEABLE_TO_V4) when classic MIRRORED queues exist, which in practice means cluster brokers, or when the Khepri feature flag is enabled. Khepri has no in-place path at all, so a blue-green migration is needed. The in-place guide says single-instance brokers with classic queues can skip the migration step. The troubleshooting page words it as 'classic queues', so the AWS pages are inconsistent. After upgrade, the lower RabbitMQ 4 default resource limits apply. |
| V03 | confirmed | high | OAuth 2.0 for Amazon MQ for RabbitMQ shipped 2025-09-03, for public identity providers. It works on 3.13 (the tutorial uses engine 3.13) and 4.x. The IdP's server certificate must come from a public CA. management.oauth_client_secret is unsupported, so UAA is unsupported. There are no opaque tokens, introspection or revocation. OAuth-only brokers without an internal user are possible. Separately, IAM authentication (STS GetWebIdentityToken JWTs used as OAuth tokens) is supported on 3.13 and 4.2+. |
| V04 | confirmed | high | LDAP authentication and authorization shipped 2025-11-17. A system user monitoring-AWS-OWNED-DO-NOT-DELETE, which uses internal auth, is loopback-only and is protected via the 4.2 'protected' tag, coexists with LDAP. |
| V05 | confirmed | high | HTTP auth backend shipped 2026-01-06 and SSL certificate (X.509 or SASL EXTERNAL) authentication plus mTLS shipped 2026-01-08. Both are RabbitMQ 4.x only. CA certificates are given as AWS ARNs; private CAs work for mTLS only on 4.x. mTLS on the management API supports verify_peer but not strict mode. Shovels and federation cannot present client certificates. |
| V06 | confirmed | high | Shipped 2026-04-30 for 4.2+ only; 3.13 brokers have CloudWatch only. Supported endpoints are /metrics, /metrics/detailed and /metrics/memory-breakdown; /metrics/per-object is NOT supported. Each node is scraped on its own port, <prometheus-endpoint>:16001/16002/16003, over HTTPS with the broker's normal authentication. AWS recommends scraping every 60 s or slower. The endpoint is returned by DescribeBroker under BrokerInstances[].Endpoints. |
| V07 | confirmed | high | Supported since 2026-09-09 per the developer guide (the What's New post is dated 2026-09-10 18:08 UTC). Upgrades go only from 4.2. On Amazon MQ, 4.3 rejects transient non-exclusive queues, global QoS and x-queue-version=1. It no longer applies consumer timeouts to classic queues and adds x-modulus-hash in core. |
| V08 | nuanced | high | LavinMQ v2.10.2 copies RabbitMQ's paths for core objects: overview, whoami, vhosts, users, permissions, vhost-limits, exchanges, queues, bindings, policies, operator-policies, parameters, global-parameters, definitions, shovels, federation-links, connections, channels, consumers and /metrics.  It lacks health checks, feature-flags, deprecated-features, quorum-queue endpoints, rebalance, topic-permissions, user-limits, config/effective, version, cluster-name and auth/attempts.  Its /api/overview has product_name 'LavinMQ' and lavinmq_version but no rabbitmq_version. /api/extensions returns [].  Critically, POST /api/queues/{v}/{q}/get only understands ackmode 'get' (ack), 'reject_requeue_true' and 'reject_requeue_false'. RabbitMQ's 'ack_requeue_true' falls through to reject-without-requeue, so the message is dropped or dead-lettered, unless the body also carries requeue:true. A missing ackmode defaults to ack. |
| V09 | nuanced | high | The figure comes from 84codes, CloudAMQP's operator. Its homepage states '31,000+ Running Brokers' and '4,100+ Happy Customers', across RabbitMQ and LavinMQ combined. The CloudAMQP homepage says '13,000+ users'. No split between shared and dedicated plans, or between RabbitMQ and LavinMQ, is published. |
| V10 | confirmed | high | From 2025-08-28 no new Bitnami images or charts were published to Docker Hub. Existing images moved to docker.io/bitnamilegacy with no further updates; the deletion of docker.io/bitnami was postponed to 2025-09-29. The free tier became 'latest'-only hardened images (bitnamisecure). The chart source on GitHub is now the 'Bitnami Secure Images Helm chart for RabbitMQ' (version 16.0.16, appVersion 4.1.3). bitnami/rabbitmq on Docker Hub was last updated 2025-09-03, and Azure Marketplace references were removed in April 2026. |
| V11 | refuted | high | In RabbitMQ 3.13.7, 4.2.9 and 4.3.6, augment_declare_args checks rabbit_queue_type:is_compatible. Quorum queues are compatible only with durable=true, exclusive=false and auto_delete=false. Exclusive, auto-delete or non-durable declares therefore get x-queue-type set to the fallback type, classic. On 4.x this applies whether the default comes from vhost metadata or from the node-level default_queue_type (Amazon MQ 4.x). Lab confirmation on Amazon MQ is still pending. |
| V12 | confirmed | high | Confirmed by source reading: rabbit_trace:update_config stores trace_vhosts in the local application environment and refreshes only local channels and sessions. The 'tracing' field in GET /api/vhosts is also computed on whichever node answers. Behind the NLBs and Services used by managed and Kubernetes clusters, capture is therefore partial and unpredictable.  Additional finding: the handler defaults a missing description or tags to "" and the metadata merge overwrites them. A body of {"tracing":true} therefore wipes the vhost's description and tags (3.13.7 and 4.3.6); only default_queue_type is preserved. LavinMQ has no firehose (tracing hard-coded false). |
| V13 | nuanced | high | /metrics/detailed accepts vhost and family on 4.2.9. The queue regex filter (at most 2,000 characters, one parameter) exists only from 4.3.  Ports and paths vary by provider: Amazon MQ uses 16001-16003 with credentials and no per-object endpoint; CloudAMQP serves https://<host>-0N.rmq.cloudamqp.com/metrics on 443; the Bitnami chart uses 9419 and is off by default; LavinMQ uses 15692 bound to 127.0.0.1 with lavinmq_-prefixed names; IBM has no Prometheus plugin.  When prometheus.authentication.enabled is set, the endpoint requires the monitoring tag. Listeners appear as protocol 'http/prometheus' or 'https/prometheus' in /api/overview, visible only to monitoring or administrator users. |
| V14 | confirmed | high | RabbitMQ 4.2.0 added the shovel protocol 'local' (built on AMQP 1.0 internals, using intra-cluster connections, same cluster only). Amazon MQ lists local shovels among its 4.2 features. Shovels still count against runtime_parameters.limits.shovel, which defaults to 30 per node on an m7g.large cluster. |
| V15 | nuanced | high | The route exists from 3.13.7 through 4.3.6 (handled by rabbit_mgmt_wm_environment). It requires the administrator tag, returns text/plain Erlang terms of rabbit:environment() for the node serving the request, and can expose sensitive settings. Treat it as optional, node-local and secret. No provider documents whether it is blocked. |
| V16 | refuted | high | Amazon MQ ships management.restrictions.operator_policy_changes.disabled=true (all versions). Single-operator-policy resources then return HTTP 405 'Broker settings disallow editing of operator policies.', even for GET. The list endpoint still works and /api/overview reports is_op_policy_updating_enabled=false. Customers can lift the restriction through an Amazon MQ configuration revision followed by a reboot. |
| V17 | confirmed | high | Plugins are provider-fixed: - Always on: management, shovel (dynamic shovels only), federation, consistent-hash. - 4.x: JMS topic exchange. - 4.2+: Prometheus. - Switched on through broker configuration: OAuth2, LDAP, HTTP (4.x), SSL certificate auth (4.x) and the aws ARN-resolver plugin. No event_exchange, tracing, stream, MQTT/STOMP/web, top or custom plugins. |
| V18 | refuted | high | AWS states 'Currently, Amazon MQ does not support streams'. The documented queue types are classic, classic mirrored and quorum, and the stream protocol is absent from the supported protocols. An Amazon MQ team plugin for S3 tiered stream storage exists on GitHub but is a beta built on development branches, not a service feature. |
| V19 | nuanced | high | On dedicated plans (Sassy Squirrel and up): - On by default: rabbitmq_event_exchange, prometheus, shovel and federation, each with its management extension. - Opt-in: stream (+management), tracing and top. - Prometheus is served at https://<host>-0N.rmq.cloudamqp.com/metrics with basic auth, including detailed and per-object endpoints. - The firehose can be toggled from the CloudAMQP console. Shared plans (Little Lemur, Tough Tiger) offer none of this: no plugin view, no Prometheus, and no user, vhost or permission management. |
| V20 | confirmed | high | cluster-operator v2.23.1 runs 'rabbitmqctl enable_feature_flag all' in pod <name>-server-0 during reconcile. Its essential plugins are rabbitmq_management, rabbitmq_prometheus and rabbitmq_peer_discovery_k8s, with additionalPlugins for anything else. |
| V21 | nuanced | medium | The Messaging Topology Operator reconciles on CR events. Periodic full reconciliation follows the controller-runtime cache SyncPeriod, which is configurable via the SYNC_PERIOD env var and defaults to 10 hours in controller-runtime v0.25.2. UI edits to CR-owned policies, users or permissions persist until the next CR change, operator restart or resync, then get overwritten. The revert is delayed, not immediate. Detection requires Kubernetes API access. |
| V22 | nuanced | high | The developer-guide release notes date it 2026-09-09; the What's New post is timestamped 2026-09-10 18:08 UTC. |
| V23 | nuanced | medium | The plugin page still says shovel destinations and federation upstreams cannot be private brokers. Since 2026-06-18, however, private networking (VPC Lattice, RAM and PrivateLink) lets brokers reach private resources, including other Amazon MQ brokers and self-hosted RabbitMQ.  Outbound TLS is fixed to verify_none on 3.x. On 4.x it defaults to verify_peer against the Mozilla CA list, and client certificates are unsupported. |
| V24 | refuted | medium | Policies match tap queues by name. Amazon MQ cluster default policies set max-length plus overflow=reject-publish, and RabbitMQ nacks a publish when any routed queue rejects it. A full tap queue without its own x-overflow could therefore make production publishers using confirms receive basic.nack.  The fix is to declare taps with x-overflow=drop-head, which wins over the policy for classic queues, and a small x-max-length (the minimum of policy and argument applies). |
| V25 | confirmed | medium | The Tanzu RabbitMQ 4.3 commercial-features page lists these as exclusive features: JMS Queues, Warm Standby Replication, intra-cluster compression, AMQP 1.0 over WebSocket, OAuth forward proxy, opaque OAuth tokens, runtime LDAP changes and the Stream browser. The 4.3 release notes add Delayed Queues/Message Scheduler, stream shovel protocol and Linter. |
| V26 | confirmed | high | Confirmed on 2026-10-16: cluster-operator has 1,120 stars, v2.23.1 published 2026-10-13T11:28:44Z. messaging-topology-operator is at v1.20.4 (2026-10-13). LavinMQ has 1,031 stars, v2.10.2 published 2026-10-07T14:28:09Z. |

### Evidence

- **V01** (confirmed, high): https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-4.html ('The default queue type on Amazon MQ for RabbitMQ 4.2 brokers is quorum. If no queue type argument is specified during queue creation, a quorum queue will be created.'); https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-42.html (Breaking changes: 'Default queue type ... set to quorum'; 'Default redelivery limit on quorum queues is set to 20'); https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/quorum-queues-best-practices.html
- **V02** (nuanced, high): https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/troubleshooting-action-required-codes-rabbitmq-not-upgradeable-to-v4.html ('the broker has classic queues or the Khepri metadata store feature flag is enabled'); https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/upgrading-rabbitmq-v3-to-v4-inplace.html ('Amazon MQ will prevent in-place upgrades to RabbitMQ 4 if the broker has classic mirrored queues ... If you are upgrading a single-instance broker with classic queues, you can skip this step'; 'Amazon MQ applies the RabbitMQ 4 default resource limits, which are lower'); https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-43.html
- **V03** (confirmed, high): https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/amazon-mq-release-notes.html (row 'September 3, 2025 ... OAuth 2.0 ... public identity providers'); https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/oauth-for-amq-for-rabbitmq.html ('doesn't support server certificate issued by a private CA'; 'we don't support UAA'); https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/oauth-tutorial.html; https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/iam-for-amq-for-rabbitmq.html ('supported on RabbitMQ versions 3.13, 4.2 and above')
- **V04** (confirmed, high): https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/amazon-mq-release-notes.html (row 'November 17, 2025'); https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/ldap-for-amq-for-rabbitmq.html
- **V05** (confirmed, high): https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/amazon-mq-release-notes.html (rows 'January 6, 2026', 'January 8, 2026'); https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/configure-mtls.html ('Strict mTLS is not supported for the management API'); https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-amqp-client-ssl-configuration.html ('Amazon MQ does not currently support configuring client certificates for AMQP client connections')
- **V06** (confirmed, high): https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-prometheus-metrics.html ('The /metrics/per-object endpoint is not supported'; sample targets '<broker-prometheus-endpoint>:16001'...'16003'; 'same authentication scheme as the broker'); https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/amazon-mq-release-notes.html (row 'April 30, 2026'); https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-basic-elements-plugins.html (Prometheus 'always enabled')
- **V07** (confirmed, high): https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/amazon-mq-release-notes.html (row 'September 09, 2026'); https://aws.amazon.com/about-aws/whats-new/2026/09/amazon-mq-rabbitmq-43/ (postDateTime 2026-09-10T18:08:00Z); https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-43.html
- **V08** (nuanced, high): https://github.com/cloudamqp/lavinmq/tree/v2.10.2/src/lavinmq/http/controller (route list); queues.cr@v2.10.2 L185-191: 'ack_mode = (body["ack_mode"]? || body["ackmode"]?).try(&.as_s) || "get" ... requeue = body["requeue"]?.try(&.as_bool) || ack_mode == "reject_requeue_true" ... ack = ack_mode == "get"' and L222-227 'q.reject(sp, requeue)'; same logic at v1.3.0, v2.0.0, v2.4.0, v2.7.0; views/queue.shtml@v2.10.2 L268-272 (modes get / reject_requeue_true / reject_requeue_false); main.cr@v2.10.2 L93-96 and L184-186
- **V09** (nuanced, high): https://www.84codes.com/ (HTML: '<p>31,000+</p> <h2>Running Brokers</h2>', '<p>4,100+</p> <h2>Happy Customers</h2>'); https://www.cloudamqp.com/ ('13,000+ users')
- **V10** (confirmed, high): https://github.com/bitnami/containers/issues/83267; https://raw.githubusercontent.com/bitnami/charts/main/bitnami/rabbitmq/Chart.yaml; https://raw.githubusercontent.com/bitnami/charts/main/bitnami/rabbitmq/README.md (L3, L32); https://hub.docker.com/v2/repositories/bitnami/rabbitmq/ (last_updated 2025-09-03T10:38:12Z); https://github.com/bitnami/charts/pull/36507
- **V11** (refuted, high): rabbit_amqqueue.erl@v4.2.9 L765-810 (augment_declare_args, update_args_table_with_queue_type: 'if the properties are incompatible with the declared DQT, use the fall back type'); rabbit_quorum_queue.erl@v4.2.9 L209-214 ('is_compatible(_Durable = true, _Exclusive = false, _AutoDelete = false) -> true; is_compatible(_, _, _) -> false.'); rabbit_queue_type.erl@v4.2.9 L334-335 ('fallback() -> rabbit_classic_queue.'); rabbit_amqqueue.erl@v3.13.7 L774-806; @v4.3.6 L766-811 (https://github.com/rabbitmq/rabbitmq-server/blob/v4.2.9/deps/rabbit/src/rabbit_amqqueue.erl)
- **V12** (confirmed, high): rabbit_trace.erl@v4.3.6 L124-143 ('application:set_env(rabbit, ?TRACE_VHOSTS, VHosts)', 'rabbit_amqp_session:list_local()', 'rabbit_channel:refresh_config_local/0'); rabbit_vhost.erl@v4.3.6 L486-490 and L759 ('i(tracing, VHost) -> rabbit_trace:enabled(...)'); rabbit_mgmt_wm_vhost.erl@v4.3.6 L66-68 ('Description = maps:get(description, BodyMap, <<"">>)', 'Tags = maps:get(tags, BodyMap, <<"">>)'); vhost.erl@v4.3.6 L187-196 (metadata_merger); rabbit_vhost.erl@v3.13.7 L257+ (update/5); lavinmq vhost.cr@v2.10.2 L325 ('tracing: false')
- **V13** (nuanced, high): rabbit_prometheus_handler.erl@v4.2.9 L132 (match_qs vhost, family) and L32-42 (is_authorized_monitor when authentication enabled); rabbit_prometheus_handler.erl@v4.3.6 L18, L136-139, L183-202 (queue filter); rabbit_prometheus_app.erl@v4.2.9 start_listener ('https/prometheus' / 'http/prometheus'); rabbitmq_prometheus.schema@v4.2.9 L182; https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-prometheus-metrics.html; https://www.cloudamqp.com/docs/cloudamqp-metrics/; bitnami values.yaml L360/L1357; lavinmq docs/monitoring.md@v2.10.2 L5-12
- **V14** (confirmed, high): https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.0/release-notes/4.2.0.md L134-140 ('Shovels now support a new "protocol" option called local'); https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-42.html; https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-resource-limits-configuration.html
- **V15** (nuanced, high): rabbit_mgmt_dispatcher.erl@v3.13.7 and @v4.3.6 L227 ('{"/config/effective", rabbit_mgmt_wm_environment, []}'); rabbit_mgmt_wm_environment.erl@v4.3.6 (to_plain: 'Res = rabbit:environment()'; is_authorized -> 'rabbit_mgmt_util:is_authorized_admin')
- **V16** (refuted, high): https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/configurable-values.html (default 'true'; 'Changes to the operator policies via the AWS Management Console or Management API are not available by default'); rabbit_mgmt_wm_operator_policy.erl@v4.3.6 L74-80; rabbit_mgmt_wm_operator_policies.erl@v4.3.6 L37-38; rabbit_mgmt_wm_overview.erl@v4.3.6 L57
- **V17** (confirmed, high): https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-basic-elements-plugins.html; https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/troubleshooting-rabbitmq.html ('currently only supports the RabbitMQ management, shovel, federation, consistent-hash exchange plugin'); https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-supported-protocols.html (AMQP 0-9-1, AMQP 1.0, JMS only)
- **V18** (refuted, high): https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/best-practices-rabbitmq.html; https://aws.amazon.com/amazon-mq/features/; https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-supported-protocols.html; https://github.com/amazon-mq/rabbitmq-stream-s3 (README: 'beta level', requires 'streams-tiered-storage' branch)
- **V19** (nuanced, high): https://www.cloudamqp.com/docs/cloudamqp-plugins/ (table column 'Default'); https://www.cloudamqp.com/docs/cloudamqp-metrics/; https://www.cloudamqp.com/blog/prometheus-and-grafana/; https://www.cloudamqp.com/changelog/ ('Added possibility to enable/disable RabbitMQ tracing/firehose from the CloudAMQP Console'); https://www.cloudamqp.com/docs/faq/ ('It is only possible to manage users, virtual hosts and permissions on dedicated plans')
- **V20** (confirmed, high): https://github.com/rabbitmq/cluster-operator/blob/v2.23.1/internal/controller/reconcile_cli.go L68-77 ('cmd := "rabbitmqctl enable_feature_flag all"'); https://github.com/rabbitmq/cluster-operator/blob/v2.23.1/api/v1beta1/rabbitmqcluster_types.go L423
- **V21** (nuanced, medium): https://github.com/rabbitmq/messaging-topology-operator/blob/v1.20.4/cmd/main.go L236-243 ('sync period set; all resources will be reconciled every: %s'); internal/controller/common.go@v1.20.4 L43 (SYNC_PERIOD); https://github.com/kubernetes-sigs/controller-runtime/blob/v0.25.2/pkg/cache/cache.go L45 ('defaultSyncPeriod = 10 * time.Hour')
- **V22** (nuanced, high): https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/amazon-mq-release-notes.html; https://aws.amazon.com/about-aws/whats-new/2026/09/amazon-mq-rabbitmq-43/
- **V23** (nuanced, medium): https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-basic-elements-plugins.html; https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/private-networking.html; https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-amqp-client-ssl-configuration.html
- **V24** (refuted, medium): https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-defaults.html (overflow: reject-publish, max-length on clusters); https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-defaults-applying-policies.html (pattern .*); rabbitmq-website docs/maxlength/index.md L62-64 ('If a message is routed to multiple queues and rejected by at least one of them, the channel will inform the publisher via basic.nack'); rabbit_amqqueue_process.erl@v4.2.9 L492-507 ('max-length' res_min, 'overflow' res_arg)
- **V25** (confirmed, medium): https://techdocs.broadcom.com/us/en/vmware-tanzu/data-solutions/tanzu-rabbitmq-oci/4-3/tanzu-rabbitmq-oci-image/site-tanzu-rabbitmq-features.html; https://techdocs.broadcom.com/us/en/vmware-tanzu/data-solutions/tanzu-rabbitmq-oci/4-3/tanzu-rabbitmq-oci-image/site-release-notes.html (read via WebFetch summary)
- **V26** (confirmed, high): GitHub API repos/rabbitmq/cluster-operator, repos/rabbitmq/cluster-operator/releases, repos/rabbitmq/messaging-topology-operator/releases, repos/cloudamqp/lavinmq and its releases

## Report

# Managed and restricted RabbitMQ: compatibility of the planned features (as of 2026-10-16)

**How this was researched.** Documentation and source code only; no brokers were run.
- Provider documentation was fetched on 2026-10-16.
- Source code was read at exact tags:
  - RabbitMQ: v3.13.7, v4.0.9, v4.1.8, v4.2.9 and v4.3.6 (the latest open-source patch of each series).
  - LavinMQ: v2.10.2.
  - cluster-operator: v2.23.1.
  - messaging-topology-operator: v1.20.4.
  - controller-runtime: v0.25.2.
- Bracketed keys such as [A5] point to the source index in section 8.
- Provenance tags: **DOC** = provider documentation, **SRC** = source read, **INF** = inference.

---

## 1. Bottom line

1. **The core that needs no broker plugin survives on every RabbitMQ-based provider.** That core is:
   - peek over AMQP;
   - the exclusive temporary-queue tap;
   - redrive done by our engine (consume, then republish with publisher confirms);
   - topology export and diff built from list endpoints.

   The differentiators that need plugins or special ports are the ones that break on managed services:
   - firehose capture;
   - the event-exchange audit timeline;
   - Prometheus history;
   - the stream protocol;
   - redrive through shovels.

   Alibaba ApsaraMQ is not RabbitMQ: it speaks AMQP 0-9-1 only and has no RabbitMQ management API.
2. **Amazon MQ (the largest managed offering).**
   - **Access:** you get an administrator user, the standard management API on 443 and 15671, and AMQPS on 5671. AMQP 1.0 is also on 5671 for 4.x.
   - **Plugins:** management, dynamic shovels, federation, consistent-hash, JMS (4.x), Prometheus (4.2 and later, on ports 16001–16003), and authentication plugins.
   - **Missing:** event exchange, tracing plugin, streams, MQTT/STOMP and custom plugins.
   - **Operator policies:** edits return HTTP 405 by default.
   - **4.x specifics:** quorum is the default queue type (delivery limit 20), and default limits are low: 10 consumers per channel, 512 KiB messages, and 100–500 connections per node on small clusters [A2][A3][A5][A9][A11][A14][A25].
3. **CloudAMQP.**
   - Dedicated plans are close to self-hosted. The event exchange and Prometheus are on by default. The stream plugin is opt-in, with ports 5551 and 5552.
   - Shared plans are tenant vhosts without administrator rights. They have no definitions, users, firehose or Prometheus. Limits are 20 or 100 connections and 100 or 1,000 queues. The monthly message quota also counts consumed messages, so peeks use it up [C1][C4][C7][C11].
4. **LavinMQ looks like RabbitMQ but is not safe to treat as RabbitMQ.**
   - On `/api/queues/{v}/{q}/get`, RabbitMQ's `ack_requeue_true` means *reject without requeue*. The message is dropped or dead-lettered unless the body also carries `"requeue": true`.
   - It lacks about half of the 4.x endpoints, and has no AMQP 1.0, stream protocol, firehose or event exchange [L1][L2][L3].
5. **IBM Messages for RabbitMQ** has a fixed plugin set with no federation, Prometheus, event exchange or stream plugin. It uses an IBM-issued CA and per-deployment ports [I1][I3].
6. **Node-local behaviour is unpredictable behind load balancers.** This covers the firehose toggle, local health checks, `/api/config/effective` and Prometheus. Every managed cluster sits behind a load balancer, and so does every Kubernetes Service; the engine must model the case "this cluster is fronted by a load balancer" [R8][K1][A17].
7. **Old brokers will persist.** No new Bitnami images have been published since 2025-08-28, so expect many pinned brokers at 4.1.x or older in the field. Amazon MQ and IBM also still run 3.13. Support 3.13 through 4.3 [B1][B3][A1][I6].

---

## 2. Provider × capability matrix (planned features)

Legend:
- **S**: supported.
- **P**: partial or degraded.
- **C**: needs configuration or opt-in.
- **B**: blocked or unavailable.
- **U**: unknown; probe at runtime.

### 2a. Managed services

| # | Capability | Amazon MQ 3.13 | Amazon MQ 4.2 / 4.3 | CloudAMQP shared (Little Lemur / Tough Tiger) | CloudAMQP dedicated | IBM Messages for RabbitMQ | StackHero |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Peek (AMQP get or consume + nack; HTTP /get) | S. AMQPS 5671 only; standard /get [A26][R14] | S, high risk. Default type is quorum, so most queues have delivery-limit 20 and nack-peeks consume that budget; AMQP 1.0 on 5671 [A2][A3][A6] | S/P. Every consumed message counts toward the 1M/10M per-month quota [C4][C11] | S [C2][C16] | S. AMQPS on a per-deployment port [I3] | S. AMQPS [S2] |
| 2 | Live tap (exclusive auto-delete temp queue) | S. Counts toward the vhost max-queues default; AWS cluster default policy (max-length + reject-publish) matches temp queues, so set x-overflow [A8][R22][R23] | S/P. Exclusive becomes classic under a quorum default [R9][R10]. Defaults on an m7g.large cluster: 10 consumers per channel, 1,000 queues, 1,000 exchanges [A9]. x-local-random unsupported [A2] | P. Counts toward 100/1,000 queues and 10k/100k queued messages; temporary queues are deleted after 60 s [C11][C13] | S | S (limits U) | U (S expected) |
| 3 | Firehose (vhost tracing + amq.rabbitmq.trace) | U→P. Core toggle needs the administrator tag; AWS does not document it. The toggle is node-local and the load balancer picks the node, so a 3-node cluster gives partial capture; no rabbitmq_tracing [R7][R8][A5] | same as 3.13 | B. Needs the administrator tag [C4][R7] | S/P. Console toggle; HTTP toggle is node-local; rabbitmq_tracing is opt-in [C14][C1] | U. An admin user exists; no tracing plugin [I1][I2] | U |
| 4 | Audit timeline (amq.rabbitmq.event) | B. Plugin not offered [A5][A24] | B | B/U. The exchange lives in vhost "/" by default [R24]; tenants are confined to their own vhost | **S, on by default** [C1] | B. Fixed plugin list [I1] | U |
| 5 | Prometheus history | B. 4.2 and later only; CloudWatch only (first 500 queues) [A14][A21] | S. `/metrics`, `/metrics/detailed`, `/metrics/memory-breakdown` at `<prom-endpoint>:16001..16003` (one port per node), HTTPS with broker credentials, scrape interval ≥60 s; **no `/metrics/per-object`** [A14]. The `queue=` filter exists only on 4.3 [R11]. No per-queue CloudWatch metrics on 4.x [A2] | B. Dedicated only [C7] | S. `https://<host>-0N.rmq.cloudamqp.com/metrics` on 443 with basic auth; detailed and per-object available; behind VPC Connect use `/nodeN/metrics` [C7][C8][C6] | B. rabbitmq_prometheus not offered [I1] | U |
| 6 | Stream browser | B. "does not support streams" [A25]; no stream protocol in the protocol list [A6] | B | U. No stream protocol; AMQP-declared streams unverified | C. Stream plugin is opt-in [C1]; open 5551/5552 via firewall or PrivateLink [C5][C6]; AMQP reads also possible [C3] | P. Streams over AMQP 0-9-1 only [I7] | U |
| 7 | Redrive via dynamic shovels (local shovels on 4.2+) | P. Dynamic shovels only; docs forbid private-broker destinations [A5], though private networking has allowed them since 2026-06-18 [A31]; outbound TLS is verify_none and cannot be overridden on 3.x [A30]; no local shovels | S/P. Dynamic and local shovels [A3]; per-node shovel quota (30 on an m7g.large cluster) [A9]; outbound verify_peer against the Mozilla CA list; no client certificates [A30] | U. Shovel plugin is on server-wide [C1]; creating parameters needs the policymaker tag [R-tags] | S. Shovel and its management extension on by default [C1] | S. Shovel and its management extension; **no federation** [I1] | U |
| 8 | Definitions export/import/diff | S. Administrator; AWS documents export/import with rabbitmqadmin [A33][R13] | S. Exclude AWS-owned objects | B. The endpoint is admin-only, so build a synthetic export [R13][C4] | S, plus automatic backups [C15] | S for `admin`; B for service-credential users, who have the monitoring tag [I2] | U (an admin user exists [S2]) |
| 9 | Policies / operator policies | Policies: S. AWS-DEFAULT-POLICY-* already exist, and on 3.x clusters AWS appends ha-mode/ha-sync-mode to every policy [A8][A17]. Operator policies: **read via the list endpoint; edits return 405 by default**; C via broker configuration [A11][R3] | Same; the 4.x default operator policy is `{"queue-version":2}` on classic queues [A7] | U. Depends on tenant tags; provider TTL policies exist [C13] | S (operator-policy restriction U) | S (admin) | U |
| 10 | Users / permissions / limits | S. Administrator; allowed tags are administrator, management, monitoring and policymaker; `guest` is auto-deleted; a protected system user exists [A13][A28]. Per-node connection limits are fixed [A21] | S. Node resource limits are changed only through an AWS configuration revision plus reboot [A12] | B. Dedicated plans only [C4] | S [C4]; node limits set in the console [C9] | S (admin); never touch the internal user `ibm` [I2] | S (vendor claim) [S1] |
| 11 | Feature flags / deprecated features | U. Reading is standard; enabling is undocumented. Enabling `khepri_db` on 3.13 **blocks the in-place upgrade to 4.2** [A22] | U | P. Read with the management tag; enabling is B | U (provider manages upgrades [C-vers]) | U | U |
| 12 | Health checks | U (standard endpoints, undocumented); node-local behind the NLB | U | S/P. The management tag is enough [R19]; results reflect the shared cluster | S | U | U |
| 13 | QQ replica ops / rebalance | U. AWS pins the replication factor to 3 [A32]; not applicable on single-instance brokers | U | B (needs administrator) | U | U | U |
| 14 | OAuth2 login | S. OAuth2 since 2025-09-03 on 3.13 and later; IAM via STS JWT on 3.13 and 4.2+; LDAP. IdP must use a public CA; no UAA; no opaque tokens [A1][A29][A15] | S, plus the HTTP backend, X.509/EXTERNAL and mTLS (4.x only) [A38][A28][A27] | B. OAuth2 is dedicated only [C10] | C. 3.13 and later, set in the console [C10] | U | U |

### 2b. Distributions and self-managed deployments

| # | Capability | LavinMQ 2.10 (self-hosted or CloudAMQP) | Tanzu RabbitMQ (K8s/VM/OCI) | Tanzu Platform (CF) service-key credentials | Cluster Operator (OSS) | Bitnami Helm | ApsaraMQ for RabbitMQ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Peek | **P / hazard.** HTTP /get understands only `get`, `reject_requeue_true` and `reject_requeue_false`; RabbitMQ's `ack_requeue_true` rejects without requeue; a missing ackmode means **ack**. No quorum queues: `x-quorum` is silently mapped to a standard queue [L2][L3][L5] | S [T1] | S (vhost permissions) [T3] | S | S | P. AMQP only; basic.cancel requeues messages already delivered [X1] |
| 2 | Tap | S [L9] | S | S | S | S | U |
| 3 | Firehose | B. Vhost `tracing` is hard-coded false [L6] | S/P (node-local) | B (needs administrator) | S/P. Node-local; the Service routes to one pod [R8][K1] | S/P | B. Console message trace instead [X1] |
| 4 | Event exchange | B | C (plugin) | U | C. `additionalPlugins` [K2] | C. `extraPlugins` [B2] | B |
| 5 | Prometheus | P. `/metrics` and `/metrics/detailed` (family, vhost) on 15692, **bound to 127.0.0.1 by default**; metric names prefixed `lavinmq_` [L8] | S | U (platform-level) | S. Essential plugin; 15692/15691 on the client Service, but scrape each pod [K2][K1] | C. **Off by default** (`metrics.enabled=false`); **port 9419** [B2][B4] | B. Own dashboards [X1] |
| 6 | Stream browser | P. AMQP 0-9-1 streams (`x-stream-offset`, `x-stream-filter`) plus `POST /api/queues/{v}/{q}/stream`; no stream protocol, no AMQP 1.0 [L7][L2] | S, plus the commercial Stream Browser [T1] | U | C. Add `rabbitmq_stream` to additionalPlugins for 5552/5551; the advertised host is the pod hostname [K3][K1] | C | B |
| 7 | Shovels | P. LavinMQ's own keys (src-uri, src-queue, dest-uri, dest-exchange, ack-mode...); no `*-protocol`, no local shovels; HTTP destinations [L12] | S, plus the stream shovel protocol in 4.3 [T2] | U (policymaker can set parameters) | C (plugin opt-in) | C | B |
| 8 | Definitions | P. `/api/definitions` plus upload; import returns precondition_failed on a mismatched redeclare [L11] | S, plus Schema Definition Sync (commercial) | B (admin only), so synthesize [T3][R13] | S. The default user is an administrator [K5][R25] | S | B |
| 9 | Policies / operator policies | S. The policymaker tag can also edit operator policies [L10] | S | Policies S; operator policies B [T3][R3] | S. Topology-Operator-owned objects are re-asserted at resync (10 h default) [K6][K7] | S | U (console) |
| 10 | Users / permissions / limits | P. No user-limits or topic permissions [L1] | S | B | S (CR drift possible) | S | B (RAM / console) |
| 11 | Feature flags | B. No endpoint [L1] | S | Read S; enable B | S, but the operator runs `rabbitmqctl enable_feature_flag all` [K4] | S | B |
| 12 | Health checks | P. aliveness-test only [L4] | S | S | S (node-local through the Service) | S | B |
| 13 | QQ replica ops / rebalance | B | S | B | S | S | B |
| 14 | OAuth2 | C. LavinMQ 2.7 and later (`/oauth/*`) [L4][C14] | C, plus opaque tokens and OAuth forward proxy [T1] | U | C | C. The LDAP backend plugin is in `extraPlugins` by default [B2] | B. RAM credentials instead [X1] |

**Marketplaces.**
- **Azure / GCP: CloudAMQP.** Listings bill the same CloudAMQP product [C4].
- **Azure / GCP: Bitnami.** References removed from the chart README in April 2026 [B6]; the Bitnami VM-stack documentation pages now return 404. Such VMs are self-managed: full administrator access and SSH, so treat them as self-hosted.
- **Rate limits.** No provider documents rate limits on the broker management HTTP API.
  - AWS throttling (15 rps, burst 100) applies only to the Amazon MQ control-plane API [A21].
  - AWS recommends polling per-queue metrics at most once a minute [A2] and scraping every 60 s or slower [A14].

---

## 3. Provider attribute matrix

| Provider | Administrator tag? | Plugins | Ports and reachability | Queue types | CLI | Limits | Auth | TLS |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Amazon MQ** (3.13, 4.2, 4.3; RMQ 4 only on mq.m7g) | Yes: the user given at broker creation gets `administrator`. Allowed tags: administrator, management, monitoring, policymaker. `guest` is deleted periodically. System user `monitoring-AWS-OWNED-DO-NOT-DELETE` is loopback-only and carries the `protected` tag [A13][A28] | Always on: management, shovel (dynamic only), federation, consistent-hash. 4.x: JMS topic exchange. 4.2+: Prometheus. Switched on by configuration: oauth2, ldap, http (4.x), ssl auth (4.x), aws (ARN resolver). Not offered: event_exchange, tracing, stream(+mgmt), mqtt/stomp/web_*, top, delayed-message, custom plugins [A5][A24]. Extra: the queue-migration plugin `/api/queue-migration/*` [A37] | 5671 AMQPS (AMQP 0-9-1; AMQP 1.0 on 4.x). 443 and 15671 HTTPS management. 16001–16003 Prometheus (4.2+). **No 5672, 5552 or 15692.** Public brokers are reachable from the internet and use **no security groups**. Private brokers are VPC-only through a VPC endpoint; AWS documents an SSH `-D` SOCKS5 proxy for console access [A26][A14][A18] | Classic; quorum (3.13+); classic mirrored on 3.x clusters (AWS HA policy). 4.x: the default type is quorum, exclusive queues become classic, and classic queues are not replicated. 4.3 rejects transient non-exclusive queues, global QoS and CQv1. No streams; no x-local-random [A2][A3][A4][A25] | None. AWS API/CLI for configuration revisions and reboots [A12] | 4.x defaults on an m7g.large cluster: 500 connections/node, 1,500 channels/node, **10 consumers/channel**, 1,000 queues, 50 vhosts, 30 shovels/node, 1,000 exchanges, **512 KiB** messages. Maximums: 5,000 connections/node, 1,000 consumers/channel, 10,000 queues, 128 MiB [A9][A10]. 3.x: per-node connection limits are fixed; default vhost limits, e.g. max-queues 4,000 and max-connections 15,000 on an m5.large cluster [A8][A21] | Internal; OAuth2 (public IdPs); IAM (STS JWT, valid 300–3600 s); LDAP; HTTP (4.x); X.509/EXTERNAL (4.x) [A16][A36] | Public Amazon Trust Services chain. Per-broker certificates carry the broker FQDN **only in the SAN** (the CN is opaque); a legacy regional wildcard is being retired. Do not pin certificates. VPC-endpoint DNS names are not in the SAN. mTLS with a private CA (4.x) uses ARNs; management mTLS is not strict [A20][A27] |
| **CloudAMQP shared** (Little Lemur free / Tough Tiger $19) | No; users, vhosts and permissions cannot be managed [C4]. Exact tags U | Provider-fixed. AMQP 0-9-1/1.0, MQTT, STOMP and WebSockets on all plans; Web-STOMP on dedicated plans only [C2][C4] | AMQP(S), HTTPS 443 for management; no Prometheus [C7][C16] | Per broker version. Temporary queues expire after 60 s; idle queues are deleted after 28 days [C13] | rabbitmqadmin over 443 only [C4] | Connections 20 / 100; queues 100 / 1,000; queued messages 10k / 100k; messages per month 1M / 10M (each publish **or consume** counts); 200 channels per connection; 20 new connections/s per IP [C11][C12][C4] | Internal only | Public CA [C4] |
| **CloudAMQP dedicated** (Sassy Squirrel and up) | Yes (INF: user and vhost management is offered only on dedicated plans) [C4] | **On by default:** management(+agent), shovel(+mgmt), federation(+mgmt), consistent-hash, **event_exchange**, **prometheus**. **Opt-in:** stream(+mgmt), tracing, top, mqtt, stomp, web_mqtt, web_stomp, jms, random, sharding, trust_store. **Need configuration:** oauth2/ldap/http/cache backends, auth_mechanism_ssl, recent-history. **Community:** delayed-message, deduplication, lvc, rtopic, routing-node-stamp, message-timestamp. Custom plugins on request [C1][C4] | 443 (management and `/metrics`), 5671/5672, 1883/8883, 61613/61614, **5551/5552**. Per-IP/port firewall. VPC peering, PrivateLink and PSC with "VPC features" ($99/month). Per-node hosts `-01`, `-02`, ... [C5][C6][C18][C8] | All; streams need the plugin | No rabbitmqctl; rabbitmqadmin over 443; CloudAMQP API/Terraform [C4] | No artificial limits; channel_max, connection_max, max_message_size (≤512 MiB) and consumer_timeout are configurable [C4][C9] | Internal; OAuth2 (3.13+; scope_aliases 4.1+); LDAP/HTTP/x509 via plugins; SAML and 2FA for the console only [C10][C1] | Public CA; custom domain with an uploaded chain and an SNI host list [C4][C17] |
| **IBM Messages for RabbitMQ** (4.3 preferred; 4.2; 3.13) | `admin` user. Service-credential, CLI and API users get the **monitoring** tag plus full permissions on the default vhost. Internal user `ibm` [I2] | Fixed: management, shovel(+mgmt), stomp, mqtt, jms_topic_exchange, consistent-hash; users cannot enable or disable plugins [I1] | Per-deployment high ports (e.g. `amqps://…:30402`); public and/or private service endpoints; IP allowlisting [I3][I5] | Classic and quorum (migration recommended); streams over AMQP 0-9-1 [I6][I7] | None (`ibmcloud cdb` for deployment operations) [I2] | U | Internal users, provisioned through IBM Cloud APIs | **IBM-issued certificate delivered Base64 in the connection strings**, so a custom CA must be trusted; TLS 1.2 [I3][I5] |
| **LavinMQ 2.10.2** | Self-hosted: yes. Tags: administrator, monitoring, management, policymaker (which can edit operator policies), impersonator [L10] | None (built in: shovels, federation, streams, delayed exchange, dedup, consistent-hash, MQTT) [L7] | 5672/5671, 15672/15671 (HTTP API), 1883/8883, 15692 metrics on 127.0.0.1, 5679 clustering; **no 5552** [L13][L8] | standard, priority, stream, mqtt. `quorum` and `classic` are accepted but ignored [L5][L9] | lavinmqctl, local only (not on CloudAMQP) [C4] | CloudAMQP LavinMQ plans. Shared: Loyal Lemming 200 queues / 20k queued / 2M per month; Elegant Ermine 2,000 / 200k / 20M. Dedicated plans start at 2.5k connections and 5k queues [C11] | Internal; OAuth2 (2.7+) [C14] | Self-managed |
| **Tanzu RabbitMQ** | As open source | Open source plus commercial: Stream Browser, Warm Standby Replication, JMS queues, AMQP over WebSocket, opaque tokens, OAuth forward proxy, runtime LDAP changes [T1][T2]. `product.name` and `product.version` are configurable [R16] | As deployed | Open source plus JMS queues | rabbitmqctl | As configured | Open source plus opaque tokens | As deployed |
| **Tanzu Platform (CF) on-demand** | **No.** Service keys and bindings create users tagged `management` + `policymaker` [T3] | Set by the platform operator | Set by the platform | per version | none for developers | U | U | U |
| **Cluster Operator (OSS)** | Yes. The default user (Secret `<name>-default-user`, username `default_user_<random>`) gets `administrator` from RabbitMQ's `default_user_tags` [K5][R25] | rabbitmq_management, rabbitmq_prometheus and rabbitmq_peer_discovery_k8s, plus `additionalPlugins` [K2] | Service: 5672, 15672, 15692 (TLS: 5671, 15671, 15691); 5552/5551 when the stream plugin is on; MQTT/STOMP/web ports when enabled. ClusterIP by default, so the desktop needs a port-forward [K1] | per version | `kubectl exec … rabbitmqctl`; the operator enables all feature flags [K4] | none by default | all open-source options | User-provided secrets, often a private CA (cert-manager) |
| **Bitnami Helm** | Yes (the chart user) | management, peer_discovery_k8s, plus `rabbitmq_auth_backend_ldap` in extraPlugins; prometheus only when `metrics.enabled` [B2][B4] | 5672/5671, 15672, 25672, 4369, **9419 (metrics)** [B2] | per version (chart appVersion **4.1.3**) [B3] | kubectl exec | none | all (LDAP plugin pre-enabled) | user-provided |
| **StackHero** | Admin user [S2] | Vendor claims delayed message, deduplication, consistent-hash and more (search snippet, unverified) [S1] | AMQPS (port per instance) [S2] | U | U | Vendor claims unlimited queues [S1] | Internal | Let's Encrypt (ISRG Root X1) [S2] |
| **ApsaraMQ for RabbitMQ** (Alibaba) | n/a | n/a (not RabbitMQ) | AMQP 0-9-1 only [X1] | own model; no transactions | none | per instance | RAM-derived credentials | Alibaba |

**Provider-owned objects to exclude from diff and apply, and to show as "managed by provider":**
- **Amazon MQ:** policies `AWS-DEFAULT-POLICY-SINGLE-INSTANCE`, `AWS-DEFAULT-POLICY-CLUSTER(-MULTI-AZ)`, `AWS-DEFAULT-QUORUM-QUEUES-POLICY-CLUSTER-MULTI-AZ` and `ha-all-AWS-OWNED-DO-NOT-DELETE`; operator policy `default_operator_policy_AWS_managed`; user `monitoring-AWS-OWNED-DO-NOT-DELETE`. On 3.x clusters, the `ha-mode`/`ha-sync-mode` keys AWS injects into every policy [A7][A8][A17][A28].
- **CloudAMQP shared:** the 28-day and 60-second TTL policies [C13].
- **IBM:** user `ibm` [I2].
- **RabbitMQ 4.2+:** any user tagged `protected` [R17].
- **Kubernetes:** objects owned by Messaging Topology Operator CRs [K6].

---

## 4. Core RabbitMQ facts the probes rely on (SRC)

1. **Restriction switches return HTTP 405, not 401.**
   - `rabbit_mgmt_features.erl@v4.3.6` defines `is_op_policy_updating_disabled/0` and `is_qq_replica_operations_disabled/0`. They are set by `management.restrictions.operator_policy_changes.disabled` and `management.restrictions.quorum_queue_replica_operations.disabled` (`rabbitmq_management.schema@v4.3.6` L712/L719).
   - In `rabbit_mgmt_wm_operator_policy.erl@v4.3.6` L74-80, `is_authorized` returns `method_not_allowed(<<"Broker settings disallow editing of operator policies.">>)` for **every method, including GET** of a single policy. The list endpoint needs only vhost access (`rabbit_mgmt_wm_operator_policies.erl` L37-38).
   - `rabbit_mgmt_wm_quorum_queue_replicas_add_member.erl@v4.3.6` L60-66 behaves the same way. `is_authorized` runs before `resource_exists`, so a probe against a nonexistent queue name is safe.
   - `/api/overview` exposes `is_op_policy_updating_enabled` (3.13.7+) but has no equivalent flag for the quorum-queue replica restriction.
2. **Tag requirements, which show up as 401 with a reason.**
   - Administrator:
     - definitions (all forms; `rabbit_mgmt_wm_definitions.erl` @v3.13.7 L139, @v4.3.6 L316);
     - feature-flag enable;
     - `/api/rebalance/queues`, which spawns `rabbit_amqqueue:rebalance(all, ".*", ".*")` asynchronously;
     - `/api/config/effective`;
     - quorum-queue replica operations;
     - operator policies.
   - Monitoring:
     - `/api/nodes`;
     - the `listeners` and `contexts` fields of `/api/overview`.
   - Policymaker:
     - policies;
     - `/api/parameters/{component}/...`, which covers shovel and federation parameters.
   - Any management user:
     - `/api/whoami`;
     - `/api/extensions`;
     - `GET /api/feature-flags`;
     - `/api/deprecated-features`;
     - health checks.
   - Vhost access:
     - `/get`;
     - `/publish`.
   - Insufficient tags return 401 with a reason such as `Not administrator user` or `Not monitor user` (`rabbit_web_dispatch_access_control.erl@v4.3.6` L36-53, L327-328).
3. **An exclusive tap queue becomes classic under a quorum default.**
   - See `rabbit_amqqueue.erl@v4.2.9` L765-810, `rabbit_quorum_queue.erl@v4.2.9` L209-214 and `rabbit_queue_type.erl@v4.2.9` L334-335. The same holds at v3.13.7 (vhost default) and v4.3.6 (vhost or node default).
   - 4.3 rejects transient **non-exclusive** queues, so taps must be exclusive.
4. **Firehose over HTTP is node-local, and it wipes vhost metadata.**
   - `rabbit_trace.erl@v4.3.6` L124-143 changes only the local application environment and local channels and sessions. Tracing is not persisted.
   - The `tracing` field in `GET /api/vhosts` is computed on the node that answers (`rabbit_vhost.erl@v4.3.6` L759).
   - `PUT /api/vhosts/{v}` defaults a missing `description` or `tags` to `""` (`rabbit_mgmt_wm_vhost.erl@v4.3.6` L66-68), and the metadata merger overwrites them (`vhost.erl@v4.3.6` L194-196). Only `default_queue_type` is kept when it is undefined (L187-188). 3.13.7 behaves the same way (`rabbit_vhost:update/5`).
   - The engine must therefore **GET the vhost first, then PUT tracing together with the current description, tags and default_queue_type**.
5. **Provider policies apply to tap queues.**
   - For classic queues, `overflow` is resolved argument-first and `max-length` takes the minimum of policy and argument (`rabbit_amqqueue_process.erl@v4.2.9` L492-507).
   - "If a message is routed to multiple queues and rejected by at least one of them, the channel will inform the publisher via basic.nack" [R23].
   - Because AWS cluster default policies set `overflow: reject-publish` [A8], taps must declare `x-overflow: drop-head` and their own `x-max-length`.
6. **Prometheus endpoint details.**
   - Listener protocol names are `'http/prometheus'` and `'https/prometheus'` (`rabbit_prometheus_app.erl@v4.2.9`).
   - When `prometheus.authentication.enabled` is set, the endpoint requires the monitoring tag over basic auth (`rabbit_prometheus_handler.erl@v4.2.9` L32-42).
   - `/metrics/detailed` accepts `vhost` and `family` (4.2.9 L132). 4.3.6 adds a single `queue` regex of at most 2,000 characters (L18, L136-139, L183-202).
7. **Overview fields by version** (`rabbit_mgmt_wm_overview.erl`):
   - `default_queue_type` from 4.0.9;
   - `is_op_policy_updating_enabled` from 3.13.7;
   - `listeners`, `contexts` and full statistics only for monitoring and administrator users (4.3.6 L62-73);
   - `product_name` is configurable (`rabbit.schema@v4.3.6` L1581/L1584), so treat it as a hint only.
8. **Endpoint inventory by version** (dispatcher at each tag [R1]).
   - `/api/config/effective` (3.13.7–4.3.6): administrator only; returns text/plain `rabbit:environment()`. Treat as a secret.
   - `/api/version` (4.0+).
   - `/api/vhosts/{v}/deletion/protection` (4.0+).
   - Health checks in 3.13.7: alarms, local-alarms, certificate-expiration, port-listener, protocol-listener, virtual-hosts, node-is-mirror-sync-critical, node-is-quorum-critical.
   - Health checks added in 4.0: metadata-store/initialized (+ with-data); mirror-sync was dropped.
   - Health checks added in 4.1: quorum-queues-without-elected-leaders, is-in-service, below-node-connection-limit, ready-to-serve-clients.
   - Health checks added in 4.2: reached-target-cluster-size.
   - OAuth discovery: `/js/oidc-oauth/bootstrap.js` (3.13.7–4.3.6, unauthenticated, emits `set_oauth_settings({...})`) [R21]; `/api/auth` up to 4.1.8 only (removed in 4.2).
   - 4.2.0 adds the `protected` user tag [R17].
   - Management extensions advertise themselves as `shovel.js`, `federation.js`, `stream.js` (stream_management, which also adds `/api/stream/connections`), `top.js` and `tracing.js` [R20].
9. **Event exchange vhost.** It uses `event_exchange.vhost`, defaulting to rabbit `default_vhost` ("/") [R24]. 4.x adds `event_exchange.protocol` (amqp_0_9_1 or amqp_1_0).

---

## 5. Capability-detection probes (run on connect, cache per connection, rerun on reconnect or version change)

### 5.1 Rules
- Run read-only probes in this order: network → unauthenticated → identity → product → features.
- Never toggle anything during probing. Write-shaped probes (5.2 #4.11) run only when the user opens the matching screen.
- Interpret HTTP status codes as follows:

| HTTP status | Meaning |
| --- | --- |
| 401 + `Login failed` | Bad credentials, or basic auth disabled. |
| 401 + `Not … user` | Missing tag. |
| 404 | Endpoint or plugin absent (also LavinMQ, older versions, a path prefix, or a provider proxy). |
| 405 + `Broker settings disallow …` | Provider restriction. |
| 503 | Health check failing. |
| timeout or reset | Port blocked (VPC or firewall). |

- Every feature gate stores a reason string and a source link to show in the UI.

### 5.2 Probe table

| # | Probe | Exact call | Needs | Interpretation → capability flags |
| --- | --- | --- | --- | --- |
| 0.1 | TLS and certificate check | TLS handshake to the management host:port and to AMQP 5671 | – | Record chain, SAN, issuer and expiry. Unknown CA (IBM, cert-manager) → offer CA import. **SAN mismatch** (typical for `vpce-*.amazonaws.com`, `localhost` port-forwards, raw IPs) → offer "verify as `<SAN host>`" (SNI and hostname override). Never pin the leaf certificate (Amazon MQ rotates per-broker certificates) [A20] |
| 0.2 | Provider fingerprint from hostname | regex on the host | – | `*.mq.<region>.amazonaws.com` / `*.mq.<region>.on.aws` → Amazon MQ [A19]. `*.rmq*.cloudamqp.com` → CloudAMQP [C8]. `*.databases.appdomain.cloud` → IBM [I3]. `*.stackhero-network.com` → StackHero [S2]. `*.svc(.cluster.local)` or a kube context → Kubernetes. `vpce-*` → AWS PrivateLink (Amazon MQ private broker, or CloudAMQP via PrivateLink) |
| 1.1 | OAuth discovery | `GET /js/oidc-oauth/bootstrap.js` (3.13–4.3) → parse the JSON inside `set_oauth_settings(...)`. Fallback `GET /api/auth` (≤4.1). LavinMQ: `GET /oauth/enabled` | none | `oauth_enabled`, client id, provider URL, resource servers, basic-auth disabled → pick the login flow (PKCE, Bearer for HTTP, JWT as password for AMQP). Offer the IAM token provider when Amazon MQ is detected [A15] |
| 2.1 | Identity | `GET /api/whoami` | any management user | name and tags (accept a comma string or an array). Tags drive all gates. `protected` (4.2+) makes the account read-only |
| 3.1 | Product and version | `GET /api/overview` | any | `product_name`, `product_version`, `rabbitmq_version`; **LavinMQ: `product_name`=`LavinMQ`, `lavinmq_version`, no `rabbitmq_version`** [L4]. Also `management_version`, `cluster_name`, `default_queue_type` (4.0+), `is_op_policy_updating_enabled`, `disable_stats`, `enable_queue_totals`, `exchange_types` (x-consistent-hash, x-modulus-hash, x-local-random, x-jms-topic, x-delayed-message …), and `listeners`/`contexts` (monitoring+) |
| 3.2 | Load-balancer detection | `GET /api/overview?columns=node` three times (or `GET /api/nodes`, monitoring+) | any | Different `node` values → the cluster sits behind a load balancer. Mark node-local features (firehose, local health, config/effective, unauthenticated Prometheus) as **unreliable or partial** |
| 3.3 | Version | `GET /api/version` | any | 4.0+; otherwise read the overview |
| 3.4 | Management extensions | `GET /api/extensions` | any | `shovel.js` → shovel_management; `federation.js`; `stream.js` → stream_management; `top.js`; `tracing.js`. `[]` → LavinMQ or a minimal broker |
| 3.5 | Nodes and plugins | `GET /api/nodes?columns=name,running,enabled_plugins,applications,auth_mechanisms,exchange_types,being_drained` | monitoring | Node count. Exact plugin set (event_exchange, stream, shovel, tracing, prometheus, oauth2). EXTERNAL among the auth mechanisms → mTLS login possible. Nodes being drained |
| 3.6 | Vendor fingerprints | `GET /api/queue-migration/status`; `GET /api/operator-policies`; `GET /api/policies`; `GET /api/users` (admin) | varies | 200 on queue-migration → Amazon MQ plugin [A37]. `default_operator_policy_AWS_managed` or `AWS-DEFAULT-POLICY-*` → Amazon MQ. User `monitoring-AWS-OWNED-DO-NOT-DELETE` → Amazon MQ. User `ibm` → IBM. A single visible vhost named like the username → CloudAMQP shared (INF) |
| 4.1 | Default queue type | Overview `default_queue_type` plus `GET /api/vhosts?columns=name,default_queue_type,tracing,description,tags,metadata` | any | quorum → assume new queues are quorum queues (delivery-limit 20 from 4.0): enable quorum-safe peek limits and DLQ warnings |
| 4.2 | Operator policies | Overview `is_op_policy_updating_enabled`; read through `GET /api/operator-policies/{vhost}` | vhost access | false → read-only editor, with Amazon MQ remediation text [A11]. Never GET a single operator policy (it returns 405 when restricted) |
| 4.3 | Definitions | if `administrator` → `GET /api/definitions/{vhost}`; else build a synthetic export | admin | 401 `Not administrator user` → synthetic export from queues, exchanges, bindings, policies and parameters lists |
| 4.4 | Event exchange | `GET /api/exchanges/{%2F or configured vhost}/amq.rabbitmq.event` | vhost access | 200 → event-based audit (bind an exclusive queue with `#`). 404 → fallback audit (snapshot diff) |
| 4.5 | Firehose | `GET /api/exchanges/{v}/amq.rabbitmq.trace` plus the administrator tag plus 3.2 | admin to toggle | Exchange present (any RabbitMQ) and admin → offered. If behind a load balancer → partial. LavinMQ → absent. Toggle = GET vhost, then PUT with `{description,tags,default_queue_type,tracing}` |
| 4.6 | Prometheus discovery | Candidates, in order: provider adapter (Amazon MQ DescribeBroker endpoint, ports 16001…; CloudAMQP `https://<host>-0N…/metrics`), then overview `listeners` with `http(s)/prometheus`, then defaults 15692 / 15691 / 9419 (Bitnami) / 15692 at 127.0.0.1 (LavinMQ). Request `GET <c>/metrics` without, then with, credentials | network (+ monitoring tag if auth is on) | 200 → enabled. 401 → authentication enabled (use monitoring credentials). Timeout → blocked (security group, firewall or VPC). Scrape **each node** individually. Metric prefix `lavinmq_` → LavinMQ |
| 4.7 | Prometheus features | version gate | – | `queue=` regex only on 4.3+. Never use `/metrics/per-object` on Amazon MQ. Scrape every 60 s or slower on Amazon MQ |
| 4.8 | Stream protocol | `listeners` `stream`/`stream/ssl` (monitoring+); else `GET /api/health/checks/protocol-listener/stream` (any user; node-local) or `GET /api/stream/connections` (stream_management) | – | Then connect to the stream port and check that every advertised host:port from stream metadata is reachable. If not (NAT, port-forward, Kubernetes pod DNS) → read over AMQP 1.0 (4.x) or AMQP 0-9-1 `x-stream-offset` instead |
| 4.9 | AMQP 1.0 | open AMQP 1.0 on the AMQP port | credentials | Works on 4.x RabbitMQ, including Amazon MQ 4.2+. Fails on LavinMQ, on ApsaraMQ, and on 3.13 without the plugin |
| 4.10 | Shovels | `/api/extensions` `shovel.js` or `GET /api/shovels`; `enabled_plugins` contains `rabbitmq_shovel`; version ≥4.2 → `local` protocol available | policymaker to create | Also check quota headroom (Amazon MQ instance table) before creating a shovel |
| 4.11 | Quorum-queue replica operations (only on demand) | `POST /api/queues/quorum/{vhost}/<random-nonexistent>/replicas/add` with body `{"node":"<a node>"}` | admin | 405 `Broker settings disallow quorum queue replica operations.` → restricted. 404 → allowed. 401 → not admin. Hide on single-node brokers and, by default, on Amazon MQ [A32] |
| 4.12 | Rebalance | gate only: admin, more than one node, not Amazon MQ by default | admin | No dry-run exists; it is fire-and-forget and asynchronous [R1] |
| 4.13 | Feature flags and deprecated features | `GET /api/feature-flags`; `GET /api/deprecated-features/used` | any | 404 → LavinMQ or a very old broker. Read-only by default; enabling needs explicit confirmation (Amazon MQ 3.13 `khepri_db` warning [A22]; Kubernetes operator enables all flags anyway [K4]) |
| 4.14 | Health | `GET /api/health/checks/alarms`, `/virtual-hosts`, `/node-is-quorum-critical`, `/certificate-expiration/1/months` (only the endpoints that exist at the detected version) | any | 200 / 503. 404 → use `/api/aliveness-test/{vhost}` (LavinMQ). Behind a load balancer, show results as node-local |
| 4.15 | Effective config (opt-in) | `GET /api/config/effective` | admin | Node-local Erlang terms; parse `consumer_max_per_channel`, `max_message_size`, `cluster_queue_limit`, `runtime_parameters` limits. Never persist; tolerate 401/404 |
| 4.16 | Limits | `GET /api/vhost-limits`, `GET /api/user-limits` (admin), plus provider tables (Amazon MQ instance type and deployment mode from DescribeBroker) | – | Budget for taps, shovels and connections |
| 5.1 | AMQP server properties | AMQP 0-9-1 handshake: `product`, `version`, `cluster_name`, `capabilities`; negotiated `channel_max` and `frame_max` | credentials | LavinMQ product string. CloudAMQP shared `channel_max` 200. Our client's frame_max must be ≥8192 (Amazon MQ 4.x requirement [A3]; amqplib 2.2.0 defaults to 131072 [N1]) |
| 5.2 | Tap dry-run | declare `<prefix>.tap.<uuid>` with `exclusive`, `auto_delete`, `x-queue-type: classic`, `x-max-length`, `x-overflow: drop-head`, `x-expires`; then `GET /api/queues/{v}/{name}` | configure permission | Confirms the type is classic and shows `effective_policy_definition`. Errors map to limits (5.3) |

### 5.3 Error signatures that reveal limits (exact texts from [A10], which match RabbitMQ core)

| Error text | Limit hit |
| --- | --- |
| `NOT_ALLOWED - connection refused: node connection limit (N) is reached` | `connection_max` |
| `NOT_ALLOWED - number of channels opened on node '…' has reached the maximum allowed limit of (N)` | `channel_max_per_node` |
| `NOT_ALLOWED - reached maximum (N) of consumers per channel` | `consumer_max_per_channel` (Amazon MQ 4.x default **10**) |
| `PRECONDITION_FAILED - message size X is larger than configured max size Y` | `max_message_size` (Amazon MQ 4.x default 524288) |
| `PRECONDITION_FAILED - cannot declare exchange '…' in vhost '…': exchange limit of N is reached` | `cluster_exchange_limit` (4.1+) |
| HTTP `cannot declare queue '…': queue limit in cluster (N) is reached` | `cluster_queue_limit` |
| HTTP `Validation failed … component shovel is limited to N per node` | `runtime_parameters.limits.shovel` |
| HTTP `cannot create vhost '…': vhost limit of N is reached` | `vhost_max` |

The core config keys behind these limits are `connection_max`, `channel_max_per_node`, `consumer_max_per_channel`, `max_message_size`, `cluster_queue_limit`, `cluster_exchange_limit` (4.1+), `vhost_max` and `runtime_parameters.limits.$category` (`rabbit.schema@v4.2.9`; `cluster_exchange_limit` is absent in 4.0.9) [R16][A12].

### 5.4 Resulting capability flags (suggested)

| Area | Flags |
| --- | --- |
| Identity and product | `product{rabbitmq,tanzu,lavinmq,apsara}`, `provider{amazonmq,cloudamqp-shared,cloudamqp-dedicated,ibm,k8s-operator,bitnami,stackhero,self}`, `version` |
| Access and topology | `role{admin,monitoring,policymaker,management}`, `lbFronted`, `nodeCount` |
| Protocols and features | `amqp10`, `streamProtocol{reachable,advertisedOk}`, `streamsSupported`, `prometheus{url[],auth,detailed,queueFilter,perObject}`, `eventExchange`, `firehose{available,partial}`, `shovel{dynamic,local,quota}` |
| Restrictions and policies | `opPolicyEditable`, `qqReplicaOps`, `definitionsApi`, `healthChecks[]`, `featureFlagsReadable/Enable`, `defaultQueueType`, `limits{…}`, `providerOwnedObjects[]` |
| Auth and TLS | `auth{basic,oauth2,iam,external}`, `tls{customCA,serverNameOverride}` |

---

## 6. Per provider: what to hide or degrade

**Amazon MQ 3.13**
- **Hide:**
  - stream browser and stream tooling [A25];
  - event-exchange audit: use snapshot-diff audit plus the team server's own audit, with an optional CloudWatch Logs adapter;
  - Prometheus history: sample the management API every 60 s or slower into the built-in store, with an optional CloudWatch adapter [A14];
  - local shovels;
  - HTTP-backend and X.509 login options (4.x only).
- **Degrade:**
  - **Firehose:** experimental, admin-only. Full only on single-instance brokers; labelled partial on clusters. Auto-off timer. Preserve vhost metadata.
  - **Operator-policy editor:** read-only, with remediation text (`management.restrictions.operator_policy_changes.disabled=false` plus a reboot).
  - **Policy editor:** warn that on clusters AWS appends HA keys and that AWS default policies exist.
  - **Quorum-queue replica operations:** hidden.
  - **Feature-flag enable:** behind an advanced setting, with the Khepri upgrade warning.
  - **Redrive:** republishing from our engine is the default. The shovel mode targets only public or Amazon MQ destinations, with unverified outbound TLS.
- **Works:**
  - peek, tap and publish;
  - users and permissions (no `guest`, no impersonator tag);
  - vhost limits and definitions;
  - OAuth2, IAM and LDAP.

**Amazon MQ 4.2 / 4.3**
- **Hide:**
  - streams;
  - event-exchange audit;
  - `x-local-random` in the routing simulator, with an "unsupported on Amazon MQ" note [A2];
  - creating transient non-exclusive queues and global QoS on 4.3 [A4].
- **Degrade:**
  - **Peek on quorum queues:** most queues are quorum queues with delivery-limit 20 (4.2 counter semantics apply), so use strict caps and warnings.
  - **Tap:** one consumer per channel (default limit 10). Check budgets against queue, exchange and connection limits; m7g.medium allows only 100 connections per node and 100 queues.
  - **Prometheus:** use the provider ports, scrape per node every 60 s or slower, and never use `/metrics/per-object`.
  - **Shovels:** they consume the per-node quota and use verify_peer for outbound TLS.
  - **Republish:** fails above 512 KiB by default.
  - **Redrive into queues covered by AWS default policies:** these are max-length + reject-publish, so handle broker nacks by pausing and reporting.
- **Works:**
  - the AMQP 1.0 client on 5671;
  - local shovels;
  - OAuth2, IAM, LDAP, HTTP auth and mTLS/EXTERNAL;
  - Prometheus history.

**CloudAMQP shared**
- **Hide:**
  - users, vhosts and permissions;
  - definitions import;
  - firehose, event audit and Prometheus;
  - feature-flag enable, quorum-queue replica operations and rebalance;
  - OAuth login;
  - plugin-dependent features.
- **Degrade:**
  - **Definitions export:** offer a synthetic export of the tenant's own vhost.
  - **Peek and tap:** meter against the monthly message quota and the queued-message cap.
  - **Connections:** use one AMQP connection (20 or 100 allowed) and stay at 200 channels or fewer.
  - **Temporary queues:** they expire after 60 s.
  - **Metrics:** sample the management API.
- **Works:**
  - peek and publish;
  - small taps;
  - health checks with the management tag (cluster-wide, multi-tenant).

**CloudAMQP dedicated**
- **Works:**
  - nearly everything, including event-exchange audit (on by default);
  - Prometheus at `https://<host>-0N.rmq.cloudamqp.com/metrics`;
  - firehose (console, or HTTP with the node-local caveat);
  - streams once the plugin is enabled and 5551/5552 are opened;
  - OAuth2 on 3.13+.
- **Degrade:** plugins, firewall and configuration can only be changed through the CloudAMQP console or API. Link to them, or integrate the CloudAMQP API.

**LavinMQ**
- **Hide:**
  - AMQP 1.0 and the stream protocol;
  - firehose and event audit;
  - feature flags and deprecated features;
  - the health-check panel (use aliveness-test instead);
  - quorum-queue operations, rebalance and quorum-specific UI;
  - user limits and topic permissions.
- **Degrade:**
  - **Peek:** never send `ack_requeue_true`. Use AMQP get + nack(requeue), or HTTP `reject_requeue_true` with `"requeue": true`.
  - **Stream browser:** use AMQP 0-9-1 `x-stream-offset`/`x-stream-filter`, or `POST /api/queues/{v}/{q}/stream`.
  - **Prometheus:** names start with `lavinmq_`; the endpoint is localhost-bound when self-hosted.
  - **Shovels:** use LavinMQ's key schema.
  - **Definitions import:** stricter than RabbitMQ.
- **Add:** LavinMQ-specific actions: queue pause, resume and restart; consumer cancel; the unacked view [L1].

**IBM Messages for RabbitMQ**
- **Hide:**
  - Prometheus: link to IBM Cloud Monitoring instead;
  - event audit;
  - federation;
  - stream protocol;
  - plugin toggles.
- **Degrade:**
  - **Streams:** over AMQP 0-9-1.
  - **Service-credential users** (monitoring tag): read-mostly mode.
  - **TLS:** importing the custom CA from the connection string is mandatory.
- **Works:**
  - peek and tap;
  - shovel redrive;
  - definitions and users, with the `admin` user.

**Tanzu RabbitMQ**
- **Works:** everything.
- **Commercial integrations:** offer Stream Browser, Warm Standby Replication and JMS queues as detected integrations rather than reimplementing them.

**Tanzu Platform service keys**
- **Hide:** the administrator surface: users, definitions, firehose, operator policies, feature-flag enable and quorum-queue operations.
- **Allowed:** policies and shovel parameters (policymaker tag).

**Cluster Operator**
- **Works:** everything, with plugin opt-ins.
- **Degrade:**
  - **Per-pod scope:** metrics, health and firehose are per-pod unless the engine runs in-cluster. The team server should be deployed in-cluster, or the desktop should port-forward per pod.
  - **Stream protocol over a port-forward:** needs an address resolver, or fall back to AMQP.
  - **Topology Operator drift:** warn when kubeconfig access shows a matching CR.
  - **Feature-flag enable:** redundant, because the operator enables all flags.

**Bitnami Helm**
- **Works:** everything, with opt-ins.
- **Degrade:**
  - **Prometheus:** off by default; when enabled it is on 9419. Show the enable instructions.
  - **Version gating:** expect 4.1.x or older images, so gate 4.2/4.3-only features by version.

**StackHero**
- Treat as self-hosted with an administrator account until the probes say otherwise.

**ApsaraMQ**
- **AMQP-only mode:** peek, tap and publish over AMQP 0-9-1.
- **Caveat:** basic.cancel requeues messages already delivered.
- **Unavailable:** all management-API features.

---

## 7. Managed versus self-hosted share: evidence

- **No public survey quantifies the split** between managed and self-hosted RabbitMQ.
- Proxies:
  - **Docker Hub pulls** (2026-10-16):

| Image | Pulls | Note |
| --- | --- | --- |
| `library/rabbitmq` | **3,892,782,061** | [D1] |
| `bitnami/rabbitmq` | 658,477,522 | last updated 2025-09-03 [D2] |
| `bitnamilegacy/rabbitmq` | 6,714,376 | [D3] |
| `rabbitmqoperator/cluster-operator` | 167,064,234 | [D4] |
| `rabbitmqoperator/messaging-topology-operator` | 5,390,188 | [D5] |
| `cloudamqp/lavinmq` | 844,152 | [D6] |

    These counts are inflated by CI pulls but show that container and Kubernetes self-hosting dominates by volume.
  - **Managed:**
    - 84codes (CloudAMQP) states "31,000+ Running Brokers" and "4,100+ Happy Customers", across RabbitMQ and LavinMQ [C19]. CloudAMQP claims "13,000+ users" [C20].
    - Amazon MQ publishes no broker counts.
    - GitHub stars: cluster-operator 1,120; LavinMQ 1,031.
  - **INF:** design for self-hosted and Kubernetes first.

---

## 8. Source index

**Amazon MQ** (`https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/…`)

| Key | Page |
| --- | --- |
| A1 | amazon-mq-release-notes.html |
| A2 | rabbitmq-4.html |
| A3 | rabbitmq-42.html |
| A4 | rabbitmq-43.html |
| A5 | rabbitmq-basic-elements-plugins.html |
| A6 | rabbitmq-supported-protocols.html |
| A7 | rabbitmq-defaults-applying-policies.html |
| A8 | rabbitmq-defaults.html |
| A9 | rabbitmq-resource-limits-configuration.html |
| A10 | rabbitmq-resource-hard-limit.html |
| A11 | configurable-values.html |
| A12 | configure-resource-limits.html |
| A13 | rabbitmq-simple-auth-broker-users.html |
| A14 | rabbitmq-prometheus-metrics.html |
| A15 | iam-for-amq-for-rabbitmq.html and rabbitmq-iam-tutorial.html |
| A16 | rabbitmq-authentication.html |
| A17 | rabbitmq-broker-architecture.html |
| A18 | configuring-private-broker.html |
| A19 | connect-to-amazonmq.html |
| A20 | amazon-mq-certificates.html |
| A21 | amazon-mq-limits.html |
| A22 | troubleshooting-action-required-codes-rabbitmq-not-upgradeable-to-v4.html |
| A23 | upgrading-rabbitmq-v3-to-v4-inplace.html |
| A24 | troubleshooting-rabbitmq.html |
| A25 | best-practices-rabbitmq.html |
| A26 | general.html |
| A27 | configure-mtls.html |
| A28 | ssl-for-amq-for-rabbitmq.html |
| A29 | oauth-for-amq-for-rabbitmq.html and oauth-tutorial.html |
| A30 | rabbitmq-amqp-client-ssl-configuration.html |
| A31 | private-networking.html |
| A32 | quorum-queues-best-practices.html |
| A33 | quorum-queues-migration.html |
| A38 | http-for-amq-for-rabbitmq.html |
| A39 | ldap-for-amq-for-rabbitmq.html |

Other Amazon MQ sources:

| Key | Source |
| --- | --- |
| A34 | https://aws.amazon.com/amazon-mq/features/ |
| A35 | https://aws.amazon.com/about-aws/whats-new/2026/09/amazon-mq-rabbitmq-43/ |
| A36 | https://aws.amazon.com/blogs/big-data/iam-authentication-with-oauth-2-0-for-amazon-mq-for-rabbitmq/ |
| A37 | https://github.com/amazon-mq/rabbitmq-queue-migration (docs/HTTP_API.md) |
| A40 | https://github.com/amazon-mq/rabbitmq-stream-s3 |

**CloudAMQP and 84codes**

| Key | Source |
| --- | --- |
| C1 | https://www.cloudamqp.com/docs/cloudamqp-plugins/ |
| C2 | https://www.cloudamqp.com/docs/protocols/ |
| C3 | https://www.cloudamqp.com/docs/stream-queues/ |
| C4 | https://www.cloudamqp.com/docs/faq/ |
| C5 | https://www.cloudamqp.com/docs/cloudamqp-firewall/ |
| C6 | https://www.cloudamqp.com/docs/cloudamqp-vpc-connect/ |
| C7 | https://www.cloudamqp.com/docs/cloudamqp-metrics/ |
| C8 | https://www.cloudamqp.com/blog/prometheus-and-grafana/ |
| C9 | https://www.cloudamqp.com/docs/cloudamqp-configuration/ |
| C10 | https://www.cloudamqp.com/docs/cloudamqp-oauth2/ |
| C11 | https://www.cloudamqp.com/plans.html |
| C12 | https://www.cloudamqp.com/blog/shared-vs-dedicated-plan.html |
| C13 | https://www.cloudamqp.com/blog/new-limit-for-shared-plans.html |
| C14 | https://www.cloudamqp.com/changelog/ |
| C15 | https://www.cloudamqp.com/docs/cloudamqp-definitions/ |
| C16 | https://www.cloudamqp.com/docs/http/ |
| C17 | https://www.cloudamqp.com/docs/cloudamqp-custom-domain/ |
| C18 | https://www.cloudamqp.com/docs/cloudamqp-vpc/ |
| C19 | https://www.84codes.com/ |
| C20 | https://www.cloudamqp.com/ |
| C-vers | https://www.cloudamqp.com/docs/cloudamqp-versions/ |

**LavinMQ** (v2.10.2 tree)

| Key | Source |
| --- | --- |
| L1 | https://github.com/cloudamqp/lavinmq/tree/v2.10.2/src/lavinmq/http/controller |
| L2 | …/controller/queues.cr |
| L3 | …/views/queue.shtml |
| L4 | …/controller/main.cr |
| L5 | …/src/lavinmq/queue_factory.cr |
| L6 | …/src/lavinmq/vhost.cr |
| L7 | README.md |
| L8 | docs/monitoring.md |
| L9 | docs/queues.md |
| L10 | docs/users-permissions.md |
| L11 | docs/definitions.md |
| L12 | src/lavinmq/shovel/store.cr |
| L13 | https://lavinmq.com/documentation/lavinmq-ports |

**RabbitMQ** (`https://github.com/rabbitmq/rabbitmq-server/blob/<tag>/…`)

| Key | Source |
| --- | --- |
| R1 | deps/rabbitmq_management/src/rabbit_mgmt_dispatcher.erl @ v3.13.7 / v4.0.9 / v4.1.8 / v4.2.9 / v4.3.6 |
| R2 | rabbit_mgmt_features.erl@v4.3.6 |
| R3 | rabbit_mgmt_wm_operator_policy.erl@v4.3.6 |
| R4 | rabbit_mgmt_wm_quorum_queue_replicas_add_member.erl@v4.3.6 |
| R5 | rabbit_mgmt_wm_environment.erl@v4.3.6 |
| R6 | rabbit_mgmt_wm_overview.erl@v4.3.6 |
| R7 | rabbit_mgmt_wm_vhost.erl, deps/rabbit/src/rabbit_vhost.erl and vhost.erl @ v4.3.6 (+ v3.13.7) |
| R8 | deps/rabbit/src/rabbit_trace.erl@v4.3.6 |
| R9 | deps/rabbit/src/rabbit_amqqueue.erl @ v3.13.7 / v4.2.9 / v4.3.6 |
| R10 | rabbit_quorum_queue.erl and rabbit_queue_type.erl @ v4.2.9 |
| R11 | deps/rabbitmq_prometheus/src/rabbit_prometheus_handler.erl @ v4.2.9 / v4.3.6 |
| R12 | rabbit_prometheus_app.erl@v4.2.9 |
| R13 | rabbit_mgmt_wm_definitions.erl |
| R14 | rabbit_mgmt_wm_queue_get.erl@v4.3.6 |
| R15 | deps/rabbitmq_management/priv/schema/rabbitmq_management.schema@v4.3.6 |
| R16 | deps/rabbit/priv/schema/rabbit.schema @ v4.2.9 / v4.3.6 |
| R17 | release-notes/4.2.0.md |
| R18 | rabbit_mgmt_external_stats.erl@v4.3.6 |
| R19 | deps/rabbitmq_web_dispatch/src/rabbit_web_dispatch_access_control.erl@v4.3.6 |
| R20 | web_ui() in rabbitmq_shovel_management, rabbitmq_federation_management, rabbitmq_stream_management (rabbit_stream_connections_mgmt.erl), rabbitmq_top, rabbitmq_tracing @ v4.3.6 |
| R21 | rabbit_mgmt_oauth_bootstrap.erl@v4.2.9 |
| R22 | deps/rabbit/src/rabbit_amqqueue_process.erl@v4.2.9 |
| R23 | https://github.com/rabbitmq/rabbitmq-website/blob/main/docs/maxlength/index.md (L62-64) |
| R24 | deps/rabbitmq_event_exchange/priv/schema/rabbitmq_event_exchange.schema and rabbit_exchange_type_event.erl @ v4.3.6 |
| R25 | deps/rabbit/Makefile@v4.2.9 (default_user_tags) |
| R-tags | rabbit_mgmt_wm_parameter.erl@v4.3.6 (is_authorized_policies) |

**Kubernetes**

| Key | Source |
| --- | --- |
| K1 | https://github.com/rabbitmq/cluster-operator/blob/v2.23.1/internal/resource/service.go |
| K2 | …/api/v1beta1/rabbitmqcluster_types.go |
| K3 | …/internal/resource/configmap.go |
| K4 | …/internal/controller/reconcile_cli.go |
| K5 | …/internal/resource/default_user_secret.go |
| K6 | https://github.com/rabbitmq/messaging-topology-operator/blob/v1.20.4/cmd/main.go (+ internal/controller/common.go) |
| K7 | https://github.com/kubernetes-sigs/controller-runtime/blob/v0.25.2/pkg/cache/cache.go |

**Bitnami**

| Key | Source |
| --- | --- |
| B1 | https://github.com/bitnami/containers/issues/83267 |
| B2 | https://github.com/bitnami/charts/blob/main/bitnami/rabbitmq/values.yaml |
| B3 | …/Chart.yaml |
| B4 | …/templates/_helpers.tpl |
| B5 | …/README.md |
| B6 | https://github.com/bitnami/charts/pull/36507 |

**IBM** (`https://github.com/ibm-cloud-docs/messages-for-rabbitmq/blob/master/…`, rendered at cloud.ibm.com/docs/messages-for-rabbitmq)

| Key | File |
| --- | --- |
| I1 | howto-plugins.md |
| I2 | howto-user-management.md |
| I3 | connecting-external.md |
| I4 | howto-getting-connection-strings.md |
| I5 | learn-security-compliance.md |
| I6 | release-notes.md |
| I7 | howto-streams.md |

**Tanzu**

| Key | Source |
| --- | --- |
| T1 | https://techdocs.broadcom.com/us/en/vmware-tanzu/data-solutions/tanzu-rabbitmq-oci/4-3/tanzu-rabbitmq-oci-image/site-tanzu-rabbitmq-features.html |
| T2 | …/site-release-notes.html |
| T3 | https://techdocs.broadcom.com/us/en/vmware-tanzu/platform/tanzu-rabbitmq-tanzu-platform/10-1/rabbitmq-tp/policies-od.html |

**StackHero, Alibaba, Docker Hub and npm**

| Key | Source |
| --- | --- |
| S1 | https://www.stackhero.io/en-US/services/RabbitMQ/documentations |
| S2 | …/documentations/Getting-started |
| X1 | https://www.alibabacloud.com/help/en/apsaramq-for-rabbitmq/product-overview/comparison-between-apsaramq-for-rabbitmq-and-open-source-rabbitmq |
| D1 | https://hub.docker.com/v2/repositories/library/rabbitmq/ |
| D2 | …/bitnami/rabbitmq/ |
| D3 | …/bitnamilegacy/rabbitmq/ |
| D4 | …/rabbitmqoperator/cluster-operator/ |
| D5 | …/rabbitmqoperator/messaging-topology-operator/ |
| D6 | …/cloudamqp/lavinmq/ |
| N1 | https://registry.npmjs.org/amqplib (2.2.0; lib/connect.js frameMax default 131072) |
| N2 | https://unpkg.com/@aws-sdk/client-sts/dist-types/commands/ (GetWebIdentityTokenCommand present in 3.1152.0) |

## Design implications

- Run a capability probe on every connect, before any feature is shown. It produces a cached BrokerProfile: product, provider, version, role/tags, LB-fronted?, node count, extensions, plugins, restrictions, limits, auth and TLS facts. Gate every feature on detected capabilities, not on product names. Each gate carries a 'why disabled' reason with a source link.
- Build the default product on the no-plugin core: peek, exclusive taps, republish from our engine with confirms, and topology export/diff from list endpoints. These work on Amazon MQ, CloudAMQP (shared and dedicated), IBM, LavinMQ (with adaptations), Tanzu and Kubernetes. Make firehose, event-exchange audit, Prometheus history, the stream protocol and shovel-based redrive capability-gated enhancements.
- HTTP peek safety: send product-specific ackmodes, and always include "requeue": true in POST /api/queues/{v}/{q}/get bodies. LavinMQ treats ack_requeue_true as reject-without-requeue and a missing ackmode as ack. Never call /get without an explicit ackmode. Prefer AMQP basic.get + nack(requeue) for RabbitMQ.
- Declare tap queues deterministically: exclusive=true, auto_delete=true, x-queue-type=classic, x-expires, a small x-max-length, and x-overflow=drop-head. The queue argument beats provider policies such as Amazon MQ's overflow=reject-publish, which could otherwise nack production publishers. Use a configurable name prefix (e.g. <tool>.tap.<uuid>) so admins can grant narrow configure permissions.
- Budget broker resources. Use one consumer per channel (Amazon MQ 4.x defaults to 10 consumers per channel) and a single pooled AMQP connection per broker per engine. Count temp queues and exchanges against cluster_queue_limit/cluster_exchange_limit. Learn limits from error signatures and show usage versus limits. CloudAMQP shared allows 20/100 connections and 200 channels per connection, and counts consumed messages toward the monthly quota.
- Firehose: offer it only to admins. Toggle it with GET-then-PUT that resends description, tags and default_queue_type, because PUT /api/vhosts with only tracing wipes the vhost's description and tags. Label it 'partial (node-local)' when the cluster is LB-fronted. Always auto-disable it (timer, disconnect, app exit), since it is not persisted and has CPU cost. Hide it on LavinMQ, CloudAMQP shared and Tanzu Platform service keys.
- Audit timeline, tiered by what the broker offers. Best: amq.rabbitmq.event (CloudAMQP dedicated has it on by default; self-hosted and Kubernetes need an opt-in). Otherwise: the tool's own audit log plus periodic snapshot diffs of definitions/lists. Optional: provider log adapters (CloudWatch Logs for Amazon MQ, CloudAMQP log integrations).
- Metrics: discover Prometheus endpoints through provider adapters first, then overview listeners ('http/prometheus'), then defaults (15692/15691, 9419 for Bitnami, 127.0.0.1:15692 for LavinMQ). Known provider endpoints: Amazon MQ uses ports 16001-16003 from DescribeBroker; CloudAMQP uses https://host-0N.rmq.cloudamqp.com/metrics. Support basic auth with monitoring credentials and TLS. Scrape each node individually; never rely on a Service or LB. Fall back to built-in history from management API sampling, at 60 s or slower on Amazon MQ. Never call /metrics/per-object on Amazon MQ. Use the queue= filter only on 4.3+.
- Stream browser: gate it on stream support, which is absent on Amazon MQ. Then pick the first read path that works: the stream protocol (only if listeners are present and every advertised host:port is reachable), AMQP 1.0 (4.x; filters in 4.1/4.2+), AMQP 0-9-1 x-stream-offset, or LavinMQ's POST /api/queues/{v}/{q}/stream.
- Redrive: republishing from our engine with confirms and throttling is the universal default. It must handle max_message_size rejections (Amazon MQ 4.x defaults to 512 KiB) and broker nacks from reject-publish policies. Offer shovel mode only when a shovel plugin and quota exist. Prefer local shovels on 4.2+ to avoid outbound TLS verification problems on Amazon MQ 4.x. Implement LavinMQ's separate shovel schema.
- Definitions and topology-as-code: use /api/definitions only with the administrator tag. For management or policymaker users (CloudAMQP shared, Tanzu Platform keys, IBM service credentials), build a synthetic export from list endpoints. The diff and apply engine must exclude or annotate provider-owned objects (AWS-DEFAULT-*, default_operator_policy_AWS_managed, monitoring-AWS-OWNED-DO-NOT-DELETE, IBM 'ibm', protected users). It must normalise provider-injected policy keys (ha-mode/ha-sync-mode on Amazon MQ 3.x clusters) and flag Kubernetes CR-owned objects when kubeconfig is available.
- Policy tooling: read operator policies only through the list endpoint, because single GETs return 405 when restricted. Gate editing on overview.is_op_policy_updating_enabled. On Amazon MQ, show the exact remediation (configuration revision management.restrictions.operator_policy_changes.disabled=false, then reboot). The effective-policy debugger must include provider default and operator policies.
- User management: hide it without the administrator tag. Render protected users (4.2+) read-only. On Amazon MQ, block creating 'guest' and assigning the impersonator tag. Never modify IBM's internal 'ibm' user or AWS system users.
- Feature flags: show them read-only by default, plus deprecated-features linting. Enabling a flag requires a typed confirmation and provider-specific warnings: on Amazon MQ 3.13, enabling khepri_db blocks the in-place upgrade to 4.2; the Kubernetes operator enables all flags anyway; there is no endpoint on LavinMQ.
- Health and cluster operations: when LB-fronted, use cluster-wide sources (/api/nodes, alarms) rather than node-local checks, and label node-local results. Probe quorum-queue replica operations only on demand, using a nonexistent queue (405 means restricted). Hide replica operations and rebalance on single-node brokers and, by default, on Amazon MQ (AWS manages replication factor 3).
- Authentication: support basic auth, OAuth2 (Bearer for HTTP; JWT as password for AMQP; refresh via update-secret for AMQP 0-9-1 and token PUT for AMQP 1.0), AWS IAM, and mTLS/SASL EXTERNAL client certificates on both HTTPS and AMQPS. AWS IAM uses STS GetWebIdentityToken via @aws-sdk/client-sts; tokens last 300-3600 s, so plan for refresh. Discover OAuth through /js/oidc-oauth/bootstrap.js on 3.13-4.3 and /api/auth on 4.1 and earlier.
- TLS and networking: per-connection CA bundles; one-click import of the IBM CA from its connection string; certificate diagnostics; no leaf pinning (Amazon MQ rotates per-broker certificates). Support a TLS server-name override for VPC-endpoint DNS names, port-forwards and IPs. Build in SOCKS5/HTTP CONNECT proxies and SSH tunnels; AWS itself documents ssh -D plus SOCKS5 for private brokers. Support per-pod Kubernetes port-forwards. Recommend deploying the team server inside the broker's VPC or cluster.
- Provider adapters (optional, read-only by default). AWS: ListBrokers/DescribeBroker for endpoints including Prometheus, engine version, deployment mode and instance type, mapped to Amazon MQ limit tables. CloudAMQP API: instances, plugins, firewall, per-node hosts. Kubernetes: RabbitmqCluster discovery, default-user Secret, per-pod endpoints, Topology CR ownership. Also detect Amazon MQ's /api/queue-migration plugin for the upgrade advisor.
- Upgrade advisor content for managed providers. Amazon MQ: 3.13 to 4.2 readiness (classic mirrored queues, Khepri, headroom against the much lower 4.x default limits); 4.2 to 4.3 breaking changes (transient non-exclusive queues, global QoS, CQv1, classic-queue consumer timeout). Bitnami: images frozen at 4.1.x or older, so recommend moving to the official image or the operator.
- Keep the supported version window at 3.13 through 4.3, with 4.4 readiness. Amazon MQ and IBM still offer 3.13, and Bitnami legacy images pin 4.1.x or older. Gate 4.0+ (default_queue_type, /api/version), 4.1+ (cluster_exchange_limit, new health checks), 4.2+ (local shovels, protected tag, /api/auth removal) and 4.3+ (queue= Prometheus filter) behaviours on the detected version.
- Treat ApsaraMQ (and any broker whose management API returns 404 at /api/overview) as AMQP-only mode: peek, tap and publish only. ApsaraMQ's basic.cancel requeues messages already delivered.
- Publish the provider × capability matrix in the documentation and in-app. It is a credible differentiator against which documents only username/password plus an AMQP URI. Include automated contract tests against Amazon MQ (3.13, 4.2, 4.3; single and cluster), CloudAMQP shared and dedicated, LavinMQ, and Kubernetes operator brokers.

## Open questions

- Amazon MQ: are PUT /api/vhosts {tracing:true}, PUT /api/feature-flags/{name}/enable, quorum-queue replica add/delete/grow/shrink, POST /api/rebalance/queues, GET /api/config/effective and /api/health/checks/* permitted, or intercepted by AWS? Is management.restrictions.quorum_queue_replica_operations.disabled set? Needs empirical testing on 3.13, 4.2 and 4.3, single-instance and cluster.
- Amazon MQ: what product_name and cluster_name do brokers report? Is shovel_management (/api/shovels, shovel.js) enabled? Do AWS default cluster policies (max-length plus reject-publish) actually match exclusive server-named tap queues, and what are their exact pattern and apply-to on 4.x?
- Amazon MQ: does the single-instance 4.x Prometheus endpoint expose only port 16001? Do private brokers expose 16001-16003 through the same VPC endpoint and security group? Is the endpoint accessible with OAuth/IAM tokens, and with which tag (monitoring)?
- Amazon MQ: does an exclusive queue declared without x-queue-type under the 4.x quorum default really become classic, as the source read predicts? Do such temp queues count toward cluster_queue_limit, and do they trigger the default operator policy {queue-version:2}?
- CloudAMQP shared plans: which tags does the tenant user have (management only, or policymaker)? Can tenants create policies or dynamic shovels, declare stream queues over AMQP 0-9-1, and access amq.rabbitmq.event? Does the HTTP API have undocumented rate limits?
- CloudAMQP dedicated: does the default instance user carry the administrator tag (inferred, not documented)? Does HTTP-toggled firehose behave node-locally on multi-node clusters behind their LB? What stream protocol advertised_host do clusters use (public per-node hostnames?), and are 5551/5552 open by default or only after a firewall rule?
- LavinMQ: how compatible is its definitions JSON with RabbitMQ in both directions? Does ?prefix=rabbitmq on /metrics yield RabbitMQ-compatible metric names and semantics? What exactly do the HTTP /stream endpoint and x-stream-filter do? Does dead-lettering produce RabbitMQ-compatible x-death headers?
- IBM Messages for RabbitMQ: management HTTP port and path; whether the admin user can toggle firehose or enable feature flags; quorum-queue replica operations; any connection or queue limits per plan; OAuth support.
- StackHero, Huawei Cloud DMS for RabbitMQ and Tencent TDMQ for RabbitMQ: plugin sets, ports (5552, 15692), admin rights and TLS chains were not verified. StackHero's docs render client-side; Huawei and Tencent were not researched.
- Tanzu RabbitMQ: exact product_name strings and extra management endpoints (Warm Standby Replication, Schema Definition Sync, Stream Browser) worth integrating. Do Tanzu Platform on-demand plans expose Prometheus or the stream protocol to service-key users?
- Messaging Topology Operator: which CR types re-assert overwritten state on resync (policies, users and permissions surely; queues and exchanges cannot change arguments)? Do any objects carry markers detectable through the RabbitMQ API alone, without Kubernetes access?
- Managed versus self-hosted share: no survey found. Consider asking CloudAMQP/84codes and AWS for anonymised version and plan distributions, or running our own community survey; Docker Hub pull counts are only a weak proxy.
- Lab confirmation of the source-read findings (firehose vhost-metadata wipe, policy precedence on taps, multi-queue nack from reject-publish, LavinMQ get semantics) on real brokers: 3.13.7, 4.2.9 and 4.3.6, plus LavinMQ 2.10.2.

## Sources

- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/amazon-mq-release-notes.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-4.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-42.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-43.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-basic-elements-plugins.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-supported-protocols.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-defaults-applying-policies.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-defaults.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-resource-limits-configuration.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-resource-hard-limit.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/configurable-values.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/configure-resource-limits.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-simple-auth-broker-users.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-prometheus-metrics.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/iam-for-amq-for-rabbitmq.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-iam-tutorial.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-authentication.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-broker-architecture.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/configuring-private-broker.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/connect-to-amazonmq.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/amazon-mq-certificates.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/amazon-mq-limits.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/troubleshooting-action-required-codes-rabbitmq-not-upgradeable-to-v4.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/upgrading-rabbitmq-v3-to-v4.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/upgrading-rabbitmq-v3-to-v4-inplace.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/troubleshooting-rabbitmq.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/best-practices-rabbitmq.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/general.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/configure-mtls.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/ssl-for-amq-for-rabbitmq.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/oauth-for-amq-for-rabbitmq.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/oauth-tutorial.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/http-for-amq-for-rabbitmq.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/ldap-for-amq-for-rabbitmq.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-amqp-client-ssl-configuration.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/private-networking.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/quorum-queues.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/quorum-queues-best-practices.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/quorum-queues-migration.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-version-management.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/toc-contents.json
- https://aws.amazon.com/amazon-mq/features/
- https://aws.amazon.com/about-aws/whats-new/2026/09/amazon-mq-rabbitmq-43/
- https://aws.amazon.com/about-aws/whats-new/2026/05/amazon-mq-inplace-upgrades-rabbitmq4/
- https://aws.amazon.com/blogs/big-data/iam-authentication-with-oauth-2-0-for-amazon-mq-for-rabbitmq/
- https://github.com/amazon-mq/rabbitmq-queue-migration
- https://raw.githubusercontent.com/amazon-mq/rabbitmq-queue-migration/main/docs/HTTP_API.md
- https://github.com/amazon-mq/rabbitmq-aws
- https://github.com/amazon-mq/rabbitmq-stream-s3
- https://github.com/amazon-mq/mcp-server-rabbitmq
- https://www.cloudamqp.com/docs/cloudamqp-plugins/
- https://www.cloudamqp.com/docs/protocols/
- https://www.cloudamqp.com/docs/stream-queues/
- https://www.cloudamqp.com/docs/faq/
- https://www.cloudamqp.com/docs/faq-rabbitmq/
- https://www.cloudamqp.com/docs/cloudamqp-firewall/
- https://www.cloudamqp.com/docs/cloudamqp-vpc-connect/
- https://www.cloudamqp.com/docs/cloudamqp-vpc/
- https://www.cloudamqp.com/docs/cloudamqp-metrics/
- https://www.cloudamqp.com/docs/cloudamqp-integrations/
- https://www.cloudamqp.com/blog/prometheus-and-grafana/
- https://www.cloudamqp.com/docs/cloudamqp-configuration/
- https://www.cloudamqp.com/docs/cloudamqp-oauth2/
- https://www.cloudamqp.com/docs/cloudamqp-versions/
- https://www.cloudamqp.com/docs/cloudamqp-definitions/
- https://www.cloudamqp.com/docs/http/
- https://www.cloudamqp.com/docs/cloudamqp-custom-domain/
- https://www.cloudamqp.com/plans.html
- https://www.cloudamqp.com/blog/shared-vs-dedicated-plan.html
- https://www.cloudamqp.com/blog/new-limit-for-shared-plans.html
- https://www.cloudamqp.com/blog/added-limits-for-shared-plans-lemur-tiger.html
- https://www.cloudamqp.com/changelog/
- https://www.cloudamqp.com/blog/annual-amqp-report-2024-by-cloudamqp.html
- https://www.cloudamqp.com/
- https://www.84codes.com/
- https://github.com/cloudamqp/lavinmq/tree/v2.10.2/src/lavinmq/http/controller
- https://raw.githubusercontent.com/cloudamqp/lavinmq/v2.10.2/src/lavinmq/http/controller/queues.cr
- https://raw.githubusercontent.com/cloudamqp/lavinmq/v2.10.2/views/queue.shtml
- https://raw.githubusercontent.com/cloudamqp/lavinmq/v2.10.2/src/lavinmq/http/controller/main.cr
- https://raw.githubusercontent.com/cloudamqp/lavinmq/v2.10.2/src/lavinmq/queue_factory.cr
- https://raw.githubusercontent.com/cloudamqp/lavinmq/v2.10.2/src/lavinmq/vhost.cr
- https://raw.githubusercontent.com/cloudamqp/lavinmq/v2.10.2/README.md
- https://raw.githubusercontent.com/cloudamqp/lavinmq/v2.10.2/docs/monitoring.md
- https://raw.githubusercontent.com/cloudamqp/lavinmq/v2.10.2/docs/queues.md
- https://raw.githubusercontent.com/cloudamqp/lavinmq/v2.10.2/docs/users-permissions.md
- https://raw.githubusercontent.com/cloudamqp/lavinmq/v2.10.2/docs/definitions.md
- https://raw.githubusercontent.com/cloudamqp/lavinmq/v2.10.2/src/lavinmq/shovel/store.cr
- https://github.com/cloudamqp/lavinmq/releases/tag/v2.10.2
- https://lavinmq.com/documentation/lavinmq-ports
- https://github.com/rabbitmq/rabbitmq-server/blob/v4.3.6/deps/rabbitmq_management/src/rabbit_mgmt_dispatcher.erl
- https://github.com/rabbitmq/rabbitmq-server/blob/v3.13.7/deps/rabbitmq_management/src/rabbit_mgmt_dispatcher.erl
- https://github.com/rabbitmq/rabbitmq-server/blob/v4.3.6/deps/rabbitmq_management/src/rabbit_mgmt_features.erl
- https://github.com/rabbitmq/rabbitmq-server/blob/v4.3.6/deps/rabbitmq_management/src/rabbit_mgmt_wm_operator_policy.erl
- https://github.com/rabbitmq/rabbitmq-server/blob/v4.3.6/deps/rabbitmq_management/src/rabbit_mgmt_wm_quorum_queue_replicas_add_member.erl
- https://github.com/rabbitmq/rabbitmq-server/blob/v4.3.6/deps/rabbitmq_management/src/rabbit_mgmt_wm_rebalance_queues.erl
- https://github.com/rabbitmq/rabbitmq-server/blob/v4.3.6/deps/rabbitmq_management/src/rabbit_mgmt_wm_environment.erl
- https://github.com/rabbitmq/rabbitmq-server/blob/v4.3.6/deps/rabbitmq_management/src/rabbit_mgmt_wm_overview.erl
- https://github.com/rabbitmq/rabbitmq-server/blob/v4.3.6/deps/rabbitmq_management/src/rabbit_mgmt_wm_vhost.erl
- https://github.com/rabbitmq/rabbitmq-server/blob/v4.3.6/deps/rabbit/src/rabbit_vhost.erl
- https://github.com/rabbitmq/rabbitmq-server/blob/v4.3.6/deps/rabbit/src/vhost.erl
- https://github.com/rabbitmq/rabbitmq-server/blob/v3.13.7/deps/rabbit/src/rabbit_vhost.erl
- https://github.com/rabbitmq/rabbitmq-server/blob/v4.3.6/deps/rabbit/src/rabbit_trace.erl
- https://github.com/rabbitmq/rabbitmq-server/blob/v4.2.9/deps/rabbit/src/rabbit_amqqueue.erl
- https://github.com/rabbitmq/rabbitmq-server/blob/v3.13.7/deps/rabbit/src/rabbit_amqqueue.erl
- https://github.com/rabbitmq/rabbitmq-server/blob/v4.3.6/deps/rabbit/src/rabbit_amqqueue.erl
- https://github.com/rabbitmq/rabbitmq-server/blob/v4.2.9/deps/rabbit/src/rabbit_quorum_queue.erl
- https://github.com/rabbitmq/rabbitmq-server/blob/v4.2.9/deps/rabbit/src/rabbit_queue_type.erl
- https://github.com/rabbitmq/rabbitmq-server/blob/v4.2.9/deps/rabbit/src/rabbit_amqqueue_process.erl
- https://github.com/rabbitmq/rabbitmq-server/blob/v4.2.9/deps/rabbitmq_prometheus/src/rabbit_prometheus_handler.erl
- https://github.com/rabbitmq/rabbitmq-server/blob/v4.3.6/deps/rabbitmq_prometheus/src/rabbit_prometheus_handler.erl
- https://github.com/rabbitmq/rabbitmq-server/blob/v4.2.9/deps/rabbitmq_prometheus/src/rabbit_prometheus_app.erl
- https://github.com/rabbitmq/rabbitmq-server/blob/v4.2.9/deps/rabbitmq_prometheus/priv/schema/rabbitmq_prometheus.schema
- https://github.com/rabbitmq/rabbitmq-server/blob/v4.3.6/deps/rabbitmq_management/src/rabbit_mgmt_wm_definitions.erl
- https://github.com/rabbitmq/rabbitmq-server/blob/v4.3.6/deps/rabbitmq_management/src/rabbit_mgmt_wm_queue_get.erl
- https://github.com/rabbitmq/rabbitmq-server/blob/v4.3.6/deps/rabbitmq_management/priv/schema/rabbitmq_management.schema
- https://github.com/rabbitmq/rabbitmq-server/blob/v4.2.9/deps/rabbit/priv/schema/rabbit.schema
- https://github.com/rabbitmq/rabbitmq-server/blob/v4.3.6/deps/rabbit/priv/schema/rabbit.schema
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.0/release-notes/4.2.0.md
- https://github.com/rabbitmq/rabbitmq-server/blob/v4.3.6/deps/rabbitmq_management_agent/src/rabbit_mgmt_external_stats.erl
- https://github.com/rabbitmq/rabbitmq-server/blob/v4.3.6/deps/rabbitmq_web_dispatch/src/rabbit_web_dispatch_access_control.erl
- https://github.com/rabbitmq/rabbitmq-server/blob/v4.3.6/deps/rabbitmq_stream_management/src/rabbit_stream_connections_mgmt.erl
- https://github.com/rabbitmq/rabbitmq-server/blob/v4.2.9/deps/rabbitmq_management/src/rabbit_mgmt_oauth_bootstrap.erl
- https://github.com/rabbitmq/rabbitmq-server/blob/v4.3.6/deps/rabbitmq_event_exchange/priv/schema/rabbitmq_event_exchange.schema
- https://github.com/rabbitmq/rabbitmq-server/blob/v4.2.9/deps/rabbit/Makefile
- https://github.com/rabbitmq/rabbitmq-website/blob/main/docs/maxlength/index.md
- https://github.com/rabbitmq/cluster-operator/blob/v2.23.1/internal/resource/service.go
- https://github.com/rabbitmq/cluster-operator/blob/v2.23.1/api/v1beta1/rabbitmqcluster_types.go
- https://github.com/rabbitmq/cluster-operator/blob/v2.23.1/internal/resource/configmap.go
- https://github.com/rabbitmq/cluster-operator/blob/v2.23.1/internal/controller/reconcile_cli.go
- https://github.com/rabbitmq/cluster-operator/blob/v2.23.1/internal/resource/default_user_secret.go
- https://github.com/rabbitmq/messaging-topology-operator/blob/v1.20.4/cmd/main.go
- https://github.com/rabbitmq/messaging-topology-operator/blob/v1.20.4/internal/controller/common.go
- https://github.com/kubernetes-sigs/controller-runtime/blob/v0.25.2/pkg/cache/cache.go
- https://github.com/bitnami/containers/issues/83267
- https://github.com/bitnami/charts/blob/main/bitnami/rabbitmq/values.yaml
- https://github.com/bitnami/charts/blob/main/bitnami/rabbitmq/Chart.yaml
- https://github.com/bitnami/charts/blob/main/bitnami/rabbitmq/templates/_helpers.tpl
- https://github.com/bitnami/charts/blob/main/bitnami/rabbitmq/README.md
- https://github.com/bitnami/charts/pull/36507
- https://github.com/ibm-cloud-docs/messages-for-rabbitmq/blob/master/howto-plugins.md
- https://github.com/ibm-cloud-docs/messages-for-rabbitmq/blob/master/howto-user-management.md
- https://github.com/ibm-cloud-docs/messages-for-rabbitmq/blob/master/connecting-external.md
- https://github.com/ibm-cloud-docs/messages-for-rabbitmq/blob/master/howto-getting-connection-strings.md
- https://github.com/ibm-cloud-docs/messages-for-rabbitmq/blob/master/learn-security-compliance.md
- https://github.com/ibm-cloud-docs/messages-for-rabbitmq/blob/master/release-notes.md
- https://github.com/ibm-cloud-docs/messages-for-rabbitmq/blob/master/howto-streams.md
- https://techdocs.broadcom.com/us/en/vmware-tanzu/data-solutions/tanzu-rabbitmq-oci/4-3/tanzu-rabbitmq-oci-image/site-tanzu-rabbitmq-features.html
- https://techdocs.broadcom.com/us/en/vmware-tanzu/data-solutions/tanzu-rabbitmq-oci/4-3/tanzu-rabbitmq-oci-image/site-release-notes.html
- https://techdocs.broadcom.com/us/en/vmware-tanzu/platform/tanzu-rabbitmq-tanzu-platform/10-1/rabbitmq-tp/policies-od.html
- https://www.stackhero.io/en-US/services/RabbitMQ/documentations
- https://www.stackhero.io/en-US/services/RabbitMQ/documentations/Getting-started
- https://www.alibabacloud.com/help/en/apsaramq-for-rabbitmq/product-overview/comparison-between-apsaramq-for-rabbitmq-and-open-source-rabbitmq
- https://hub.docker.com/v2/repositories/library/rabbitmq/
- https://hub.docker.com/v2/repositories/bitnami/rabbitmq/
- https://hub.docker.com/v2/repositories/bitnamilegacy/rabbitmq/
- https://hub.docker.com/v2/repositories/rabbitmqoperator/cluster-operator/
- https://hub.docker.com/v2/repositories/rabbitmqoperator/messaging-topology-operator/
- https://hub.docker.com/v2/repositories/cloudamqp/lavinmq/
- https://registry.npmjs.org/amqplib
- https://unpkg.com/@aws-sdk/client-sts/dist-types/commands/
