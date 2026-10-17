# Differentiators and strategy

> **Pre-verification research (2026-10-16).** Where this conflicts with [`docs/research/fact-sheet.md`](../fact-sheet.md), the fact sheet wins. Content about a specific third-party product was removed under the docs policy ([ADR-034](../../adr/ADR-034-docs-policy.md)).

> **Superseded recommendation:** this report recommends an open-core model. The maintainer chose **fully open source** ([ADR-031](../../adr/ADR-031-fully-open-source.md)).

_Research angle `differentiators-and-strategy` · 2026-10-16_

## Executive summary

Late 2026 is a good moment to build the default RabbitMQ tool. Three things favour it:
- **Built-in metrics are going away.** The management UI ships with every broker, but its metrics are deprecated in favour of Prometheus.
- **The newest tooling is commercial-only.** Broadcom keeps its management-UI Linter, Stream Browser, Message Scheduler and AMQP-over-WebSocket in paid Tanzu RabbitMQ.
- **Upgrades never stop.** Community support is short: 4.2 ended 2026-07-31 and 4.3 ends 2027-01-31.

Warren is a self-hosted DLQ console at v0.17. Neither serves developers, operators and platform teams together.

The strongest differentiators, ranked:
1. A DLQ operations centre: framework-aware decoding, throttled replay, replay verification and undo.
2. A message workbench whose peek and live-tap respect RabbitMQ's real side effects (redelivery flag, quorum-queue delivery limits).
3. An open-source stream browser with offset/timestamp navigation and 4.2 SQL filters.
4. A version-aware linter plus an upgrade and migration advisor.
5. One codebase that ships both a local-first desktop app and a self-hosted team web server.
6. Prometheus-first diagnostics that answer "why is this queue growing?"
7. Topology-as-code: diff, plan and drift detection, with Terraform and Kubernetes-operator export.
8. A governed MCP server and an AI copilot grounded in the deterministic diagnostics.

Basic MCP access already exists: Amazon MQ's open-source RabbitMQ MCP server (v4.0.0) ships with write actions off by default. The defensible part is governance, because any publisher can plant instructions in a message that an AI agent will read.

**Recommended business model: open core.**
- An Apache-2.0 core with every single-user workflow free for any use: no login, no telemetry by default, offline licences.
- Paid Team/Enterprise governance on the self-hosted server: SSO, role-based access control (RBAC), audit, approvals, masking, AI governance.
- Per-seat annual pricing that keeps working after cancellation (perpetual fallback), plus a public pledge never to relicense the core or move free features behind the paywall.
- Lens, Postman, Insomnia, Redis and HashiCorp all show what breaking that trust costs.

**Naming.** Broadcom's guidelines allow "<Name> for RabbitMQ" but forbid "RabbitMQ" in product, company or domain names and reserve the logo.

## Report

# Differentiators & go-to-market strategy for a de facto RabbitMQ tool
*Angle: differentiators-and-strategy. Researched 2026-10-16.*

**Method and caveats.** Facts come from primary pages fetched on 2026-10-16 (links inline). The WebSearch budget shared by all agents ran out partway through the session. A few threads are therefore listed as open questions instead of answered: Lenses/Kpow AI features, other open-source RabbitMQ web UIs, and Amazon MQ plugin/metrics specifics. Labels: **FACT** = sourced, **INFERENCE** = my reasoning, **IDEA** = proposal.

## 1. Signals that shape differentiation

### 1.1 RabbitMQ keeps changing under every tool

**RabbitMQ 4.3 (FACT)** — [release blog, 2026-04-23](https://www.rabbitmq.com/blog/2026/04/23/rabbitmq-4.3-release); 4.3.6 shipped 2026-09-14 ([GitHub](https://api.github.com/repos/rabbitmq/rabbitmq-server/releases?per_page=8)):
- Khepri is the only metadata store. Mnesia and the partition-handling strategies are removed.
- Quorum queues gain:
  - 32 strict priority levels;
  - native delayed retries (`x-delayed-retry-type/min/max`);
  - per-queue consumer timeouts;
  - `x-acquired-count`, separate from `x-delivery-count`.
- The delayed-message-exchange plugin is archived.
- rabbitmqadmin v2.35.0 (2026-09-09) already targets forward compatibility with RabbitMQ 4.4.0 ([release](https://api.github.com/repos/rabbitmq/rabbitmqadmin-ng/releases/latest)).

**Commercial-only features (FACT)**
- Tanzu 4.3 adds a Management-UI **Linter**, a **Stream Browser**, a Message Scheduler, and a JMS queue type with a non-destructive browser.
- AMQP 1.0 over WebSocket is "a closed-source feature available exclusively" in Tanzu ([blog](https://www.rabbitmq.com/blog/2025/04/16/amqp-websocket)).
- **INFERENCE:** users of OSS RabbitMQ, Amazon MQ and CloudAMQP have no linter and no stream browser. That gap is unclaimed.
- **INFERENCE:** a web edition will need its own server-side component to talk AMQP.

**Metrics are moving to Prometheus (FACT)**
- `management_metrics_collection` is on the [deprecated list](https://www.rabbitmq.com/release-information/deprecated-features-list).
- With the collector disabled, "all charts and detailed statistics will be hidden in the UI". The docs recommend Prometheus and Grafana instead ([management](https://www.rabbitmq.com/docs/management)).
- `/metrics/per-object` can be up to 60× more expensive than filtered `/metrics/detailed` ([prometheus](https://www.rabbitmq.com/docs/prometheus)).

**Short support windows (FACT)** — [release information](https://www.rabbitmq.com/release-information)
- Community support for 4.1 ended 2026-01-31, for 4.2 on 2026-07-31; 4.3 ends 2027-01-31.
- Commercial support runs into 2028–2030.
- Upgrades from 3.13 must go through 4.2 to reach 4.3. "RabbitMQ 3.13 with Khepri enabled cannot be upgraded to 4.x" ([upgrade](https://www.rabbitmq.com/docs/upgrade)).
- **INFERENCE:** upgrade pressure never stops, so an upgrade advisor keeps delivering value.

**AMQP 1.0 clients and stream filtering (FACT)**
- The official AMQP 1.0 clients (Java, .NET, Go, Python, JS; RabbitMQ 4.0+) manage topology natively over AMQP, without the HTTP plugin ([clients](https://www.rabbitmq.com/client-libraries/amqp-client-libraries)).
- Stream SQL filter expressions (4.2) combined with Bloom filters exceed 4M msg/s ([blog](https://www.rabbitmq.com/blog/2025/09/23/sql-filter-expressions)).

**Managed providers keep pace (FACT)**
- Amazon MQ has supported 4.3 since 2026-09-10 ([AWS](https://aws.amazon.com/about-aws/whats-new/2026/09/amazon-mq-rabbitmq-43/)).
- CloudAMQP ([changelog](https://www.cloudamqp.com/changelog/)): 4.3 available on 2026-08-27; 4.0 deprecated on 2026-06-22; several OTLP log integrations shipped in 2026.

### 1.2 Reference points

- **INFERENCE:** the pace is slowing.
- Peek is `basic.get` plus requeue.
- The live spy is a shadow queue that copies the target queue's bindings.

**Warren** ([warrenops.io](https://warrenops.io), v0.17; FACT)
- Self-hosted web console for dead-letter operations.
- Groups failures, verifies replays at 5 min / 30 min / 2 h / 1 day, and offers dry-run with a frozen set of messages.
- 7-day undo window and an audit log.
- RBAC and four-eyes approval are in the Team/Pro editions.
- No telemetry. Free Community tier; Team/Pro will be one-time purchases with 12 months of updates ("coming soon").
- Offers a free x-death decoder page.

**Discovery channel (FACT)** — rabbitmq.com's [devtools page](https://www.rabbitmq.com/client-libraries/devtools)
- New entries are added by contacting the team or editing the site repo.

**MCP is already commoditised (FACT)** — [amazon-mq/mcp-server-rabbitmq](https://github.com/amazon-mq/mcp-server-rabbitmq), Apache-2.0, v4.0.0 on 2026-07-28 ([release](https://api.github.com/repos/amazon-mq/mcp-server-rabbitmq/releases/latest))
- 61 tools collapsed into 31 dispatchers, cutting tool tokens by about 60%.
- Tool groups; mutating tools are off unless you pass `--allow-mutative-tools`.
- OAuth and JWT/JWKS authentication, SSRF protection, and passwords stripped from exports.
- 16 skills, for example `broker_recommendations`, `dlq_summary`, `trace_message_route` and `policy_conflict_detection`.

## 2. Ranked differentiators (25)

Ranking weighs: (a) how often the pain occurs and how many users have it; (b) the gap left by the management UI and Warren; (c) defensibility; (d) feasibility. Complexity is S/M/L/XL.

| # | Differentiator | Why it wins (evidence) | Feasibility notes |
| --- | --- | --- | --- |
| 3 | **Stream browser and replay.** Navigate by offset or timestamp, SQL and Bloom filters, super-stream partitions, re-drive to an exchange, export. | Tanzu's Stream Browser is paid-only. SQL filters arrived in 4.2. | **M–L.** SQL filters need an AMQP 1.0 client. Older brokers fall back to client-side filtering. |
| 4 | **Version-aware linter plus upgrade and migration advisor**, with a CI mode. | The Tanzu Linter is paid-only. Building blocks exist: [deprecated-features API](https://www.rabbitmq.com/docs/deprecated-features), rabbitmqadmin `health_check deprecated_features_in_use` ([CLI](https://www.rabbitmq.com/docs/management-cli)), the upgrade checklist, and [CloudAMQP best practices](https://www.cloudamqp.com/blog/part1-rabbitmq-best-practice.html). The QQ docs recommend DLX on every quorum queue. | **M.** Rules are pure functions over definitions and metrics, versioned per broker release. Some deprecated features cannot be detected (global QoS). |
| 5 | **One codebase, two surfaces.** Local-first desktop app plus a self-hosted team web server (SSO, RBAC, audit, approvals). | Conduktor moved from Desktop to its web Console because platform teams need central rules ([retro](https://www.conduktor.io/blog/conduktor-retrospective-2023)). RedisInsight ships both Electron and Docker builds ([repo](https://github.com/redis/RedisInsight)). | **XL.** A shared UI over a backend that runs either as a desktop sidecar or as a server. Secrets, auth and updates differ per surface. |
| 7 | **Topology-as-code control plane.** Snapshot, diff, plan/apply and drift detection. Export to definitions JSON, Terraform, the Kubernetes Messaging Topology Operator (MTO) and Pulumi. CI lint. | [cyrilgdn/rabbitmq](https://registry.terraform.io/v1/providers/cyrilgdn/rabbitmq) has 28.9M downloads (v1.10.1, 2025-09-05), but its README lists support only up to 3.13. The [rfd59 fork](https://registry.terraform.io/v1/providers/rfd59/rabbitmq) covers 4.1. [MTO](https://www.rabbitmq.com/kubernetes/operator/using-topology-operator) reconciles only on create/update/delete by default and has immutable fields. | **L.** Apply in dependency order. Flag "forces replacement" when queue arguments are immutable. |
| 8 | **Governed MCP server.** stdio on desktop, OAuth-protected HTTP on web. Inherits connections, guardrails, RBAC, masking, approvals and audit. | [Conduktor](https://www.conduktor.io/pricing.md): AI actions inherit user RBAC. [kafbat](https://ui.docs.kafbat.io/llms-full.txt) offers MCP over SSE. [Confluent MCP](https://github.com/confluentinc/mcp-confluent) has tool allow/block lists. The [MCP spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices) forbids token passthrough. | **M.** Expose the app's existing action layer. Read-only by default; payload access is a separate scope. |
| 9 | **Grounded AI copilot.** Bring your own model, including local models. Answers cite evidence. | Comparable tools already ship this: Redis Copilot ([docs](https://redis.io/docs/latest/develop/tools/insight/)), DBeaver AI chat ([repo](https://github.com/dbeaver/dbeaver)) and [Grafana Assistant](https://grafana.com/docs/grafana-cloud/machine-learning/assistant/). | **L.** Metadata-only by default. Payloads are opt-in and masked. |
| 13 | **OpenTelemetry correlation.** Detect `traceparent` and deep-link to Jaeger, Tempo or Datadog. Show a message's journey. | [.NET client 7](https://github.com/rabbitmq/rabbitmq-dotnet-client/pull/1261) propagates trace context through headers. [Semantic conventions](https://opentelemetry.io/docs/specs/semconv/messaging/rabbitmq/) are still at Development status. [W3C traceparent](https://www.w3.org/TR/trace-context/). | **S–M.** URL templates only; no backend coupling. |
| 14 | **PII detection and masking** in the UI, exports, AI context and audit. | kafbat has MASK/REMOVE/REPLACE rules. Conduktor sells data masking in its Team tier. | **M.** |
| 15 | **Production guardrails.** Environment tags, read-only prod, typed confirmations, dry-run on a frozen set, four-eyes approval (web), undo. | Warren; Conduktor approvals; kafbat audit levels. | **S** on desktop, **L** on web. |
| 17 | **Migration wizard.** Blue-green, classic mirrored queues → quorum queues, cluster moves. | The [RabbitMQ blog](https://www.rabbitmq.com/blog/2025/07/29/latest-benefits-of-rmq-and-migrating-to-qq-along-the-way) prescribes blue-green with federation. amazon-mq has migration tools. | **L.** |
| 18 | **AsyncAPI round-trip and EventCatalog export.** | The [AMQP binding 0.3.0](https://www.asyncapi.com/docs/reference/bindings/amqp) does not model exchange-to-queue bindings, queue arguments or DLX. Related work: [Scribano](https://nordicapis.com/8-asyncapi-documentation-generators/), the [EventCatalog generator](https://github.com/event-catalog/generator-asyncapi) and [Springwolf](https://github.com/springwolf/springwolf-core). | **L.** Needs `x-rabbitmq-*` extensions. **IDEA:** propose them upstream. |
| 19 | **Contract validation and schema-drift alerts** on sampled traffic. | Apicurio compatibility rules. | **M.** |
| 22 | **Load and chaos lab.** Runs [omq](https://github.com/rabbitmq/omq), [PerfTest](https://github.com/rabbitmq/rabbitmq-perf-test) and [Toxiproxy](https://github.com/Shopify/toxiproxy). | omq covers AMQP 1.0 and 0.9.1, MQTT, STOMP and streams, and exposes Prometheus metrics. | **M.** Block runs against prod-tagged connections. |
| 23 | **Executable runbooks and notebooks.** | RedisInsight Workbench and tutorials. | **M.** |
| 24 | **Extension SDK** for codecs, panels, lint rules and actions. | RedisInsight plugins; Lens extension API ([repo](https://github.com/lensapp/lens)); kafbat SerDe. | **L.** |
| 25 | **Collaboration.** Git-synced views on desktop; workspaces, permalinks and comments on web. | Postman's free plan is limited to 1 user ([pricing](https://www.postman.com/pricing/)). Beekeeper charges for cloud workspaces ([pricing](https://www.beekeeperstudio.io/pricing/)). | **M–L.** |

**Table stakes (parity, not differentiation).** Full management-UI CRUD for vhosts, users, permissions, limits, policies, feature flags, definitions, connections, channels and consumers. Plus quick search, custom views, dark theme, JSON editor and multi-instance switching.

**Suggested sequencing (INFERENCE)**
- **Wedge, v1 desktop:** #1–4, #10, #11, the desktop part of #15, and part of #16.
- **Expand, v2 web:** #5–8, #12–14, #20.
- **Moat:** #9, #17–19, #21–25.

## 3. AI and MCP: rules for safe design

**The core risk (FACT)**
- Simon Willison's "lethal trifecta": an agent with private data, untrusted content and outbound communication can "easily" be tricked into leaking ([Willison](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)).
- **INFERENCE:** message bodies are attacker-controllable, because anyone with publish rights can write them.

**IDEA: design rules**
1. Tools return metadata by default (counts, rates, definitions, x-death summaries). Reading payloads requires a separate scope, applies masking, and labels the content as untrusted data.
2. Mutating actions return a plan or diff. A human applies it, and prod changes need approval.
3. Remote MCP uses tokens issued to the server, never passthrough. Use least-privilege scopes with step-up, and bind session IDs to users. The spec recommends stdio for local servers "to limit access to just the MCP client" ([spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices)).
4. Offer tool groups and dispatcher-style tools to save tokens (the amazon-mq v4 approach).
5. Audit the agent's identity together with the human who authorised it.
6. The copilot narrates linter and diagnostic evidence rather than reasoning from scratch.

**Forward signal (FACT).** MQ Summit, 21–22 Oct 2026 in Haarlem, lists a talk "Powering Asynchronous AI Agent Communication with MCP over AMQP" ([mqsummit.com](https://mqsummit.com/)). **IDEA:** an "agent traffic" lens that decodes JSON-RPC/MCP payloads.

## 4. GitOps, observability and contract specifics

**rabbitmqadmin v2 (FACT)** — export transforms ([CLI docs](https://www.rabbitmq.com/docs/management-cli)):
- `strip_cmq_keys_from_policies`, `drop_empty_policies`, `obfuscate_usernames`, `exclude_users`, `exclude_permissions`, `exclude_runtime_parameters`, `exclude_policies`.
- The 2025 migration blog also mentions `prepare_for_quorum_queue_migration`, but the docs and README do not list it. Needs verification.
- **IDEA:** use definitions JSON as the internal canonical model, and generate HCL, MTO YAML and Pulumi from it.

**Drift (INFERENCE).** MTO does not continuously reconcile by default, and Terraform only notices drift when someone runs plan. Scheduled drift reports against Git therefore add real value.

**Tracing (FACT)**
- Producers "SHOULD attach a creation context" that intermediaries cannot change.
- Producer and consumer spans are related through links ([messaging spans](https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/)).
- **IDEA:** the tool emits spans for its own replays, linked to the original creation context.

**CloudEvents (FACT).** The binding targets AMQP 1.0. Attributes travel as application-properties prefixed `cloudEvents_` or `cloudEvents:`; structured mode uses `application/cloudevents+json`.

**Code generation (FACT).** The AsyncAPI Initiative maintains `@asyncapi/dotnet-rabbitmq-template` and `@asyncapi/php-template` ([README](https://app.unpkg.com/@asyncapi/generator@2.7.1/files/README.md)).

## 5. How comparable tools became, or stopped being, the default

| Tool | Model | Traction (FACT) | Lesson |
| --- | --- | --- | --- |
| UI for Apache Kafka (Provectus) | Apache-2.0; README promises no paid features | 12.3k stars; [448M Docker pulls](https://hub.docker.com/v2/repositories/provectuslabs/kafka-ui/); last image 2024-04-10 | Free plus a one-line Docker run wins. Single-vendor stewardship can stall, after which [kafbat](https://github.com/kafbat/kafka-ui) forked it (2.8k stars; RBAC, masking, MCP; sponsor-funded). |
| AKHQ | Apache-2.0 | ~3.2k stars; [31.6M pulls](https://hub.docker.com/v2/repositories/tchiotludo/akhq/) | Self-hosted web is the norm for team tools. |
| RedisInsight | Free, vendor-backed, SSPL | 8.9k stars; desktop plus Docker; app stores; opt-in telemetry; plugins; Copilot (requires sign-in) | A vendor-funded free tool with wide distribution. |
| Lens → Freelens | Proprietary EULA with paid tiers above a $10M revenue threshold | "The open source version of Lens Desktop has been retired" ([repo](https://github.com/lensapp/lens)); [Freelens](https://github.com/freelensapp/freelens) is MIT, 5.7k stars | Closing an open product spawns forks. |
| Postman | Freemium cloud | Scratch Pad "no longer available in Postman v10.18 and later" ([docs](https://learning.postman.com/docs/getting-started/basics/using-scratch-pad/)) | Removing offline mode pushed users to alternatives. |
| Bruno | MIT plus subscriptions | 47.7k stars; "offline-only … no plans to add cloud-sync … ever"; Pro $6 / Ultimate $11 per user per month ([pricing](https://www.usebruno.com/pricing)) | A local-first pledge acts as a growth engine. |
| DBeaver | Apache-2.0 community edition plus PRO and the CloudBeaver web edition | 52.1k stars | Open core across desktop and web works at scale. |
| Beekeeper Studio | GPLv3 plus commercial Ultimate | 23.8k stars; $9–18 per user per month with "perpetual fallback" | Perpetual fallback softens resistance to subscriptions. |
| TablePlus | Commercial, perpetual | $99 with 1 year of updates ([pricing](https://www.tableplus.com/pricing)) | Works, but stays niche. |
| Conduktor | Desktop → self-hosted Console | Desktop had "hundreds of thousands" of users; then "auth backend has been turned off" ([docs](https://docs.conduktor.io/desktop.md)). Console Community is free (50 users, 3 clusters); Team costs $125/seat/month and adds approvals, masking and audit. | Governance sells on the web. Login-dependent desktop apps die when the vendor pivots. |

**Pitfalls (FACT)**
- Insomnia 8.0 (Sept 2023) pushed users to log in and sync to the cloud. Local-only projects came back in 8.3 ([Kong CTO post](https://medium.com/@subnetmarco/insomnia-8-0-cloud-synchronization-12ed5a341eb0); medium confidence).
- Redis moved to SSPL in 2024. Redis says it "hurt our relationship with the Redis community" and added AGPL back in May 2025 ([Redis](https://redis.io/blog/agplv3/)).
- HashiCorp moved to BSL 1.1 on 2023-08-10 ([HashiCorp](https://www.hashicorp.com/blog/hashicorp-adopts-business-source-license)).
- Elastic added AGPL back on 2024-08-29 ([Elastic](https://www.elastic.co/blog/elasticsearch-is-open-source-again)).

## 6. Business-model options

**A. Pure OSS plus sponsorship and services** (kafka-ui, AKHQ, Freelens)
- **Pros:** maximum trust, outside contributions, few enterprise legal blockers, easiest path to partner listings.
- **Cons:** sustainability. Provectus paused development, and kafbat depends on sponsors. Little money for code signing, multi-OS QA, keeping up with RabbitMQ's roughly 6-month support cadence, or AI and governance work.

**B. Open core with governance-tier pricing** (DBeaver, Beekeeper, Bruno, Conduktor) — **recommended**
- **Shape:** an Apache-2.0 core containing every single-user workflow, on both desktop and web.
- **Paid Team/Enterprise features on the self-hosted server:** SSO/SCIM, granular RBAC, audit export to SIEM, four-eyes approvals, central masking policies, AI governance, fleet views, alert integrations and SLA support.
- **Pros:** individual developers never hit a paywall; organisations pay for organisational needs (Conduktor's lesson); the revenue funds sustained development.
- **Cons:** the free/paid boundary needs discipline; licence infrastructure is required; clones of the open core are possible.

**C. Commercial desktop app, one-time licence** (TablePlus, Offset Explorer, Warren Team/Pro)
- **Pros:** simple; revenue from day one.
- **Cons:**
  - Caps adoption, and there is no source code for security reviews.
  - One-time revenue underfunds continuous compatibility work.
  - Tutorials and docs rarely standardise on a paid tool.

**Variant: source-available.** FSL converts to Apache or MIT after two years ([fsl.software](https://fsl.software/)); BSL is the other common choice. Either deters clones but is not OSI-approved and risks the backlash described above. Not recommended if the goal is de facto status.

**Recommendation: B, with these guardrails**
1. Free for any use: no revenue threshold (unlike Lens), no login, no telemetry by default.
2. Charge only for features whose buyer is the organisation.
3. Publish a charter: free features never become paid, and the core licence never changes.
4. Per-seat annual pricing with perpetual fallback, around $8–12 per user per month. That sits between Bruno and Beekeeper, below Postman Team ($19), and far below Conduktor ($125). Enterprise is custom.
5. Signed licence files that work offline.
6. Offer hosted SaaS only later, and only after SOC 2.

## 7. Go-to-market playbook

All items below are IDEAs grounded in the precedents above.

**Distribution**
- Desktop: winget, Homebrew cask, Flathub, Snap, AppImage, deb/rpm, and the Microsoft and Mac App Stores (RedisInsight precedent).
- Web: Docker image plus Helm chart, and a one-line compose snippet to run next to `rabbitmq:management`.
- Later: a VS Code extension.
- The official RabbitMQ image has [3.89B Docker pulls](https://hub.docker.com/v2/repositories/library/rabbitmq/), which is the funnel to tap.

**Ecosystem**
- Get listed on rabbitmq.com devtools.
- CloudAMQP/84codes runs 31,000+ brokers for 4,100+ customers ([84codes](https://www.84codes.com/)): integrate their API and co-market.
- AWS: interoperate with the amazon-mq MCP server and list on AWS Marketplace.
- Seventh State, an Erlang Solutions brand that sells RabbitMQ support ([site](https://seventhstate.io/)), as a services channel.
- Talks at MQ Summit (AWS and CloudAMQP are sponsors).

**Content and SEO**
- Free web utilities: x-death decoder (Warren already has one), topic-pattern and policy-pattern testers, definitions linter, AMQP URI builder, 4.x upgrade checker.
- Upgrade guides timed to support-window deadlines.
- Error-explainer pages.

**Community**
- Discord, a plugin SDK, and Developer Certificate of Origin (DCO) sign-off rather than a CLA.

**Trust**
- OS keychain for secrets, no account required, opt-in telemetry only.
- Signed and notarised builds with SBOMs (rabbitmqadmin publishes CycloneDX and SPDX).
- A security.txt, a published threat model, and an auto-updater that enterprises can control.

## 8. Naming, positioning and trademark

**What the guidelines say (FACT)** — [RabbitMQ trademark guidelines](https://www.rabbitmq.com/trademark-guidelines)
- Tools may be titled "Foobar for RabbitMQ".
- "You may not … create a software product name that includes the 'RabbitMQ' trademark."
- "You must not use RabbitMQ or any confusingly similar phrase in a domain name."
- Logos are "reserved solely for use by Broadcom".
- Expected attribution: "RabbitMQ is a trademark of Broadcom, Inc. in the U.S. and other countries."
- Contact: rabbitmq-core@groups.vmware.com.

**INFERENCE**
- A distinct coined brand is safer and builds its own equity.
- Avoid rabbit silhouettes that resemble the logo, and use the descriptor "… for RabbitMQ".
- Check for collisions; for example, "Warren" is already taken.

**Positioning (IDEA)**
- Tagline: "The open-source workbench and control plane for RabbitMQ: debug messages, fix failures and govern topology, on your desktop or self-hosted for your team."
- Own "open + team + safe AI" instead.
- Name directions (illustrative, not cleared): flow metaphors or coined words. Clear the `.dev`/`.io` domain, USPTO/EUIPO trademarks and npm/GitHub names before committing.

## Feature ideas

| Idea | Persona | Priority | Size | Description | Evidence / inspiration |
| --- | --- | --- | --- | --- | --- |
| Failure fingerprinting across DLQs | developer | should | M | Group dead-lettered messages by exception type/message/stack hash using framework headers (NServiceBus.ExceptionInfo.*, Spring x-exception-message, MassTransit fault info) and flag new failure groups. | Warren failure aggregation; NServiceBus headers docs; Spring RepublishMessageRecoverer docs |
| Replay verification and undo window | operator | should | M | Tag replays with a replay id, watch for re-deaths at intervals, keep discarded/purged messages in an encrypted vault for N days for restore. | Warren replay verification (5m/30m/2h/1d) and 7-day undo |
| Stream browser | developer | must | L | Non-destructive navigation of streams and super streams by offset, timestamp, head/tail with SQL filter expressions (4.2+, AMQP 1.0) and Bloom filters, plus range export. | Tanzu 4.3 Stream Browser is commercial-only; RabbitMQ 4.2 SQL filter blog; streams docs |
| Stream re-drive | operator | should | M | Replay a filtered stream range into an exchange or queue with throttling for reprocessing and backfills. | RabbitMQ stream offset specs; Conduktor message reprocessing in Console Community |
| Framework envelope lenses | developer | should | M | Recognize and pretty-print MassTransit, NServiceBus, Spring AMQP and Celery messages showing message type, correlation/conversation ids and fault info. | MassTransit exceptions docs (_error/_skipped); NServiceBus headers docs; Spring AMQP docs |
| Schema registry integration and validation | platform | could | M | Resolve schemas from Apicurio or Confluent-compatible registries; validate on publish and on sampled traffic; alert on schema drift. | Apicurio Registry (Apache-2.0, multi-format, Confluent-compatible API) |
| CloudEvents-aware viewer | developer | could | S | Detect binary (cloudEvents_ / cloudEvents: application properties) and structured (application/cloudevents+json) events and render attributes. | CloudEvents AMQP protocol binding spec |
| Trace deep links | developer | should | S | Detect W3C traceparent in headers/application-properties and open the trace in Jaeger, Tempo, Honeycomb or Datadog via URL templates; show trace ids on DLQ items. | W3C Trace Context; OTel RabbitMQ semconv; RabbitMQ .NET client 7 ActivitySource |
| Tool-emitted spans for replays | operator | could | M | Optionally emit OTel spans for replay/republish actions linked to the message creation context so replays appear in the original trace. | OTel messaging spans guidance on creation context and links |
| Prometheus-first metrics engine | operator | must | L | Read /metrics/detailed with family and vhost filters, fall back to the management HTTP API, add provider metrics; keep working when management metrics are disabled. | management_metrics_collection deprecated; RabbitMQ Prometheus docs (per-object up to 60x cost) |
| Why is this queue growing diagnosis | operator | must | M | Deterministic decision tree over publish/deliver/ack rates, consumer count and utilisation, unacked vs prefetch, redeliveries, alarms/flow control, queue type and policy limits, with evidence and recommended actions. | amazon-mq MCP skills queue_metrics_analysis / queue_health_assessment; CloudAMQP best practices |
| Best-practice linter | platform | must | M | Versioned rule catalog over definitions and metrics (quorum queues without DLX, unbounded queues, connection/channel churn, prefetch, more than 5 priorities, detailed stats mode) with fix plans and a CLI/CI mode. | Tanzu 4.3 Linter (commercial-only); CloudAMQP best practices; quorum queue docs DLX recommendation |
| Upgrade and deprecation advisor | operator | must | M | Check deprecated features in use, stable feature flags, upgrade path (3.13 to 4.2 to 4.3), Khepri status, quorum-critical nodes and alarms, then produce a step plan. | RabbitMQ upgrade guide; deprecated features API; rabbitmqadmin health_check deprecated_features_in_use; release support timeline |
| Blue-green and CMQ-to-QQ migration wizard | platform | should | L | Export definitions with transforms, provision target, configure federation/shovels, move consumers then producers, track drain to zero. | RabbitMQ 2025 migration blog; rabbitmqadmin v2 transforms; amazon-mq migration tools |
| Topology snapshot, diff, plan and apply | platform | must | L | Compare any two sources (live broker, Git file, other environment), produce a plan with forces-replacement flags for immutable queue arguments, apply in dependency order with approvals. | amazon-mq compare_definitions; Messaging Topology Operator immutable fields; definitions import/export |
| IaC export and import | platform | should | M | Export topology to definitions JSON, Terraform (cyrilgdn or rfd59 providers), Messaging Topology Operator CRDs and Pulumi, and import from them. | Terraform registry (28.9M downloads for cyrilgdn/rabbitmq); MTO CRDs; Pulumi rabbitmq package |
| Scheduled drift detection | platform | should | M | Periodically compare live brokers to the Git/IaC source of truth and report or alert on drift. | Messaging Topology Operator reconciles only on create/update/delete events by default |
| RabbitMQ 4.3 feature forms | developer | must | S | First-class UI for quorum queue 32 priorities, delayed retries (x-delayed-retry-*), consumer timeouts, x-acquired-count and stream filters, gated by broker version. | RabbitMQ 4.3 release blog |
| Governed MCP server | all | must | M | stdio MCP on desktop and OAuth-protected remote MCP on web reusing saved connections, environment guardrails, RBAC, masking, approvals and audit; read-only by default, tool groups, dispatcher-style tools. | amazon-mq/mcp-server-rabbitmq v4; Conduktor MCP with RBAC inheritance; kafbat MCP; Confluent MCP; MCP security best practices |
| Grounded AI copilot | all | should | L | Chat that answers from linter/diagnostic evidence and docs, supports BYO cloud keys or local models, metadata-only by default, cites the metrics it used. | Redis Copilot; DBeaver AI chat; Grafana Assistant |
| AI topology authoring to plan | developer | could | M | Describe intent (e.g., retries with backoff using 4.3 delayed retries) and receive a reviewable plan/diff that is never auto-applied. | RabbitMQ 4.3 delayed retries; lethal trifecta guidance |
| PII detection and masking policies | team-security | should | M | Detect emails, card numbers (Luhn), IBANs and tokens; mask, remove or replace by field pattern per vhost/queue across UI, exports, AI context and audit. | kafbat data masking (MASK/REMOVE/REPLACE); Conduktor Team data masking |
| Team server governance | team-security | must | L | Self-hosted web edition with OIDC/SAML SSO, SCIM, RBAC, four-eyes approvals for destructive actions and topology applies, audit log with SIEM export. | Warren Team/Pro; Conduktor Team approvals and audit; Bruno Ultimate SSO/SCIM/audit |
| Load test lab | platform | could | M | Configure and run omq or PerfTest scenarios locally or as Kubernetes jobs, chart throughput and latency, blocked on prod-tagged connections. | rabbitmq/omq (multi-protocol, Prometheus metrics); rabbitmq-perf-test |
| Chaos toggles | developer | could | S | Spin up Toxiproxy between local apps and the broker to inject latency, resets and bandwidth limits. | Shopify Toxiproxy toxics list |
| Executable runbooks | operator | could | M | Markdown notebooks mixing docs with live actions (queries, publish, lint, charts) for incidents and onboarding, stored in Git. | RedisInsight Workbench and tutorials |
| AsyncAPI round-trip | platform | should | L | Generate AsyncAPI 3.0 with x-rabbitmq extensions from live topology plus inferred payload schemas; import AsyncAPI to produce a topology plan; export to EventCatalog. | AsyncAPI AMQP binding 0.3.0 gaps; Scribano; EventCatalog AsyncAPI generator; Springwolf |
| Extension SDK | platform | could | L | Sandboxed plugins for codecs, panels, lint rules and actions, with a registry later. | RedisInsight plugins; Lens extension API; DBeaver OSGi plugins; kafbat SerDe |
| Agent traffic lens | developer | could | M | Decode JSON-RPC / MCP or agent-to-agent payloads carried over AMQP to inspect AI agent conversations on queues. | MQ Summit 2026 talk Powering Asynchronous AI Agent Communication with MCP over AMQP |
| One-line deploy and multi-channel install | platform | must | S | Docker image and Helm chart for the web edition, compose snippet beside rabbitmq:management, desktop installers via winget, Homebrew, Flathub and Snap. | provectus kafka-ui 448M Docker pulls; AKHQ 31.6M pulls; RedisInsight multi-store distribution |

## Claims flagged for verification

- **[high]** RabbitMQ trademark guidelines (Broadcom) allow titles of the form '<Name> for RabbitMQ', forbid company or software product names that include 'RabbitMQ', forbid 'RabbitMQ or any confusingly similar phrase' in domain names, reserve the logos solely for Broadcom, and expect the attribution 'RabbitMQ is a trademark of Broadcom, Inc. in the U.S. and other countries.'
  - Why it matters: Determines product name, domain, app icon and marketing copy; a wrong choice forces a costly rebrand.
  - Sources: https://www.rabbitmq.com/trademark-guidelines
- **[high]** In RabbitMQ 4.3 the Management-UI Linter, Stream Browser and Message Scheduler are commercial Tanzu-only features, and AMQP 1.0 over WebSocket (introduced in 4.1) is a closed-source Tanzu-only feature.
  - Why it matters: Defines the open-source gap (linter, stream browser) the product can own, and implies the web edition needs a server-side component rather than browser-direct AMQP.
  - Sources: https://www.rabbitmq.com/blog/2026/04/23/rabbitmq-4.3-release https://www.rabbitmq.com/blog/2025/04/16/amqp-websocket
- **[high]** management_metrics_collection is a deprecated feature; when the management metrics collector is disabled all charts and detailed statistics are hidden in the UI; RabbitMQ recommends Prometheus/Grafana, and /metrics/per-object can be up to 60x more expensive than filtered /metrics/detailed.
  - Why it matters: The metrics/diagnostics engine must be Prometheus-first with careful endpoint selection, not built only on the management HTTP API.
  - Sources: https://www.rabbitmq.com/release-information/deprecated-features-list https://www.rabbitmq.com/docs/management https://www.rabbitmq.com/docs/prometheus
- **[medium]** Quorum queues default to delivery-limit 20 since RabbitMQ 4.0; in 4.3 basic.nack / AMQP 1.0 released no longer increment x-delivery-count (x-acquired-count added) while basic.reject still does;
  - Why it matters: Core 'peek' and DLQ features can silently destroy or dead-letter production messages if settle semantics are wrong per version.
- **[high]** amazon-mq/mcp-server-rabbitmq (Apache-2.0) v4.0.0, released 2026-07-28, exposes RabbitMQ to AI agents via 31 dispatcher tools (consolidated from 61), selectable tool groups, mutative tools disabled unless --allow-mutative-tools, OAuth and JWT/JWKS auth, SSRF protection, and 16 diagnostic skills.
  - Why it matters: Plain MCP access is not a differentiator; the product must win on governance, integration and UX, or interoperate with this server.
  - Sources: https://github.com/amazon-mq/mcp-server-rabbitmq https://api.github.com/repos/amazon-mq/mcp-server-rabbitmq/releases/latest
- **[high]** RabbitMQ community support for 4.2 ended 31 Jul 2026 and for 4.3 ends 31 Jan 2027; 3.13 must upgrade via 4.2 to 4.3, and 3.13 with Khepri enabled cannot be upgraded to 4.x in place.
  - Why it matters: Sets the version-support matrix and justifies an upgrade/migration advisor as a recurring-value feature.
  - Sources: https://www.rabbitmq.com/release-information https://www.rabbitmq.com/docs/upgrade
- **[medium]** The cyrilgdn/rabbitmq Terraform provider has about 28.9M downloads (latest 1.10.1, 2025-09-05) while its README states support for RabbitMQ 3.10-3.13; the rfd59/rabbitmq fork (2.6.0, 2025-08-31, about 623k downloads) states support for 3.12-4.1.
  - Why it matters: Confirms Terraform-managed topology is mainstream and fragmented, shaping which IaC export targets to support.
  - Sources: https://registry.terraform.io/v1/providers/cyrilgdn/rabbitmq https://registry.terraform.io/v1/providers/rfd59/rabbitmq https://github.com/cyrilgdn/terraform-provider-rabbitmq https://github.com/rfd59/terraform-provider-rabbitmq
- **[medium]** The Messaging Topology Operator reconciles only on create/update/delete events by default (time-based reconciliation optional), forbids updates to name/vhost/cluster reference, and recommends policies over queue arguments because queue properties cannot change after creation; latest release v1.20.4 on 2026-10-13.
  - Why it matters: Justifies drift detection and an immutable-argument migration planner as differentiators for Kubernetes users.
  - Sources: https://www.rabbitmq.com/kubernetes/operator/using-topology-operator https://api.github.com/repos/rabbitmq/messaging-topology-operator/releases/latest
  - Why it matters: A primary, high-trust discovery channel the product must get onto at launch.
  - Sources: https://www.rabbitmq.com/client-libraries/devtools
  - Why it matters: Defines where to differentiate (offline/air-gapped trust, team web, AI) and signals the incumbent's pace.
- **[high]** Conduktor retired its desktop app (auth backend turned off so existing installs cannot sign in) in favour of a self-hosted web Console whose free Community tier allows up to 50 users and 3 clusters, with approvals, data masking and audit logs in the Team tier at $125/seat/month, and MCP plus Skills in all tiers with AI actions inheriting user RBAC.
  - Why it matters: Strong precedent for putting monetized governance in the web edition and for RBAC-inheriting AI; also a warning against login-dependent desktop apps.
  - Sources: https://docs.conduktor.io/desktop.md https://www.conduktor.io/pricing.md https://www.conduktor.io/blog/conduktor-retrospective-2023
- **[medium]** AsyncAPI AMQP bindings 0.3.0 describe exchanges and queues as channels and message/operation properties but do not model exchange-to-queue bindings, queue arguments such as x-queue-type, or DLX configuration.
  - Why it matters: AsyncAPI round-trip (generate/import topology) requires custom x-rabbitmq extensions or an upstream binding proposal.
  - Sources: https://www.asyncapi.com/docs/reference/bindings/amqp
- **[medium]** The open-source version of Lens Desktop has been retired and Lens moved to a proprietary EULA requiring paid subscriptions for organizations above $10M revenue/funding (grace period to 2023-01-02); Freelens (MIT, about 5.7k stars) carries the open code forward.
  - Why it matters: Key licence-change backlash precedent informing the open-core charter and avoidance of revenue-threshold EULAs.
  - Sources: https://github.com/lensapp/lens https://github.com/freelensapp/freelens https://www.businesswire.com/news/home/20220728005140/en
- **[high]** Bruno (MIT, about 47.7k GitHub stars) states 'There are no plans to add cloud-sync to Bruno, ever' and sells Pro at $6 and Ultimate at $11 per user/month billed annually.
  - Why it matters: Evidence that a local-first pledge drives adoption, and a pricing anchor for the Team tier.
  - Sources: https://github.com/usebruno/bruno https://www.usebruno.com/pricing
- **[medium]** Official RabbitMQ AMQP 1.0 client libraries (RabbitMQ 4.0+) can declare and delete exchanges, queues and bindings natively over AMQP without the HTTP management plugin, and stream SQL filter expressions (4.2+) are an AMQP 1.0 capability.
  - Why it matters: Shapes the client stack: the stream browser and some topology operations need an AMQP 1.0 client, with HTTP API used for discovery and fallbacks.
  - Sources: https://www.rabbitmq.com/client-libraries/amqp-client-libraries https://www.rabbitmq.com/blog/2025/09/23/sql-filter-expressions

## Open questions

- Exact quorum-queue delivery-count behaviour on RabbitMQ 4.0-4.2 for basic.nack(requeue=true), basic.get + requeue and the HTTP API 'Get messages' ack modes: do they count toward the default delivery-limit of 20? The 4.2 docs are ambiguous.
- Does Amazon MQ for RabbitMQ expose the Prometheus endpoint (port 15692), the stream protocol port, local-protocol shovels and the firehose? Can tracing be enabled there without rabbitmqctl? The fetched AWS page did not load reliably.
- Is LavinMQ's HTTP API compatible enough with the RabbitMQ management API to support LavinMQ cheaply, as an olive branch to 84codes?
- Does rabbitmqadmin's prepare_for_quorum_queue_migration transformation actually ship? A 2025 RabbitMQ blog mentions it, but the docs and README do not list it.
- Which rules does the Tanzu 4.3 Linter check? Knowing them would help us position against it and avoid inadvertently copying it.
- What do RabbitMQ 4.4 changes imply for the HTTP API and management features? rabbitmqadmin 2.35.0 already mentions forward compatibility with 4.4.0.
- Would Broadcom object to rabbit-themed names or imagery? Is there any formal permission or partner-listing process beyond the rabbitmq-core email address?
- Warren Team/Pro pricing, adoption, and whether it will add developer-facing features.
- Not researched because the shared WebSearch budget ran out: Lenses and Kpow AI/MCP features, other open-source RabbitMQ web UIs, Datadog/New Relic AI features for RabbitMQ, Postman's 2026 plan changes, and verification of MassTransit MT-Fault-* header names and of the Insomnia 8.3 date.
- Whether a hosted SaaS edition is worth doing at all, given custody of broker credentials and the cost of SOC 2.
- Market size: there is no reliable public count of RabbitMQ deployments or developers. Docker Hub's 3.89B pulls of the official image and CloudAMQP's 31,000+ brokers are only proxies.
- When Bruno moved from the $19 one-time Golden Edition to subscription tiers, and how the community reacted. This is useful evidence for the one-time vs subscription decision.

## Sources

- https://www.rabbitmq.com/trademark-guidelines
- https://www.rabbitmq.com/blog
- https://www.rabbitmq.com/blog/2026/04/23/rabbitmq-4.3-release
- https://www.rabbitmq.com/blog/2025/04/16/amqp-websocket
- https://www.rabbitmq.com/blog/2025/09/23/sql-filter-expressions
- https://www.rabbitmq.com/blog/2025/07/29/latest-benefits-of-rmq-and-migrating-to-qq-along-the-way
- https://www.rabbitmq.com/release-information
- https://www.rabbitmq.com/release-information/deprecated-features-list
- https://www.rabbitmq.com/docs/deprecated-features
- https://www.rabbitmq.com/docs/upgrade
- https://www.rabbitmq.com/docs/management
- https://www.rabbitmq.com/docs/management-cli
- https://www.rabbitmq.com/docs/prometheus
- https://www.rabbitmq.com/docs/firehose
- https://www.rabbitmq.com/docs/dlx
- https://www.rabbitmq.com/docs/quorum-queues
- https://www.rabbitmq.com/docs/4.2/quorum-queues
- https://www.rabbitmq.com/docs/shovel-dynamic
- https://www.rabbitmq.com/docs/streams
- https://www.rabbitmq.com/client-libraries/amqp-client-libraries
- https://www.rabbitmq.com/client-libraries/devtools
- https://www.rabbitmq.com/kubernetes/operator/using-topology-operator
- https://github.com/rabbitmq/messaging-topology-operator
- https://api.github.com/repos/rabbitmq/messaging-topology-operator/releases/latest
- https://github.com/rabbitmq/rabbitmqadmin-ng
- https://api.github.com/repos/rabbitmq/rabbitmqadmin-ng/releases/latest
- https://api.github.com/repos/rabbitmq/rabbitmq-server/releases?per_page=8
- https://github.com/rabbitmq/omq
- https://github.com/rabbitmq/rabbitmq-perf-test
- https://github.com/rabbitmq/rabbitmq-dotnet-client/pull/1261
- https://github.com/amazon-mq/mcp-server-rabbitmq
- https://api.github.com/repos/amazon-mq/mcp-server-rabbitmq/releases/latest
- https://pypi.org/project/amq-mcp-server-rabbitmq/3.0.0/
- https://awslabs.github.io/mcp/servers/amazon-mq-mcp-server
- https://aws.amazon.com/about-aws/whats-new/2026/09/amazon-mq-rabbitmq-43/
- https://www.cloudamqp.com/changelog/
- https://www.cloudamqp.com/blog/part1-rabbitmq-best-practice.html
- https://www.84codes.com/
- https://mqsummit.com/
- https://seventhstate.io/
- https://warrenops.io
- https://www.cogin.com/mq/
- https://www.kafkatool.com/
- https://lavinmq.com/documentation/installation-guide
- https://ui.docs.kafbat.io/llms-full.txt
- https://github.com/kafbat/kafka-ui
- https://github.com/provectus/kafka-ui
- https://hub.docker.com/v2/repositories/provectuslabs/kafka-ui/
- https://hub.docker.com/v2/repositories/kafbat/kafka-ui/
- https://hub.docker.com/v2/repositories/tchiotludo/akhq/
- https://hub.docker.com/v2/repositories/redis/redisinsight/
- https://hub.docker.com/v2/repositories/library/rabbitmq/
- https://github.com/tchiotludo/akhq/releases
- https://github.com/confluentinc/mcp-confluent
- https://www.conduktor.io/pricing.md
- https://docs.conduktor.io/desktop.md
- https://www.conduktor.io/blog/conduktor-retrospective-2023
- https://redis.io/docs/latest/develop/tools/insight/
- https://github.com/redis/RedisInsight
- https://grafana.com/docs/grafana-cloud/machine-learning/assistant/
- https://github.com/dbeaver/dbeaver
- https://pricingsaas.com/companies/dbeaver
- https://github.com/beekeeper-studio/beekeeper-studio
- https://www.beekeeperstudio.io/blog/ultimate-and-gpl
- https://www.beekeeperstudio.io/pricing/
- https://www.tableplus.com/pricing
- https://github.com/usebruno/bruno
- https://www.usebruno.com/pricing
- https://www.postman.com/pricing/
- https://learning.postman.com/docs/getting-started/basics/using-scratch-pad/
- https://medium.com/@subnetmarco/insomnia-8-0-cloud-synchronization-12ed5a341eb0
- https://github.com/lensapp/lens
- https://github.com/freelensapp/freelens
- https://dev.to/alexandrev/freelens-vs-openlens-vs-lens-choosing-the-right-kubernetes-ide-lc8
- https://www.businesswire.com/news/home/20220728005140/en
- https://redis.io/blog/agplv3/
- https://www.hashicorp.com/blog/hashicorp-adopts-business-source-license
- https://www.elastic.co/blog/elasticsearch-is-open-source-again
- https://fsl.software/
- https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices
- https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
- https://opentelemetry.io/docs/specs/semconv/messaging/rabbitmq/
- https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/
- https://www.w3.org/TR/trace-context/
- https://github.com/cloudevents/spec/blob/main/cloudevents/bindings/amqp-protocol-binding.md
- https://www.asyncapi.com/docs/reference/bindings/amqp
- https://nordicapis.com/8-asyncapi-documentation-generators/
- https://github.com/event-catalog/generator-asyncapi
- https://eventcatalog.dev/docs/plugins/asyncapi/intro
- https://github.com/springwolf/springwolf-core
- https://app.unpkg.com/@asyncapi/generator@2.7.1/files/README.md
- https://docs.redhat.com/en/documentation/red_hat_build_of_apicurio_registry/3.0/html-single/apicurio_registry_user_guide/apicurio_registry_user_guide
- https://github.com/cyrilgdn/terraform-provider-rabbitmq
- https://registry.terraform.io/v1/providers/cyrilgdn/rabbitmq
- https://github.com/rfd59/terraform-provider-rabbitmq
- https://registry.terraform.io/v1/providers/rfd59/rabbitmq
- https://www.pulumi.com/registry/packages/rabbitmq/
- https://github.com/Shopify/toxiproxy
- https://masstransit.massient.com/documentation/concepts/exceptions
- https://docs.particular.net/nservicebus/messaging/headers
- https://docs.particular.net/nservicebus/recoverability/
- https://docs.spring.io/spring-amqp/reference/amqp/resilience-recovering-from-errors-and-broker-failures.html
