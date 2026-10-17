# Inspiration from other brokers and adjacent tools

> **Pre-verification research (2026-10-16).** Where this conflicts with [`docs/research/fact-sheet.md`](../fact-sheet.md), the fact sheet wins. Content about a specific third-party product was removed under the docs policy ([ADR-034](../../adr/ADR-034-docs-policy.md)).

_Research angle `cross-broker-inspiration` · 2026-10-16_

## Executive summary

I looked at management tools for Kafka, NATS, the cloud queues, Pulsar, Solace and IBM MQ, plus adjacent tools (RedisInsight, Compass, pgAdmin, DBeaver, Headlamp, Lens, Postman/Bruno/Insomnia/Hoppscotch, Microcks/AsyncAPI/EventCatalog). Three patterns decide which tool becomes the de facto one.

(1) How it is delivered. Desktop-only tools are being retired in favour of shared web deployments with team controls. Conduktor shut down its Desktop app (its sign-in backend is off; the vendor's reason is that 'Kafka stopped being a one-engineer-one-laptop tool'). IBM deprecated the MQ Explorer desktop app on 13 Oct 2026, and Kubernetes replaced its Dashboard with Headlamp. The tools that win both individuals and teams build one codebase and ship it as a desktop app and a web app: pgAdmin 4, RedisInsight, NUI, Headlamp and Hoppscotch, and MongoDB reused the Compass UI inside its Atlas web console. This supports the desktop + web requirement, as long as one backend and one UI serve both.

(2) How tools got adopted. Winners are free and run with one command (Provectus kafka-ui, 12.3k stars, no paid features; its fork kafbat is in the Thoughtworks Radar 'Adopt' ring because it makes payloads readable), vendor-neutral, and trusted. Forcing logins or cloud sync caused backlash and forks (Insomnia 8; Lens leading to OpenLens and Freelens), and Bruno grew by promising to stay offline-only. Commercial leaders give away a generous free tier and charge for team features: SSO, role-based access control (RBAC), audit logs, data masking and approvals. Free tiers: Conduktor 50 users/3 clusters, Kpow 3 clusters/10 users, Lenses 5 users.

(3) Features worth copying:
- safe filter languages (CEL, JS, kJQ, SQL) with field projections;
- pluggable payload decoding (Protobuf definitions loaded from files, Git or schema registries);
- server-side dead-letter redrive with rate control, progress and cancel (AWS SQS);
- grouping failed messages by cause (Particular's ServicePulse);
- a live data-flow map whose edges show throughput (Confluent);
- rule-based health checks and alert routing;
- masking and audit;
- self-service requests within guardrails;
- detecting drift between the designed and the live setup (Solace);
- AI access through MCP under the same permissions, masking and audit as the UI.

RabbitMQ caveat: Kafka-style message browsing does not carry over directly. Reading from classic and quorum queues removes messages, and 'peeking' by requeueing has side effects: quorum queues default to a delivery limit of 20 since 4.0, and how deliveries are counted changed in 4.3. Streams are the exception: they support non-destructive reads by offset, with broker-side filtering.

## Report

# Cross-broker inspiration for a de facto RabbitMQ management & usage tool

*Angle: cross-broker-inspiration. Research date 2026-10-16. Sources: primary docs, release notes, pricing pages and GitHub repos (WebSearch + WebFetch). The session-wide WebSearch budget ran out partway through, so later checks used direct WebFetch of primary URLs; unverified items are flagged. Labels: **FACT** (sourced), **INFERENCE** (my reasoning), **IDEA** (proposal).*

---

## 1. Most decision-relevant finding: desktop-only is being retired; one codebase shipped as desktop + web wins

**FACTs**
- **Conduktor** built the best-known Kafka desktop GUI, used by 'hundreds of thousands of developers' (vendor, https://conduktor.io/blog/conduktor-retrospective-2023). It has end-of-lifed Desktop:
  - 'The auth backend has been turned off - existing installs can no longer sign in.'
  - The stated reason is that 'Kafka stopped being a one-engineer-one-laptop tool'; teams need 'shared access, audit trails, role-based permissions, and a deployment story' (https://docs.conduktor.io/desktop.md).
  - The migration path is the free, self-hosted Console Community Edition, where connections are 're-create[d] once in Console; after that they're shared with your team'.
  - The same retrospective says the SaaS 'Conduktor Cloud' was dropped because customers preferred on-prem for security, and 'Conduktor Testing' was dropped for lack of adoption.
- **IBM** deprecated the Eclipse-based **MQ Explorer** in MQ 10.0.1 (announced 13 Oct 2026). It positions the web **MQ Console** as the primary admin experience (https://www.ibm.com/new/announcements/ibm-mq-10-0-1-advancing-enterprise-messaging-with-ai-mqtt-5-0-and-enhanced-security, https://www.ibm.com/docs/SSFKSJ_latest/overview/mq_deprecations.html).
- **Kubernetes** retired its Dashboard in favour of **Headlamp** (https://kubernetes.io/blog/2026/07/13/kubernetes-dashboard-to-headlamp/).
  - Headlamp runs as a desktop app (using kubeconfig) or in-cluster (using a ServiceAccount).
  - Its UI only shows the actions the user's permissions allow, and it supports plugins (https://github.com/headlamp-k8s/headlamp).
- **MongoDB** put 'the same interface as MongoDB Compass' into the Atlas web UI (28 May 2025), 'eliminating the need for developers to toggle between desktop and web interfaces' (https://www.mongodb.com/company/blog/product-release-announcements/new-data-management-experience-in-atlas-ui).
- **Apache Pulsar Manager** is 'no longer maintained and not recommended' (https://github.com/apache/pulsar-manager). Vendor-neutral OSS UIs can wither without a business behind them.

**Single-codebase precedents (FACT)**

| Tool | Desktop shell | Web/server mode | Notes |
| --- | --- | --- | --- |
| pgAdmin 4 | Electron runtime forks the Python/Flask server | Same app behind WSGI, multi-user auth | desktop mode is single-user with no auth (https://www.enterprisedb.com/blog/pgadmin-4-architecture) |
| RedisInsight | Electron | Docker (REST API at :5540/api/docs) | NestJS + React, one codebase; SSPL; free (https://github.com/redis/RedisInsight) |
| NUI (NATS) | Go + Wails | Docker / Helm / hosted demo | 'single codebase' (https://github.com/nats-nui/nui) |
| Headlamp | Electron (Go + React) | In-cluster | plugins work in both; desktop-only plugin capabilities |
| Hoppscotch | Tauri | PWA + self-host CE/EE + CLI | MIT, 80.6k stars (https://github.com/hoppscotch/hoppscotch) |
| Kadeck | Desktop | 'Teams' web (Docker) | whether code is shared is unknown (https://www.kadeck.com/) |

**Counter-examples**
- DBeaver (desktop) vs CloudBeaver: CloudBeaver is a separate Java + React web app (https://github.com/dbeaver/cloudbeaver).
- Azure Service Bus Explorer: the community desktop app is Windows-only WinForms, separate from the portal explorer.
- Conduktor ran Desktop and Console as two products, and Desktop was the one sunset.

**INFERENCE**: The desktop app is where individuals discover a tool. Organisations standardise on, and pay for, governed shared deployments. Keeping two codebases eventually kills one of them.

**IDEA**: One UI and one backend binary:
- Desktop mode embeds the backend: localhost/IPC, OS keychain, no login.
- Server mode adds auth, RBAC, audit and a database.
- Provide 'promote my desktop connections and views to the team server'.

## 2. Why tools became de facto (adoption stories)

| Tool | Adoption signal (FACT) | Driver (INFERENCE unless cited) |
| --- | --- | --- |
| Provectus kafka-ui to kafbat UI | Provectus has 12.3k stars and says it will 'remain free and open-source, without any paid features' (https://github.com/provectus/kafka-ui). kafbat released v1.0.0 2024-03-20 through v1.5.0 2026-04-20 (https://releasealert.dev/github/kafbat/kafka-ui). Thoughtworks Radar Vol.34 (Apr 2026) puts it in **Adopt**: 'especially useful when teams need to inspect payloads that are otherwise hard to read' (https://www.thoughtworks.com/radar/tools/kafbat-ui) | free, one `docker run`, payload readability |
| AKHQ | 3.9k stars, Apache-2.0; users include BMW Group and Klarna (https://github.com/tchiotludo/akhq) | most complete free UI (masking, RBAC, audit) |
| Kafdrop | 6.1k stars (https://ossinsight.io/analyze/obsidiandynamics/kafdrop) | the simplest possible viewer |
| Conduktor | desktop at 'hundreds of thousands'; Console since Oct 2022 | great desktop UX, then upsell of team governance |
| Kpow | '10,000 active users across 100+ countries' (2023, https://www.juxt.pro/blog/clojure-in-kpow/) | kJQ data search; stateless (Kafka is its datastore); air-gap capable |
| Redpanda Console | started as Kowl, acquired by Redpanda; BSL licence (https://redpanda.com/blog/redpanda-acquires-cloudhut-kowl-data-streaming-kafka-ui) | bundled by the vendor; JS filters |
| Offset Explorer | free for personal use; commercial perpetual licence ~$67-79 (https://alternativeto.net/software/offset-explorer/about) | first-mover desktop app |
| RedisInsight | 8.9k stars; free and official; in MS Store, App Store, Snap, Flathub and Docker | vendor-official, available everywhere |
| Headlamp | Kubernetes' official successor to Dashboard; 7.5k stars | neutral; desktop + in-cluster; plugins |
| Lens to OpenLens to Freelens | Lens added a required login (Lens ID) and paid tiers, and the community forked; Freelens is MIT with 5.7k stars (https://github.com/freelensapp/freelens) | lesson: don't break trust |
| Bruno | 47.7k stars; 'Bruno is offline-only. There are no plans to add cloud-sync to Bruno, ever' (https://github.com/usebruno/bruno) | rode the backlash against Postman's push to cloud and against Insomnia 8 |
| Insomnia 8.0 (Oct 2023) | forced cloud/login caused backlash; 8.3 restored local projects ('Local Vault'), still with an account (https://github.com/Kong/insomnia/discussions/6626) | cautionary tale |
| Microcks | CNCF incubating (7 May 2026); 2.5M image downloads in 2025; supports AMQP (https://www.cncf.io/blog/2026/05/07/microcks-becomes-a-cncf-incubating-project/) | neutral governance |
| Klaw (Aiven) | Apache-2.0, 194 stars (https://github.com/Aiven-Open/klaw) | governance-only tools stay niche |

## 3. Message browsing, filtering and querying

| Tool | Language | Where it runs | Notable details |
| --- | --- | --- | --- |
| Redpanda Console | JS/TS function body that returns a boolean | backend, per record ('push-down') | injects headers, key, keySchemaID, partitionId, offset, timestamp, value, valueSchemaID; multiple filters are AND-ed; warns about CPU cost (https://docs.redpanda.com/current/console/ui/programmable-push-filters) |
| kafbat UI | CEL ('smart filters') | backend | vars: key/value (JSON if parseable), keyAsText, valueAsText, headers, partition, timestampMs; CEL replaced Groovy in v1.0.0 (https://ui.docs.kafbat.io/faq/faq.md) |
| Conduktor Console | global search (key/value/header), field search with autocomplete, JS filter, JQ projection, SQL over indexed topics | backend | saved views can be private or organisation-wide; export to JSON/CSV for re-import (https://docs.conduktor.io/guide/manage-kafka/kafka-resources/topics.md) |
| Kpow | kJQ (a jq subset), projection expressions, kREPL | streaming backend search, regex across topics | e.g. `.value.tx.amount > 11`, `test("order_")`, `//` fallbacks (https://docs.factorhouse.io/kpow/language/kjq/examples) |
| Lenses 6 | SQL Snapshot (`_key`, `_value`, headers, metadata) | engine | timestamp selector, saved queries, 'Tune Query'; warns about full scans (https://docs.lenses.io/latest/user-guide/sql-studio) |
| Confluent Cloud | jump to offset/timestamp, string filter | service | download selected messages as JSON (https://docs.confluent.io/cloud/current/client-apps/topics/messages.html) |
| Azure Service Bus Explorer | peek top 100, or from a sequence number | service | message bodies over 1 MB load on demand (https://learn.microsoft.com/en-us/azure/service-bus-messaging/explorer) |
| GCP Pub/Sub | seek to timestamp or snapshot | service | 'seek to a time in the future' purges; eventually consistent within about a minute (https://docs.cloud.google.com/pubsub/docs/replay-overview) |
| **RabbitMQ streams (native)** | Bloom filter (3.13+) plus AMQP property and SQL filter expressions | broker | filtering on the message body has to happen on the client (https://www.rabbitmq.com/docs/stream-filtering) |

**RabbitMQ translation (INFERENCE)**: Classic and quorum queues have no offsets, so a tool must do one of four things:
1. **consume and requeue**, which has side effects (see section 13);
2. **capture into a local index** and query it repeatedly;
3. **tap traffic upstream**: either a temporary queue bound with the same keys, or the firehose (`amq.rabbitmq.trace`). The firehose works per node and per vhost, 'performance will drop somewhat', and it is off after restart (https://www.rabbitmq.com/docs/firehose);
4. on **streams**, use offsets plus server-side filters.

CEL is the safest default filter language for a multi-user server because it cannot run arbitrary loops. JS and JQ can be power-user options.

## 4. Serialization & schemas

**FACT**
- **Conduktor** tries deserializers in order: schema-registry formats (Avro, Protobuf, JSON Schema), then JSON, then String, then Bytes. Users can force a format or plug in a custom deserializer.
- **Redpanda Console** maps Protobuf types per topic. The `.proto` files come from Schema Registry, the local filesystem (with `refreshInterval`), or a Git repo over HTTPS token or SSH. It also supports MessagePack (https://docs.redpanda.com/current/console/config/deserialization/).
- **kafbat** has pluggable SerDes (AWS Glue, Smile, MessagePack in v1.5.0, Hex, raw Protobuf).
- **Kpow** supports Avro, Protobuf, JSON Schema, Transit, EDN and custom serdes.
- **NUI** displays text, JSON, hex, Protobuf and CBOR.
- **RedisInsight** formats Unicode, JSON, MessagePack, hex and ASCII.

**IDEA (RabbitMQ)**:
- Auto-detect the format from AMQP `content_type`, `content_encoding` and `type`.
- Let users write mapping rules (vhost / queue / exchange / routing key / type header to a decoder).
- Load Protobuf definitions from files, Git or compiled descriptor sets.
- Optionally connect to schema registries (Confluent, Apicurio, Glue).
- Transparently decompress gzip and deflate.

RabbitMQ has no built-in schema registry, so this is the big readability win.

## 5. Dead-letter handling, redrive and replay

**FACT**
- **AWS SQS** redrive runs as asynchronous move tasks (`StartMessageMoveTask` / `ListMessageMoveTasks` / `CancelMessageMoveTask`) (https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-configure-dead-letter-queue-redrive.html):
  - Destination: back to the source queue(s) or a custom queue of the same type.
  - Speed: 'System optimized' or a custom maximum of **500 msg/s**; AWS recommends starting small.
  - Limits: 36 h per task, 100 active tasks per account. Cancelling keeps messages that already moved.
  - No filtering or editing during redrive; redriven messages get a new messageId and enqueue time.
- **Azure Service Bus Explorer** (portal):
  - Separate Peek and Receive modes. Receive has PeekLock and ReceiveAndDelete ('destructive receive' warning). Locked messages can be completed, deferred, abandoned or dead-lettered.
  - 'Re-send selected messages' sends a copy (the original stays) and lets you **edit content and properties first**.
  - Resending from a subscription's DLQ goes to the topic, so every subscription gets a copy.
  - Purge requires typing `purge`. Messages export to Excel.
- **Particular ServicePulse** groups failed messages 'by Exception Type and Stack Trace' (or by message type or endpoint). It retries whole groups with progress tracking, lets you retry one message first to test a fix, and moves deleted messages to an archive (https://docs.particular.net/servicepulse/intro-failed-messages).
- **Conduktor** reprocesses a record to the same or a different topic, with edits. DLQ reprocessing is a paid Team-edition feature.

**RabbitMQ translation**: Dynamic shovels can move messages on the broker side (https://www.rabbitmq.com/docs/shovel-dynamic):
- `src-delete-after: queue-length` makes the shovel stop after the current backlog;
- the default `ack-mode: on-confirm` acknowledges only after the destination confirms;
- `src-prefetch-count` defaults to 1000;
- the docs mention no rate limiting.

**IDEA**: Redrive tasks in the server component (or via shovels):
- choose the destination: 'back to source' from `x-death`, or a custom queue;
- pace the rate, track progress, allow cancel, and keep running if the laptop sleeps.

## 6. Security and governance

### RBAC (role-based access control)
- **Conduktor**: permissions scoped to topics, consumer groups, subjects and connectors; groups synced from the identity provider.
- **Kpow**: global and per-resource roles, plus multi-tenancy.
- **AKHQ**: group-based. **kafbat**: RBAC with LDAP/AD/OAuth2 and a default role.
- **Redpanda**: enterprise licence only. **Lenses**: IAM policies.
- **Headlamp**: the UI hides actions the user is not allowed to take.
- **Synadia Control Plane**: 'grant application owners access to view connection activity on their NATS Accounts' (https://www.synadia.com/blog/announcing-the-general-availability-of-synadia-control-plane).

### Audit
- **Conduktor** logs every action with IP, timestamp and payload across '70+ event types', and can stream the audit log to a Kafka topic (https://www.conduktor.io/compare/conduktor-vs-akhq).
- **Kpow** exposes audit via UI, webhook or topic. **Lenses** and **AKHQ** also keep audit logs.

### Data masking
- **Conduktor** (https://docs.conduktor.io/guide/conduktor-in-production/admin/data-masking.md):
  - field paths in dot notation; arrays are traversed; no wildcards;
  - rules such as `hide-all` and `hide-last-3`;
  - 'mask all fields' keeps types (numbers become 0, booleans false);
  - groups can be excluded;
  - masking applies at display time only.
- **Kpow** (https://docs.factorhouse.io/kpow/data/data-policies):
  - YAML policies scoped by cluster / topic / key, value or header;
  - 12 redaction functions, including SHA512, ShowLast4 and email variants;
  - when a function can't apply, it falls back conservatively to full redaction.
- **AKHQ, kafbat and Redpanda** mask in the UI only.

### Governance
- **Conduktor self-service** (https://docs.conduktor.io/guide/conduktor-concepts/self-service.md):
  - 'Guardrails, not gatekeeping';
  - applications own their topics;
  - access requests go to the owning team;
  - all changes go through Git.
- **Klaw**: change requests with approvals, plus reconciliation against the live cluster.
- **Lenses**: a 'Create Topic Request' permission routes topic creation to an admin for approval.
- **Kpow**: 'staged approval workflows'.
- **Confluent Data Portal**: discover topics without seeing data, then request access with owner approval (https://docs.confluent.io/cloud/current/stream-governance/data-portal.html).

### Proxy approach
**Conduktor Gateway** is a Kafka-protocol proxy with Java plugins ('interceptors'), field-level encryption, masking, tokenization and virtual clusters. **INFERENCE**: an AMQP-proxy equivalent would be extra-large effort; it belongs on the post-v1 list.

### RabbitMQ translation
RabbitMQ already has:
- users and per-vhost configure/write/read permissions (regex);
- topic permissions and user tags;
- **OAuth 2** in the management UI (UAA, Keycloak, Auth0, Entra, OAuth2 Proxy, Okta) (https://www.rabbitmq.com/docs/management).

**IDEA**: In server mode,
1. pass the user's OAuth2 identity through to RabbitMQ, so the broker enforces permissions and audit is per user;
2. layer tool-level permissions on top for things the broker can't express, e.g. 'may view bodies', 'may redrive', 'sees unmasked PII'.

## 7. Topology, lineage, catalogs and design-time tools

- **Confluent Stream Lineage** (https://docs.confluent.io/cloud/current/stream-governance/stream-lineage.html):
  - built from producer and consumer activity; by default 'for the last 10 minutes';
  - point-in-time windows range from 10 min to 24 h, or a 1 h window on any of the last 7 days;
  - nodes are topics, apps, Flink statements, Streams apps and connectors;
  - **edge thickness shows throughput**;
  - search covers topics, connectors, consumer groups and producer client IDs.
- **Lenses Topology**: built automatically, and external apps can self-register.
- **Kadeck FlowView**; **Synadia**: a topology view of all servers.
- **Solace Event Portal**: a design catalog with one-click AsyncAPI generation. A discovery agent scans the live broker, then compares it with the design: Match, Partial Match, Found only in runtime (importable), Found only in design (https://docs.solace.com/Cloud/Event-Portal/event-portal-audit-runtime-data.htm).
- **EventCatalog**: generates its docs catalog from AsyncAPI files, with automatic versioning (https://www.eventcatalog.dev/docs/plugins/asyncapi/intro.md).
- **AsyncAPI** has an AMQP 0-9-1 binding (v0.3.0) that covers exchange and queue properties and vhosts (https://www.asyncapi.com/docs/reference/bindings/amqp).

**RabbitMQ translation (FACT + IDEA)**: The Prometheus `/metrics/detailed` endpoint exposes `channel_exchange_metrics` (messages published per exchange per channel), `channel_queue_metrics` and `channel_queue_exchange_metrics` (https://www.rabbitmq.com/docs/prometheus). Combined with connection names, these allow a **live** map: publishing apps → exchanges → bindings → queues → consumers, with throughput on the edges.

## 8. Monitoring, health checks and alerting

- **Conduktor Insights** (https://docs.conduktor.io/guide/insights/risk-analysis.md):
  - risk checks graded red/orange/green with remediation steps (replication factor, partition skew formula);
  - cost control (empty or stale topics) and 'VIP topics';
  - alerts to Slack, Teams, email and webhooks.
- **Kpow Signals** (alpha): proactive detection of broker, topic and consumer issues.
- **Kadeck Health Assistant**: AI-powered diagnostics.
- **RedisInsight database analysis**: samples up to 10k keys and extrapolates; keeps historical reports; findings feed bulk-delete actions.
- **Confluent Control Center (next generation)**: rebuilt on **Prometheus**; supports 400K partitions; startup about 1 min instead of 15-50 min; released separately from the platform (https://www.confluent.io/blog/next-generation-control-center/).
- **Lenses alert channels**: CloudWatch, Datadog, PagerDuty, Alertmanager, Slack, webhooks, Teams, and email/SMS via webhooks.
- **Synadia**: customisable alert rules, including 'Accounts approaching limits'.
- **ServiceBusExplorer** desktop dashboard: live Active/DLQ/Scheduled counts, colour-coded dead-letter alerts.

**RabbitMQ (FACT)**:
- The management UI 'by design doesn't try to be a long term metric collection solution'; Prometheus is recommended.
- Metrics collection can be turned off with `disable_metrics_collector`.
- Deprecated features can be checked with `rabbitmq-diagnostics check_if_any_deprecated_features_are_used` or `GET /api/deprecated-features/used`. Detection has gaps: classic mirroring is detectable, global QoS is not (https://www.rabbitmq.com/docs/deprecated-features).

**IDEA**: A Prometheus-backed metrics mode and an upgrade-readiness checker.

## 9. Developer workflows and collaboration

- **Conduktor produce** (https://docs.conduktor.io/guide/manage-kafka/kafka-resources/topics.md):
  - saved templates;
  - 'Flow mode' produces many records at once or runs 'a live producer that will produce records at a configurable rate';
  - generates random keys and values that conform to the schema.
- **Azure send**: content type, broker properties (CorrelationId, ReplyTo, TTL, scheduled enqueue time), custom properties, and 'Repeat send' with auto-numbered MessageIds.
- **Solace 'Try Me!'** is a built-in publisher/subscriber in the broker's web console (https://docs.solace.com/Admin/Broker-Manager/PubSub-Manager-Overview.htm).
- **NUI**: pub/sub, request/reply, key-value history, stream backup/restore; 'card stack' workspaces.
- **Postman** supports HTTP, GraphQL, gRPC, WebSocket and **MQTT**, with collections (https://learning.postman.com/docs/use/send-requests/protocols/mqtt-client/mqtt-client-overview). I found no AMQP 0-9-1 support (INFERENCE).
- **Bruno** stores collections as plain-text `.bru` files in Git and has a CLI for CI.
- **Insomnia** now offers Local Vault, Cloud Sync (end-to-end encrypted) and Git Sync (https://developer.konghq.com/insomnia/storage/).
- **Microcks** turns AsyncAPI files into mocks and contract (conformance) tests, including AMQP.

**IDEA**: Git-native 'AMQP collections': publish requests plus per-environment variables, runnable from a CLI in CI. No Postman-class tool exists for AMQP.

## 10. Extensibility, automation and AI

**Plugins**
- **Headlamp**: plugins add app-bar items, sidebar entries, detail sections, pages and themes; distributed through Artifact Hub; desktop-only capabilities are gated (https://headlamp.dev/docs/latest/development/plugins/).
- **RedisInsight**: visualization plugins. **kafbat**: SerDe plugins. **Conduktor Gateway**: Java interceptors. **Freelens**: extensions.

**Automation**
- **Conduktor**: REST API, CLI and Terraform provider.
- **Kpow Community Edition**: includes 'CLI, terminal UI, and agent skills' (https://factorhouse.io/pricing).
- **Lenses**: VS Code plugin, permissions-as-code.

**AI / MCP (became standard in 2025-26)**
- **Conduktor**'s MCP server is built into Console and 'runs with the permissions of your own token'. Its tools are read-only except `set-topic-labels`, and secret-looking connector settings are redacted (https://docs.conduktor.io/guide/conduktor-in-production/automate/mcp/tools.md).
- **kafbat** serves MCP at `/mcp/sse` (https://ui.docs.kafbat.io/faq/mcp).
- **Lenses 6.2** has a remote MCP server using OAuth 2.1 with `lenses:read/write/delete` scopes and 'full audit attribution'.
- **Kpow Enterprise** advertises 'Agent access governed by RBAC, masking, and audit'.
- **Redis Copilot** (sign-in required) and **Compass** turn natural language into queries. Compass sends prompt text and schema details to Azure OpenAI (https://www.mongodb.com/docs/compass/query-with-natural-language/).
- **CloudBeaver** 26.2 added AI Chat. The **IBM MQ Agent** generates MQSC commands from natural language.

## 11. UX patterns worth copying (FACT)

- IDE-style workspace with unified search, info drawers and bulk actions (Lenses 6.2 Studio, https://docs.lenses.io/latest/changelog/lenses-hq/version-6.2.0/features-improvements-and-fixes).
- Monaco editor workbench with autocomplete and built-in guides (RedisInsight).
- Colour-coded cluster menu, custom timezone, live consumer-lag updates, full-text search (kafbat).
- Option to hide message bodies, lazy-loading of large bodies, typed confirmation for purge (Azure).
- Connection types: Production shown in brick red, confirmations required before changes (DBeaver, https://dbeaver.com/docs/dbeaver/Connection-Types/).
- Bulk-delete preview showing the expected count, then a summary of results (RedisInsight).

## 12. Packaging, distribution and pricing

**Distribution (FACT)**
- **Freelens**: Homebrew, DMG/PKG, Flathub, Snap, AppImage, DEB/RPM, AUR, WinGet, Scoop, EXE/MSI, portable.
- **RedisInsight**: Microsoft Store, Apple App Store, Snapcraft, Flathub, Docker Hub.
- **Headlamp**: Flatpak, winget, Homebrew, Helm.
- **Kpow**: Docker, Kubernetes or JAR; 'no external database required'; air-gap capable.

| Tool | Free tier | Paid entry | Model |
| --- | --- | --- | --- |
| Conduktor Console | ≤50 users, ≤3 clusters; includes SSO/LDAP and MCP | Team $125/seat/mo or $1,200/seat/yr | per seat (https://www.conduktor.io/console/team-edition) |
| Kpow | ≤3 clusters, ≤10 users | from $4,500/cluster/yr (100 users) | per cluster (https://factorhouse.io/pricing) |
| Lenses | ≤5 users; UI and MCP | Team from $4k/yr, ≤15 users | tiered (https://lenses.io/pricing) |
| Kadeck | 1 cluster; Teams free ≤5 users | Pro $19/user/mo; Enterprise $32/user/mo (min 10) | per user (https://www.kadeck.com/pricing) |
| Offset Explorer | personal use | ~$67-79 perpetual | one-time |
| Bruno | open source | Pro $6, Ultimate $11/user/mo (annual) | per user (https://www.usebruno.com/pricing) |

**INFERENCE**: Every de facto tool was either free (kafka-ui, AKHQ, RedisInsight, Headlamp) or had a generous free tier with paid team features. Paid self-hosted team features (SSO, RBAC, audit, masking, approvals) are where revenue sits.

## 13. RabbitMQ-specific caveats when borrowing Kafka-style ideas

1. **Reading from classic and quorum queues removes messages** (https://www.rabbitmq.com/docs/quorum-queues):
   - Since 4.0, quorum queues default to a delivery limit of 20. Past it, messages are dropped or dead-lettered.
   - In 4.3 the limit counts `delivery-count`. `basic.nack` increments only `acquired-count`; `basic.reject` increments both.
   - Returned messages go to a returns queue, in the order they were returned.
   - **INFERENCE (verify)**: get-and-requeue 'peeks' set the redelivered flag and change order. On 4.0-4.2, if the limit counted acquisitions, repeated peeks could dead-letter or drop messages. The tool must take the broker version and queue type into account.
2. **Streams** are non-destructive, with offsets `first/last/next/offset/timestamp`, Bloom filters (3.13+), AMQP SQL filter expressions, and super streams (3.11+). Current docs are for 4.3 (https://www.rabbitmq.com/docs/streams).
3. **Broker events**: `amq.rabbitmq.event` messages have empty bodies with the details in metadata; give consumer queues a max length (https://www.rabbitmq.com/docs/event-exchange). This can feed an audit or event timeline.
4. **Declarative config**: the definitions file and the Messaging Topology Operator CRDs (queues, exchanges, bindings, users, permissions, policies, vhosts, shovels, federation; `deletionPolicy` since v1.17) make Git-based management and drift detection possible (https://www.rabbitmq.com/kubernetes/operator/using-topology-operator).

## 14. Ranked: the 40 most transferable ideas

| # | Idea | Source tool(s) | Why it matters for RabbitMQ | Effort |
| --- | --- | --- | --- | --- |
| 3 | Generous free tier, paid team governance (open-core) | Conduktor CE, Kpow CE, Lenses CE, kafka-ui 'no paid features' | Being the default requires frictionless free use; enterprises pay for SSO, RBAC and audit | S |
| 5 | Safe peek that knows the queue type: discloses side effects, offers non-destructive alternatives | Azure peek vs ReceiveAndDelete; RabbitMQ quorum queue semantics | Requeue affects ordering and counters; quorum delivery limit 20 risks dropping or dead-lettering messages | M |
| 7 | DLQ triage by failure cause: parse `x-death` and framework headers, group, retry a group, edit and resend, archive | ServicePulse, Azure resend-with-edit, SQS | `x-death` records where a message came from; MassTransit/NServiceBus/Spring/Celery add exception headers | L |
| 8 | Broker-side redrive tasks: back to source or custom destination, rate cap, progress, cancel | SQS move tasks; RabbitMQ dynamic shovels | Client-side republish dies when the laptop sleeps; shovels have no rate limit, so pacing lives in the server | M |
| 9 | Environment profiles with safety rails: production colour, read-only mode, typed confirmations, dry-run previews | DBeaver, Azure 'purge', kafbat colours, RedisInsight previews | One-click switching between instances raises the risk of purging the wrong environment | S |
| 10 | Command palette and global search over objects and actions, tabs, info drawer, keyboard-first | Lenses 6.2 Studio, kafbat search, NUI | Brokers with thousands of queues; speed is the desktop advantage | M |
| 11 | Permission-aware UI plus OAuth2 identity passed through to RabbitMQ, with tool-level permissions on top | Headlamp, Conduktor MCP user token | Reuse RabbitMQ's own permissions and OAuth2 support instead of maintaining two RBAC systems | L |
| 12 | SSO (OIDC/SAML/LDAP), identity-provider group sync, permissions scoped by vhost/queue patterns × actions | Conduktor, Kpow, AKHQ, Lenses, Synadia | Prerequisite for enterprises to standardise on the tool | L |
| 13 | Audit log of user actions merged with a broker-event timeline; export to a stream or SIEM | Conduktor (70+ event types), Kpow, Lenses; RabbitMQ event exchange | Answers 'who purged or deleted this?'; compliance | M |
| 14 | Masking policies (body field paths and headers), role exemptions, conservative fallback, screen-share mode | Conduktor, Kpow, AKHQ/kafbat/Redpanda | Payloads carry personal data; support staff triage DLQs | M |
| 15 | Live flow map: apps → exchanges → queues → consumers, edge thickness = rate, selectable time window | Confluent Stream Lineage, Lenses Topology, Kadeck FlowView | Detailed Prometheus metrics plus connection names make it possible; a static graph shows no traffic | L |
| 16 | Health checker: findings with severity and fixes (no consumers, unbounded queues, missing DLX, deprecated features, unacked build-up, connection churn) | Conduktor Insights, Kpow Signals, Kadeck, RedisInsight | Upgrade readiness via `/api/deprecated-features/used`; RabbitMQ misconfigurations are common | M |
| 18 | MCP server and assistant: read-only by default, user-scoped, masked and audited; natural language to filters | Conduktor, kafbat, Lenses OAuth 2.1, Kpow, Redis Copilot, Compass, IBM MQ Agent | Every competitor shipped this in 2025-26; 'why is this queue growing?' | M |
| 19 | Capture messages into a local index and query them with SQL/JQ (DuckDB/SQLite on desktop, Postgres on server) | Conduktor SQL, Lenses SQL Snapshot, Kpow | Queues can't be re-read; repeated analysis needs a local copy | L |
| 20 | Stream workbench: seek by offset/timestamp, push filters to the broker, super stream partitions, consumer offsets | Confluent, Pub/Sub seek, Redpanda push-down | Streams are RabbitMQ's only non-destructive structure, and have native SQL filters | L |
| 22 | Git-native 'AMQP collections' (requests, environments, scripts) plus a CLI runner for CI | Bruno, Postman, Hoppscotch, Insomnia Git Sync | Postman has MQTT but no AMQP 0-9-1, so the slot is open | L |
| 24 | Shovel and Federation console: create, monitor, restart, auto-restart | Conduktor connectors, Lenses K2K, Redpanda shadow links | These are RabbitMQ's replication and migration tools, and today's UIs for them are thin (INFERENCE) | M |
| 25 | Definitions-as-code: visual diff, drift against Git, generate Topology Operator CRDs or Terraform | Solace runtime audit, Klaw reconcile, Conduktor GitOps | Definitions JSON and the operator exist; there is no visual drift tool (INFERENCE) | L |
| 26 | Self-service requests within guardrails (naming rules, required max-length/TTL/DLX, queue type), approval by owners | Conduktor, Klaw, Lenses, Confluent Data Portal | Shared RabbitMQ platforms with a vhost per team | L |
| 27 | Two-person approval for destructive production operations | Kpow staged approvals, Klaw | Purge or delete in production cannot be undone | M |
| 29 | Fleet overview: multi-cluster health, colour-coded ready/unacked/DLQ counts | ServiceBusExplorer dashboard, Lenses, Conduktor | Organisations often run several clusters | M |
| 30 | Packaging everywhere with auto-update (winget/Homebrew/Flathub/Snap/MSI/DMG, Docker/Helm, marketplaces) | Freelens, RedisInsight, Headlamp | 'All operating systems' and team adoption depend on it | M |
| 31 | Prometheus-backed metrics mode for history and scale | Confluent Control Center next-gen; RabbitMQ docs | Management stats have short retention and can be disabled | M |
| 32 | Plugin SDK (decoders, panels, actions, themes) with a registry | Headlamp, RedisInsight, kafbat, Freelens | Long tail of encodings and frameworks; community growth | L |
| 33 | 'Try Me' client: temporary queue bound by pattern, plus request/reply tester using direct reply-to | Solace Try Me!, NUI, Postman/Hoppscotch MQTT | Debugging topic and headers routing; testing RPC | S |
| 34 | Schema inference and a validation-violations column on sampled messages | Lenses schema inference, Conduktor violations, Compass | No registry; inferred schemas drive autocomplete, masking and test data | M |
| 36 | Large messages: size column, load body on demand, hex view | Azure Explorer (>1 MB bodies loaded on demand) | Large payloads make the UI freeze and waste bandwidth | S |
| 37 | Time-machine snapshots of definitions and stats, with 'what changed' diffs | Kpow per-minute snapshots, RedisInsight history, Confluent point-in-time lineage | Post-incident analysis; the broker keeps only short metric windows | M |
| 38 | Kubernetes and cloud discovery (RabbitmqCluster resources via kubeconfig, managed brokers) | Headlamp/Freelens, RedisInsight auto-discovery | Many clusters run under the Cluster Operator | M |
| 39 | Design-time round-trip: AsyncAPI import/export, design-vs-live checks, Microcks contract tests | Solace Event Portal, AsyncAPI Studio, EventCatalog, Microcks | AsyncAPI has an AMQP binding; documentation drifts from reality | L |
| 40 | Central hub plus lightweight agents for segmented networks | Lenses 6 HQ/agents | On-prem and edge clusters sit behind firewalls | XL |

## Feature ideas

| Idea | Persona | Priority | Size | Description | Evidence / inspiration |
| --- | --- | --- | --- | --- | --- |
| Dual-mode delivery from one codebase | platform | must | XL | Single UI + backend; desktop shell (Electron/Tauri/Wails) embeds the backend on localhost/IPC with OS keychain; same backend runs as multi-user self-hosted server (Docker/Helm) with auth, RBAC, audit and DB; 'promote desktop connections/views to team server'. | pgAdmin 4 (Electron wraps Flask server; server mode adds auth), RedisInsight (Electron + Docker), NUI (Go+Wails + Docker), Headlamp (desktop + in-cluster), Hoppscotch (Tauri + PWA); Conduktor Desktop EOL and IBM MQ Explorer deprecation show desktop-only risk |
| Local-first trust contract | all | must | S | No forced login, offline-capable desktop, no vendor cloud relay, opt-in anonymized telemetry, explicit data-residency statement; server mode is self-hosted only. | Bruno 'offline-only... no plans to add cloud-sync ever'; Insomnia 8.0 backlash (Oct 2023); Lens login change led to OpenLens/Freelens forks; RedisInsight opt-in telemetry; Conduktor Cloud dropped because customers preferred on-prem |
| Open-core packaging with generous free tier | all | must | S | Free personal/small-team tier (desktop + small server), paid team features: SSO, RBAC, audit, masking, approvals, alert routing, fleet views. | Conduktor CE free <=50 users/3 clusters; Kpow CE 3 clusters/10 users; Lenses CE 5 users; Kadeck free tier; kafka-ui popularity as fully free |
| Universal payload decoding pipeline | developer | must | L | Auto-detect via content_type/content_encoding/type; rules by vhost/queue/exchange/routing key/header; codecs JSON, XML, text, MessagePack, CBOR, Avro, Protobuf (descriptor sets from files, Git, registries), hex/base64; gzip/deflate decompression; pretty viewers. | Conduktor auto-deserializer order; Redpanda Console protobuf from filesystem/Git; kafbat pluggable SerDes (Glue, Smile, MessagePack); NUI protobuf/CBOR; Thoughtworks Radar 'Adopt' rationale for kafbat (readable payloads) |
| Queue-type-aware safe peek | operator | must | M | Detect broker version and queue type; disclose side effects of get+requeue (redelivered flag, ordering, acquired/delivery counts, delivery-limit risk); prefer non-destructive paths (streams offsets, tap queue, firehose capture); configurable max peek count. | Azure Service Bus Explorer separates non-destructive Peek from destructive ReceiveAndDelete; RabbitMQ quorum queue delivery-limit default 20 since 4.0 and 4.3 counting change |
| Expression filters and projections | developer | must | M | CEL as default safe filter language over key fields/body/headers/properties; optional sandboxed JS and JQ projections; field autocomplete from sampled messages; saved and shareable filters. | kafbat CEL smart filters (replaced Groovy in v1.0.0); Redpanda JS push-down filters; Conduktor JS filter + field search + JQ projection; Kpow kJQ |
| DLQ triage grouped by failure cause | operator | must | L | Parse x-death and framework headers (MassTransit, NServiceBus, Spring AMQP, Celery, Symfony Messenger); group by exception type/message type/origin queue; retry whole group with progress; retry one to test a fix; edit-and-resend; archive instead of hard delete. | Particular ServicePulse grouping by exception type and stack trace with group retries and archive; Azure re-send selected messages with edits |
| Broker-side redrive move tasks | operator | must | M | Long-running move jobs (DLQ to original source via x-death or custom destination) with velocity cap, progress, cancel and resumability; implemented via server component or dynamic shovel (src-delete-after=queue-length, ack-mode on-confirm). | AWS SQS StartMessageMoveTask/List/Cancel with custom max velocity up to 500 msg/s and 36h limit; RabbitMQ dynamic shovel parameters |
| Environment profiles and destructive-action safety rails | operator | must | S | Per-connection environment type (dev/test/prod) with colour, default read-only for prod, typed confirmation for purge/delete, dry-run previews of bulk operations showing counts. | DBeaver connection types (Production brick red, confirmations); Azure purge requires typing 'purge'; kafbat colored cluster menu; RedisInsight bulk-delete preview |
| Command palette and global search | developer | must | M | Keyboard-first palette for navigation and actions across all clusters/vhosts/objects; tabs; right-hand info drawer; recent items. | Lenses 6.2 Studio unified search, info panels, bulk actions; kafbat full-text search (v1.4.1); NUI card stack workspaces |
| RBAC-aware UI with OAuth2 identity pass-through | team-security | must | L | In server mode, forward user OAuth2 tokens to RabbitMQ so broker permissions apply; hide actions the user cannot perform; overlay app-level permissions (view bodies, redrive, unmasked PII). | Headlamp RBAC-aware UI (desktop kubeconfig vs in-cluster ServiceAccount); Conduktor MCP runs with user token; RabbitMQ management OAuth 2 support |
| SSO with IdP group sync and scoped roles | team-security | must | L | OIDC/SAML/LDAP login, group sync, roles scoped by cluster/vhost/resource pattern and action. | Conduktor group sync and resource-scoped RBAC; Kpow RBAC and multi-tenancy; AKHQ group RBAC; Lenses IAM; Synadia SSO |
| Audit log plus broker event timeline | team-security | must | M | Record every user action (who, what, when, IP, payload diff), export to RabbitMQ stream/SIEM/webhook, and merge with broker events from amq.rabbitmq.event into one timeline. | Conduktor audit (70+ event types, audit topic); Kpow audit via UI/webhook/topic; Lenses audits; rabbitmq_event_exchange plugin |
| Data masking policies | team-security | should | M | Mask JSON body paths and headers with strategies (full, partial, hash, email), role exemptions, conservative fallback to full redaction; desktop screen-share mode. | Conduktor masking (dot paths, hide-last-3, type-preserving mask-all, group exclusions); Kpow YAML policies with 12 redaction functions; AKHQ/kafbat/Redpanda UI masking |
| Live flow and lineage map | operator | should | L | Graph publishers (by connection name/client properties) to exchanges, bindings, queues and consumers with edge thickness by rate over selectable time windows; 'who publishes here?' search. | Confluent Stream Lineage (last 10 min default, point-in-time windows, edge thickness = throughput); Lenses Topology; Kadeck FlowView; RabbitMQ /metrics/detailed channel_exchange_metrics |
| Health advisor and upgrade readiness | operator | should | M | Rule engine with severity and remediation: queues without consumers, unbounded queues, missing DLX, unacked build-up, connection churn, classic queues for critical data, deprecated features in use. | Conduktor Insights risk analysis; Kpow Signals; Kadeck Health Assistant; RedisInsight database analysis; RabbitMQ GET /api/deprecated-features/used |
| Governed MCP server and AI assistant | all | should | M | MCP endpoint and in-app assistant, read-only by default, scoped to user permissions, masked and audited; natural language to CEL filters; 'explain this queue/incident'; bring-your-own LLM in local mode. | Conduktor MCP (user token, read-only tools except labels); kafbat MCP SSE; Lenses MCP OAuth 2.1 scopes and audit attribution; Kpow 'agent access governed by RBAC, masking, and audit'; Redis Copilot; Compass NL queries; IBM MQ Agent |
| Capture-to-local-index with SQL/JQ queries | developer | should | L | Persist captured messages (DLQ snapshots, spy sessions, firehose/tap captures) into DuckDB/SQLite (desktop) or Postgres (server) and query them repeatedly without re-consuming. | Conduktor SQL (index topics into a DB); Lenses SQL Snapshot; Kpow multi-topic search |
| Stream workbench | developer | should | L | Browse RabbitMQ streams by offset/timestamp/interval, push down Bloom and AMQP SQL/property filters, view super stream partitions, inspect and reset consumer offsets. | Confluent jump to offset/timestamp; GCP Pub/Sub seek; Redpanda push-down filters; RabbitMQ stream filtering docs |
| Shared saved views and deep links | all | should | S | Persist filters/columns/queries as private or org-shared views with URLs usable in incident channels. | Conduktor saved consume views private or org-wide; Lenses saved queries; RedisInsight Query Library |
| Git-native AMQP collections and CLI runner | developer | should | L | Publish requests (exchange, routing key, properties, headers, body templates, variables per environment, scripts) stored as plain-text files in Git; run from CLI in CI. | Bruno plain-text .bru files and CLI; Postman collections (MQTT but no AMQP); Hoppscotch; Insomnia Git Sync |
| Shovel and Federation console | operator | should | M | Create, monitor, restart dynamic shovels and federation upstreams; status and lag; optional auto-restart. | Conduktor connector management and auto-restart; Lenses K2K replicator UI; Redpanda shadow links |
| Definitions-as-code and drift detection | platform | should | L | Export/import definitions, visual diff between live broker and Git/desired state, generate Messaging Topology Operator CRDs or Terraform, PR-based change proposals. | Solace Event Portal runtime audit (match/partial/only-in-runtime/only-in-design + import); Klaw reconciliation; Conduktor GitOps/Terraform |
| Self-service with guardrails | platform | should | L | Teams request vhosts/queues/users/permissions/policies within policies (naming, required max-length/TTL/DLX, queue type); owners approve cross-team access. | Conduktor self-service 'guardrails, not gatekeeping'; Klaw; Lenses approval requests; Confluent Data Portal access requests |
| Four-eyes staged approvals | team-security | should | M | Destructive operations on production (purge, delete, policy changes, bulk redrive) require a second approver. | Kpow staged approval workflows; Klaw approvals; Conduktor federated ownership with approvals |
| Multi-cluster fleet overview | operator | should | M | Single dashboard of all clusters with health, ready/unacked/DLQ counts, colour-coded alerts and auto-refresh. | ServiceBusExplorer dashboard with colour-coded dead-letter alerts; Lenses multi-environment HQ; Conduktor multi-cluster |
| Cross-platform packaging and auto-update | platform | must | M | Signed installers and package-manager presence (winget, Scoop, MSI, Homebrew, DMG, Flathub, Snap, AppImage, DEB/RPM), Docker image, Helm chart, cloud marketplaces; delta auto-updates. | Freelens and RedisInsight distribution breadth; Headlamp Flatpak/winget/Homebrew/Helm; Kpow/Conduktor on AWS Marketplace |
| Prometheus-backed metrics mode | operator | should | M | Read metrics from RabbitMQ Prometheus endpoints or an existing Prometheus instead of management stats, for long history and large clusters. | Confluent Control Center next-gen rebuilt on Prometheus; RabbitMQ docs recommending Prometheus and allowing disable_metrics_collector |
| Time-machine snapshots | operator | could | M | Periodic snapshots of definitions and key stats with 'what changed' diffs between two points in time. | Kpow gathers cluster state every minute into internal topics; RedisInsight historical analysis reports; Confluent point-in-time lineage |
| Plugin and extension SDK | platform | should | L | Extension points for decoders, panels, actions, themes and integrations, with a registry; sandboxed desktop-only capabilities. | Headlamp plugins via Artifact Hub; RedisInsight visualization plugins; kafbat SerDe plugins; Freelens extensions; Conduktor Gateway interceptors |
| Try-Me and RPC tester | developer | should | S | Subscribe to an exchange with a binding pattern via a temporary exclusive queue and see messages live; publish; request/reply tests using direct reply-to with correlation matching and latency. | Solace Broker Manager Try Me!; NUI pub/sub and request/reply; Postman/Hoppscotch MQTT clients |
| Schema inference and validation violations | developer | could | M | Infer JSON schema and field statistics from sampled messages; validate against JSON Schema/Protobuf and flag violations in a column. | Lenses 6.2 schema inference for non-registry topics; Conduktor 'Marking Violations' display column; MongoDB Compass schema analysis and validation |
| Large-message handling | developer | must | S | Show body size, lazy-load bodies above a threshold, truncate previews, hex view, option to browse without bodies. | Azure Service Bus Explorer does not retrieve bodies for >1 MB entities by default and offers Hide message body |
| Kubernetes and cloud discovery | operator | should | M | Discover RabbitmqCluster resources via kubeconfig with port-forwarding and credentials from Secrets; discover managed brokers where APIs allow. | Headlamp/Freelens kubeconfig-based access; RedisInsight auto-discovery of local, cloud and Azure databases |
| AsyncAPI round-trip and contract testing | platform | could | L | Import AsyncAPI (AMQP binding 0.3.0) to create topology and publish templates; export live topology to AsyncAPI; audit runtime vs spec; integrate Microcks mocks/contract tests. | Solace Event Portal AsyncAPI generation and runtime audit; AsyncAPI Studio; EventCatalog generator; Microcks AMQP (CNCF incubating) |
| HQ plus agent architecture | platform | could | XL | Central web hub with lightweight agents deployed next to clusters in segmented networks, outbound-only connectivity. | Lenses 6 HQ control plane with per-environment agents |
| CLI and TUI companion | operator | could | M | CLI and terminal UI sharing connection profiles, views and auth with the GUI for scripting and SSH sessions. | Kpow Community Edition ships CLI, terminal UI and agent skills; Conduktor CLI |
| Workbench console for HTTP API and CLI commands | operator | could | M | Monaco-based console with autocomplete and inline docs for management HTTP API calls and common rabbitmqadmin/rabbitmqctl equivalents, with result visualizations. | RedisInsight Workbench (Monaco, command autocomplete, built-in guides) |
| Server-mode secrets management | team-security | must | M | OS keychain on desktop; KMS/Vault-backed encryption of broker credentials in server mode; never store plaintext; support short-lived OAuth tokens. | Synadia Control Plane secrets via AWS KMS/Azure Key Vault/GCP KMS/HashiCorp Vault; ServiceBusExplorer Entra sign-in without storing SAS secrets |
| Air-gapped, dependency-light server | platform | should | M | Server runs with embedded storage by default (optional Postgres), no outbound internet needed, offline license activation. | Kpow 'no external database required' and air-gap capable; Conduktor Cloud failure due to on-prem preference |
| Usage and chargeback attribution | platform | could | M | Per vhost/team/application usage reports (connections, queues, message rates, storage) for shared platforms. | Conduktor chargeback and partner zone traffic analytics |
| Automation API and Terraform provider for the tool | platform | could | M | Public REST API, OpenAPI docs and Terraform provider for tool-level configuration (users, roles, masking, alerts, views). | Conduktor REST API/CLI/Terraform; kafbat Swagger API docs; RedisInsight Docker API docs |
| Accessibility compliance | all | should | M | Keyboard navigation, screen-reader labels, contrast and WCAG conformance for enterprise procurement. | Kpow documentation has a dedicated Accessibility section |

## Claims flagged for verification

- **[high]** Conduktor Desktop has reached end-of-life: 'The auth backend has been turned off - existing installs can no longer sign in', with the rationale that 'Kafka stopped being a one-engineer-one-laptop tool'; users are directed to the free self-hosted Console Community Edition.
  - Why it matters: Strongest market signal that a desktop-only tool cannot become the team standard; validates the desktop + web requirement and a single-codebase architecture.
  - Sources: https://docs.conduktor.io/desktop.md https://www.conduktor.io/auth-failure.md https://conduktor.io/blog/conduktor-retrospective-2023
- **[high]** IBM deprecated IBM MQ Explorer in IBM MQ 10.0.1 (announced 13 October 2026), 'with no new functional enhancements being added', positioning the web-based MQ Console as the primary admin experience.
  - Why it matters: A second enterprise messaging vendor moving from desktop GUI to web console, three days before this research; supports web-first team strategy.
  - Sources: https://www.ibm.com/new/announcements/ibm-mq-10-0-1-advancing-enterprise-messaging-with-ai-mqtt-5-0-and-enhanced-security https://www.ibm.com/docs/SSFKSJ_latest/overview/mq_deprecations.html
- **[medium]** Kubernetes Dashboard was retired in favour of Headlamp, which runs both as a desktop app (kubeconfig) and in-cluster (ServiceAccount), is RBAC-aware and plugin-extensible.
  - Why it matters: Shows the winning delivery model in an adjacent ecosystem is 'both desktop and web from one codebase', not either alone.
  - Sources: https://kubernetes.io/blog/2026/07/13/kubernetes-dashboard-to-headlamp/ https://github.com/headlamp-k8s/headlamp
- **[medium]** Starting with RabbitMQ 4.0 the quorum queue delivery limit defaults to 20 (excess deliveries are dropped or dead-lettered); in 4.3 the limit is based on delivery-count, where basic.nack increments only acquired-count and basic.reject increments both.
  - Sources: https://www.rabbitmq.com/docs/quorum-queues
- **[medium]** RabbitMQ streams support server-side filtering via Bloom filters (since 3.13) and AMQP 1.0 property and SQL filter expressions; streams are non-destructive with offset/timestamp attach points.
  - Why it matters: Streams are the only RabbitMQ structure where Kafka-style push-down browsing (Redpanda/kafbat/Lenses patterns) transfers directly; the release that introduced SQL filter expressions is still unverified.
  - Sources: https://www.rabbitmq.com/docs/stream-filtering https://www.rabbitmq.com/docs/streams
- **[high]** Free tiers of the leading commercial Kafka UIs (as of Oct 2026): Conduktor Community up to 50 users and 3 clusters (includes SSO/LDAP and MCP); Kpow Community up to 3 clusters and 10 users (includes CLI, TUI, agent skills); Lenses Community up to 5 users (UI and MCP).
  - Why it matters: Sets the free-tier bar a new RabbitMQ tool must meet or beat to become the default, and indicates which features are typically gated.
  - Sources: https://www.conduktor.io/pricing https://factorhouse.io/pricing https://lenses.io/pricing
- **[medium]** Paid pricing benchmarks: Conduktor Team $125/seat/month or $1,200/seat/year; Kpow Enterprise from $4,500 per cluster per year (100 users); Lenses Team from $4k/year up to 15 users; Kadeck Professional $19/user/month and Enterprise $32/user/month (min 10); Offset Explorer perpetual ~$67-79 and free for personal use.
  - Sources: https://www.conduktor.io/console/team-edition https://factorhouse.io/pricing https://lenses.io/pricing https://www.kadeck.com/pricing https://alternativeto.net/software/offset-explorer/about
- **[high]** AWS SQS DLQ redrive runs as asynchronous server-side move tasks to the source or a custom queue, with velocity control up to 500 messages/second, a 36-hour maximum per task, 100 active tasks per account, cancellation, and no filtering or modification during redrive.
  - Why it matters: Reference design for a robust RabbitMQ redrive feature (progress, cancel, rate cap, survives client disconnect).
  - Sources: https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-configure-dead-letter-queue-redrive.html
- **[high]** Filter languages in leading Kafka UIs: Redpanda Console runs JavaScript filters server-side per record; kafbat UI uses CEL (replacing Groovy in v1.0.0); Kpow uses kJQ (a jq subset); Lenses uses SQL Snapshot; Conduktor offers JS filters plus JQ projections.
  - Why it matters: Choosing the filter language is an architecture decision for a multi-user server mode (sandboxing, performance, learnability).
  - Sources: https://docs.redpanda.com/current/console/ui/programmable-push-filters https://ui.docs.kafbat.io/faq/faq.md https://github.com/kafbat/kafka-ui/releases https://docs.factorhouse.io/kpow/language/kjq/examples https://docs.lenses.io/latest/user-guide/sql-studio https://docs.conduktor.io/guide/manage-kafka/kafka-resources/topics.md
- **[high]** AI access is governed like human access in leading tools: Conduktor's built-in MCP server runs with the user's token and exposes read-only tools except set-topic-labels; Lenses 6.2's remote MCP uses OAuth 2.1 scopes (read/write/delete) with audit attribution; Kpow Enterprise advertises 'Agent access governed by RBAC, masking, and audit'.
  - Why it matters: Defines the minimum acceptable security model for an MCP/AI feature in a RabbitMQ tool.
  - Sources: https://docs.conduktor.io/guide/conduktor-in-production/automate/mcp/tools.md https://docs.lenses.io/latest/changelog/lenses-hq/version-6.2.0/features-improvements-and-fixes https://factorhouse.io/pricing
- **[medium]** Conduktor discontinued its SaaS 'Conduktor Cloud' because customers preferred on-premise solutions for security, and discontinued 'Conduktor Testing' for insufficient adoption.
  - Why it matters: Argues for self-hosted web mode rather than a vendor-hosted SaaS, and cautions against a separate testing product.
  - Sources: https://conduktor.io/blog/conduktor-retrospective-2023
- **[medium]** Postman's messaging protocol support covers MQTT (3.1.1 and 5.0) but no AMQP 0-9-1 client was found in its documentation.
  - Why it matters: If true, a Postman-class 'AMQP collections' capability is an open niche for the RabbitMQ tool.
  - Sources: https://learning.postman.com/docs/use/send-requests/protocols/mqtt-client/mqtt-client-overview
- **[high]** Kafbat UI (community successor of Provectus kafka-ui, 12.3k stars on the original repo) is in the Thoughtworks Technology Radar Vol. 34 (April 2026) 'Adopt' ring, cited as especially useful to inspect payloads that are otherwise hard to read.
  - Why it matters: Evidence that free + payload readability is what makes a broker UI the default choice.
  - Sources: https://www.thoughtworks.com/radar/tools/kafbat-ui https://github.com/provectus/kafka-ui https://releasealert.dev/github/kafbat/kafka-ui
- **[high]** Microcks became a CNCF incubating project on 7 May 2026 and supports AMQP among its asynchronous protocols for AsyncAPI-based mocking and contract testing.
  - Why it matters: Viable integration partner for design-time/testing features instead of building mocking in-house.
  - Sources: https://www.cncf.io/blog/2026/05/07/microcks-becomes-a-cncf-incubating-project/

## Open questions

- Exact Conduktor Desktop end-of-life date and user count at shutdown (docs confirm EOL and auth shutdown; 'end of 2025' came only from a search snippet of the former download page).
- On RabbitMQ 4.0-4.2, does basic.get + nack/requeue count toward the quorum queue delivery limit (acquired-count based)?
- Which RabbitMQ release introduced AMQP SQL filter expressions for streams (believed 4.2), and are they usable from AMQP 0-9-1 / stream-protocol clients or only AMQP 1.0?
- Does x-death reliably carry enough information (original exchange, routing keys, queue) for automatic 'redrive to source' across all queue types and dead-letter reasons in RabbitMQ 4.x, including AMQP 1.0 clients?
- Licensing choice for the new product (OSS, source-available like Redpanda BSL, or proprietary open-core); community-fork risk if it later moves from OSS to commercial (Lens precedent).
- Whether Kadeck Desktop and Kadeck Teams share a single codebase (relevant precedent) - not verified.
- Lens command palette and keyboard-first UX could not be verified (docs URL returned 404 after redirect).
- Bruno's earlier one-time 'Golden Edition' licence history (current pricing page shows only subscriptions) - unverified, so the one-time to subscription trend in dev tools is not evidenced here.
- Whether Broadcom/VMware Tanzu RabbitMQ plans a first-party advanced web console or message browser that could compete - outside this angle and not researched.
- Confluent Control Center 2.5.0 (Apr 2026) support for Kafka queues/share groups was seen only in a search snippet; Kafka gaining queue semantics may shift competitive positioning for RabbitMQ tools.
- Kpow kJQ throughput ('tens of thousands of messages a second') and adoption numbers ('10,000 active users', 2023) are vendor claims with no independent verification.
- The session-wide WebSearch budget ran out partway through; NATS desktop newcomers (e.g. 'NATS Studio'), StreamNative Console's current feature set, and Postman/Hoppscotch AMQP roadmap plans were not fully researched.

## Sources

- https://www.conduktor.io/compare/kafka-ui-tools.md
- https://www.conduktor.io/compare/conduktor-vs-akhq
- https://www.conduktor.io/compare/conduktor-vs-redpanda-console
- https://docs.conduktor.io/desktop.md
- https://www.conduktor.io/auth-failure.md
- https://www.conduktor.io/blog/why-you-should-consider-migrating-to-conduktor-console
- https://conduktor.io/blog/conduktor-retrospective-2023
- https://www.conduktor.io/pricing
- https://www.conduktor.io/console/team-edition
- https://docs.conduktor.io/llms.txt
- https://docs.conduktor.io/guide/manage-kafka/kafka-resources/topics.md
- https://docs.conduktor.io/guide/conduktor-in-production/automate/mcp.md
- https://docs.conduktor.io/guide/conduktor-in-production/automate/mcp/tools.md
- https://docs.conduktor.io/guide/conduktor-in-production/admin/data-masking.md
- https://docs.conduktor.io/guide/insights/risk-analysis.md
- https://docs.conduktor.io/guide/conduktor-concepts/self-service.md
- https://docs.conduktor.io/gateway.md
- https://github.com/kafbat/kafka-ui
- https://github.com/kafbat/kafka-ui/releases
- https://releasealert.dev/github/kafbat/kafka-ui
- https://ui.docs.kafbat.io/faq/faq.md
- https://ui.docs.kafbat.io/faq/mcp
- https://www.thoughtworks.com/radar/tools/kafbat-ui
- https://github.com/provectus/kafka-ui
- https://github.com/tchiotludo/akhq
- https://akhq.io/
- https://ossinsight.io/analyze/obsidiandynamics/kafdrop
- https://docs.redpanda.com/current/console/ui/programmable-push-filters
- https://docs.redpanda.com/current/console/
- https://docs.redpanda.com/current/console/config/deserialization/
- https://redpanda.com/blog/redpanda-acquires-cloudhut-kowl-data-streaming-kafka-ui
- https://factorhouse.io/kpow
- https://factorhouse.io/pricing
- https://docs.factorhouse.io/kpow/getting-started
- https://docs.factorhouse.io/kpow/language
- https://docs.factorhouse.io/kpow/language/kjq/examples
- https://docs.factorhouse.io/kpow/data
- https://docs.factorhouse.io/kpow/data/data-policies
- https://docs.factorhouse.io/kpow/signals
- https://www.juxt.pro/blog/clojure-in-kpow/
- https://hub.docker.com/r/factorhouse/kpow
- https://lenses.io/pricing
- https://lenses.io/blog/lenses-6-multi-kafka
- https://docs.lenses.io/latest/changelog/lenses-hq/version-6.2.0/features-improvements-and-fixes
- https://docs.lenses.io/latest/user-guide/sql-studio
- https://docs.lenses.io/latest/llms.txt
- https://docs.lenses.io/latest/devx/6.1/user-guide/topology.md
- https://docs.lenses.io/latest/devx/6.1/user-guide/topics/environment-topic-catalogue/approval-requests.md
- https://docs.lenses.io/latest/devx/6.1/user-guide/monitoring-and-alerting/integrations.md
- https://www.kadeck.com/
- https://www.kadeck.com/pricing
- https://alternativeto.net/software/offset-explorer/about
- https://www.confluent.io/blog/next-generation-control-center/
- https://docs.confluent.io/control-center/current/release-notes.md
- https://docs.confluent.io/cloud/current/stream-governance/stream-lineage.html
- https://docs.confluent.io/cloud/current/stream-governance/data-portal.html
- https://docs.confluent.io/cloud/current/client-apps/topics/messages.html
- https://github.com/Aiven-Open/klaw
- https://aiven.io/blog/introducing-klaw-for-apache-kafka-governance
- https://github.com/nats-nui/nui
- https://www.synadia.com/blog/announcing-the-general-availability-of-synadia-control-plane
- https://learn.microsoft.com/en-us/azure/service-bus-messaging/explorer
- https://github.com/paolosalvatori/ServiceBusExplorer
- https://raw.githubusercontent.com/paolosalvatori/ServiceBusExplorer/main/README.md
- https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-configure-dead-letter-queue-redrive.html
- https://docs.cloud.google.com/pubsub/docs/replay-overview
- https://github.com/apache/pulsar-manager
- https://docs.streamnative.io/docs/streamnative-console
- https://docs.solace.com/Admin/Broker-Manager/PubSub-Manager-Overview.htm
- https://docs.solace.com/Cloud/Event-Portal/event-portal-audit-runtime-data.htm
- https://solace.com/products/portal
- https://www.ibm.com/new/announcements/ibm-mq-10-0-1-advancing-enterprise-messaging-with-ai-mqtt-5-0-and-enhanced-security
- https://www.ibm.com/docs/SSFKSJ_latest/overview/mq_deprecations.html
- https://redis.io/docs/latest/develop/tools/insight
- https://github.com/redis/RedisInsight
- https://www.mongodb.com/company/blog/product-release-announcements/new-data-management-experience-in-atlas-ui
- https://www.mongodb.com/docs/compass/query-with-natural-language/
- https://www.enterprisedb.com/blog/pgadmin-4-architecture
- https://www.pgadmin.org/docs/pgadmin4/9.13/desktop_deployment.html
- https://github.com/dbeaver/cloudbeaver
- https://dbeaver.com/docs/dbeaver/Connection-Types/
- https://github.com/headlamp-k8s/headlamp
- https://headlamp.dev/docs/latest/development/plugins/
- https://kubernetes.io/blog/2026/07/13/kubernetes-dashboard-to-headlamp/
- https://github.com/freelensapp/freelens
- https://dev.to/alexandrev/freelens-vs-openlens-vs-lens-choosing-the-right-kubernetes-ide-lc8
- https://github.com/usebruno/bruno
- https://www.usebruno.com/pricing
- https://medium.com/@vignarajj/why-i-switched-to-bruno-for-api-testing-a-developers-journey-c610b5cdea59
- https://github.com/Kong/insomnia/discussions/6626
- https://developer.konghq.com/insomnia/storage/
- https://github.com/hoppscotch/hoppscotch
- https://learning.postman.com/docs/use/send-requests/protocols/mqtt-client/mqtt-client-overview
- https://www.cncf.io/blog/2026/05/07/microcks-becomes-a-cncf-incubating-project/
- https://www.eventcatalog.dev/docs/plugins/asyncapi/intro.md
- https://www.asyncapi.com/docs/reference/bindings/amqp
- https://www.asyncapi.com/blog/asyncapi-studio-from-single-file-to-real-world-usage
- https://docs.particular.net/servicepulse/intro-failed-messages
- https://awslabs.github.io/mcp/servers/amazon-mq-mcp-server
- https://www.rabbitmq.com/docs/quorum-queues
- https://www.rabbitmq.com/docs/management
- https://www.rabbitmq.com/docs/firehose
- https://www.rabbitmq.com/docs/streams
- https://www.rabbitmq.com/docs/stream-filtering
- https://www.rabbitmq.com/docs/shovel-dynamic
- https://www.rabbitmq.com/docs/event-exchange
- https://www.rabbitmq.com/docs/prometheus
- https://www.rabbitmq.com/docs/deprecated-features
- https://www.rabbitmq.com/kubernetes/operator/using-topology-operator
