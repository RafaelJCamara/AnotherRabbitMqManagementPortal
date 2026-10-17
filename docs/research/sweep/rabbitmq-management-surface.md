# Official RabbitMQ management surface (UI, HTTP API, CLI, metrics)

> **Pre-verification research (2026-10-16).** Where this conflicts with [`docs/research/fact-sheet.md`](../fact-sheet.md), the fact sheet wins. Content about a specific third-party product was removed under the docs policy ([ADR-034](../../adr/ADR-034-docs-policy.md)).

_Research angle `rabbitmq-management-surface` · 2026-10-16_

## Executive summary

State on 2026-10-16: the latest GA release is RabbitMQ 4.3.6 (2026-09-14). The 4.2.x line still gets patches (4.2.9, 2026-07-20). 4.4.0 and 5.0.0 exist only as alpha builds. Since 4.3, Khepri is the only metadata store.

The open-source management UI is an older single-page app (Sammy.js, EJS templates, jQuery) built on the HTTP API. It covers create/read/update/delete and admin work broadly, but it is weak at working with messages:
- "Get messages" is labelled a destructive action and works by fetching and then requeueing. It is turned off for streams.
- There is no message search, export or filtering, no bulk actions, no dead-letter re-drive, no topology graph, no multi-cluster view and no audit trail.
- Access control is coarse: four user tags plus per-vhost regex permissions.
- Unless `management.credential_encryption_secret` is set, the UI keeps Base64 `user:password` in localStorage.

The core team said in September 2026 that the first step is to modernise the UI code without visible changes. A completely new UI will ship later and take a long time to evaluate. Meanwhile the commercial Tanzu edition is closing gaps that open-source users do not get: a Stream Browser, a Linter, a JMS queue browser and AMQP over WebSocket.

The HTTP API (about 130 routes) is the backbone. It supports pagination (default 100, max 500 per page), `columns=`, `disable_stats` and `enable_queue_totals`. It also covers quorum-queue replica operations and Raft status, queue rebalancing, health checks, definitions export/import, and feature-flag / deprecated-feature reporting. There is no official schema or OpenAPI spec (issue #2622 is still open).

The built-in metrics collection has been deprecated since 2021 but is still on by default in the 4.3.x and 4.4.x code. Prometheus is the recommended path. Turning stats off removes data from the API, and the amount removed depends on the version. So the tool needs its own metrics layer: the management stats, a Prometheus scraper, PromQL, or its own sampling.

Real message work needs native protocol clients. The HTTP get and publish endpoints are documented for development use only. Quorum queues drop or dead-letter a message after 20 failed deliveries by default. Before 4.3, requeue-based peeks also count toward that limit.

Several operations are CLI-only with no HTTP route: quorum-queue peek, stream replica operations, maintenance drain/revive, plugin enable/disable, cluster membership and log tailing. The AMQP 1.0 `/management` node only covers queues, exchanges and bindings.

A web version needs a backend: browsers cannot speak AMQP to open-source RabbitMQ, and CORS is closed by default.

## Report

# The official RabbitMQ 4.x management surface (research as of 2026-10-16)

**How this was researched and its limits.** I used primary sources only:
- rabbitmq.com docs (they are versioned 4.3)
- release notes in `rabbitmq/rabbitmq-server/release-notes/`
- source code on the v4.0.x, v4.1.x, v4.2.x, v4.3.x, v4.4.x and main branches
- GitHub issues and PRs
- Broadcom Tanzu techdocs

The shared WebSearch budget ran out early, so the rest of the work used direct fetches. GitHub Discussions could not be searched and StackOverflow could not be fetched, so evidence of user complaints comes only from GitHub issues. Code was read through a summarising fetcher. I quote code only where I asked for verbatim excerpts.

---

## 0. Version landscape

| Line | Status | Management-relevant changes |
| --- | --- | --- |
| 4.0.x | last tag v4.0.9 | AMQP 1.0 becomes a core protocol and clients can manage topology over it. Quorum-queue default delivery-limit set to 20. Classic mirrored queues removed. New Prometheus metrics: per-queue and per-exchange, memory breakdown, shovel and federation ([4.0.1 RN](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.0.1.md)) |
| 4.1.x | v4.1.8 | Dark theme (#13545). AMQP 1.0 session and link details on connection pages. Feature-flag page shows migration and experimental status, and flags enable asynchronously. New health checks for quorum queues without an elected leader. Separate HTTP auth backends via `http_dispatch.auth_backends` (#13465). `/api/aliveness-test` became a no-op. rabbitmqadmin v2 introduced ([4.1.0 RN](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.1.0.md)) |
| 4.2.x | v4.2.9 (2026-07-20) | Khepri is the default for new clusters. `protected` user tag. Local shovels. SQL filter expressions for streams. Ra/Raft Prometheus metrics renamed, which breaks dashboards. `rabbitmq-diagnostics message_size_stats` ([4.2.0 RN](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.2.0.md)) |
| 4.3.x | 4.3.0 (2026-04-23) to 4.3.6 (2026-09-14) | Khepri only (Mnesia and partition strategies removed). Quorum queues get 32 strict priorities, delayed retry, per-queue consumer timeouts, and unlimited explicit returns. `GET /api/auth` removed (#16083). `GET /api/users/{u}/queues` added. Fixes for what disappears when stats are disabled. `management.tcp/ssl.max_connections` (4.3.1). CORS hardening (4.3.2). Definitions export is streamed (4.3.3). ETag on definitions export (4.3.5). Channels pages work with stats off (4.3.6) ([4.3.0 RN](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.3.0.md), [4.3.1](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.3.1.md)–[4.3.6](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.3.6.md)) |
| 4.4.0 / 5.0.0 | alpha builds only, published 2026-10-13 to 16 ([server-packages](https://github.com/rabbitmq/server-packages/releases)) | Draft 4.4 notes: `GET /api/init`, quorum-queue delayed delivery via `x-opt-delivery-time`, status of blocked consumers in the API ([4.4.0 draft](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.4.0.md)). Draft 5.0 notes: the `rabbitmq_amqp1_0` plugin is removed |

GA tags were checked via the [tags API](https://api.github.com/repos/rabbitmq/rabbitmq-server/tags?per_page=60) and the [releases page](https://github.com/rabbitmq/rabbitmq-server/releases).

---

## 1. Management UI: what exists (FACT)

**Technology.** The UI is a single-page app (Sammy.js, EJS templates, jQuery) that "relies on the HTTP API" ([docs](https://www.rabbitmq.com/docs/management), [#2619](https://github.com/rabbitmq/rabbitmq-server/issues/2619)).

**Navigation and required user tags** ([global.js](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/priv/www/js/global.js)):
- Top-level tabs, available to the `management` tag: Overview, Connections, Channels, Exchanges, **Queues and Streams**.
- Admin pages for `administrator`: Users, Virtual Hosts, Feature Flags, Deprecated Features, Cluster.
- Admin pages for `management`: Policies, Limits.

**Pages added by plugins:**
- **shovel_management**: Shovel Status (`monitoring`), Shovel Management (`policymaker`), and the queue-page action "Move messages". Move messages creates a temporary shovel with `src-delete-after=queue-length` and prefetch 1000 ([shovel.js](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_shovel_management/priv/www/js/shovel.js), [queue.ejs](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/priv/www/js/tmpl/queue.ejs)).
- **federation_management**: Federation Status, Federation Upstreams ([federation.js](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_federation_management/priv/www/js/federation.js)).
- **stream_management**: Stream Connections, Super Streams (create), and stream publishers shown on the queue page ([stream.js](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_stream_management/priv/www/js/stream.js)).
- **rabbitmq_top**: Top Processes and Top ETS Tables (administrator) ([top.js](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_top/priv/www/js/top.js)).
- **rabbitmq_tracing**: Tracing (administrator), which writes trace files on the node ([tracing.js](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_tracing/priv/www/js/tracing.js)).

**Page contents.** Source: [dispatcher.js](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/priv/www/js/dispatcher.js) and the templates.
- **Overview:** totals, rates, nodes, churn, listeners, and definitions export/import.
- **Node:** overview, process stats, persistence and I/O stats, churn, cluster links, memory details, binary references, advanced (GC, plugins), applications, exchange types, auth mechanisms ([node.ejs](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/priv/www/js/tmpl/node.ejs)).
- **Connection:** close with a reason. AMQP 1.0 sessions and links since 4.1. Peer certificate serial since 4.3.1.
- **Queue:** one template per queue type (classic, quorum, stream). Actions: get messages, publish, move messages, delete, purge. Bindings and consumers.
  - Quorum queues show members and leader. Since 4.3 they also show per-priority counts, delayed-retry settings and consumer-timeout state.
  - Streams show the oldest message timestamp (4.3.2).
- **Queue list:** column chooser (including `msgs-delayed`, 4.3.2), regex name filter, server-side pagination.
- **Vhost form:** description, tags, default queue type ([vhosts.ejs](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/priv/www/js/tmpl/vhosts.ejs)).
- **Other actions:** enable feature flags, restart a vhost on a node, reset stats, rename the cluster, and manage limits, permissions, topic permissions, policies and operator policies.
- **Refresh interval:** 5s, 10s, 30s or off. Theme: dark, light or auto ([layout.ejs](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/priv/www/js/tmpl/layout.ejs)).

**User tags** ([management docs](https://www.rabbitmq.com/docs/management)):
- `management`: own connections and channels, objects in vhosts the user can access.
- `policymaker`: adds policies and parameters.
- `monitoring`: adds all vhosts, other users' connections, node data.
- `administrator`: adds vhosts, users, permissions, closing other users' connections.
- "Normal RabbitMQ permissions to resources still apply."
- Since 4.2.x/4.3 a `protected` tag blocks updating or deleting that user through the HTTP API ([#14545](https://github.com/rabbitmq/rabbitmq-server/pull/14545)).

## 2. What the UI cannot do, or does poorly

| Area | Evidence (FACT) | Opportunity |
| --- | --- | --- |
| Message browsing | The Get messages form warns "getting messages from a queue is a destructive action". Ack modes: Nack requeue true / Automatic ack / Reject requeue true / Reject requeue false. Defaults: count 1, truncate 50000 ([template](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/priv/www/js/tmpl/classic-queue-get-message.ejs)) | Safe, explicit peek. Batch browsing |
| Streams | `stream: actions {get_message:false, purge:false}` ([global.js](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/priv/www/js/global.js)). No way to browse a stream in open-source RabbitMQ. Tanzu-only Stream Browser exists ([Tanzu doc](https://techdocs.broadcom.com/us/en/vmware-tanzu/data-solutions/tanzu-rabbitmq-oci/4-3/tanzu-rabbitmq-oci-image/site-stream-browser.html)) | Stream browser for open-source users |
| Search, filter, export of payloads | No routes for any of these (dispatcher.js) | JSON/header search, CSV/JSON export |
| Bulk operations | No multi-select in the UI. The only bulk API endpoint is `POST /api/users/bulk-delete`. rabbitmqadmin v2 added `queues delete_multiple --name-pattern` in 2026 ([CHANGELOG](https://raw.githubusercontent.com/rabbitmq/rabbitmqadmin-ng/main/CHANGELOG.md)), which shows demand | Bulk actions with dry-run |
| Dead-letter handling | Only "Move messages", which moves everything through a shovel and needs `policymaker`. No inspection of `x-death`, no selective re-drive | Dead-letter workbench |
| Topology | No graph view | Routing graph |
| Multi-cluster | One UI per cluster | Workspaces with profiles |
| RBAC | Four tags plus regex permissions. `queue.purge` needs only **read** permission ([access-control](https://www.rabbitmq.com/docs/access-control)) | Finer-grained role layer in the tool |
| Audit | "RabbitMQ nodes do not log any HTTP API requests by default" (`management.http_log_dir`) ([docs](https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/management/index.md)). No history of UI actions | Audit log, plus consuming the event exchange |
| Scale | 3.13 notes: an unfiltered, unpaginated `GET /api/queues` "can produce enormously large responses". Monitoring docs warn that "very frequent polling" hurts the broker and recommend 30–60s intervals in production ([monitoring](https://www.rabbitmq.com/docs/monitoring), [3.13 RN](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/3.13.0.md)) | Adaptive polling, local search index |
| Credentials | The UI stores "the Base64-encoded username:password" in localStorage unless the encryption secret is set ([docs](https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/management/index.md)) | OS keychain or a vault |
| Stats disabled | Charts and detailed stats are hidden. Before 4.3, policy and `delivery_limit` fields disappeared ([#15182](https://github.com/rabbitmq/rabbitmq-server/issues/15182), fixed by #15651). Channels endpoints returned 400 until 4.3.6 | Degrade gracefully |
| Recent bugs | Queue-type change resets the declare form (#15015). Two consumers shown active under single-active-consumer (#13045). AMQP 1.0 filters not shown (#13429). Quorum-queue stats show "???" after a 3.13→4.3 upgrade (#16974). OIDC tokens too large cause 431 (#13761) ([issue search](https://api.github.com/search/issues?q=repo:rabbitmq/rabbitmq-server+is:issue+%22management%22+in:title+created:%3E2024-01-01&sort=comments&order=desc&per_page=50)) | Polish |

## 3. HTTP API inventory

All paths below are under `/api`. Source: [rabbit_mgmt_dispatcher.erl on main](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/src/rabbit_mgmt_dispatcher.erl), cross-checked against the v4.0.x through v4.3.x branches.

- **Cluster:**
  - `overview`, `cluster-name` (GET/PUT), `nodes`, `nodes/{n}` (`?memory=true&binary=true`)
  - `nodes/{n}/memory[/relative]`, `nodes/{n}/memory/ets[/{filter}][/relative]`
  - `extensions`, `whoami`
  - `version`: needs no authentication and returns the product version ([handler](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.x/deps/rabbitmq_management/src/rabbit_mgmt_wm_version.erl))
  - `config/effective`: administrator only, plain-text Erlang terms of `rabbit:environment()`. The handler shows no redaction ([handler](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.x/deps/rabbitmq_management/src/rabbit_mgmt_wm_environment.erl)).
- **Definitions:** `definitions`, `definitions/{vhost}`, alias `all-configuration`, GET and POST. Import merges with existing state. The request body limit is 20 MiB. Export includes password hashes.
- **Parameters and policies:** `parameters[/{component}[/{vhost}[/{name}]]]`, `global-parameters[/{name}]`, `policies[...]`, `operator-policies[...]`.
- **Limits:** `vhost-limits[...]` (max-connections, max-queues), `user-limits[...]` (max-connections, max-channels).
- **Connections and channels:**
  - `connections`, `connections/{c}` (DELETE accepts an `X-Reason` header)
  - `connections/username/{u}` (GET/DELETE)
  - `connections/{c}/channels`, `connections/{c}/sessions` (4.1+)
  - `channels[/{ch}]`, `vhosts/{v}/connections`, `vhosts/{v}/channels`
  - `consumers[/{vhost}]`
- **Exchanges:** `exchanges[...]` (DELETE accepts `if-unused`), `exchanges/{v}/{x}/publish` (POST), `.../bindings/source`, `.../bindings/destination`.
- **Queues:**
  - `queues` (reduced field set), `queues/detailed`, `queues/{v}`, `queues/{v}/{q}` (DELETE accepts `if-empty` and `if-unused`)
  - `queues/{v}/{q}/bindings`, `/contents` (DELETE purges), `/get` (POST), `/actions`
  - Quorum queues: `queues/quorum/{v}/{q}/replicas/add` (POST, `node`), `.../replicas/delete` (DELETE)
  - `queues/quorum/replicas/on/{node}/grow` (POST: `vhost_pattern`, `queue_pattern`, `strategy`, `membership`)
  - `queues/quorum/replicas/on/{node}/shrink` (DELETE, returns 202)
  - `queues/quorum/{v}/{q}/status` (Raft status)
  - The replica operations need `administrator` and can be turned off with `management.restrictions.quorum_queue_replica_operations.disabled` ([grow handler](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.x/deps/rabbitmq_management/src/rabbit_mgmt_wm_quorum_queue_replicas_grow.erl)).
- **Bindings:** `bindings[/{v}]`, `bindings/{v}/e/{src}/{q|e}/{dst}[/{props}]`.
- **Vhosts:**
  - `vhosts[/{v}]`: PUT accepts `description`, `tags`, `default_queue_type`, `protected_from_deletion` and `tracing`
  - `vhosts/{v}/deletion/protection` (POST/DELETE)
  - `vhosts/{v}/start/{node}`, `vhosts/{v}/permissions`, `vhosts/{v}/topic-permissions`
- **Users:** `users`, `users/without-permissions`, `users/bulk-delete`, `users/{u}`, `.../permissions`, `.../topic-permissions`, `users/{u}/queues` (4.3). Only users in the internal database are listed.
- **Permissions:** `permissions[...]`, `topic-permissions[...]`.
- **Feature flags:** `feature-flags`, `feature-flags/{name}/enable` (PUT).
- **Deprecated features:** `deprecated-features`, `deprecated-features/used`.
- **Health checks** (all under `health/checks/`, 200 when healthy, 503 when not):
  - `alarms`, `local-alarms`, `certificate-expiration/{within}/{unit}`, `port-listener/{port}`, `protocol-listener/{protocols}`, `virtual-hosts`, `node-is-quorum-critical`
  - `metadata-store/initialized[/with-data]` (4.0.x+)
  - `is-in-service`, `below-node-connection-limit`, `ready-to-serve-clients`, `quorum-queues-without-elected-leaders/{all-vhosts|vhost/{v}}[/pattern/{p}]` (4.1.x+)
  - `reached-target-cluster-size` (4.2.x+)
  - Legacy: `healthchecks/node[/{n}]` and `aliveness-test/{v}` (no-op since 4.1).
- **Other:**
  - `reset[/{node}]` (stats)
  - `rebalance/queues` (POST, asynchronous: "inspect logs")
  - `auth/attempts/{node}[/source]`
  - `auth/hash_password/{pw}`, plus POST `auth/hash_password` on main
  - `login` (IdP-initiated form with `access_token`)
  - `init` (4.4/main only)
- **Plugin endpoints:**
  - Shovels: `shovels[/{v}]` (monitoring); `shovels/vhost/{v}/{name}` GET/DELETE and `.../restart` DELETE. Since 4.3 the DELETE needs `policymaker` ([handler](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_shovel_management/src/rabbit_shovel_mgmt_shovel.erl)).
  - Federation: `federation-links[/{v}]`, `.../state/down`, `federation-links/vhost/{v}/{id}/{node}/restart` (DELETE) ([handler](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_federation_management/src/rabbit_federation_mgmt.erl)).
  - Streams: `stream/connections[...]` including publishers, consumers and DELETE; `stream/publishers[...]`; `stream/consumers[...]`; `stream/super-streams/{v}/{name}` (PUT only: `partitions` or `binding-keys`, `arguments`, `node`); `stream/{v}/{s}/tracking?type=offset|writer|all`.
  - Top: `top/{node}`, `top/ets/{node}`, `process/{pid}`.
  - Tracing: `traces[...]`, `trace-files[...]`.

**Query parameters** ([HTTP API reference](https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/http-api-reference.md)):
- `page`, `page_size` (default 100, **max 500**), `name`, `use_regex`.
- `sort` (supports dotted sub-fields), `sort_reverse`, `columns=` (dotted).
- `disable_stats=true`, which can be combined with `enable_queue_totals=true` to get name, vhost, type, node, state, arguments, flags and the three message counts.
- Time series: `lengths_age`/`lengths_incr`, `msg_rates_age`/`msg_rates_incr`, `data_rates_age`/`data_rates_incr`, `node_stats_age`/`node_stats_incr`.

**No machine-readable schema.** There is no official JSON schema or OpenAPI spec. [#2622](https://github.com/rabbitmq/rabbitmq-server/issues/2622) has been open since 2016 and was assigned on 2026-02-20. The best typed reference is the Rust client [rabbitmq-http-api-rs](https://github.com/michaelklishin/rabbitmq-http-api-rs) (0.93.0, async and blocking, Apache-2.0/MIT), which rabbitmqadmin v2 is built on.

## 4. Message endpoints and their caveats

**Publish: `POST /api/exchanges/{vhost}/{name}/publish`.** Body: `properties`, `routing_key`, `payload`, `payload_encoding` (string or base64). Response: `{"routed":bool}`.
- The docs warn that HTTP "is a highly inefficient option for publishing".
- In code, the handler opens an internal channel, publishes with `mandatory=true`, and waits for a publisher confirm with a 30 s default timeout ([handler](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/src/rabbit_mgmt_wm_exchange_publish.erl)).

**Get: `POST /api/queues/{vhost}/{name}/get`.** Body: `count`, `ackmode`, `encoding` (auto or base64), `truncate`. The docs say it is "intended for development and troubleshooting only, not for production". The handler ([source](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/src/rabbit_mgmt_wm_queue_get.erl)) works as follows:
- It runs `basic.get` `count` times on an internal channel.
- Only after all messages are fetched does it settle them. The code comment explains why: "we get always the same message if the messages are requeued inside basic_get".
- `ack_requeue_true` sends `basic.nack(requeue=true)`.
- `reject_requeue_*` sends `basic.reject`.
- `ack_requeue_false` uses `no_ack`.
- While the request runs, the fetched messages are held unacknowledged, so other consumers cannot see them.

**How requeueing interacts with quorum queues:**
- Since 4.0 the default delivery-limit is 20. Above it, messages are dropped, or dead-lettered if a dead-letter exchange is configured.
- In 4.3, `basic.nack` increments only `acquired-count`. `basic.reject` and client crashes also increment `delivery-count`, and the limit uses `delivery-count` ([QQ docs](https://www.rabbitmq.com/docs/quorum-queues)).
- The 4.3.0 notes say explicit returns no longer count "towards the delivery limit". INFERENCE: on 4.0–4.2, repeated requeue-based peeks counted against the limit.
- 4.2 docs: with a delivery-limit set, returned messages go back "near the head" ([4.2 QQ docs](https://www.rabbitmq.com/docs/4.2/quorum-queues)).

**Other message caveats:**
- Streams cannot be read through the UI's Get messages. Reading them needs AMQP 0.9.1 with `x-stream-offset`, the stream protocol, or AMQP 1.0 (with filter expressions; SQL filters since 4.2).
- The only true non-destructive peek is `rabbitmq-queues peek <queue> <position>`, which is CLI-only and works on quorum queues ([man](https://www.rabbitmq.com/docs/man/rabbitmq-queues.8)). Its output is unreadable for large headers ([#17359](https://api.github.com/search/issues?q=repo:rabbitmq/rabbitmq-server+%22get+messages%22+OR+%22message+browser%22+OR+%22browse+messages%22+OR+%22peek%22&sort=created&order=desc&per_page=40), open).
- In 4.x the broker no longer interprets an `x-death` header that a client republishes. It still sets and updates `x-death` on each dead-lettering (4.0.1 RN). This matters for any re-drive feature.

## 5. Authentication, CORS and hardening (FACT)

**Basic auth and bearer tokens.**
- Basic auth works by default. A JWT bearer token is accepted in `Authorization`.
- With `management.disable_basic_auth=true` only bearer tokens work. The exception is `GET/POST /definitions`, which need the token in a `?token=` query parameter.

**OAuth 2.0 in the UI** ([management docs](https://www.rabbitmq.com/docs/management)):
- Authorization code flow with PKCE (`sp_initiated`), or `idp_initiated`. In the IdP flow the portal POSTs `access_token` to `/login`.
- Multiple resources via `management.oauth_resource_servers.N.*`. Multiple OAuth resources and providers have existed since 3.13 (#10012).
- URL parameters `preferred_auth_mechanism` and `strict_auth_mechanism`.
- RP-initiated logout.
- Scopes such as `rabbitmq.tag:administrator` ([oauth2](https://www.rabbitmq.com/docs/oauth2)).

**Separate auth backends for HTTP.** Since 4.1, the HTTP API can use its own auth backends via `http_dispatch.auth_backends` ([#13465](https://github.com/rabbitmq/rabbitmq-server/pull/13465)).

**CORS.** Cross-origin requests are refused by default. Configure `management.cors.allow_origins.N` and `management.cors.max_age` (default 1800 s). The implementation:
- echoes the requested headers
- sets `Access-Control-Allow-Credentials: true`
- ignores origins that are `null`, undefined or `*`

4.3.2 added more hardening ([cors.erl](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/src/rabbit_mgmt_cors.erl)).

**Other hardening:**
- CSP dropped `unsafe-eval` and `unsafe-inline` in 4.3.4. HSTS and Referrer-Policy are configurable. `hide_allow_header`.
- `management.tcp/ssl.max_connections` (4.3.1). Body limit 20 MiB. `login_session_timeout` defaults to 480 minutes.
- Restriction keys: `management.restrictions.operator_policy_changes.disabled` and `management.restrictions.quorum_queue_replica_operations.disabled`.
- `management.credential_encryption_secret` (spelled this way in the [schema](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/priv/schema/rabbitmq_management.schema); the docs spell it `credentials_...`).

## 6. Where metrics are heading

**Deprecation status (FACT).** The `management_metrics_collection` deprecated feature is still declared `permitted_by_default` on v4.3.x and v4.4.x ([4.3.x source](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.x/deps/rabbitmq_management_agent/src/rabbit_mgmt_agent_config.erl), [4.4.x](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.4.x/deps/rabbitmq_management_agent/src/rabbit_mgmt_agent_config.erl)). It was announced in 2021 for removal in 4.0 ([PR #7390](https://github.com/rabbitmq/rabbitmq-server/pull/7390), [2021 post](https://www.rabbitmq.com/blog/2021/08/21/4.0-deprecation-announcements)) and has not been removed.

**Ways to turn collection off:**
- `management_agent.disable_metrics_collector=true`, or `deprecated_features.permit.management_metrics_collection=false`, turns the collector off.
- `management.disable_stats=true` hides charts and stats. `management.enable_queue_totals=true` keeps `messages`, `messages_ready` and `messages_unacknowledged`.

**What the docs say.** Prometheus plus Grafana is "highly recommended". Management stats keep "recent data (think hours, not days)" ([monitoring](https://www.rabbitmq.com/docs/monitoring)). Default retention: 5 s resolution for 1 minute, 60 s for 1 hour, 20 minutes for 1 day.

**Prometheus** ([docs](https://www.rabbitmq.com/docs/prometheus)):
- Port 15692, no auth by default.
- Endpoints: `/metrics` (aggregated), `/metrics/per-object`, `/metrics/memory-breakdown` (expensive at scale), and `/metrics/detailed?family=…&vhost=…&queue=<regex>`. The queue filter was added in 4.3. `/metrics/detailed` is "up to 60 times more efficient" than per-object.
- Families: `queue_coarse_metrics`, `queue_delivery_metrics`, `queue_consumer_count`, `queue_metrics`, `exchange_metrics`, `queue_exchange_metrics`, `connection_*`, `channel_*`, `ra_metrics`, `stream_consumer_metrics`, `auth_attempt_*`, `vhost_status`, `exchange_names`, `exchange_bindings`, `node_*`, `connection_churn_metrics`.
- Gaps: per-queue "incoming" rate parity was still missing as of the last comment in [#8691](https://github.com/rabbitmq/rabbitmq-server/issues/8691) (2024). Ra metrics were renamed in 4.2.

**INFERENCE for a third-party tool.** Charts cannot depend on the management stats. You need a metrics-provider layer:
- management stats, when enabled
- direct Prometheus scraping with rates computed client-side
- the user's existing Prometheus through PromQL
- the tool's own sampling of `enable_queue_totals` counts

It also needs local storage for history beyond the server's short retention. Detect the stats mode first: `/api/overview` returns only `object_totals` when stats are off, and node `uptime` is absent when the collector is off.

## 7. CLI-only capabilities and other programmatic paths

CLI tools reach nodes through Erlang distribution using the Erlang cookie and ports 4369 and 25672. Only rabbitmqadmin uses HTTP ([cli](https://www.rabbitmq.com/docs/cli)).

**No HTTP equivalent:**
- `rabbitmq-queues peek`
- stream `add_replica`, `delete_replica`, `stream_status`, `restart_stream`
- single-active-consumer group commands (`list_stream_consumer_groups`, `list_stream_group_consumers`, `activate_stream_consumer`)
- `delete_super_stream`
- `rabbitmq-upgrade drain/revive/await_online_quorum_plus_one/post_upgrade`. The drain state is still visible through the `is-in-service` check and the `being_drained` field on nodes.
- `rabbitmq-plugins` enable/disable. The enabled list is visible in `/api/nodes` `enabled_plugins`.
- `join_cluster`, `forget_cluster_node`, `reset`, `force_boot`
- `set_log_level`, `set_vm_memory_high_watermark`, `set_disk_free_limit`, `eval`
- `log_tail[_stream]`, `consume_event_stream`, `observer`, `runtime_thread_stats`, `message_size_stats`, `tls_versions`, `cipher_suites`, `list_unresponsive_queues`, `set_permissions_globally`
- `sole_connection_*` (4.4)

Man pages: [rabbitmq-diagnostics](https://www.rabbitmq.com/docs/man/rabbitmq-diagnostics.8), [rabbitmq-streams](https://www.rabbitmq.com/docs/man/rabbitmq-streams.8), [rabbitmq-upgrade](https://www.rabbitmq.com/docs/man/rabbitmq-upgrade.8), [rabbitmqctl](https://www.rabbitmq.com/docs/man/rabbitmqctl.8).

**Has an HTTP equivalent:** quorum-queue add/delete member, grow/shrink, `quorum_status`, `rebalance`, the quorum-critical check, `hash_password`, `environment` (`/config/effective`), firehose `trace_on` (vhost `{"tracing":true}`), closing connections per user, and stream offset tracking.

**AMQP 1.0 HTTP-over-AMQP (`/management` node).** It supports only these operations ([rabbit_amqp_management.erl](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbit/src/rabbit_amqp_management.erl), [Java client](https://raw.githubusercontent.com/rabbitmq/rabbitmq-amqp-java-client/main/src/main/java/com/rabbitmq/client/amqp/impl/AmqpManagement.java)):
- GET, PUT, DELETE `/queues/{q}`; DELETE `/queues/{q}/messages`
- PUT and DELETE `/exchanges/{x}`
- POST, GET, DELETE `/bindings`
- PUT `/auth/tokens`

There is nothing for users, vhosts, policies or CLI-only operations.

**Event and log streams over AMQP:**
- The `rabbitmq_event_exchange` plugin publishes to `amq.rabbitmq.event`. Event types: queue, exchange, binding, connection, channel, consumer, policy, parameter, vhost, user, permission, alarm, shovel and federation. Payloads carry `user_who_performed_action` ([logging#internal-events](https://www.rabbitmq.com/docs/logging#internal-events), [rabbit_vhost.erl](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbit/src/rabbit_vhost.erl)).
- With `log.exchange=true`, log lines go to `amq.rabbitmq.log`.
- The firehose publishes to `amq.rabbitmq.trace`. It runs per node and per vhost and costs performance ([firehose](https://www.rabbitmq.com/docs/firehose)).

**rabbitmqadmin v2 (Rust).** Latest is v2.35.0 (2026-09-08), with forward compatibility for 4.4.0. It uses only the HTTP API. Configuration is TOML with node profiles. Features include health checks, definition transformations, blue/green helpers, `delete_multiple` with `--dry-run`, plugin listing, Tanzu SDS/WSR, shovel and federation TLS peer-verification sweeps, and shell completions ([repo](https://github.com/rabbitmq/rabbitmqadmin-ng), [CHANGELOG](https://raw.githubusercontent.com/rabbitmq/rabbitmqadmin-ng/main/CHANGELOG.md)). The rabbitmqadmin v1 download endpoint was removed in 4.3.

## 8. Official signals on the UI's future and competitive context

**Issue [#2619](https://github.com/rabbitmq/rabbitmq-server/issues/2619), "Migrate UI to a modern framework" (open since 2016):**
- michaelklishin, 2026-09-23: "modernizing the UI without any meaningful UI changes will be the first step. A completely new UI prototype will most likely ship later, and take a long time to evaluate."
- @Zerpet showed TypeScript prototypes (Vue + ChartJS, and React + Tailwind) and mentioned RabbitScout.
- A contributor's request for incremental restyling ([#17533](https://github.com/rabbitmq/rabbitmq-server/issues/17533)) was closed as a duplicate.

**Tanzu-only additions in 4.3** ([4.3 blog](https://www.rabbitmq.com/blog/2026/04/23/rabbitmq-4.3-release), [Tanzu RN](https://techdocs.broadcom.com/us/en/vmware-tanzu/data-solutions/tanzu-rabbitmq-oci/4-3/tanzu-rabbitmq-oci-image/site-release-notes.html)):
- Stream Browser (`rabbitmq_stream_browser`): navigate by offset or timestamp, show all AMQP 1.0 sections, view segments and chunks, selective downloads.
- Linter: checks for anti-patterns, built into the UI.
- JMS queue type with a queue browser and selectors.
- Delayed queues and a message scheduler.
- AMQP 1.0 over WebSocket (`rabbitmq_web_amqp`) has been commercial-only since 4.1 ([blog](https://www.rabbitmq.com/blog/2025/04/16/amqp-websocket)).

**Community alternative.** [RabbitScout](https://github.com/Ralve-org/RabbitScout) is MIT-licensed, built with Next.js 16, and proxies the HTTP API. It had about 154 stars when checked.

## 9. Capability matrix

| Capability | HTTP API | UI | CLI | Needs AMQP? | Notes / caveats |
| --- | --- | --- | --- | --- | --- |
| Overview, versions, totals | `GET overview`, `GET version` (no auth) | Overview | diagnostics status, server_version | No | Keys shrink when stats are off |
| Nodes, memory, ETS | `nodes`, `nodes/{n}/memory[/ets]` | Node page | memory_breakdown, status | No | Includes `being_drained` and `enabled_plugins` |
| Effective config | `GET config/effective` | — | environment | No | Admin only; likely includes secrets |
| Cluster membership | — | — | join_cluster, forget_cluster_node, reset | n/a | CLI only |
| Maintenance (drain/revive) | read-only via `is-in-service` | — | rabbitmq-upgrade | n/a | CLI only |
| Plugins enable/disable | list only via `nodes` | — | rabbitmq-plugins | n/a | CLI only |
| Log level / watermarks | — | — | set_log_level etc. | n/a | CLI only |
| Logs | — | — | log_tail[_stream] | Yes (`amq.rabbitmq.log` if enabled) |  |
| Event / audit feed | — | — | consume_event_stream | Yes (`amq.rabbitmq.event`) | Plugin required; `user_who_performed_action` |
| Health checks | `health/checks/*` | alarms only | check_* | No | 200/503; availability varies by version |
| Connections (all protocols) | `connections[...]` | Connections | list_*_connections | No | Paged 100/500; static info with stats off only from 4.3 |
| Close connections | DELETE `connections/{c}`, `connections/username/{u}` | Connection page | close_connection, close_all_connections | No | `X-Reason` header |
| AMQP 1.0 sessions/links | `connections/{c}/sessions` | Connection page | — | No | 4.1+ |
| Channels / consumers | `channels[...]`, `consumers[...]` | Channels, Queue page | list_channels, list_consumers | No | Channels returned 400 with stats off before 4.3.6 |
| Exchanges / queues / bindings CRUD | `exchanges`, `queues`, `bindings` | Yes | list_* only | Alternative: AMQP 0.9.1 or AMQP 1.0 `/management` | `queues` returns reduced fields; use `/detailed` or `columns=` |
| Purge | DELETE `queues/{v}/{q}/contents` | Yes (not streams) | purge_queue | Alternative: AMQP | Needs only read permission |
| Policies / operator policies | `policies`, `operator-policies` | Admin > Policies | set_policy | No | Equal priority means random choice; `effective_policy_definition` |
| Parameters / global parameters | `parameters`, `global-parameters` | Via plugin pages | set_parameter | No |  |
| Vhosts | `vhosts`, `deletion/protection`, `start/{node}` | Admin > Virtual Hosts | add_vhost, restart_vhost | No | `tracing` flag on PUT |
| Users, permissions, limits | `users*`, `permissions`, `topic-permissions`, `*-limits` | Admin | add_user, set_permissions | No | Internal-database users only; `protected` tag |
| Definitions | `definitions[/{v}]` | Overview | export_definitions, import_definitions | No | Merge on import; 20 MiB limit; ETag; contains password hashes |
| Feature flags / deprecated features | `feature-flags`, `deprecated-features[/used]` | Admin | enable_feature_flag, list_deprecated_features | No |  |
| Queue leader rebalance | POST `rebalance/queues` | — | rabbitmq-queues rebalance | No | Asynchronous |
| QQ replicas / grow / shrink | `queues/quorum/...` | — | add_member, grow, shrink | No | Admin; can be disabled |
| QQ Raft status | `queues/quorum/{v}/{q}/status` | Partial (members, leader) | quorum_status | No |  |
| QQ peek by position | — | — | rabbitmq-queues peek | n/a | CLI only |
| Stream replicas / status / restart | — | — | rabbitmq-streams | n/a | CLI only |
| Stream SAC groups | — | — | list_stream_consumer_groups etc. | n/a | CLI only |
| Super streams | PUT `stream/super-streams/{v}/{n}` | Super Streams | add_ / delete_super_stream | No | No HTTP delete |
| Stream connections, publishers, consumers, offsets | `stream/*`, `stream/{v}/{s}/tracking` | Stream Connections | list_stream_* | No | Needs `rabbitmq_stream_management` |
| Publish | POST `exchanges/{v}/{x}/publish` | Exchange and queue pages | rabbitmqadmin publish | No (internal channel) | Inefficient; waits for confirm (30 s) |
| Get with requeue | POST `queues/{v}/{q}/get` | Get messages | rabbitmqadmin get | No | Destructive; QQ delivery-count side effects; not for streams |
| Non-destructive browse | — | — (Tanzu: JMS browser) | peek (QQ) | Yes | Not available in open-source |
| Stream browse | — | — (Tanzu Stream Browser) | — | Yes (offset consumer) |  |
| Move messages | PUT `parameters/shovel/...` | Move messages | set_parameter shovel | No | Moves all; needs `policymaker` |
| Shovels / federation status | `shovels*`, `federation-links*` | Admin pages | shovel_status, federation_status | No | DELETE needs `policymaker` (4.3) |
| Firehose / tracing | vhost `tracing`, `traces*` | Tracing | trace_on, trace_off | Yes, to consume the firehose | Per node; performance cost |
| Processes / ETS | `top/*`, `process/{pid}` | Top pages | observer | No | Needs `rabbitmq_top` |
| Management metrics | stats fields plus `*_age`/`*_incr` | Charts | — | No | Deprecated but on by default; short retention |
| Prometheus | :15692 `/metrics*` | — | — | No | Separate port; no auth by default |
| Topology over AMQP 1.0 | — | — | — | Yes | Queues, exchanges, bindings, purge, token refresh only |

## 10. Architecture implications (INFERENCE / IDEA)

1. **Version and capability negotiation.** Build a capability layer from `/api/version`, `/api/overview`, `/api/extensions`, `nodes.enabled_plugins` and probes (404/405/400). Endpoint availability differs across 4.0–4.4, and stats-off mode changes response shapes.
2. **Native protocol clients are required.** Stream browsing, a live tap, safe peeks and high-throughput publish or re-drive need AMQP 0.9.1, AMQP 1.0 and/or the stream protocol.
   - Desktop apps can connect directly.
   - Web mode needs a backend: browsers cannot speak these protocols to open-source RabbitMQ (AMQP over WebSocket is Tanzu-only), and CORS is closed by default.
   - Desktop webviews are also subject to CORS, so route HTTP calls through the native layer.
3. **Polling budget.** Use server-side `name`/`use_regex`/`columns`, `disable_stats=true` per request, poll every 30–60 s in production, and cap concurrency below `management.tcp.max_connections`. Keep a local index for search.
4. **Safety model for message operations.** Make side effects explicit for each queue type and version. Prefer server-side shovels for mass moves. Require confirmations for production profiles.
5. **CLI-only gaps.** Ship copyable runbooks first. Consider an optional node-side agent (holding the Erlang cookie) later, as an opt-in security-sensitive component.

## Feature ideas

| Idea | Persona | Priority | Size | Description | Evidence / inspiration |
| --- | --- | --- | --- | --- | --- |
| Capability and version negotiation layer | all | must | M | On connect, call /api/version (no auth), /api/overview, /api/extensions and /api/nodes (enabled_plugins, being_drained). Probe optional endpoints and detect stats mode and restriction flags. Use the results to enable or disable UI actions and pick API shapes for each RabbitMQ version (4.0 through 4.4, 3.13 legacy). | Endpoints added per version: sessions (4.1), reached-target-cluster-size (4.2), users/{u}/queues (4.3), /api/auth removed (4.3), /api/init (4.4). Stats-off differences: #15182; channels returned 400 before 4.3.6. |
| Pluggable metrics engine | operator | must | L | Provider abstraction: management stats (*_age/*_incr) when available; direct Prometheus scrape of /metrics/detailed with family, vhost and queue filters and client-side rate calculation; a user-supplied Prometheus via PromQL; or the tool's own sampling of enable_queue_totals counts. Map metric names per version (Ra metrics renamed in 4.2). | management_metrics_collection deprecated since 2021, still permitted_by_default in 4.3.x/4.4.x. Monitoring docs recommend Prometheus. 4.2 renamed Ra metrics. |
| Local time-series history | operator | should | M | Keep queue depth, rates, consumers and node metrics locally (embedded database on desktop, server database in web mode) beyond the broker's retention of minutes to one day. Enables time-series explorer, comparisons and post-incident review. | Default sample retention: 5 s for 1 minute, 60 s for 1 hour, 20 minutes for 1 day. Docs: 'hours, not days'. |
| Safe peek with side-effect disclosure | developer | must | M | Explicit, queue-type- and version-aware peek. Classic queues: requeue sets the redelivered flag. Quorum queues: on 4.0–4.2 each requeue counts toward delivery-limit (default 20); on 4.3+ nack is safe but reject counts. Show delivery-limit, DLX presence and a risk banner. Default to nack-requeue and small batches. | rabbit_mgmt_wm_queue_get.erl uses basic.nack or basic.reject after fetching all messages. QQ docs counter table. 4.3.0 release notes on unlimited returns. |
| Open-source stream browser | developer | must | L | Browse streams and super streams by first, last, offset or timestamp using the stream protocol or AMQP. Supports AMQP 1.0 filter expressions and SQL filters (4.2+), tabular and expanded views (all AMQP 1.0 sections), paging, and download or export. | Open-source UI sets get_message:false for streams. The Tanzu Stream Browser (4.3) is commercial-only. |
| Dead-letter workbench | operator | must | L | Decode x-death and x-first-death-*. Group by reason, queue and exchange. Selective or bulk re-drive to the original exchange and routing key with publisher confirms, throttling, idempotency headers and a configurable policy on x-death headers. Use server-side shovels for large moves. Show progress and partial failures. | The UI only offers 'Move messages' (all messages, needs policymaker). In 4.x the broker no longer interprets client-republished x-death headers (4.0.1 RN). |
| Server-side move and copy | operator | should | M | Create temporary dynamic shovels (amqp091, amqp10, or local on 4.2+) with src-delete-after=queue-length or src-delete-after-duration (4.3.5). Track progress through /api/shovels and clean up. | queue.ejs Move messages uses a shovel with prefetch 1000. Local shovels in 4.2. Shovel TTL in 4.3.5. |
| Policy debugger and simulator | operator | must | M | For any queue or exchange, list matching policies and operator policies (pattern, apply-to, priority) and highlight equal-priority conflicts. Show effective_policy_definition and per-key origin. Test a hypothetical name before declaring it. | API docs: only one policy applies, and conflicting priorities lead to random selection. effective_policy_definition fixed in 4.3 (#16017). |
| Schema-aware policy editor | operator | should | M | Policy and operator-policy editor with known keys per queue type (delivery-limit, delayed-retry-*, max-length, overflow, DLX, stream max-age), validation, diffs and patch-style updates of a single key. Respects the operator-policy restriction flag. | KNOWN_ARGS in global.js. rabbitmqadmin policies patch and update_definition. management.restrictions.operator_policy_changes.disabled. |
| Bulk operations with dry-run | operator | must | M | Regex or selection-based bulk delete or purge of queues, delete of exchanges, closing connections, and applying policies. Dry-run preview, concurrency limit, progress, idempotency and a partial-failure report. | The only bulk endpoint is users/bulk-delete. rabbitmqadmin v2.31/2.32 added delete_multiple --name-pattern, --dry-run and --detailed-exit-codes. |
| Credential vault and modern auth | team-security | must | M | OS keychain on desktop and encrypted secrets server-side. Basic auth, bearer and JWT, OIDC with PKCE (multiple resource servers and audiences), client-credentials for team servers, mTLS, token refresh, and ?token= for definitions when basic auth is disabled. | The official UI stores Base64 user:password in localStorage unless credential_encryption_secret is set. disable_basic_auth requires ?token= on /definitions. |
| Team RBAC overlay (web mode) | team-security | should | L | Roles per environment and cluster with fine-grained actions (view messages, publish, purge, delete, policy edit), optional approval workflow for destructive actions, and least-privilege broker credentials per role. | RabbitMQ has four coarse tags. queue.purge needs only read permission. Protected tag only blocks HTTP user edits. |
| Audit log and activity feed | team-security | should | M | Record every action taken through the tool (who, what, when, cluster, payload hash). Also ingest broker events from amq.rabbitmq.event, including user_who_performed_action, into a searchable timeline. | HTTP requests are not logged by default. Event types documented in logging#internal-events. rabbit_vhost.erl includes user_who_performed_action. |
| Definitions studio and GitOps diff | platform | must | M | Export cluster or per-vhost definitions with canonical sorting. Diff between clusters, environments or files. Transformations (strip classic-mirroring keys, obfuscate credentials, prepare for quorum-queue migration). Conditional fetch with ETag. Import preview that warns about merge semantics. | rabbitmqadmin v2 transformations. #12297 asks for sorted export. ETag in 4.3.5. Merge-only import semantics. |
| Health dashboard | operator | must | S | Aggregate the /api/health/checks/* endpoints (alarms, certificate expiry, listeners, vhosts, quorum-critical, QQs without a leader, ready-to-serve-clients, target cluster size) and deprecated features in use, with history and notifications. | The health checks have no UI page. They were added in 4.0, 4.1 and 4.2. |
| Upgrade and readiness assistant | operator | should | M | Checks before upgrading: feature flags not enabled, deprecated features used (transient non-exclusive queues, global QoS and others denied by default in 4.3), Khepri migration status, x-queue-mode or CQv1 arguments, classic-mirroring policy keys. Generates a blue/green plan and transformed definitions. | 4.3.0 breaking changes. /api/deprecated-features/used. rabbitmqadmin blue-green helpers. |
| Quorum-queue operations panel | operator | should | M | Show members, leader and Raft status (quorum status endpoint). Leader distribution per node. Add or remove a replica, grow or shrink, rebalance. Quorum-critical warnings. Respects the replica-operations restriction flag. | HTTP endpoints queues/quorum/* and rebalance/queues exist but have no UI. |
| Stream operations panel | operator | should | M | Stream connections, publishers and consumers, offset tracking per reference, consumer lag (Prometheus stream_consumer_metrics), super stream creation. Copyable CLI runbooks for replica, status and restart operations that are CLI-only. | stream/* endpoints and stream tracking. rabbitmq-streams commands with no HTTP equivalent. |
| Connection, channel and consumer explorer | operator | must | M | Filter by protocol (AMQP 0.9.1, AMQP 1.0, MQTT, STOMP, stream), user, client properties, TLS details and certificate serial. AMQP 1.0 sessions and links. Prefetch and unacknowledged hotspots. Close one connection or all of a user's, with a reason. | connections/{c}/sessions (4.1). connections/username/{u}. X-Reason header. Peer certificate serial (4.3.1). |
| Node diagnostics | operator | should | M | Memory breakdown (absolute and relative), ETS tables, top processes when rabbitmq_top is enabled, file descriptors and sockets, alarms, enabled plugins, maintenance state. | nodes/{n}/memory[/ets]. top/* endpoints. being_drained field. |
| Live event and log console | operator | could | M | Consume amq.rabbitmq.event and, when log.exchange is enabled, amq.rabbitmq.log, with filters by event type and level. A substitute for CLI log_tail and consume_event_stream. | Event exchange and logging docs. log_tail is CLI-only. |
| CLI runbooks, with an optional agent later | platform | could | S | For CLI-only operations (QQ peek, stream replicas, drain/revive, plugins, cluster membership), generate exact, copyable commands with context. Later, an optional opt-in node-side agent could run them securely. | CLI tools need Erlang distribution and the cookie. Gaps listed in the capability matrix. |
| Test consumer workbench | developer | should | M | Temporary consumers with ack mode, prefetch, priority, x-stream-offset and AMQP 1.0 filters. Pause and ack controls. Shows how a real consumer would see messages. | The HTTP get endpoint is for development only. Streams require consumers. |
| Queue and stream declare wizard | developer | must | M | Arguments aware of queue type: QQ delivery-limit, delayed retry, consumer timeout, priorities, member placement; stream max-age, max-length-bytes, initial offset (4.4); warnings for deprecated or ignored arguments. | KNOWN_ARGS list. 4.3 QQ features. 4.4 x-stream-initial-offset. #15015 form-reset bug. |
| Large-scale performance mode | all | must | M | Use server-side name/regex filters, columns=, disable_stats=true and enable_queue_totals. Adaptive polling (no faster than 5 s in development, 30–60 s in production). Request concurrency below management.tcp.max_connections. Virtualised tables and a local name index. | Monitoring docs on polling overhead. 3.13 note on 'enormously large responses'. Page size max 500. 4.3.1 max_connections. |
| Permissions matrix and access evaluator | team-security | should | M | Users × vhosts grid of configure, write and read regexes plus topic permissions. 'Who can read, write or configure queue X' evaluator. Highlights over-broad patterns such as .* | Permission model in access-control docs. /api/permissions and /api/topic-permissions. |
| User hygiene tools | team-security | should | S | List users with no permissions and bulk-delete them, aware of the protected tag. Per-user limits. Hash passwords locally, never through GET /api/auth/hash_password/{pw} where the secret sits in the URL path. | users/without-permissions and bulk-delete endpoints. Protected tag (4.2.x/4.3). Main adds POST hash_password. |
| Vhost management | operator | should | S | Metadata, default queue type, deletion-protection toggle, limits, tracing toggle, restart on a node. | PUT /api/vhosts fields. deletion/protection endpoints. The vhost form in the official UI lacks deletion protection. |
| Shovel and federation manager | operator | should | M | Create, inspect, restart and delete shovels (amqp091, amqp10, local) and federation upstreams and sets. Audit TLS peer verification. Status timeline. | Shovel and federation endpoints. rabbitmqadmin v2 TLS verification sweeps. 4.3 requires policymaker for DELETE. |
| Feature flags and deprecated features advisor | operator | should | S | Explain each flag (stable or experimental, migration needed), enable with confirmation, and show deprecated features in use with remediation steps. | 4.1 feature-flag UI changes. /api/deprecated-features/used. |
| Open-source linter | operator | should | M | Rule-based checks: QQ without DLX (delivery-limit silently drops messages), queues without length or TTL limits, equal-priority policy overlaps, transient non-exclusive queues, ignored x-queue-mode, global QoS, consumer-timeout risks, very high unacknowledged ratios, single-replica QQs. | The Tanzu Linter (4.3) is commercial-only. 4.0 delivery-limit default of 20. |
| Web deployment modes | platform | must | L | Self-hosted backend that proxies the HTTP API and hosts the AMQP and stream clients. Optional direct-from-browser HTTP mode when CORS is configured. Supports path_prefix, reverse proxies and X-Forwarded-*. SSO. | CORS closed by default. AMQP over WebSocket is Tanzu-only. RabbitScout uses a catch-all proxy. |
| Prometheus and Grafana integration | platform | could | S | Detect the :15692 endpoints, link to or import the official Grafana dashboards, use PromQL for history where available. | Prometheus docs list the official dashboards. |
| Deep link into the official UI with SSO | team-security | could | S | Open the same object in the official management UI. For IdP-initiated deployments, POST access_token to /login. | management.oauth_initiated_logon_type=idp_initiated and the /login form. |
| Typed API console | developer | could | M | Built-in HTTP API explorer with typed request and response models and version notes, filling the gap left by having no official schema. | #2622 open since 2016. rabbitmq-http-api-rs as a typed reference. |
| Configuration drift detection | platform | should | M | Scheduled definition snapshots per cluster with drift alerts against a baseline or Git (web mode). | Definitions export with ETag (4.3.5) and streaming (4.3.3). |
| Connection and consumer hygiene analytics | operator | should | M | Detect idle connections, channel leaks (channels per connection), consumers with low consumer_capacity, unacknowledged growth, blocked consumers (4.4). | Consumers and channels endpoints. 4.4 blocked-consumer status fix. |
| Message size analytics | operator | could | S | Message size distribution per protocol from Prometheus histograms (4.1+), with links to max_message_size limits (16 MiB default since 4.0). | 4.1 Prometheus message size histogram. 4.2 message_size_stats (CLI only). |
| Typed Rust HTTP client core | platform | could | M | Build the shared core (desktop and server) on, or modelled after, rabbitmq-http-api-rs (async, rustls) to reuse up-to-date endpoint coverage. | rabbitmq-http-api-rs 0.93.0 powers rabbitmqadmin v2.35.0 with 4.4.0 forward compatibility. |

## Claims flagged for verification

- **[high]** The deprecated feature management_metrics_collection is still declared with deprecation_phase => permitted_by_default on the v4.3.x and v4.4.x branches (not removed in 4.0 as announced in 2021). Operators can turn it off with management_agent.disable_metrics_collector=true or deprecated_features.permit.management_metrics_collection=false.
  - Why it matters: Decides whether charts and rates can rely on the HTTP API. The tool must support both modes and have Prometheus or self-sampling fallbacks.
  - Sources: https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.x/deps/rabbitmq_management_agent/src/rabbit_mgmt_agent_config.erl https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.4.x/deps/rabbitmq_management_agent/src/rabbit_mgmt_agent_config.erl https://github.com/rabbitmq/rabbitmq-server/pull/7390 https://www.rabbitmq.com/release-information/deprecated-features-list
- **[high]** The open-source management UI cannot read stream messages (stream queue type has get_message:false and purge:false). Stream browsing in the official UI exists only in the commercial Tanzu RabbitMQ 4.3+ Stream Browser plugin (rabbitmq_stream_browser).
  - Why it matters: An open-source stream browser is a clear differentiator, and it needs stream or AMQP protocol clients rather than the HTTP API.
  - Sources: https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/priv/www/js/global.js https://techdocs.broadcom.com/us/en/vmware-tanzu/data-solutions/tanzu-rabbitmq-oci/4-3/tanzu-rabbitmq-oci-image/site-stream-browser.html https://www.rabbitmq.com/blog/2026/04/23/rabbitmq-4.3-release
- **[high]** POST /api/queues/{vhost}/{name}/get runs basic.get N times on an internal channel, then settles all messages: basic.nack(requeue=true) for ack_requeue_true, basic.reject for reject_requeue_*, no_ack for ack_requeue_false. It is documented as for development and troubleshooting only, and the UI labels it a destructive action.
  - Why it matters: Any 'peek' feature built on it has side effects (redelivered flag, ordering, delivery counts, temporary invisibility to other consumers) that must be disclosed.
  - Sources: https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/src/rabbit_mgmt_wm_queue_get.erl https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/http-api-reference.md https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/priv/www/js/tmpl/classic-queue-get-message.ejs
- **[medium]** Quorum queues have had a default delivery-limit of 20 since 4.0. Before 4.3, explicit requeues counted toward it (4.3 switched to delivery-count, where basic.nack does not increment but basic.reject does). Repeated requeue-based peeks on 4.0–4.2 can therefore dead-letter or drop messages.
  - Why it matters: A naive peek or browse on quorum queues could cause data loss for users on 4.0–4.2.
  - Sources: https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.3.0.md https://www.rabbitmq.com/docs/quorum-queues https://www.rabbitmq.com/docs/4.2/quorum-queues https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.0.1.md
- **[high]** These operations have no HTTP API route and are CLI-only (Erlang distribution plus cookie): rabbitmq-queues peek; rabbitmq-streams add_replica, delete_replica, stream_status, restart_stream and SAC group commands; delete_super_stream; rabbitmq-upgrade drain and revive; rabbitmq-plugins enable and disable; join_cluster, forget_cluster_node and reset; set_log_level and watermarks; log_tail.
  - Why it matters: Defines the hard limit of an HTTP-based tool and whether a node-side agent or runbooks are needed.
  - Sources: https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/src/rabbit_mgmt_dispatcher.erl https://www.rabbitmq.com/docs/man/rabbitmq-queues.8 https://www.rabbitmq.com/docs/man/rabbitmq-streams.8 https://www.rabbitmq.com/docs/man/rabbitmq-upgrade.8 https://www.rabbitmq.com/docs/cli
- **[high]** The HTTP API exposes quorum-queue replica operations (queues/quorum/{v}/{q}/replicas/add|delete, replicas/on/{node}/grow|shrink), quorum-queue Raft status (queues/quorum/{v}/{q}/status) and POST /api/rebalance/queues. They are admin-only, and replica operations can be disabled with management.restrictions.quorum_queue_replica_operations.disabled.
  - Why it matters: Enables a quorum-queue operations panel with no CLI dependency, but the tool must detect when the restriction is set.
  - Sources: https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.x/deps/rabbitmq_management/src/rabbit_mgmt_dispatcher.erl https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.x/deps/rabbitmq_management/src/rabbit_mgmt_wm_quorum_queue_replicas_grow.erl https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/src/rabbit_mgmt_features.erl
- **[high]** The AMQP 1.0 HTTP-over-AMQP management node (/management) supports only queue GET, PUT and DELETE, queue purge, exchange PUT and DELETE, binding POST, GET and DELETE, and PUT /auth/tokens. It has nothing for users, vhosts, policies, permissions or CLI-only operations.
  - Why it matters: It cannot replace the HTTP API or the CLI. It is useful only for topology operations over an existing AMQP connection.
  - Sources: https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbit/src/rabbit_amqp_management.erl https://raw.githubusercontent.com/rabbitmq/rabbitmq-amqp-java-client/main/src/main/java/com/rabbitmq/client/amqp/impl/AmqpManagement.java
- **[high]** The management HTTP API refuses cross-origin browser requests by default. Origins must be listed with management.cors.allow_origins.N (max_age defaults to 1800 s). 4.3.2 hardened CORS further, and AMQP over WebSocket is Tanzu-only.
  - Why it matters: A web version cannot call arbitrary brokers from the browser, so it needs a server-side backend or proxy for both HTTP and AMQP features.
  - Sources: https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/src/rabbit_mgmt_cors.erl https://www.rabbitmq.com/docs/management https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.3.2.md https://www.rabbitmq.com/blog/2025/04/16/amqp-websocket
- **[high]** Disabling management stats strips more than rates. Before 4.3.0, policy fields and delivery_limit disappeared from queue responses (#15182, fixed in #15651). Channels endpoints returned 400 until 4.3.6. Static connection info appears with stats off only from 4.3. Message counts require management.enable_queue_totals=true.
  - Why it matters: The tool's data model and UI must degrade per version and stats mode, or it will show wrong or empty data.
  - Sources: https://github.com/rabbitmq/rabbitmq-server/issues/15182 https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.3.0.md https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.3.6.md https://www.rabbitmq.com/docs/management
- **[high]** On 2026-09-23 the core team stated: 'modernizing the UI without any meaningful UI changes will be the first step. A completely new UI prototype will most likely ship later, and take a long time to evaluate'. TypeScript prototypes (Vue and React) exist.
  - Why it matters: Suggests a multi-year window before the official UI closes UX gaps, and a risk to watch.
  - Sources: https://github.com/rabbitmq/rabbitmq-server/issues/2619 https://github.com/rabbitmq/rabbitmq-server/issues/17533
- **[high]** As of 2026-10-16 the latest GA is RabbitMQ 4.3.6 (2026-09-14). 4.2.x is still patched (4.2.9 on 2026-07-20). 4.4.0 and 5.0.0 are alpha builds only. 4.3 is Khepri-only.
  - Why it matters: Sets the version support matrix and test targets (4.0–4.3 GA plus 4.4 forward compatibility).
  - Sources: https://api.github.com/repos/rabbitmq/rabbitmq-server/tags?per_page=60 https://github.com/rabbitmq/server-packages/releases https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.3.0.md
- **[high]** List endpoints paginate with a default page_size of 100 and a maximum of 500, filtered by name and use_regex. GET /api/queues returns a reduced field set (since 3.13); /api/queues/detailed or /api/queues/{vhost} return 50+ fields.
  - Why it matters: Drives the data-loading strategy for clusters with tens of thousands of queues and the search-index design.
  - Sources: https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/http-api-reference.md https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/3.13.0.md
- **[high]** There is no official JSON schema or OpenAPI spec for the management HTTP API. Issue #2622 has been open since 2016 and was assigned on 2026-02-20.
  - Why it matters: Typed API models must be hand-maintained or borrowed from rabbitmq-http-api-rs, and version regressions must be tested.
  - Sources: https://github.com/rabbitmq/rabbitmq-server/issues/2622 https://github.com/michaelklishin/rabbitmq-http-api-rs
- **[medium]** Unless management.credential_encryption_secret is set (schema key; the docs write credentials_encryption_secret), the official UI stores the Base64-encoded username:password in browser localStorage and sends it on every request.
  - Why it matters: A security differentiator for credential handling (OS keychain or vault) and an argument for teams to adopt the tool.
  - Sources: https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/management/index.md https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/priv/schema/rabbitmq_management.schema
- **[high]** Tanzu RabbitMQ 4.3 (commercial) adds these to the management UI: a Stream Browser, a Linter, JMS queue type pages with a queue browser, and Delayed queue pages. AMQP 1.0 over WebSocket (rabbitmq_web_amqp) is also commercial-only.
  - Why it matters: Shows where the vendor sees value, and that these features are not available to open-source users.
  - Sources: https://www.rabbitmq.com/blog/2026/04/23/rabbitmq-4.3-release https://techdocs.broadcom.com/us/en/vmware-tanzu/data-solutions/tanzu-rabbitmq-oci/4-3/tanzu-rabbitmq-oci-image/site-release-notes.html https://techdocs.broadcom.com/us/en/vmware-tanzu/data-solutions/tanzu-rabbitmq-oci/4-3/tanzu-rabbitmq-oci-image/site-jms.html https://www.rabbitmq.com/blog/2025/04/16/amqp-websocket

## Open questions

- Exact release in which management.credential_encryption_secret shipped, and whether the docs' 'credentials_encryption_secret' spelling is a typo. The schema uses the singular form.
- Does GET /api/config/effective (rabbit:environment()) redact secrets such as default_pass or LDAP and OAuth client secrets? The handler showed no redaction step.
- Will 4.4 or 5.0 move management_metrics_collection to denied_by_default, and is there a dated plan for the new UI prototype?
- Does 4.4 make GET /api/auth/hash_password/{password} a breaking change in favour of POST? One read of the 4.4.0 draft notes said so, another did not. Main has both routes.
- Precise 4.0–4.2 semantics: did basic.nack(requeue=true) increment x-delivery-count on quorum queues? The versioned docs pages appear to serve current text. Needs a live test on 4.0, 4.1 and 4.2.
- What exactly does POST /api/queues/{v}/{stream}/get return for streams (an error, or messages)? The UI disables it but the API behaviour was not verified.
- Does the vhost 'tracing' flag set over HTTP turn on the firehose cluster-wide, or only on the node that receives the request?
- The full set of settings keys returned in /api/overview (for reliable stats-mode and restriction detection) was not enumerated.
- Which HTTP API endpoints do managed services (CloudAMQP, Amazon MQ for RabbitMQ 4.3, Azure or GCP marketplace offers) block or alter? Out of scope here, but important for compatibility.
- Is the Prometheus per-queue 'incoming' rate gap (#8691) now covered, for example by summing queue_exchange_metrics?
- Complaint evidence is limited: the shared WebSearch budget ran out, GitHub Discussions could not be searched, and StackOverflow could not be fetched. Community pain points beyond GitHub issues still need validation (Reddit, Discord, StackOverflow).
- UI-level details not verified: whether the official UI exposes auth-attempt stats or the vhost deletion-protection toggle anywhere. The vhost list form lacks the toggle.

## Sources

- https://www.rabbitmq.com/docs/management
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/management/index.md
- https://www.rabbitmq.com/docs/http-api-reference
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/http-api-reference.md
- https://www.rabbitmq.com/blog/2026/04/23/rabbitmq-4.3-release
- https://www.rabbitmq.com/blog
- https://www.rabbitmq.com/blog/2025/04/15/rabbitmq-4.1.0-is-released
- https://www.rabbitmq.com/blog/2025/04/16/amqp-websocket
- https://www.rabbitmq.com/blog/2024/08/05/native-amqp
- https://www.rabbitmq.com/blog/2021/08/21/4.0-deprecation-announcements
- https://github.com/rabbitmq/rabbitmq-server/releases
- https://api.github.com/repos/rabbitmq/rabbitmq-server/tags?per_page=60
- https://github.com/rabbitmq/server-packages/releases
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/3.13.0.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.0.1.md
- https://github.com/rabbitmq/rabbitmq-server/releases/tag/v4.0.1
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.1.0.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.2.0.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.2.9.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.3.0.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.3.1.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.3.2.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.3.3.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.3.4.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.3.5.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.3.6.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.4.0.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/5.0.0.md
- https://www.rabbitmq.com/docs/deprecated-features
- https://www.rabbitmq.com/release-information/deprecated-features-list
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/release-information/deprecated-features-list.md
- https://github.com/rabbitmq/rabbitmq-server/pull/7390
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management_agent/src/rabbit_mgmt_agent_config.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.x/deps/rabbitmq_management_agent/src/rabbit_mgmt_agent_config.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.4.x/deps/rabbitmq_management_agent/src/rabbit_mgmt_agent_config.erl
- https://www.rabbitmq.com/docs/prometheus
- https://www.rabbitmq.com/docs/monitoring
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/src/rabbit_mgmt_dispatcher.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.0.x/deps/rabbitmq_management/src/rabbit_mgmt_dispatcher.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.1.x/deps/rabbitmq_management/src/rabbit_mgmt_dispatcher.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.x/deps/rabbitmq_management/src/rabbit_mgmt_dispatcher.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.x/deps/rabbitmq_management/src/rabbit_mgmt_dispatcher.erl
- https://api.github.com/repos/rabbitmq/rabbitmq-server/contents/deps/rabbitmq_management/src
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/priv/www/js/dispatcher.js
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/priv/www/js/global.js
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/priv/www/js/tmpl/layout.ejs
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/priv/www/js/tmpl/queue.ejs
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/priv/www/js/tmpl/classic-queue-get-message.ejs
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/priv/www/js/tmpl/vhosts.ejs
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/priv/www/js/tmpl/node.ejs
- https://api.github.com/repos/rabbitmq/rabbitmq-server/contents/deps/rabbitmq_management/priv/www/js/tmpl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/src/rabbit_mgmt_wm_queue_get.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/src/rabbit_mgmt_wm_exchange_publish.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/src/rabbit_mgmt_cors.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/src/rabbit_mgmt_features.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/src/rabbit_mgmt_wm_overview.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/priv/schema/rabbitmq_management.schema
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.x/deps/rabbitmq_management/src/rabbit_mgmt_wm_version.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.x/deps/rabbitmq_management/src/rabbit_mgmt_wm_environment.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.x/deps/rabbitmq_management/src/rabbit_mgmt_wm_quorum_queue_status.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.x/deps/rabbitmq_management/src/rabbit_mgmt_wm_quorum_queue_replicas_grow.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.x/deps/rabbitmq_management/src/rabbit_mgmt_wm_quorum_queue_replicas_add_member.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.x/deps/rabbitmq_management/src/rabbit_mgmt_wm_quorum_queue_replicas_shrink.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.x/deps/rabbitmq_management/src/rabbit_mgmt_wm_health_check_reached_target_cluster_size.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_shovel_management/priv/www/js/shovel.js
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_shovel_management/src/rabbit_shovel_mgmt_shovels.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_shovel_management/src/rabbit_shovel_mgmt_shovel.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_federation_management/priv/www/js/federation.js
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_federation_management/src/rabbit_federation_mgmt.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_stream_management/priv/www/js/stream.js
- https://api.github.com/repos/rabbitmq/rabbitmq-server/contents/deps/rabbitmq_stream_management/src
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_stream_management/src/rabbit_stream_super_stream_mgmt.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_stream_management/src/rabbit_stream_tracking_mgmt.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_top/src/rabbit_top_extension.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_top/priv/www/js/top.js
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_tracing/src/rabbit_tracing_mgmt.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_tracing/priv/www/js/tracing.js
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbit/src/rabbit_amqp_management.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbit/src/rabbit_vhost.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-amqp-java-client/main/src/main/java/com/rabbitmq/client/amqp/impl/AmqpManagement.java
- https://www.rabbitmq.com/client-libraries/amqp-client-libraries
- https://www.rabbitmq.com/docs/amqp
- https://www.rabbitmq.com/docs/oauth2
- https://www.rabbitmq.com/docs/quorum-queues
- https://www.rabbitmq.com/docs/4.2/quorum-queues
- https://www.rabbitmq.com/docs/4.0/quorum-queues
- https://www.rabbitmq.com/docs/streams
- https://www.rabbitmq.com/docs/man/rabbitmq-queues.8
- https://www.rabbitmq.com/docs/man/rabbitmq-streams.8
- https://www.rabbitmq.com/docs/man/rabbitmq-diagnostics.8
- https://www.rabbitmq.com/docs/man/rabbitmq-upgrade.8
- https://www.rabbitmq.com/docs/man/rabbitmqctl.8
- https://www.rabbitmq.com/docs/cli
- https://www.rabbitmq.com/docs/event-exchange
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/event-exchange.md
- https://www.rabbitmq.com/docs/logging
- https://www.rabbitmq.com/docs/logging#internal-events
- https://www.rabbitmq.com/docs/firehose
- https://www.rabbitmq.com/docs/definitions
- https://www.rabbitmq.com/docs/access-control
- https://www.rabbitmq.com/docs/management-cli
- https://github.com/rabbitmq/rabbitmqadmin-ng
- https://raw.githubusercontent.com/rabbitmq/rabbitmqadmin-ng/main/CHANGELOG.md
- https://api.github.com/repos/rabbitmq/rabbitmqadmin-ng/releases?per_page=5
- https://github.com/michaelklishin/rabbitmq-http-api-rs
- https://raw.githubusercontent.com/michaelklishin/rabbitmq-http-api-rs/main/src/responses/cluster.rs
- https://github.com/rabbitmq/rabbitmq-server/issues/2619
- https://github.com/rabbitmq/rabbitmq-server/issues/17533
- https://github.com/rabbitmq/rabbitmq-server/issues/2622
- https://github.com/rabbitmq/rabbitmq-server/issues/8691
- https://github.com/rabbitmq/rabbitmq-server/issues/15182
- https://github.com/rabbitmq/rabbitmq-server/pull/16083
- https://github.com/rabbitmq/rabbitmq-server/pull/14282
- https://github.com/rabbitmq/rabbitmq-server/pull/14545
- https://github.com/rabbitmq/rabbitmq-server/pull/13465
- https://api.github.com/search/issues?q=repo:rabbitmq/rabbitmq-server+%22management+UI%22+is:issue&sort=reactions-%2B1&order=desc&per_page=60
- https://api.github.com/search/issues?q=repo:rabbitmq/rabbitmq-server+management+UI+in:title+created:%3E2024-06-01&sort=created&order=desc&per_page=60
- https://api.github.com/search/issues?q=repo:rabbitmq/rabbitmq-server+is:issue+%22management%22+in:title+created:%3E2024-01-01&sort=comments&order=desc&per_page=50
- https://api.github.com/search/issues?q=repo:rabbitmq/rabbitmq-server+label:usability+%22management%22&sort=created&order=desc&per_page=40
- https://api.github.com/search/issues?q=repo:rabbitmq/rabbitmq-server+%22get+messages%22+OR+%22message+browser%22+OR+%22browse+messages%22+OR+%22peek%22&sort=created&order=desc&per_page=40
- https://api.github.com/search/issues?q=repo:rabbitmq/rabbitmq-management+is:issue&sort=reactions-%2B1&order=desc&per_page=50
- https://techdocs.broadcom.com/us/en/vmware-tanzu/data-solutions/tanzu-rabbitmq-oci/4-3/tanzu-rabbitmq-oci-image/site-stream-browser.html
- https://techdocs.broadcom.com/us/en/vmware-tanzu/data-solutions/tanzu-rabbitmq-oci/4-3/tanzu-rabbitmq-oci-image/site-jms.html
- https://techdocs.broadcom.com/us/en/vmware-tanzu/data-solutions/tanzu-rabbitmq-oci/4-3/tanzu-rabbitmq-oci-image/site-delayed-queues.html
- https://techdocs.broadcom.com/us/en/vmware-tanzu/data-solutions/tanzu-rabbitmq-oci/4-3/tanzu-rabbitmq-oci-image/site-release-notes.html
- https://github.com/Ralve-org/RabbitScout
- https://endoflife.date/rabbitmq
