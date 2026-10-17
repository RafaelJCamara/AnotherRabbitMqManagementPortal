# User pain points

> **Pre-verification research (2026-10-16).** Where this conflicts with [`docs/research/fact-sheet.md`](../fact-sheet.md), the fact sheet wins. Content about a specific third-party product was removed under the docs policy ([ADR-034](../../adr/ADR-034-docs-policy.md)).

_Research angle `user-pain-points` · 2026-10-16_

## Executive summary

I drew on Stack Overflow (the top-voted [rabbitmq] questions plus keyword probes), the titles of all 2,131 rabbitmq-server GitHub Discussions, GitHub issues, Hacker News, the 4.0 to 4.4-draft release notes and vendor documentation. RabbitMQ pain falls into five clusters.

(1) Seeing messages and acting on them safely is the biggest developer pain. The official UI calls 'Get messages' 'a destructive action'. It reads only from the head of the queue, decodes nothing beyond base64 and is switched off for streams. Dead-letter handling stops at 'move everything' through a shovel. Stuck unacked consumers and confusion about prefetch never go away; a maintainer says 'We observe consumers that do not acknowledge deliveries all the time'.

(2) Upgrades and migrations are a new, high-severity category that few tools address. 4.0 silently turned off mirroring policies. 4.3 (April 2026) made Khepri mandatory, removed partition handling and denies some deprecated features by default, such as transient non-exclusive queues and global QoS. The delayed-message plugin is no longer maintained, and each release series gets roughly 6 to 9 months of community support. AWS blocks v4 upgrades and wrote its own migration plugin. A version-aware readiness checker plus a queue-migration wizard would set the product apart.

(3) Team and security gaps are built into RabbitMQ:
- purging a queue needs only 'read', the same permission as get or consume
- no internal event is emitted when a queue is purged
- HTTP access logging is off by default
- deletion protection covers only vhosts and users
- OAuth2 is fragile and maintainers decline to troubleshoot it for non-paying users

A self-hosted web edition that sits in front of the API as an SSO, role-based access and audit gateway fixes this. Maintainers themselves recommend a reverse proxy to restrict endpoints. A local-only tool with 'no activity logs' cannot do it.

(4) Operators lack history and diagnosis. The UI keeps 'hours, not days' of metrics, Prometheus has no per-queue incoming rate, and many users cannot run Prometheus at all.

(5) Platform teams want a view across many clusters, control over definitions drift and self-service. The evidence here is thinner.

Caveats: Reddit was mostly blocked and the search budget ran out. GitHub vote counts understate demand.

## Report

# RabbitMQ user pain points: evidence, ranking and the features that solve them
Research date 2026-10-16. Latest stable broker: 4.3.6 (2026-09-14). 4.4.0 is in development: its draft release notes are on the main branch.

## 1. Method and evidence quality

**Sources mined**
- **Stack Overflow.** I used the official Stack Exchange API. I pulled the top 100 questions tagged [rabbitmq] by votes, then probed with keywords for counts and top hits. Votes and views are as of today.
- **GitHub (rabbitmq/rabbitmq-server).** Issues ranked by reactions. I bucketed the titles of all 2,131 GitHub Discussions (2019-03 to 2026-10-14) by keyword. I read the key threads in full. I also read the release notes for 4.0.1, 4.2.0, 4.3.0 and the in-progress 4.4.0.
- **Hacker News**, through Algolia (stories and comments).
- **Vendor docs:** RabbitMQ, AWS, Elastic and Particular.
- **READMEs of workaround tools**, used as demand signals.

**Evidence limits (FACT)**
- **Reddit:** direct access returned 403 and the archive API was rate-limited. I could only get the r/rabbitmq archive up to Oct 2022. That sub had about 1k subscribers in 2020 and its top post scored 14. Reddit evidence is therefore weak here.
- **Search budget:** the shared web-search budget ran out near the end of the research.
- **Stack Overflow skew:** the data is mostly from 2010 to 2018.
- **GitHub votes understate demand:** maintainers discourage upvoting ('our team really does not appreciate upvoting fests', [disc #14666](https://github.com/rabbitmq/rabbitmq-server/discussions/14666)). They also give community support only to the latest release series.

I therefore weighted evidence by three things: Stack Overflow views, the same pain recurring across channels, and maintainer statements.

**Discussion-title buckets (n=2,131)**

| Bucket | Titles |
| --- | --- |
| Upgrade/migration | 235 |
| Security/auth | 181 |
| Connections/channels | 150 |
| Management UI / HTTP API | 129 |
| Memory/disk alarms | 99 |
| Streams | 96 |
| Kubernetes | 74 |
| Monitoring | 66 |
| Shovel | 63 |
| Dead-letter queues (DLQ) / retry | 37 |
| Unacked / timeouts | 33 |
| Definitions | 27 |
| Partitions | 21 |
| Peek / inspect | 5 |

Peeking is rare on GitHub because maintainers steer people toward consumers. On Stack Overflow it is one of the most-viewed topics.

**Workaround tools as demand signals** (GitHub stars, today)

| Tool | Stars | Note |
| --- | --- | --- |
| rabbitmq-delayed-message-exchange | 2,309 | Archived |
| streamdal/plumber | 2,153 |  |
| cloudamqp/amqproxy | 408 |  |
| jandelgado/rabtap | 290 |  |
| dubek/rabbitmq-dump-queue | 226 |  |
| messaging-topology-operator | 161 |  |
| RabbitScout | 154 |  |
| rabbitmqadmin v2 | 54 |  |

Small r/rabbitmq posts show the same pattern of people repeatedly building their own tooling: a 'Queue Viewer' Windows GUI (2018), the 'AliceMQ visualizer' (2019) and an 'amqp-client-cli debugging tool' (2022).

## 2. Platform shifts in 2024-2026 that create new pain (FACT)

**4.0 ([notes](https://github.com/rabbitmq/rabbitmq-server/releases/tag/v4.0.1))**
- Classic queue mirroring is removed. 'After an upgrade to 4.0, all classic queue mirroring-related parts of policies will have no effect.' Netdata calls this a silent failure: 'nothing crashes ... You simply lost replication' ([guide](https://www.netdata.cloud/guides/rabbitmq/rabbitmq-classic-mirrored-queue-removed/)).
- Quorum queues now default to a delivery limit of 20. Over-limit messages are dropped, or dead-lettered if a DLX is configured.
- The broker no longer interprets a client-set x-death header when a client re-publishes a message.
- The default maximum message size is now 16 MiB.

**4.2.0 (2025-10-27)**
- Khepri is the default metadata store for new clusters.
- Streams gain SQL filter expressions, over AMQP 1.0 only ([blog](https://www.rabbitmq.com/blog/2025/09/23/sql-filter-expressions)).
- Users can be tagged 'protected'.
- Ra metrics were renamed or removed, which breaks existing dashboards.

**4.3.0 (2026-04-23) ([notes](https://github.com/rabbitmq/rabbitmq-server/releases/tag/v4.3.0))**
- Mnesia is removed and Khepri is the only metadata store. A majority of nodes must be online for the cluster to be available.
- Partition-handling keys are accepted but have no effect.
- Upgrades are supported only from 4.2.x.
- These deprecated features are now denied by default: transient_nonexcl_queues, global_qos, amqp_address_v1, queue_master_locator and amqp_filter_set_bug.
- CQv1 is removed. Declaring a queue with x-queue-mode, or with x-queue-version=1, now fails.
- 'Consumer timeouts are no longer evaluated for classic queues and streams'.
- Quorum queues gain strict priorities, delayed retry and a consumer timeout.

**4.4.0 (draft on main)**
- Quorum queues support delayed messages (x-opt-delivery-time).
- Changing delivery-limit in a policy now affects existing quorum queues.
- OIDC discovery validation is stricter, which breaks UAA.
- GET /api/auth/hash_password is replaced by POST ([draft](https://github.com/rabbitmq/rabbitmq-server/blob/main/release-notes/4.4.0.md)).

**Other changes**
- The delayed-message-exchange plugin 'is no longer maintained' because it depends on Mnesia ([README](https://github.com/rabbitmq/rabbitmq-delayed-message-exchange)).
- Community support ends on 2026-07-31 for 4.2 and on 2027-01-31 for 4.3 ([release info](https://www.rabbitmq.com/release-information)).
- The official UI is built on sammy.js, which is unsupported. Maintainers are prototyping a TypeScript UI (Vue or React). Klishin says: 'modernizing the UI without any meaningful UI changes will be the first step. A completely new UI prototype will most likely ship later, and take a long time to evaluate' ([#2619](https://github.com/rabbitmq/rabbitmq-server/issues/2619), 2026-09-23).
- Management metrics collection is deprecated, but Klishin (2025-12-16) said 'much more likely that the stats collection in the management plugin will remain at least in 4.x. We have learned the hard way that some users cannot provision any other monitoring solution' ([disc #15146](https://github.com/rabbitmq/rabbitmq-server/discussions/15146)).

## 3. Top 30 pains ranked by frequency (F) times severity (S), each scored 1-5

Personas: A = developers, B = operators/SRE, C = teams/security/compliance, D = platform teams.

| # | Pain (persona) | F | S | FxS | Key evidence | Workaround today | Feature that solves it |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Can't inspect messages safely. 'Get messages' is destructive, head-only, base64-only and disabled for streams (A,B) | 5 | 4 | 20 | [SO 10709533](https://stackoverflow.com/questions/10709533) 152 votes / 314k views; [SO 9874234](https://stackoverflow.com/questions/9874234) 65 / 90k; [SO 4700292](https://stackoverflow.com/questions/4700292) 58 / 39k. UI text: 'getting messages from a queue is a destructive action'. Streams have get_message:false in UI code. [disc #13060](https://github.com/rabbitmq/rabbitmq-server/discussions/13060): node crash when fetching 10k messages over the API | UI Get with nack-requeue; rabbitmq-dump-queue; rabtap; firehose | Safe Peek; Stream Browser; Live Tap |
| 3 | Stuck unacked consumers, prefetch confusion, consumer-timeout channel closures (A,B) | 5 | 4 | 20 | [SO 31915773](https://stackoverflow.com/questions/31915773) 150 / 147k; [SO 25114230](https://stackoverflow.com/questions/25114230) 66 / 88k; [SO 7063224](https://stackoverflow.com/questions/7063224) 54 / 75k; [SO 53374144](https://stackoverflow.com/questions/53374144) 38 / 85k; [SO 69828547](https://stackoverflow.com/questions/69828547) 21 / 24k. Klishin in [#14611](https://github.com/rabbitmq/rabbitmq-server/discussions/14611): 'consumers that do not acknowledge deliveries all the time'. HN [35532770](https://news.ycombinator.com/item?id=35532770) | rabbitmqctl list_consumers; kill connections; raise consumer_timeout | Consumer Diagnostics |
| 4 | Upgrade readiness: feature flags, deprecated features, Khepri, silent behavior changes (B,D) | 4 | 5 | 20 | [SO 76712557](https://stackoverflow.com/questions/76712557) 13k views; [SO 77873608](https://stackoverflow.com/questions/77873608) 9.3k (boot failed); [SO 78560616](https://stackoverflow.com/questions/78560616) 6.4k. [#11350](https://github.com/rabbitmq/rabbitmq-server/discussions/11350): warning 'does not specify which features'. [#12848](https://github.com/rabbitmq/rabbitmq-server/discussions/12848): hours-long CQ conversion. [#16974](https://github.com/rabbitmq/rabbitmq-server/issues/16974): '???' stats after 3.13 to 4.3. AWS marks brokers 'not upgradeable to v4' | Manual checklists; consultant assessments (Seventh State) | Upgrade Readiness Assessor |
| 5 | Memory/disk alarms block publishers cluster-wide; container memory mis-sizing (B) | 4 | 5 | 20 | [SO 25162484](https://stackoverflow.com/questions/25162484) 63 / 133k; [SO 12175156](https://stackoverflow.com/questions/12175156) 46k views; [SO 40805580](https://stackoverflow.com/questions/40805580). Discussions [#7674](https://github.com/rabbitmq/rabbitmq-server/discussions/7674), [#10611](https://github.com/rabbitmq/rabbitmq-server/discussions/10611), [#7362](https://github.com/rabbitmq/rabbitmq-server/discussions/7362) (27 comments). Docs: alarms are 'cluster-wide' and heartbeats are turned off | Grafana; rabbitmq-diagnostics | Alarm and Flow-Control Center |
| 6 | 'Why is this queue growing?' Missing rates and history (B) | 4 | 4 | 16 | [#8691](https://github.com/rabbitmq/rabbitmq-server/issues/8691), 17 reactions, open: per-queue incoming rate missing from Prometheus; UI retention '1h AFAIK'. Docs: UI keeps 'hours, not days'. [SO 32563873](https://stackoverflow.com/questions/32563873) (consumer utilisation) | Grafana; eyeballing UI charts | Backlog Analyzer + history |
| 7 | Changing queue type or args (classic or mirrored to quorum) means delete and recreate (B,A) | 4 | 4 | 16 | [SO 63607314](https://stackoverflow.com/questions/63607314) 9.6k; [SO 76350352](https://stackoverflow.com/questions/76350352). RabbitMQ [blog](https://www.rabbitmq.com/blog/2025/07/29/latest-benefits-of-rmq-and-migrating-to-qq-along-the-way): 'can seem daunting'. AWS [plugin](https://github.com/amazon-mq/rabbitmq-queue-migration) warns TTL messages cause 'message_count_mismatch' | Blue-green with federation or shovels; rabbitmqadmin v2 transformations | Queue Migration Wizard |
| 8 | Connection/channel churn, leaks, unexplained closures (B,A) | 4 | 4 | 16 | [SO 18418936](https://stackoverflow.com/questions/18418936) 251 / 122k; [SO 8839094](https://stackoverflow.com/questions/8839094) 47 / 158k. [Docs](https://www.rabbitmq.com/docs/connections): over 100 opens/s is suboptimal; PHP is a typical cause. AMQProxy (408 stars). HN [35532338](https://news.ycombinator.com/item?id=35532338). [#12833](https://github.com/rabbitmq/rabbitmq-server/discussions/12833): names missing when stats are off | AMQProxy; manual UI review | Connection Hygiene Dashboard |
| 9 | Retry and delay patterns are hard; delayed-message plugin abandoned (A,B) | 4 | 4 | 16 | [SO 23158310](https://stackoverflow.com/questions/23158310) 107 / 124k; [SO 17014584](https://stackoverflow.com/questions/17014584) 52; [SO 4444208](https://stackoverflow.com/questions/4444208) 52. Plugin README. [#17816](https://github.com/rabbitmq/rabbitmq-server/discussions/17816) (2026-10-14): DLX+TTL retries dropped as 'cycle detected' | Hand-built DLX+TTL; frameworks | Retry Wizard + Delayed-plugin Migration |
| 10 | Accidental purge or delete; no queue-level protection (C,B) | 3 | 5 | 15 | [mgmt #142](https://github.com/rabbitmq/rabbitmq-management/issues/142): 'meant to purge ... accidentally clicked the delete button'. [SO 35876741](https://stackoverflow.com/questions/35876741); [SO 79716696](https://stackoverflow.com/questions/79716696) (2025). Protection exists only for vhosts (4.0.6) and users (4.2). Elastic has a 'multi-queue purge burst' detection rule | Restrict configure permission; confirm dialog | Production Guardrails |
| 11 | Understanding cluster, partition and quorum health (B) | 3 | 5 | 15 | HN [23259668](https://news.ycombinator.com/item?id=23259668): 'lost entire queues because a small network blip'. [#15909](https://github.com/rabbitmq/rabbitmq-server/discussions/15909): Khepri split-brain detection. [#5787](https://github.com/rabbitmq/rabbitmq-server/discussions/5787). [Khepri known issues](https://www.rabbitmq.com/docs/metadata-store/known-issues): write timeouts | CLI health checks; Grafana | Cluster and Quorum Health |
| 12 | 'Where did my message go?' Routing and binding confusion, unroutable messages (A) | 4 | 3 | 12 | [SO 10620976](https://stackoverflow.com/questions/10620976) 249 / 292k; [SO 9704590](https://stackoverflow.com/questions/9704590) 67; [SO 38988225](https://stackoverflow.com/questions/38988225). [#3095](https://github.com/rabbitmq/rabbitmq-server/discussions/3095): firehose 'will double the load' | Alternate exchange; mandatory flag; firehose | Routing Simulator and Probe; Topology Graph |
| 13 | Coarse permissions: purge equals read; no read-only-with-peek role (C,D) | 3 | 4 | 12 | [Access control](https://www.rabbitmq.com/docs/access-control): queue.purge, basic.get and basic.consume all need read. [SO 53339508](https://stackoverflow.com/questions/53339508) 12k; [#2616](https://github.com/rabbitmq/rabbitmq-server/issues/2616) open since 2017; [#1000](https://github.com/rabbitmq/rabbitmq-server/issues/1000) 17 reactions; [#14313](https://github.com/rabbitmq/rabbitmq-server/discussions/14313) | Separate vhosts; reverse proxy | Gateway RBAC (web) |
| 14 | No audit trail of management actions (C) | 3 | 4 | 12 | Management docs: HTTP API not logged by default. Event list has no purge event. [SO 19937345](https://stackoverflow.com/questions/19937345) 23 / 46k ('auditability'). [#16559](https://github.com/rabbitmq/rabbitmq-server/issues/16559) (OAuth user logged as client_id); [#7764](https://github.com/rabbitmq/rabbitmq-server/issues/7764) open | http_log_dir; event exchange; packet capture | Audit Log |
| 15 | SSO/OAuth2 setup is brittle (C,D) | 3 | 4 | 12 | [#13887](https://github.com/rabbitmq/rabbitmq-server/discussions/13887): Entra broke on 4.1.0; 'we will not be troubleshooting OAuth 2 for non-paying users'. [#12261](https://github.com/rabbitmq/rabbitmq-server/issues/12261), [#16664](https://github.com/rabbitmq/rabbitmq-server/issues/16664), [#17110](https://github.com/rabbitmq/rabbitmq-server/issues/17110), [#13477](https://github.com/rabbitmq/rabbitmq-server/discussions/13477). 4.4 breaks UAA | Trial and error | Portal SSO + OAuth Config Validator |
| 17 | Binary, protobuf or compressed payloads unreadable (A) | 3 | 3 | 9 | [SO 56940428](https://stackoverflow.com/questions/56940428) ('base64-encoded' error queue); [SO 59441565](https://stackoverflow.com/questions/59441565). UI offers only 'Auto string / base64' and truncates at 50,000 bytes | plumber; custom scripts | Decoders |
| 18 | Definitions drift across environments; no diff (B,D) | 3 | 3 | 9 | [HTTP API](https://www.rabbitmq.com/docs/http-api-reference): 'definitions are merged', conflicts 'ignored'. [SO 41306350](https://stackoverflow.com/questions/41306350) 40; [SO 4545660](https://stackoverflow.com/questions/4545660) 94; [#12977](https://github.com/rabbitmq/rabbitmq-server/discussions/12977). Tanzu sells Schema Definition Sync | rabbitmqadmin v2 transformations; Terraform; operator | Definitions Diff and Sync |
| 19 | Which policy applies, and what are the effective values? (B,A) | 3 | 3 | 9 | [#15146](https://github.com/rabbitmq/rabbitmq-server/discussions/15146): effective policy and delivery limit missing when stats are off (fixed in 4.2/4.3). 4.4 changes delivery-limit semantics | Read JSON by hand | Policy Debugger |
| 20 | Monitoring silo and short history; some orgs cannot run Prometheus (B,D) | 3 | 3 | 9 | Klishin in #15146. #8691: CloudAMQP UI needs IP allow-listing. [Prometheus docs](https://www.rabbitmq.com/docs/prometheus): per-object endpoint expensive | Prometheus/Grafana | Built-in History Store |
| 21 | Shovels and federation are opaque (B) | 3 | 3 | 9 | [SO 11443309](https://stackoverflow.com/questions/11443309) 'stuck on starting'; [SO 64076455](https://stackoverflow.com/questions/64076455) 13k. [#11317](https://github.com/rabbitmq/rabbitmq-server/discussions/11317); [#17429](https://github.com/rabbitmq/rabbitmq-server/issues/17429) open | CLI and logs | Shovel and Federation Manager |
| 22 | UI slow or fragile at scale (B,D) | 3 | 3 | 9 | HN [39097784](https://news.ycombinator.com/item?id=39097784): web UI weak with tens of thousands of queues. Maintainer Zerpet: runtime errors blank the UI, which forced an emergency hotfix; the whole page reloads every N seconds. API page size capped at 500 | rabbitmqadmin; Grafana | Scale-ready UI |
| 23 | Capacity planning and limits (B,D) | 3 | 3 | 9 | [SO 18353898](https://stackoverflow.com/questions/18353898) 115 / 117k; [SO 22989833](https://stackoverflow.com/questions/22989833) 76 / 78k | Experience; consultants | Sizing Assistant |
| 25 | No bulk operations (A,B) | 4 | 2 | 8 | [SO 11459676](https://stackoverflow.com/questions/11459676) 230 / 236k; [SO 5313027](https://stackoverflow.com/questions/5313027) 195 / 256k; [SO 7149074](https://stackoverflow.com/questions/7149074) 262 / 232k | Shell loops over CLI | Bulk Ops with guardrails |
| 26 | Local dev setup (Docker, plugins, seed definitions) (A) | 4 | 2 | 8 | [SO 47290108](https://stackoverflow.com/questions/47290108) 139 / 188k; [SO 30747469](https://stackoverflow.com/questions/30747469) 119; [SO 52819237](https://stackoverflow.com/questions/52819237) 70; [SO 75236860](https://stackoverflow.com/questions/75236860) | docker-compose and docs | Local Broker Launcher |
| 28 | Fleet visibility and self-service (D) | 2 | 4 | 8 | [Grafana fleet dashboard](https://grafana.com/grafana/dashboards/20697-rabbitmq-clusters-seventh-state-rabbitmq-support/); Tanzu schema sync and warm standby are commercial; [#7028](https://github.com/rabbitmq/rabbitmq-server/discussions/7028); [#2616](https://github.com/rabbitmq/rabbitmq-server/issues/2616); cluster-operator [#223](https://github.com/rabbitmq/cluster-operator/issues/223) (37 comments) | Grafana; operator CRDs | Fleet Overview; Self-service |
| 29 | PII exposure when inspecting payloads (C) | 2 | 4 | 8 | INFERENCE: any read grant exposes bodies and nothing masks them. [#7582](https://github.com/rabbitmq/rabbitmq-server/discussions/7582) (authorization by payload) | None | Masking + view-payload permission |
| 30 | Streams are second-class in tooling (A,B) | 2 | 3 | 6 | UI cannot get stream messages; [#6444](https://github.com/rabbitmq/rabbitmq-server/discussions/6444) (inspect stream consumers); [#3306](https://github.com/rabbitmq/rabbitmq-server/discussions/3306); SQL filters work only over AMQP 1.0 | Stream perf tools; custom code | Stream Browser + offsets view |

## 4. Persona deep-dives

### A. Application developers

**Inspection (FACT)**
- **The official UI's Get is a basic.get loop that then requeues.** The default ack mode is basic.nack(requeue=true); 'Reject requeue true' sends basic.reject ([source](https://github.com/rabbitmq/rabbitmq-server/blob/main/deps/rabbitmq_management/src/rabbit_mgmt_wm_queue_get.erl)).
- **Reject counts against the delivery limit on quorum queues.** Per the [quorum queue docs](https://www.rabbitmq.com/docs/quorum-queues), basic.reject and client crash or connection loss increment delivery-count; basic.nack does not. With the default limit of 20, repeatedly peeking with 'Reject requeue true', or with consume-then-disconnect tools, can eventually drop a message that has no DLX (INFERENCE from those two facts).
- **Gets only reach the head of the queue.** There is no way to jump to message 10,000.
- **Bulk gets can hurt the node.** Large gets through the HTTP API caused a node crash in [#13060](https://github.com/rabbitmq/rabbitmq-server/discussions/13060).

**Error queues**
- Developers monitor error queues in the UI but 'it is not easy to make sense of the payload ... which are base64-encoded' ([SO 56940428](https://stackoverflow.com/questions/56940428)).
- They want an admin 'Retry' that moves failed messages back to their original queue ([SO 48845714](https://stackoverflow.com/questions/48845714)).
- The native 'Move messages' form creates a temporary shovel with src-delete-after=queue-length and shows 'To move messages, the shovel plugin must be enabled'. It moves everything; there is no filtering.

**Republishing in 4.x**
4.x does not interpret a client-set x-death when a message is re-published. Any replay tool must decide whether to strip or preserve x-death and should add its own replay counter header.

**Routing**
- 'Single queue, multiple consumers' (292k views) and topic-versus-direct questions show that people misunderstand exchange semantics.
- For unroutable messages, maintainers say 'should be handled by publishers', and the firehose 'will double the load' ([#3095](https://github.com/rabbitmq/rabbitmq-server/discussions/3095)).

**Retries and delays**
- DLX+TTL retry loops get dropped as 'cycle detected' ([#17816](https://github.com/rabbitmq/rabbitmq-server/discussions/17816)).
- The widely used delayed exchange (2.3k stars) is abandoned.
- Native quorum-queue delays arrive in 4.4.

**Local setup**
Docker, guest/guest, plugins and seeded definitions together account for more than 1M Stack Overflow views (rows 16 and 26).

### B. Operators / SRE

**Unacked consumers**
The core team: 'We observe consumers that do not acknowledge deliveries **all the time** and had to introduce a protection mechanism' ([#14611](https://github.com/rabbitmq/rabbitmq-server/discussions/14611)). The default consumer_timeout is 30 min (1800000 ms in the error text of [SO 69828547](https://stackoverflow.com/questions/69828547)). In 4.3 that check no longer applies to classic queues, so a stuck classic-queue consumer now holds messages indefinitely unless the app handles it (INFERENCE).

**Upgrades (FACT)**
- Upgrade paths are now gated: 4.3 accepts upgrades only from 4.2 with khepri_db and the other required feature flags enabled. The 4.x support windows are short.
- Amazon MQ refuses v4 upgrades while classic queues exist or Khepri is enabled ([AWS](https://docs.aws.eu/amazon-mq/latest/developer-guide/troubleshooting-action-required-codes-rabbitmq-not-upgradeable-to-v4.html)).
- AWS published a migration plugin (Dec 2025). Its README lists TTL pitfalls and 'relaxed_checks_on_redeclaration' prerequisites ([repo](https://github.com/amazon-mq/rabbitmq-queue-migration)).

**Observability (FACT)**
- The UI 'only stores recent data (think hours, not days or months)' ([docs](https://www.rabbitmq.com/docs/management)).
- Turning off management metrics also removes connection names ([#12833](https://github.com/rabbitmq/rabbitmq-server/discussions/12833)). Before a 4.2/4.3 fix, it also removed effective policies ([#15146](https://github.com/rabbitmq/rabbitmq-server/discussions/15146)).
- The Prometheus per-object endpoint should be avoided or scraped rarely at tens of thousands of objects.

**Alarms** are cluster-wide. One node's alarm blocks every publisher and deactivates heartbeats ([docs](https://www.rabbitmq.com/docs/alarms)).

**Connections** opening at more than 100/s, typically from PHP, call for a proxy ([docs](https://www.rabbitmq.com/docs/connections)).

### C. Teams / security / compliance

**Permissions (FACT)**
- queue.purge requires the same 'read' permission as basic.get and basic.consume ([docs](https://www.rabbitmq.com/docs/access-control)).
- Users with the 'management' tag see every queue in their vhosts. A request to filter that view by permissions has been open since 2017: 'users can do dictionary-style attacks to delete, change bindings, or read messages from other peoples queues' ([#2616](https://github.com/rabbitmq/rabbitmq-server/issues/2616)).
- To restrict endpoints, maintainers recommend 'a reverse proxy in front of the API' ([#14313](https://github.com/rabbitmq/rabbitmq-server/discussions/14313)).

**Audit (FACT)**
- HTTP API requests are not logged by default ([docs](https://www.rabbitmq.com/docs/management)). The internal event list has no purge event ([docs](https://www.rabbitmq.com/docs/logging)).
- Until mid-2026 the access log recorded OAuth users as the client_id ([#16559](https://github.com/rabbitmq/rabbitmq-server/issues/16559)).
- Elastic's rule against mass purges relies on packet capture ([rule](https://www.elastic.co/docs/reference/security/prebuilt-rules/rules/network/impact_amqp_multi_queue_purge_burst)).

**SSO** breaks across upgrades and gets no community support (row 15).

**Shared admin credentials** are a known pain: 'WRITE down that rabbitmq-web-admin passwd' ([HN](https://news.ycombinator.com/item?id=23263383)).

### D. Platform teams

**Operator versus user roles**
Operators running RabbitMQ as a service separate the two: 'end-users have access only to the HTTP API, and operators to CLI and configuration'. They want safeguards on quorum-queue replication ([#7028](https://github.com/rabbitmq/rabbitmq-server/discussions/7028)).

**Willingness to pay (INFERENCE)**
Two signals point the same way:
- Fleet dashboards are built in Grafana.
- Definitions sync and warm standby are sold commercially (Tanzu).

**Distribution constraint**
Klishin notes that bundling a plugin is 'not how large companies operate'. Zerpet praised RabbitScout because it 'doesn't require a new plugin' ([#2619](https://github.com/rabbitmq/rabbitmq-server/issues/2619)). Amazon MQ forbids custom plugins altogether. Implication (INFERENCE): the product must work with no broker plugin.

## 5. Implications for the product (INFERENCE / IDEA)

1. **Observing must never harm.**
   - Peek with basic.get plus nack(requeue), never reject, and cap the counts.
   - Show x-delivery-count and the delivery limit, and warn near the limit.
   - Read streams by offset. Use exchange-to-exchange taps (rabtap's technique) for live views instead of the firehose.
   - Never bulk-get through the HTTP API.
2. **Make the 4.x transition a product pillar.** Build a version-aware readiness assessor (flags, deprecated features, ha-* policies, CQv1 args, transient non-exclusive queues, global QoS, delayed plugin, partition keys, EOL dates). Pair it with a queue-migration wizard. No public GUI does this today. AWS and consultancies do parts of it.
3. **The web edition is a gateway, not just a hosted UI.**
   - The broker refuses cross-origin calls by default (CORS), so a backend is needed anyway.
   - That backend should provide SSO for people, fine-grained RBAC (peek without purge), approvals for destructive actions in prod, and an immutable audit log.
4. **Own the time dimension.** Sample the HTTP API and/or Prometheus into a local (desktop) or server (web) store. That enables drain ETAs, 'why is it growing', and alerts. It must keep working when stats are disabled.
5. **Be version- and environment-aware everywhere.** Features gate on the version (stream filters 4.2+, QQ priority, retry and timeout 4.3+, delays 4.4+), and destructive defaults are off in prod.
6. **Scale.** Virtualize lists, page at the 500-item API cap, refresh incrementally, and target 50k+ queues.

They do not cover rows 4, 5, 7, 10, 11, 13, 14, 15, 18, 28, 29 or 30.

## 6. Unresolved items
See open_questions. The main ones are Reddit sentiment, the exact delivery-count semantics for consumer-timeout and channel-close paths, and how restricted managed-service APIs are.

## Feature ideas

| Idea | Persona | Priority | Size | Description | Evidence / inspiration |
| --- | --- | --- | --- | --- | --- |
| Stream browser | developer | must | L | Read streams by offset, timestamp, first or last, with a consumer-offset view. On 4.2+ over AMQP 1.0, push filters on properties and application-properties to the broker with SQL filter expressions; search bodies client-side. | Management UI sets get_message:false for streams (global.js). Discussions #6444 and #3306. SQL filter expressions blog (4.2). |
| Built-in payload decoders | developer | must | M | Auto-detect and render JSON, XML, text encodings, hex and base64. Detect gzip, deflate, brotli or zstd from content-encoding. Decode MessagePack and CBOR, recognize CloudEvents envelopes, and accept user-written decoders as plugins. | SO 56940428 (base64 error-queue payloads). Official UI offers only 'Auto string / base64' and truncates at 50,000 bytes. |
| Routing simulator and probe | developer | must | M | Given an exchange, routing key and headers, compute which bindings and queues would match across direct, topic, fanout and headers exchanges, exchange-to-exchange bindings, alternate exchanges and the default exchange. Optionally send a real probe with the mandatory flag. Explain unroutable rates. | SO 10620976 (249 votes/292k), 9704590, 38988225, 42932933. Discussion #3095 (unroutable source unknown). |
| Retry topology wizard and linter | developer | should | M | Generate DLX+TTL retry and parking-lot topologies, or quorum-queue delivery-limit and delayed-retry policies on 4.3+. Visualize retry loops and flag risk from dead-letter cycle detection and head-of-line TTL blocking. | SO 23158310 (107 votes/124k), 17014584, 4444208. Discussion #17816 (cycle-detected drops, 2026-10). 4.3 quorum-queue delayed retry. |
| Delayed-message plugin migration helper | operator | should | M | Detect x-delayed-message exchanges and count pending delayed messages. Explain that the plugin blocks upgrading to 4.3 (Mnesia removed). Plan a move to quorum-queue x-opt-delivery-time (4.4+) or to DLX+TTL. | The plugin README says it is 'no longer maintained' (repo archived, 2.3k stars). 4.4.0 draft notes add quorum-queue delayed messages. |
| Consumer and unacked diagnostics | operator | must | M | Per queue: consumers with prefetch, unacked per channel, ack rate, idle time, and the app behind each (client-provided name, user, IP). Detect stuck consumers (unacked above zero with zero acks for N minutes). Show which consumer-timeout rules apply for this broker version and queue type. Offer to close a channel or connection with an impact preview. | SO 31915773 (150/147k), 25114230, 7063224, 53374144, 69828547. Discussion #14611 (maintainer quote). 4.3: consumer timeouts no longer evaluated for classic queues. |
| Prometheus-native mode and stats-disabled resilience | operator | should | M | Read /metrics/detailed with family and queue-name filters (4.3+), avoiding /metrics/per-object at scale. Degrade gracefully when management_metrics_collection or rates_mode is disabled. | Prometheus docs (per-object cost). Discussion #12833 (connection names missing). 4.3 notes (detailed endpoint queue filter, static connection info with stats disabled). |
| Alarm and flow-control center | operator | must | M | Memory and disk alarm state per node, with an explanation of cluster-wide blocking. List blocked and blocking connections and show a memory breakdown. Check the watermark and disk limit against container or VM limits. | SO 25162484 (63/133k), 12175156, 40805580. Discussions #7674, #10611, #10518. Alarms docs. |
| Connection hygiene dashboard | operator | must | M | Churn rates against the docs' 100/s guidance and top clients by connections and channels. Flag unnamed connections and detect leaks (monotonic growth). Show heartbeat settings and a history of close reasons from connection.closed events. | Connections docs (churn, PHP, leaks). SO 18418936 (251/122k), 8839094 (47/158k). AMQProxy (408 stars). Discussion #6331. |
| Upgrade readiness assessor | operator | must | L | Pick a target version and get a report and remediation plan. Checks: required feature flags; deprecated features in use (API); ha-* policies that silently do nothing in 4.x; CQv1, x-queue-mode and x-queue-version args; transient non-exclusive queues and global-QoS consumers (denied in 4.3); Khepri status; delayed-plugin use; partition-handling keys; node count and quorum; Erlang compatibility; community-support EOL dates; managed-service blockers. | 4.0.1, 4.3.0 and 4.4.0 notes. SO 76712557, 77873608, 78560616. Discussions #11350, #12848. Issue #16974. AWS 'not upgradeable to v4' page. Seventh State readiness self-assessment. |
| Queue migration wizard | operator | should | L | Convert classic or mirrored queues to quorum, or change immutable args: create the new queue, copy bindings, move messages with verification, switch over, then remove the old queue. Handle per-message TTL caveats and relaxed redeclaration checks. Batch mode with a skip list and rollback. | SO 63607314, 76350352 (inequivalent arg). AWS rabbitmq-queue-migration plugin README (TTL message_count_mismatch). RabbitMQ blue-green migration blog (2025-07-29). |
| Definitions diff, drift detection and selective sync | platform | should | L | Compare a live cluster with a file, a git repo, another cluster or another vhost. Dry-run selective sync. Apply transformations (strip CMQ keys, obfuscate users, exclude permissions). Export to YAML, Terraform or Kubernetes topology CRDs. | HTTP API: imports are merged and conflicts ignored. SO 41306350, 4545660. Discussion #12977. rabbitmqadmin v2 transformations. Tanzu Schema Definition Sync (commercial). Topology-operator #624. |
| Cluster and quorum health | operator | must | M | Node status, Khepri leader and quorum, quorum-queue members and quorum-critical queues, leader imbalance with a rebalance action, partitions, maintenance mode and certificate expiry, using the /api/health/checks endpoints. | HN 23259668. Discussions #15909, #5787, #13182. Khepri known issues (write timeouts without majority). Issue #8558. |
| Shovel and federation manager | operator | should | M | List shovels and federation links with real status, last error and rates. Create and edit with validation, diagnose 'stuck starting' and links that cannot forward, and clean up shovels that never connect. | SO 11443309, 64076455 (13k). Discussions #11317, #14639. Issue #17429 (open). |
| Bulk operations with guardrails | all | must | M | Multi-select by filter or regex, then purge, delete, move or apply a policy. Preview the affected objects, require typed confirmation in prod, throttle, and produce a result report written to the audit log. | SO 11459676 (230/236k), 5313027 (195/256k), 7149074 (262/232k), 6742938 (105). |
| Event and log timeline | operator | should | M | Subscribe to amq.rabbitmq.event and the optional amq.rabbitmq.log exchange. Present a searchable timeline of connection, queue, policy, user and alarm events, correlated with metrics. | Logging docs (event list). Discussion #6331. HN 35532338 (silent disconnects). |
| Production guardrails | team-security | must | M | Tag environments with color-coding. Profiles are read-only by default in prod. Keep a protected-resources list for queues, exchanges and vhosts. Require typed-name confirmations, separate purge from delete visually, and offer backup-before-purge (move messages to a quarantine queue). | rabbitmq-management #142 (purge/delete mix-up). SO 35876741, 79716696. Only vhost (4.0.6) and user (4.2) protection exist natively. Elastic purge-burst detection rule. |
| Web edition as SSO + RBAC + approval gateway | team-security | must | XL | People sign in to the portal with OIDC or SAML. The portal holds scoped broker credentials and enforces fine-grained permissions per environment, vhost and resource pattern (for example peek but not purge, or replay but not delete). Destructive prod operations can require approval. Doubles as the restricted-endpoint reverse proxy that maintainers recommend. | Access-control table (purge = read = get = consume). SO 53339508. Issues #2616 and #1000. Discussion #14313 (reverse proxy). CORS is refused by default, so a backend is needed anyway. |
| Immutable audit log with SIEM export | team-security | must | M | Record who did what: config changes, purges, deletes, message views, exports and replays, with before/after values. Append-only storage, retention policies, export over syslog, OTLP or JSON, plus a per-user activity view. | Management docs: HTTP API not logged by default. No purge event. SO 19937345 (auditability). Issues #16559 and #7764. Elastic rule depends on packet capture. |
| PII masking and view-payload permission | team-security | should | L | Masking rules (JSONPath or regex) applied to payload views and exports. Viewing metadata and viewing bodies are separate permissions. Exports are redacted and local caches are encrypted with configurable retention. | INFERENCE: any read grant exposes message bodies. Discussion #7582. Compliance requirements. |
| Broker OAuth2 config validator and token debugger | team-security | could | M | Generate and validate rabbitmq.conf OAuth2 settings for Entra ID, Keycloak, Okta and Auth0. Decode JWTs, show the scope-to-permission mapping, and explain common 'Not authorized' causes and version-specific breaking changes. | Discussion #13887 (Entra broke on 4.1.0; no community OAuth support). Issue #12261. Discussion #13386. Issues #16664 and #17110. 4.4 stricter OIDC discovery. |
| Credential and permission hygiene report | team-security | should | M | Flag the default guest user and loopback overrides, admin-tag sprawl, '.*' permissions everywhere, unused or stale users, missing 'protected' tags and weak TLS settings. | Access-control docs (guest loopback warning). HN 23263383 (forgotten admin password). 4.2 protected user tag. |
| Fleet overview and cross-cluster search | platform | should | L | One pane across many clusters and managed instances: health, version and EOL, alarms, top backlogs, DLQ totals, quorum-critical queues, and search across all of them. | Seventh State Grafana 'RabbitMQ Clusters' fleet dashboard. Tanzu commercial multi-cluster features. Discussion #7028. |
| Self-service portal for app teams | platform | could | XL | Teams request or declare their own queues, exchanges, bindings and users within guardrails: naming rules, required policies, quotas through vhost limits and approvals. Includes templates and resource ownership. | Issue #2616 (open since 2017). Discussion #7028 (operator vs user roles). Tanzu on-demand self-service. |
| Permission-scoped visibility | platform | should | M | Show each user only the resources that match their configure, write or read patterns, not everything in the vhost. | Issue #2616: management-tag users see all queues in their vhosts, enabling dictionary-style attacks. |
| GitOps/IaC export and drift warnings | platform | could | L | Export or import Terraform (cyrilgdn provider) and Messaging Topology Operator CRDs. Warn when a UI change will be overwritten by, or diverge from, IaC-managed state. | Topology-operator #624 (recreate configuration). Discussion #12977 (YAML export). terraform-provider-rabbitmq (26 open issues). |
| Kubernetes discovery and connect | platform | could | M | Find RabbitmqCluster resources through kubeconfig, open a port-forward to the management API and AMQP, and read the default-user secret with explicit consent. | Blog on reaching the management UI with the operator. Kubernetes discussions (74 titles). Cluster-operator issues. |
| Version-aware capability matrix | all | must | M | Detect broker version, plugins and feature flags and adapt the UI: stream filters on 4.2+, quorum-queue priority, retry and timeout on 4.3+, delays on 4.4+, changed endpoints such as hash_password POST in 4.4. Warn about EOL and deprecations. | 4.0 through 4.4 release notes. Community support windows of about 6 to 9 months. |
| Managed-service compatibility layer | all | must | M | Work through the HTTP API and AMQP only, with no broker plugins required. Handle Amazon MQ (no custom plugins, dynamic shovels only, its own migration tool) and CloudAMQP (IP allow-listing). Degrade gracefully when endpoints are blocked. | Amazon MQ plugin and upgrade docs. #8691 (CloudAMQP access friction). Klishin: plugin bundling 'not how large companies operate'. |
| Scale-ready, resilient UI | all | must | M | Virtualized tables, server-side pagination within the 500-item API cap, incremental refresh with no full-page reload, and error isolation so one bad response never blanks the app. | Maintainer Zerpet (#2619, 2026-09): runtime errors blank the UI; the page reloads every N seconds. HN 39097784. HTTP API max page size 500. |
| Local broker launcher | developer | could | M | Start RabbitMQ in Docker or Podman with management and chosen plugins, seeded definitions and users. Reset with one click, and switch versions to rehearse upgrades. | SO 47290108 (139/188k), 30747469 (119), 52819237 (70), 31403873, 75236860. |
| Message lifecycle trace | developer | could | L | Follow a message (by message-id or correlation-id) from publish through exchanges to queues and on to delivery, ack or dead-lettering, using a time-boxed firehose or tap that switches itself off. | Firehose docs (performance drop; state not persistent). SO 19937345. Discussion #3095. |
| Capacity and sizing assistant | operator | could | M | Per-queue memory and disk footprint, message-size distribution from samples, headroom on file descriptors and connections, vhost-limit usage and growth projections. | SO 18353898 (115/117k), 22989833 (76/78k). rabbitmqadmin v2 memory breakdown. Issue #16347. |

## Claims flagged for verification

- **[high]** The official management UI disables 'Get messages' and purge for streams (QUEUE_TYPE['stream'].actions.get_message=false in deps/rabbitmq_management/priv/www/js/global.js on main).
  - Why it matters: A stream browser would fill a real gap in the official UI.
  - Sources: https://github.com/rabbitmq/rabbitmq-server/blob/main/deps/rabbitmq_management/priv/www/js/global.js
- **[high]** queue.purge requires only 'read' permission on the queue, the same as basic.get and basic.consume, so native permissions cannot allow peeking or consuming without also allowing purge.
  - Why it matters: Supports fine-grained RBAC in a gateway-style web edition as a core differentiator.
  - Sources: https://www.rabbitmq.com/docs/access-control
- **[high]** RabbitMQ emits no internal event for queue purges, and HTTP API requests are not logged unless management.http_log_dir is set.
  - Why it matters: Shows an audit gap that only a tool-side audit log can fill.
  - Sources: https://www.rabbitmq.com/docs/logging https://www.rabbitmq.com/docs/management https://www.elastic.co/docs/reference/security/prebuilt-rules/rules/network/impact_amqp_multi_queue_purge_burst
- **[medium]** In the UI's Get messages, 'Nack message requeue true' (the default) sends basic.nack, while 'Reject requeue true' sends basic.reject. On quorum queues basic.reject and client crash or connection loss increment delivery-count; basic.nack does not. Since 4.0 the default delivery limit is 20, after which messages are dropped (or dead-lettered if a DLX exists).
  - Why it matters: Decides how peek must be implemented. A naive peek, or a consume-then-disconnect dump, can eventually delete messages. Behavior on graceful channel close and consumer timeout needs testing on 4.3/4.4.
  - Sources: https://github.com/rabbitmq/rabbitmq-server/blob/main/deps/rabbitmq_management/src/rabbit_mgmt_wm_queue_get.erl https://www.rabbitmq.com/docs/quorum-queues https://github.com/rabbitmq/rabbitmq-server/releases/tag/v4.0.1
- **[high]** RabbitMQ 4.3.0 (2026-04-23) makes Khepri the only metadata store, removes partition-handling strategies, supports upgrades only from 4.2.x, denies transient_nonexcl_queues, global_qos, amqp_address_v1, queue_master_locator and amqp_filter_set_bug by default, removes CQv1, and no longer evaluates consumer timeouts for classic queues and streams.
  - Why it matters: Defines the checks an upgrade readiness assessor needs, and explains why upgrades and migrations are a top-severity pain.
  - Sources: https://github.com/rabbitmq/rabbitmq-server/releases/tag/v4.3.0
- **[high]** After upgrading to 4.0, classic mirroring keys in policies (ha-mode etc.) silently have no effect; classic queues keep working with a single replica.
  - Why it matters: Replication can be lost with no error, so readiness tooling must detect it.
  - Sources: https://github.com/rabbitmq/rabbitmq-server/releases/tag/v4.0.1 https://www.netdata.cloud/guides/rabbitmq/rabbitmq-classic-mirrored-queue-removed/
- **[high]** RabbitMQ 4.x no longer interprets an x-death header set by a client when it re-publishes a message, though it still updates x-death on real dead-lettering.
  - Why it matters: DLQ replay must deliberately preserve or strip x-death and keep its own retry counter.
  - Sources: https://github.com/rabbitmq/rabbitmq-server/releases/tag/v4.0.1
- **[high]** The rabbitmq-delayed-message-exchange plugin is no longer maintained (repo archived; it depends on Mnesia, which 4.3 removed). Native quorum-queue delayed delivery arrives in 4.4 (x-opt-delivery-time); 4.4 is not yet released as of 2026-10-16.
  - Why it matters: A widely used plugin (2.3k stars) blocks upgrades, so a migration-helper feature has a concrete trigger.
  - Sources: https://github.com/rabbitmq/rabbitmq-delayed-message-exchange https://github.com/rabbitmq/rabbitmq-server/blob/main/release-notes/4.4.0.md
- **[high]** Core maintainers are prototyping a new TypeScript management UI (Vue+Chart.js and React+Tailwind prototypes, Sept 2026). They say the first step is modernizing without meaningful UI changes, and a new UI will ship later and take a long time to evaluate.
  - Why it matters: Sets how long the official UI will lag. The product should compete on workflows, not just looks.
  - Sources: https://github.com/rabbitmq/rabbitmq-server/issues/2619 https://github.com/rabbitmq/rabbitmq-server/issues/17533
- **[medium]** Management-plugin stats collection, although a deprecated feature, is 'much more likely' to remain at least through 4.x, because some users cannot run any other monitoring (Klishin, 2025-12-16).
  - Why it matters: The tool can rely on the management API for stats in 4.x but should still support Prometheus and stats-disabled modes.
  - Sources: https://github.com/rabbitmq/rabbitmq-server/discussions/15146 https://github.com/rabbitmq/rabbitmq-server/discussions/12833
- **[medium]** The management UI keeps only recent metric history ('hours, not days or months'). Per-queue incoming (publish) rate is still missing from Prometheus (issue #8691 open). /metrics/per-object should be avoided or scraped rarely at tens of thousands of objects.
  - Why it matters: Supports building a tool-side history store and a careful data-source strategy.
  - Sources: https://www.rabbitmq.com/docs/management https://github.com/rabbitmq/rabbitmq-server/issues/8691 https://www.rabbitmq.com/docs/prometheus
- **[medium]** Community support ended for 4.2 on 2026-07-31 and ends for 4.3 on 2027-01-31; 4.0's ended 2025-04-30, about 7 months after release.
  - Why it matters: Short support windows force frequent upgrades and raise the value of upgrade tooling.
  - Sources: https://www.rabbitmq.com/release-information
- **[high]** Deletion protection exists natively only for virtual hosts (since 4.0.6) and users (the 'protected' tag, since 4.2.0). Individual queues and exchanges cannot be protected.
  - Why it matters: Justifies tool-level guardrails (protected-resource lists, typed confirmations).
  - Sources: https://github.com/rabbitmq/rabbitmq-server/releases/tag/v4.0.6 https://github.com/rabbitmq/rabbitmq-server/releases/tag/v4.2.0 https://www.rabbitmq.com/docs/vhosts
- **[medium]** Amazon MQ marks 3.x brokers 'not upgradeable to v4' while classic queues exist or Khepri is enabled. AWS open-sourced a classic-to-quorum migration plugin (Dec 2025) that documents TTL-related message_count_mismatch failures.
  - Why it matters: Confirms demand for migration tooling and shows constraints for managed-service compatibility.
  - Sources: https://docs.aws.eu/amazon-mq/latest/developer-guide/troubleshooting-action-required-codes-rabbitmq-not-upgradeable-to-v4.html https://github.com/amazon-mq/rabbitmq-queue-migration
- **[high]** By default the management HTTP API refuses cross-origin (CORS) requests; origins must be explicitly allowed with management.cors.allow_origins.
  - Why it matters: A web edition hosted on its own origin needs a backend proxy (or broker reconfiguration), which makes the gateway architecture natural.
  - Sources: https://www.rabbitmq.com/docs/management

## Open questions

- Reddit sentiment (r/devops, r/dotnet, r/kubernetes, r/ExperiencedDevs, etc.) could not be mined: direct access returned 403, the archive API was rate-limited, and the shared web-search budget ran out. Only the r/rabbitmq archive to Oct 2022 was obtained. A manual Reddit pass is recommended.
- Exact quorum-queue delivery-count semantics for consumer timeout (two doc reads disagreed; the latest table says acquired-count only) and for a graceful channel.close with unacked deliveries (is it treated like 'connection loss'?) on 4.3/4.4. This needs a lab test before designing Safe Peek.
- How much the HTTP API is restricted on managed offerings (Amazon MQ, CloudAMQP, Azure-hosted, Tanzu): definitions import, shovel management, /api/queues/.../get and Prometheus endpoints.
- Its roadmap and changelog do not mention them; this needs competitor verification.
- Release timing of RabbitMQ 4.4 and whether the new official UI will ship inside it or later; also whether the maintainers' prototype will be distributed as a separate app (like RabbitScout) or in the plugin.
- Desktop users may value it more than web-UI users.
- Direct evidence for PII and compliance-driven payload masking is thin; interview regulated-industry users (finance, health) to validate priority.
- Market sizing: the share of RabbitMQ users on managed services, adoption of streams, and the proportion still on 3.13 or 4.0/4.1 (which determines how valuable migration tooling is now versus in 12 months).
- Whether 4.2+ message interceptors could enable a lightweight broker-side audit or trace plugin as an optional companion. This conflicts with the no-plugin principle and needs evaluation.
- Stack Overflow numbers are dominated by 2010-2018 questions; current-era frequency of each pain (2024-2026) is better captured by GitHub Discussions, which are biased by the maintainers' support policy.

## Sources

- https://api.stackexchange.com/2.3/questions?order=desc&sort=votes&tagged=rabbitmq&site=stackoverflow
- https://stackoverflow.com/questions/10709533
- https://stackoverflow.com/questions/9874234
- https://stackoverflow.com/questions/4700292
- https://stackoverflow.com/questions/31915773
- https://stackoverflow.com/questions/25114230
- https://stackoverflow.com/questions/7063224
- https://stackoverflow.com/questions/53374144
- https://stackoverflow.com/questions/69828547
- https://stackoverflow.com/questions/65201334
- https://stackoverflow.com/questions/32563873
- https://stackoverflow.com/questions/48845714
- https://stackoverflow.com/questions/36186578
- https://stackoverflow.com/questions/21742232
- https://stackoverflow.com/questions/23158310
- https://stackoverflow.com/questions/17014584
- https://stackoverflow.com/questions/4444208
- https://stackoverflow.com/questions/10620976
- https://stackoverflow.com/questions/9704590
- https://stackoverflow.com/questions/38988225
- https://stackoverflow.com/questions/42932933
- https://stackoverflow.com/questions/25162484
- https://stackoverflow.com/questions/6481760
- https://stackoverflow.com/questions/12175156
- https://stackoverflow.com/questions/40805580
- https://stackoverflow.com/questions/18418936
- https://stackoverflow.com/questions/8839094
- https://stackoverflow.com/questions/10407760
- https://stackoverflow.com/questions/25194406
- https://stackoverflow.com/questions/76712557
- https://stackoverflow.com/questions/77873608
- https://stackoverflow.com/questions/78720978
- https://stackoverflow.com/questions/78560616
- https://stackoverflow.com/questions/76350352
- https://stackoverflow.com/questions/63607314
- https://stackoverflow.com/questions/69084081
- https://stackoverflow.com/questions/79199487
- https://stackoverflow.com/questions/56940428
- https://stackoverflow.com/questions/59441565
- https://stackoverflow.com/questions/53339508
- https://stackoverflow.com/questions/35876741
- https://stackoverflow.com/questions/79716696
- https://stackoverflow.com/questions/19937345
- https://stackoverflow.com/questions/11459676
- https://stackoverflow.com/questions/5313027
- https://stackoverflow.com/questions/7149074
- https://stackoverflow.com/questions/6742938
- https://stackoverflow.com/questions/22850546
- https://stackoverflow.com/questions/26811924
- https://stackoverflow.com/questions/23669780
- https://stackoverflow.com/questions/14699873
- https://stackoverflow.com/questions/23500014
- https://stackoverflow.com/questions/47290108
- https://stackoverflow.com/questions/30747469
- https://stackoverflow.com/questions/52819237
- https://stackoverflow.com/questions/31403873
- https://stackoverflow.com/questions/75236860
- https://stackoverflow.com/questions/41306350
- https://stackoverflow.com/questions/4545660
- https://stackoverflow.com/questions/18353898
- https://stackoverflow.com/questions/22989833
- https://stackoverflow.com/questions/11443309
- https://stackoverflow.com/questions/64076455
- https://stackoverflow.com/questions/77106316
- https://stackoverflow.com/questions/76497553
- https://github.com/rabbitmq/rabbitmq-server/releases/tag/v4.0.1
- https://github.com/rabbitmq/rabbitmq-server/releases/tag/v4.0.6
- https://github.com/rabbitmq/rabbitmq-server/releases/tag/v4.1.0
- https://github.com/rabbitmq/rabbitmq-server/releases/tag/v4.2.0
- https://github.com/rabbitmq/rabbitmq-server/releases/tag/v4.3.0
- https://github.com/rabbitmq/rabbitmq-server/blob/main/release-notes/4.4.0.md
- https://github.com/rabbitmq/rabbitmq-server/issues/2619
- https://github.com/rabbitmq/rabbitmq-server/issues/17533
- https://github.com/rabbitmq/rabbitmq-server/issues/8691
- https://github.com/rabbitmq/rabbitmq-server/issues/2616
- https://github.com/rabbitmq/rabbitmq-server/issues/1000
- https://github.com/rabbitmq/rabbitmq-server/issues/16559
- https://github.com/rabbitmq/rabbitmq-server/issues/7764
- https://github.com/rabbitmq/rabbitmq-server/issues/12261
- https://github.com/rabbitmq/rabbitmq-server/issues/16664
- https://github.com/rabbitmq/rabbitmq-server/issues/17110
- https://github.com/rabbitmq/rabbitmq-server/issues/16974
- https://github.com/rabbitmq/rabbitmq-server/issues/17147
- https://github.com/rabbitmq/rabbitmq-server/issues/17429
- https://github.com/rabbitmq/rabbitmq-server/issues/8558
- https://github.com/rabbitmq/rabbitmq-management/issues/142
- https://github.com/rabbitmq/rabbitmq-server/discussions/15146
- https://github.com/rabbitmq/rabbitmq-server/discussions/12833
- https://github.com/rabbitmq/rabbitmq-server/discussions/11350
- https://github.com/rabbitmq/rabbitmq-server/discussions/10640
- https://github.com/rabbitmq/rabbitmq-server/discussions/12848
- https://github.com/rabbitmq/rabbitmq-server/discussions/16324
- https://github.com/rabbitmq/rabbitmq-server/discussions/13060
- https://github.com/rabbitmq/rabbitmq-server/discussions/3095
- https://github.com/rabbitmq/rabbitmq-server/discussions/12967
- https://github.com/rabbitmq/rabbitmq-server/discussions/14313
- https://github.com/rabbitmq/rabbitmq-server/discussions/13887
- https://github.com/rabbitmq/rabbitmq-server/discussions/13386
- https://github.com/rabbitmq/rabbitmq-server/discussions/13477
- https://github.com/rabbitmq/rabbitmq-server/discussions/14424
- https://github.com/rabbitmq/rabbitmq-server/discussions/7028
- https://github.com/rabbitmq/rabbitmq-server/discussions/6331
- https://github.com/rabbitmq/rabbitmq-server/discussions/14611
- https://github.com/rabbitmq/rabbitmq-server/discussions/9079
- https://github.com/rabbitmq/rabbitmq-server/discussions/17816
- https://github.com/rabbitmq/rabbitmq-server/discussions/14666
- https://github.com/rabbitmq/rabbitmq-server/discussions/15562
- https://github.com/rabbitmq/rabbitmq-server/discussions/5787
- https://github.com/rabbitmq/rabbitmq-server/discussions/15909
- https://github.com/rabbitmq/rabbitmq-server/discussions/13182
- https://github.com/rabbitmq/rabbitmq-server/discussions/7674
- https://github.com/rabbitmq/rabbitmq-server/discussions/10518
- https://github.com/rabbitmq/rabbitmq-server/discussions/10611
- https://github.com/rabbitmq/rabbitmq-server/discussions/7362
- https://github.com/rabbitmq/rabbitmq-server/discussions/11317
- https://github.com/rabbitmq/rabbitmq-server/discussions/14639
- https://github.com/rabbitmq/rabbitmq-server/discussions/6444
- https://github.com/rabbitmq/rabbitmq-server/discussions/3306
- https://github.com/rabbitmq/rabbitmq-server/discussions/7582
- https://github.com/rabbitmq/rabbitmq-server/discussions/12977
- https://github.com/rabbitmq/rabbitmq-server/blob/main/deps/rabbitmq_management/priv/www/js/global.js
- https://github.com/rabbitmq/rabbitmq-server/blob/main/deps/rabbitmq_management/priv/www/js/tmpl/classic-queue-get-message.ejs
- https://github.com/rabbitmq/rabbitmq-server/blob/main/deps/rabbitmq_management/priv/www/js/tmpl/queue.ejs
- https://github.com/rabbitmq/rabbitmq-server/blob/main/deps/rabbitmq_management/src/rabbit_mgmt_wm_queue_get.erl
- https://github.com/rabbitmq/cluster-operator/issues/223
- https://github.com/rabbitmq/messaging-topology-operator/issues/624
- https://github.com/rabbitmq/rabbitmq-delayed-message-exchange
- https://github.com/rabbitmq/rabbitmqadmin-ng
- https://github.com/amazon-mq/rabbitmq-queue-migration
- https://github.com/jandelgado/rabtap
- https://github.com/dubek/rabbitmq-dump-queue
- https://github.com/streamdal/plumber
- https://github.com/cloudamqp/amqproxy
- https://github.com/Ralve-org/RabbitScout
- https://github.com/cyrilgdn/terraform-provider-rabbitmq
- https://www.rabbitmq.com/docs/management
- https://www.rabbitmq.com/docs/access-control
- https://www.rabbitmq.com/docs/quorum-queues
- https://www.rabbitmq.com/docs/event-exchange
- https://www.rabbitmq.com/docs/logging
- https://www.rabbitmq.com/docs/connections
- https://www.rabbitmq.com/docs/alarms
- https://www.rabbitmq.com/docs/firehose
- https://www.rabbitmq.com/docs/prometheus
- https://www.rabbitmq.com/docs/http-api-reference
- https://www.rabbitmq.com/docs/vhosts
- https://www.rabbitmq.com/docs/metadata-store/known-issues
- https://www.rabbitmq.com/release-information
- https://www.rabbitmq.com/blog/2025/07/29/latest-benefits-of-rmq-and-migrating-to-qq-along-the-way
- https://www.rabbitmq.com/blog/2025/09/23/sql-filter-expressions
- https://docs.aws.eu/amazon-mq/latest/developer-guide/troubleshooting-action-required-codes-rabbitmq-not-upgradeable-to-v4.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/quorum-queues-migration.html
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-basic-elements-plugins.html
- https://www.elastic.co/docs/reference/security/prebuilt-rules/rules/network/impact_amqp_multi_queue_purge_burst
- https://docs.particular.net/servicepulse/intro-failed-messages
- https://kestra.io/blueprints/rabbitmq-dlq-quarantine-and-replay
- https://www.netdata.cloud/guides/rabbitmq/rabbitmq-classic-mirrored-queue-removed/
- https://www.netdata.cloud/guides/rabbitmq/rabbitmq-consumer-timeout/
- https://www.cloudamqp.com/blog/part4-rabbitmq-13-common-errors.html
- https://dev.to/danzal/rabbitscout-a-modern-open-source-dashboard-for-managing-rabbitmq-3lha
- https://ryanrodemoyer.github.io/what-i-wish-someone-would-have-told-me-about-using-rabbitmq-before-it-was-too-late/
- https://seventhstate.io/are-you-rabbitmq40-ready/
- https://grafana.com/grafana/dashboards/20697-rabbitmq-clusters-seventh-state-rabbitmq-support/
- https://news.ycombinator.com/item?id=35526846
- https://news.ycombinator.com/item?id=32091550
- https://news.ycombinator.com/item?id=41581942
- https://news.ycombinator.com/item?id=23258301
- https://news.ycombinator.com/item?id=39097784
- https://news.ycombinator.com/item?id=40025577
- https://news.ycombinator.com/item?id=35532770
- https://news.ycombinator.com/item?id=35532338
- https://news.ycombinator.com/item?id=23263383
- https://news.ycombinator.com/item?id=23259668
- https://news.ycombinator.com/item?id=24709442
- https://hn.algolia.com/api/v1/search?query=rabbitmq&tags=story
- https://reddit.com/r/rabbitmq/comments/8d9yi6/queue_viewer_a_windows_gui_for_rabbitmq_management/
- https://reddit.com/r/rabbitmq/comments/besef4/alicemq_open_source_rabbitmq_visualizer/
- https://reddit.com/r/rabbitmq/comments/tnsstt/new_debugging_tool_amqpclientcli/
- https://reddit.com/r/rabbitmq/comments/b42kve/rabbitmq_no_longer_loses_message_with_the_use_of/
- https://reddit.com/r/rabbitmq/comments/p0y6sm/do_you_name_your_producers_and_consumers/
