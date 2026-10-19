# svc-capabilities

The capability probe: it reads a broker with management requests (and two handshakes), builds the `BrokerProfile` (DC-31) and caches it. This work package (M0-45, CON-03 part 1) is the probe sequence, the profile builder, the cache and the two actions. The feature gates, the `allowedActions` and the era's own rules are part 2 (M0-46).

Tags: `type:service`, `runtime:node`.

## Public API

- `createCapabilitiesModule(deps)`: returns the `EngineModule` the composition root registers, with two actions.
- `CapabilitiesModuleDeps` (`src/deps.ts`): `mgmt` (`MgmtReadPort`, the BrokerScheduler's read wrapper: the module is never given a write port), `wire` (`BrokerWireProbe`: the TLS and AMQP handshakes), `profiles` (`BrokerProfileStore`: `repos.brokerProfiles` of persistence), `connections` (`ConnectionStore.get`, only to tell whether the caller may see the connection), and optionally `lastVerified` and `registry`.
- `createCapabilitiesFakeDeps()` and the fakes in `src/testing.ts`: a scripted management API (it answers from a table by path and records every request), a fake wire probe, an in-memory cache.
- `runProbe(env)`, `buildProfile(input)`, `fingerprintOf(profile)`: the probe, the facts-to-profile function and the fingerprint, for the composition root, tests and the diagnostics.

| Action | Kind and route | What it does |
| --- | --- | --- |
| `probe.run` | query, `POST /connections/{cid}/probe` | Runs the twelve steps, caches the `BrokerProfile`, and answers the profile, whether its fingerprint changed and how each step went. It is a query on purpose (OQ-470): it reads the broker and refreshes a cache. |
| `profile.get` | query, `GET /connections/{cid}/profile` | The cached profile, or `NOT_FOUND` ("run the probe first"). No broker request. |

## The probe (fact sheet j.2)

Network, then unauthenticated, then identity, then product, then features. Each step is a file in `src/probe/steps/`; a step fills `Facts` and reports `ok`, `unavailable` (the broker or this login has no such endpoint), `failed` or `skipped`. A step that fails does not stop the run: the fact stays unknown and the builder reads it the cautious way. Only the overview is required (without a product there is no profile): its failure is a Problem (`UNAUTHENTICATED`, `BROKER_UNREACHABLE`, ...) and the cached profile is kept.

| # | Step | Reads | Fills |
| --- | --- | --- | --- |
| 1 | `01-tls` | the handshake, through `BrokerWireProbe` | `tls` (`verified` only when the chain verified) |
| 2 | `02-host-fingerprint` | the host name, against the registry's provider presets | the provider |
| 3 | `03-oauth-discovery` | `/js/oidc-oauth/bootstrap.js`, then `/api/auth` | `auth.oauth` (the issuer; `pinned` is always false here) |
| 4 | `04-identity` | `/api/whoami` | `identity` (tags drive every gate) |
| 5 | `05-overview` | `/api/overview`, three times | product, version, statistics mode, default queue type, exchange types, listeners, `lbFronted` |
| 6 | `06-extensions` | `/api/extensions` | `extensions` |
| 7 | `07-nodes` | `/api/nodes` | `nodes` |
| 8 | `08-feature-flags` | `/api/feature-flags`, `/api/deprecated-features/used` | `featureFlags`, `deprecatedFeaturesUsed` |
| 9 | `09-vendor-fingerprints` | policies, operator policies, users (administrators only), against the presets' owned objects | the provider again, `managedObjects` |
| 10 | `10-exchanges` | `amq.rabbitmq.event` and `amq.rabbitmq.trace` of the default vhost | `firehose` |
| 11 | `11-prometheus` | nothing: listeners of the overview, then the provider's ports, then the default port when the plugin is on | `prometheus.endpoints` |
| 12 | `12-amqp-handshake` | the handshake, through `BrokerWireProbe` | `limits.channelMax`, `limits.frameMax` |

Step 13 of the fact sheet (write-shaped probes on demand) is not part of this package: `qqReplicaOps` stays `unknown`.

## Rules the profile builder follows

- **Unknown is cautious (I-3 stays with the registry).** A version that cannot be read is `null`; the registry then reports every hazard that might apply and grants no capability, and the era resolver falls back to 4.0-4.2. The builder compares no version for a decision: the era, the hazards, the capabilities and the provider limits are the registry's answers.
- **A node has a version only if it answered the overview itself.** The lab brokers (3.13.7 to 4.3.6) answer no per-node version in `/api/nodes` (OQ-475), so a cluster is read from the nodes that answered, and a node that never did is `null`. If the node list cannot be read at all, one entry `(nodes not listed)` stands for the nodes nobody has looked at.
- **A product that is not RabbitMQ has no RabbitMQ version.** LavinMQ reports `2.10.2`; that is recorded as unreadable, with the reason in `era.reasons`. The build is `commercial-or-unknown` unless the product is RabbitMQ and the provider is not one that runs its own builds.
- **The provider needs evidence.** The host name and the provider-owned objects must agree; a disagreement, or none, is `unknown` (the preset that assumes nothing). A loopback address is `self-hosted`.
- **A missing statistics flag means statistics are off.** RabbitMQ reports `disable_stats` explicitly; LavinMQ has no switch.
- **Load balancers.** `/api/overview` is asked three times; different node names mean `lbFronted`, with the names as evidence and a line saying that node-local results come from one node. A managed provider is treated as balanced. Every probe read gets a schema object of its own, because the BrokerScheduler merges identical reads and reuses an answer: without that a second probe would not ask again, and the three asks would be one.
- **Fingerprint.** SHA-256 of the canonical JSON of the profile without `probedAt`: it follows what a decision reads, not the time of the probe or the order of the nodes.
- **Statistics off** (OQ-431): the overview lists no listeners and the node list no plugins, so no metrics endpoint is guessed.

## Invariants

- **The probe never touches `MgmtWritePort` (I-2).** The module's deps hold `MgmtReadPort` only; the specs replay every golden fixture through a recording fake and assert every request is a GET.
- Never imports another service or an adapter; the TLS and AMQP handshakes are the `BrokerWireProbe` port (I-9), the cache is `BrokerProfileStore`.
- A profile holds no secret: what a broker said about itself. Details of a failed step are reasons and counts, never the broker's text, a URL or a credential (I-10).
- Bounded (I-6, I-7): 100 nodes, 500 feature flags, 200 extensions and managed objects, 16 metrics endpoints, 64 KiB of any script read.

Open questions: OQ-470 to OQ-479 in [docs/open-questions.md](../../../docs/open-questions.md).

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p svc-capabilities
pnpm nx test svc-capabilities                 # fixtures of RabbitMQ 3.13.7 to 4.3.6 (statistics on and off) and LavinMQ 2.10.2
pnpm nx run svc-capabilities:it '--versions=3.13.7,4.0.9,4.1.8,4.2.9,4.3.6'   # real brokers, adapter, SQLite; needs Docker and openssl
```
