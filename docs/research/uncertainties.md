# Remaining uncertainties U-01…U-26

Everything in the fact sheet is code- or doc-derived. These items must be settled empirically (lab cells, spikes, provider runs) before the features that depend on them ship. Each one is tracked as a GitHub issue (label `type:lab-cell`). WP ids below are the original design ids; see [`docs/plan/work-items.md`](../plan/work-items.md) for the re-sequenced ids and issue links.

**Rule.** A feature whose correctness depends on an uncertainty cannot merge (or stays behind a disabled flag) until the lab result or spike is recorded. A negative result changes the registry or the design, never the test.

## U-01

**Uncertainty.** Every cell of the QQ and CQ version × settle-action matrix is code-derived and none has been measured. Priorities: (1) on 4.3, graceful channel.close, connection.close and basic.cancel-then-close count as failed deliveries; (2) TAIL placement on 3.13 with no limit and on 4.0-4.2 with L=-1; (3) on 4.0-4.2, x-delivery-count equals acquired_count on both get and consume paths; (4) the 4.3 DLQ carry-over drop for both at-most-once and at-least-once dead-lettering, from CQ and from QQ sources; (5) the 3.13 -1 drop on first return.

**How to resolve.** Conformance suite on Testcontainers images 3.13.7, 4.0.9, 4.1.8, 4.2.9 and 4.3.6, plus the 4.4 alpha. Each test asserts x-delivery-count, x-acquired-count, redelivered, position and survival after each action.

**Scheduled as.** CF-SETTLE, CF-DOWN and CF-CARRY cells on 5 versions · design WP M0-38/39/40 · must land before: every peek/tap/DLQ WP; M0 exit · if negative: Human-reviewed registry fix; the planner uses the corrected cell

## U-02

**Uncertainty.** How to detect the effective QQ machine version (v7 vs v8) over HTTP in mixed or upgraded clusters. Status 'Machine Version' shows per-node code version from 4.0.9; flag rabbitmq_4.3.0 is only 'stable'.

**How to resolve.** Lab: rolling upgrade 4.2.9→4.3.6 with the flag disabled and then enabled. Compare the status endpoint, flag state and canary-QQ behaviour. Decide whether an opt-in canary QQ is acceptable on team servers.

**Scheduled as.** Rolling upgrade 4.2.9→4.3.6 with the flag off and on; status endpoint vs canary QQ · design WP M0-41 (canary decision in M3-03) · must land before: era resolver GA (M0); team canary (M3) · if negative: Keep the conservative rule; canary stays opt-in

## U-03

**Uncertainty.** Whether an aborted HTTP POST /get (client or proxy timeout) kills the handler and closes the direct channel while it holds messages, which on 4.3 would count as failed deliveries for each held message.

**How to resolve.** Lab: abort the request mid-way on 4.3.6 and 4.2.9, then inspect the counters. Fix the client-timeout policy accordingly.

**Scheduled as.** CF-HTTPGET-ABORT on 4.2.9/4.3.6 · design WP M1-06 · must land before: MSG-13 (M1-37) · if negative: Client timeout above server work; hide the fallback for finite-L QQs on 4.3

## U-04

**Uncertainty.** Whether, under Raft leader changes or load, the DOWN signal from a closing channel can overtake a nack pipelined just before it. If so, the nack + qos barrier protocol may still occasionally produce failed-delivery counts.

**How to resolve.** Chaos test with toxiproxy plus leader transfers during peek; measure DC deltas over thousands of runs.

**Scheduled as.** Lab-driver chaos pre-run, then executor chaos (S-09) · design WP M1-06, M1-38 · must land before: 'lab-verified' badge on QQ peek; 1.0 · if negative: Lazy close after the barrier, W-CRASH disclosure; badge stays 'code-derived'

## U-05

**Uncertainty.** 4.3 delayed retry: does a single nack peek on type all/returned delay message visibility by at least min, and how do the management stats (messages_delayed, next_delayed_at) and Prometheus expose this?

**How to resolve.** Lab on 4.3.6 with x-delayed-retry-* arguments and 4.3.1+ policy keys.

**Scheduled as.** CF-DR cells · design WP M0-40 · must land before: planner W-DELAY (M1-12) · if negative: Treat types all/returned as consent-gated

## U-06

**Uncertainty.** Local shovels (4.2+): do they carry delivery_count and death annotations into a destination QQ (preserving an exhausted budget and history), and what does the Amazon MQ queue-migration path do?

**How to resolve.** Lab: dead-letter at the limit, local-shovel to a QQ, inspect the headers and first-return survival; compare with 0-9-1 republish.

**Scheduled as.** CF-SHOVEL-CARRY · design WP M2-06 · must land before: shovel moves (M4-07) · if negative: Shovel moves stay off; engine republish only

## U-07

**Uncertainty.** Stream reads: (a) does rabbitmq-amqp-js-client 1.0.0 Offset.first() start at 'next' on 4.3.6 and at 'first' on 4.2.9, and are BigInt offsets ignored everywhere? (b) does the 3.13 AMQP 1.0 plugin support stream offset and filter specs? (c) how often does an AMQP stream reader land on a node without a replica behind a load balancer?

**How to resolve.** Lab against 3.13.7, 4.2.9 and 4.3.6, including a 3-node cluster behind a TCP load balancer and a node added after stream declaration.

**Scheduled as.** Oracle diff, plus cells on 3 nodes behind HAProxy · design WP M1-08 · must land before: STR-01/02 (M1-30/31) · if negative: 3.13 streams via 0-9-1 only; replica helper

## U-08

**Uncertainty.** End-to-end header fidelity for 0-9-1-published messages in streams and across protocols: which headers survive each read path, and how x-death and Laravel/Celery tables appear.

**How to resolve.** Fixture messages published via 0-9-1 and AMQP 1.0 into CQ, QQ and stream, read back via 0-9-1, AMQP 1.0 and the stream protocol; diff the headers.

**Scheduled as.** CF-FIDELITY · design WP M1-06 · must land before: viewer badges (M1-45); DLQ views (M1-51) · if negative: Show the 'possible loss' badge by default

## U-09

**Uncertainty.** Runtime confirmation of the vhost PUT side effects at v4.1.4+ (default_queue_type reset; description and tags wipe), and whether tracing:false stops tracing only on the serving node.

**How to resolve.** Integration test on 4.1.8, 4.2.9 and 4.3.6 with a vhost whose default queue type is quorum.

**Scheduled as.** CF-OPS-VHOST · design WP M0-41 · must land before: any vhost write (M2-01); firehose (M2-05) · if negative: GET-merge-PUT regardless (DC-21)

## U-10

**Uncertainty.** Back-pressure from a slow tap queue on production publishers (flow control, confirms latency) and safe default max-length/prefetch values.

**How to resolve.** Load test with a 10k-message tap and a slow consumer; measure publisher latency and throughput.

**Scheduled as.** Load test · design WP M1-29 · must land before: tap defaults GA · if negative: Lower max-length and prefetch; add a warning

## U-11

**Uncertainty.** Amazon MQ behaviours not documented by AWS: vhost tracing toggle, feature-flag enable, replica ops and rebalance, /api/config/effective, health checks; whether exclusive taps under the quorum default really become classic; whether AWS default policies match tap queues; Prometheus access with OAuth/IAM tokens.

**How to resolve.** Contract tests on Amazon MQ 3.13, 4.2 and 4.3, single-instance and cluster brokers.

**Scheduled as.** Provider contract runs, v0 then v1 · design WP M0-63, M1-29, M2-09 · must land before: M0 exit (probe); presets (M2) · if negative: Gate the feature off with a reason

## U-12

**Uncertainty.** CloudAMQP shared and dedicated specifics: tenant user tags; policy and shovel rights; access to amq.rabbitmq.event; stream advertised_host and firewall defaults; undocumented HTTP rate limits.

**How to resolve.** Test accounts on Little Lemur and a dedicated plan; ask 84codes.

**Scheduled as.** Provider contract runs, v0 then v1 · design WP M0-63, M1-29, M2-09 · must land before: M0 exit (probe); presets (M2) · if negative: Gate the feature off with a reason

## U-13

**Uncertainty.** LavinMQ compatibility: definitions JSON round-trip, metric-name compatibility, x-death format, /stream endpoint semantics.

**How to resolve.** Lab against LavinMQ 2.10.2 using the RabbitMQ contract suite with expected deviations recorded.

**Scheduled as.** Golden fixtures and a contract suite with recorded deviations · design WP M0-25, M1-37, M2-09 · must land before: HTTP get adapter (M1); presets (M2) · if negative: AMQP-only and read-only for unverified endpoints

## U-14

**Uncertainty.** Auth runtime behaviour: token expiry per protocol and version (including AMQP 1.0 on the 3.13 plugin and stream ANONYMOUS); the real 431 and frame_too_large thresholds with Entra and Keycloak tokens; whether advanced.config cowboy_opts fixes 431 on 4.2/4.3; whether ?token= on /api/definitions works anywhere.

**How to resolve.** Lab plan from the auth report (§7) on 3.13.7-4.3.6 with Keycloak 26 and an Entra test tenant.

**Scheduled as.** Keycloak 26 + Entra lab · design WP M1-25 · must land before: TokenManager GA (M1-23/24) · if negative: Reconnect before expiry everywhere; size warnings

## U-15

**Uncertainty.** IdP specifics: ephemeral loopback ports on Okta and Auth0; reuse of the management UI's Entra registration; whether Entra OBO and Keycloak 26.2 token exchange produce broker-audience tokens with the claims RabbitMQ needs.

**How to resolve.** Spikes against each IdP tenant.

**Scheduled as.** Per-tenant spikes · design WP M1-24/25, M3-05 · must land before: OAuth login (M1); delegated mode (M3) · if negative: Fixed ports or device code; service-account mode

## U-16

**Uncertainty.** Electron 44/45 runtime: tls.getCACertificates('system'), setDefaultCACertificates and crypto.argon2 under BoringSSL; PKCS#12 client certificates; safeStorage async timing; keychain prompts from the utilityProcess; macOS local-network prompt attribution and the denial path; MessagePort RPC performance; NestJS 12 cold start in a utilityProcess (budget ~400 ms).

**How to resolve.** Desktop spike on Windows, macOS (arm64 and x64) and Linux with instrumented builds.

**Scheduled as.** S-01/02/03 and S-07 · design WP M0-18, M0-19 · must land before: M0-26, M0-34, M0-56/57 · if negative: CJS bundle; scrypt; engine-link worker; documented prompts

## U-17

**Uncertainty.** amqplib behaviours: nacking delivery tags after a server-initiated basic.cancel (4.3 consumer timeout); CPU and GC for 1-10 MB messages; and whether rhea release() always sends 'released'.

**How to resolve.** Adapter contract tests plus benchmarks; follow amqplib PR #860.

**Scheduled as.** Contract cells and benchmarks · design WP M0-28, M1-06, M1-08 · must land before: peek executor (M1-14) · if negative: Get-only peek, with no consumer path where unsafe

## U-18

**Uncertainty.** Classic-queue requeue ordering for messages paged to disk (delta) and for priority classic queues.

**How to resolve.** Lab on 4.2.9 and 4.3.6 with large backlogs and priority queues.

**Scheduled as.** CF-CQORDER · design WP M1-06 · must land before: CQ 'original position' claim (M1-14) · if negative: Receipt says 'position may change'

## U-19

**Uncertainty.** Whether a client-published x-delivery-count, copied on replay, causes premature dead-lettering or wrong retry decisions in consumers (Rebus, NServiceBus immediate retries, Sneakers), and which counter resets each framework honours.

**How to resolve.** Framework fixture apps in CI (MassTransit v8, NServiceBus, Rebus, Spring, Celery) replaying with and without stripping.

**Scheduled as.** CF-DLQ cells; fixture apps · design WP M1-35, M2-07 · must land before: replay defaults (M1-34); decoders (M2) · if negative: Strip by default (already the plan)

## U-20

**Uncertainty.** MassTransit v9 wire details (header types on _error, mt-delay-* x-death patterns) and the peek side effects of the v9 Dashboard and ServicePulse on QQ error queues.

**How to resolve.** Licensed v9 test harness; measure counters on 4.2.9 and 4.3.6.

**Scheduled as.** Licensed harness (optional) · design WP M2-07 · must land before: any v9 claim · if negative: Claim v8 only

## U-21

**Uncertainty.** Signing pipeline feasibility: SignPath reputation threshold and whether the linter falls under the 'No hacking tools' clause; electron-builder plus SignPath two-pass NSIS signing and regeneration of latest.yml/blockmap; MSIX packaging of the Electron app with the utilityProcess engine; Certum renewal and headless CI signing.

**How to resolve.** Ask SignPath directly; prototype on GitHub-hosted Windows runners; test MSIX submission.

**Scheduled as.** S-10 plus a SignPath inquiry · design WP M0-19 · must land before: M0-67/68 · if negative: Unsigned NSIS for the internal alpha only

## U-22

**Uncertainty.** Monorepo tooling: when @nx/nest supports NestJS 12; whether Nx executors handle NestJS 12 ESM; Nx with Angular 22.2.x migrations.

**How to resolve.** Spike before fixing the repository layout; track the @nx/nest peer range.

**Scheduled as.** S-11 inside M0-01 (@nx/nest is moot) · design WP M0-01 · must land before: everything · if negative: Pin Nx 23.3.0; run-commands targets

## U-23

**Uncertainty.** Cytoscape WebGL renderer reliability on GPU blocklists, VMs and remote desktops inside Electron.

**How to resolve.** Test matrix on VMs and RDP sessions, with automatic canvas fallback telemetry kept local.

**Scheduled as.** Spike · design WP M1-11 · must land before: topology view (M1-49) · if negative: Canvas by default; WebGL opt-in

## U-24

**Uncertainty.** Trademark clearance of the chosen name, and Broadcom's stance on 'Rabbit'-prefixed names or imagery.

**How to resolve.** USPTO, EUIPO and WIPO searches; email rabbitmq-core@groups.vmware.com before committing.

**Scheduled as.** Searches plus the core-team email · design WP M0-09 · must land before: first public artefact · if negative: Runner-up name (Kewbench)

## U-25

**Uncertainty.** Upstream status: will coders51 accept the AMQP 1.0 client fixes (filters, credits #94, vhost #95, race #96), will the stream client get update-secret and address mapping, and will cloudamqp/amqp-client accept SASL EXTERNAL?

**How to resolve.** Open PRs early; decide by milestone whether the in-house adapters stay permanent.

**Scheduled as.** PRs opened in M1-08; status reviewed at each release · design WP — · must land before: nothing · if negative: Keep the in-house adapters

## U-26

**Uncertainty.** Market data: managed vs self-hosted share, distribution of broker versions in the field, and willingness to pay or adopt.

**How to resolve.** Community survey; ask CloudAMQP and AWS for anonymised version distributions; track download and pull metrics.

**Scheduled as.** Survey after the beta; download counters · design WP M1-59 · must land before: roadmap reprioritisation only · if negative: —
