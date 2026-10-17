# RabbitMQ tools landscape

> **Pre-verification research (2026-10-16).** Where this conflicts with [`docs/research/fact-sheet.md`](../fact-sheet.md), the fact sheet wins. Content about a specific third-party product was removed under the docs policy ([ADR-034](../../adr/ADR-034-docs-policy.md)).

_Research angle `rabbitmq-tools-landscape` · 2026-10-16_

## Executive summary

No third-party RabbitMQ tool is the de facto standard today. FACT: the best-starred open-source RabbitMQ GUIs are RabbitScout (154★), RabbitLens (91★) and mq-studio (89★). Comparable UIs for Kafka and Redis have 2.8k–12.3k★ (AKHQ 3,860; Redpanda Console 4,336; RedisInsight 8,907; provectus kafka-ui 12,309). About 40 tools were reviewed. They fall into seven groups:

1. **Paid desktop workbenches for one user:** RMQ (macOS, $19.99), RabbitMQ Assistant ($49.99) and QueueExplorer ($149/$249, perpetual). QueueExplorer is the most complete message workbench, with stream browsing and definitions compare/sync in its Pro edition.
2. **A new paid JetBrains plugin, Queue Studio (Sept 2026):** it has a routing simulator, moves that only acknowledge the source after the broker confirms the copy, and peeks that do not use up a quorum queue's delivery limit.
3. **Small open-source web dashboards** that only wrap the management HTTP API.
4. **CLIs:** rabtap, rabbitmqadmin v2 and rabbitmq-dump-queue.
5. **SaaS consoles that are strong on operations but have no message tools:** CloudAMQP (alarms plus 23 diagnostic checks) and Amazon MQ.
6. **Error consoles:** ServicePulse is tied to NServiceBus/MassTransit; Warren is a new DLQ console that works with any client framework.
7. **MCP servers for AI agents:** amazon-mq/mcp-server-rabbitmq v4.

Five constraints should drive the design:
- **No safe browse API.** RabbitMQ has no way to read queue messages without side effects. The HTTP "get" changes queue state. Quorum queues have had a default delivery limit of 20 since 4.0, and before 4.3 every requeue counted toward it.
- **No stream browsing in the open-source UI.** Only the commercial Tanzu edition has a stream browser.
- **A web edition needs a server.** Browsers cannot speak AMQP to open-source RabbitMQ, so the web version needs a server-side gateway. That gateway is also the natural place for RBAC, SSO, audit and data masking.
- **AI tools need fixed connections.** CVE-2026-18655 showed that letting a model choose broker hostnames can leak credentials.
- **"Read-only" AI peeks are not read-only.** The Amazon MQ team's MCP server files its message peek under read-only tools, but it uses the state-changing HTTP get.

The gaps no tool fills well:
- one product with the same features on desktop and self-hosted web;
- team controls on message operations (RBAC, audit, four-eyes approval, PII masking), which only Warren offers, for DLQs, and mostly in unreleased paid tiers;
- a peek that adapts to the broker version and queue type;
- a GUI routing simulator, and a topology diff or drift check between environments;
- Protobuf/Avro decoding;
- alerting and best-practice checks for self-hosted brokers;
- a searchable history of messages after they are consumed;
- awareness of the Kubernetes operator;
- a safe MCP/AI layer tied to saved connections.

## Report

# RabbitMQ tools landscape (status 2026-10-16)

Scope: tools other than the official management UI. Both still appear as columns in the matrix.

## 0. Method and caveats

- **Sources.** Vendor sites, docs, release notes and store listings. GitHub metadata (stars, push dates, releases) was pulled read-only through the GitHub API on 2026-10-16.
- **Search budget ran out.** The shared WebSearch budget was used up partway through. The rest of the work used direct fetches of known primary URLs plus GitHub's own API.
- **IDE marketplaces only partly covered.** The JetBrains and VS Code marketplaces render with JavaScript and could not be read. IDE extensions were found through GitHub and Open VSX instead.
- **Mobile only partly covered.** Only Google Play search was checked.
- **Labels.** FACT = sourced. INFERENCE = my reasoning. IDEA = proposal.

## 1. Headline findings

1. **FACT: no third-party UI has real adoption.**
   - Top open-source RabbitMQ GUIs: [RabbitScout](https://github.com/Ralve-org/RabbitScout) 154★, [RabbitLens](https://github.com/huynhanx03/RabbitLens) 91★, [mq-studio](https://github.com/amigoer/mq-studio) 89★ (covers many brokers).
   - Kafka/Redis equivalents: [kafbat](https://github.com/kafbat/kafka-ui) 2,783★, [AKHQ](https://github.com/tchiotludo/akhq) 3,860★, [Redpanda Console](https://github.com/redpanda-data/console) 4,336★, [RedisInsight](https://github.com/redis/RedisInsight) 8,907★, [provectus kafka-ui](https://github.com/provectus/kafka-ui) 12,309★.
   - The most-starred tool that handles RabbitMQ messages, [Plumber](https://github.com/streamdal/plumber) (2,153★), covers several messaging systems and has been effectively unmaintained since its v2.9.0 release (2024-12-24).
2. **FACT: paid tools are single-user desktop apps with one-time licences from $19.99 to $249.** Examples: [RMQ](https://apps.apple.com/app/id6755972526), [RabbitMQ Assistant](https://www.redisant.com/rta) and [QueueExplorer](https://www.cogin.com/mq/buy.php). None has a web or team mode.
3. **FACT: tooling for teams is still early.**
   - The open-source web UIs use the user's own broker login and add no RBAC, SSO or audit of their own.
   - [Warren](https://warrenops.io) (a DLQ-only console) has announced RBAC, OIDC, four-eyes approval and 90-day audit for its Team/Pro tiers, but those tiers are "coming soon".
   - [ServicePulse](https://docs.particular.net/servicepulse/intro-failed-messages) only covers NServiceBus and MassTransit.
4. **FACT: RabbitMQ has no way to read queue messages without side effects.**
   - The HTTP API's `POST /api/queues/{vhost}/{name}/get` "will alter the state of the queue" and is for development and troubleshooting only ([HTTP API reference](https://www.rabbitmq.com/docs/http-api-reference)).
   - The open-source UI form warns that "getting messages from a queue is a destructive action" ([template](https://github.com/rabbitmq/rabbitmq-server/blob/main/deps/rabbitmq_management/priv/www/js/tmpl/classic-queue-get-message.ejs)).
   - The delivery-limit rules for quorum queues changed in 4.3 (see section 3).
5. **FACT: the open-source UI cannot browse streams.**
   - Its queue-type table sets `get_message:false` for streams ([global.js](https://github.com/rabbitmq/rabbitmq-server/blob/main/deps/rabbitmq_management/priv/www/js/global.js)).
   - A "Stream Browser" is a Tanzu (commercial) feature ([commercial features](https://www.rabbitmq.com/commercial-features)).
   - Third-party tools that read streams: QueueExplorer, Queue Studio, rabtap.
6. **FACT: AI/MCP tooling is real but risky.**
   - [amazon-mq/mcp-server-rabbitmq](https://github.com/amazon-mq/mcp-server-rabbitmq) v4.0.0 (2026-07-28) is the reference server.
   - The related [AWS Labs Amazon MQ MCP server had CVE-2026-18655](https://aws.amazon.com/security/security-bulletins/2026-070-aws/): a prompt injection could steer broker credentials or OAuth tokens to a hostname chosen by the attacker.
7. **INFERENCE: the gap is a combination no one ships.** That combination is:
   - a full message workbench with safe peek, move and redrive;
   - topology tools (graph, simulator, diff);
   - an operations view (metrics, alerts, health checks);
   - team governance (RBAC, SSO, audit, approvals, masking);
   - the same capabilities on desktop and self-hosted web.

## 2. Tool profiles

### 2.1 Paid desktop and IDE workbenches

**QueueExplorer 5 (Cogin)**
- **Type/platforms:** desktop app for Windows, macOS and Linux. One install also handles Azure Service Bus, MSMQ and ActiveMQ.
- **Price/activity:** Standard $149, Pro $249, perpetual licence with 12 months of maintenance. Version 5.x; Cogin's RabbitMQ article is dated 2026-07-21.
- **Headline features:**
  - progressive loading, with headers shown as columns;
  - filtering on body, properties and headers;
  - edit, create and publish messages;
  - move, copy, delete, save and load messages;
  - replay of dead-lettered messages;
  - stream paging with an offset jump;
  - viewers for JSON, XML, WCF, hex, gzip and deflate;
  - bulk send.
- **Unique:** Pro adds definitions export, copy, **compare and synchronize** across environments, custom columns built with JSON expressions, XPath or regex, saved "queue views" and regex folders.
- **Weaknesses:** no live tap, routing graph, alerts, RBAC or web edition.
- **Sources:** [cogin.com/mq](https://www.cogin.com/mq/), [professional](https://www.cogin.com/mq/professional.php), [article](https://www.cogin.com/articles/rabbitmq/rabbitmq-gui.php).

**Queue Studio for RabbitMQ (factodus)**
- **Type/platforms:** JetBrains IDE plugin for IDEs version 2025.3 or newer. Sister plugins exist for SQS/SNS and Azure Service Bus.
- **Price/activity:** paid through JetBrains Marketplace with a free trial; the price was not retrievable. Its docs repo was created 2026-09-23.
- **Headline features:**
  - reads streams from the start, from the latest N, from an offset or from a point in time;
  - holds up to 65,535 classic-queue messages unacknowledged, then returns them in their original order;
  - reads up to 5,000 quorum-queue messages without using up the delivery limit;
  - moves messages and only acknowledges the source after the broker confirms the copy;
  - deletes or edits a single message in the middle of a queue;
  - shows live traffic through a temporary exclusive queue with the same bindings;
  - policies editor that also shows the effective policy;
  - SSH bastion support.
- **Unique:** a routing graph with **route check** (enter a routing key and headers, see which queues a message would reach), and the clearest documentation of side effects of any tool reviewed.
- **Weaknesses:** tied to the IDE; no team or web mode; no metric history or alerts.
- **Source:** [docs](https://github.com/drbenzin/queue-studio-docs).

**RabbitMQ Assistant (Redisant)**
- **Type/platforms:** desktop app for Windows, macOS and Linux.
- **Price/activity:** $49.99 with a free evaluation. Version 1.3.1.4; the winget entry was updated 2025-05-15.
- **Headline features:**
  - topology map per vhost, exportable as PNG, SVG or PDF;
  - simulates producers and consumers, with batch sends for performance testing;
  - decodes MessagePack and numeric payload types;
  - monitoring with auto-refresh;
  - user and permission management.
- **Unique:** topology export and MessagePack decoding.
- **Weaknesses:** releases are infrequent and there is no documented DLQ workflow.
- **Sources:** [redisant.com/rta](https://www.redisant.com/rta), [winget](https://winget.ragerworks.com/package/Redisant.RabbitMQAssistant).

**RMQ (Aaron Carr)**
- **Type/platforms:** native macOS app from the Mac App Store; needs macOS 26 or later.
- **Price/activity:** $19.99. Version 1.1.3, updated Sep 16.
- **Headline features:** multiple connections, SSH tunnels, management of exchanges, queues and bindings, real-time dashboards, publishing with headers, templates with placeholder tokens, import and export, and passwords kept in the macOS Keychain.
- **Unique:** an **API transcript** that shows every management-API call the app makes.
- **Weaknesses:** macOS only.
- **Source:** [App Store](https://apps.apple.com/app/id6755972526).

**Qu Desktop (Barbaleon)**
- **Type/platforms:** desktop app for Windows and Mac.
- **Price/activity:** the Community edition (v1.1.11) is free but limited to a single host, read-only use and exporting one message at a time.
- **Headline features:** vhost/queue tree, browsing, sorting, export, JSON highlighting.
- **Weaknesses:** the free tier is very limited.
- **Source:** [site](https://qu.barbaleon.co.uk/).

Taken from the project context plus its docs:
- **DLQ handling.** Either "peek and requeue" (up to the first 1,000 messages; headers may change) or "consume and remove", which keeps the only copy in a local database.
- **Spy.** Watches traffic through a shadow queue with the same bindings. It cannot mirror traffic published through the default exchange.
- **Network model.** Connects directly to the broker; the only server-side call is for licence checks.

### 2.2 Open-source GUIs

- **RabbitScout v2.0.0** (2026-08-20; Next.js 16; Docker images for amd64 and arm64)
  - Logs in with the user's own RabbitMQ credentials (kept in an httpOnly cookie; RabbitMQ user tags are respected).
  - Live charts from Live up to 24h, using the broker's own retained samples.
  - Create classic, quorum or stream queues; peek with pagination; publish with headers; manage exchanges, bindings, connections and channels; command palette.
  - One broker only; no DLQ, policy or user screens. ([release](https://github.com/Ralve-org/RabbitScout))
- **RabbitLens v1.1.0** (2026-09-02)
  - A single-page app behind a proxy that roughly matches the official UI: users, vhosts, policies, limits, federation, shovels, streams, tracing and definitions.
  - Navigation adapts to the user's permissions; English and Vietnamese.
  - Roadmap: "guided safe-action flows". It explicitly will not store payloads or bypass RabbitMQ auth. ([roadmap](https://github.com/huynhanx03/RabbitLens))
- **mq-studio v0.3.0** (Wails 3 desktop app; 15+ brokers)
  - Built-in AI assistant (Claude, OpenAI or local models).
  - Acts as an MCP server, read-only by default; write actions need approval and are audit-logged.
  - RabbitMQ browsing "requeues what it reads". ([repo](https://github.com/amigoer/mq-studio))
- **Smaller tools**
  - [easyqueue](https://github.com/sousadiego11/easyqueue) (Electron; "the Postman for message brokers"; 16★).
  - [Nanuq](https://github.com/waelouf/Nanuq) (.NET + Vue; Kafka, Redis, RabbitMQ, SQS/SNS and Azure Service Bus; RabbitMQ topology only; 43★).
  - [TurkNet RabbitMQ-UI](https://github.com/TurkNet/RabbitMQ-UI) (multiple clusters, JWT admin, read-only mode; 4★).
  - qhopper, Spool (native Mac app for Redis + RabbitMQ), rabbit-wrangler, erebus, ProtoRabbit (Protobuf, 2023).
  - A Docker Desktop extension (2023).
- **[MassLens](https://github.com/N0T-A-NUMB3R/MassLens)**: a dashboard embedded in MassTransit v8 apps showing faults, retries, saga states and topology.
- **[tryrabbitmq.com](http://tryrabbitmq.com/)**: a drawing and simulation tool for teaching; it is not connected to a real broker.

### 2.3 CLIs and terminal UIs

**rabtap**
- Go, GPL-3.0; 290★; v1.46.0 (2026-08-20). [repo](https://github.com/jandelgado/rabtap)
- Taps exchanges through exchange-to-exchange bindings without disturbing delivery.
- Captures the firehose, reads streams by offset or time, and publishes or replays saved messages.
- Filters with expressions; outputs the topology tree as Graphviz dot.

**rabbitmqadmin v2**
- Rust; 54★; v2.35.0 (2026-09-09), "forward compatibility with RabbitMQ 4.4.0". Homebrew: 428 installs in 365 days. ([releases](https://github.com/rabbitmq/rabbitmqadmin-ng/releases), [brew](https://formulae.brew.sh/api/formula/rabbitmqadmin.json))
- Exports and transforms definitions (strip classic-mirroring keys, hide credentials); manages shovels and federation.
- Health checks, feature flags and deprecated features; TOML file with named broker aliases.
- Regex bulk delete (v2.31). Publish and get are for development only.
- The old Python v1 is no longer actively developed ([docs](https://www.rabbitmq.com/docs/management-cli)).

**rabbitmq-dump-queue**
- 226★; v0.7.3 (2026-09-04). [repo](https://github.com/dubek/rabbitmq-dump-queue)
- Dumps messages to files without acknowledging them; they go back to the queue when the connection closes.
- See section 3 for the quorum-queue side effect of this.

**Other small CLIs**
- [amqpcat](https://github.com/cloudamqp/amqpcat): netcat for AMQP; snap, Homebrew and Docker.
- [rabbitmq-c tools](https://github.com/alanxz/rabbitmq-c): `amqp-publish`, `amqp-get`, `amqp-consume`.
- [amqp-utils](https://github.com/dougbarth/amqp-utils): abandoned, last push 2015.

**Plumber**
- [repo](https://github.com/streamdal/plumber)
- Decodes Protobuf, Avro and Thrift; works with RabbitMQ Streams.
- Release v2.8.0 removed the Streamdal backend code; last push 2025-07-16.

**Terminal UIs**
- [rabbitui](https://github.com/maxmindlin/rabbitui): Rust; 22★.
- [mqx](https://github.com/Max2535/mqx): v0.4.0, 2026-10-11. Has **routing simulation without publishing**, read-only contexts, an AI panel and a read-only MCP server.

**Error-queue CLIs**
- [dlq_inspector](https://github.com/HalxDocs/dlq_inspector): Sept 2026. Pipeline of inspect, classify, plan, dry run, recover and audit; optional AI classifier.
- [EasyNetQ Hosepipe](https://github.com/EasyNetQ/EasyNetQ/wiki/Re-Submitting-Error-Messages-With-EasyNetQ.Hosepipe): dump, insert, err and retry. Its docs warn that delivery limits on quorum queues can drop messages after repeated inspection.

**Kubernetes plugin**
- [kubectl rabbitmq](https://www.rabbitmq.com/kubernetes/operator/kubectl-plugin): create, list, `manage` (opens the UI), `tail`, `observe`, `perf-test`, pause or resume reconciliation.

**httpYac**
- VS Code extension and CLI; 884★.
- `.http` files can hold AMQP requests: publish, consume, ack/nack, purge, declare, bind and delete ([docs](https://httpyac.github.io/guide/request.html)).
- INFERENCE: this is the closest thing to "Postman collections" for RabbitMQ.

### 2.4 Load and contract testing

- **[PerfTest](https://github.com/rabbitmq/rabbitmq-perf-test):** v2.25.0 (2026-06-30); includes HTML reporting tools.
- **[omq](https://github.com/rabbitmq/omq):** v0.56.0 (2026-10-06). Covers AMQP 1.0 and 0-9-1, MQTT 3/5, STOMP and the stream protocol. Measures end-to-end latency, exposes Prometheus metrics and detects out-of-order messages.
- **stream-perf-test:** official stream benchmark.
- **[xk6-amqp](https://github.com/grafana/xk6-amqp):** archived.
- **[Microcks](https://microcks.io/documentation/references/artifacts/asyncapi-conventions/):** AsyncAPI mocking and contract testing over AMQP with RabbitMQ.

### 2.5 Vendor and SaaS consoles

**Official open-source UI (4.3 baseline)**
- Get messages: ack modes are Nack-requeue (the default), auto-ack, reject-requeue and reject.
- "Move messages" builds a temporary shovel and needs the shovel plugins ([queue.ejs](https://github.com/rabbitmq/rabbitmq-server/blob/main/deps/rabbitmq_management/priv/www/js/tmpl/queue.ejs)).
- Publish, definitions, policies, users and limits.
- SSO through OAuth 2.0 with multiple resource servers.
- Metrics are "by design" not a long-term store, and the collector can be disabled ([management](https://www.rabbitmq.com/docs/management), [prometheus](https://www.rabbitmq.com/docs/prometheus)).

**Tanzu RabbitMQ (commercial)**
- Stream Browser, audit logging (on Kubernetes) and AMQP 1.0 over WebSocket.
- Also warm standby replication and intra-cluster compression ([commercial features](https://www.rabbitmq.com/commercial-features)).

**CloudAMQP console**
- Definitions, plugins, versions, upgrades, logs and metrics ([intro](https://cloudamqp.com/docs/cloudamqp-intro.html)).
- Alarms for CPU, memory, disk, netsplit, queue, consumers, connections, channels and connection flow. Queue and consumer alarms can filter by queue or vhost regex. Notifications go to email, webhook, Slack, PagerDuty, Teams, VictorOps, Signl4 or OpsGenie ([alarms](https://www.cloudamqp.com/docs/monitoring.html)).
- **23 diagnostic checks** covering versions, rate mode, unused queues, connection and channel leaks, heartbeats, prefetch and outdated clients ([diagnostics](https://www.cloudamqp.com/docs/cloudamqp-diagnostics.html)).
- Account history with user attribution (2025-03-25).
- OTLP log integrations (2026) and the message deduplication plugin for 4.2/4.3 (2026-10-14) ([changelog](https://cloudamqp.com/changelog.html)).
- Message-level work happens in the hosted RabbitMQ management UI.

**Amazon MQ for RabbitMQ**
- The AWS console handles the broker lifecycle, configuration and auth: OAuth 2.0 (Sep 2025), LDAP (Nov 2025), HTTP auth and mTLS (Jan 2026).
- Prometheus endpoints for 4.2 and later (Apr 2026); in-place upgrade from 3.13 to 4.2 (May 2026); RabbitMQ 4.3 support (Sep 2026).
- Topology and message work still happens in the RabbitMQ web console.
- Sources: [release notes](https://docs.amazonaws.cn/en_us/amazon-mq/latest/developer-guide/amazon-mq-release-notes.md), [4.3](https://aws.amazon.com/about-aws/whats-new/2026/09/amazon-mq-rabbitmq-43/).

**LavinMQ (84codes)**
- v2.10.2 (2026-10-07). UI has get, move, purge and pause; restarting closed queues (2.7); shovels, federation and definitions; churn and IOPS charts; dark theme ([docs](https://lavinmq.com/documentation/management-interface-overview)).

**Alibaba ApsaraMQ for RabbitMQ**
- Message **query by queue and time window or by message ID** (within 3 days, up to 100 results), with download and resend ([doc](https://www.alibabacloud.com/help/en/apsaramq-for-rabbitmq/user-guide/query-messages)).
- INFERENCE: this is a history-search feature that self-hosted users lack.

### 2.6 Error and DLQ tooling

**ServicePulse 2.12.1 / ServiceControl**
- Groups failures by exception type plus stack trace, by message type or by endpoint.
- Retries single messages or whole groups with progress; retry redirects; edit and retry; delete; CSV export.
- Message URLs can be shared, and the last 10 retry runs are kept as history ([failed messages](https://docs.particular.net/servicepulse/intro-failed-messages)).
- MassTransit support for RabbitMQ and Azure Service Bus is in **early access and free** ([docs](https://docs.particular.net/platform/masstransit)).
- ServiceInsight's sunset was announced 2025-12-19; it is deprecated on 2027-02-10 ([docs](https://docs.particular.net/serviceinsight/)).

**Warren**
- A self-hosted web console for DLQs ([site](https://warrenops.io), [Docker Hub](https://hub.docker.com/r/viba88/warren)).
- Groups failures by cause; replays with throttling, publisher confirms and a dry run.
- After a replay it checks for re-failures at 5 minutes, 30 minutes, 2 hours and 1 day.
- Parks or discards messages, hides PII by default, and supports undo.
- The free Community edition covers 1 broker and 3 vhosts, with 1 hour of audit history. Team and Pro are not yet released.

### 2.7 Monitoring

**Prometheus plugin and official Grafana dashboards** ([grafana.com/orgs/rabbitmq](https://grafana.com/orgs/rabbitmq/dashboards); download counts are inflated by automated provisioning)

| Dashboard | Downloads |
| --- | --- |
| RabbitMQ-Overview (10991) | 52.1M |
| Erlang-Memory-Allocators | 39.5M |
| Erlang-Distribution | 36.6M |
| Quorum-Queues-Raft | 35.5M |
| Stream | 31.4M |

RabbitMQ 4.3 adds queue-name filtering on `/metrics/detailed` ([4.3.0 notes](https://github.com/rabbitmq/rabbitmq-server/releases/tag/v4.3.0)).

**Other integrations**
- **[Datadog](https://docs.datadoghq.com/integrations/rabbitmq/):** collects through Prometheus or the management plugin; ready-made dashboards and monitors; Data Streams Monitoring.
- **[New Relic nri-rabbitmq](https://docs.newrelic.com/docs/infrastructure/host-integrations/host-integrations-list/rabbitmq-monitoring-integration/):** uses the management API. It reports nothing if more than 2,000 queues remain after filters.
- **Dynatrace:** CloudAMQP has offered a Dynatrace metrics integration since Mar 2025. A native extension was not verified.
- **[WombatOAM](https://www.erlang-solutions.com/capabilities/wombatoam/):** general monitoring for systems on the Erlang VM, including RabbitMQ.
- **[kbudde/rabbitmq_exporter](https://github.com/kbudde/rabbitmq_exporter):** 720★, **archived**.

### 2.8 Infrastructure as code and Kubernetes

- **[Cluster Operator](https://github.com/rabbitmq/cluster-operator):** 1,120★, v2.23.1 (2026-10-13).
- **[Messaging Topology Operator](https://github.com/rabbitmq/messaging-topology-operator):** v1.20.4. Manages queues, exchanges, bindings, users, vhosts, policies, permissions, federation and shovels as Kubernetes resources.
- **[terraform-provider-rabbitmq](https://github.com/cyrilgdn/terraform-provider-rabbitmq):** last push 2025-11-20.
- **CloudAMQP Terraform provider:** active.
- INFERENCE: no GUI recognises objects managed by the operator, so changes made in a UI can be reverted silently by the operator's next reconciliation.

### 2.9 AI and MCP

**amazon-mq/mcp-server-rabbitmq** ([README](https://github.com/amazon-mq/mcp-server-rabbitmq), [PyPI](https://pypi.org/project/amq-mcp-server-rabbitmq/))
- Moved from kenliao94's repo. Works with any RabbitMQ, not just Amazon MQ.
- v4 has 31 dispatcher tools; v3 mode has 61 tools; there are 16 "skills" (for example DLQ summary and dead-letter chain tracing).
- Mutative tools are off unless `--allow-mutative-tools` is set. It can hold several brokers under aliases. Its HTTP transport supports OAuth and JWKS. It has SSRF protection.
- It includes `definitions_compare` and migration readiness checks.
- FACT (from source code): its **read-only** tool `get_messages` calls HTTP `/get` with `ack_requeue_true` ([admin.py](https://github.com/amazon-mq/mcp-server-rabbitmq/blob/main/src/rabbitmq/admin.py)).
- INFERENCE: on 4.0–4.2 quorum queues, an agent "peeking" repeatedly can use up the delivery limit. In v3 mode the same tool also accepts `ack_requeue_false`, which consumes the messages.

**awslabs.amazon-mq-mcp-server**
- Provisions brokers through AWS APIs; read-only by default.
- Its RabbitMQ connection tools were affected by **CVE-2026-18655**: up to 2.0.23, a prompt injection could send credentials to a broker hostname chosen by the attacker. Fixed in 2.0.24 ([bulletin](https://aws.amazon.com/security/security-bulletins/2026-070-aws/)).

**Other AI tooling**
- **[@aws/mcp-amqp-transport](https://github.com/amazon-mq/mcp-amqp-transport) (beta):** runs MCP over AMQP 0-9-1 or 1.0, so RabbitMQ carries agent traffic.
- **Built-in assistants:** mq-studio, mqx and dlq_inspector.
- INFERENCE: no MCP server from Broadcom or the RabbitMQ team was found in the rabbitmq GitHub org.

### 2.10 IDE extensions and mobile

- **JetBrains:** Queue Studio (paid). Older open-source plugins were abandoned around 2019.
- **VS Code:**
  - [AMQP Manager](https://github.com/LeoGardini/amqp-manager-vscode): 2★; stores passwords in the workspace `settings.json`.
  - [MQExplorer](https://github.com/spockstein/MQExplorer): covers several brokers.
  - httpYac.
- **Mobile:** no RabbitMQ management app was found in Google Play results. INFERENCE: the on-call phone gap is unfilled.

## 3. Broker facts that constrain any tool

| Concern | FACT | Design implication (INFERENCE/IDEA) |
| --- | --- | --- |
| Streams | Reading by offset or timestamp is non-destructive. Server-side Bloom filters and AMQP property/SQL filter expressions work on properties and application-properties, not the body ([stream filtering](https://www.rabbitmq.com/docs/stream-filtering)). | A fast stream browser with server-side search is cheap to build and stands out. |
| Move/redrive | The open-source UI moves a whole queue with a shovel. Queue Studio acknowledges the source only after the broker confirms the copy. SQS redrive has a speed limit (up to 500 msg/s), cancel and a task list ([SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-configure-dead-letter-queue-redrive.html)). | Copy the SQS-style job UX, with confirms. |
| Web edition | Browsers cannot open AMQP to open-source RabbitMQ without a WebSocket-to-TCP relay ([amqp-client.js](https://github.com/cloudamqp/amqp-client.js)). AMQP 1.0 over WebSocket is Tanzu-only. | The web edition needs a server-side gateway, which is also where RBAC, audit and masking go. |
| Audit primitive | The `amq.rabbitmq.event` exchange publishes events for queues, exchanges, bindings, users, permissions, policies, vhosts, connections, consumers and alarms ([event exchange](https://www.rabbitmq.com/docs/event-exchange), [internal events](https://www.rabbitmq.com/docs/logging)). | Ingest these events to build an audit trail at the broker level, covering changes made by any tool. |
| Metrics | The management API's statistics can be switched off (`disable_metrics_collector`). The Prometheus endpoints are the long-term source. | Read live metrics from the management API, with Prometheus as a fallback and for history. |
| Version churn | 4.3.0 shipped 2026-04-23 (4.3.6 on 2026-09-14). Khepri is now the only metadata store, CQv1 is removed, transient non-exclusive queues are off by default, and Amazon MQ notes that global QoS was removed. rabbitmqadmin already targets 4.4. | Add upgrade-readiness checks and branch behaviour on detected capabilities. |

## 4. Feature-coverage matrix

**Columns:**
- **OSS** = official open-source UI (4.3)
- **QE** = QueueExplorer 5 (Pro)
- **QS** = Queue Studio (JetBrains)
- **RA** = RabbitMQ Assistant
- **RMQ** = RMQ (macOS)
- **OW** = open-source web UIs (RabbitScout/RabbitLens)
- **WR** = Warren
- **CLI** = rabtap, dump-queue and amqpcat
- **ADM** = rabbitmqadmin v2
- **CA** = CloudAMQP console
- **MCP** = amazon-mq/mcp-server-rabbitmq
- **SP** = ServicePulse

**Legend:** Y = yes; P = partial; T = paid or announced tier only; - = no or not found; ? = undocumented.

| Capability | OSS | RG | QE | QS | RA | RMQ | OW | WR | CLI | ADM | CA | MCP | SP |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Browse/peek queue messages | P | Y | Y | Y | P | P | P | Y¹ | P | P | - | Y | P² |
| Side-effect-aware "safe peek" | - | P | ? | Y | ? | ? | - | ? | - | - | - | -³ | - |
| Stream browsing (offset/time) | -⁴ | ? | Y | Y | ? | ? | - | - | Y | - | - | ? | - |
| Search/filter body and headers | - | Y | Y | ? | ? | ? | - | Y | Y | - | - | ? | P |
| Columns extracted from payload | - | ? | Y | - | - | - | - | - | - | - | - | - | - |
| Saved views and folders | - | Y | Y | Y | - | ? | - | - | - | - | - | - | - |
| Edit and resend | - | P | Y | Y | P | ? | - | ? | P | - | - | - | Y |
| Delete one message mid-queue | - | P⁵ | Y | Y | ? | ? | - | P | - | - | - | - | Y |
| Move/copy selected messages | P⁶ | P | Y | Y | ? | ? | - | P | P | P | - | - | P |
| DLQ redrive to origin, throttled | P⁶ | Y | P | P | - | - | - | Y | P | P | - | - | Y |
| DLQ failure analytics/grouping | - | P | P | - | - | - | - | Y | - | - | - | P | Y |
| Publish with properties/headers | Y | Y | Y | Y | Y | Y | Y | P | Y | P | - | Y | - |
| Templates with placeholders | - | - | P | - | P | Y | - | - | P | - | - | - | - |
| Bulk publish from files, rate-limited | - | - | Y | - | Y | ? | - | - | Y | - | - | - | - |
| Export messages | - | - | Y | ? | ? | ? | P | T | Y | - | - | - | P |
| Import/replay from files | - | - | Y | P | ? | ? | - | - | Y | P | - | - | - |
| Live tap without stealing messages | - | Y | - | Y | ? | ? | - | - | Y | - | - | - | - |
| Firehose/trace capture | P⁷ | - | - | - | - | - | P | - | Y | - | - | - | - |
| History search after consumption | - | - | - | - | - | - | - | - | - | - | - | - | P |
| Routing/topology graph | - | Y | - | Y | Y | ? | - | - | P | - | - | - | - |
| Routing simulator | - | ? | - | Y | ? | ? | - | - | - | - | - | - | - |
| Topology diff/sync between environments | - | - | Y | - | - | - | - | - | - | - | - | Y | - |
| Definitions export/import | Y | ? | Y | ? | ? | ? | P | - | - | Y | Y | Y | - |
| Multiple clusters in one place | - | Y | Y | Y | ? | Y | - | T | P | Y | Y | Y | - |
| Policy/operator-policy editor | Y | - | ? | Y | ? | ? | P | - | - | Y | - | Y | - |
| Effective-policy debugger | P | Y | - | Y | - | - | - | - | - | - | - | ? | - |
| Users/permissions/limits | Y | - | - | - | Y | ? | P | - | - | Y | - | Y | - |
| Connections/channels (inspect/close) | Y | - | - | - | P | ? | P | - | P | Y | - | Y | - |
| Consumers (prefetch, utilisation) | Y | ? | - | ? | Y | ? | P | - | P | Y | P | Y | - |
| Shovels and federation | Y | - | - | - | - | - | P | - | - | Y | P | Y | - |
| Health, feature flags, deprecations | Y | - | - | - | - | - | P | P | - | Y | Y | Y | P |
| Live metrics/charts | Y | Y | P | P | Y | Y | Y | P | P | P | Y | P | P |
| Long-term metric history | - | P | - | - | - | - | P | T | - | - | Y | - | - |
| Drain/ETA forecast | - | Y | - | - | - | - | - | - | - | - | - | - | - |
| Alerting/notifications | - | - | - | - | - | - | - | T | - | - | Y | - | P |
| Best-practice diagnostics | - | - | - | - | - | - | - | P | - | P | Y | P | - |
| RBAC inside the tool | P | - | - | - | - | - | P | T | - | - | ? | - | ? |
| Audit log of operator actions | -⁸ | - | - | - | - | P⁹ | - | Y | - | - | P | - | P |
| SSO (OIDC/OAuth2/SAML) | Y | - | - | - | - | - | - | T | - | ? | ? | P | ? |
| Data masking/PII | - | - | - | - | - | - | - | Y | - | P | - | P | - |
| Four-eyes approval / production guard | - | - | - | - | - | - | - | T | - | - | - | P | - |
| Decoding beyond text/JSON | - | - | P | - | P | ? | - | ? | P | - | - | - | - |
| AI assistant / MCP | - | - | - | - | - | - | - | - | - | - | - | Y | - |
| CLI/API for automation | Y | - | - | - | - | P | - | ? | Y | Y | Y | Y | P |
| Kubernetes awareness | P | - | - | - | - | - | - | - | - | - | - | - | - |
| SSH tunnel/bastion | - | ? | ? | Y | ? | Y | - | - | - | - | - | - | - |
| Self-hosted web/team mode | Y¹⁰ | - | - | - | - | - | Y | Y | - | - | Y(SaaS) | P | Y |
| Runs locally on Windows/macOS/Linux | - | Y | Y | P(IDE) | Y | P(mac) | - | - | Y | Y | - | Y | - |

**Footnotes:**
1. Warren covers DLQs only.
2. ServicePulse shows failed messages already ingested into ServiceControl, not a live peek of the broker.
3. The MCP peek is listed as read-only but uses the state-changing HTTP get.
4. The open-source UI sets `get_message:false` for streams. Tanzu has a Stream Browser.
6. The open-source UI moves a whole queue through a temporary shovel; you cannot pick messages or set a rate.
7. The `rabbitmq_tracing` plugin writes traces to log files.
8. Tanzu has audit logging. Open source only offers the internal event exchange.
9. RMQ's API transcript is local to the user.
10. One UI per cluster.

## 5. White space (INFERENCE from the matrix and the profiles)

1. **The same product on desktop and self-hosted web.** No tool has both. Desktop tools combine AMQP with the HTTP API. Web tools only use the HTTP API, so they cannot tap, safely peek or do confirm-based moves.
2. **Team controls on message operations.** RBAC, SSO, an audit trail, four-eyes approval and PII masking only exist in Warren, for DLQs, and mostly in unreleased tiers. Kafka UIs (kafbat) ship RBAC, SSO and masking for free.
3. **Peek that adapts to version and queue type and shows its side effects.** Only Queue Studio documents this. Even an AWS-maintained MCP server treats the HTTP get as read-only.
4. **Routing simulator and topology diff or drift detection in a GUI.**
   - Simulator: only Queue Studio (in the IDE) and mqx (a terminal tool).
   - Diff: QueueExplorer Pro and the MCP server, with no visual diff.
   - Nothing checks drift against Git, Terraform or Kubernetes resources.
5. **Streams as a first-class feature.** No tool offers server-side SQL or Bloom filtering in a UI, super-stream partition views, or consumer offset tracking.
6. **Payload decoding.** Protobuf, Avro, MessagePack and CloudEvents are mostly missing.
7. **Message history and search after consumption.** This exists only in a cloud console (Alibaba). Self-hosted users would need an opt-in capture store.
8. **Alerting and best-practice checks for self-hosted brokers without Prometheus.** CloudAMQP has both only as SaaS; Warren's are a paid tier.
9. **Understanding failures across client frameworks.** MassTransit, NServiceBus, EasyNetQ, Spring AMQP and Celery each wrap failures in their own envelope. Only ServicePulse parses them, and only for its own frameworks.
10. **Safe AI.** No GUI has an MCP layer that is bound to saved connection profiles and that masks data. CVE-2026-18655 shows the risk.
11. **Kubernetes and operator awareness, and an on-call phone or PWA view.** Neither exists.
12. **Upgrade-readiness assistant for 4.3 and 4.4.** The removals (CQv1, transient queues, global QoS) are a recurring pain point (Amazon MQ in-place upgrades).

## 6. Popularity and pricing benchmarks (FACT, 2026-10-16)

**Stars and activity**
- rabbitmq-server: 13,928★.
- Plumber: 2,153★ (stale).
- rabbitmq-c: 1,864★.
- Cluster Operator: 1,120★.
- LavinMQ: 1,031★.
- PerfTest: 418★.
- rabtap: 290★.
- dump-queue: 226★.
- Topology Operator: 161★.
- RabbitScout: 154★.
- RabbitLens: 91★.
- mq-studio: 89★.
- rabbitmqadmin-ng: 54★.
- amazon-mq MCP server: 42★.
- omq: 9★.

**Installs**
- Homebrew `rabbitmq` formula: 24,225 installs in 365 days.
- Homebrew `rabbitmqadmin`: 428 installs in 365 days.

**Prices (one-time unless noted)**
- QueueExplorer $149/$249.
- Warren Team/Pro: one-time purchase per installation, not yet released.

INFERENCE: tools that became de facto for other brokers are free and open source, or vendor-backed (RedisInsight).

## 7. Implications (IDEA)

1. **One core engine for both editions.** Build one engine that speaks the HTTP API, AMQP 0-9-1, AMQP 1.0 and the stream protocol. Embed it in the desktop apps and deploy it as the server gateway of the web edition.
2. **Make safety the headline.** Version-aware peek, previews of side effects, confirm-based moves, and redrive jobs with throttle, cancel and verification.
3. **Free core, paid team layer.** Win adoption with a free open-source core. Charge for team governance: RBAC, SSO, audit, approvals and masking.
4. **Ship a profile-bound, read-only-by-default MCP server.** Treat peek as a mutation.
5. **Use the broker's event exchange** so the audit trail also covers changes made outside the tool.

## Feature ideas

| Idea | Persona | Priority | Size | Description | Evidence / inspiration |
| --- | --- | --- | --- | --- | --- |
| Side-effect disclosure before every message operation | all | must | S | Before a peek, move, delete, edit or redrive, show what will change: redelivered flags, delivery-count increments, temporary invisibility to consumers, message ordering, and the delivery limit of the queue's effective policy. | Queue Studio asks before reading classic or quorum queues and refuses operations that would exceed the delivery limit. rabbitmq-dump-queue documents the consumer visibility gap. |
| Stream browser | developer | must | M | Browse streams by first/last/next, numeric offset, timestamp or relative time. Follow the tail. Show super-stream partitions and consumer offset tracking. Use the stream protocol for throughput. | The OSS UI sets get_message:false for streams. Tanzu has a Stream Browser (commercial). QueueExplorer and Queue Studio read streams by offset. rabtap reads streams by offset or time. |
| Server-side stream search | developer | should | M | Turn UI filters into Bloom filter values and AMQP 1.0 property or SQL filter expressions so streams are filtered on the broker. Fall back to client-side filtering for body content. | rabbitmq.com/docs/stream-filtering (three filtering stages, server-side). omq supports AMQP 1.0 stream filtering. |
| Confirm-safe move and copy of selected messages | operator | must | M | Move or copy selected messages, or the first N, to another queue, exchange, vhost or cluster. Acknowledge the source only after the broker confirms the copy on the target. Abort without losing messages if anything fails. | Queue Studio moves with confirms. The OSS UI's 'Move messages' can only move a whole queue through a temporary shovel. rabtap's 'poor man's shovel'. |
| Failure parsing per client framework | operator | should | M | Plugins that read MassTransit, NServiceBus, EasyNetQ, Spring AMQP, Celery and Wolverine failure envelopes and headers. Use them to group by exception or stack trace and to pick the right redrive target. | ServicePulse groups by exception type plus stack trace. The MassTransit connector for ServiceControl (early access). EasyNetQ Hosepipe error envelope. MassLens. |
| Edit-and-resend and single-message delete | developer | should | M | Edit the body, headers or properties of one message and republish it, then remove the original. Delete chosen messages from the middle of a queue, matching on content and position, and abort if the queue has changed. | QueueExplorer edit and resend. Queue Studio edit and mid-queue delete. ServicePulse edit and retry. |
| Opt-in capture store and message history search | developer | could | L | Record tapped or firehose traffic into a local or server-side store with retention limits. Search it later by message ID, correlation ID, time window or content, even after the messages were consumed. | Alibaba ApsaraMQ for RabbitMQ message query (3-day window, 100 results, resend). The firehose tracer. |
| RPC and request-reply tester | developer | could | M | Send a request with reply-to and correlation-id, wait for and display the reply, and assert on its content. Save scenarios as tests. | kurier ('Postman-like client for AMQP-based APIs'). httpYac AMQP consume and ack. |
| Routing simulator | developer | must | M | Enter a routing key and headers and see which queues the message would reach. Handle topic wildcards, headers-exchange matching, alternate exchanges, exchange-to-exchange chains, DLX and TTL chains, and detect dead-letter loops. | Queue Studio route check. mqx 'dry-run routing'. tryrabbitmq.com simulator (no broker connection). |
| Topology diff and sync between environments | platform | should | L | Visual diff of definitions between clusters, vhosts or snapshots, with selective sync. Export results as definitions JSON, Terraform or Messaging Topology Operator resources. | QueueExplorer Pro compare and synchronize. Amazon MQ MCP definitions_compare and migration readiness. MQ-Topology-Visualizer-to-Code (GitHub). |
| Drift detection against IaC and the operator | platform | could | L | Compare live topology with Git, Terraform or Kubernetes resources. Mark objects managed by the operator and warn before editing them in the UI, because reconciliation will revert the change. | Messaging Topology Operator v1.20.4. cyrilgdn Terraform provider. CloudAMQP Terraform provider. |
| Definitions import/export with transformations | operator | must | M | Export and import definitions with transformations: strip classic-mirroring keys, hide credentials, exclude sections. Preview an import as a dry run with a diff. | rabbitmqadmin v2 definitions transformations. CloudAMQP console definitions. OSS UI export and import. |
| Shovels and federation management | operator | should | M | Status, throughput and errors for shovels and federation links. Wizards for moving messages and for local shovels (4.2+). | OSS UI shovel and federation pages. rabbitmqadmin v2. Amazon MQ notes for 4.2 (local shovels). |
| Health checks and upgrade-readiness assistant | platform | should | M | Alarms, quorum criticality, deprecated features in use, feature flags, Khepri status, and checks for 4.3/4.4 removals (CQv1, transient non-exclusive queues, global QoS) before an upgrade. | rabbitmqadmin health checks. RabbitMQ 4.3.0 release notes. Amazon MQ in-place upgrades (May 2026) and 4.3 deprecations. |
| Best-practice linter for self-hosted brokers | operator | should | M | Configurable rules modelled on CloudAMQP's 23 diagnostics, with explanations and how to fix each finding. Can run on a schedule. | CloudAMQP Diagnostics (general, queues, connections, clients). |
| Metrics with management API and Prometheus sources | operator | must | M | Live charts from the management API. Optional Prometheus datasource for history, reusing the queries behind the official dashboards. Keep working when management statistics are disabled. | rabbitmq.com/docs/prometheus. Management metrics are not a long-term store and can be disabled. Official dashboards have 52M+ downloads. |
| Web-edition gateway service | platform | must | L | Server-side component that holds the AMQP, stream and HTTP connections and streams results to browsers over WebSocket. Required because browsers cannot speak AMQP to open-source RabbitMQ. | amqp-client.js says a WebSocket-TCP relay is needed for RabbitMQ. AMQP 1.0 over WebSocket is Tanzu-only. |
| Team RBAC | team-security | must | M | Viewer, operator and admin roles, plus custom roles scoped by environment, cluster, vhost and queue pattern, with production read-only defaults. | Warren Team roles. kafbat UI RBAC. RabbitScout only passes through broker tags. |
| SSO | team-security | must | M | OIDC/SAML login for the web edition, optionally passing RabbitMQ OAuth2 tokens through so broker permissions still apply. | OSS UI OAuth 2.0 with multiple resource servers. Warren Pro OIDC. RabbitScout pass-through auth. |
| Audit trail | team-security | must | M | Record who did what, when, the before/after state and message counts for every change. Also ingest the broker's amq.rabbitmq.event events so changes from any tool are recorded. Export to a SIEM. | Warren audit trail. Tanzu audit logging. CloudAMQP account history (Mar 2025). RabbitMQ event exchange and internal events. |
| Four-eyes approvals | team-security | could | M | Require a second approver for purges, deletes, bulk redrives over N messages and production definition imports. | Warren Pro four-eyes approval workflows. |
| PII masking | team-security | should | M | Role-based masking rules (JSONPath or regex) applied consistently to the UI, exports, logs and AI or MCP outputs, while replays keep the original bytes. | Warren masks personal data by default. kafbat UI data masking. |
| Built-in MCP server with safety guardrails | platform | should | M | Expose the tool's operations to AI agents. Only allow saved connection profiles, never hostnames supplied by the model. Read-only by default. Classify peek as a mutation. Require per-tool approval, mask data and log everything. | amazon-mq/mcp-server-rabbitmq (mutative tools gated, SSRF protection). CVE-2026-18655. The 'read-only' get_messages uses ack_requeue_true. mq-studio and mqx MCP modes. |
| AI triage assistant | operator | could | M | Explain why a backlog is growing, cluster DLQ failures, explain effective policies and suggest fixes, with masking and audit applied. | mq-studio AI assistant. mqx AI panel. dlq_inspector optional AI classifier. |
| CLI and REST API for the tool itself | platform | should | M | Scriptable access to redrive jobs, diffs, exports, linting and alerts for CI/CD and runbooks, matching what the GUI can do. | rabbitmqadmin v2. rabtap. ServiceControl API. Cogin article recommends CLI and API runbooks. |
| Show the equivalent API call or CLI command | operator | should | S | For every UI action, show the HTTP API call, rabbitmqadmin command or definitions snippet, ready to copy into a runbook. | RMQ API transcript feature. Cogin article on recording commands for runbooks. |
| Kubernetes discovery | platform | could | L | Find RabbitmqCluster resources, read their secrets, port-forward automatically, and mark operator-managed topology. | kubectl rabbitmq plugin (manage, secrets, tail). Cluster and Messaging Topology Operators. |
| Load-test runner | developer | could | L | Run PerfTest- or omq-style scenarios from the GUI and chart rates and end-to-end latency for a queue or topology. | PerfTest. omq. kubectl rabbitmq perf-test. RabbitMQ Assistant stress testing. QueueExplorer bulk send. |
| UX for newer protocols and queue features | operator | should | M | Show AMQP 1.0 addresses, MQTT/STOMP/WebSocket connections, quorum-queue strict priorities, delayed-retry state and per-protocol consumer timeouts (4.3). | RabbitMQ 4.3.0 notes (UI shows delayed retry and per-priority counts). Amazon MQ 4.3 announcement. omq protocols. |
| On-call mobile view | operator | could | M | Read-only, phone-friendly view of the web edition (as a PWA) for alerts, queue depth and starting pre-approved redrive jobs. | No maintained RabbitMQ admin app was found on Google Play. RabbitScout has a responsive mobile shell. |
| LavinMQ compatibility | operator | could | M | Detect LavinMQ and support its HTTP API and features (queue pause and restart, stream filters) so the tool also covers CloudAMQP's second broker. | LavinMQ management UI v2.10.2. CloudAMQP hosts both RabbitMQ and LavinMQ. |

## Claims flagged for verification

- **[high]** As of 2026-10-16 the most-starred dedicated open-source RabbitMQ GUIs have at most 154 GitHub stars (RabbitScout 154, RabbitLens 91, mq-studio 89). Leading Kafka/Redis UIs have 2,783-12,309 stars (kafbat 2,783; AKHQ 3,860; Redpanda Console 4,336; RedisInsight 8,907; provectus kafka-ui 12,309).
  - Why it matters: It confirms that no open-source de facto RabbitMQ UI exists, which underpins the go-to-market and the open-core choice.
  - Sources: https://github.com/Ralve-org/RabbitScout https://github.com/huynhanx03/RabbitLens https://github.com/amigoer/mq-studio https://github.com/kafbat/kafka-ui https://github.com/tchiotludo/akhq https://github.com/redpanda-data/console https://github.com/redis/RedisInsight https://github.com/provectus/kafka-ui
- **[high]** Quorum queues have defaulted to a delivery limit of 20 since RabbitMQ 4.0. From 4.3 the limit is based on delivery-count: basic.nack and AMQP 1.0 released/modified(delivery-failed=false) do not count, while basic.reject, connection loss and consumer timeout do. Before 4.3 it was based on acquired-count, so any requeue counted.
  - Why it matters: This decides how a non-destructive peek can be built. Repeated peeks with requeue on 4.0-4.2 can dead-letter or drop messages.
  - Sources: https://www.rabbitmq.com/docs/quorum-queues https://github.com/EasyNetQ/EasyNetQ/wiki/Re-Submitting-Error-Messages-With-EasyNetQ.Hosepipe https://github.com/drbenzin/queue-studio-docs
- **[high]** The management HTTP API's POST /api/queues/{vhost}/{name}/get 'will alter the state of the queue' and is meant for development and troubleshooting only. The open-source UI's Get messages form warns that it is 'a destructive action'; its default ack mode is 'Nack message requeue true'.
  - Why it matters: Web tools limited to the HTTP API (RabbitScout, RabbitLens, MCP servers) cannot offer a truly safe peek. A safe design needs AMQP-level control.
  - Sources: https://www.rabbitmq.com/docs/http-api-reference https://github.com/rabbitmq/rabbitmq-server/blob/main/deps/rabbitmq_management/priv/www/js/tmpl/classic-queue-get-message.ejs
- **[high]** The open-source management UI disables Get messages for stream queues (QUEUE_TYPE['stream'].actions.get_message = false). A management-UI Stream Browser is listed as a Tanzu RabbitMQ commercial feature.
  - Why it matters: Stream browsing is a clear differentiator that is free to claim in the open-source world.
  - Sources: https://github.com/rabbitmq/rabbitmq-server/blob/main/deps/rabbitmq_management/priv/www/js/global.js https://www.rabbitmq.com/commercial-features
- **[medium]** Browsers cannot connect to open-source RabbitMQ over AMQP directly; a WebSocket-to-TCP relay is required. AMQP 1.0 over WebSocket is listed as a Tanzu commercial feature.
  - Why it matters: The web edition must ship a server-side gateway. That shapes the architecture, the security model (RBAC, audit, masking live there) and the cost of hosting.
  - Sources: https://github.com/cloudamqp/amqp-client.js https://www.rabbitmq.com/commercial-features
- **[high]** CVE-2026-18655 (AWS bulletin 2026-070-AWS, 2026-08-03): in awslabs.amazon-mq-mcp-server up to 2.0.23, the RabbitMQ broker connection tools could be steered by prompt injection to send broker credentials or OAuth tokens to a hostname chosen by an attacker. Fixed in 2.0.24.
  - Why it matters: Any built-in MCP or AI feature must bind tools to saved connection profiles and never accept endpoints from the model.
  - Sources: https://aws.amazon.com/security/security-bulletins/2026-070-aws/ https://nvd.nist.gov/vuln/detail/CVE-2026-18655
- **[medium]** amazon-mq/mcp-server-rabbitmq 4.0.0 (PyPI, 2026-07-28) works with any RabbitMQ broker. It exposes 31 dispatcher tools in v4 mode (61 in v3 mode) and gates mutative tools behind --allow-mutative-tools. Its read-only get_messages tool nevertheless calls the HTTP /get endpoint with ackmode ack_requeue_true, and in v3 mode it also accepts ack_requeue_false (consume).
  - Why it matters: It is the reference MCP server and the main AI competitor. It also shows that 'read-only' message peeking is a misnomer the product must handle correctly.
  - Sources: https://github.com/amazon-mq/mcp-server-rabbitmq https://pypi.org/project/amq-mcp-server-rabbitmq/ https://github.com/amazon-mq/mcp-server-rabbitmq/blob/main/src/rabbitmq/admin.py
- **[high]** QueueExplorer costs $149 (Standard) or $249 (Professional) as a perpetual licence with 12 months of maintenance. It runs on Windows, macOS and Linux and browses RabbitMQ streams with offset navigation. Professional adds definitions export/copy/compare/synchronize, JSON/XPath/regex custom columns, saved queue views and custom folders.
  - Why it matters: It is the most complete commercial message workbench and the price anchor for desktop tools.
  - Sources: https://www.cogin.com/mq/buy.php https://www.cogin.com/mq/professional.php https://www.cogin.com/articles/rabbitmq/rabbitmq-gui.php
- **[medium]** Queue Studio for RabbitMQ is a paid JetBrains IDE plugin whose docs repo was created on 2026-09-23. It offers a routing simulator, moves that acknowledge the source only after the broker confirms the copy, mid-queue delete and edit, stream reading by offset or time, quorum reads that do not use up the delivery limit, and SSH bastion support.
  - Why it matters: It is a new competitor that already covers several 'advanced' features the product might plan as differentiators.
  - Sources: https://github.com/drbenzin/queue-studio-docs
- **[medium]** Warren (warrenops.io) offers a free self-hosted DLQ console (Community: 1 broker, up to 3 vhosts, 1-hour audit). Team/Pro tiers are announced as 'coming soon' one-time purchases and add RBAC, alerts, replay rules, four-eyes approval, OIDC SSO and 90-day audit. PII masking is on by default.
  - Why it matters: It is the closest existing attempt at governed, team-oriented message operations for RabbitMQ.
  - Sources: https://warrenops.io https://hub.docker.com/r/viba88/warren https://github.com/ViBa88/warren-releases
- **[high]** Particular announced the ServiceInsight sunset on 2025-12-19, with deprecation on 2027-02-10. Error management for MassTransit on RabbitMQ and Azure Service Bus in ServicePulse is in free early access.
  - Why it matters: It shows .NET users moving to web-based failed-message consoles, and that a framework vendor is entering generic DLQ management.
  - Sources: https://discuss.particular.net/t/serviceinsight-sunset/4507 https://docs.particular.net/serviceinsight/ https://docs.particular.net/platform/masstransit
- **[high]** RabbitMQ 4.3.0 was published on 2026-04-23 and the latest patch is 4.3.6 (2026-09-14). 4.3 makes Khepri the only metadata store, removes CQv1 and disables transient non-exclusive queues by default. rabbitmqadmin 2.35.0 (2026-09-09) already claims forward compatibility with RabbitMQ 4.4.0.
  - Why it matters: Spy and tap designs must use exclusive queues. The product needs version-capability detection and an upgrade-readiness checker.
  - Sources: https://github.com/rabbitmq/rabbitmq-server/releases/tag/v4.3.0 https://github.com/rabbitmq/rabbitmqadmin-ng/releases https://aws.amazon.com/about-aws/whats-new/2026/09/amazon-mq-rabbitmq-43/
- **[medium]** The CloudAMQP console runs 23 best-practice diagnostic checks and offers queue and consumer alarms filtered by regex with 8 notification channels. It added an account history (action log with user attribution) on 2025-03-25.
  - Why it matters: These are the benchmark for operations features (linting, alerting) that self-hosted users lack.
  - Sources: https://www.cloudamqp.com/docs/cloudamqp-diagnostics.html https://www.cloudamqp.com/docs/monitoring.html https://cloudamqp.com/changelog.html
- **[high]** Plumber (2,153 stars) last released v2.9.0 on 2024-12-24 and was last pushed on 2025-07-16; v2.8.0 removed the Streamdal backend code. kbudde/rabbitmq_exporter (720 stars) is archived.
  - Why it matters: The best-known third-party tools are fading, which leaves room for a new de facto tool.
  - Sources: https://github.com/streamdal/plumber https://github.com/streamdal/plumber/releases https://github.com/kbudde/rabbitmq_exporter
- **[medium]** The official Grafana dashboard RabbitMQ-Overview (ID 10991) shows 52,088,329 downloads on grafana.com. The other official dashboards each show 31-39M.
  - Why it matters: Most teams already use Prometheus and Grafana for monitoring, so the product should integrate with them rather than replace them.
  - Sources: https://grafana.com/orgs/rabbitmq/dashboards https://www.rabbitmq.com/docs/prometheus

## Open questions

- What does Queue Studio cost, how many downloads and ratings does it have, and when was it first released on JetBrains Marketplace? Are there other JetBrains RabbitMQ plugins? The marketplace could not be read (JS-rendered; the API returned 400).
- Which RabbitMQ-specific VS Code Marketplace extensions exist, and how many installs do they have? Only Open VSX and GitHub were checked.
- How does its v1.7 peek behave on 4.0-4.2 quorum queues?
- How does QueueExplorer peek quorum queues (delivery-limit safety), and when were the 5.x builds released?
- How does Redisant RabbitMQ Assistant peek or consume, and is it still updated after 1.3.1.4 (winget entry dated 2025-05-15)?
- Is there a native Dynatrace RabbitMQ extension, and how does it work? Only CloudAMQP's Dynatrace metrics integration was verified.
- Does the CloudAMQP console support SSO (SAML/OIDC) and team roles? Not verified.
- Do all mutation events on amq.rabbitmq.event carry user_who_performed_action? This decides whether broker-level audit ingestion is complete.
- Is Broadcom or the RabbitMQ team planning an official MCP server or a modernised management UI? None was found in the rabbitmq GitHub org.
- In which Tanzu version did the Stream Browser and AMQP 1.0 over WebSocket ship, and is either planned for open source?
- In which versions did AMQP 1.0 property filters and SQL filter expressions for streams ship (likely 4.1 and 4.2, unverified)?
- Are there RabbitMQ admin apps on the iOS App Store? It is not searchable via fetch. What is 'RabbitPro' (com.rabbitpro.app) on Google Play?
- Are there RabbitMQ desktop GUIs on Flathub or Snapcraft? Only the amqpcat snap was confirmed.
- What will Warren's Team/Pro tiers cost, and when will they ship? Who is the vendor behind warrenops.io?
- How big are the paid user bases? QueueExplorer, RMQ and RabbitMQ Assistant publish no numbers.
- Research caveat: the shared WebSearch budget ran out mid-research. Some long-tail tools may be missing, especially commercial tools without a GitHub presence and Chinese cloud consoles such as Tencent TDMQ for RabbitMQ.

## Sources

- https://www.cogin.com/mq/
- https://www.cogin.com/mq/buy.php
- https://www.cogin.com/mq/professional.php
- https://www.cogin.com/QueueExplorer/rabbitmq/
- https://www.cogin.com/QueueExplorer/releases/QueueExplorer5.0.php
- https://www.cogin.com/articles/rabbitmq/rabbitmq-management-ui-alternatives.php
- https://www.cogin.com/articles/rabbitmq/rabbitmq-gui.php
- https://github.com/drbenzin/queue-studio-docs
- https://www.redisant.com/rta
- https://winget.ragerworks.com/package/Redisant.RabbitMQAssistant
- https://apps.microsoft.com/detail/9nvlndqp4rpq?hl=en-US
- https://rmq-app.com/
- https://apps.apple.com/app/id6755972526
- https://qu.barbaleon.co.uk/
- https://qu.barbaleon.co.uk/download.html
- https://github.com/Ralve-org/RabbitScout
- https://github.com/huynhanx03/RabbitLens
- https://github.com/amigoer/mq-studio
- https://github.com/sousadiego11/easyqueue
- https://github.com/waelouf/Nanuq
- https://github.com/TurkNet/RabbitMQ-UI
- https://github.com/N0T-A-NUMB3R/MassLens
- https://github.com/topics/rabbitmq-management
- https://github.com/topics/rabbitmq-tools
- http://tryrabbitmq.com/
- https://github.com/jandelgado/rabtap
- https://github.com/jandelgado/rabtap/releases
- https://github.com/rabbitmq/rabbitmqadmin-ng
- https://github.com/rabbitmq/rabbitmqadmin-ng/releases
- https://www.rabbitmq.com/docs/management-cli
- https://formulae.brew.sh/api/formula/rabbitmqadmin.json
- https://formulae.brew.sh/api/formula/rabbitmq.json
- https://github.com/dubek/rabbitmq-dump-queue
- https://github.com/cloudamqp/amqpcat
- https://github.com/alanxz/rabbitmq-c
- https://github.com/dougbarth/amqp-utils
- https://github.com/streamdal/plumber
- https://github.com/streamdal/plumber/releases
- https://github.com/maxmindlin/rabbitui
- https://github.com/Max2535/mqx
- https://github.com/HalxDocs/dlq_inspector
- https://github.com/EasyNetQ/EasyNetQ/wiki/Re-Submitting-Error-Messages-With-EasyNetQ.Hosepipe
- https://www.rabbitmq.com/kubernetes/operator/kubectl-plugin
- https://www.rabbitmq.com/kubernetes/operator/operator-overview
- https://github.com/rabbitmq/cluster-operator
- https://github.com/rabbitmq/messaging-topology-operator
- https://github.com/cyrilgdn/terraform-provider-rabbitmq
- https://github.com/cloudamqp/terraform-provider-cloudamqp
- https://httpyac.github.io/guide/request.html
- https://open-vsx.org/api/-/search?query=rabbitmq&size=50
- https://github.com/LeoGardini/amqp-manager-vscode
- https://github.com/spockstein/MQExplorer
- https://github.com/Relrin/kurier
- https://github.com/rabbitmq/rabbitmq-perf-test
- https://github.com/rabbitmq/rabbitmq-perf-test/releases
- https://github.com/rabbitmq/omq
- https://github.com/grafana/xk6-amqp
- https://microcks.io/documentation/references/artifacts/asyncapi-conventions/
- https://www.rabbitmq.com/docs/management
- https://www.rabbitmq.com/docs/http-api-reference
- https://www.rabbitmq.com/docs/quorum-queues
- https://www.rabbitmq.com/docs/streams
- https://www.rabbitmq.com/docs/stream-filtering
- https://www.rabbitmq.com/docs/firehose
- https://www.rabbitmq.com/docs/event-exchange
- https://www.rabbitmq.com/docs/logging
- https://www.rabbitmq.com/docs/prometheus
- https://www.rabbitmq.com/docs/shovel-dynamic
- https://www.rabbitmq.com/commercial-features
- https://github.com/rabbitmq/rabbitmq-server/releases/tag/v4.3.0
- https://github.com/rabbitmq/rabbitmq-server/blob/main/deps/rabbitmq_management/priv/www/js/tmpl/queue.ejs
- https://github.com/rabbitmq/rabbitmq-server/blob/main/deps/rabbitmq_management/priv/www/js/global.js
- https://github.com/rabbitmq/rabbitmq-server/blob/main/deps/rabbitmq_management/priv/www/js/tmpl/classic-queue-get-message.ejs
- https://github.com/rabbitmq/rabbitmq-server/blob/main/deps/rabbitmq_shovel_management/priv/www/js/shovel.js
- https://cloudamqp.com/changelog.html
- https://cloudamqp.com/docs/cloudamqp-intro.html
- https://www.cloudamqp.com/docs/monitoring.html
- https://www.cloudamqp.com/docs/cloudamqp-diagnostics.html
- https://www.cloudamqp.com/blog/diagnostic-tool-for-RabbitMQ.html
- https://github.com/cloudamqp/amqp-client.js
- https://aws.amazon.com/about-aws/whats-new/2026/09/amazon-mq-rabbitmq-43/
- https://docs.amazonaws.cn/en_us/amazon-mq/latest/developer-guide/amazon-mq-release-notes.md
- https://lavinmq.com/documentation/management-interface-overview
- https://lavinmq.com/blog/lavinmq-28
- https://www.cloudamqp.com/blog/lavinmq-2.7.0-release.html
- https://github.com/cloudamqp/lavinmq/releases
- https://www.alibabacloud.com/help/en/apsaramq-for-rabbitmq/user-guide/query-messages
- https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-configure-dead-letter-queue-redrive.html
- https://docs.particular.net/platform/masstransit
- https://docs.particular.net/servicecontrol/masstransit/
- https://docs.particular.net/servicepulse/intro-failed-messages
- https://docs.particular.net/servicepulse/intro-failed-message-retries
- https://docs.particular.net/serviceinsight/
- https://discuss.particular.net/t/serviceinsight-sunset/4507
- https://warrenops.io
- https://hub.docker.com/r/viba88/warren
- https://github.com/ViBa88/warren-releases
- https://grafana.com/orgs/rabbitmq/dashboards
- https://grafana.com/grafana/dashboards/10991-rabbitmq-overview/
- https://docs.datadoghq.com/integrations/rabbitmq/
- https://docs.newrelic.com/docs/infrastructure/host-integrations/host-integrations-list/rabbitmq-monitoring-integration/
- https://www.erlang-solutions.com/capabilities/wombatoam/
- https://github.com/kbudde/rabbitmq_exporter
- https://github.com/kenliao94/mcp-server-rabbitmq
- https://github.com/amazon-mq/mcp-server-rabbitmq
- https://github.com/amazon-mq/mcp-server-rabbitmq/blob/main/src/rabbitmq/admin.py
- https://pypi.org/project/amq-mcp-server-rabbitmq/
- https://glama.ai/mcp/servers/amazon-mq/mcp-server-rabbitmq
- https://github.com/awslabs/mcp/tree/main/src/amazon-mq-mcp-server
- https://aws.amazon.com/security/security-bulletins/2026-070-aws/
- https://nvd.nist.gov/vuln/detail/CVE-2026-18655
- https://github.com/amazon-mq/mcp-amqp-transport
- https://agentpedia.codes/mcp/rabbitmq
- https://github.com/kafbat/kafka-ui
- https://github.com/provectus/kafka-ui
- https://github.com/tchiotludo/akhq
- https://github.com/redpanda-data/console
- https://github.com/redis/RedisInsight
- https://play.google.com/store/search?q=rabbitmq&c=apps
