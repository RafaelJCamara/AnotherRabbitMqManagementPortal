# Feature catalogue (147 features)

Milestones are re-tagged for the web-first order ([ADR-030](../adr/ADR-030-web-first-delivery-order.md)); the design-phase tag is kept for traceability. Parity tags: `official-ui-parity`, `desktop-tools-parity` (table stakes in existing desktop tools), `beyond`, `unique`. Dependency corrections from the final critique are applied (TAP-04, TEAM-01, DLQ-08, EXP-05).

## Connections & environments (9)

| ID | Feature | Milestone | Parity | Size | Personas |
| --- | --- | --- | --- | --- | --- |
| CON-01 | Connection profiles | M0 | desktop-tools-parity | M | DEV,OPS |
| CON-02 | Environment chrome and production lock | M0 | desktop-tools-parity | S | DEV,OPS,SEC |
| CON-03 | Capability probe and BrokerProfile | M0 | unique | L | ALL |
| CON-04 | Secret vault and connection bundles | M0 | beyond | M | DEV,SEC |
| CON-05 | TLS trust store and mTLS | M1 | beyond | M | OPS,PLAT |
| CON-06 | Dialer: SSH, SOCKS5, HTTP CONNECT | M1 | beyond | L | DEV,OPS |
| CON-07 | Broker identity providers and TokenManager | M1 | beyond | L | DEV,OPS,SEC |
| CON-08 | Kubernetes discovery and port-forward | M4 | beyond | M | DEV,PLAT |
| CON-09 | Provider adapters and presets | M4 | unique | M | OPS,PLAT |

#### CON-01 Connection profiles

- **Milestone:** M0 (design-phase tag: M0) · **Size:** M · **Parity:** desktop-tools-parity · **Personas:** DEV,OPS
- **Description:** Profiles with separate HTTP and AMQP endpoints and credentials. Paste an amqp(s):// URI or a management URL; AMQP ports are derived from /api/overview listeners. HTTP and AMQP are tested separately.
- **Depends on:** PLAT-04, PLAT-05
- **Safety notes:** Separate HTTP/AMQP creds (DC-37)
- **Acceptance criteria:**
  - Given a pasted amqps URI, when saved, then host, vhost, TLS and the derived management URL are filled and each is tested separately with a specific error
  - Given HTTP OK but 5672 blocked, when testing, then the result says 'AMQP port blocked' and the AMQP features are disabled with a reason

#### CON-02 Environment chrome and production lock

- **Milestone:** M0 (design-phase tag: M0) · **Size:** S · **Parity:** desktop-tools-parity · **Personas:** DEV,OPS,SEC
- **Description:** DEV/TEST/STAGE/PROD tags with a colour, label and icon. Prod is locked read-only by default with a per-session, audited unlock. The switcher keeps the open entity.
- **Depends on:** -
- **Safety notes:** Peeks count as mutations under the lock (DC-42)
- **Acceptance criteria:**
  - Given a PROD profile, when opened, then every mutating action including peek is disabled until an unlock dialog is confirmed
  - Given orders.q is open on staging, when switching to prod, then orders.q opens on prod if it exists

#### CON-03 Capability probe and BrokerProfile

- **Milestone:** M0 (design-phase tag: M0) · **Size:** L · **Parity:** unique · **Personas:** ALL
- **Description:** A read-only probe sequence (§j.2) builds a cached profile: product, provider, version, tags, LB fronting, nodes, plugins, extensions, flags, stats mode, restrictions and limits. Every gate shows why it is disabled.
- **Depends on:** PLAT-04
- **Safety notes:** Write-shaped probes only on demand (DC-31)
- **Acceptance criteria:**
  - Given Amazon MQ 4.2, when connecting, then streams, firehose and event audit are disabled with source-linked reasons and operator-policy edits show the 405 remediation
  - Given repeated /api/overview calls returning different node names, then the profile marks the cluster LB-fronted and labels node-local results

#### CON-04 Secret vault and connection bundles

- **Milestone:** M0 (design-phase tag: M0) · **Size:** M · **Parity:** beyond · **Personas:** DEV,SEC
- **Description:** AES-256-GCM secrets with the data key wrapped by safeStorage async or @napi-rs/keyring; a master password on Linux basic_text. Bundles can be exported with secrets excluded or passphrase-encrypted.
- **Depends on:** -
- **Safety notes:** DC-45; no tokens in localStorage
- **Acceptance criteria:**
  - Given Linux reports basic_text, when the first secret is saved, then a master password is required
  - Given a bundle export, when secrets are excluded, then the file contains no password, token or URI credentials (checked by a scanner test)

#### CON-05 TLS trust store and mTLS

- **Milestone:** M1 (design-phase tag: M1) · **Size:** M · **Parity:** beyond · **Personas:** OPS,PLAT
- **Description:** CA import (including the IBM CA from a connection string), server-name override, client certificates (PEM/PKCS#12) and certificate diagnostics. The insecure switch is explicit and shows a banner.
- **Depends on:** CON-01
- **Safety notes:** No leaf pinning; concatenate CAs (DC-44)
- **Acceptance criteria:**
  - Given a private CA imported, when connecting by IP with an SNI override, then the TLS handshake verifies and system CAs remain trusted
  - Given the insecure flag, then a persistent banner shows and the receipt records it

#### CON-06 Dialer: SSH, SOCKS5, HTTP CONNECT

- **Milestone:** M1 (design-phase tag: M1) · **Size:** L · **Parity:** beyond · **Personas:** DEV,OPS
- **Description:** A single dialer for all sockets: ssh2 jump chains and agents, system OpenSSH -W for certificates and FIDO, SOCKS5 and HTTP CONNECT. SNI is preserved.
- **Depends on:** PLAT-05
- **Safety notes:** Tunnels make clients 'local' (guest/ANONYMOUS) - warn (DC-43)
- **Acceptance criteria:**
  - Given a two-hop SSH profile, when connecting, then HTTP, AMQP 0-9-1 and AMQP 1.0 all traverse the tunnel
  - Given the system-OpenSSH mode with ProxyJump, then the connection succeeds on Windows, macOS and Linux

#### CON-07 Broker identity providers and TokenManager

- **Milestone:** M1 (design-phase tag: M1) · **Size:** L · **Parity:** beyond · **Personas:** DEV,OPS,SEC
- **Description:** Providers: password, OAuth PKCE loopback in the system browser, device code, client credentials, token command, static token and x509/EXTERNAL. OAuth is discovered via bootstrap.js with issuer pinning. Tokens refresh per protocol.
- **Depends on:** CON-01
- **Safety notes:** DC-37, DC-38, DC-39; Bearer preferred; token-size warnings
- **Acceptance criteria:**
  - Given a 4.3 broker with Keycloak, when the token nears expiry, then update-secret refreshes AMQP 0-9-1 without dropping taps and the username claim is asserted unchanged
  - Given a broker advertising an issuer not on the allow-list, then login is blocked until the user confirms and pins it

#### CON-08 Kubernetes discovery and port-forward

- **Milestone:** M4 (design-phase tag: M2) · **Size:** M · **Parity:** beyond · **Personas:** DEV,PLAT
- **Description:** Lists RabbitmqCluster resources from the kubeconfig. Port-forwards per pod for 15672, 5672 and 5552. Reads the default-user secret only with explicit consent.
- **Depends on:** CON-06
- **Safety notes:** Consent before reading secrets
- **Acceptance criteria:**
  - Given a kubeconfig with a RabbitmqCluster, when discovering, then a profile is created with per-pod forwards
  - Given consent was not given, then no Secret read is attempted

#### CON-09 Provider adapters and presets

- **Milestone:** M4 (design-phase tag: M2) · **Size:** M · **Parity:** unique · **Personas:** OPS,PLAT
- **Description:** Presets for Amazon MQ (ports, limits, owned objects, Prometheus 16001-16003), CloudAMQP (per-node hosts, shared limits), IBM (CA), LavinMQ and ApsaraMQ (AMQP-only mode). Shows usage against limits.
- **Depends on:** CON-03
- **Safety notes:** DC-12, DC-55; provider objects read-only (DC-54)
- **Acceptance criteria:**
  - Given Amazon MQ 4.x, then the connection budget assumes 10 consumers per channel and 512 KiB messages
  - Given LavinMQ, then the HTTP get adapter always sends requeue:true

## Explorer & search (7)

| ID | Feature | Milestone | Parity | Size | Personas |
| --- | --- | --- | --- | --- | --- |
| EXP-01 | IDE shell | M0 | beyond | L | ALL |
| EXP-02 | Cluster overview | M0 | official-ui-parity | M | OPS,DEV |
| EXP-03 | Entity grids and saved views | M0 | official-ui-parity | L | DEV,OPS |
| EXP-04 | Command palette, global search and keymap | M1 | desktop-tools-parity | M | ALL |
| EXP-05 | Linked navigation and deep links | M1 | beyond | M | ALL |
| EXP-06 | Entity detail tabs | M1 | desktop-tools-parity | M | DEV,OPS |
| EXP-07 | Inline docs, error explainer, show-as-API | M1 | beyond | S | DEV,OPS |

#### EXP-01 IDE shell

- **Milestone:** M0 (design-phase tag: M0) · **Size:** L · **Parity:** beyond · **Personas:** ALL
- **Description:** Activity bar, connection switcher, explorer tree, tabbed workspace with splits, bottom panel (jobs, receipts, tap, problems) and a status bar with the era badge. Layout is persisted per profile.
- **Depends on:** PLAT-03
- **Safety notes:** -
- **Acceptance criteria:**
  - Given a restart, when reopening, then tabs, splits and panel sizes are restored per profile
  - Given a 1280x720 window, then all regions remain usable with no horizontal page scroll

#### EXP-02 Cluster overview

- **Milestone:** M0 (design-phase tag: M0) · **Size:** M · **Parity:** official-ui-parity · **Personas:** OPS,DEV
- **Description:** Nodes, alarms, object totals, message totals, top backlogs, DLQ totals, a capability card and lint highlights. Works with stats off.
- **Depends on:** CON-03
- **Safety notes:** Stats-off aware (DC-32)
- **Acceptance criteria:**
  - Given management stats disabled on 4.2.9, then the overview renders totals via enable_queue_totals and labels rates 'from Prometheus' or 'unavailable'
  - Given an alarm, then a red banner names the node and the resource

#### EXP-03 Entity grids and saved views

- **Milestone:** M0 (design-phase tag: M0) · **Size:** L · **Parity:** official-ui-parity · **Personas:** DEV,OPS
- **Description:** AG Grid Community behind an adapter: queues, exchanges, bindings, connections. Server paging (≤500), columns=, disable_stats plus enable_queue_totals, regex filters, filter chips, column picker and saved views. An adaptive polling budget.
- **Depends on:** PLAT-04
- **Safety notes:** Never disable_stats on /api/channels <4.3.6 (DC-32)
- **Acceptance criteria:**
  - Given 20k queues, when scrolling and filtering, then p95 interaction is under 300 ms and no request exceeds page_size 500
  - Given a saved view, when reopened on another connection, then filters and columns apply

#### EXP-04 Command palette, global search and keymap

- **Milestone:** M1 (design-phase tag: M1) · **Size:** M · **Parity:** desktop-tools-parity · **Personas:** ALL
- **Description:** A VS Code-style CommandRegistry with when-contexts. Fuzzy word-start search across all connected clusters and entity types from a local index. A remappable JSON keymap with browser-safe alternates and a cheat sheet.
- **Depends on:** EXP-01
- **Safety notes:** -
- **Acceptance criteria:**
  - Given 'abau', when searching, then account.balance.update is ranked first with highlights
  - Given the browser build, then no default binding collides with a reserved browser chord (test list)

#### EXP-05 Linked navigation and deep links

- **Milestone:** M1 (design-phase tag: M1) · **Size:** M · **Parity:** beyond · **Personas:** ALL
- **Description:** Every entity name is a link. Breadcrumbs with vhost, back/forward history, URL routes on the web and an app:// scheme handoff on desktop.
- **Depends on:** -
- **Safety notes:** -
- **Acceptance criteria:**
  - Given a copied deep link, when opened in the team server, then the same entity and tab open after login
  - Given an app:// link, when clicked in the OS, then the desktop app focuses the entity

#### EXP-06 Entity detail tabs

- **Milestone:** M1 (design-phase tag: M1) · **Size:** M · **Parity:** desktop-tools-parity · **Personas:** DEV,OPS
- **Description:** Queue: Overview, Messages, Publish, Tap, Consumers, Routing, Config, Charts, Forecast, Lint. Exchange: Overview, Publish, Routing, Config. Stream: Browse, Consumers, Config.
- **Depends on:** EXP-01
- **Safety notes:** -
- **Acceptance criteria:**
  - Given a stream, then Messages is replaced by Browse and no get-based action is reachable
  - Given a feature gated off, then its tab shows the why-disabled reason

#### EXP-07 Inline docs, error explainer, show-as-API

- **Milestone:** M1 (design-phase tag: M1) · **Size:** S · **Parity:** beyond · **Personas:** DEV,OPS
- **Description:** Version-aware tooltips and typed inputs for x-arguments. Explains AMQP and HTTP errors (e.g. inequivalent arg, 405 restrictions). Each action can be shown as curl, rabbitmqadmin or a definitions snippet.
- **Depends on:** MSG-01
- **Safety notes:** -
- **Acceptance criteria:**
  - Given PRECONDITION_FAILED inequivalent arg, then the explainer shows the differing argument and a fix
  - Given a queue declare form, when 'Show as curl' is clicked, then an equivalent masked curl command is produced

## Message workbench: peek/browse (14)

| ID | Feature | Milestone | Parity | Size | Personas |
| --- | --- | --- | --- | --- | --- |
| MSG-01 | BrokerSemantics registry and era resolver | M0 | unique | L | ALL |
| MSG-02 | Peek preflight planner | M1 | unique | L | DEV,OPS |
| MSG-03 | Side-effect-aware classic-queue peek | M1 | desktop-tools-parity | M | DEV |
| MSG-04 | Quorum peek on 4.3+ | M1 | unique | M | DEV |
| MSG-05 | Quorum peek on 3.13 and 4.0-4.2 (budget eras) | M1 | unique | M | DEV,OPS |
| MSG-06 | Post-acquire guard, rescue and receipts | M1 | unique | M | DEV,OPS,SEC |
| MSG-07 | Message viewer and diff | M1 | desktop-tools-parity | M | DEV |
| MSG-08 | Payload codecs v1 | M1 | beyond | M | DEV |
| MSG-09 | Schema codecs: Protobuf and Avro | M4 | beyond | L | DEV |
| MSG-10 | Local message workspace | M1 | desktop-tools-parity | L | DEV |
| MSG-11 | Consume to workspace (extract) | M1 | desktop-tools-parity | M | DEV,OPS |
| MSG-12 | Move, copy and selective delete | M3 | beyond | M | DEV,OPS |
| MSG-13 | Product-aware HTTP get fallback | M1 | official-ui-parity | S | DEV |
| MSG-14 | Node agent: zero-side-effect QQ peek | M8 | unique | L | OPS |

#### MSG-01 BrokerSemantics registry and era resolver

- **Milestone:** M0 (design-phase tag: M0) · **Size:** L · **Parity:** unique · **Personas:** ALL
- **Description:** A data-driven registry keyed by era, queue type, settle action and distribution, with source citations and conformance test IDs. A conservative per-cluster era resolver (flags, machine version, mixed nodes).
- **Depends on:** CON-03, PLAT-06
- **Safety notes:** DC-01, DC-02; unknown builds -> 4.0-4.2
- **Acceptance criteria:**
  - Given a 4.3.6 cluster with rabbitmq_4.3.0 disabled, then the era resolves to 4.0-4.2
  - Given any registry cell without a passing conformance test, then the UI labels it 'unverified' and uses the conservative cell

#### MSG-02 Peek preflight planner

- **Milestone:** M1 (design-phase tag: M1) · **Size:** L · **Parity:** unique · **Personas:** DEV,OPS
- **Description:** An HTTP-only preflight covering type, exclusive owner, auto_delete, the delivery_limit stat, DLX topology, delayed retry, max-length/overflow, TTL, SAC/consumers, QQ quorum and size. Produces a plan with effects and gates.
- **Depends on:** MSG-01, POL-01, TOP-02
- **Safety notes:** DC-06, DC-07, DC-13, DC-14, DC-16
- **Acceptance criteria:**
  - Given a 4.3 QQ DLQ with a finite L ≤ source L, then the plan is blocked with W-OVERLIMIT and offers the delivery-limit -1 policy fix
  - Given a 3.13 QQ with x-delivery-limit=-1, then peek is refused with an explanation

#### MSG-03 Side-effect-aware classic-queue peek

- **Milestone:** M1 (design-phase tag: M1) · **Size:** M · **Parity:** desktop-tools-parity · **Personas:** DEV
- **Description:** basic.get×n on a dedicated peek connection, then one nack(multiple, requeue), a qos barrier and close. Target 5 s, hard abort 30 s via the engine watchdog. Default 20, max 500, 16 MiB.
- **Depends on:** MSG-02, PLAT-05
- **Safety notes:** Never return by close (DC-04, DC-05, DC-11)
- **Acceptance criteria:**
  - Given 100 ready CQ messages, when peeking 20, then they return in their original positions with redelivered=true (conformance cell)
  - Given an app quit mid-peek, then pending nacks are flushed before the connection closes

#### MSG-04 Quorum peek on 4.3+

- **Milestone:** M1 (design-phase tag: M1) · **Size:** M · **Parity:** unique · **Personas:** DEV
- **Description:** basic.get plus nack(requeue) or AMQP 1.0 credit N + drain + released. Delayed-retry aware. Over-limit messages trigger the guard. Never reject, modified(df=true) or close while holding.
- **Depends on:** MSG-02, MSG-06
- **Safety notes:** DC-03, DC-07, DC-14, DC-25
- **Acceptance criteria:**
  - Given a 4.3.6 QQ, when peeked twice, then x-acquired-count rises and x-delivery-count stays absent (conformance)
  - Given delayed-retry type 'all', then W-DELAY is shown and the plan lists the expected invisibility window

#### MSG-05 Quorum peek on 3.13 and 4.0-4.2 (budget eras)

- **Milestone:** M1 (design-phase tag: M1) · **Size:** M · **Parity:** unique · **Personas:** DEV,OPS
- **Description:** An explicit budget-consent dialog showing L and the attempts used per message. Caps 20/50 (admin 200), no auto-refresh. W-313 and W-TAIL are handled.
- **Depends on:** MSG-02, MSG-06
- **Safety notes:** DC-08, DC-16
- **Acceptance criteria:**
  - Given a 4.2.9 QQ with L=20, when the user declines consent, then no basic.get is sent
  - Given consent, then the receipt shows AC+1 per message and no message with AC≥L was returned

#### MSG-06 Post-acquire guard, rescue and receipts

- **Milestone:** M1 (design-phase tag: M1) · **Size:** M · **Parity:** unique · **Personas:** DEV,OPS,SEC
- **Description:** A per-message doom check by era. Stops acquisition and applies the pre-chosen rescue (confirmed copy to a classic quarantine queue on a separate connection, then ack). Every peek emits a receipt.
- **Depends on:** MSG-01
- **Safety notes:** AI and unattended runs never 'let RabbitMQ handle' (DC-09, DC-15)
- **Acceptance criteria:**
  - Given a doomed message, when rescue is selected, then a copy is confirmed in quarantine before the original is acked and the receipt records it
  - Given any peek, then the receipt lists era, method, AC/DC deltas, positions and hold time, and it is written to the audit log

#### MSG-07 Message viewer and diff

- **Milestone:** M1 (design-phase tag: M1) · **Size:** M · **Parity:** desktop-tools-parity · **Personas:** DEV
- **Description:** JSON tree, raw, hex and text views; 0-9-1 properties and headers or AMQP 1.0 sections; conversion-loss badges; lazy large bodies; a two-message diff.
- **Depends on:** -
- **Safety notes:** DC-26 loss disclosure
- **Acceptance criteria:**
  - Given a 10 MB body, then the preview is truncated and the full body streams on demand without freezing the UI
  - Given a stream message published via 0-9-1 with table headers, then a 'headers lost at write' badge is shown

#### MSG-08 Payload codecs v1

- **Milestone:** M1 (design-phase tag: M1) · **Size:** M · **Parity:** beyond · **Personas:** DEV
- **Description:** JSON, XML, text encodings, base64, hex, gzip/deflate/brotli (zstd experimental), MessagePack, CBOR and CloudEvents, chosen by content_type/encoding plus per-queue rules. Decoding runs in a worker.
- **Depends on:** -
- **Safety notes:** Never unpickle or PHP-unserialize
- **Acceptance criteria:**
  - Given content-encoding gzip and a msgpack body, then the decoded tree renders
  - Given a malformed payload, then the hex view is shown with the decode error inline

#### MSG-09 Schema codecs: Protobuf and Avro

- **Milestone:** M4 (design-phase tag: M2) · **Size:** L · **Parity:** beyond · **Personas:** DEV
- **Description:** Protobuf from .proto folders or descriptor sets (protobufjs/@bufbuild), Avro (avsc) with Confluent/Apicurio registries. Type mapping by header or routing-key rules; encode for publish.
- **Depends on:** MSG-08, EXT-01
- **Safety notes:** -
- **Acceptance criteria:**
  - Given a descriptor set and a type rule, then a protobuf message decodes to JSON and re-encodes byte-identical
  - Given a registry URL, then fetches go through the dialer egress policy

#### MSG-10 Local message workspace

- **Milestone:** M1 (design-phase tag: M1) · **Size:** L · **Parity:** desktop-tools-parity · **Personas:** DEV
- **Description:** Captured copies (peek, tap, extract) go to an encrypted SQLite store with retention. FTS5 search, facets (routing key, deaths, headers), JSONPath/CEL filters, saved queries. Export and import to JSON, NDJSON, CSV, TSV or XLSX, with redaction.
- **Depends on:** PLAT-02
- **Safety notes:** Masking on export; retention purge (DC-45)
- **Acceptance criteria:**
  - Given 50k captured messages, when filtering by a JSONPath, then results return within 1 s
  - Given an export with redaction rules, then masked fields never appear in the file

#### MSG-11 Consume to workspace (extract)

- **Milestone:** M1 (design-phase tag: M1) · **Size:** M · **Parity:** desktop-tools-parity · **Personas:** DEV,OPS
- **Description:** A destructive extract of N or all messages into the local journal. Each message is written durably before its ack; copies are labelled 'Local'. Throttled; resumable.
- **Depends on:** MSG-10
- **Safety notes:** Typed confirm in prod; ack only after journal fsync
- **Acceptance criteria:**
  - Given a crash mid-extract, then every acked message exists in the journal
  - Given a PROD profile, then extract requires an unlock and a typed queue name

#### MSG-12 Move, copy and selective delete

- **Milestone:** M3 (design-phase tag: M2) · **Size:** M · **Parity:** beyond · **Personas:** DEV,OPS
- **Description:** Move or copy selected or first-N messages to a queue, exchange, vhost or cluster using confirm-then-ack. Selective delete matches content and position, and aborts if the queue changed.
- **Depends on:** MSG-11, DLQ-04
- **Safety notes:** DC-27 mechanics; mandatory + returns
- **Acceptance criteria:**
  - Given a target rejecting with basic.return, then the source message is not acked and the job reports the failure
  - Given a selective delete where the head changed since the snapshot, then the job aborts without acking

#### MSG-13 Product-aware HTTP get fallback

- **Milestone:** M1 (design-phase tag: M1) · **Size:** S · **Parity:** official-ui-parity · **Personas:** DEV
- **Description:** Used only when AMQP is unreachable: ack_requeue_true, count ≤50, truncate, same preflight; requeue:true for LavinMQ. Not offered where over-limit messages are possible.
- **Depends on:** MSG-02
- **Safety notes:** DC-10, DC-55
- **Acceptance criteria:**
  - Given a LavinMQ broker, then the request body includes ackmode and requeue:true
  - Given a 4.3 QQ DLQ at risk of over-limit, then the HTTP fallback is hidden with a reason

#### MSG-14 Node agent: zero-side-effect QQ peek

- **Milestone:** M8 (design-phase tag: M6) · **Size:** L · **Parity:** unique · **Personas:** OPS
- **Description:** An optional, separately installed agent (SSH, kubectl exec or local Docker) runs rabbitmq-queues peek by position. It sees ready messages only. The only path labelled 'non-destructive' for QQs.
- **Depends on:** CON-06
- **Safety notes:** DC-15 wording allowed only here; cookie handling audited
- **Acceptance criteria:**
  - Given the agent, when peeking position 1-20, then QQ counters are unchanged (conformance)
  - Given a CQ, then the agent reports classic_queue_not_supported

## Message workbench: publish (7)

| ID | Feature | Milestone | Parity | Size | Personas |
| --- | --- | --- | --- | --- | --- |
| PUB-01 | Publish studio | M1 | desktop-tools-parity | M | DEV |
| PUB-02 | Publish history | M1 | desktop-tools-parity | S | DEV |
| PUB-03 | Collections, templates and variables | M4 | beyond | M | DEV,PLAT |
| PUB-04 | Bulk publish and data generator | M4 | beyond | M | DEV |
| PUB-05 | Consumer and RPC test bench | M4 | beyond | M | DEV |
| PUB-06 | AMQP 1.0 publisher | M4 | beyond | M | DEV |
| PUB-07 | Copy as code | M4 | beyond | S | DEV |

#### PUB-01 Publish studio

- **Milestone:** M1 (design-phase tag: M1) · **Size:** M · **Parity:** desktop-tools-parity · **Personas:** DEV
- **Description:** Monaco editor with JSON Schema validation; typed property inputs; header grid or JSON; the default exchange; routing-key autocomplete from bindings with topic hints; mandatory, confirms and returns; N copies.
- **Depends on:** PLAT-05
- **Safety notes:** Prod lock; separate publish connection (DC-12)
- **Acceptance criteria:**
  - Given mandatory and no binding match, then the UI shows 'returned: NO_ROUTE' instead of success
  - Given confirms, then the result distinguishes confirmed, nacked and returned

#### PUB-02 Publish history

- **Milestone:** M1 (design-phase tag: M1) · **Size:** S · **Parity:** desktop-tools-parity · **Personas:** DEV
- **Description:** A searchable history grouped by day, per profile, re-sendable, with secrets masked.
- **Depends on:** PUB-01
- **Safety notes:** -
- **Acceptance criteria:**
  - Given a previous publish, when 'Send again' is clicked, then the studio is prefilled
  - Given history retention of 30 days, then older entries are purged

#### PUB-03 Collections, templates and variables

- **Milestone:** M4 (design-phase tag: M2) · **Size:** M · **Parity:** beyond · **Personas:** DEV,PLAT
- **Description:** Saved messages with per-environment variables and faker functions, stored as plain-text files for git, and shareable on the team server.
- **Depends on:** PUB-01
- **Safety notes:** -
- **Acceptance criteria:**
  - Given a collection file in git, when opened, then the variables resolve per active environment
  - Given the same file, then the tool CLI can run it headless

#### PUB-04 Bulk publish and data generator

- **Milestone:** M4 (design-phase tag: M2) · **Size:** M · **Parity:** beyond · **Personas:** DEV
- **Description:** Publish from CSV, JSON, NDJSON or XLSX with column mapping, a token-bucket rate, confirms and resume. Generates messages from JSON Schema, Avro or Protobuf.
- **Depends on:** PUB-01, PLAT-02
- **Safety notes:** Blocked on PROD by default
- **Acceptance criteria:**
  - Given 100k rows at 500/s, then the job reports progress and resumes after a restart without duplicates
  - Given a PROD profile, then bulk publish requires an unlock and a typed confirmation

#### PUB-05 Consumer and RPC test bench

- **Milestone:** M4 (design-phase tag: M2) · **Size:** M · **Parity:** beyond · **Personas:** DEV
- **Description:** A temporary consumer with prefetch, ack mode and priority controls. A request/reply tester using direct reply-to (0-9-1, or AMQP 1.0 on 4.2+) with correlation and latency.
- **Depends on:** PLAT-05
- **Safety notes:** Consumers are destructive - labelled; never on prod by default
- **Acceptance criteria:**
  - Given an RPC test, then the reply is matched by correlation_id and the latency is shown
  - Given a test consumer with manual ack, then unacked messages are nacked explicitly on stop (DC-04)

#### PUB-06 AMQP 1.0 publisher

- **Milestone:** M4 (design-phase tag: M2) · **Size:** M · **Parity:** beyond · **Personas:** DEV
- **Description:** Publish via the in-house rhea adapter: v2 percent-encoded addresses, annotations and application properties, durable header, and per-outcome display (accepted/rejected/released).
- **Depends on:** STR-02
- **Safety notes:** -
- **Acceptance criteria:**
  - Given a queue name with spaces, then the address is percent-encoded and delivery succeeds
  - Given a 4.3 reject with a reason, then the outcome reason is shown

#### PUB-07 Copy as code

- **Milestone:** M4 (design-phase tag: M2) · **Size:** S · **Parity:** beyond · **Personas:** DEV
- **Description:** Generates publish, consume and declare snippets for amqplib, pika/aio-pika, Java amqp-client/Spring, RabbitMQ.Client 7/MassTransit, amqp091-go and php-amqplib.
- **Depends on:** -
- **Safety notes:** -
- **Acceptance criteria:**
  - Given a publish with headers, then each snippet compiles in its CI fixture
  - Given secrets in the profile, then snippets use placeholders

## Message workbench: tap (6)

| ID | Feature | Milestone | Parity | Size | Personas |
| --- | --- | --- | --- | --- | --- |
| TAP-01 | Tap planner | M1 | unique | M | DEV |
| TAP-02 | Copied-binding shadow tap | M1 | desktop-tools-parity | M | DEV |
| TAP-03 | Exchange-to-exchange tap mode | M4 | beyond | S | DEV |
| TAP-04 | Firehose capture | M4 | beyond | M | OPS |
| TAP-05 | Capture to stream (team) | M8 | unique | M | DEV,OPS |
| TAP-06 | Message lifecycle trace | M6 | beyond | M | DEV,OPS |

#### TAP-01 Tap planner

- **Milestone:** M1 (design-phase tag: M1) · **Size:** M · **Parity:** unique · **Personas:** DEV
- **Description:** Builds a TapPlan: source exchanges, types and binding args; simulated user/operator policy match on the tap name; alarm check; classic-type availability; permission check against configure regex.
- **Depends on:** POL-01, CON-03
- **Safety notes:** DC-17, DC-18
- **Acceptance criteria:**
  - Given a source of type x-consistent-hash, then the tap is refused unless diversion is explicitly accepted
  - Given a policy with reject-publish matching the tap name, then the plan shows the risk and the argument override

#### TAP-02 Copied-binding shadow tap

- **Milestone:** M1 (design-phase tag: M1) · **Size:** M · **Parity:** desktop-tools-parity · **Personas:** DEV
- **Description:** An exclusive classic queue: explicit prefix.tap.uuid, drop-head, max-length, TTL, x-expires. Bindings are copied with their arguments and re-synced. Ring buffer, pause, sampling counters. Badges for blind spots and masking. Orphan sweeper.
- **Depends on:** TAP-01
- **Safety notes:** DC-17, DC-19
- **Acceptance criteria:**
  - Given a headers exchange binding with x-match=all, then the tap binding carries the same arguments (conformance)
  - Given traffic via the default exchange, then the 'blind: default exchange' badge is shown and firehose is suggested

#### TAP-03 Exchange-to-exchange tap mode

- **Milestone:** M4 (design-phase tag: M2) · **Size:** S · **Parity:** beyond · **Personas:** DEV
- **Description:** An E2E tap on a tap exchange, for exchange-wide capture. Refused on CHX below 4.3.6 and on hash/random types.
- **Depends on:** TAP-01
- **Safety notes:** DC-18 (#17255)
- **Acceptance criteria:**
  - Given a 4.3.4 CHX source, then E2E mode is unavailable with a citation
  - Given stop or crash, then the tap exchange is swept on the next connect

#### TAP-04 Firehose capture

- **Milestone:** M4 (design-phase tag: M2) · **Size:** M · **Parity:** beyond · **Personas:** OPS
- **Description:** Admin-only, per node, leased with automatic switch-off. Enabled via the rabbitmq_tracing node routes or generated trace_on runbooks. State is tracked per node. PII warning.
- **Depends on:** TAP-02
- **Safety notes:** Never PUT /api/vhosts tracing (DC-20, DC-21)
- **Acceptance criteria:**
  - Given a 3-node cluster with tracing, when the lease expires, then tracing is disabled on all 3 nodes and verified
  - Given an LB-fronted cluster without the plugin, then runbooks per node are generated and the capture is labelled 'partial'

#### TAP-05 Capture to stream (team)

- **Milestone:** M8 (design-phase tag: M6) · **Size:** M · **Parity:** unique · **Personas:** DEV,OPS
- **Description:** Bind a retention-limited stream as a shared capture buffer that several people can replay non-destructively. Same routing caveats as taps; cleanup is scheduled.
- **Depends on:** TAP-02, STR-01, TEAM-01
- **Safety notes:** -
- **Acceptance criteria:**
  - Given a capture with max-age 1h, then it is deleted when the session ends or its TTL is reached
  - Given two users, then both can browse the capture by offset

#### TAP-06 Message lifecycle trace

- **Milestone:** M6 (design-phase tag: M4) · **Size:** M · **Parity:** beyond · **Personas:** DEV,OPS
- **Description:** Follow a message-id or correlation-id from publish through routing to delivery or dead-lettering using a time-boxed firehose or tap.
- **Depends on:** TAP-04, DLQ-02
- **Safety notes:** -
- **Acceptance criteria:**
  - Given a traced id, then publish, routed queues and deliver events are shown on a timeline
  - Given the lease ends, then tracing is switched off automatically

## DLQ operations centre (11)

| ID | Feature | Milestone | Parity | Size | Personas |
| --- | --- | --- | --- | --- | --- |
| DLQ-01 | DLQ inventory | M1 | beyond | M | DEV,OPS |
| DLQ-02 | Death history normaliser | M1 | desktop-tools-parity | S | DEV |
| DLQ-03 | Safe replay (basic) | M1 | desktop-tools-parity | M | DEV,OPS |
| DLQ-04 | Replay engine (full) | M3 | unique | L | OPS |
| DLQ-05 | Framework decoders v1.0 and header registry | M3 | unique | L | DEV |
| DLQ-06 | Framework decoders v1.1 | M6 | unique | M | DEV |
| DLQ-07 | Failure fingerprinting and grouping | M3 | unique | M | DEV,OPS |
| DLQ-08 | DLQ hazard advisor | M1 | unique | S | OPS,DEV |
| DLQ-09 | Edit and resend | M3 | beyond | M | DEV |
| DLQ-10 | Dead-letter analytics | M6 | beyond | M | OPS |
| DLQ-11 | Shovel-based server-side move | M6 | official-ui-parity | M | OPS |

#### DLQ-01 DLQ inventory

- **Milestone:** M1 (design-phase tag: M1) · **Size:** M · **Parity:** beyond · **Personas:** DEV,OPS
- **Description:** Discovers DLQs from DLX arguments, policies and naming conventions, with depth, inflow, sources and reasons. Detects queues managed by other systems (ServiceControl, Wolverine, providers) and makes them read-only by default.
- **Depends on:** TOP-02, POL-01
- **Safety notes:** DC-54
- **Acceptance criteria:**
  - Given a ServiceControl consumer on 'error', then the queue is badged 'managed by ServiceControl' and its actions are read-only
  - Given policies that set a DLX, then derived DLQs appear with their source queues

#### DLQ-02 Death history normaliser

- **Milestone:** M1 (design-phase tag: M1) · **Size:** S · **Parity:** desktop-tools-parity · **Personas:** DEV
- **Description:** Parses x-death, x-first/last-death-* and x-opt-deaths into one timeline (seconds vs ms). Flags client-published x-death as untrusted on 4.0+.
- **Depends on:** MSG-01
- **Safety notes:** -
- **Acceptance criteria:**
  - Given a 0-9-1 and a 1.0 dead letter, then both normalise to the same model with the newest entry first
  - Given a 4.x message with a client-set x-death, then it is marked untrusted

#### DLQ-03 Safe replay (basic)

- **Milestone:** M1 (design-phase tag: M1) · **Size:** M · **Parity:** desktop-tools-parity · **Personas:** DEV,OPS
- **Description:** Queue-first destination (framework field, newest rejected/delivery_limit death, convention) via the default exchange with mandatory. Confirm-then-ack, token-bucket throttle, header stripping, id preservation.
- **Depends on:** DLQ-02, PLAT-02
- **Safety notes:** DC-27, DC-28; exchange replay needs fan-out confirm
- **Acceptance criteria:**
  - Given a replay, then x-death*, x-delivery-count, x-acquired-count and a mismatched user_id are stripped and messageId is preserved
  - Given a basic.return, then the source is not acked and the job reports the failure

#### DLQ-04 Replay engine (full)

- **Milestone:** M3 (design-phase tag: M2) · **Size:** L · **Parity:** unique · **Personas:** OPS
- **Description:** Dry run on frozen identities, canary batch, journal, resumable jobs, auto-pause when replayed ids re-fail, provenance headers (switchable), honest undo by re-parking journaled copies.
- **Depends on:** DLQ-03
- **Safety notes:** Shovels deprioritised (DC-29)
- **Acceptance criteria:**
  - Given 5 replayed ids reappearing in the DLQ, then the job pauses and shows them
  - Given undo within retention, then journaled copies are re-parked to the DLQ and audited as such

#### DLQ-05 Framework decoders v1.0 and header registry

- **Milestone:** M3 (design-phase tag: M2) · **Size:** L · **Parity:** unique · **Personas:** DEV
- **Description:** Generic layer plus MassTransit, Spring AMQP/Cloud Stream, NServiceBus, EasyNetQ and Celery. Recognises delay and retry infrastructure. Publishes an open JSON failure-header registry.
- **Depends on:** EXT-01, DLQ-02
- **Safety notes:** DC-53; licence hygiene (no v9/RPL code)
- **Acceptance criteria:**
  - Given MassTransit v8 fixtures from CI apps, then the exception type, message and consumer are extracted
  - Given an expired death from nsb.v2.delay-level-05, then it is classified as scheduled, not failed

#### DLQ-06 Framework decoders v1.1

- **Milestone:** M6 (design-phase tag: M4) · **Size:** M · **Parity:** unique · **Personas:** DEV
- **Description:** Symfony (safe PHP tokeniser), Rebus, Wolverine, Laravel, Dramatiq (7-day XQ expiry warning) and Sneakers/Kicks.
- **Depends on:** DLQ-05
- **Safety notes:** -
- **Acceptance criteria:**
  - Given a PHP-serialized Symfony body, then stamps are read without unserialize
  - Given Dramatiq .XQ messages, then the remaining time before the 7-day TTL drop is shown

#### DLQ-07 Failure fingerprinting and grouping

- **Milestone:** M3 (design-phase tag: M2) · **Size:** M · **Parity:** unique · **Personas:** DEV,OPS
- **Description:** Groups by exception type, first application frame and a message template, with framework fallbacks. Flags new groups. Replays or parks a whole group.
- **Depends on:** DLQ-05
- **Safety notes:** -
- **Acceptance criteria:**
  - Given 300 messages with the same exception at different line numbers in framework frames, then they form one group
  - Given a group replay, then a canary of 1 runs before the throttled remainder

#### DLQ-08 DLQ hazard advisor

- **Milestone:** M1 (design-phase tag: M1) · **Size:** S · **Parity:** unique · **Personas:** OPS,DEV
- **Description:** Detects 4.3 QQ DLQs at limits ≤ source+1 and 4.0-4.2 budget exhaustion. Offers a one-click delivery-limit -1 policy (or a classic/stream DLQ) with a preview.
- **Depends on:** MSG-02, POL-01 (minimal impact preview per A-4)
- **Safety notes:** DC-07; NServiceBus policies are never overridden (DC-54)
- **Acceptance criteria:**
  - Given a 4.3 QQ DLQ with default L=20 fed by a QQ with L=20, then a blocking finding with the fix policy is shown
  - Given an nsb.* delivery-limit policy, then no fix is offered that overrides it

#### DLQ-09 Edit and resend

- **Milestone:** M3 (design-phase tag: M2) · **Size:** M · **Parity:** beyond · **Personas:** DEV
- **Description:** Edit body, headers or properties and republish with a new id and a link header to the failed id. Body-embedded counters are labelled as edits in the audit log.
- **Depends on:** DLQ-03
- **Safety notes:** -
- **Acceptance criteria:**
  - Given an edited message, then it gets a new message id and an x-<tool>-edit-of header
  - Given the audit log, then the diff of the edit is recorded with masking applied

#### DLQ-10 Dead-letter analytics

- **Milestone:** M6 (design-phase tag: M4) · **Size:** M · **Parity:** beyond · **Personas:** OPS
- **Description:** Reasons, sources, groups and inflow trends over time from history, with one-click replay of a slice.
- **Depends on:** MON-03, DLQ-07
- **Safety notes:** -
- **Acceptance criteria:**
  - Given 7 days of history, then a trend by reason and group is shown
  - Given a selected slice, then the replay dry run is prefilled

#### DLQ-11 Shovel-based server-side move

- **Milestone:** M6 (design-phase tag: M4) · **Size:** M · **Parity:** official-ui-parity · **Personas:** OPS
- **Description:** A capability-gated self-deleting dynamic or local shovel for large moves, with progress via /api/shovels and cleanup. Blocked on 4.3.0-4.3.6.
- **Depends on:** ADM-12
- **Safety notes:** DC-29
- **Acceptance criteria:**
  - Given a 4.3.5 broker, then shovel mode is unavailable citing #17794
  - Given 4.2.9 with local shovels, then the move completes and the shovel is removed

## Streams (6)

| ID | Feature | Milestone | Parity | Size | Personas |
| --- | --- | --- | --- | --- | --- |
| STR-01 | Stream browser via 0-9-1 | M1 | beyond | M | DEV |
| STR-02 | In-house AMQP 1.0 adapter on rhea | M1 | unique | L | DEV |
| STR-03 | Stream filter builder | M4 | unique | M | DEV |
| STR-04 | Stream protocol fast path | M6 | beyond | M | DEV |
| STR-05 | Stream operations panel | M4 | official-ui-parity | M | OPS |
| STR-06 | Stream range replay | M6 | unique | M | OPS,DEV |

#### STR-01 Stream browser via 0-9-1

- **Milestone:** M1 (design-phase tag: M1) · **Size:** M · **Parity:** beyond · **Personas:** DEV
- **Description:** x-stream-offset (first, last, next, offset, timestamp in seconds, interval) with manual ack and prefetch >0. Live tail, range export and a 'no local replica' helper that names the replica nodes.
- **Depends on:** PLAT-05
- **Safety notes:** Never basic.get on streams (DC-11); anonymous only (DC-22)
- **Acceptance criteria:**
  - Given a 3.13.7 stream, when reading from a timestamp, then messages from that time are shown and no offset is stored
  - Given a node without a replica, then the error names the nodes that host one

#### STR-02 In-house AMQP 1.0 adapter on rhea

- **Milestone:** M1 (design-phase tag: M1) · **Size:** L · **Parity:** unique · **Personas:** DEV
- **Description:** vhost via the hostname, credit_window 0, explicit credit and drain, described filter values, ulong offsets, ms timestamps, percent-encoded addresses, EXTERNAL. The applied filter-set is compared on attach.
- **Depends on:** PLAT-05
- **Safety notes:** DC-22 to DC-25
- **Acceptance criteria:**
  - Given 4.3.6, when attaching with a Bloom filter, then the attach reply lists it applied, or the read fails with 'broker ignored filter X'
  - Given a peek of N, then at most N deliveries are acquired (credit test)

#### STR-03 Stream filter builder

- **Milestone:** M4 (design-phase tag: M2) · **Size:** M · **Parity:** unique · **Personas:** DEV
- **Description:** Compose Bloom (3.13+), property filters (4.1+) and SQL (4.2+). Explains server vs client stages and false positives; a client-side body search follows.
- **Depends on:** STR-02
- **Safety notes:** -
- **Acceptance criteria:**
  - Given 4.1.8, then the SQL option is disabled with a version reason
  - Given property and SQL chosen together, then the builder rejects them as mutually exclusive

#### STR-04 Stream protocol fast path

- **Milestone:** M6 (design-phase tag: M4) · **Size:** M · **Parity:** beyond · **Personas:** DEV
- **Description:** rabbitmq-stream-js-client as an optional path, enabled only when the probe confirms every advertised host:port is reachable. Load-balancer resolver; reconnect before token expiry.
- **Depends on:** STR-01
- **Safety notes:** Anonymous consumers only (DC-22)
- **Acceptance criteria:**
  - Given an unresolvable advertised_host, then the fast path stays off and AMQP is used
  - Given a large range, then throughput is at least 3x the AMQP path in the benchmark

#### STR-05 Stream operations panel

- **Milestone:** M4 (design-phase tag: M2) · **Size:** M · **Parity:** official-ui-parity · **Personas:** OPS
- **Description:** Stream connections, publishers, consumers, offsets and lag. Super-stream detection and creation (4.1+). CLI runbooks for replica, status and restart.
- **Depends on:** ADM-15
- **Safety notes:** -
- **Acceptance criteria:**
  - Given 4.1+, then a super stream with N partitions can be created via HTTP
  - Given a CLI-only operation, then a copyable rabbitmq-streams command with context is generated

#### STR-06 Stream range replay

- **Milestone:** M6 (design-phase tag: M4) · **Size:** M · **Parity:** unique · **Personas:** OPS,DEV
- **Description:** Replays a filtered stream range into an exchange or queue with throttling, confirms and provenance headers.
- **Depends on:** STR-03, DLQ-04
- **Safety notes:** -
- **Acceptance criteria:**
  - Given offsets 100-200 filtered by a property, then only matching messages are republished with confirms
  - Given a PROD target, then approval rules apply

## Topology & routing simulator (4)

| ID | Feature | Milestone | Parity | Size | Personas |
| --- | --- | --- | --- | --- | --- |
| TOP-01 | Topology graph | M1 | desktop-tools-parity | L | ALL |
| TOP-02 | Routing simulator | M1 | unique | L | DEV |
| TOP-03 | Routing tab and binding CRUD | M1 | official-ui-parity | M | DEV,OPS |
| TOP-04 | Live flow overlay | M6 | beyond | M | OPS |

#### TOP-01 Topology graph

- **Milestone:** M1 (design-phase tag: M1) · **Size:** L · **Parity:** desktop-tools-parity · **Personas:** ALL
- **Description:** Cytoscape with an ELK worker (dagre fallback) and WebGL detection. Exchanges, queues, E2E, AE, DLX and shovel/federation edges, consumers, focus up/downstream. Export PNG/SVG/Mermaid with an accessible tree alternative.
- **Depends on:** EXP-01
- **Safety notes:** elkjs separate asset (DC-51)
- **Acceptance criteria:**
  - Given 5k elements, then the layout completes off the main thread and pan/zoom stays above 30 fps
  - Given a screen reader, then the tree alternative exposes the same edges

#### TOP-02 Routing simulator

- **Milestone:** M1 (design-phase tag: M1) · **Size:** L · **Parity:** unique · **Personas:** DEV
- **Description:** Pure evaluation of direct, topic, fanout and headers exchanges; E2E chains; AE; the default exchange; CC/BCC; DLX and TTL paths; loops; hash and random notes. An optional verification probe publish with mandatory.
- **Depends on:** PLAT-04
- **Safety notes:** -
- **Acceptance criteria:**
  - Given conformance fixtures of bindings, then the simulator's matches equal the broker's routed_queues (firehose) for 100% of cases
  - Given an unroutable key, then the AE path or 'unroutable' is shown

#### TOP-03 Routing tab and binding CRUD

- **Milestone:** M1 (design-phase tag: M1) · **Size:** M · **Parity:** official-ui-parity · **Personas:** DEV,OPS
- **Description:** Bindings in and out with arguments, AE/DLX relations, and create/delete bindings, including on the canvas.
- **Depends on:** TOP-01
- **Safety notes:** -
- **Acceptance criteria:**
  - Given a headers binding, then its arguments are editable as typed fields
  - Given a delete, then a typed confirm is required on PROD

#### TOP-04 Live flow overlay

- **Milestone:** M6 (design-phase tag: M4) · **Size:** M · **Parity:** beyond · **Personas:** OPS
- **Description:** Edge thickness by rate over a selectable window. 'Who publishes here?' from connection names.
- **Depends on:** MON-01, TOP-01
- **Safety notes:** -
- **Acceptance criteria:**
  - Given Prometheus rates, then edges update at 1-4 Hz without relayout
  - Given an exchange, then the publishing connections are listed

## Policies & effective config (3)

| ID | Feature | Milestone | Parity | Size | Personas |
| --- | --- | --- | --- | --- | --- |
| POL-01 | Effective-config debugger | M1 | unique | L | OPS,DEV |
| POL-02 | Policy and operator-policy editor | M2 | official-ui-parity | M | OPS |
| POL-03 | Policy impact preview | M2 | unique | M | OPS |

#### POL-01 Effective-config debugger

- **Milestone:** M1 (design-phase tag: M1) · **Size:** L · **Parity:** unique · **Personas:** OPS,DEV
- **Description:** A pure resolver per key, queue type and version: operator+user merge, then the argument resolution rules, with provenance. Includes hypothetical names ('what applies if I declare X').
- **Depends on:** MSG-01
- **Safety notes:** Never present effective_policy_definition as effective (DC-30)
- **Acceptance criteria:**
  - Given a 4.0.8 QQ with arg max-length 500 and policy 1000, then the effective value is 500 with 'min' provenance
  - Given a 3.13 QQ with expires in arg and policy, then the policy wins

#### POL-02 Policy and operator-policy editor

- **Milestone:** M2 (design-phase tag: M2) · **Size:** M · **Parity:** official-ui-parity · **Personas:** OPS
- **Description:** Schema-aware keys per queue type and version (delayed-retry 4.3.1+, consumer timeout, priorities), a pattern tester, tie detection, and 405/restriction handling.
- **Depends on:** POL-01
- **Safety notes:** DC-13, DC-14; gate on is_op_policy_updating_enabled
- **Acceptance criteria:**
  - Given 4.3.0, then delayed-retry policy keys are not offered
  - Given two equal-priority matches, then a tie warning is shown

#### POL-03 Policy impact preview

- **Milestone:** M2 (design-phase tag: M2) · **Size:** M · **Parity:** unique · **Personas:** OPS
- **Description:** Shows which objects a draft matches and which effective values change. Warns when 3.13-era unlimited QQs would get the effective limit.
- **Depends on:** POL-01
- **Safety notes:** W-UPGRADED (DC-13)
- **Acceptance criteria:**
  - Given a draft, then a diff table of affected queues and values is shown before save
  - Given an upgraded unlimited QQ, then a warning names it

## Admin CRUD (15)

| ID | Feature | Milestone | Parity | Size | Personas |
| --- | --- | --- | --- | --- | --- |
| ADM-01 | Queue management | M1 | official-ui-parity | M | DEV,OPS |
| ADM-02 | Exchange management | M1 | official-ui-parity | S | DEV,OPS |
| ADM-03 | Bulk operations | M3 | desktop-tools-parity | M | OPS |
| ADM-04 | Virtual hosts | M2 | official-ui-parity | M | OPS |
| ADM-05 | Users and user limits | M2 | official-ui-parity | M | SEC,OPS |
| ADM-06 | Permissions matrix and access evaluator | M2 | beyond | M | SEC |
| ADM-07 | Connections, channels and sessions | M2 | official-ui-parity | M | OPS |
| ADM-08 | Consumer inspector | M2 | official-ui-parity | M | OPS,DEV |
| ADM-09 | Nodes and cluster settings | M2 | official-ui-parity | M | OPS |
| ADM-10 | Feature flags and deprecated features | M2 | official-ui-parity | S | OPS |
| ADM-11 | Definitions export and import | M3 | official-ui-parity | M | OPS,PLAT |
| ADM-12 | Shovels and federation | M3 | official-ui-parity | M | OPS |
| ADM-13 | Quorum replica and leader operations | M3 | official-ui-parity | M | OPS |
| ADM-14 | Health checks panel | M2 | official-ui-parity | S | OPS |
| ADM-15 | CLI runbook generator | M3 | unique | S | OPS |

#### ADM-01 Queue management

- **Milestone:** M1 (design-phase tag: M1) · **Size:** M · **Parity:** official-ui-parity · **Personas:** DEV,OPS
- **Description:** A type-aware declare wizard (QQ limit, delayed retry, timeout; stream retention; deprecated args flagged), plus purge and delete with typed confirm and an optional extract-before-purge.
- **Depends on:** POL-01
- **Safety notes:** Purge needs only read on the broker - audit (DC-40)
- **Acceptance criteria:**
  - Given 4.3, then x-queue-mode is rejected in the form with a reason
  - Given a purge on PROD, then the name must be typed and a receipt is stored

#### ADM-02 Exchange management

- **Milestone:** M1 (design-phase tag: M1) · **Size:** S · **Parity:** official-ui-parity · **Personas:** DEV,OPS
- **Description:** Create and delete exchanges with type-aware arguments (AE, hash weights) and plugin-type detection.
- **Depends on:** -
- **Safety notes:** -
- **Acceptance criteria:**
  - Given x-consistent-hash available, then the type appears in the picker
  - Given an exchange delete with bindings, then a dependents list is shown

#### ADM-03 Bulk operations

- **Milestone:** M3 (design-phase tag: M2) · **Size:** M · **Parity:** desktop-tools-parity · **Personas:** OPS
- **Description:** Select by filter or regex, then purge, delete, apply a policy or close connections. Dry-run list, concurrency limit, progress, partial-failure report and an exportable log.
- **Depends on:** EXP-03
- **Safety notes:** Typed confirm + approvals (TEAM-07)
- **Acceptance criteria:**
  - Given 200 selected queues, then the dry run lists them and the run reports per-item results
  - Given a partial failure, then succeeded items are not retried on resume

#### ADM-04 Virtual hosts

- **Milestone:** M2 (design-phase tag: M2) · **Size:** M · **Parity:** official-ui-parity · **Personas:** OPS
- **Description:** Metadata, default queue type, deletion protection, limits and restart on a node, using GET-merge-PUT.
- **Depends on:** -
- **Safety notes:** DC-21
- **Acceptance criteria:**
  - Given a vhost with DQT quorum, when editing its description, then DQT remains quorum (integration test)
  - Given deletion protection, then delete is disabled with a reason

#### ADM-05 Users and user limits

- **Milestone:** M2 (design-phase tag: M2) · **Size:** M · **Parity:** official-ui-parity · **Personas:** SEC,OPS
- **Description:** Users, tags and limits; protected-aware; bulk delete of users without permissions; local password hashing.
- **Depends on:** -
- **Safety notes:** Never call hash_password with a secret in the URL
- **Acceptance criteria:**
  - Given a protected user (4.2+), then edit and delete are disabled
  - Given Amazon MQ, then creating 'guest' is blocked

#### ADM-06 Permissions matrix and access evaluator

- **Milestone:** M2 (design-phase tag: M2) · **Size:** M · **Parity:** beyond · **Personas:** SEC
- **Description:** A user × vhost grid of configure/write/read and topic permissions. 'Can user X purge queue Y?' evaluator. Flags over-broad patterns.
- **Depends on:** -
- **Safety notes:** -
- **Acceptance criteria:**
  - Given user X and queue Y, then the evaluator answers per action with the matching regex
  - Given '.*' on all three, then a finding is raised

#### ADM-07 Connections, channels and sessions

- **Milestone:** M2 (design-phase tag: M2) · **Size:** M · **Parity:** official-ui-parity · **Personas:** OPS
- **Description:** Client properties, TLS/auth info, flow and blocked state, AMQP 1.0 sessions and links. Close one connection or all of a user's with a reason. Stats-off aware.
- **Depends on:** -
- **Safety notes:** Channels endpoint gating (DC-32)
- **Acceptance criteria:**
  - Given stats off on 4.3.5, then the channels view shows a degraded mode instead of an error
  - Given close-all for a user, then a preview lists the connections

#### ADM-08 Consumer inspector

- **Milestone:** M2 (design-phase tag: M2) · **Size:** M · **Parity:** official-ui-parity · **Personas:** OPS,DEV
- **Description:** Per queue: prefetch, ack mode, SAC active flag, priority, consumer-timeout source by version, utilisation and client app.
- **Depends on:** -
- **Safety notes:** -
- **Acceptance criteria:**
  - Given a 4.3 QQ, then the effective consumer timeout and its source are shown
  - Given SAC, then the active consumer is highlighted

#### ADM-09 Nodes and cluster settings

- **Milestone:** M2 (design-phase tag: M2) · **Size:** M · **Parity:** official-ui-parity · **Personas:** OPS
- **Description:** Memory breakdown, fds, sockets, processes, alarms, plugins, maintenance state, cluster name, runtime/global parameters, and 'Reset management statistics' correctly labelled.
- **Depends on:** -
- **Safety notes:** -
- **Acceptance criteria:**
  - Given stats off, then node resources come from Prometheus or are marked unavailable
  - Given DELETE /api/reset, then the UI labels it 'reset management statistics' with a confirm

#### ADM-10 Feature flags and deprecated features

- **Milestone:** M2 (design-phase tag: M2) · **Size:** S · **Parity:** official-ui-parity · **Personas:** OPS
- **Description:** Stability, irreversibility, and enable with typed confirm plus provider warnings. Deprecated features in use are shown with remediation.
- **Depends on:** -
- **Safety notes:** -
- **Acceptance criteria:**
  - Given Amazon MQ 3.13 and khepri_db, then a warning about the blocked 4.2 upgrade is shown
  - Given a deprecated feature in use, then the remediation is linked

#### ADM-11 Definitions export and import

- **Milestone:** M3 (design-phase tag: M2) · **Size:** M · **Parity:** official-ui-parity · **Personas:** OPS,PLAT
- **Description:** Canonical export per cluster or vhost. Synthetic export from list endpoints for non-admins. Transforms (strip mirroring keys, obfuscate users). Import preview with merge-semantics warnings.
- **Depends on:** -
- **Safety notes:** Provider objects annotated (DC-54); secrets redacted (DC-45)
- **Acceptance criteria:**
  - Given a policymaker user, then a synthetic export is produced and labelled
  - Given an import preview, then additions and changes are listed before apply

#### ADM-12 Shovels and federation

- **Milestone:** M3 (design-phase tag: M2) · **Size:** M · **Parity:** official-ui-parity · **Personas:** OPS
- **Description:** Create, inspect, restart and delete shovels (0-9-1, 1.0, local) and federation upstreams/sets. Status timeline, TLS-verify audit, LavinMQ schema.
- **Depends on:** -
- **Safety notes:** Restart needs policymaker on 4.3+
- **Acceptance criteria:**
  - Given a stuck 'starting' shovel, then the last error is shown with a hint
  - Given verify_none, then a security finding is raised

#### ADM-13 Quorum replica and leader operations

- **Milestone:** M3 (design-phase tag: M2) · **Size:** M · **Parity:** official-ui-parity · **Personas:** OPS
- **Description:** Members, leader, machine version per member, add/delete/grow/shrink, rebalance, quorum-critical check. Handles 405 restrictions.
- **Depends on:** -
- **Safety notes:** -
- **Acceptance criteria:**
  - Given replica ops restricted, then the actions show the 405 reason after an on-demand probe
  - Given rebalance, then a warning notes there is no dry run and that it runs asynchronously

#### ADM-14 Health checks panel

- **Milestone:** M2 (design-phase tag: M2) · **Size:** S · **Parity:** official-ui-parity · **Personas:** OPS
- **Description:** Runs every /api/health/checks endpoint available for the version, per node where meaningful; LB-aware labels.
- **Depends on:** -
- **Safety notes:** -
- **Acceptance criteria:**
  - Given 4.1+, then is-in-service and QQ-without-leader checks run
  - Given an LB-fronted cluster, then node-local checks are labelled

#### ADM-15 CLI runbook generator

- **Milestone:** M3 (design-phase tag: M2) · **Size:** S · **Parity:** unique · **Personas:** OPS
- **Description:** Copyable commands for CLI-only operations (QQ peek, stream replicas, drain/revive, plugins, join/forget, log level, trace_on) with context filled in.
- **Depends on:** -
- **Safety notes:** -
- **Acceptance criteria:**
  - Given drain for node X, then rabbitmq-upgrade drain with the correct -n is generated
  - Given a runbook copy, then it is recorded as 'generated' in the audit log

## Monitoring, metrics & alerts (8)

| ID | Feature | Milestone | Parity | Size | Personas |
| --- | --- | --- | --- | --- | --- |
| MON-01 | Metrics source abstraction | M1 | beyond | L | OPS |
| MON-02 | Live charts | M1 | desktop-tools-parity | M | DEV,OPS |
| MON-03 | Local history store | M6 | beyond | M | OPS |
| MON-04 | Time-series explorer | M6 | beyond | M | OPS |
| MON-05 | Drain and fill forecast | M1 | desktop-tools-parity | S | OPS,DEV |
| MON-06 | Alerts | M6 | beyond | L | OPS |
| MON-07 | Fleet overview | M6 | beyond | M | PLAT,OPS |
| MON-08 | Event timeline | M6 | beyond | M | OPS,SEC |

#### MON-01 Metrics source abstraction

- **Milestone:** M1 (design-phase tag: M1) · **Size:** L · **Parity:** beyond · **Personas:** OPS
- **Description:** Prometheus per node first (provider adapters, listeners, default ports; queue= on 4.3+), then management stats, then sampling. External PromQL datasource and Grafana links.
- **Depends on:** CON-03
- **Safety notes:** DC-33; never per-object on Amazon MQ
- **Acceptance criteria:**
  - Given Amazon MQ, then scrapes go to ports 16001-16003 at ≥60 s without per-object
  - Given an LB-fronted Service, then per-node targets are used or the source is marked partial

#### MON-02 Live charts

- **Milestone:** M1 (design-phase tag: M1) · **Size:** M · **Parity:** desktop-tools-parity · **Personas:** DEV,OPS
- **Description:** uPlot charts for queue depth, rates and overview with ranges, zoom and hover; coalesced updates.
- **Depends on:** MON-01
- **Safety notes:** -
- **Acceptance criteria:**
  - Given 50 charts open, then the CPU of the renderer stays below 20% at 1 Hz
  - Given stats off and no Prometheus, then the chart explains the gap

#### MON-03 Local history store

- **Milestone:** M6 (design-phase tag: M4) · **Size:** M · **Parity:** beyond · **Personas:** OPS
- **Description:** Samples to SQLite (desktop/local) or Postgres (team) with downsampling and retention of days to weeks.
- **Depends on:** MON-01, PLAT-02
- **Safety notes:** -
- **Acceptance criteria:**
  - Given 7 days at 30 s for 1k queues, then storage stays under the documented budget
  - Given a retention change, then old samples are compacted

#### MON-04 Time-series explorer

- **Milestone:** M6 (design-phase tag: M4) · **Size:** M · **Parity:** beyond · **Personas:** OPS
- **Description:** Compare entities, zoom, annotations (deploys, incidents, receipts) and a forecast overlay.
- **Depends on:** MON-03
- **Safety notes:** -
- **Acceptance criteria:**
  - Given two queues, then they overlay on a shared axis
  - Given a replay receipt, then an annotation is shown at its time

#### MON-05 Drain and fill forecast

- **Milestone:** M1 (design-phase tag: M1) · **Size:** S · **Parity:** desktop-tools-parity · **Personas:** OPS,DEV
- **Description:** Adaptive-window regression (R² ≥ 0.95) for the drain ETA, time to max-length or alarm, and consumers needed.
- **Depends on:** MON-02
- **Safety notes:** -
- **Acceptance criteria:**
  - Given a steady decline, then the ETA is shown with confidence
  - Given R² below threshold, then 'no reliable forecast' is shown

#### MON-06 Alerts

- **Milestone:** M6 (design-phase tag: M4) · **Size:** L · **Parity:** beyond · **Personas:** OPS
- **Description:** Rules on depth, age, zero consumers, DLQ inflow, unacked, alarms, certificate expiry and EOL. Desktop notifications and tray locally; server-evaluated with Slack, Teams, email, webhook, PagerDuty and Opsgenie, snooze and routing.
- **Depends on:** MON-03
- **Safety notes:** Only user-configured endpoints (DC-59)
- **Acceptance criteria:**
  - Given a team server rule, then it fires with laptops closed and is delivered once with dedup
  - Given snooze, then no notifications are sent until it expires

#### MON-07 Fleet overview

- **Milestone:** M6 (design-phase tag: M4) · **Size:** M · **Parity:** beyond · **Personas:** PLAT,OPS
- **Description:** All clusters in one view: health, version/EOL, alarms, top backlogs, DLQ totals, quorum-critical queues.
- **Depends on:** MON-01
- **Safety notes:** -
- **Acceptance criteria:**
  - Given 20 profiles, then the fleet view loads within 3 s using cached probes
  - Given an EOL version, then it is badged with its dates

#### MON-08 Event timeline

- **Milestone:** M6 (design-phase tag: M4) · **Size:** M · **Parity:** beyond · **Personas:** OPS,SEC
- **Description:** Optional consumption of amq.rabbitmq.event and amq.rabbitmq.log into a bounded, searchable timeline correlated with metrics.
- **Depends on:** TAP-02
- **Safety notes:** -
- **Acceptance criteria:**
  - Given the event exchange, then connection, queue and policy events show user_who_performed_action
  - Given it is absent, then the feature is disabled with the enable instructions

## Diagnostics, lint & upgrade advisor (9)

| ID | Feature | Milestone | Parity | Size | Personas |
| --- | --- | --- | --- | --- | --- |
| DIA-01 | Lint engine and CLI/CI mode | M6 | unique | L | OPS,PLAT |
| DIA-02 | Upgrade readiness advisor | M6 | unique | L | OPS |
| DIA-03 | Why is this queue growing? | M6 | unique | M | OPS,DEV |
| DIA-04 | Consumer and unacked diagnostics | M6 | beyond | M | OPS |
| DIA-05 | Connection hygiene | M6 | beyond | M | OPS |
| DIA-06 | Alarm and flow-control centre | M6 | beyond | M | OPS |
| DIA-07 | Security posture checks | M6 | unique | M | SEC |
| DIA-08 | Queue-type migration wizard | M8 | beyond | L | OPS |
| DIA-09 | Capacity and headroom | M6 | unique | M | OPS,PLAT |

#### DIA-01 Lint engine and CLI/CI mode

- **Milestone:** M6 (design-phase tag: M4) · **Size:** L · **Parity:** unique · **Personas:** OPS,PLAT
- **Description:** A versioned rule catalogue of the DC-56 hazards plus best practices, each with severity, evidence and a fix plan. Runs on demand or on a schedule; outputs SARIF/JSON from the CLI.
- **Depends on:** POL-01, CON-03
- **Safety notes:** Connected brokers only; no network scanning (DC-56)
- **Acceptance criteria:**
  - Given a QQ without DLX, then a finding with a fix policy is produced
  - Given the CI command against a definitions file, then it exits non-zero on errors

#### DIA-02 Upgrade readiness advisor

- **Milestone:** M6 (design-phase tag: M4) · **Size:** L · **Parity:** unique · **Personas:** OPS
- **Description:** Pick a target (e.g. 4.3/4.4) and get the report and plan: flags, deprecated features, CQv1, transient queues, global QoS, Khepri, the delayed-message plugin and its migration options, provider blockers.
- **Depends on:** DIA-01
- **Safety notes:** -
- **Acceptance criteria:**
  - Given a 4.2 cluster using x-delayed-message, then the report lists the 4.3 blocker and alternatives
  - Given target 4.3, then required flags not enabled are listed in order

#### DIA-03 Why is this queue growing?

- **Milestone:** M6 (design-phase tag: M4) · **Size:** M · **Parity:** unique · **Personas:** OPS,DEV
- **Description:** A deterministic decision tree over rates, consumers, utilisation, unacked vs prefetch, redeliveries, alarms and limits, with evidence and actions.
- **Depends on:** MON-03, ADM-08
- **Safety notes:** -
- **Acceptance criteria:**
  - Given consumers dropped to 0, then the top cause is 'no consumers since T' with evidence
  - Given a redelivery loop, then it is identified with the offending consumer

#### DIA-04 Consumer and unacked diagnostics

- **Milestone:** M6 (design-phase tag: M4) · **Size:** M · **Parity:** beyond · **Personas:** OPS
- **Description:** Stuck consumers (unacked >0, no acks for N minutes), prefetch hotspots, and timeout rules per version and queue type.
- **Depends on:** ADM-08
- **Safety notes:** -
- **Acceptance criteria:**
  - Given a stuck consumer, then it is flagged with its connection name and age
  - Given a CQ on 4.3, then 'no server consumer timeout' is noted

#### DIA-05 Connection hygiene

- **Milestone:** M6 (design-phase tag: M4) · **Size:** M · **Parity:** beyond · **Personas:** OPS
- **Description:** Churn rates, leaks (monotonic growth), unnamed connections, heartbeat settings and close reasons.
- **Depends on:** MON-03
- **Safety notes:** -
- **Acceptance criteria:**
  - Given churn above 100/s, then a finding names the top clients
  - Given unnamed connections, then they are grouped by peer

#### DIA-06 Alarm and flow-control centre

- **Milestone:** M6 (design-phase tag: M4) · **Size:** M · **Parity:** beyond · **Personas:** OPS
- **Description:** Memory and disk alarms per node, blocked and blocking connections, and watermark checks against container limits.
- **Depends on:** -
- **Safety notes:** -
- **Acceptance criteria:**
  - Given a memory alarm, then all blocked publishers are listed with an explanation of the cluster-wide effect
  - Given a watermark above the cgroup limit, then a finding is raised

#### DIA-07 Security posture checks

- **Milestone:** M6 (design-phase tag: M4) · **Size:** M · **Parity:** unique · **Personas:** SEC
- **Description:** verify_aud=false, hostname_verification=none, ANONYMOUS/guest, basic auth alongside OAuth, client-secret leak versions, oversized tokens, access-log attribution.
- **Depends on:** DIA-01
- **Safety notes:** Framed as config hygiene (SignPath clause)
- **Acceptance criteria:**
  - Given 4.3.2 with OAuth, then the client-secret leak finding cites the fix version
  - Given a token over 4 KB, then the 431 risk is reported

#### DIA-08 Queue-type migration wizard

- **Milestone:** M8 (design-phase tag: M6) · **Size:** L · **Parity:** beyond · **Personas:** OPS
- **Description:** CQ or mirrored queue to QQ: create the new queue, copy bindings, move with verification, switch, remove; batch with a skip list and rollback.
- **Depends on:** MSG-12, TAC-03
- **Safety notes:** -
- **Acceptance criteria:**
  - Given a CQ with exclusive or global-QoS consumers, then migration is blocked with reasons
  - Given a completed batch, then message counts match before and after

#### DIA-09 Capacity and headroom

- **Milestone:** M6 (design-phase tag: M4) · **Size:** M · **Parity:** unique · **Personas:** OPS,PLAT
- **Description:** Usage against limits (connections, channels, queues, consumers per channel, message size, vhost limits, provider quotas) with projections.
- **Depends on:** CON-09
- **Safety notes:** -
- **Acceptance criteria:**
  - Given CloudAMQP shared, then connection usage against 20/100 is shown
  - Given growth, then the date the limit is reached is projected

## Topology-as-code (5)

| ID | Feature | Milestone | Parity | Size | Personas |
| --- | --- | --- | --- | --- | --- |
| TAC-01 | Topology snapshots | M6 | beyond | M | PLAT |
| TAC-02 | Diff any two sources | M6 | beyond | M | PLAT,OPS |
| TAC-03 | Plan and apply | M8 | unique | L | PLAT |
| TAC-04 | IaC and AsyncAPI export | M8 | beyond | M | PLAT |
| TAC-05 | Drift detection | M8 | beyond | M | PLAT |

#### TAC-01 Topology snapshots

- **Milestone:** M6 (design-phase tag: M4) · **Size:** M · **Parity:** beyond · **Personas:** PLAT
- **Description:** A normalised, sorted model of the live topology with provider-owned and operator-owned annotations; scheduled snapshots.
- **Depends on:** ADM-11
- **Safety notes:** DC-54
- **Acceptance criteria:**
  - Given two exports of an unchanged broker, then the snapshots are byte-identical
  - Given AWS-owned objects, then they are annotated as provider-owned

#### TAC-02 Diff any two sources

- **Milestone:** M6 (design-phase tag: M4) · **Size:** M · **Parity:** beyond · **Personas:** PLAT,OPS
- **Description:** Diff live brokers, files, git refs, vhosts or snapshots, with a visual and textual diff and immutable-argument change markers.
- **Depends on:** TAC-01
- **Safety notes:** -
- **Acceptance criteria:**
  - Given staging vs prod, then added, removed and changed objects are grouped by type
  - Given a changed QQ argument, then it is marked 'forces replacement'

#### TAC-03 Plan and apply

- **Milestone:** M8 (design-phase tag: M6) · **Size:** L · **Parity:** unique · **Personas:** PLAT
- **Description:** Plans in dependency order with replacements flagged, approvals and an audit trail; partial-failure handling; never touches operator-owned objects.
- **Depends on:** TAC-02, TEAM-07
- **Safety notes:** -
- **Acceptance criteria:**
  - Given a plan with a queue replacement, then apply requires approval and moves messages only by explicit option
  - Given an object owned by the Topology Operator, then the plan refuses to edit it

#### TAC-04 IaC and AsyncAPI export

- **Milestone:** M8 (design-phase tag: M6) · **Size:** M · **Parity:** beyond · **Personas:** PLAT
- **Description:** Export to definitions JSON, Terraform (cyrilgdn), Topology Operator CRDs and AsyncAPI 3 with inferred schemas; import AsyncAPI as a plan.
- **Depends on:** TAC-01
- **Safety notes:** -
- **Acceptance criteria:**
  - Given a vhost, then the generated CRDs apply cleanly on a kind cluster (CI)
  - Given an AsyncAPI file, then a reviewable plan is produced

#### TAC-05 Drift detection

- **Milestone:** M8 (design-phase tag: M6) · **Size:** M · **Parity:** beyond · **Personas:** PLAT
- **Description:** Scheduled comparison against git or an IaC source of truth with alerts; warns before UI edits to IaC-managed objects.
- **Depends on:** TAC-02, MON-06
- **Safety notes:** -
- **Acceptance criteria:**
  - Given a manual change on prod, then a drift alert fires at the next run
  - Given a UI edit on a managed object, then a warning names the managing system

## Team server governance (14)

| ID | Feature | Milestone | Parity | Size | Personas |
| --- | --- | --- | --- | --- | --- |
| TEAM-01 | Team server mode | M5 | unique | XL | SEC,PLAT |
| TEAM-02 | OIDC SSO | M5 | beyond | L | SEC |
| TEAM-03 | Deny-by-default RBAC and quotas | M5 | beyond | L | SEC |
| TEAM-04 | Shared catalog and assets | M5 | beyond | M | PLAT,SEC |
| TEAM-05 | Broker credential modes | M5 | unique | L | SEC |
| TEAM-06 | Append-only audit log | M5 | beyond | L | SEC |
| TEAM-07 | Four-eyes approvals | M5 | beyond | M | SEC,OPS |
| TEAM-08 | PII masking | M5 | beyond | M | SEC |
| TEAM-09 | SSRF egress policy | M5 | unique | M | SEC |
| TEAM-10 | Desktop remote workspaces | M5 | unique | M | DEV,OPS |
| TEAM-11 | Team admin console | M5 | unique | M | SEC,PLAT |
| TEAM-12 | SCIM provisioning | M8 | beyond | M | SEC |
| TEAM-13 | Highly available team server | M8 | beyond | L | PLAT |
| TEAM-14 | Self-service within guardrails | M8 | beyond | XL | PLAT |

#### TEAM-01 Team server mode

- **Milestone:** M5 (design-phase tag: M3) · **Size:** XL · **Parity:** unique · **Personas:** SEC,PLAT
- **Description:** The same engine and UI with Postgres, OIDC cookies, a multi-user connection catalog and server-held AMQP sessions; Docker and Helm; free.
- **Depends on:** PLAT-02
- **Safety notes:** -
- **Acceptance criteria:**
  - Given docker compose up with Postgres, then the server starts and passes readiness within 30 s
  - Given SIGTERM, then pending nacks are flushed within the 2 s drain (DC-04)

#### TEAM-02 OIDC SSO

- **Milestone:** M5 (design-phase tag: M3) · **Size:** L · **Parity:** beyond · **Personas:** SEC
- **Description:** A BFF with authorization code + PKCE, server sessions, CSRF, group-claim mapping, an optional trusted-header mode and a break-glass local admin.
- **Depends on:** TEAM-01
- **Safety notes:** -
- **Acceptance criteria:**
  - Given Keycloak and Entra test tenants, then login maps groups to roles
  - Given the break-glass admin, then its use raises an audit event and banner

#### TEAM-03 Deny-by-default RBAC and quotas

- **Milestone:** M5 (design-phase tag: M3) · **Size:** L · **Parity:** beyond · **Personas:** SEC
- **Description:** Roles on connection/vhost/resource patterns with separate permissions: view metadata, view bodies, peek, consume, purge, replay, publish, tap, firehose, topology admin, user admin. Scoped visibility; per-role quotas and a kill switch.
- **Depends on:** TEAM-02, PLAT-02
- **Safety notes:** Stricter than the broker (DC-40)
- **Acceptance criteria:**
  - Given a role with peek but not purge, then purge is hidden in the UI and refused by the API
  - Given the kill switch, then all running taps and jobs stop and nacks are flushed

#### TEAM-04 Shared catalog and assets

- **Milestone:** M5 (design-phase tag: M3) · **Size:** M · **Parity:** beyond · **Personas:** PLAT,SEC
- **Description:** Admin-defined connections, colours and defaults via UI, file or Helm values; ad-hoc connections can be locked down. Shared views, collections, schemas and deep links.
- **Depends on:** TEAM-01
- **Safety notes:** -
- **Acceptance criteria:**
  - Given Helm values with connections, then they appear read-only to users
  - Given lockdown, then users cannot add brokers

#### TEAM-05 Broker credential modes

- **Milestone:** M5 (design-phase tag: M3) · **Size:** L · **Parity:** unique · **Personas:** SEC
- **Description:** Per connection: delegated OAuth access tokens (token exchange/OBO) in per-user pools, Vault/OpenBao dynamic users, personal LDAP or a service account; always intersected with RBAC.
- **Depends on:** TEAM-03, CON-07
- **Safety notes:** Never ID tokens (DC-41); user id in connection_name
- **Acceptance criteria:**
  - Given delegated mode, then each user has their own AMQP connection and the broker sees the user's identity
  - Given Vault dynamic, then credentials are leased and revoked on logout

#### TEAM-06 Append-only audit log

- **Milestone:** M5 (design-phase tag: M3) · **Size:** L · **Parity:** beyond · **Personas:** SEC
- **Description:** Hash-chained attempt and outcome rows for every peek, get, publish, purge, tap, firehose, replay, export and admin action, with receipts. Export to OTLP, syslog or JSON; retention.
- **Depends on:** TEAM-01
- **Safety notes:** DC-40; no payloads by default
- **Acceptance criteria:**
  - Given a purge, then an attempt row precedes the call and an outcome row follows, linked
  - Given a tampered row, then chain verification fails and is reported

#### TEAM-07 Four-eyes approvals

- **Milestone:** M5 (design-phase tag: M3) · **Size:** M · **Parity:** beyond · **Personas:** SEC,OPS
- **Description:** Configurable approval for budget-spending QQ peeks, bulk replays, purges, deletes, firehose, imports and plan applies, with expiry.
- **Depends on:** TEAM-03
- **Safety notes:** -
- **Acceptance criteria:**
  - Given a bulk replay over 1,000 messages on PROD, then it waits for a second approver
  - Given an approval that expired, then the action cannot run

#### TEAM-08 PII masking

- **Milestone:** M5 (design-phase tag: M3) · **Size:** M · **Parity:** beyond · **Personas:** SEC
- **Description:** Engine-side JSONPath, regex and detector rules (email, Luhn, IBAN, tokens) per vhost and queue, applied to UI, exports, audit, AI and failure headers; role-based unmask is audited.
- **Depends on:** TEAM-03
- **Safety notes:** -
- **Acceptance criteria:**
  - Given a masked field, then it never leaves the engine unmasked for unprivileged roles (API test)
  - Given replay, then the original bytes are republished unmasked

#### TEAM-09 SSRF egress policy

- **Milestone:** M5 (design-phase tag: M3) · **Size:** M · **Parity:** unique · **Personas:** SEC
- **Description:** An admin allow-list of hosts, CIDRs and ports per environment. Private, link-local and metadata ranges are denied by default; connect-time DNS validation; no redirects. Covers OIDC, JWKS and Vault.
- **Depends on:** CON-06
- **Safety notes:** DC-43
- **Acceptance criteria:**
  - Given a profile pointing at 169.254.169.254, then the connection is refused
  - Given a DNS rebinding to a private IP, then the connect-time check blocks it

#### TEAM-10 Desktop remote workspaces

- **Milestone:** M5 (design-phase tag: M3) · **Size:** M · **Parity:** unique · **Personas:** DEV,OPS
- **Description:** The desktop app attaches to a team server through an RFC 8252 login and works on brokers reachable only from the server.
- **Depends on:** TEAM-02
- **Safety notes:** -
- **Acceptance criteria:**
  - Given a team server, then desktop login uses the system browser with PKCE
  - Given RBAC limits, then the desktop UI reflects the server's permissions

#### TEAM-11 Team admin console

- **Milestone:** M5 (design-phase tag: M3) · **Size:** M · **Parity:** unique · **Personas:** SEC,PLAT
- **Description:** Users and groups, roles, connections, approvals queue, audit search and verification, masking rules, egress policy and server settings.
- **Depends on:** TEAM-03
- **Safety notes:** -
- **Acceptance criteria:**
  - Given an auditor role, then audit is searchable but settings are read-only
  - Given a role change, then it takes effect on the next request and is audited

#### TEAM-12 SCIM provisioning

- **Milestone:** M8 (design-phase tag: M6) · **Size:** M · **Parity:** beyond · **Personas:** SEC
- **Description:** SCIM 2.0 users and groups from the IdP, with deprovisioning that revokes sessions and per-user broker pools.
- **Depends on:** TEAM-02
- **Safety notes:** -
- **Acceptance criteria:**
  - Given a deprovisioned user, then their sessions and connections close within 60 s
  - Given group sync, then role bindings follow

#### TEAM-13 Highly available team server

- **Milestone:** M8 (design-phase tag: M6) · **Size:** L · **Parity:** beyond · **Personas:** PLAT
- **Description:** Multiple replicas, pg-boss jobs, LISTEN/NOTIFY fan-out, per-broker work ownership, and a Helm PDB and NetworkPolicy.
- **Depends on:** TEAM-01
- **Safety notes:** -
- **Acceptance criteria:**
  - Given one replica killed, then running jobs resume on another without duplicate publishes
  - Given 3 replicas, then each broker is polled once

#### TEAM-14 Self-service within guardrails

- **Milestone:** M8 (design-phase tag: M6) · **Size:** XL · **Parity:** beyond · **Personas:** PLAT
- **Description:** App teams request vhosts, queues, users and permissions; naming rules and required policies are enforced; owners approve; results go through plan/apply.
- **Depends on:** TAC-03, TEAM-07
- **Safety notes:** -
- **Acceptance criteria:**
  - Given a request violating naming rules, then it is rejected with the rule
  - Given an approved request, then the plan applies and is audited

## AI & MCP (5)

| ID | Feature | Milestone | Parity | Size | Personas |
| --- | --- | --- | --- | --- | --- |
| AI-01 | Local read-only MCP | M4 | beyond | M | DEV |
| AI-02 | Team /mcp resource | M7 | unique | M | SEC,PLAT |
| AI-03 | Governed mutating tools | M7 | unique | M | SEC,OPS |
| AI-04 | Grounded copilot | M7 | beyond | L | ALL |
| AI-05 | Prompt-injection hardening | M7 | unique | M | SEC |

#### AI-01 Local read-only MCP

- **Milestone:** M4 (design-phase tag: M2) · **Size:** M · **Parity:** beyond · **Personas:** DEV
- **Description:** A stdio MCP shim over a permission-protected named pipe or Unix socket. Metadata-only tools (list, describe, lint, explain config); connections referenced by opaque IDs.
- **Depends on:** PLAT-02
- **Safety notes:** No TCP listener (DC-35); peeks excluded (DC-42)
- **Acceptance criteria:**
  - Given an MCP client, then tools accept only profile IDs, never hosts or URIs
  - Given a peek request, then it is not exposed in read-only mode

#### AI-02 Team /mcp resource

- **Milestone:** M7 (design-phase tag: M5) · **Size:** M · **Parity:** unique · **Personas:** SEC,PLAT
- **Description:** The team server's /mcp is its own OAuth protected resource (RFC 9728/8707) with no token passthrough; RBAC, masking and audit apply.
- **Depends on:** TEAM-03
- **Safety notes:** DC-42; CVE-2026-18655 lesson
- **Acceptance criteria:**
  - Given a token with the wrong audience, then /mcp rejects it
  - Given a tool call, then an audit row names the human principal and the agent

#### AI-03 Governed mutating tools

- **Milestone:** M7 (design-phase tag: M5) · **Size:** M · **Parity:** unique · **Personas:** SEC,OPS
- **Description:** Peek (classified as a mutation, with receipts), publish, replay and purge tools are off by default and require human approval. The rescue option is mandatory for doomed messages.
- **Depends on:** AI-02, TEAM-07
- **Safety notes:** DC-09, DC-42
- **Acceptance criteria:**
  - Given an AI peek of a 4.0-4.2 QQ, then approval is required and the receipt is returned to the agent
  - Given a doomed message, then 'let RabbitMQ handle' is unavailable

#### AI-04 Grounded copilot

- **Milestone:** M7 (design-phase tag: M5) · **Size:** L · **Parity:** beyond · **Personas:** ALL
- **Description:** Chat grounded in lint, diagnostics, effective config and docs. Bring-your-own endpoint or local model; metadata-only by default; cites evidence; natural language to filters and to reviewable topology plans that are never auto-applied.
- **Depends on:** DIA-01, AI-05
- **Safety notes:** Only user-configured endpoints (DC-59)
- **Acceptance criteria:**
  - Given 'why is orders.q growing', then the answer cites the decision-tree evidence
  - Given no endpoint configured, then the copilot is disabled with no outbound calls

#### AI-05 Prompt-injection hardening

- **Milestone:** M7 (design-phase tag: M5) · **Size:** M · **Parity:** unique · **Personas:** SEC
- **Description:** Payloads are quoted, size-capped, stripped of control characters and secret-masked; output is rendered as text without remote images; tool allow-lists per environment.
- **Depends on:** TEAM-08
- **Safety notes:** -
- **Acceptance criteria:**
  - Given a message body containing tool instructions, then it is delivered to the model as quoted data and red-team tests pass
  - Given an exfiltration URL in output, then it is not auto-rendered

## Extensibility/SDK (6)

| ID | Feature | Milestone | Parity | Size | Personas |
| --- | --- | --- | --- | --- | --- |
| EXT-01 | Plugin SDK v1: codecs and DLQ decoders | M3 | unique | M | DEV,PLAT |
| EXT-02 | Tool CLI | M4 | beyond | M | OPS,PLAT |
| EXT-03 | Team REST API and API tokens | M5 | beyond | M | PLAT |
| EXT-04 | Lint rule SDK | M6 | unique | S | OPS,PLAT |
| EXT-05 | UI extension points | M8 | beyond | L | PLAT |
| EXT-06 | Executable runbooks | M8 | beyond | M | OPS |

#### EXT-01 Plugin SDK v1: codecs and DLQ decoders

- **Milestone:** M3 (design-phase tag: M2) · **Size:** M · **Parity:** unique · **Personas:** DEV,PLAT
- **Description:** Typed TS interfaces (detect, decode, encode; detect, decode, fingerprint, replayPlan) running sandboxed in workers; fixtures kit; published to npm.
- **Depends on:** MSG-08
- **Safety notes:** -
- **Acceptance criteria:**
  - Given a sample decoder from the template, then it loads in desktop, local web and team modes
  - Given a plugin throwing errors, then the engine stays healthy and shows the error

#### EXT-02 Tool CLI

- **Milestone:** M4 (design-phase tag: M2) · **Size:** M · **Parity:** beyond · **Personas:** OPS,PLAT
- **Description:** A headless CLI over the local named pipe or a team API token: export, lint, diff, replay jobs, run collections, tail.
- **Depends on:** PLAT-02
- **Safety notes:** -
- **Acceptance criteria:**
  - Given 'lint --format sarif', then a valid SARIF file is produced
  - Given no local engine, then the CLI starts one on demand

#### EXT-03 Team REST API and API tokens

- **Milestone:** M5 (design-phase tag: M3) · **Size:** M · **Parity:** beyond · **Personas:** PLAT
- **Description:** Published OpenAPI 3.1 for automation, with scoped expiring tokens under RBAC, audit and rate limits.
- **Depends on:** TEAM-03
- **Safety notes:** -
- **Acceptance criteria:**
  - Given a token scoped to read metadata, then message endpoints return 403
  - Given the OpenAPI, then oasdiff in CI blocks breaking changes

#### EXT-04 Lint rule SDK

- **Milestone:** M6 (design-phase tag: M4) · **Size:** S · **Parity:** unique · **Personas:** OPS,PLAT
- **Description:** Community lint rules with metadata, version gates, fixtures and fix plans.
- **Depends on:** DIA-01
- **Safety notes:** -
- **Acceptance criteria:**
  - Given a rule package, then it runs in UI and CLI with the same results
  - Given a version gate, then the rule is skipped on other versions

#### EXT-05 UI extension points

- **Milestone:** M8 (design-phase tag: M6) · **Size:** L · **Parity:** beyond · **Personas:** PLAT
- **Description:** Panels, renderers, actions and activity-bar entries loaded from signed plugin bundles in all modes; actions go through the action layer.
- **Depends on:** EXT-01
- **Safety notes:** -
- **Acceptance criteria:**
  - Given an unsigned bundle on the team server, then it is refused
  - Given a plugin action, then RBAC and audit apply

#### EXT-06 Executable runbooks

- **Milestone:** M8 (design-phase tag: M6) · **Size:** M · **Parity:** beyond · **Personas:** OPS
- **Description:** Markdown notebooks mixing docs with live, governed actions (queries, lint, charts, publish), stored in git.
- **Depends on:** EXT-02
- **Safety notes:** -
- **Acceptance criteria:**
  - Given a runbook cell with a mutation, then it requires the same confirmation as the UI
  - Given a shared runbook, then outputs are masked

## Distribution & platform (18)

| ID | Feature | Milestone | Parity | Size | Personas |
| --- | --- | --- | --- | --- | --- |
| PLAT-01 | Monorepo, agent toolchain and licence gate | M0 | unique | M | PLAT |
| PLAT-02 | Engine core and action layer | M0 | unique | L | ALL |
| PLAT-03 | Transport-agnostic RPC | M0 | unique | M | ALL |
| PLAT-04 | Management HTTP client | M0 | unique | L | ALL |
| PLAT-05 | Protocol adapters and connection manager | M0 | unique | L | ALL |
| PLAT-06 | Conformance suite and public matrix | M0 | unique | L | ALL |
| PLAT-07 | Electron desktop shell | M2 (Windows), M3 (Linux), M4 (macOS) | desktop-tools-parity | L | DEV |
| PLAT-08 | Local web mode (npx) | M0 (container mode); npx optional in M2 | unique | M | DEV |
| PLAT-09 | Container image | M0 | beyond | S | PLAT |
| PLAT-10 | Release, signing and update pipeline | M0 (image); M2–M4 (desktop) | beyond | L | ALL |
| PLAT-11 | Helm chart | M5 | beyond | M | PLAT |
| PLAT-12 | Privacy, offline operation and support bundle | M0 | beyond | S | SEC |
| PLAT-13 | Accessibility programme | M1 | beyond | M | ALL |
| PLAT-14 | i18n and theming | M1 | beyond | M | ALL |
| PLAT-15 | Docs site and public matrices | M1 | beyond | M | ALL |
| PLAT-16 | Free web utilities | M4 | unique | M | DEV,OPS |
| PLAT-17 | Local broker launcher | M6 | beyond | M | DEV |
| PLAT-18 | On-call responsive view | M8 | beyond | M | OPS |

#### PLAT-01 Monorepo, agent toolchain and licence gate

- **Milestone:** M0 (design-phase tag: M0) · **Size:** M · **Parity:** unique · **Personas:** PLAT
- **Description:** Nx 23 + pnpm catalogs, TS 6.0.3 pinned, bans (TS7, @types/amqplib, git dependencies), module boundaries, generators, AGENTS.md and the CI licence gate with notices.
- **Depends on:** -
- **Safety notes:** DC-24, DC-49, DC-50
- **Acceptance criteria:**
  - Given a PR adding primeng 22, then CI fails the licence gate
  - Given a dependency resolving from a git URL, then CI fails

#### PLAT-02 Engine core and action layer

- **Milestone:** M0 (design-phase tag: M0) · **Size:** L · **Parity:** unique · **Personas:** ALL
- **Description:** NestJS 12 on Fastify; ports and adapters; a policy-enforced action layer shared by UI, CLI and MCP; JobService with abort, checkpoints and idempotency; persistence (node:sqlite via Kysely or Postgres).
- **Depends on:** -
- **Safety notes:** All broker I/O in the engine (DC-34)
- **Acceptance criteria:**
  - Given any mutating command, then it passes through the action layer and emits an audit or receipt event
  - Given a job abort, then cleanup runs and nacks are flushed

#### PLAT-03 Transport-agnostic RPC

- **Milestone:** M0 (design-phase tag: M0) · **Size:** M · **Parity:** unique · **Personas:** ALL
- **Description:** Zod-typed contracts: MessagePort on desktop, WebSocket in web and team; streaming with credits, ring buffers and coalescing; Orval-generated Angular client.
- **Depends on:** -
- **Safety notes:** DC-35
- **Acceptance criteria:**
  - Given the same Angular build, then it runs over MessagePort in Electron and WebSocket in browser E2E tests
  - Given a slow client, then tap frames are sampled with a dropped counter, never unbounded

#### PLAT-04 Management HTTP client

- **Milestone:** M0 (design-phase tag: M0) · **Size:** L · **Parity:** unique · **Personas:** ALL
- **Description:** An in-house undici + zod client with pagination, columns, stats flags, the bug table as data, and golden fixtures per broker version.
- **Depends on:** -
- **Safety notes:** DC-32, DC-48
- **Acceptance criteria:**
  - Given fixtures for 3.13.7-4.3.6, then all schemas parse (passthrough) in CI
  - Given /api/channels on 4.3.5 with stats off, then disable_stats is never sent

#### PLAT-05 Protocol adapters and connection manager

- **Milestone:** M0 (design-phase tag: M0) · **Size:** L · **Parity:** unique · **Personas:** ALL
- **Description:** Amqp091Port (amqplib, with a contract suite against @cloudamqp/amqp-client), Amqp10Port (rhea), optional StreamPort; role-separated connections and budgets.
- **Depends on:** -
- **Safety notes:** DC-11, DC-12, DC-48
- **Acceptance criteria:**
  - Given the contract suite, then both 0-9-1 adapters pass
  - Given a provider limit of 10 consumers per channel, then the manager queues jobs instead of exceeding it

#### PLAT-06 Conformance suite and public matrix

- **Milestone:** M0 (design-phase tag: M0) · **Size:** L · **Parity:** unique · **Personas:** ALL
- **Description:** Testcontainers on Linux: RabbitMQ 3.13.7, 4.0.9, 4.1.8, 4.2.9 and 4.3.6 plus nightly alphas, crossed with Node 24.22, 26.12 and Electron's Node. Covers every settle path and registry cell; the matrix is published per release.
- **Depends on:** -
- **Safety notes:** DC-47, DC-60
- **Acceptance criteria:**
  - Given a release tag, then the published matrix lists every registry cell with pass, fail or unverified status
  - Given a registry change without a test ID, then CI fails

#### PLAT-07 Electron desktop shell

- **Milestone:** M2 (Windows), M3 (Linux), M4 (macOS) (design-phase tag: M0) · **Size:** L · **Parity:** desktop-tools-parity · **Personas:** DEV
- **Description:** Engine in a utilityProcess; app:// protocol; fuses (RunAsNode, NodeOptions, NodeCliInspect off; ASAR integrity); sandbox, CSP and navigation guards; a separate test-fused binary; before-quit and suspend flush.
- **Depends on:** -
- **Safety notes:** DC-04, DC-46
- **Acceptance criteria:**
  - Given the release binary, then fuses are verified by @electron/fuses read in CI
  - Given OS suspend during a peek, then nacks flush before suspend completes

#### PLAT-08 Local web mode (npx)

- **Milestone:** M0 (container mode); npx optional in M2 (design-phase tag: M0) · **Size:** M · **Parity:** unique · **Personas:** DEV
- **Description:** npx <product> binds 127.0.0.1, prints a URL with the token in the fragment, uses Host/Origin allow-lists, refuses public binds without auth and TLS; Docker docs use -p 127.0.0.1.
- **Depends on:** -
- **Safety notes:** DC-36
- **Acceptance criteria:**
  - Given --host 0.0.0.0 without auth, then startup is refused with guidance
  - Given a request with a foreign Origin, then it is rejected

#### PLAT-09 Container image

- **Milestone:** M0 (design-phase tag: M0) · **Size:** S · **Parity:** beyond · **Personas:** PLAT
- **Description:** A distroless nodejs24 non-root image, multi-arch, cosign-signed with SBOM and provenance, read-only root filesystem, SIGTERM drain.
- **Depends on:** -
- **Safety notes:** -
- **Acceptance criteria:**
  - Given the image, then cosign verify succeeds and Trivy shows no critical vulnerabilities
  - Given SIGTERM, then the process exits within 2 s after flushing

#### PLAT-10 Release, signing and update pipeline

- **Milestone:** M0 (image); M2–M4 (desktop) (design-phase tag: M0) · **Size:** L · **Parity:** beyond · **Personas:** ALL
- **Description:** Release-please; notarised macOS arm64 and x64; Store MSIX plus NSIS (SignPath later, metadata regenerated after signing); deb/rpm/AppImage; own Homebrew tap; winget; auto-update channels with an enterprise disable. Wave 2: Flathub, Snap.
- **Depends on:** -
- **Safety notes:** DC-58
- **Acceptance criteria:**
  - Given a tag, then all artefacts are built, signed and attached to an immutable release
  - Given the enterprise disable setting, then no update request is made

#### PLAT-11 Helm chart

- **Milestone:** M5 (design-phase tag: M3) · **Size:** M · **Parity:** beyond · **Personas:** PLAT
- **Description:** OCI chart with a values schema generated from the config, existingSecret support, restricted PSS, probes, optional ServiceMonitor, NetworkPolicy and PDB, HTTPRoute or Ingress; chart-testing on kind.
- **Depends on:** TEAM-01
- **Safety notes:** -
- **Acceptance criteria:**
  - Given helm install on kind with defaults, then the pod passes restricted PSS and readiness
  - Given invalid values, then the schema rejects them

#### PLAT-12 Privacy, offline operation and support bundle

- **Milestone:** M0 (design-phase tag: M0) · **Size:** S · **Parity:** beyond · **Personas:** SEC
- **Description:** No telemetry by default, a documented outbound-calls list, fully offline operation, a redacted local diagnostics bundle that is never auto-uploaded.
- **Depends on:** -
- **Safety notes:** DC-59
- **Acceptance criteria:**
  - Given a network capture of a fresh install with updates disabled, then zero outbound connections are made except to configured brokers
  - Given a diagnostics bundle, then the secret scanner finds no credentials

#### PLAT-13 Accessibility programme

- **Milestone:** M1 (design-phase tag: M1) · **Size:** M · **Parity:** beyond · **Personas:** ALL
- **Description:** WCAG 2.2 AA: aria patterns, focus management, contrast tokens, target sizes, alternatives for canvas views, and axe plus keyboard E2E in CI.
- **Depends on:** -
- **Safety notes:** -
- **Acceptance criteria:**
  - Given the core flows (connect, peek, publish, tap, replay), then they are completable with keyboard only (E2E)
  - Given axe in CI, then there are 0 serious violations

#### PLAT-14 i18n and theming

- **Milestone:** M1 (design-phase tag: M1) · **Size:** M · **Parity:** beyond · **Personas:** ALL
- **Description:** Transloco with externalised strings; light, dark and high-contrast themes; compact and comfortable density; tokens pushed to the grid, Monaco, charts and graph.
- **Depends on:** -
- **Safety notes:** -
- **Acceptance criteria:**
  - Given a pseudo-locale build, then no hard-coded string is found
  - Given the high-contrast theme, then all tokens pass 7:1 for text

#### PLAT-15 Docs site and public matrices

- **Milestone:** M1 (design-phase tag: M1) · **Size:** M · **Parity:** beyond · **Personas:** ALL
- **Description:** Starlight docs: per-mode quickstarts, semantics guides, the provider × capability matrix, the conformance matrix, the security model and ADRs.
- **Depends on:** PLAT-06
- **Safety notes:** -
- **Acceptance criteria:**
  - Given a release, then the docs are rebuilt with that release's matrix
  - Given every W-* code, then a docs page explains it

#### PLAT-16 Free web utilities

- **Milestone:** M4 (design-phase tag: M2) · **Size:** M · **Parity:** unique · **Personas:** DEV,OPS
- **Description:** Static tools: x-death decoder, routing tester, policy tester, URI builder, definitions linter, upgrade checker; they reuse the engine's pure libraries.
- **Depends on:** TOP-02, POL-01, DIA-01
- **Safety notes:** -
- **Acceptance criteria:**
  - Given pasted headers, then decoding happens client-side with no network request
  - Given the routing tester, then results match the in-app simulator on shared fixtures

#### PLAT-17 Local broker launcher

- **Milestone:** M6 (design-phase tag: M4) · **Size:** M · **Parity:** beyond · **Personas:** DEV
- **Description:** Start RabbitMQ in Docker or Podman by version with plugins and seeded definitions; reset; switch versions to rehearse upgrades.
- **Depends on:** -
- **Safety notes:** -
- **Acceptance criteria:**
  - Given 'launch 4.3.6 with streams', then a profile is created and connected
  - Given reset, then the container and its volume are removed after confirmation

#### PLAT-18 On-call responsive view

- **Milestone:** M8 (design-phase tag: M6) · **Size:** M · **Parity:** beyond · **Personas:** OPS
- **Description:** A phone-friendly PWA view of the team server for alerts, health and pre-approved jobs.
- **Depends on:** TEAM-01, MON-06
- **Safety notes:** -
- **Acceptance criteria:**
  - Given a 390 px viewport, then alerts and approvals are usable without horizontal scroll
  - Given a pre-approved job, then it can be started with a second-factor confirmation
