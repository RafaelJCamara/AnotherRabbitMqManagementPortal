# Competitor landscape 2026 (verified)

> **Verified research (2026-10-16).** Source read at exact release tags and primary docs; **not yet lab-tested**. The conformance suite (M0) confirms or corrects every runtime claim. Content about a specific third-party product was removed under the docs policy ([ADR-034](../adr/ADR-034-docs-policy.md)).

_Verification task `competitors-2026` · 2026-10-16_

## Summary

The lane for a fully open-source tool that combines a developer IDE, full admin, ops/SRE features and a team-grade self-hosted web edition is open as of 2026-10-16, though competitors are moving fast at every edge.

**Coverage today.** No product covers more than two of those four areas. Every product with team features is closed source, charges for those features, or does DLQ work only:
- Warren is closed source, and its paid tiers are not released yet.
- Qarote is open core, with SSO, RBAC and audit only in its Cloud tier ($99/month billed yearly, up to 100 queues per broker).
- QueueLens is MIT-licensed but DLQ-only, with 0 stars.

**Previously untraced products, now found:**
- **QueueLens:** github.com/talaatmagdyx/queuelens (MIT, Python, v0.19.2 on 2026-10-10).
- **HZN Queue Console:** hzn-queue-console.app, from Huzen Software B.V. in the Netherlands. v1.0.5; Pro costs €12/month or €99/year. Its web edition is listed as "Coming soon, Q4 2026".

**Peek safety on quorum queues.** This is the most decision-relevant finding. Competitors contradict each other about whether peeking a quorum queue is safe, and each is partly wrong. RabbitMQ source read at exact tags shows three behaviour eras:

| Versions | What spends the delivery limit |
| --- | --- |
| 3.13 | Every return of a message to the queue counts. |
| 4.0.x–4.2.x, including the v4.2.x branch head (2026-10-14) | The limit (default 20) is checked against `acquired_count`. Every `basic.nack` or AMQP 1.0 `released` raises it, so peeks spend the budget. |
| 4.3+ | Only failed deliveries count. Exception: a message whose count is already over the limit is dropped on any return. |

How each competitor gets it wrong:
- Queue Studio claims peeking "never counts". It peeks with HTTP `/get` plus `basic.nack`, which is free only on 4.3+.
- Warren claims "RabbitMQ 4 no longer counts" returns. That is wrong for 4.0–4.2.
- QueueLens refuses to browse quorum queues with a limit even where 4.3 would allow it.
- QueueExplorer returns messages by closing the session, which counts on 4.3.

**verified from outside:**
- It uses the management HTTP API plus direct AMQP connections for consume, peek and spy, with no relay server.
- Outbound calls: licensing (monthly online check, up to a month offline) and Sentry. It also has an auto-updater that fetches from the vendor's S3 bucket, and its terms reserve "usage data ... and analytics".
- Peek fetches the first 1,000 messages with consumer prefetch, then puts them back with nack. It is not `basic.get`.
- 1.9.0 (2026-08-18) is still the latest; none of its 10 roadmap items has shipped; there is no trial.

*RabbitMQ resolves max-length as the minimum of the two, so the effective value is 500, not the 1,000 it displays.

**Implications.** Lead with verified, version-aware message safety, backed by a public conformance suite. Also lead on giving away the team server free (OIDC, RBAC, audit, approvals, masking), and on one engine for desktop, local web and team server. The main threats:
- the RabbitMQ core team's next-gen management UI (prototypes shown 2026-09-23; ship date "later");
- the AI-paced release cadence of solo competitors.

## Verdicts

| ID | Verdict | Confidence | Verified statement |
| --- | --- | --- | --- |
| R2a | confirmed | high | Confirmed as documented by the vendor: messages are taken with consumer prefetch, stored in a local database, then nacked with requeue; only the first 1,000 messages at the head are reachable and repeated extraction returns the same messages. Errors in the vendor's own side-effect text: nack/requeue does not add x-death or x-first-death-* (only dead-lettering does); on 4.3+ nack does not change x-delivery-count (only x-acquired-count); on 4.0-4.2 the x-delivery-count header equals the acquired count, which every nack raises toward the default limit of 20, so ~20 peeks of a quorum DLQ can dead-letter or drop its messages. |
| R3a | confirmed | high | Confirmed 2026-10-16 12:02 UTC: latest.yml, latest-mac.yml and latest-linux.yml all report version 1.9.0 (releaseDate 2026-08-18T09:46-09:57Z; latest.yml Last-Modified Tue, 18 Aug 2026 09:46:46 GMT); the changelog's newest entry is v1.9.0 (August 18, 2026, AMQP connection string); /download links only 1.9.0 artifacts; HEAD requests for 1.9.1, 1.9.2, 1.10.0, 1.10.1, 1.11.0 and 2.0.0 installers and for beta.yml/alpha.yml return 403 (absent) while the 1.9.0 installer returns 200. |
| R3b | confirmed | high | Confirmed: /roadmap still lists Protobuf support, custom alerts, export of consumed messages, dummy message generator, bulk publish, filtering on JSON keys, users management, monitoring statistics, policies editor, and connections/channels management; the changelog (1.1.1 to 1.9.0) contains none of them (new platforms, custom views, headers/properties, forecast, routing graph, spy, peek, dark theme, AMQP connection string). |
| R3d | confirmed | high | Confirmed: 'We don't provide a trial, but we do have a 30-day money-back guarantee'; the licence manager shows a Cancel action only within 30 days of licence creation (2592e6 ms). Price is 45 EUR one-time with 'Free updates, forever'. |
| R3e | confirmed | high | Confirmed: 'The only time the app needs to connect online is to activate your license the first time you use it, and then once every month. Between those checks, you can stay fully offline for up to a month without any interruption.' Installation requires pasting the key at first launch and activation before use. |
| Q1-QueueLens | refuted | high | QueueLens is https://github.com/talaatmagdyx/queuelens (site https://talaatmagdyx.github.io/queuelens/, image ghcr.io/talaatmagdyx/queuelens). It is MIT-licensed, built with Python 3.12, FastAPI and aio-pika, repo created 2026-07-10. It has 27 tags: v0.9.0 on 2026-07-11, then 20 releases between 2026-10-01 and v0.19.2 on 2026-10-10. Traction is 0 stars, 0 forks and 106 GHCR downloads. Its features match Warren's description: Viewer/Operator/Admin roles, an audit log recording attempt and outcome, a mandatory dry-run, a {queue}.parking queue, field masking, and a refusal to browse quorum queues that have a delivery limit. Email, Slack, PagerDuty and webhook alert delivery is marked experimental, and SSO works only behind an authenticating proxy (experimental). |
| Q1-HZN | refuted | high | HZN Queue Console is https://hzn-queue-console.app/ from Huzen Software B.V., registered in the Netherlands.  - **Product:** a desktop app for macOS, Windows and Linux (download zips of about 165-190 MB) supporting RabbitMQ 3.11+, ActiveMQ Classic 5.16+ and Artemis 2.28+. - **Pricing:** 14-day trial. Pro costs €12/month or €99/year for one seat active on one machine at a time. Team costs €11/seat/month or €79/seat/year with a minimum of 5 seats, and is only a bundle of independent keys. A Custom company licence to 'Deploy as an internal web service' is marked 'Coming soon · Q4 2026'. - **Releases:** 1.0.2 on 2026-08-25, 1.0.3 on 2026-08-31, 1.0.4 on 2026-09-08 and 1.0.5 on 2026-09-14; nothing newer. - **Quorum-queue bug:** the 1.0.4 changelog admits that interrupted searches could destroy messages on quorum queues with a delivery limit, because the connection close returned the messages. - **Spy Mode** cannot use AMQPS. - **Traction:** no GitHub or Hacker News presence found. |
| Q3 | nuanced | medium | Queue Studio reads quorum queues through the management HTTP API ('Up to 5,000 messages over the HTTP API'), i.e. POST /api/queues/{vhost}/{queue}/get. That endpoint runs basic.get N times on a server-side channel, then sends basic.nack(multiple=false, requeue=true) for each message (ackmode ack_requeue_true). It does not use AMQP 1.0 'released'.  Whether this spends the delivery limit depends on the broker version: - **4.3+:** it does not count. nack is a plain return that increments only acquired-count, and the limit is checked against delivery-count (4.3.0 change, #13885). - **4.0.x-4.2.x (including the v4.2.x branch head on 2026-10-14):** it counts. Every return, nack included, increments acquired_count, and the limit (default 20) is checked against it. The 21st return dead-letters the message (reason delivery_limit) or drops it. - **3.13:** every return increments delivery_count. The limit applies only if one is configured.  Even on 4.3 there are two exceptions: - A message whose delivery-count already exceeds the limit is dropped or dead-lettered on any return. Example: a message that another quorum queue dead-lettered for delivery_limit, carrying its count. - delayed-retry-type returned/all delays nacked messages.  Settling on the server inside one HTTP request also shields the read from an IDE crash, which on 4.3 would count as a failed delivery.  The vendor's unconditional 'never counts' claim is therefore true only on 4.3+. |
| P-Warren-RMQ4 | refuted | high | Explicit returns stopped counting only in 4.3.0 (#13885). On 4.0.x-4.2.x the quorum delivery limit (default 20) is checked against acquired_count, which every nack, reject, released or modified return increments. On those versions every peek-with-requeue counts, whether it comes from Warren, the management UI or a script. Warren's 4.3.6 measurement, that over-limit arrivals in a quorum DLQ are dropped on any return, is consistent with 4.3 source. |
| P-QueueLens-RMQ4 | nuanced | high | This is true for 4.0-4.2, where the limit is based on acquired-count; QueueLens measured it on 3.13.7 and 4.1.8. It is false for 4.3+, where basic.nack, AMQP 1.0 released and modified(delivery-failed=false) do not count, while reject, modified(delivery-failed=true) and channel/connection termination still do. QueueLens therefore refuses quorum queues on 4.3 where a nack-based browse would be free. |
| P-313-minus1 | confirmed | medium | Confirmed from source; not tested here. On 3.13.7 the x-delivery-limit argument is not validated (it is absent from declare_args). return_one increments delivery_count on every return and discards when delivery_count > DeliveryLimit, so -1 means dropped or dead-lettered on the first return. The delivery-limit policy key rejects negative values (validator requires >= 0). Leaving the limit unset means no limit on 3.13. From 4.0, -1 means unlimited. |
| P-Warren-editions | nuanced | high | **Community** (free): one broker with up to 3 vhosts; browse, search, replay, dry run, park, discard, purge, export, publish and the audit log; 'History: the last hour'; no roles ('every user is admin').  **Team:** up to 3 brokers; viewer/operator/admin roles; alerts; replay rules; Prometheus; up to 7 days of history.  **Pro:** unlimited brokers; OIDC single sign-on; four-eyes approval; audit export as CSV and forwarding to a SIEM; up to 90 days of history; your own PostgreSQL.  Team and Pro are unreleased. They will be one-time purchases with 12 months of updates; prices are unpublished.  Across editions: - licence keys are verified offline, with no phone-home; - the source code is not published; - the image is Java/Spring; - 0.17.0 shipped 2026-10-13; - Docker Hub shows 2,823 pulls since registration on 2026-10-05. |
| P-QueueStudio-vendor-price | nuanced | high | Factodus (Mislata, Spain; verified JetBrains vendor) sells Queue Studio for RabbitMQ 'From $4 a month for individuals, with a 30-day free trial'; plugin id 34454 (com.factodus.queuestudio), versions 1.0.0-1.0.2, 82 downloads, IDE 2025.3+, listing created 2026-10-07; docs repo drbenzin/queue-studio-docs created 2026-09-23 (0 stars, no issues). |
| P-MCP-peek | confirmed | high | Confirmed on main: rabbitmq_broker_get_messages is registered in __register_read_only_tools (available without --allow-mutative-tools), is documented as 'Peek at messages in a queue without consuming them', and passes ackmode (default ack_requeue_true, or ack_requeue_false = consume) to POST queues/{vhost}/{queue}/get. On 4.0-4.2 quorum queues each call spends delivery-limit budget. v4.0.0 released 2026-07-28; 42 stars. |
| P-C3-count-travels | nuanced | medium | Plausible and supported by source on 4.3. There, a quorum queue copies the incoming message's delivery-count annotation into its own header on enqueue. The 4.3.0 release notes say acquired-count is 'now correctly preserved when dead-lettering'. return_one checks delivery_count > limit on every return. This is consistent with Warren's 4.3.6 measurement: an arrival with count 21 is dropped on its first return to a quorum DLQ with the default limit of 20, even via nack.  On 4.0-4.2 the limit basis is acquired_count, which is not copied on enqueue. The arriving count does not cause drops there, but every peek spends the DLQ's own budget of 20. Not lab-tested. |
| P-official-UI-get | confirmed | high | Confirmed at v4.3.6. The template warns 'getting messages from a queue is a destructive action' and pre-selects ack_requeue_true ('Nack message requeue true'). The other modes are Automatic ack, Reject requeue true and Reject requeue false. On 4.0-4.2 quorum queues each default get spends delivery-limit budget. On 4.3 the default nack mode is free, but 'Reject requeue true' counts. |
| P-nextgen-UI | confirmed | high | Confirmed:  - **Prototypes:** on 2026-09-23 core engineer Zerpet shared TypeScript UI prototypes (Vue + Charts, and React + Tailwind) on issue #2619. - **Timeline:** Michael Klishin replied: 'modernizing the UI without any meaningful UI changes will be the first step. A completely new UI prototype will most likely ship later, and take a long time to evaluate.' - **Interim work:** PR #17760 (2026-10-08) replaces SammyJS and says 'The next-gen management will scrap all this code anyway.' - **Plugin idea:** gmr noted that a new UI could be bundled as a RabbitMQ plugin. |
| P-adjacent-vendors | refuted | medium | None of them offers RabbitMQ message browsing, peek or DLQ tooling.  - **Kadeck** positions on Apache Kafka and Amazon Kinesis. - **Conduktor's** only RabbitMQ page is a 'kafka-vs-rabbitmq' glossary entry. - **Lenses and Kpow (Factor House):** no RabbitMQ pages were found. - **Datadog** collects RabbitMQ metrics through Prometheus or the management plugin, and supports RabbitMQ in Data Streams Monitoring (pipeline and lag). It has no payload inspection. - **Grafana** has official RabbitMQ dashboards, plus a stale community plugin, 'Rabbitmq streaming datasource plugin' v1.0.0 (updated 2024-09-13), that streams data into panels. - **Flower** uses the management API (broker_api) only to read queue information. |
| P-QueueExplorer-browse | nuanced | medium | Cogin documents how browsing works. QueueExplorer consumes messages and keeps them unacknowledged while reading; 'When the read session closes, RabbitMQ returns the outstanding deliveries to the queue'. An exclusive mode blocks other consumers during the read. Cogin warns that 'Quorum delivery limits require care'.  Inference: on 4.3 quorum queues, a return by session termination counts as a failed delivery, and on 4.0-4.2 every return counts, so QueueExplorer browsing spends delivery budget on both.  Release history: - 5.0.93 (2026-09-11) fixed quorum-queue deletes on RabbitMQ 4.3+. - 5.0.98 (2026-10-02) fixed moves that sometimes failed to delete the source message.  Current versions are 5.0.99 on Windows (2026-10-05) and 5.0.98 on Mac/Linux. |
| P-devtools-listing | confirmed | high | Confirmed. devtools.md lists 'a tool for vizualizing and managing dead letter queues' and 'Warren, a Web UI for browsing dead-lettered messages'. Warren's PR #2662 was opened 2026-10-02 and merged 2026-10-03. No QueueLens, HZN, Queue Studio or Qarote entry exists. |

### Evidence

- After activation, you are ready').
- **Q1-QueueLens** (refuted, high): gh api repos/talaatmagdyx/queuelens (created 2026-07-10, MIT, Python, homepage talaatmagdyx.github.io/queuelens); gh api repos/talaatmagdyx/queuelens/releases; https://raw.githubusercontent.com/talaatmagdyx/queuelens/main/README.md (Feature status table); https://github.com/talaatmagdyx/queuelens/pkgs/container/queuelens ('Total downloads 106'); no HN hits (hn.algolia.com).
- **Q1-HZN** (refuted, high): https://hzn-queue-console.app/ (schema.org offers, 'Desktop only', 'No Agent Required ... uses the broker's built-in management APIs'); https://hzn-queue-console.app/llms.txt ; https://hzn-queue-console.app/pricing ; https://hzn-queue-console.app/docs/changelog (1.0.4 text); https://hzn-queue-console.app/downloads/latest/manifest.json (version 1.0.5, releaseDate 2026-09-14); HEAD Last-Modified of /downloads/1.0.2..1.0.5/ zips; https://hzn-queue-console.app/terms ('Huzen Software B.V., registered in the Netherlands'); https://hzn-queue-console.app/docs/server-connections ('Spy Mode does not negotiate TLS ... AMQPS on 5671. Not supported by Spy Mode'); found via https://saasbrowser.com/en/saas/1606670/hzn-queue-console
- **Q3** (nuanced, medium): https://raw.githubusercontent.com/drbenzin/queue-studio-docs/main/README.md ('Quorum | Up to 5,000 messages over the HTTP API | Marked redelivered; does not count toward delivery-limit'); https://plugins.jetbrains.com/api/plugins/34454 ('Peeking a quorum queue never counts toward its delivery-limit'); rabbit_mgmt_wm_queue_get.erl@v4.3.6 L141-146; rabbit_channel.erl@v4.3.6 L1249-1258 (nack requeue -> requeue op) vs L1527-1535 (reject -> settle(true,false)); rabbit_channel.erl@v4.2.9 L1279-1282 and L1589-1591 (nack and reject identical); rabbit_fifo.erl@v4.3.6 return_one L2348-2398 (delivery_count > DeliveryLimit); rabbit_fifo.erl@v4.2.9 L1944-1966 and incr_msg L3097-3112 (acquired_count always +1, checked > DeliveryLimit); @v4.0.9 L1894-1905; @v4.1.8 L1946-1957; v4.2.x branch L1954-1955; https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/release-notes/4.3.0.md L230-232, L351; rabbit_fifo.erl@v4.3.6 should_delay0 L2424-2435.
- **P-Warren-RMQ4** (refuted, high): https://warrenops.io/docs/quorum-queues.html ; https://warrenops.io/ FAQ; rabbit_fifo.erl@v4.2.9 L1944-1966; @v4.0.9 L1894-1905; @v4.1.8 L1946-1957; release-notes/4.3.0.md L230-232.
- **P-QueueLens-RMQ4** (nuanced, high): https://raw.githubusercontent.com/talaatmagdyx/queuelens/main/docs/SAFETY.md L17-33; https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/quorum-queues/index.md L584-589 and trigger table L629-639; rabbit_fifo.erl@v4.3.6 L2348-2398.
- **P-313-minus1** (confirmed, medium): rabbit_fifo.erl@v3.13.7 L1847-1863; rabbit_amqqueue.erl@v3.13.7 declare_args L912-933; rabbit_policies.erl@v3.13.7 L167-171; quorum-queues docs ('3.13.x era behavior where there was no limit can be restored by setting x-delivery-limit=-1').
- **P-Qarote** (nuanced, high): https://raw.githubusercontent.com/getqarote/Qarote/main/README.md (Editions, 'Community Edition mirror', License section); https://raw.githubusercontent.com/getqarote/Qarote/main/LICENSE (MIT); https://qarote.io/pricing/ ; https://qarote.io/changelog/ ; https://github.com/getqarote/Qarote/pull/448 ; https://raw.githubusercontent.com/getqarote/Qarote/main/docs/ENTERPRISE_EDITION.md ; https://registry.npmjs.org/@qarote%2Fmcp (not found).
- **P-Warren-editions** (nuanced, high): https://warrenops.io/docs/editions.html ; https://warrenops.io/ (Pricing, 'No telemetry, no phone-home'); https://hub.docker.com/v2/repositories/viba88/warren/ (pull_count 2823, date_registered 2026-10-05); https://github.com/ViBa88/warren-releases ('Source is not published').
- **P-QueueStudio-vendor-price** (nuanced, high): https://factodus.com/queue-studio/ ; https://plugins.jetbrains.com/api/plugins/34454 (downloads 82, trialPeriod 30, vendor country ES); https://plugins.jetbrains.com/api/plugins/34454/updates ; gh api repos/drbenzin/queue-studio-docs
- **P-MCP-peek** (confirmed, high): https://raw.githubusercontent.com/amazon-mq/mcp-server-rabbitmq/main/src/rabbitmq/admin.py L338-354; https://raw.githubusercontent.com/amazon-mq/mcp-server-rabbitmq/main/src/rabbitmq/module.py L228 (__register_read_only_tools), L325-332; https://pypi.org/pypi/amq-mcp-server-rabbitmq/json (4.0.0).
- **P-C3-count-travels** (nuanced, medium): rabbit_fifo.erl@v4.3.6 maybe_set_msg_delivery_count L2032-2044 and return_one L2348-2398; release-notes/4.3.0.md L351 (#16039); rabbit_fifo.erl@v4.2.9 L1674-1686 (only delivery_count copied) and L1944-1966 (acquired_count basis); https://warrenops.io/docs/quorum-queues.html
- **P-official-UI-get** (confirmed, high): https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/priv/www/js/tmpl/classic-queue-get-message.ejs L5, L16-20; rabbit_mgmt_wm_queue_get.erl@v4.3.6 L135-146.
- **P-nextgen-UI** (confirmed, high): https://github.com/rabbitmq/rabbitmq-server/issues/2619 (comments 2026-09-21..23); https://github.com/rabbitmq/rabbitmq-server/issues/17533 ; https://github.com/rabbitmq/rabbitmq-server/pull/17760
- **P-adjacent-vendors** (refuted, medium): https://www.kadeck.com/ ; https://www.conduktor.io/sitemap.xml ; https://lenses.io/ ; https://factorhouse.io/products/kpow/ ; https://docs.datadoghq.com/integrations/rabbitmq/ ; https://docs.datadoghq.com/data_streams/ ; https://grafana.com/api/plugins/maormil-rabbitmq-datasource ; https://raw.githubusercontent.com/mher/flower/master/docs/config.rst (broker_api).
- **P-QueueExplorer-browse** (nuanced, medium): https://www.cogin.com/articles/rabbitmq/inspect-rabbitmq-message-contents-without-losing-them.php ; https://www.cogin.com/mq/qehistory.php ; https://www.cogin.com/mq/download.php ; quorum-queues docs trigger table (Client crash / Connection loss increments delivery-count).
- **P-devtools-listing** (confirmed, high): https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/client-libraries/devtools.md L224-227; https://github.com/rabbitmq/rabbitmq-website/pull/2662

## Report

# Verified 2026 competitor matrix fact check

All sources were accessed on **2026-10-16**, between 12:00 and 12:50 UTC.

## 0. Method

**What I did not do.** This was read-only research. I installed nothing, ran no product and ran no broker.

**Evidence types used:**
- **VENDOR:** the vendor's own pages, docs, changelogs, update feeds and public website JavaScript.
- **REGISTRY:** GitHub REST through `gh api`, Docker Hub v2, JetBrains Marketplace API, the iTunes lookup API, PyPI/pypistats, the npm registry and the French company registry.
- **SOURCE:** RabbitMQ source read at exact tags on raw.githubusercontent.com (3.13.7, 4.0.8, 4.0.9, 4.1.8, 4.2.9, the `v4.2.x` branch, 4.3.0 and 4.3.6), plus rabbitmq-website docs on `main`.
- **INFERENCE:** my reasoning, labelled as such.

**Caveats:**
- Vendor comparison pages are treated as biased. Warren's 2026-10-12 comparison was used only as a lead.
- Public OSS tags stop at **v4.2.9**. 4.2.10 and 4.2.11 appear on release-information but are not tagged publicly (`git/ref/tags/v4.2.10` returns 404), so they are presumably commercial-only builds.

---

## 1. Answers in brief

1. **QueueLens and HZN Queue Console both exist.**
   - QueueLens = https://github.com/talaatmagdyx/queuelens (MIT, Python).
   - HZN Queue Console = https://hzn-queue-console.app/ (Huzen Software B.V., Netherlands).
   - Neither has measurable traction yet.
2. **Competitor matrix:** sections 2–4.
3. **Queue Studio and quorum queues.** It peeks through the management HTTP API's `/get` endpoint with ackmode `ack_requeue_true`, which means `basic.get` then `basic.nack(requeue)` on the server side. It does not use AMQP 1.0 `released`.
   - This is free only on **RabbitMQ 4.3+**.
   - On **4.0–4.2**, every peek spends the default delivery limit of 20 (section 5).
   - R1 is nuanced: there is an extra updater call, and the terms reserve analytics.
   - R2's prefetch-plus-nack description is confirmed;
   - R3 is confirmed. The "one machine per key" part is nuanced.
   - Section 7 gives the precise precedence rules.

---

## 2. Identity, commercial terms, traction (accessed 2026-10-16)

| Product | Vendor | Licence | Price | Delivery modes | Latest version · cadence | Traction | URL |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **HZN Queue Console** | Huzen Software B.V. (NL) | Proprietary; the Enterprise licence includes source code | 14-day trial. Pro €12/month or €99/year (1 seat, 1 machine at a time). Team €11/seat/month or €79/seat/year, minimum 5. Custom web licence "Coming soon · Q4 2026" | Desktop for macOS, Windows and Linux (zips of 165–190 MB). Web only through the future Custom licence | **1.0.5 (2026-09-14).** 1.0.2 on 08-25, 1.0.3 on 08-31, 1.0.4 on 09-08; nothing since | None public; no GitHub or HN presence | https://hzn-queue-console.app |
| **Queue Studio for RabbitMQ** | Factodus (Mislata, Spain) | Proprietary EULA | From $4/month for individuals; 30-day trial | JetBrains IDE plugin (2025.3+) | **1.0.2** (versions 1.0.0–1.0.2; listing created 2026-10-07) | 82 downloads | https://plugins.jetbrains.com/plugin/34454-queue-studio-for-rabbitmq , https://github.com/drbenzin/queue-studio-docs |
| **QueueExplorer 5** | Cogin | Proprietary, perpetual, 12 months of maintenance | Standard $149, Pro $249 per computer; 14-day trial | Desktop for Windows, macOS and Linux (Mac/Linux generally available since 2026-07-08); also handles Azure Service Bus, MSMQ and ActiveMQ Classic | **5.0.99 Windows (2026-10-05) / 5.0.98 Mac/Linux.** Releases roughly weekly | Not published | https://www.cogin.com/mq/ |
| **RabbitMQ Assistant** | Redisant | Proprietary | $49.99, free evaluation | Desktop for Windows, macOS and Linux | 1.3.1.4 | Not published | https://www.redisant.com/rta |
| **RMQ** | Aaron Carr | Proprietary (Mac App Store) | $19.99 | macOS 26+ | **1.1.3 (2026-09-16)**; first release 2025-12-17 | 0 ratings | https://apps.apple.com/app/id6755972526 |
| **Warren** | "Warren", Germany (Impressum, gmail contact; author byline Viktor Baumann) | Proprietary; source not published | Community free. Team and Pro "coming soon", one-time purchase with 12 months of updates, prices unpublished | Self-hosted container (Java/Spring, H2 database, PostgreSQL in Pro), amd64/arm64, Helm | **0.17.0 (2026-10-13).** 0.8.0 to 0.17.0 in 9 days | Docker Hub: 2,823 pulls since 2026-10-05. GHCR: 255. 0 GitHub stars. rabbitmq.com devtools listing (PR #2662) | https://warrenops.io |
| **QueueLens** | Individual (talaatmagdyx) | **MIT** | Free | Self-hosted web (FastAPI + aio-pika), GHCR image, Helm (experimental), SQLite or PostgreSQL | **v0.19.2 (2026-10-10).** 20 releases from 10-01 to 10-10; repo created 2026-07-10 | 0 stars, 106 GHCR downloads | https://github.com/talaatmagdyx/queuelens |
| **Qarote** | Qarote (CTO Brice Tessier) | Open core: Community Edition mirror under MIT, Enterprise Edition under a private commercial licence | Community free (1 server). Cloud $99/month billed yearly ($1,188/year) or $124 monthly, up to 100 queues per broker, 14-day trial. Self-hosted Enterprise key: price not published | Self-hosted (Compose, Dokku, binary) plus Cloud SaaS | v1.1.0 (2026-04-24, site changelog) / GitHub release v1.2.0 (2026-04-02). **v2.0.0 "Upcoming".** Last push 2026-09-28 | 29 stars; `@qarote/mcp` not on npm | https://qarote.io , https://github.com/getqarote/Qarote |
| **RabbitScout** | Ralve-org | MIT | Free | Self-hosted web (Next.js 16), Docker | v2.0.0 (2026-08-20) | 154★, 4.77K GHCR downloads | https://github.com/Ralve-org/RabbitScout |
| **RabbitLens** | huynhanx03 | Apache-2.0 | Free | Static single-page app plus an nginx `/api` proxy (Docker) | v1.1.0 (2026-09-02) | 91★ / 81 forks (an unusually high fork ratio) | https://github.com/huynhanx03/RabbitLens |
| **mq-studio** | amigoer | Apache-2.0 | Free | Desktop (Wails 3 / Go), 15+ brokers | v0.3.0 (2026-10-03) | 89★ | https://github.com/amigoer/mq-studio |
| **mqx** | Max2535 | MIT | Free | CLI and terminal UI (Go) for Kafka and RabbitMQ | v0.4.0 (2026-10-11) | 4★ | https://github.com/Max2535/mqx |
| **amazon-mq/mcp-server-rabbitmq** | AWS (amazon-mq org) | Apache-2.0 | Free | MCP server (Python; stdio or HTTP) | v4.0.0 (2026-07-28) | 42★; about 950 PyPI downloads in the last week (pypistats figures are internally inconsistent) | https://github.com/amazon-mq/mcp-server-rabbitmq |
| **CloudAMQP console** | 84codes | SaaS | Bundled with CloudAMQP plans | Hosted; only for CloudAMQP instances | Continuous | n/a | https://www.cloudamqp.com/docs/ |
| **LavinMQ UI** | 84codes | Apache-2.0 (the broker) | Free | Built into the LavinMQ broker (not RabbitMQ) | v2.10.2 (2026-10-07) | 1,031★ | https://lavinmq.com |
| **Official management UI** | RabbitMQ team (Broadcom) | MPL-2.0 | Free | Broker plugin, one UI per cluster | 4.3.6 | — | https://www.rabbitmq.com/docs/management |
| **Tanzu RabbitMQ** | Broadcom | Commercial | Commercial | Broker | — | — | https://www.rabbitmq.com/commercial-features |

**Long tail.** Each of these has 16 stars or fewer and was created in 2026:
- tbunny (Go terminal UI, 12★)
- easyqueue (Electron, 16★)
- dlq_inspector (Go CLI, 8★)
- queuepeek (Rust terminal UI, 4★)
- TurkNet RabbitMQ-UI (4★)
- messaging-explorer (3★)
- erebus (2★)
- rabbit-wrangler (2★)
- rabbit-studio (created 2026-10-10, 1★)
- eventore (1★)

**Not RabbitMQ message tools:**
- **Kadeck:** Kafka and Kinesis.
- **Conduktor:** only a "kafka-vs-rabbitmq" glossary page.
- **Lenses, Kpow:** no RabbitMQ found.
- **Datadog:** metrics plus Data Streams Monitoring pipelines, with no payload browsing.
- **Grafana:** official dashboards plus a stale community "Rabbitmq streaming datasource plugin" v1.0.0 (2024-09-13).
- **Flower:** uses the management API only for queue lengths.

---

## 3. Capability coverage

**Legend:** Y = yes, P = partial, T = only in a paid or unreleased tier, – = no, ? = undocumented.

| Product | Browse/peek (mechanism; documented side effects) | Streams | DLQ grouping and redrive (confirms, throttle) | Admin CRUD (users, policies, connections, shovels) | Metric history and alerts | Diagnostics / linting | Team (RBAC, SSO, audit, masking, approvals) | MCP / AI | Desktop + web | Multi-cluster |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| HZN Queue Console | **P:** first N messages (default 100) through the management API; search over AMQP since 1.0.4, after an admitted bug that destroyed quorum-queue messages; side effects not documented | ? (its "Stream view" is a layout, not RabbitMQ streams) | **P:** route back to the `x-death` source queue, bulk, edit payload or headers, x-death stripped automatically; confirms and throttle not documented | – (topology graph, monitoring) | **P:** live monitoring; no alerts | AsyncAPI 2.x/3.x validation; traffic recording that generates a spec (beta) | – (the Team plan is just a bundle of seats) | – | Desktop; web "Q4 2026" | Y (also ActiveMQ Classic and Artemis) |
| Queue Studio | **Y:** streams by offset or time; classic queues up to 65,535 held then returned in original order; quorum queues up to 5,000 through HTTP `/get`, claimed "never counts" (true only on 4.3+) | Y | **P:** move with publisher confirms (acknowledge only after the confirm), back to the origin queue; delete or edit one message mid-queue (refused on quorum queues when over the limit); no grouping or throttle | **P:** policies CRUD plus effective policy, including operator policies | – | – | – (collects no data) | – | IDE only | Y; SSH bastion |
| QueueExplorer 5 | **Y:** consumes and holds messages unacknowledged, returned when the read session closes; exclusive mode; filters, custom JSON/XPath/regex columns | Y (offset paging) | **P:** move, copy, edit, replay, delete; no grouping | **P (Pro):** export, import, copy, compare and synchronise definitions | – | – | – | – | Desktop | Y |
| RabbitMQ Assistant | P (receive messages) | ? | – | **P:** exchanges, queues, users, permissions | P (auto-refreshing dashboard) | – | – | – | Desktop | Y |
| RMQ | P (message viewing; mechanism undocumented) | ? | – | **Y:** exchanges, queues, bindings, policies, users, vhosts | P (live dashboards) | – | – (API transcript only) | – | macOS only | Y; SSH |
| Warren | **Y:** management API reads; "LIMIT" tag and a confirmation before reading risky quorum queues; each message's remaining delivery budget shown | – | **Y:** groups failures across all DLQs by reason, exception, queue or routing key; decodes Spring and MassTransit failure headers; confirms, throttle, dry run that freezes the message set, canary, outcome checks at 5 min/30 min/2 h/1 day, park, 7-day undo, edit before replay, replay rules (Team+) | – (by design it never changes broker configuration) | **Y/T:** history of 1 h / 7 days / 90 days; alerts to Slack, Teams, PagerDuty, Opsgenie, e-mail or webhook, and Prometheus, only in Team/Pro (unreleased) | **P:** set-up checks (queues that lose dead letters, exchanges into nowhere, quorum DLQ limits) | **P/T:** audit log and masking in every edition; roles from Team; OIDC, four-eyes approval and SIEM forwarding in Pro | – | Web only | T (Team: 3 brokers; Pro: unlimited) |
| QueueLens | **Y:** `basic_get` + nack; refuses quorum queues that have a limit; reads quorum queues whole (up to 5,000 messages / 64 MiB) to keep their order | – | **Y:** publish before acknowledging, with confirms; park; bulk actions with a mandatory dry run; provenance headers; replay policies (experimental). Grouping is P (risk-sorted list, filters) | – (read-only) | **P:** in-app alerts; e-mail, Slack, PagerDuty and webhook marked experimental; Prometheus `/metrics` | P | **Y:** Viewer/Operator/Admin roles, audit of attempt and outcome, masking, type-to-confirm; SSO only behind an authenticating proxy (experimental) | – | Web only | Y |
| Qarote | **P:** v1.x message browsing plus spy (PR #448); v2.0 hides the browser behind firehose tracing | – | – (DLQ alert only) | **P:** queues, exchanges, vhosts, connections | **Y:** 30-day TimescaleDB history; e-mail alerts in Community; Slack and webhooks paid | **Y:** incident rules plus config scan (Community) | **T:** SSO/SAML, RBAC and audit in Cloud or Enterprise | **Y/T:** MCP read tools (v2.0, upcoming); AI Explain paid | Web (self-hosted and SaaS) | P (Community: 1 server) |
| RabbitScout | **P:** HTTP `/get` with `ack_requeue_true`; a code comment admits peeks "count as delivery attempts" | – | – | **P:** queues, exchanges, bindings; close connections | P (broker samples, up to 24 h) | – | – (passes through the user's broker login) | – | Web | – |
| RabbitLens | **P:** HTTP `/get` with `ack_requeue_true`, plus a snapshot warning | P | – | **Y:** users, vhosts, policies, limits, feature flags, definitions, shovels, federation, tracing, top | P | – | – (broker login; navigation adapts to permissions) | – | Web | – |
| mq-studio | P ("browsing requeues what it reads") | ? | – | P | – | – | P (write approvals plus an audit log of agent actions) | **Y:** built-in assistant; MCP read-only by default | Desktop | Y |
| mqx | P (peek) | – | – | P (CLI admin) | – | P (routing dry run; headers exchanges "not simulated") | P (read-only contexts) | **Y:** AI panel plus read-only MCP | CLI / terminal UI | Y |
| amazon-mq MCP | **P:** its "read-only" `get_messages` is HTTP `/get` and also accepts `ack_requeue_false` (consume) | – | P (DLQ "skills") | Y (mutating tools behind a flag) | – | P (health, migration readiness) | P (OAuth on the HTTP transport) | **Y** | MCP | Y |
| CloudAMQP console | Through the hosted management UI | – | – | P (definitions, plugins, configuration) | **Y:** metrics plus alarms to e-mail, webhook, Slack, PagerDuty, Teams, VictorOps, Signl4, OpsGenie | **Y:** Diagnostics (dedicated plans only) | **Y:** SAML, 2FA, audit log | – | SaaS web | Y (its own instances) |
| Official UI (4.3.6) | **P:** "Get messages" defaults to "Nack message requeue true" and is labelled "destructive" | – (Tanzu only) | P (whole-queue move through a shovel) | **Y** | P (short retention, no alerts) | P (health checks, feature flags, deprecations) | P (OAuth2 SSO; broker permissions only; no audit) | – | Web, one UI per cluster | – |
| Tanzu (commercial) | adds a **Stream Browser** | Y | — | Y | — | — | audit logging (on Kubernetes) | — | — | — |

---

## 4. How each tool peeks, and what it costs on each RabbitMQ version

### 4a. Ground truth (source read at tags)

| Version | What the quorum-queue limit counts, and the default | `basic.nack(requeue)` / AMQP 1.0 `released` | `basic.reject(requeue)` / `modified(delivery-failed=true)` | Channel or connection ends with unacked messages | Count header | Count carried into a quorum DLQ? |
| --- | --- | --- | --- | --- | --- | --- |
| **3.13.x** | `delivery_count` +1 on **every** return. A limit applies only if configured. `x-delivery-limit=-1` is accepted unvalidated and **drops on the first return**; the policy key rejects negative values | counts | counts | counts | `x-delivery-count` | not checked |
| **4.0.x–4.2.x** (also the `v4.2.x` branch head on 2026-10-14) | Default **20**, checked against **`acquired_count`**, which every return increments | **counts** | counts | counts | `x-delivery-count` = acquired count (AMQP 0-9-1) | No: only `delivery_count` is copied on enqueue, and the limit uses acquired count. But each peek spends the DLQ's own budget of 20 |
| **4.3.x** | Default 20, checked against **`delivery_count`** (failed deliveries only) on every return | **free** (only acquired count +1) | counts | counts | `x-delivery-count` (failed) + `x-acquired-count` | **Yes** (#16039 plus `maybe_set_msg_delivery_count`): a message that arrives over the limit is dropped or re-dead-lettered on its first return, even a nack. `delayed-retry-type` returned/all delays nacked messages |

**Evidence, in brief:**
- `rabbit_fifo.erl`:
  - @v3.13.7 L1847-1863
  - @v4.0.9 L1894-1905
  - @v4.1.8 L1946-1957
  - @v4.2.9 L1944-1966 and L3097-3112
  - `v4.2.x` branch L1954-1955
  - @v4.3.6 L2348-2398, L2032-2044 and L2424-2440
- `rabbit_channel.erl`:
  - @v4.2.9 L1279-1282 and L1589-1591: nack and reject behave identically.
  - @v4.3.6 L1249-1258 and L1527-1535: nack means requeue; reject means delivery-failed.
- `rabbit_fifo_client.erl` @v4.2.9 L241-252 and @v4.3.6 L246-260.
- `release-notes/4.3.0.md` L230-232 and L351.
- QQ docs trigger table: https://www.rabbitmq.com/docs/quorum-queues
- 4.2 docs, "returned to the back ... if no delivery-limit is set": https://www.rabbitmq.com/docs/4.2/quorum-queues

### 4b. What the competitors actually do

| Tool | Read path for quorum queues | 3.13 | 4.0–4.2 | 4.3+ | Tool's own claim |
| --- | --- | --- | --- | --- | --- |
| Queue Studio | HTTP `/get` (`basic.get`×N plus a nack for each), up to 5,000 | counts | **counts** | free unless over the limit | "never counts toward delivery-limit" |
| Warren | Management API reads; asks first on risky queues | counts (asks) | **counts**, but its docs say it does not | free; asks first for quorum DLQs that have a limit | "RabbitMQ 4 no longer counts a message put back on purpose" |
| QueueLens | `basic_get` + nack; **refuses** quorum queues that have a limit | refused | refused | refused, although nack would be free | "on 4.x even AMQP 1.0 released counts" |
| QueueExplorer | Consumes and holds; returned when the session closes | counts | counts | **counts** (session termination) | "Quorum delivery limits require care" |
| HZN | Management API, then AMQP read with an explicit hand-back since 1.0.4 | counts | counts | free since the 1.0.4 fix | not documented |
| Official UI, RabbitScout, RabbitLens, amazon-mq MCP | HTTP `/get` `ack_requeue_true` | counts | **counts** | free unless over the limit | MCP: "Peek ... without consuming them" |

**Conclusion.** No competitor documents correct semantics across all three behaviour eras. This is the clearest gap that can be verified.

---

## 5. Queue Studio: how it reads quorum queues "without using up the delivery limit"

**What the vendor says:**
- README "Reading messages" table: Quorum — "Up to 5,000 messages over the HTTP API — Marked `redelivered`; does **not** count toward `delivery-limit`".
- Marketplace text: "Peeking a quorum queue never counts toward its delivery-limit ... delete and edit ... are refused when that would push any of them past the limit."
- No version qualifier is given.

**The mechanism (SOURCE).** `POST /api/queues/{vhost}/{q}/get` is handled by `rabbit_mgmt_wm_queue_get` (v4.3.6):
- `do_it` (L50-75) runs `basic_gets(Count, …)` and holds every delivery on a server-side channel.
- `maybe_return` then calls `maybe_reject_or_nack` (L135-146). For `ack_requeue_true` that is `#'basic.nack'{multiple=false, requeue=true}`; for `reject_requeue_*` it is `basic.reject`.
- There is no HTTP route for a side-effect-free quorum-queue peek. The dispatcher at v4.3.6 has only `/queues/:vhost/:queue/get`.

**Answer to "4.3+ only? AMQP 1.0 released? other?":**
- **It is not AMQP 1.0.** The read path is the management HTTP `/get` with `ack_requeue_true`, i.e. `basic.get` plus `basic.nack(requeue)`.
- **The "no budget" claim holds only on 4.3+.**
  - On 4.3+, `basic.nack(requeue)` becomes a plain `requeue`. `return_one` increments only `acquired_count` and compares `delivery_count` with the limit.
  - On 4.0–4.2, nack and reject are both a plain return. `return_one` increments `acquired_count` and discards once `AcquiredCount > DeliveryLimit` (default 20).
  - On 3.13, every return increments `delivery_count`.
- **Caveats even on 4.3:**
  - Messages already over the limit are dropped by the return. This is the typical case for quorum DLQs that inherit counts.
  - `delayed-retry-type: returned` or `all` delays nacked messages.
  - If the HTTP handler's channel dies mid-request, that is a channel termination with pending messages, which counts.
- **Why server-side HTTP `/get` is still a good transport on 4.3** (INFERENCE): the hold-and-return happens inside one request, so an IDE crash cannot turn into a connection-loss return. HZN's 1.0.4 bug was exactly that failure.

---

## 7. Effective policy: precise rules (SOURCE v4.3.6 unless noted)

**Step 1. Merge the operator policy with the user policy.** This happens in `rabbit_policy:get0` and `rabbit_policies:merge_policy_value` (L218-245).

| Key | Merged value |
| --- | --- |
| message-ttl, max-length, max-length-bytes, max-in-memory-length/bytes, expires | minimum of the two |
| delivery-limit | if either is negative, the larger one; otherwise the minimum |
| overflow, queue-version, booleans | operator policy value |
| target-group-size | greater value (docs) |

**Step 2. Resolve the merged policy value against the client x-argument.** This happens in `rabbit_queue_type_util:args_policy_lookup` with a resolver that depends on the key and the queue type:

| Queue type | min(policy, arg) | Argument wins | Policy wins |
| --- | --- | --- | --- |
| Classic (`rabbit_amqqueue_process` L486-502) | expires, message-ttl, max-length, max-length-bytes | dead-letter-exchange, dead-letter-routing-key, **overflow** | — |
| Quorum (`rabbit_quorum_queue` L424-445, L1968-1985, L2014-2016, L2069-2074) | max-length, max-length-bytes, message-ttl, expires (**the policy wins on 3.13.7**, L316), consumer-disconnected-timeout, delayed-retry-min/max; delivery-limit (with the negative-value rule) | dead-letter-exchange, dead-letter-routing-key, dead-letter-strategy | **overflow**, delayed-retry-type |
| Stream (`rabbit_stream_queue` L200-201, L1253-1258) | — | — | max-length-bytes, max-age, stream-max-segment-size-bytes, stream-filter-size-bytes, initial-cluster-size |

**How this compares with the docs:**
- The policies guide (L863-869) says client arguments take precedence over user policies, with stream settings and quorum overflow as exceptions, and that operator policies override both. That matches the argument-wins keys.
- It does **not** match the numeric limits, where the code takes the minimum. The maxlength guide's "the minimum of the two values specified is used" is the accurate rule.
- For classic queues, a client `x-overflow` argument beats an operator-policy `overflow` in code (source-read, untested).
- The management API's `effective_policy_definition` (L71-93) is the merged user and operator policy only. It is **not** the effective queue setting.

---

## 8. Is the lane open? Verdict: **open, but contested at every edge and closing fast**

**Coverage by pillar (verified):**

| Pillar | Who covers it | What they lack |
| --- | --- | --- |
| **Developer IDE** | HZN, Queue Studio, QueueExplorer, RMQ, RabbitMQ Assistant | All closed source. The only open option, mq-studio, is generic across brokers and requeues what it reads. |
| **Full admin** | Official UI, RabbitLens, RMQ, amazon-mq MCP | No safe message work and no team layer. |
| **Ops/SRE** | Qarote (open core), Warren Team/Pro (closed, unreleased), CloudAMQP (SaaS only), QueueLens (partial) | — |
| **Team-grade self-hosted web** | Warren (closed; roles, OIDC and approvals unreleased), QueueLens (MIT but DLQ-only, 0★), Qarote (team features paid, Cloud) | — |

No product covers three of the four pillars. None ships desktop and team web from one codebase: HZN's web licence is "Q4 2026" and Warren and QueueLens are web-only. None that has team features is fully open source except QueueLens, which is narrow.

**Threats:**
1. The RabbitMQ core team's next-gen UI. TypeScript prototypes were shown 2026-09-23, but Klishin says "will most likely ship later, and take a long time to evaluate". A per-cluster broker UI is unlikely to add team RBAC or audit, multi-cluster, desktop or DLQ operations (INFERENCE).
2. Fast solo vendors whose release cadence suggests AI-accelerated development: Warren made 10 minor releases in 9 days, QueueLens 20 releases in 10 days.
3. HZN's web edition in Q4 2026.
4. Warren's Team/Pro launch.

**What wins the lane** (INFERENCE): the most correct product, because semantics are verified per version; the broadest, with admin, messages, ops and team in one; and the freest, with team features at no cost and no telemetry or licence server.

---

## 9. Table stakes in 2026

The test: shipped by at least three competitors, or explicitly expected by the incumbents' users.

1. Multiple connections and clusters with environment tags and colours, and quick switching (HZN, QueueExplorer, Queue Studio, RMQ, QueueLens, mq-studio).
2. Queue, exchange and binding list and CRUD; purge and delete behind type-to-confirm; bulk actions; Cmd/Ctrl-K palette; dark mode.
3. Message browser:
   - JSON tree and table views, headers and properties, binary/base64/hex and gzip handling;
   - search and filter over loaded bodies and headers;
   - columns extracted from payloads (HZN, QueueExplorer Pro);
   - export.
4. **Explicit side-effect disclosure for peeks** (the redelivered flag and delivery counts). Every serious tool now says something, though most get the details wrong.
5. Publish with properties and headers, a Monaco-class editor, history and templates.
6. DLQ basics:
   - `x-death` parsing shown as a timeline;
   - replay or move to the original queue or route **with publisher confirms, acknowledging only after the confirm**;
   - throttling;
   - x-death stripped on replay;
   - park queue;
   - dry run for bulk actions.

   Shipped by Warren, QueueLens, Queue Studio, HZN.
7. Live spy through an exclusive temporary queue that copies the target's bindings, with the default-exchange blind spot disclosed (Queue Studio, HZN, Qarote).
8. Routing and topology graph including DLX edges (Queue Studio, HZN, RabbitMQ Assistant, QueueLens).
9. Stream reading by offset and timestamp (Queue Studio, QueueExplorer, rabtap).
10. Effective-policy view (Queue Studio).
11. Live metrics charts from the management API.
12. Credentials kept in the OS keychain or encrypted; no telemetry or no-telemetry pledges (Queue Studio, HZN, Warren, mq-studio); SSH bastion (Queue Studio, RMQ).
13. For team web tools:
    - viewer/operator/admin RBAC;
    - an audit log with attempt and outcome;
    - PII masking;
    - alerts to Slack, PagerDuty, Teams and webhooks;
    - Prometheus `/metrics`;
    - OIDC;
    - Helm and multi-arch images;
    - PostgreSQL option.

    Shipped by Warren, QueueLens and Qarote, partly in paid tiers.
14. A read-only-by-default MCP server or AI assistant (amazon-mq MCP, mq-studio, mqx, Qarote).

---

## 10. The 10 strongest differentiation opportunities (given the verified landscape)

1. **Verified, version-aware message safety, with a public conformance suite.** Section 4 shows that every competitor is wrong for at least one RabbitMQ era. Ship the 3.13 / 4.0–4.2 / 4.3+ semantics as data, back them with CI tests against real brokers, and publish the matrix. Add peek preflight and per-message budgets, plus a "rescue instead of return" action for over-limit messages.
2. **A 100% free, open-source team server:** OIDC, RBAC that separates peek from consume, purge and replay, attempt-and-outcome audit, four-eyes approvals and masking. Warren's roles, OIDC and approvals are unreleased and closed. Qarote charges for SSO, RBAC and audit. QueueLens is DLQ-only.
3. **One engine and one UI in three delivery modes** (Electron desktop, local web, team server). No competitor ships this; HZN's web edition is "Q4 2026" and needs a custom licence.
4. **Admin and message operations in one product, beyond the management UI.** Users, topic permissions, limits, user and operator policies, shovels and federation, feature flags and deprecations, definitions. Warren refuses admin by design, RabbitLens has admin without safe message work or a team layer, admin items are still on its roadmap.
5. **A correct effective-configuration debugger.** Use the per-key and per-version resolver tables in section 7, show where each value comes from, and simulate "what if this policy changes". Queue Studio's lives only inside the IDE.
6. **A DLQ operations centre with multi-framework failure decoding.** Decode Spring and MassTransit (Warren's set) plus NServiceBus, EasyNetQ, Celery and Symfony/Laravel envelopes. Group failures across queues. Use throttled replay with confirms, canaries, outcome tracking and undo, all open source.
7. **An open-source stream browser with server-side filtering.** Support AMQP 1.0 property filters (4.1+) and SQL filters (4.2+), offset and timestamp seeks, super-stream partitions and consumer offsets. Today only Tanzu (commercial) has a stream browser; QueueExplorer and Queue Studio only page by offset.
8. **A routing simulator** that handles headers exchanges, exchange-to-exchange bindings, alternate exchanges and DLX (mqx skips headers; Queue Studio's version is IDE-only). Pair it with **topology-as-code diff and drift detection** against Git, Terraform and Messaging Topology Operator resources; QueueExplorer Pro's compare/sync is paid and desktop-only.
9. **Governed MCP and AI** on the same action layer, so RBAC, approvals, audit and masking apply, and peeks count as mutations. The amazon-mq "read-only" `get_messages` can consume messages, and Qarote's AI is paid.
10. **Prometheus-first history and alerts with a lint and upgrade advisor**, open source, for desktop and web. Encode the verified hazards:
    - quorum DLQs with the default limit;
    - `-1` on 3.13;
    - no DLX;
    - delayed-retry interplay with peeks;
    - 4.3/4.4 removals and deprecations.

    CloudAMQP's Diagnostics is SaaS-only, Qarote's config scan is open core, and Warren's checks are closed.

AMQPS taps (HZN's Spy Mode lacks TLS); and distribution through the rabbitmq.com devtools listing (Warren's PR was merged within one day), winget, Homebrew and Flatpak.

---

## 11. Corrections to the prior corpus

- QueueLens and HZN "have no findable URLs": **wrong** (section 1).
- Warren Community has "1 hour of audit history": **imprecise**. The audit log is included; "the last hour" is history; there are no roles in Community.
- Queue Studio price "not retrievable": it is **from $4/month** with a 30-day trial and 82 downloads.
- Qarote: **open core with a private EE repo**; e-mail alerts are in Community; v2.0 hides the message browser.
- "From 4.3 the limit counts failed deliveries; before 4.3 every acquisition": **confirmed** at the tags above. Competitors' docs (Warren, Queue Studio) contradict it.
- The effective value is 500 by `min`.
- The official next-gen UI is **confirmed as prototypes only**, with no ship date.

## Design implications

- Build a data-driven BrokerSemantics registry in the engine, keyed by broker version range, queue type and distribution (OSS, Tanzu, Amazon MQ, CloudAMQP). Fields:
- limitBasis: none-unless-set (3.13), acquired_count (4.0-4.2), delivery_count-failed-only (4.3+);
- defaultLimit: none (3.13), 20 (4.0+);
- negativeLimitMeaning: drop-on-first-return for the 3.13 x-arg, unlimited from 4.0;
- headerSemantics: on 4.0-4.2 x-delivery-count equals the acquired count; on 4.3 the failed count is in x-delivery-count and the acquired count in x-acquired-count;
- countCarriedOnDeadLetter: 4.3;
- delayedRetry: 4.3.
Seed it from the cited tags (3.13.7, 4.0.9, 4.1.8, 4.2.9, 4.3.6). Gate every peek, move, edit and tap through it. Detect the version from GET /api/overview. Treat unknown versions and commercial 4.2.10+ builds conservatively, as 4.0-4.2.
- Add a peek planner that runs before any quorum-queue read. It computes the effective delivery-limit (from the x-argument plus the merged policy) and the delayed-retry config, then applies these rules:
- **4.0-4.2:** show each message's remaining budget (limit minus x-delivery-count) and refuse, or require confirmation, before any return that would exhaust it.
- **4.3+:** return with basic.nack or AMQP 1.0 released. Never return a message whose x-delivery-count already exceeds the limit, because the return drops it; offer 'rescue' instead (publish a copy with confirm, then ack).
- **3.13:** refuse peeks when x-delivery-limit=-1.
Always show the plan, for example '37 messages will spend 1 of 20 deliveries; 3 would be dropped'.
- Enforce settle discipline in the engine for every queue type:
- Settle peeks only with explicit basic.nack(requeue=true, multiple=false), or AMQP 1.0 released on 4.3+. Never basic.reject or modified(delivery-failed=true).
- Never rely on channel or connection close to return messages: on 4.3 that counts as a failed delivery. HZN shipped exactly this bug, and QueueExplorer returns messages by session close.
- Keep hold windows short and batches capped, and add a shutdown hook in the Electron utilityProcess and the server that settles before closing.
- On 4.3+ quorum queues, offer server-side HTTP /get with ack_requeue_true in small capped batches. The hold-and-nack then happens inside one broker-side request, so a client or browser crash cannot cause a counted 'connection loss' return; Queue Studio takes this route. Keep a hard cap, because large gets have destabilised nodes.
- Implement effective configuration as a pure TypeScript function with resolver tables for each key, queue type and version (section 7):
- **Classic:** minimum for limits and TTLs; the argument wins for DLX, DLRK and overflow.
- **Quorum:** minimum for limits and TTLs (on 3.13 the policy wins for expires); the policy wins for overflow and delayed-retry-type; the argument wins for DLX, DLRK and dead-letter-strategy; delivery-limit uses the negative-value rule.
- **Streams:** the policy wins for retention and segment settings.
- **Operator policies:** merge them with the user policy first.
Show where each value came from, for example 'arg 500, policy 1000 → min → 500'. Never present the management API's effective_policy_definition as the effective queue setting.
- Publish a CI-run conformance suite with Testcontainers images for 3.13.7, 4.0.9, 4.1.8, 4.2.9, 4.3.6 and main. It must run:
- every settle path: nack, reject, released, modified with delivery-failed true and false, channel.close, connection drop, basic.cancel with unacked messages;
- dead-letter carry-over;
- delayed-retry;
- the policy resolutions.
Publish the resulting compatibility matrix on the website. It is both QA and the headline differentiator.
- Design the team-server RBAC around operations that RabbitMQ conflates: view metadata; peek, which spends budget; consume/remove; purge; replay/move; publish; topology admin; user admin. Require an operator role or four-eyes approval for peeks on budget-limited quorum queues and for bulk replays. Record audit as an attempt row before the action and an outcome row after it (the QueueLens pattern). Ship SSO (OIDC), audit, approvals and masking in the free OSS build.
- Build the DLQ redrive engine with:
- a dedicated channel and publisher confirms;
- publish-confirm-then-ack;
- a mandatory dry run that freezes message identities;
- throttling and a canary batch;
- re-death outcome tracking;
- removal of x-death, x-delivery-count and x-acquired-count on replay, plus provenance headers;
- an undo store with retention.
Add pluggable failure-envelope decoders for Spring, MassTransit, NServiceBus, EasyNetQ and Celery so failures can be grouped across queues.
- Make the spy and tap better than the incumbents:
- support AMQPS (HZN's Spy Mode cannot);
- give the temporary queue exclusive, auto-delete, x-max-length and x-expires settings;
- disclose the default-exchange blind spot;
- offer firehose and exchange-to-exchange modes with explicit cost and permission warnings.
- Expose MCP through the same policy-enforced action layer, bound to saved profiles and subject to RBAC, approvals, audit, masking and SSRF guards. Classify peek as a mutation, and never offer consume-like ackmodes in read-only mode; amazon-mq's read-only get_messages accepts ack_requeue_false.
- Make trust a feature: no telemetry by default, no licence server, fully offline operation, signed and reproducible builds, and OS-keychain credential storage.
- Distribute aggressively from day one:
- open a PR to the rabbitmq.com devtools 'Visualisation' list (Warren's was merged within one day);
- publish to winget, Homebrew, Flatpak and AppImage, with ARM64 builds;
- provide multi-arch Docker images, a Helm chart and npx local mode.
Consider offering the web UI as an optional broker plugin later, as gmr suggested in issue #2619.
- Use Prometheus as the primary metrics source, with the management API as fallback. Ship lint rules for the verified hazards:
- quorum DLQs with the default 4.3 limit drop messages that arrive over it;
- x-delivery-limit=-1 on 3.13 drops on first return;
- quorum queues without a DLX;
- delayed-retry 'returned' or 'all' slows peeks;
- 4.3 and 4.4 deprecations and removals.
- State the version-support policy explicitly. Test 3.13, 4.0, 4.1, 4.2 and 4.3. Flag 4.2.10/4.2.11, which appear on release-information without public tags, and Tanzu builds as 'semantics unverified'. Re-verify each new minor release against the conformance suite before claiming support.

## Open questions

- All RabbitMQ semantics here come from reading source and docs; none were lab-tested. Run the conformance matrix to confirm:
- on 4.0-4.2, x-delivery-count equals the acquired count on both basic.get and consume paths;
- on 4.3, counts are carried into a quorum DLQ for both at-most-once and at-least-once dead-lettering;
- on 4.3, how channel.close, basic.cancel and graceful connection close behave while messages are unacked;
- on 4.3, delayed-retry 'returned' and 'all' delay messages after a single nack peek;
- on 3.13, x-delivery-limit=-1 drops a message on its first return.
- Commercial-only patch lines: 4.2.10 and 4.2.11 (listed on release-information, not tagged publicly) and Tanzu builds may have backported 4.3 semantics. The public v4.2.x branch head (2026-10-14) still checks acquired_count.
- Does Queue Studio detect broker versions 4.0-4.2 and warn or refuse there? Its docs claim unconditional safety, but the plugin was not run.
- HZN Queue Console:
- What exact RabbitMQ read path does it use after 1.0.4?
- How does Spy Mode and traffic recording capture messages: temporary queues or the firehose?
- Does it support RabbitMQ streams?
- What will the Q4 2026 web edition and the Team plan include (any RBAC or audit)?
- Warren:
- What are the Team/Pro prices and the ship date?
- Is its peek HTTP /get with ack_requeue_true?
- Is the 'count travels' drop reproducible on 4.3 for classic-to-quorum and quorum-to-quorum dead-lettering?
- QueueLens says returned quorum-queue messages go to the back of the queue (measured on 3.13 and 4.1). The 4.2 docs say they go near the head when a delivery-limit is set. Ordering behaviour by version needs a test.
- Does it publish over AMQP or the HTTP API?
- Which licence endpoint does the app itself call?
- What 'usage data and analytics' does ToS 4.2 cover?
- Does the policy debugger mishandle other keys, such as DLX arguments versus policy, or operator policies?
This cannot be settled without running the app, which is out of scope here.
- Can AMQP 1.0 publishers pre-set the delivery-count annotation that quorum queues copy on enqueue (maybe_set_msg_delivery_count)? If so, a publisher could poison messages so they are dropped on their first return. This needs a test and possibly a security report.
- How reliable are the traction signals? Docker and GHCR pull counts include CI and self-pulls. There are no install or active-user figures for HZN, QueueExplorer, RabbitMQ Assistant or and willingness to pay is unknown.
- The RabbitMQ core team's next-gen management UI: what scope (single cluster? RBAC?), what timeline, and will it ship as a plugin? Only prototypes and the statement 'ship later, take a long time to evaluate' are public.
- Which tap, firehose and HTTP /get restrictions apply on managed brokers (Amazon MQ, CloudAMQP)? This was not covered here and limits which peek and spy strategies can be offered.

## Sources

- https://warrenops.io/blog/rabbitmq-dead-letter-tools-compared.html
- https://warrenops.io/
- https://warrenops.io/docs/index.html
- https://warrenops.io/docs/quorum-queues.html
- https://warrenops.io/docs/editions.html
- https://warrenops.io/legal-notice.html
- https://hub.docker.com/v2/repositories/viba88/warren/
- https://hub.docker.com/v2/repositories/viba88/warren/tags?page_size=30
- https://github.com/ViBa88/warren-releases
- https://raw.githubusercontent.com/ViBa88/warren-releases/main/README.md
- https://github.com/orgs/viba88/packages/container/package/warren
- https://github.com/talaatmagdyx/queuelens
- https://raw.githubusercontent.com/talaatmagdyx/queuelens/main/README.md
- https://raw.githubusercontent.com/talaatmagdyx/queuelens/main/docs/SAFETY.md
- https://github.com/talaatmagdyx/queuelens/pkgs/container/queuelens
- https://talaatmagdyx.github.io/queuelens/
- https://hzn-queue-console.app/
- https://hzn-queue-console.app/llms.txt
- https://hzn-queue-console.app/pricing
- https://hzn-queue-console.app/docs/changelog
- https://hzn-queue-console.app/docs/server-connections
- https://hzn-queue-console.app/docs/dead-letter-queues
- https://hzn-queue-console.app/docs/queue-browser
- https://hzn-queue-console.app/docs/spec-editor
- https://hzn-queue-console.app/terms
- https://hzn-queue-console.app/download
- https://hzn-queue-console.app/downloads/latest/manifest.json
- https://saasbrowser.com/en/saas/1606670/hzn-queue-console
- https://github.com/getqarote/Qarote
- https://raw.githubusercontent.com/getqarote/Qarote/main/README.md
- https://raw.githubusercontent.com/getqarote/Qarote/main/LICENSE
- https://raw.githubusercontent.com/getqarote/Qarote/main/CHANGELOG.md
- https://raw.githubusercontent.com/getqarote/Qarote/main/docs/ENTERPRISE_EDITION.md
- https://github.com/getqarote/Qarote/pull/448
- https://qarote.io/
- https://qarote.io/pricing/
- https://qarote.io/changelog/
- https://registry.npmjs.org/@qarote%2Fmcp
- https://github.com/drbenzin/queue-studio-docs
- https://raw.githubusercontent.com/drbenzin/queue-studio-docs/main/README.md
- https://plugins.jetbrains.com/plugin/34454-queue-studio-for-rabbitmq
- https://plugins.jetbrains.com/api/plugins/34454
- https://plugins.jetbrains.com/api/plugins/34454/updates?size=20
- https://plugins.jetbrains.com/api/searchPlugins?max=10&offset=0&search=RabbitMQ
- https://factodus.com/
- https://factodus.com/queue-studio/
- https://www.cogin.com/mq/buy.php
- https://www.cogin.com/mq/download.php
- https://www.cogin.com/mq/qehistory.php
- https://www.cogin.com/mq/professional.php
- https://www.cogin.com/articles/rabbitmq/rabbitmq-gui.php
- https://www.cogin.com/articles/rabbitmq/inspect-rabbitmq-message-contents-without-losing-them.php
- https://www.redisant.com/rta
- https://itunes.apple.com/lookup?id=6755972526&country=us
- https://apps.apple.com/app/id6755972526
- https://github.com/Ralve-org/RabbitScout
- https://raw.githubusercontent.com/Ralve-org/RabbitScout/main/README.md
- https://raw.githubusercontent.com/Ralve-org/RabbitScout/main/components/queues/message-viewer.tsx
- https://github.com/Ralve-org/RabbitScout/pkgs/container/rabbitscout
- https://github.com/huynhanx03/RabbitLens
- https://raw.githubusercontent.com/huynhanx03/RabbitLens/main/README.md
- https://raw.githubusercontent.com/huynhanx03/RabbitLens/main/website/src/features/queues/message-inspector.tsx
- https://github.com/amigoer/mq-studio
- https://raw.githubusercontent.com/amigoer/mq-studio/main/README.md
- https://github.com/Max2535/mqx
- https://raw.githubusercontent.com/Max2535/mqx/main/README.md
- https://github.com/amazon-mq/mcp-server-rabbitmq
- https://raw.githubusercontent.com/amazon-mq/mcp-server-rabbitmq/main/README.md
- https://raw.githubusercontent.com/amazon-mq/mcp-server-rabbitmq/main/src/rabbitmq/admin.py
- https://raw.githubusercontent.com/amazon-mq/mcp-server-rabbitmq/main/src/rabbitmq/module.py
- https://pypi.org/pypi/amq-mcp-server-rabbitmq/json
- https://pypistats.org/api/packages/amq-mcp-server-rabbitmq/recent
- https://www.cloudamqp.com/docs/cloudamqp-diagnostics.html
- https://www.cloudamqp.com/docs/monitoring.html
- https://lavinmq.com/documentation/management-interface-overview
- https://github.com/cloudamqp/lavinmq
- https://github.com/jandelgado/rabtap
- https://github.com/rabbitmq/rabbitmqadmin-ng
- https://github.com/kafbat/kafka-ui
- https://github.com/mher/flower
- https://raw.githubusercontent.com/mher/flower/master/docs/config.rst
- https://www.kadeck.com/
- https://www.conduktor.io/sitemap.xml
- https://lenses.io/
- https://factorhouse.io/products/kpow/
- https://docs.datadoghq.com/integrations/rabbitmq/
- https://docs.datadoghq.com/data_streams/
- https://grafana.com/grafana/plugins/maormil-rabbitmq-datasource/
- https://grafana.com/api/plugins/maormil-rabbitmq-datasource
- https://github.com/HalxDocs/dlq_inspector
- https://github.com/anadale/tbunny
- https://github.com/matutetandil/queuepeek
- https://github.com/sousadiego11/easyqueue
- https://github.com/willemsevenster/rabbit-wrangler
- https://github.com/EdneyMesquita/rabbit-studio
- https://github.com/vijayptiwari/eventore
- https://github.com/Elkhan-Isayev/erebus
- https://github.com/vitorafgomes/messaging-explorer
- https://github.com/TurkNet/RabbitMQ-UI
- https://hn.algolia.com/api/v1/search?query=QueueLens&tags=story
- https://hn.algolia.com/api/v1/search?query=HZN%20Queue%20Console&tags=story
- https://www.rabbitmq.com/docs/policies
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/policies.md
- https://www.rabbitmq.com/docs/maxlength
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/maxlength/index.md
- https://www.rabbitmq.com/docs/quorum-queues
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/quorum-queues/index.md
- https://www.rabbitmq.com/docs/4.2/quorum-queues
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/versioned_docs/version-4.2/quorum-queues/index.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/client-libraries/devtools.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/src/pages/commercial-features.js
- https://www.rabbitmq.com/commercial-features
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_amqqueue_process.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v3.13.7/deps/rabbit/src/rabbit_amqqueue_process.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_quorum_queue.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.9/deps/rabbit/src/rabbit_quorum_queue.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.0.9/deps/rabbit/src/rabbit_quorum_queue.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.0.8/deps/rabbit/src/rabbit_quorum_queue.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v3.13.7/deps/rabbit/src/rabbit_quorum_queue.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_stream_queue.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_policy.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_policies.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v3.13.7/deps/rabbit/src/rabbit_policies.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_queue_type_util.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.0.8/deps/rabbit/src/rabbit_queue_type_util.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v3.13.7/deps/rabbit/src/rabbit_amqqueue.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/src/rabbit_mgmt_wm_queue_get.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/src/rabbit_mgmt_dispatcher.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/priv/www/js/tmpl/classic-queue-get-message.ejs
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/priv/www/js/tmpl/queue.ejs
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_channel.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.9/deps/rabbit/src/rabbit_channel.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.0.9/deps/rabbit/src/rabbit_channel.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v3.13.7/deps/rabbit/src/rabbit_fifo.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.0.9/deps/rabbit/src/rabbit_fifo.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.1.8/deps/rabbit/src/rabbit_fifo.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.9/deps/rabbit/src/rabbit_fifo.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.x/deps/rabbit/src/rabbit_fifo.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.0/deps/rabbit/src/rabbit_fifo.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_fifo.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.9/deps/rabbit/src/rabbit_fifo_client.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_fifo_client.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/release-notes/4.3.0.md
- https://api.github.com/repos/rabbitmq/rabbitmq-server/tags?per_page=40
- https://api.github.com/repos/rabbitmq/rabbitmq-server/git/ref/tags/v4.2.10
- https://api.github.com/repos/rabbitmq/rabbitmq-server/commits?sha=v4.2.x&per_page=3
- https://github.com/rabbitmq/rabbitmq-server/issues/2619
- https://github.com/rabbitmq/rabbitmq-server/issues/17533
- https://github.com/rabbitmq/rabbitmq-server/pull/17760
- https://github.com/rabbitmq/rabbitmq-website/pull/2662
- https://github.com/rabbitmq/rabbitmq-website/pull/2410
