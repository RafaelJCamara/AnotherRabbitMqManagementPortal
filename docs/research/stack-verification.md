# Stack, distribution and legal verification

> **Verified research (2026-10-16).** Source read at exact release tags and primary docs; **not yet lab-tested**. The conformance suite (M0) confirms or corrects every runtime claim. Content about a specific third-party product was removed under the docs policy ([ADR-034](../adr/ADR-034-docs-policy.md)).

# Part 1: TypeScript engine stack

### Summary

A TypeScript engine is workable, with one condition: the AMQP 1.0 path has to be our own adapter on raw rhea 3.0.5. The client RabbitMQ lists for JavaScript (rabbitmq-amqp-js-client 1.0.0) cannot support the headline features.

**Claims that hold up**
- amqplib 2.2.0 came back to life in 2026, with 15 npm releases. Its source has EXTERNAL, update-secret, blocked/unblocked, server cancel (the callback gets null), confirms, `get` and `nack(requeue)`.
- Node 24 goes into maintenance on 2026-10-20 and Node 26 becomes LTS on 2026-10-28.
- Electron 40 to 45 ship Node 24. Electron 45 goes GA on 2026-10-20 with Node 24.22.0.
- The fuse, utilityProcess and Playwright limits are as described.
- NestJS 12 came out on 2026-08-27, ships ESM packages and supports Standard Schema.
- node:sqlite is a release candidate and includes FTS5.
- Orval 8 generates Angular `HttpClient` services and `httpResource` functions.

**The decisive problem: the JS AMQP 1.0 client fails on 4.3 (found by reading the code; I did not run it against a broker)**
- It sends `rabbitmq:stream-offset-spec`, `stream-filter` and `match-unfiltered` as plain values, not described types. RabbitMQ 4.3.x drops these without any error, because the deprecated feature `amqp_filter_set_bug` is `denied_by_default`; on main it is `removed`.
- Numeric and timestamp offsets are JS bigints, which rhea 3.0.5 encodes as an empty map.
- It cannot select a vhost (PR #95 is still open).
- Credit cannot be set, so rhea's default of 1000 applies and refills as messages arrive. A peek would therefore take up to 1000 messages off the queue.
- Publisher and consumer addresses are not percent-encoded.
- Concurrent link creation can hand a publisher the wrong link (#96). The reporter says this misrouted about 20,000 production messages.
- It depends on rhea through a git URL, has no LICENSE file, and has had no commits since 2026-06-25.
- The Go and .NET AMQP 1.0 clients (both 1.4.0) handle all of these correctly.

**Other claims that are wrong or only partly true**
- The stream client's "OIDC" in 1.1.0 is a change to its npm release workflow, not RabbitMQ OAuth.
- nestjs-zod 5.5.0 declares peers for Nest 10 and 11 only.
- Tauri 3 alpha has a CEF runtime on GTK4, but not WebKitGTK 6.
- Node's single-executable feature (SEA) docs say macOS x64 is "not currently supported", and `--build-sea` does not exist in Node 24.
- `@testcontainers/rabbitmq` does not expose the stream port (5552) or the Prometheus port (15692).

**Risk compared with Go and .NET**
- I checked 17 protocol and client capabilities. The TS libraries as shipped cover 7. Go covers 16. .NET covers all 13 that I could verify, with 4 not checked.
- With our own rhea adapter, our own management HTTP client and a test matrix across broker versions, TS reaches 16 of 17.
- Remaining risks: amqplib and rhea each effectively depend on one maintainer, and none of the Node client libraries tests against RabbitMQ 4.3 in CI.

**Versions to pin**

| Component | Version |
| --- | --- |
| Node | 24.22.x (CI also on 26.12) |
| Electron | 45.0.x |
| TypeScript | 6.0.3 (npm `latest` is 7.0.2, which breaks Angular 22) |
| NestJS | 12.1.3 |
| @nestjs/swagger | 12.0.2 |
| amqplib | 2.2.0 |
| rhea | 3.0.5, plus our own adapter |
| rabbitmq-stream-js-client | 1.1.0, optional |
| Kysely | 0.29.6, with an in-repo node:sqlite dialect |
| zod | 4.6.7 |
| orval | 8.43.0 |
| testcontainers | 12.2.1 |

### Verdicts

| ID | Verdict | Confidence | Verified statement |
| --- | --- | --- | --- |
| E1 | confirmed | high | All dates and features are confirmed. - **Release dates (npm):** 1.0.0 on 2026-03-28T15:46Z, 1.1.0 on 2026-05-09T15:44Z, 1.2.0 on 2026-05-09T19:28Z, 2.0.0 on 2026-05-10 and 2.2.0 on 2026-09-28T09:52Z. That makes 15 npm releases in 2026. - **Package (2.2.0):** zero runtime dependencies (since 2.0.1), engines node>=18, CommonJS with a types exports map, and npm provenance attestations. - **Recovery:** opt-in through `connect(url, {recovery:{...}})`. The caller rebuilds topology and consumers in a `setup(model)` callback that runs after every reconnect. Nothing is recorded or re-declared automatically. - **Breaking change in 2.0.0:** `heartbeat: 0` now disables heartbeats. - **Maintainers:** npm lists two (squaremo, cressie176), but 111 of the 132 GitHub commits in 2026 (84%) are by cressie176, so the bus factor is effectively 1. - **CI:** tests only against RabbitMQ 4.2 (rabbitmq:4.2-alpine) on Node 18 to 24. There is no 4.3 and no Node 26. |
| E2 | nuanced | high | **What is confirmed** - 1.0.0 (2026-06-25T15:06Z) is still the latest version. - Its only dependency is `"rhea": "github:amqp/rhea"`, a git URL pointing at rhea's default branch. That is no longer needed: rhea 3.0.5 on npm already contains the modified-outcome fix. - RabbitMQ's docs mark lifecycle (ChangeState) listeners and consumer graceful shutdown as 'CURRENTLY NOT IMPLEMENTED', and topology recovery as 'NOT TESTED'. - The client has no purge and no list-bindings, even though the broker serves `DELETE /queues/:q/messages` and `GET /bindings`.  **Features that work** - released and modified outcomes: `requeue()` sends released; `requeue(ann)` sends modified with delivery_failed=false; `discard(ann)` sends modified with delivery_failed=true and undeliverable_here=true. - SQL, properties and application-properties filters are correctly sent as described types (0x120, 0x173, 0x174). - Token refresh works: `refreshToken()` does `PUT /auth/tokens`.  **Defects in 1.0.0 (code-level, not executed against a broker)** - (a) `rabbitmq:stream-offset-spec`, `rabbitmq:stream-filter` and `rabbitmq:stream-match-unfiltered` are sent as plain (non-described) values. RabbitMQ 4.1 and 4.2 accept these through the `amqp_filter_set_bug` compatibility path, which is `permitted_by_default`. In 4.3.0 to 4.3.6 that path is `denied_by_default`, so the filters are silently dropped; on main it is `removed`. - (b) `Offset.offset(n)` and `Offset.timestamp(d)` produce a JS bigint. rhea 3.0.5's `types.wrap` has no bigint branch and encodes it as an empty map, which the broker ignores on every version. `Offset.offset(0n)` sends the string "numeric". - (c) Address v2 is used, but publisher and consumer addresses are not percent-encoded. Management paths are encoded. - (d) SASL EXTERNAL is not exposed in the typed API. It is only reachable by casting rhea options through the `...envParams` spread. - (e) There is no vhost option (PR #95 has been open since 2026-07-15). The only workaround is passing `hostname:'vhost:<v>'` through that spread. - (f) There is no credit control (PR #94 open), so rhea's default `credit_window` of 1000 applies. - (g) `openLink` resolves through a connection-level `once`, so concurrent link creation can return the wrong link (issue #96, which reports production misrouting). - (h) `console.log(container_id)` runs in every Consumer and Publisher constructor. - (i) There is no LICENSE file; package.json says ISC. - (j) CI runs only against RabbitMQ 4.2.0-beta.3. - (k) The repo has had no commits since 2026-06-25 and has 9 stars. |
| E3 | nuanced | high | **Version:** only 1.1.0 exists (2026-07-23); there is no 1.1.x patch.  **Confirmed features** - Offset specs first, last, next, numeric and timestamp. - Bloom filtering; 1.1.0 adds filtering on super-stream publishers and consumers. - Super streams. - Single active consumer with `consumerUpdateListener`. - SASL EXTERNAL through the `mechanism` option (since 0.6.1).  **OAuth: not supported as described** - The '1.1.0 Add OIDC login and publish' change (PR #293) only touched the npm release workflow (trusted publishing). It is not RabbitMQ OAuth support. - A JWT can be sent as the SASL PLAIN password. - The server supports updating the secret after the connection is open, by re-sending SaslAuthenticate with the same mechanism and username. The client offers no API for this.  **Address resolver** - `addressResolver: {enabled, endpoint}` is a load-balancer mode only. The client reconnects through one endpoint until the node's advertised host and port match the chosen node, giving up after (2 + nodes)^2 attempts. - There is no callback for mapping advertised hosts.  **Maintenance** - 52 stars, 0 open issues, last push 2026-07-23. - 2 releases and 10 commits in 2026. - CI runs only against RabbitMQ 4.0.5 on Node 18 to 24. - The licence metadata is inconsistent: package.json says ISC, but the LICENSE file is MIT text. |
| E4 | confirmed | high | **@cloudamqp/amqp-client 4.1.1 (2026-08-28, Apache-2.0, zero dependencies)** - It always sends PLAIN in connection.start-ok, so there is no EXTERNAL. - It has `updateSecret()`, `onblocked`/`onunblocked`, and closes the consumer with 'Consumer cancelled by the server' on a server cancel. - It offers a WebSocket transport (`AMQPWebSocketClient`), which needs a relay in front of the broker. - 4.1.0 (2026-08-19) fixed a 'Frame end out of range' crash on Node >=24.18 and >=26.3. Node raised the default `Buffer.poolSize` from 8 KiB to 64 KiB (nodejs/node#63597, shipped in 24.18.0 on 2026-06-23 and 26.3.0 on 2026-06-01). - It is actively maintained: 4 npm maintainers, more than 100 commits from 8 authors in 2026.  **rabbitmq-client 5.0.8 (2025-12-01)** - It hard-codes PLAIN, with a `// TODO support EXTERNAL` comment. - It has no update-secret. - It has a single maintainer, made no release in 2026, and was last pushed 2026-03-04.  **Is amqplib affected by the same Node change?** I found no byteOffset-sensitive DataView or ArrayBuffer code in amqplib 2.2.0 or rhea 3.0.5, so they are likely unaffected. |
| E5 | nuanced | high | **Go clients** - amqp091-go v1.15.0 was released 2026-09-15. - Automatic connection and channel recovery with state-change notifications arrived in v1.12.0 (2026-06-16). Automatic topology recovery arrived in v1.13.0 (2026-07-21), and became the default ('Make TopologyRecoveryAllEnabled the default'). - rabbitmq-amqp-go-client v1.0.0 has a Go-module commit time of 2026-04-13, but its GitHub release was published 2026-04-20. More importantly, the current version is v1.4.0 (GitHub release 2026-09-09), with 9 releases in 2026. - rabbitmq-stream-go-client v1.8.3 was released 2026-07-23.  **Node clients** - No Node 0-9-1 or stream client carries RabbitMQ's checkmark meaning 'officially supported by Team RabbitMQ'. - However, RabbitMQ's AMQP 1.0 client page does list the coders51 JavaScript client among 'the libraries the RabbitMQ team supports'. |
| E6 | nuanced | high | **node:sqlite** - It is 'Stability: 1.2 - Release candidate'. That status arrived in v25.7.0 and was backported to v24.15.0. - All Database and Statement APIs are synchronous. The one exception is `backup()`, which returns a Promise. - It is compiled with FTS3, FTS5, RTREE, SESSION, MATH_FUNCTIONS and PERCENTILE, on SQLite 3.53.4. - Node 26.11.0 added documentation-only deprecations DEP0210 and DEP0211, renaming `DatabaseSync`/`StatementSync` to `Database`/`Statement`. Node 24 has only the `*Sync` names.  **Kysely dialects** - There is no maintained first-party dialect. Kysely 0.29.6 and 0.30.0-beta.2 ship none. - kysely-node-native-sqlite 1.1.0 declares `engines: node ^22.5.0`, which excludes Node 24 and 26. - @pikku/kysely-node-sqlite is tied to the Pikku framework. - Better Auth has an internal NodeSqliteDialect, but deliberately does not export it ('not production ready'). - Kysely's `SqliteDialect` only needs `prepare()` to return an object with `reader`, `all(params[])`, `run(params[])` and `iterate(params[])`. A wrapper of about 30 lines adapts node:sqlite.  **Drizzle** - The stable 0.45.4 (2026-10-08) has no `./node-sqlite` export. - The 1.0 pre-releases (beta.16 and later, and rc.1 to rc.4; rc.4 dated 2026-06-27) do. |
| E7 | confirmed | high | **Node** - v24 'Krypton' enters maintenance on 2026-10-20 and reaches end of life on 2028-04-30. - v26 becomes LTS on 2026-10-28 (end of life 2029-04-30). - v27 alpha is due 2026-10-28.  **Electron** - Stable lines 40.0.0 (Node 24.11.1) through 45 (Node 24.22.0) all bundle Node 24. - Electron 46 is pre-release only: the nightly runs Node 24.21.0; alpha is due 2026-10-22, beta 2026-12-03 and stable 2027-01-05, with Chromium 160. - Electron moves its main branch to a new even-numbered Node when that Node enters Active LTS, and 46's alpha comes before Node 26's LTS date. So 46 probably ships Node 24 and 47 Node 26. This is an inference, not a published fact. - Electron 44.0.0 shipped Chromium 152.0.7977.54 and Node 24.18.1. Its GitHub release is dated 2026-08-25T00:42Z (releases.json says 2026-08-24). It requires macOS 13 or later and dropped Windows ia32 and Linux armv7l, so it is 64-bit only. - Electron 45 goes stable on 2026-10-20 with Chromium 156 and Node 24.22.0, end of life 2027-04-27. Today npm `latest` is still 44.8.0. |
| E8 | confirmed | high | **Confirmed as stated** - With the RunAsNode fuse disabled, `child_process.fork` throws, and Electron's docs recommend utility processes instead. - `utilityProcess.fork` can only be called after the app's `ready` event. - `child.postMessage(message, [MessagePortMain])` can hand a utility process one end of a `MessageChannelMain`, so the main process can wire a port directly between a renderer and the utility process. - Playwright says it has 'experimental support' for Electron, supports Electron v21+, and needs the `nodeCliInspect` (EnableNodeCliInspectArguments) fuse to not be set to false.  **Changes worth adding** - Electron 46: `utilityProcess` `child.kill()` no longer force-kills the child. It sends SIGTERM only, so the engine must exit from its own SIGTERM handler. - Electron 46 also removes the synchronous safeStorage APIs (deprecated in 45). - The utilityProcess `disclaim` option defaults to false, so TCC attribution (for example macOS local-network permission prompts) stays with the app. |
| E9 | nuanced | high | **NestJS 12** - 12.0.0 was released 2026-08-27; the latest is 12.1.3 (2026-10-12). - All core packages ship as ESM (`type: module`). Existing CommonJS apps still work through `require(esm)`, which is why Node v20.19+ or v22.12+ is required. - The route decorators (`@Body`, `@Query`, `@Param`, `@RawBody`) accept a Standard Schema `schema` option, which covers zod 4, Valibot and ArkType. - @nestjs/platform-fastify 12.1.3 pins `fastify` to exactly 5.12.5.  **zod 4 to OpenAPI** - @nestjs/swagger 12 (12.0.2) can turn Standard Schemas into the OpenAPI document through a new `standardSchemaConverter` option (its example uses zod-openapi). It also makes nullability correct for 3.1 documents. - nestjs-zod 5.5.0 is NOT compatible with Nest 12: its peers are @nestjs/common ^10 \|\| ^11 and @nestjs/swagger ≤11. - @asteasolutions/zod-to-openapi 9.1.0 has V3, V31 and V32 generators and needs zod ^4. - zod-openapi 6.0.2 targets OpenAPI 3.1 and needs Node 22.14+. - zod's own `z.toJSONSchema()` targets draft-2020-12 by default and also offers 'openapi-3.0'. `z.fromJSONSchema` is experimental.  **Orval** - Orval 8.43.0 (2026-10-14, needs Node 22.18+) generates Angular `HttpClient` services and `httpResource` functions, chosen with `override.angular.retrievalClient: 'httpClient' \| 'httpResource' \| 'both'` (default `httpClient`). - Since 8.34 and 8.35 its generators work internally on OpenAPI 3.1. - It shipped 43 minor releases in 2026, so pin it exactly.  **Not verified:** NestJS startup overhead. |
| E10 | nuanced | medium | **The module** - @testcontainers/rabbitmq 12.2.1 (2026-10-13) is released in lockstep with testcontainers 12.2.1, which requires Node >=22.22. - It is thin. It exposes only ports 5672, 5671, 15671 and 15672, sets guest/guest, waits for the log line 'Server startup complete', and allows 30 s to start. - It does not expose the stream port (5552) or Prometheus (15692). It has no helper for enabling plugins and no cluster support. Its test image is rabbitmq:4.3.6-management-alpine.  **GitHub-hosted runners** - Linux runners run Docker with Linux containers. - Windows Server 2025 images ship Docker 29.7.2, but only Windows containers run there, because there is no nested Hyper-V. Linux broker images cannot run. - macOS images ship no Docker at all. Homebrew does have rabbitmq 4.3.6, so a native broker can run on macOS runners. |
| E11 | nuanced | medium | **Linux rendering in Tauri 2** - Tauri 2.12.4's wry runtime uses webkit2gtk 4.1 on GTK3 on Linux. - The wry maintainers say 'We know WebkitGTK isn't that great' (wry#890, open since 2023). - There are current WebKitGTK launch and rendering bugs, for example tauri#16226, a webkit2gtk 2.44 Wayland DMA-BUF launch failure. How much this affects our UI has not been measured.  **Tauri 3 alpha** - Tauri 3.0.0-alpha.5 (2026-10-14) adds a CEF runtime (tauri-runtime-cef 3.0.0-alpha.6, cef =154.5.0) that uses GTK4. - Its wry runtime still uses GTK3 with webkit2gtk (=2.0, v2_40). The GTK4 / WebKitGTK 6 migration is an open PR (#14684). So WebKitGTK 6 is not in Tauri 3 alpha.  **Size and memory** - The comparison repo (Elanis) measures empty-app builds at about 296-385 MB for Electron against about 3-5 MB for Tauri, roughly 100×. - Its memory results are mixed, not 'roughly similar'. Release-build used memory: Windows about 279 MB (Electron) vs 307 MB (Tauri); macOS 364 vs 96 MB; Linux 589 vs 94 MB. - Our case needs a Node sidecar. The node 24.22.0 Linux binary is 126.8 MB uncompressed, and Node distributions are 26-51 MiB compressed, against Electron runtime zips of 117-151 MiB. That puts Tauri plus Node about 2.3-3× smaller, not 10×. |
| E12 | nuanced | high | **Node SEA** - SEA is 'Stability: 1.1 - Active development'. `--build-sea` was added in v25.5.0 and is absent from Node 24. - On Node 24 you need postject, whose last release is 1.0.0-alpha.6 from 2023, and the main script must be CommonJS. - Node 26 adds `mainFormat: "module"` and `useVfs` (v26.9.0, Stability 1.0 - Early development). - Node's CI tests SEA only on Windows, macOS arm64 and Linux. The docs say macOS x64 'is not currently supported and is skipped in the tests'. That is stronger than 'not CI-tested'. Alpine and s390x are also excluded. - Cross-platform builds must disable the code cache and snapshot.  **Bun 1.4.3 `--compile`** - Cross-compiles 8 targets, including darwin-x64 and musl. - Bun is not Node: `node:tls` lacks `pskCallback` and OCSP stapling. `node:sqlite` is fully implemented.  **Deno 2.9.7 compile** - Cross-compiles 6 targets, including macOS x64 and Windows ARM64 (Windows ARM64 since 2.9.3). - Embeds npm packages and native addons that are reached from the entry point. - Has a `--self-extracting` option.  **@yao-pkg/pkg 6.23.0 (2026-09-29)** - Traditional mode uses a patched Node fork, transforms ESM to CJS and compiles to bytecode. - 'Enhanced SEA mode' uses a stock Node ≥22 binary and runs ESM natively.  **Fit for our engine** - An engine with no native addons can use any of these. - Native addons, for example @napi-rs/keyring, have to be extracted to disk in every option. |
| P1 | refuted | high | In both coders51 repositories, 'Add OIDC login and publish' means npm trusted publishing, which authenticates the GitHub Actions release workflow to npm through OIDC. It is not OAuth2 or OIDC authentication to RabbitMQ. - Stream client: no OAuth feature. A JWT can be passed as the PLAIN password, and there is no token refresh API. - AMQP 1.0 client: does have `refreshToken()`, implemented separately via `PUT /auth/tokens`. |
| P2 | nuanced | high | The options exist in the API, but some do not work: - On RabbitMQ 4.3.x, under its default deprecated-feature settings, Offset first/last/next, filterValues and matchUnfiltered are silently ignored because they are not sent as described values. - Numeric and timestamp offsets are broken on every broker version, because of the bigint encoding. - Only the SQL and property filters are encoded correctly.  Browsing streams over AMQP 1.0 is the right default only when our own rhea adapter encodes the filter-set correctly. |
| P3 | nuanced | high | **Confirmed:** rhea 3.0.5 supports PLAIN, ANONYMOUS, XOAUTH2 and EXTERNAL, plus TLS, reconnect and WebSocket. It is licensed Apache-2.0.  **Corrections** - The EXTERNAL client mechanism is only enabled when `enable_sasl_external: true` is set and a TLS socket with `options.cert` exists. - rhea has a single npm maintainer (grs) and 103 open issues. - Decoder-hardening commits made after 3.0.5 have not been released to npm: 'Bound AMQP compound element count during decode' (2026-05-07) and 'Bound nesting depth when decoding AMQP compound and described types' (2026-09-30). - rhea 3.0.5 cannot encode JS bigint values. |
| P4 | confirmed | medium | Measured on 2026-10-16: - Electron 44.8.0 runtime zips are 117-151 MiB. - Node 24.22.0 distributions are 26-51 MiB compressed, and the Linux node binary is 126.8 MB uncompressed. - A Tauri shell is about 3-5 MB.  That gives a ratio of about 2.3-3×. |
| P5 | nuanced | high | **Fine:** @asteasolutions/zod-to-openapi 9.1.0 has a V31 generator and needs zod ^4.  **Not usable as is:** nestjs-zod 5.5.0 declares peers for Nest 10 and 11 and @nestjs/swagger ≤11. Using it with Nest 12 would mean forcing past those peer dependencies.  **Better first-party option:** @nestjs/swagger 12 with a `standardSchemaConverter`. Back it with zod-openapi 6.0.2 or with zod 4's native `z.toJSONSchema()` (draft-2020-12, which fits OpenAPI 3.1). |

### Evidence

- **E1** (confirmed, high): - **Release dates and package metadata:** https://registry.npmjs.org/amqplib (`time`, `maintainers`) and https://registry.npmjs.org/amqplib/2.2.0 (`dependencies` {}, `dist.attestations` present).
- **CHANGELOG@v2.2.0** (https://raw.githubusercontent.com/amqp-node/amqplib/v2.2.0/CHANGELOG.md):
  - 'v1.1.0 Add connection recovery via connectWithRecoveryPromise and connectWithRecoveryCallback'
  - 'v1.2.0 Add bundled TypeScript type definitions (fixes #843)'
  - 'v2.0.0 BREAKING: heartbeat: 0 now disables heartbeats'
- **lib/credentials.js@v2.2.0:** `module.exports.external = () => ({ mechanism: 'EXTERNAL', response: () => Buffer.from('') })`
- **lib/channel_model.js@v2.2.0:**
  - L22 `updateSecret(newSecret, reason)`
  - L33 `createConfirmChannel`
  - L157 `get(queue, options)`
  - L186 `nack(message, allUpTo, requeue)`
  - L236 `waitForConfirms()`
- **lib/connection.js@v2.2.0:** L598-603 `ConnectionBlocked` -> `safeEmit(connection,'blocked',...)` and `ConnectionUnblocked` -> 'unblocked'; L358 `_updateSecret` sends `ConnectionUpdateSecret`.
- **lib/channel.js@v2.2.0:** L271 `case defs.BasicCancel`; L466-470 `handleCancel(fields){ const result = this.dispatchMessage(fields, null) ...`
- **lib/connect.js@v2.2.0:** L29-36 capabilities `consumer_cancel_notify`, `'connection.blocked'`, `authentication_failure_close`, `publisher_confirms`.
- **README.md@v2.2.0:** L121-179 'Opt-in recovery ... async setup(model) { // Called after every successful (re)connect. // Recreate topology/consumers here.'
- **Commit activity:** GitHub commits since 2026-01-01 via `gh api repos/amqp-node/amqplib/commits`: 132 in total (cressie176 111, ShiriNmi1520 13, GiHoon1123 8).
- **CI:** .github/workflows/test.yml@v2.2.0 uses `image: rabbitmq:4.2-alpine` with `node-version: [18.x, 20.x, 22.x, 24.x]`.
- **E2** (nuanced, high): - **Package metadata:** https://registry.npmjs.org/rabbitmq-amqp-js-client: latest 1.0.0, time 2026-06-25T15:06:33Z, deps {"rhea":"github:amqp/rhea"}, license ISC, provenance=true.
- **rhea 3.0.5 already has the fix:** `gh api repos/amqp/rhea/compare/1d83cc9df9...9ff8487f75` shows the 3.0.5 tag is ahead_by=5 of the 2025-07-14 fix 'change map to symbolic map for message_annotations on modified outcome'.
- **Docs status:** https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/client-libraries/amqp-client-libraries.md has the JS tabs '// CURRENTLY NOT IMPLEMENTED' (ChangeState listeners, consumer graceful shutdown, deactivating topology recovery) and '// TOPOLOGY RECOVERY IS NOT TESTED'.
- **Client source (rabbitmq-amqp-js-client@v1.0.0):**
  - src/consumer.ts L194 `filters[STREAM_OFFSET_SPEC] = params.stream.offset.toValue()`; L197 `filters[STREAM_FILTER_SPEC] = params.stream.filterValues`; L200 `types.wrap_described(params.stream.sqlFilter, 0x120)`; L203 match-unfiltered as a plain boolean; L153 `console.log(this.connection.container_id)`.
  - src/utils.ts L90-91 `toValue(){ if (this.value && (...numeric||timestamp)) return this.value; return this.type.toString() }`.
  - src/message.ts L50-62 `/${AmqpEndpoints.Queues}/${options.queue.name}` with no encoding, whereas src/management.ts L122 uses `encodeURIComponent(queueName)`.
  - src/environment.ts L25-33: EnvironmentParams has host, port, username, password, webSocket, oauth and tls only.
  - src/rhea_wrapper.ts L154 `connection.once(successEvent, (context) => res(context.receiver || context.sender))`; L80 and L108 `...envParams` spread.
  - src/management.ts has no purge; L251-255 `refreshToken` sends PUT to `/auth/tokens`.
- **RabbitMQ server source:**
  - deps/rabbit/src/rabbit_amqp_session.erl@v4.3.6 L3304-3357: offset-spec is only parsed when it is `{described, {symbol, <<"rabbitmq:stream-offset-spec">>}, Value}`. A non-described `rabbitmq:stream-*` value is rewrapped only if `rabbit_deprecated_features:is_permitted(amqp_filter_set_bug)`; otherwise the function returns `Acc` and the filter is dropped.
  - Deprecation phase of `amqp_filter_set_bug`: `permitted_by_default` at v4.1.0 and v4.2.0, `denied_by_default` at v4.3.0 and v4.3.6, `removed` on main.
  - release-notes/4.3.0.md@v4.3.6 L139-145 lists `amqp_filter_set_bug` among the features moved to denied_by_default.
  - deps/rabbit/src/rabbit_amqp_management.erl@v4.3.6 L255 handles `DELETE [queues, Q, messages]` and L381 `GET [bindings]`.
- **rhea 3.0.5 source:**
  - lib/types.js L456-495: `types.wrap` has branches for string, boolean, number, Date, Buffer, Array, Map and Set, and otherwise ends in `return types.wrap_map(o)`. There is no bigint branch.
  - lib/link.js L344 `this.set_credit_window(this.get_option('credit_window', 1000))`.
- **RabbitMQ docs on encoding:** rabbitmq-website docs/amqp.md L150-152 'Address format v2 requires exchange names, routing keys, and queue names to be percent-encoded'.
- **Open PRs and issues:**
  - PR #95 'Add virtual host support to EnvironmentParams', opened 2026-07-15 and still unmerged; the maintainer commented on 2026-07-30.
  - PR #94 'rhea's default credit_window of 1000 applies ... refilled on message arrival'.
  - Issue #96 '~4.5 hours every task.* event it published went out under the other event's routing key: ~20k messages', on RabbitMQ 4.3.2.
- **CI and repo:** .github/workflows/main.yml@v1.0.0 uses `rabbitmq:4.2.0-beta.3-management`. Repo contents@v1.0.0 have no LICENSE file. GitHub: 9 stars, pushed 2026-06-25.
- **E3** (nuanced, high): - **Releases:** https://registry.npmjs.org/rabbitmq-stream-js-client: 1.0.0 on 2026-01-12, 1.1.0 on 2026-07-23T14:53Z. GitHub release v1.1.0 notes list PRs #293-#299.
- **PR #293 is a CI change:** `gh api repos/coders51/rabbitmq-stream-js-client/pulls/293/files` shows only `.github/workflows/release-package.yml +8 -6`. The sibling AMQP 1.0 client's PR #79 likewise only touched the release workflow.
- **src/client.ts@v1.1.0:**
  - ClientParams has `mechanism?: "PLAIN" | "EXTERNAL"` and `addressResolver?: AddressResolverParams` = `{enabled:true, endpoint?}` or `{enabled:false}`.
  - getConnectionOnChosenNode (L885-912) loops connecting until `connectionHost === chosenNode.host && connectionPort === chosenNode.port`.
  - computeMaxAttempts is `Math.pow(2 + leader + replicas, 2)`.
  - singleActive and consumerUpdateListener are present at L311-346.
- **src/requests/subscribe_request.ts@v1.1.0:** OFFSET_TYPE first, last, next, numeric, timestamp.
- **Server-side token support:**
  - deps/rabbitmq_stream/docs/PROTOCOL.adoc@v4.3.6 L924 'JWT tokens carried as the SASL PLAIN password'.
  - deps/rabbitmq_stream/src/rabbit_stream_reader.erl@v4.3.6 L1745-1800 handles post-open `{sasl_authenticate, NewMechanism, NewSaslBin}` -> `complete_secret_update`.
- **CI:** .github/workflows/main.yml@v1.1.0 uses `rabbitmq:4.0.5-management`.
- **Licence:** the LICENSE file is 'Copyright (c) 2023 coders51 SRL ... Permission is hereby granted' (MIT), while package.json has `"license": "ISC"`.
- **E4** (confirmed, high): - **src/amqp-base-client.ts@v4.1.1:** L271 `startOk.writeShortString("PLAIN") // authentication mechanism`; L155 `updateSecret(newSecret, reason)`; L61/L66 `onblocked` and `onunblocked`; L529 `consumer.setClosed(new AMQPError("Consumer cancelled by the server", this))`.
- **CHANGELOG.md@v4.1.1, entry 4.1.0:** 'Frame parsing crashed with Frame end out of range on Node >= 24.18 / 26.3 ... Node raised Buffer.poolSize from 8 KiB to 64 KiB (nodejs/node#63597)'.
- **The Node change:** https://raw.githubusercontent.com/nodejs/node/main/doc/changelogs/CHANGELOG_V24.md L1412, in the 24.18.0 section, '(SEMVER-MINOR) buffer: increase Buffer.poolSize default to 64 KiB #63597'; the same change appears in CHANGELOG_V26 under 26.3.0.
- **Registry and repo:** https://registry.npmjs.org/@cloudamqp/amqp-client (4.0.0 2026-06-12, 4.1.0 2026-08-19, 4.1.1 2026-08-28).
- **rabbitmq-client src/Connection.ts@v5.0.8:** L429 `// TODO support EXTERNAL mechanism, i.e. x509 peer verification`; L438 `mechanism: 'PLAIN'`. The string 'secret' appears 0 times in src/Connection.ts and src/codec.ts.
- **rabbitmq-client registry:** https://registry.npmjs.org/rabbitmq-client: 5.0.8 on 2025-12-01, maintainers [cody-greene].
- **E5** (nuanced, high): - **Go release dates:**
  - `gh api repos/rabbitmq/amqp091-go/releases`: v1.15.0 2026-09-15T06:40Z, v1.13.0 2026-07-21, v1.12.0 2026-06-16. v1.12.0 notes: 'Feature: implement automatic connection and channel recovery with state change notifications (#339)'; v1.13.0: 'feature: implement automatic topology recovery (#357)'.
  - https://proxy.golang.org/github.com/rabbitmq/rabbitmq-amqp-go-client/@v/v1.0.0.info has Time 2026-04-13T07:50:43Z, while the GitHub release v1.0.0 has published_at 2026-04-20T08:28:29Z.
  - v1.4.0: proxy Time 2026-08-26; GitHub release 2026-09-09.
  - https://proxy.golang.org/github.com/rabbitmq/rabbitmq-stream-go-client/@v/v1.8.3.info: 2026-07-23T08:23Z.
- **RabbitMQ listings:**
  - rabbitmq-website client-libraries/devtools.md: '*Note:* items with a check mark (&#x2713;) are officially supported by Team RabbitMQ and VMware.' The JavaScript and Node section (L132-143) lists amqplib, amqp-client, rabbitmq-stream-js-client and node-rabbitmq-client, none with a check mark.
  - client-libraries/amqp-client-libraries.md L27-34: 'The RabbitMQ team supports the following libraries: ... RabbitMQ AMQP 1.0 **JavaScript** client (https://github.com/coders51/rabbitmq-amqp-js-client)'.
- **E6** (nuanced, high): - **Stability and history:**
  - https://raw.githubusercontent.com/nodejs/node/v24.22.0/doc/api/sqlite.md L8-18: 'version: v24.15.0 ... SQLite is now a release candidate' and '> Stability: 1.2 - Release candidate.'
  - https://raw.githubusercontent.com/nodejs/node/v26.12.0/doc/api/sqlite.md L8-18: 'version: v25.7.0'. Class Database: 'All APIs exposed by this class execute synchronously'; 'DatabaseSync is a deprecated alias for Database ... DEP0210'. L1764 backup 'Returns: {Promise}'.
- **Deprecations:** doc/api/deprecations.md@v26.12.0 L4713-4727: 'DEP0210: sqlite.DatabaseSync ... version: v26.11.0 ... Type: Documentation-only'.
- **Compile options:** deps/sqlite/sqlite.gyp@v24.22.0 L19-28 (SQLITE_ENABLE_FTS3, SQLITE_ENABLE_FTS5, SQLITE_ENABLE_MATH_FUNCTIONS, SQLITE_ENABLE_PERCENTILE, SQLITE_ENABLE_RTREE, SQLITE_ENABLE_SESSION); deps/sqlite/sqlite3.h `#define SQLITE_VERSION "3.53.4"`.
- **Kysely interface:** https://raw.githubusercontent.com/kysely-org/kysely/v0.29.6/src/dialect/sqlite/sqlite-dialect-config.ts defines `interface SqliteStatement { readonly reader: boolean; all(parameters: ReadonlyArray<unknown>) ...}`.
- **Community dialects:** registry kysely-node-native-sqlite 1.1.0, engines {"node":"^22.5.0"}. Better Auth: https://raw.githubusercontent.com/better-auth/better-auth/main/packages/kysely-adapter/src/index.ts '// Don't export node:sqlite by default, as it is not production ready.'
- **Drizzle:** https://registry.npmjs.org/drizzle-orm: latest 0.45.4 has no ./node-sqlite in exports; rc 1.0.0-rc.4 (2026-06-27) and beta 1.0.0-beta.22 include ./node-sqlite, ./node-sqlite/driver and ./node-sqlite/migrator.
- **E7** (confirmed, high): - **Node schedule:** https://raw.githubusercontent.com/nodejs/Release/main/schedule.json: v24 {lts 2025-10-28, maintenance 2026-10-20, end 2028-04-30}; v26 {lts 2026-10-28, maintenance 2027-10-20, end 2029-04-30}; v27 {alpha 2026-10-28}.
- **Electron release data:**
  - https://releases.electronjs.org/releases.json: 40.0.0 node 24.11.1, 41.0.0 node 24.14.0, 42.0.0 node 24.15.0, 43.0.0 node 24.17.0, 44.0.0 node 24.18.1 chrome 152.0.7977.54, 44.8.0 node 24.22.0, 45.0.0-beta.5 node 24.22.0 chrome 156, 46.0.0-nightly.20261015 node 24.21.0.
  - https://releases.electronjs.org/schedule: '46.0.0 Oct 22, 2026 Dec 3, 2026 Jan 5, 2027 Jun 22, 2027 M 160 v 24.21.0; 45.0.0 Aug 27, 2026 Oct 1, 2026 Oct 20, 2026 Apr 27, 2027 M 156 v 24.22.0'.
  - https://github.com/electron/electron/releases/tag/v44.0.0 (published 2026-08-25T00:42:28Z): 'macOS 13 (Ventura) or later will be required to run Electron v44.0.0' and 'Removed 32-bit builds (Windows ia32 and Linux armv7l)'.
- **Electron Node policy:** docs/tutorial/electron-timelines.md L92: 'Electron upgrades its main branch to even-number versions of Node.js when they enter Active LTS'.
- **E8** (confirmed, high): - **Fuses:** https://raw.githubusercontent.com/electron/electron/v44.8.0/docs/tutorial/fuses.md L32-36: 'With this fuse disabled, child_process.fork throws, as it depends on this environment variable to function. Instead, we recommend that you use Utility Processes'. L74-76: nodeCliInspect 'toggles whether the --inspect, --inspect-brk, etc. flags are respected'.
- **utilityProcess:** docs/api/utility-process.md@v44.8.0 L68: '`utilityProcess.fork` can only be called after the `ready` event has been emitted on `App`.' L79-93: `child.postMessage(message, [transfer])` where transfer is MessagePortMain[]. L49-54: `disclaim` defaults to false.
- **Playwright:** https://playwright.dev/docs/api/class-electron: 'Playwright has experimental support for Electron automation.'; 'Supported Electron versions are: v21+'; 'Ensure that nodeCliInspect (FuseV1Options.EnableNodeCliInspectArguments) fuse is not set to false.'
- **Electron 46 breaking changes:** https://raw.githubusercontent.com/electron/electron/main/docs/breaking-changes.md under 'Breaking API Changes (46.0)':
  - '`utilityProcess` `child.kill()` no longer force-kills the child'.
  - 'Removed: `safeStorage.isEncryptionAvailable()`, `safeStorage.encryptString()` and `safeStorage.decryptString()`'.
- **ESM entry:** utilityProcess supports an ESM entrypoint (electron/electron PR #40047, merged 2023-09).
- **E9** (nuanced, high): - **NestJS packages:** https://registry.npmjs.org/@nestjs/core: 12.0.0 on 2026-08-27T07:03Z, latest 12.1.3 on 2026-10-12, `type: module`. https://registry.npmjs.org/@nestjs/platform-fastify (12.1.3) has deps fastify "5.12.5".
- **NestJS v12.0.0 release notes** (https://github.com/nestjs/nest/releases/tag/v12.0.0):
  - 'NestJS 12 is centered around ESM-ready packages, first-class Standard Schema support'
  - 'Existing CommonJS applications keep working'
  - 'v12 requires Node.js v20.19+ or v22.12+'
  - 'Route parameter decorators — @Body(), @Query(), @Param(), @RawBody() — accept a new schema option'
- **@nestjs/swagger 12.0.0 release notes** (https://github.com/nestjs/swagger/releases/tag/12.0.0): '`@nestjs/swagger` is now a native ES module'; 'Supply an adapter via the new standardSchemaConverter document option'; 'Breaking: nullability is spelled per document version'.
- **Converters and zod:**
  - https://registry.npmjs.org/nestjs-zod: 5.5.0 peer {"@nestjs/common":"^10.0.0 || ^11.0.0","@nestjs/swagger":"^7.4.2 || ^8.0.0 || ^11.0.0"}.
  - @asteasolutions/zod-to-openapi 9.1.0 README: 'OpenApiGeneratorV3, OpenApiGeneratorV31 and OpenApiGeneratorV32'.
  - zod docs (https://raw.githubusercontent.com/colinhacks/zod/main/packages/docs/content/json-schema.mdx): L18 'Experimental — The z.fromJSONSchema() function'; L90-101 target values; L157 'By default, Zod will target Draft 2020-12'.
- **Orval:**
  - https://raw.githubusercontent.com/orval-labs/orval/v8.43.0/docs/content/docs/guides/angular.mdx L3 'Generate Angular services with HttpClient and httpResource functions'; L52-55 the retrievalClient values; L126 'Orval defaults to httpClient'.
  - Orval release notes v8.34.0 and v8.35.0: 'normalize residual OAS 3.0 syntax after upgrade()' and 'remove downstream OAS 3.0 handling from generators'.
  - https://registry.npmjs.org/orval: 8.43.0, engines node>=22.18.0; 8.0.0 on 2026-01-14 and 8.43.0 on 2026-10-14.
- **E10** (nuanced, medium): - **Module and core packages:** https://registry.npmjs.org/@testcontainers/rabbitmq (12.2.1 on 2026-10-13; history 12.0.3 to 12.2.1 during 2026) and https://registry.npmjs.org/testcontainers (12.2.1, engines {"node":">= 22.22"}).
- **Module source:** https://raw.githubusercontent.com/testcontainers/testcontainers-node/v12.2.1/packages/modules/rabbitmq/src/rabbitmq-container.ts: `withExposedPorts(AMQP_PORT, AMQPS_PORT, HTTPS_PORT, HTTP_PORT)`, `Wait.forLogMessage("Server startup complete")`, `withStartupTimeout(30_000)`. The module's Dockerfile is `FROM rabbitmq:4.3.6-management-alpine`.
- **Runner images:**
  - https://raw.githubusercontent.com/actions/runner-images/main/images/windows/Windows2025-Readme.md L63 '- Docker 29.7.2'.
  - macos-15-Readme.md and macos-15-arm64-Readme.md contain no docker, colima or podman entries.
  - actions/runner-images#5948 (2022), maintainer: 'we can't add linux container support due to Azure vm spec limitation ... without supporting nested Hyper-V virtualization'.
- **Homebrew:** https://formulae.brew.sh/api/formula/rabbitmq.json reports stable 4.3.6 (erlang@28).
- **E11** (nuanced, medium): - **Tauri releases:** `gh api repos/tauri-apps/tauri/releases`: tauri-v3.0.0-alpha.5 and tauri-v2.12.4, both 2026-10-14.
- **Tauri 3 alpha source:**
  - https://raw.githubusercontent.com/tauri-apps/tauri/tauri-v3.0.0-alpha.5/crates/tauri-runtime-wry/Cargo.toml L43-44 `gtk = { version = "0.18", features = ["v3_24"] }` and `webkit2gtk = { version = "=2.0", features = ["v2_40"] }`.
  - crates/tauri-runtime-cef/Cargo.toml L33 `cef = { version = "=154.5.0" ...}` and L124 `gtk = { package = "gtk4", version = "0.11.4" }`.
  - crates/tauri/Cargo.toml L195-196 features gtk3 and gtk4.
  - https://crates.io/api/v1/crates/tauri-runtime-cef: max_version 3.0.0-alpha.6.
- **Linux issues:** https://github.com/tauri-apps/wry/issues/890 'We know WebkitGTK isn't that great'; https://github.com/tauri-apps/tauri/pull/14684 'migrates ... to GTK4/WebKitGTK 6.0' (open).
- **Comparison repo:** https://github.com/Elanis/web-to-desktop-framework-comparison README build-size and memory tables.
- **Our measurements:** Electron v44.8.0 assets (linux-x64.zip 117 MiB, win32-x64.zip 151 MiB, darwin-arm64.zip 124 MiB); https://nodejs.org/dist/v24.22.0/ tarball listing shows `bin/node` at 126816376 bytes.
- **E12** (nuanced, high): - **Node 26 SEA docs** (https://raw.githubusercontent.com/nodejs/node/v26.12.0/doc/api/single-executable-applications.md):
  - L9-12 'version: v25.5.0 ... Added built-in single executable application generation via the CLI flag --build-sea'.
  - L21 'Stability: 1.1 - Active development'.
  - L113-119 config fields mainFormat and useVfs.
  - L180-186 VFS 'added: v26.9.0 ... Stability: 1.0 - Early development'.
  - L764-771 'macOS (arm64 only; x64 is not currently supported and is skipped in the tests)'.
- **Node 24 SEA docs:** v24.22.0 single-executable-applications.md L32 'single embedded script using the CommonJS module system'; it describes the postject flow and has no `--build-sea`.
- **postject:** https://registry.npmjs.org/postject, 1.0.0-alpha.6 on 2023-05-19.
- **Bun:** https://bun.com/docs/bundler/executables lists targets bun-darwin-x64, bun-darwin-arm64, bun-linux-x64/arm64 (glibc and musl) and bun-windows-x64/arm64. https://bun.com/docs/runtime/nodejs-compat says node:tls '🟡 Missing pskCallback, OCSP stapling' and node:sqlite '🟢 Fully implemented'.
- **Deno:** https://docs.deno.com/runtime/reference/cli/compile/ lists the targets and the --self-extracting option.
- **pkg:** https://yao-pkg.github.io/pkg/architecture: 'Enhanced SEA mode (Node ≥ 22 with package.json)'; native addons are 'extract[ed] to ~/.cache/pkg/<sha256>/'.
- **P1** (refuted, high): - `gh api repos/coders51/rabbitmq-stream-js-client/pulls/293/files` shows only `.github/workflows/release-package.yml +8 -6`. The PR body reads 'Watch it, here NPM permission wasn't enabled yet'.
- `gh api repos/coders51/rabbitmq-amqp-js-client/pulls/79/files` likewise shows only `.github/workflows/release-package.yml +8 -6`.
- Both packages now carry npm provenance (dist.attestations).
- **P2** (nuanced, high): See E2:
- consumer.ts@v1.0.0 L194-203
- rabbit_amqp_session.erl@v4.3.6 L3304-3357, with the amqp_filter_set_bug deprecation phases
- rhea lib/types.js@3.0.5 L456-495
- **P3** (nuanced, high): - **SASL selection:** https://raw.githubusercontent.com/amqp/rhea/main/lib/connection.js L395-413 `if (this.socket.encrypted && this.options.cert && this.get_option('enable_sasl_external', false)) { ... mechanisms.enable_external(); }`.
- **Registry:** https://registry.npmjs.org/rhea, latest 3.0.5 on 2026-04-28, maintainers [grs], no provenance.
- **Repo activity:** `gh api repos/amqp/rhea/commits` lists d7474da (2026-09-30) and 31314ea (2026-05-07); the repo has 302 stars and 103 open issues, with licence Apache-2.0.
- **P4** (confirmed, medium): - Electron v44.8.0 release assets: linux-x64.zip 117 MiB, darwin-arm64.zip 124 MiB, win32-x64.zip 151 MiB.
- nodejs.org/dist/v24.22.0 content-length: linux-x64.tar.xz 30 MiB, win-x64.zip 35 MiB, darwin-arm64.tar.xz 26 MiB, darwin-x64.tar.gz 51 MiB. The tar listing shows `bin/node` at 126816376 bytes.
- The Elanis comparison measures a Tauri empty-app build at about 3-5 MB.
- **P5** (nuanced, high): - https://registry.npmjs.org/nestjs-zod: 5.5.0 peerDependencies.
- https://github.com/nestjs/swagger/releases/tag/12.0.0, 'Standard Schema support' section.
- https://registry.npmjs.org/zod-openapi: 6.0.2, peer zod ^4.0.0.

### Report

# TypeScript engine stack: adversarial verification (as of 2026-10-16)

**Method**
- **Primary sources only.** These were:
  - npm registry JSON: `time`, `dist-tags`, `dependencies`, `engines`, `peerDependencies`, `dist.attestations`.
  - Source code at exact tags via raw.githubusercontent.com.
  - The GitHub REST API (releases, commits, issues, PR files), called through authenticated `gh api`.
  - The Go module proxy, crates.io, Docker Hub and Homebrew API JSON.
  - Documentation source files at tags (Node `doc/api/*.md`, Electron `docs/**` at v44.8.0, the rabbitmq-website repo).
- **rabbitmq.com could not be read directly.** It returns a Cloudflare challenge to curl, so its pages were read from the rabbitmq-website repository's `main` branch.
- **Nothing was run.** No broker, Docker container, install or test was executed. Wherever a runtime effect is inferred from reading code, it is labelled **code-level**.

---

### 1. Verdicts at a glance

| ID | Verdict | Correction / key fact |
| --- | --- | --- |
| E1 amqplib revival | **confirmed** | 15 npm releases in 2026. EXTERNAL, update-secret, blocked/unblocked, server cancel (callback gets `null`), confirms, `get` and `nack(requeue)` are all in the source. Recovery is opt-in, and the caller recreates topology in a `setup` callback. Bus factor is about 1: 84% of 2026 commits are by one person. CI tests only RabbitMQ 4.2. |
| E2 AMQP 1.0 JS client | **nuanced** | Facts confirmed. On RabbitMQ 4.3.x, stream offset and Bloom filters are silently dropped. Numeric and timestamp offsets are broken. No vhost, no credit control, unencoded addresses, a link race (#96), stray `console.log`, a git-URL dependency on rhea, no LICENSE file. |
| E3 stream client | **nuanced** | Only 1.1.0 exists. Offsets, filtering, super streams, single active consumer (SAC) and EXTERNAL are all present. "OIDC" means npm trusted publishing, not RabbitMQ OAuth. The address resolver only supports a load-balancer mode. CI runs on RabbitMQ 4.0.5 only. |
| E4 @cloudamqp / rabbitmq-client | **confirmed** | @cloudamqp sends PLAIN only. The Node 24.18 `Buffer.poolSize` change caused a crash, fixed in 4.1.0. rabbitmq-client has a TODO for EXTERNAL and no update-secret. |
| E5 Go clients | **nuanced** | amqp-go v1.0.0 was tagged 2026-04-13 (module time) but its GitHub release is dated 2026-04-20. **The current version is v1.4.0.** No Node client carries RabbitMQ's ✓ mark for official support. The AMQP 1.0 page does list the coders51 JavaScript client as one the team supports. |
| E6 node:sqlite / Kysely / Drizzle | **nuanced** | Release candidate since v25.7.0, backported to v24.15.0. There is no maintained Kysely dialect, so we write a ~30-line adapter in-repo. Drizzle supports node:sqlite only in its 1.0 beta and RC builds. |
| E7 Node/Electron timeline | **confirmed** | Electron 46 is still pre-release (Node 24.21.0 for now; stable 2027-01-05). Electron 44's GitHub release is dated 2026-08-25. |
| E8 fuses/utilityProcess/Playwright | **confirmed** | Two Electron 46 additions matter: `child.kill()` no longer force-kills, and the synchronous safeStorage methods are removed. |
| E9 NestJS 12 / Orval / zod | **nuanced** | nestjs-zod 5.5.0 does **not** support Nest 12. @nestjs/swagger 12's `standardSchemaConverter` is the supported route. Orval generates `httpResource` code. Startup overhead is unverified. |
| E10 Testcontainers | **nuanced** | The RabbitMQ module is thin and exposes neither 5552 (streams) nor 15692 (Prometheus). Windows runners have Docker but only for Windows containers. macOS runners have no Docker. |
| E11 Tauri | **nuanced** | The CEF runtime with GTK4 exists in Tauri 3 alpha, but WebKitGTK 6 does not (it is an open PR). Memory is not "similar". With a Node sidecar the bundle is about 2.3–3× smaller, not 10×. |
| E12 single executables | **nuanced** | For Node SEA, macOS x64 is "not currently supported" (stronger than "not CI-tested"). Node 24 has no `--build-sea`, and its SEA entry must be CommonJS. |
| P1 (corpus) "stream client OIDC" | **refuted** | It is npm trusted publishing from CI. |
| P2 (corpus) "use AMQP 1.0 JS client for stream browsing" | **nuanced** | Only works if we write our own rhea adapter. |
| P3 (corpus) rhea SASL | **nuanced** | EXTERNAL needs `enable_sasl_external` plus a TLS `cert`. Decoder-hardening commits are not yet released. There is no bigint support. |
| P4 (corpus) Tauri 2–3× | **confirmed** |  |
| P5 (corpus) nestjs-zod | **nuanced** | Its peer dependencies stop at Nest 11. |

---

### 2. The decisive finding: the JS AMQP 1.0 client RabbitMQ lists vs RabbitMQ 4.3

### 2.1 What the client sends
[consumer.ts@v1.0.0](https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/src/consumer.ts), lines 194–203:

```ts
filters[STREAM_OFFSET_SPEC] = params.stream.offset.toValue()          // plain "first" | bigint
filters[STREAM_FILTER_SPEC] = params.stream.filterValues              // plain list
filters[STREAM_FILTER_SQL]  = types.wrap_described(params.stream.sqlFilter, 0x120)  // described: OK
filters[STREAM_FILTER_MATCH_UNFILTERED] = params.stream.matchUnfiltered            // plain bool
```

### 2.2 What the broker accepts
[rabbit_amqp_session.erl@v4.3.6](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_amqp_session.erl), lines 3304 and 3350–3357. The broker only matches `{described, {symbol, <<"rabbitmq:stream-offset-spec">>}, Value}`. Anything else falls through to this clause:

```erlang
parse_filters({Symbol = {symbol, <<"rabbitmq:stream-", _/binary>>}, Value}, QType, Acc)
  when element(1, Value) =/= described ->
    case rabbit_deprecated_features:is_permitted(amqp_filter_set_bug) of
        true  -> parse_filters({Symbol, {described, Symbol, Value}}, QType, Acc);
        false -> Acc          %% filter silently dropped
    end;
```

**Deprecation phase of `amqp_filter_set_bug`** (it controls whether plain filter values are still accepted):

| Version | Phase |
| --- | --- |
| v4.1.0 | `permitted_by_default` |
| v4.2.0 | `permitted_by_default` |
| v4.3.0, v4.3.6 | **`denied_by_default`** |
| main | **`removed`** |

The [4.3.0 release notes](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/release-notes/4.3.0.md) (lines 139–145) list it among the features moved to `denied_by_default`.

**Effect on 4.3.x with default settings (code-level):**
- A stream consumer that asks for `Offset.first()` attaches at the default position, `next`.
- Bloom `filterValues` and `matchUnfiltered` are ignored.
- The broker reports the filters it actually applied in its attach reply, but the client never checks that list, so the caller gets no error.
- The client's CI uses `rabbitmq:4.2.0-beta.3`, where plain values are still accepted ([main.yml@v1.0.0](https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/.github/workflows/main.yml)). That explains why the client's tests pass.

### 2.3 bigint offsets
- `Offset.offset(n)` and `Offset.timestamp(d)` return a JS bigint ([utils.ts@v1.0.0](https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/src/utils.ts), lines 90–91).
- rhea 3.0.5's `types.wrap` has no bigint case. It ends in `return types.wrap_map(o)`, so a bigint is encoded as an **empty map** ([types.js@3.0.5](https://raw.githubusercontent.com/amqp/rhea/3.0.5/lib/types.js), lines 456–495).
- The broker's `case Value of` matches none of its clauses for an empty map, so the filter is dropped on every version.
- `Offset.offset(0n)` sends the string `"numeric"`, because `this.value &&` treats `0n` as false.
- The e2e tests only ever use `Offset.first()` ([consumer.test.ts](https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/test/e2e/consumer.test.ts)).

### 2.4 Other defects that matter to the product

| Defect | Evidence | Product impact |
| --- | --- | --- |
| No credit control. rhea's default `credit_window` is **1000**, refilled as messages arrive. | [link.js@3.0.5](https://raw.githubusercontent.com/amqp/rhea/3.0.5/lib/link.js) L344; [PR #94](https://github.com/coders51/rabbitmq-amqp-js-client/pull/94) still open | A peek of N messages can take up to 1000 off the queue. They become invisible to real consumers and each one counts an acquisition. A live tap's buffer can grow without limit. |
| No vhost. | [environment.ts](https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/src/environment.ts) L25–33; [PR #95](https://github.com/coders51/rabbitmq-amqp-js-client/pull/95) open since 2026-07-15 | The tool cannot connect to a vhost other than `/` except through an untyped option. |
| Link-creation race. | [rhea_wrapper.ts](https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/src/rhea_wrapper.ts) L154 `connection.once(successEvent, ...)`; [#96](https://github.com/coders51/rabbitmq-amqp-js-client/issues/96) reports "~20k messages" misrouted on 4.3.2 | Parallel DLQ replay or moves could publish to the wrong address. |
| Addresses not percent-encoded. | [message.ts](https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/src/message.ts) L50–62. The [docs](https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/amqp.md) (L150–152) require RFC 3986 percent-encoding. | Queues whose names contain `/`, `%`, `?`, `#` or spaces break. |
| No purge or list-bindings, although the broker serves both. | management.ts; [rabbit_amqp_management.erl@v4.3.6](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_amqp_management.erl) L255, L381 | Admin actions over AMQP 1.0 are incomplete. |
| No typed SASL EXTERNAL option. | EnvironmentParams; rhea needs `enable_sasl_external` plus `cert` ([connection.js](https://raw.githubusercontent.com/amqp/rhea/main/lib/connection.js) L407) | mTLS identity is not available. |
| `console.log(container_id)` in every Consumer and Publisher constructor. | consumer.ts L153, publisher.ts L86 | Noisy logs, especially in the CLI and server modes. |
| Dependency `"rhea": "github:amqp/rhea"`; no LICENSE file; 9 stars; no commits since 2026-06-25. | [registry](https://registry.npmjs.org/rabbitmq-amqp-js-client/1.0.0); repo contents | Installs are not reproducible from the registry, and the licence is hard to audit. |
| RabbitMQ docs: lifecycle listeners "CURRENTLY NOT IMPLEMENTED"; topology recovery "NOT TESTED". | [amqp-client-libraries.md](https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/client-libraries/amqp-client-libraries.md) |  |

### 2.5 The Go and .NET clients get these right
- **Go** ([rabbitmq-amqp-go-client v1.4.0](https://raw.githubusercontent.com/rabbitmq/rabbitmq-amqp-go-client/v1.4.0/pkg/rabbitmqamqp/amqp_types.go)):
  - `amqp.NewLinkFilter(rmqStreamOffsetSpec, 0, ...)` sends the filter as a described value.
  - `encodePathSegments` percent-encodes addresses (common.go L99–102).
  - It sets `HostName: "vhost:<v>"`, has `InitialCredits`, and has `PurgeQueue`.
  - Gap: it has no timestamp offset type.
- **.NET** ([rabbitmq-amqp-dotnet-client v1.4.0](https://raw.githubusercontent.com/rabbitmq/rabbitmq-amqp-dotnet-client/v1.4.0/RabbitMQ.AMQP.Client/Impl/AmqpConsumerBuilder.cs)):
  - `new DescribedValue(Consts.s_streamOffsetSpecSymbol, offset)`.
  - `Offset(DateTime)`, `InitialCredits`, `PurgeAsync`, `SaslMechanism.External`, `VirtualHost`, and `Utils.EncodePathSegment`.

---

### 3. Claim-by-claim evidence (summary; full evidence in the verdict objects)

**E1. amqplib**
- 2026 releases: 1.0.0 → 2.2.0, 15 versions in total ([registry](https://registry.npmjs.org/amqplib)).
- Features found at v2.2.0:
  - `credentials.external()` ([credentials.js](https://raw.githubusercontent.com/amqp-node/amqplib/v2.2.0/lib/credentials.js)).
  - `updateSecret` (channel_model.js L22).
  - `blocked`/`unblocked` (connection.js L598–603).
  - `BasicCancel` → `dispatchMessage(fields, null)` (channel.js L271, L466).
  - ConfirmChannel and `waitForConfirms` (L225–236), `get` (L157), `nack(msg, allUpTo, requeue)` (L186).
- Opt-in recovery: `connect(url,{recovery:{..., setup(model)}})` ([README](https://raw.githubusercontent.com/amqp-node/amqplib/v2.2.0/README.md) L121–179). 2.1.0 added `waitForConnect`; 2.2.0 added `calculateDelay` and `initialMaxRetries`.
- Package: zero runtime dependencies; npm provenance present.
- Maintenance: 132 commits in 2026, 111 of them by cressie176. CI matrix is rabbitmq:4.2-alpine × Node 18–24.
- [PR #860](https://github.com/amqp-node/amqplib/pull/860) is a draft. It reports that reading frames straight from the received bytes gives "39% less CPU, 71% fewer bytes copied" for 448 KB messages. That suggests the current frame reassembly is wasteful for large messages.
- Watch out: `@types/amqplib` 0.10.8 is not deprecated and describes the old API. Do not install it.

**E3. Stream client**
- [client.ts@v1.1.0](https://raw.githubusercontent.com/coders51/rabbitmq-stream-js-client/v1.1.0/src/client.ts):
  - `mechanism?: "PLAIN" | "EXTERNAL"`.
  - `addressResolver: {enabled, endpoint?}`, implemented as a reconnect loop until the node's advertised host and port match (L885–912).
  - `singleActive` and `consumerUpdateListener`.
- Offset types are listed in [subscribe_request.ts](https://raw.githubusercontent.com/coders51/rabbitmq-stream-js-client/v1.1.0/src/requests/subscribe_request.ts).
- The server already supports updating the secret after the connection is open ([rabbit_stream_reader.erl@v4.3.6](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_stream/src/rabbit_stream_reader.erl) L1745–1800, `complete_secret_update`). The client does not expose it.

**E4.**
- @cloudamqp/amqp-client: [amqp-base-client.ts@v4.1.1](https://raw.githubusercontent.com/cloudamqp/amqp-client.js/v4.1.1/src/amqp-base-client.ts) L271 `startOk.writeShortString("PLAIN")`.
- The crash came from [nodejs/node#63597](https://github.com/nodejs/node/pull/63597), released in 24.18.0 (2026-06-23) and 26.3.0. It affects any protocol library that builds views on `buf.buffer` while assuming `byteOffset` is 0.
- I found no such pattern in amqplib 2.2.0 or rhea 3.0.5. That is a code scan only.

**E7/E8.** See the verdicts. Engine-relevant additions:
- Electron 46 changes `utilityProcess.kill()` so it only sends SIGTERM.
- The synchronous `safeStorage` methods are removed in 46 ([breaking-changes.md](https://raw.githubusercontent.com/electron/electron/main/docs/breaking-changes.md)).
- Electron's Node uses BoringSSL. `--use-openssl-ca` and `--openssl-config` are unsupported, and `NODE_EXTRA_CA_CERTS` is ignored when the nodeOptions fuse is off ([environment-variables.md@v44.8.0](https://raw.githubusercontent.com/electron/electron/v44.8.0/docs/api/environment-variables.md)).
- Node 24 offers alternatives: `tls.getCACertificates('system')` (v22.15+) and `tls.setDefaultCACertificates()` (v24.5.0) ([tls.md@v24.22.0](https://raw.githubusercontent.com/nodejs/node/v24.22.0/doc/api/tls.md)).
- [Electron PR #52873](https://github.com/electron/electron/pull/52873) (backported to 42–45) makes utility processes boot from the Node snapshot and code cache, which shortens engine startup.

**E9.**
- NestJS: [v12.0.0 notes](https://github.com/nestjs/nest/releases/tag/v12.0.0), [@nestjs/swagger 12.0.0 notes](https://github.com/nestjs/swagger/releases/tag/12.0.0).
- `@nestjs/platform-fastify` 12.1.3 pins `fastify` to exactly `5.12.5`. Do not add a second, different fastify version.
- Orval's Angular guide: [angular.mdx@v8.43.0](https://raw.githubusercontent.com/orval-labs/orval/v8.43.0/docs/content/docs/guides/angular.mdx).

---

### 4. TypeScript vs Go/.NET, quantified

### 4.1 Protocol and client capability matrix
Only cells I verified in source are marked ✓ or ✗; **n/v** means not verified.

| # | Capability needed by the product | TS (as shipped) | Go | .NET |
| --- | --- | --- | --- | --- |
| 1 | 0-9-1 `basic.get` + `nack(requeue)` | ✓ amqplib | ✓ amqp091-go `Get`/`Nack` | ✓ `BasicGetAsync`/`BasicNackAsync` |
| 2 | 0-9-1 SASL EXTERNAL | ✓ amqplib only | ✓ `ExternalAuth`, `DialTLS_ExternalAuth` | ✓ `ExternalMechanismFactory` |
| 3 | 0-9-1 update-secret (OAuth refresh) | ✓ | ✓ `UpdateSecret` | ✓ `UpdateSecretAsync` |
| 4 | 0-9-1 connection.blocked | ✓ | ✓ `NotifyBlocked` | ✓ `ConnectionBlockedAsync` |
| 5 | 0-9-1 server consumer-cancel | ✓ | ✓ `NotifyCancel` | n/v |
| 6 | 0-9-1 automatic topology recovery | ✗ (manual `setup`) | ✓ v1.13.0 | ✓ `TopologyRecoveryEnabled=true` |
| 7 | AMQP 1.0 vhost | ✗ | ✓ | ✓ |
| 8 | AMQP 1.0 consumer credit control | ✗ | ✓ `InitialCredits` | ✓ `InitialCredits` |
| 9 | AMQP 1.0 stream offset and Bloom filter accepted by 4.3 defaults | ✗ | ✓ described | ✓ described |
| 10 | AMQP 1.0 timestamp offset | ✗ | ✗ (no type) | ✓ `Offset(DateTime)` |
| 11 | AMQP 1.0 SQL and property filters | ✓ | ✓ | n/v |
| 12 | AMQP 1.0 address percent-encoding | ✗ (publisher/consumer) | ✓ | ✓ |
| 13 | AMQP 1.0 purge | ✗ | ✓ `PurgeQueue` | ✓ `PurgeAsync` |
| 14 | AMQP 1.0 SASL EXTERNAL | ✗ (typed API) | ✓ `SASLType` | ✓ `SaslMechanism.External` |
| 15 | AMQP 1.0 OAuth token refresh | ✓ | ✓ | n/v |
| 16 | Typed management HTTP API client | ✗ (nothing maintained on npm) | ✓ [rabbit-hole v3.5.0](https://github.com/michaelklishin/rabbit-hole/releases) | ✓ [EasyNetQ.Management.Client 3.0.1](https://github.com/EasyNetQ/EasyNetQ.Management.Client/releases) |
| 17 | Main 0-9-1 client's CI covers RabbitMQ 4.3 | ✗ (amqplib: 4.2) | ✓ (v1.12.0 "Fix integration tests for RabbitMQ 4.3") | n/v |

**Score**

|  | Count | Notes |
| --- | --- | --- |
| TypeScript libraries as shipped | **7/17** |  |
| Go | **16/17** |  |
| .NET | **13 ✓, 0 ✗** | 4 rows not verified |
| TypeScript with mitigations | **16/17** | Our own rhea adapter, our own management client and a conformance test matrix. Row 6 is intentionally not needed: the engine re-establishes its own sessions. |

### 4.2 Maintenance health in 2026 (GitHub API, commits and authors capped at the first 100)

| Library | Backer | Releases 2026 | Commits 2026 | Authors | CI broker | Stars |
| --- | --- | --- | --- | --- | --- | --- |
| amqplib | community (2 npm maintainers) | 15 (npm) | 132 (84% one author) | 3 | 4.2 | 3,846 |
| @cloudamqp/amqp-client | CloudAMQP/84codes | 3 | ≥100 | 8 | n/v | 241 |
| rabbitmq-client | individual | 0 | – | – | – | 176 |
| rabbitmq-amqp-js-client | coders51 | 1 (+1 alpha) | 8 | 5 | 4.2.0-beta.3 | 9 |
| rabbitmq-stream-js-client | coders51 | 2 | 10 | 4 | 4.0.5 | 52 |
| rhea | 1 npm maintainer | 1 | ~5 | – | – | 302 (103 open issues) |
| amqp091-go | RabbitMQ team | 5 | ≥100 | 7 | 4.3 | 2,040 |
| rabbitmq-amqp-go-client | RabbitMQ team | 9 | 59 | 6 | n/v | 67 |
| rabbitmq-stream-go-client | RabbitMQ team | 7 | 73 | 8 | n/v | 221 |
| RabbitMQ.Client (.NET) | RabbitMQ team | 2 | ≥100 | 4 | n/v | 2,285 |
| rabbitmq-amqp-dotnet-client | RabbitMQ team | 8 | 45 | 6 | n/v | 25 |
| rabbitmq-stream-dotnet-client | RabbitMQ team | 6 | 29 | 3 | n/v | 137 |

The team-maintained AMQP 1.0 clients release roughly monthly and in step with each other: Go and .NET 1.4.0 on 2026-09-09, Java 1.6.0 on 2026-10-09. The JS client has had one stable release, in June.

### 4.3 Effort to close the TypeScript gaps
These are estimates, not measurements.
- **AMQP 1.0 adapter on rhea:** about 1.5–2.5k lines plus about 60 conformance tests.
- **Typed management HTTP client:** about 60 endpoints, 2–3k lines of zod schemas plus per-version golden fixtures.
- **Conformance CI:** 5–6 broker versions × 3 runtimes.
- **Total:** about 6–9 engineer-weeks, less with coding agents, but each piece needs review.

---

### 5. Risk register

L = likelihood and I = impact, each scored 1–5; the score is L×I. "Residual" is the score after the mitigation.

| ID | Risk | Evidence | L | I | Score | Go/.NET exposure | Mitigation | Residual |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | AMQP 1.0 JS client correctness gaps (§2): filters dropped on 4.3, broken offsets, no vhost, no credit control, link race, unencoded addresses | code-level, file@tag above | 5 | 5 | 25 | Low | Keep `rabbitmq-amqp-js-client` out of the production path. Build `adapter-amqp10` on **rhea 3.0.5**. Check the filters the broker reports as applied in its attach reply, and fail closed if any are missing. Run differential tests against the official client. Contribute fixes upstream. | 6 |
| R2 | rhea: single npm maintainer; 103 open issues; decoder hardening unreleased since 3.0.5 | registry, commits | 3 | 3 | 9 | Low (go-amqp, AMQPNetLite) | Pin 3.0.5 and watch main. Rhea is Apache-2.0, so be ready to vendor or fork it. Connect only to brokers the user configured. | 6 |
| R3 | amqplib bus factor of about 1; CI only on RabbitMQ 4.2 | commit stats, test.yml | 3 | 4 | 12 | Low | Put 0-9-1 behind an `Amqp091Port`. Run the contract suite against amqplib **and** @cloudamqp/amqp-client. Upstream EXTERNAL support to @cloudamqp so it becomes a viable fallback. Contribute 4.3 CI to amqplib. MIT licence makes a fork possible. | 6 |
| R4 | Peek side effects from library defaults: rhea's credit of 1000; `basic.get` on SAC queues closes the channel | link.js L344; [rabbit_channel.erl@v4.3.6](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_channel.erl) L2878-2885 "basic.get operations are not supported by ~p queues with single active consumer" | 4 | 5 | 20 | Medium (the defaults are safer there) | Use an explicit credit of N plus drain. Release every delivery explicitly before detaching. Check queue arguments before calling `basic.get`. Use a throwaway channel for each risky operation. Add per-version tests that assert acquired and delivery counts. | 4 |
| R5 | Stream protocol client: community-maintained, CI on 4.0.5, load-balancer-only resolver, no secret refresh | §3 | 3 | 2 | 6 | Low | Default stream browsing over our own AMQP 1.0 adapter. Keep the stream protocol behind a feature flag and test it on 4.3. | 4 |
| R6 | No typed management HTTP API client in TS | npm search; Go and .NET equivalents exist | 5 | 3 | 15 | Low | Write our own undici + zod client with a hand-maintained OpenAPI description and golden fixtures for 3.13 and 4.0–4.3. Use rabbitmq-http-api-rs 0.93.0 as the reference for coverage. | 2 |
| R7 | Runtime drift: Node minor releases change behaviour (`Buffer.poolSize`); Electron's BoringSSL; fuses block CA environment variables; Electron 46 lifecycle changes; Node 24 in maintenance gets no new features | §3 | 3 | 3 | 9 | Medium for .NET and Go too, but no Electron coupling | Run CI on Node 24.latest, 26.latest and Electron's own Node. Load system CAs in code. Handle SIGTERM. Use the async safeStorage methods. | 4 |
| R8 | node:sqlite is a release candidate and synchronous; no Kysely dialect; rename in Node 26 | §E6 | 2 | 3 | 6 | n/a | Write the in-repo dialect with contract tests. Detect `Database ?? DatabaseSync` at runtime. Run heavy FTS queries in a worker. Keep better-sqlite3 13.0.3 (N-API) as the fallback. | 2 |
| R9 | NestJS 12 ESM ecosystem lag (nestjs-zod; a new `standardSchemaConverter`; fastify pinned exactly) | registry | 3 | 2 | 6 | n/a | Use @nestjs/swagger 12 with `z.toJSONSchema` or zod-openapi. Lock the OpenAPI snapshot with oasdiff. | 2 |
| R10 | Version-pin hazards for AI agents: npm `latest` TypeScript is **7.0.2**, but Angular 22 needs `>=6.0 <6.1`; `@types/amqplib` is not deprecated; Orval ships weekly | registry | 4 | 3 | 12 | n/a | Exact pins, pnpm catalogs, Renovate groups, and lint rules that ban TS 7 and `@types/amqplib`. | 2 |
| R11 | Supply chain: git-URL dependencies have no integrity hash or provenance; rhea, @nestjs/* and orval publish without provenance | registry `dist.attestations` | 2 | 5 | 10 | Lower (Go module checksum database) | Fail CI on any git-resolved dependency in the lockfile. Use pnpm `overrides` (rhea → 3.0.5) and a frozen lockfile. Verify signatures with `npm audit signatures`. Publish an SBOM. Set a minimum release age before adopting new versions. | 4 |
| R12 | Throughput, memory and GC under live tap or bulk replay | amqplib PR #860 numbers | 3 | 3 | 9 | Lower | Decode in a piscina worker pool. Use bounded rings and credit-based flow control. Gate merges on benchmarks. Adopt the #860 fix once it is merged. | 4 |
| R13 | Single-executable immaturity | §E12 | 3 | 2 | 6 | Low (Go builds static binaries natively) | Do not ship a single executable in v1; npx, Docker and Electron cover every mode. Later, use Node 26 `--build-sea` (plus pkg or Bun for darwin-x64). | 2 |
| R14 | Licence hygiene: no LICENSE in the AMQP 1.0 JS client; ISC vs MIT mismatch in the stream client | repo contents | 5 | 1 | 5 | Low | Prefer our own rhea adapter. Keep notices on anything vendored. Ask upstream to add a LICENSE. | 1 |
| R15 | Broker version skew: no Node client tests against 4.3 or main; 4.3 deny-by-default deprecations (`amqp_filter_set_bug`, `amqp_address_v1`, `global_qos` silently downgraded, `transient_nonexcl_queues`) | release notes 4.3.0 L139-145; rabbit_channel.erl L1458-1468 | 4 | 4 | 16 | Medium | Conformance matrix including the nightly `pivotalrabbitmq/rabbitmq:main-otp28` image (allowed to fail). Read capabilities from `/api/deprecated-features/used`. | 6 |

---

### 6. Mitigation designs

### 6.1 `adapter-amqp10` on raw rhea 3.0.5

**Connection**

```ts
container.connect({
  host, port,
  hostname: `vhost:${vhost}`,                 // vhost selection
  transport: tls ? 'tls' : undefined,
  ca, cert, key, servername,                  // per-connection CA
  enable_sasl_external: auth === 'external',  // EXTERNAL needs TLS + cert
  username: auth === 'external' ? undefined : user,
  password: auth === 'external' ? undefined : secret,
  reconnect: false,                           // engine-owned session manager
})
```

**Addresses**

```ts
'/queues/' + encodeURIComponent(q)
'/exchanges/' + encodeURIComponent(x) + '/' + encodeURIComponent(rk)
```

**Filter-set**: every value is a described type with a symbol descriptor.

```ts
types.described(types.wrap_symbol('rabbitmq:stream-offset-spec'), v)
// v = wrap_string('first') | wrap_ulong(n) | wrap_timestamp(ms) | wrap_string('10m')
```
- `rabbitmq:stream-filter` is a described list of strings.
- `rabbitmq:stream-match-unfiltered` is a described boolean.
- `sql-filter` uses descriptor code 0x120, `properties-filter` 0x173 and `application-properties-filter` 0x174 ([amqp10_filter.hrl@v4.3.6](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/amqp10_common/include/amqp10_filter.hrl)).
- After attach, compare the filters we requested with the filter-set in the broker's attach reply, and **refuse to scan** if any was dropped.

**Peek (non-stream queues)**
1. `open_receiver({credit_window: 0, autoaccept: false, autosettle: false, rcv_settle_mode: 0, source:{address}})`.
2. `add_credit(N)`, then `drain_credit()`. Collect deliveries until N have arrived, `receiver_drained` fires, or a timeout expires.
3. Settle every delivery explicitly with the outcome chosen by the per-version policy (e.g. `release()`).
4. Detach.
- Each link is opened with its own `once('receiver_open')` listener; never a connection-level `once`.
- rhea supports `drain_credit()` and `add_credit()` ([link.js@3.0.5](https://raw.githubusercontent.com/amqp/rhea/3.0.5/lib/link.js) L364–377).

**Live tap**
- Keep a bounded credit window (for example 64) and grant more credit only as the UI consumes.
- Use pre-settled delivery only on tap-owned queues.

**Management node**
- Send HTTP-over-AMQP requests to `/management`, implementing `PUT`/`DELETE`/`GET` on queues and exchanges, `DELETE /queues/:q/messages` (purge), `GET /bindings?src=..` and `PUT /auth/tokens`. The broker routes are listed in rabbit_amqp_management.erl@v4.3.6.
- Use management.ts@v1.0.0 as the reference for the paired-link setup.

### 6.2 `adapter-amqp091` on amqplib 2.2.0
- Pin exactly, with no `@types/amqplib`.
- Use one long-lived connection per broker profile. Use throwaway channels for passive declares and `get` on exclusive or SAC queues, because a 0-9-1 channel error closes the channel.
- Always attach `channel.on('error')` and `connection.on('blocked'/'unblocked')`. A consume callback receiving `null` means the server cancelled the consumer; treat it as a first-class event.
- Use ConfirmChannel together with `mandatory` and the `return` event for move and replay operations.
- Do not rely on `global` prefetch: RabbitMQ 4.3 silently downgrades it to per-consumer.
- Use recovery only for long-lived taps, with our own `setup` that re-attaches them.

### 6.3 Stream protocol (optional fast path)
- rabbitmq-stream-js-client 1.1.0 behind a feature flag.
- Use `addressResolver` load-balancer mode for Docker or Kubernetes port-forwards.
- No token refresh means reconnecting before the token expires.

### 6.4 Conformance test kit and CI matrix
- **Broker images:**
  - `rabbitmq:3.13.7-management`
  - `4.0.9-management`
  - `4.1.8-management`
  - `4.2.9-management`
  - `4.3.6-management`
  - `pivotalrabbitmq/rabbitmq:main-otp28` (allowed to fail)

  Image list from the [Docker Hub API](https://hub.docker.com/v2/repositories/library/rabbitmq/tags).
- **Runtimes:** Node 24.22.x, Node 26.12.x, and Electron 45's Node. The last is run with `ELECTRON_RUN_AS_NODE=1` on a **test** binary whose RunAsNode and nodeCliInspect fuses are enabled; release binaries flip those fuses off.
- **Where:**
  - Linux runners run the full matrix with Testcontainers. Extend `RabbitMQContainer` with ports 5552 and 15692 plus a plugins and config mount.
  - macOS jobs run a smoke subset against `brew install rabbitmq` (4.3.6).
  - Windows jobs cover packaging and a smoke subset only, because Linux containers do not run there.
- **Test areas:**
  - vhost selection
  - EXTERNAL and PLAIN
  - update-secret and `/auth/tokens`
  - addresses with `/ % ? # space` and unicode
  - peek takes exactly N messages; acquired and delivery counts per version
  - stream attach at first, offset 0, offset N, timestamp T, and with a Bloom filter, each checked against the effective filter-set
  - SAC queue with `basic.get`
  - server cancel when a queue is deleted
  - blocked connection during confirms
  - concurrent link creation (100 in parallel)
  - large messages (1–10 MB) for CPU and GC
  - reconnect under toxiproxy

### 6.5 Upstream contributions (cheap leverage)
- **coders51/rabbitmq-amqp-js-client:**
  - send stream filters as described values and wrap timestamps correctly
  - percent-encode addresses
  - merge #94 (credits) and #95 (vhost)
  - fix #96 with per-link listeners
  - remove the `console.log` calls
  - replace the git dependency with `rhea@^3.0.5`
  - add a LICENSE file
  - add RabbitMQ 4.3 and main to CI
- **coders51/rabbitmq-stream-js-client:**
  - an update-secret API
  - an address-mapping callback
  - 4.3 in CI
- **cloudamqp/amqp-client.js:** EXTERNAL mechanism selection (about 30 lines).
- **amqp-node/amqplib:** 4.3 and Node 26 in CI; help land #860.

---

### 7. Persistence: node:sqlite + Kysely

A ~30-line in-repo dialect. Kysely calls `stmt.all(paramsArray)`, but node:sqlite expects spread arguments ([sqlite-dialect-config.ts@v0.29.6](https://raw.githubusercontent.com/kysely-org/kysely/v0.29.6/src/dialect/sqlite/sqlite-dialect-config.ts)):

```ts
import * as sqlite from 'node:sqlite';
const Db = (sqlite as any).Database ?? sqlite.DatabaseSync;   // Node 26 rename
const raw = new Db(file, { timeout: 5000 });
const db = new Kysely<DB>({ dialect: new SqliteDialect({ database: {
  close: () => raw.close(),
  prepare: (sql: string) => { const s = raw.prepare(sql); return {
    reader: s.columns().length > 0,
    all: (p) => s.all(...p), run: (p) => s.run(...p), iterate: (p) => s.iterate(...p) }; },
}})});
```

**Caveats** ([sqlite.md@v24.22.0](https://raw.githubusercontent.com/nodejs/node/v24.22.0/doc/api/sqlite.md), "Type conversion"):
- Bindable types are only null, number, bigint, boolean, string and TypedArray/DataView/ArrayBuffer. Serialise `Date` values to ISO strings or epoch milliseconds.
- Reading an INTEGER outside the safe-integer range throws `ERR_OUT_OF_RANGE` unless `readBigInts` is on. Use it for u64 stream offsets.
- The API is synchronous. Keep queries small, or move FTS5 search into a `worker_thread`.
- The Postgres side is Kysely's `PostgresDialect` with pg 8.23.1.

---

### 8. Contracts: zod 4 → OpenAPI 3.1 → Angular
1. Validate in Nest 12 with `@Body({ schema })` (Standard Schema).
2. Generate the document with `@nestjs/swagger` 12.0.2 and its `standardSchemaConverter`. Use `z.toJSONSchema(schema)` (draft-2020-12) or zod-openapi 6.0.2's `createSchema({openapiVersion:'3.1.0'})`, and set the document to `3.1.0`.
3. Generate the Angular client with Orval 8.43.0, using `override.angular.retrievalClient:'httpClient'` (the default) or `'both'` to add `httpResource` reads.
4. Pin Orval exactly. It released 43 minor versions in 2026, including internal OpenAPI 3.1 refactors in 8.34 and 8.35.
5. Do not use nestjs-zod 5.5.0.

---

### 9. Recommended pins (as of 2026-10-16)

| Component | Pin | Released | Notes |
| --- | --- | --- | --- |
| Node (engine, CLI, server image) | **24.22.0** (track 24.x) | 2026-10-14 | Same Node as Electron 45. Maintenance from 2026-10-20, end of life 2028-04-30. Move to 26 when Electron does (inferred: Electron 47). |
| Node (secondary CI) | **26.12.0** | 2026-10-14 | LTS from 2026-10-28. |
| Electron | **45.0.x** at GA (2026-10-20); 44.8.0 until then | – | Chromium 156 / Node 24.22.0. End of life 2027-04-27. Prepare now for the Electron 46 `kill()` and safeStorage changes. |
| TypeScript | **6.0.3** | 2026-04-16 | Angular 22 compiler-cli needs `>=6.0 <6.1`; `@nestjs/cli` 12.0.8 depends on `~6.0.2`. npm `latest` is 7.0.2: forbid it. |
| NestJS | **@nestjs/core, common, platform-fastify, testing 12.1.3**; @nestjs/swagger **12.0.2**; @nestjs/cli **12.0.8** | 2026-10-12 | fastify **5.12.5** comes through the adapter. |
| AMQP 0-9-1 | **amqplib 2.2.0** | 2026-09-28 | No `@types/amqplib`. |
| AMQP 1.0 | **rhea 3.0.5** plus our own adapter | 2026-04-28 | Use rabbitmq-amqp-js-client 1.0.0 only as a reference or differential oracle. If it is installed anywhere, override its rhea to 3.0.5. |
| Stream (optional) | **rabbitmq-stream-js-client 1.1.0** | 2026-07-23 | Feature-flagged. |
| Persistence | **node:sqlite** (DatabaseSync) + **kysely 0.29.6** + in-repo dialect; **pg 8.23.1** | – | Fallback: better-sqlite3 13.0.3 (N-API). |
| Validation | **zod 4.6.7** | 2026-10-12 | Optionally zod-openapi 6.0.2. |
| Client generation | **orval 8.43.0** + @orval/angular 8.43.0 | 2026-10-14 | Exact pin; needs Node 22.18+. |
| Integration tests | **testcontainers 12.2.1** + **@testcontainers/rabbitmq 12.2.1** | 2026-10-13 | Needs Node 22.22+. |
| Electron E2E | **playwright 1.64.1** | 2026-10-14 | Experimental; nodeCliInspect fuse kept on in test builds only. |

---

### 10. Single-executable assessment for this engine
The engine has no native addons when it uses node:sqlite and avoids keyring addons in CLI or local-web mode.

| Option | Assessment |
| --- | --- |
| **Node 26 `--build-sea`** | The closest match to the Node we test on. Works for linux, win and mac-arm64. macOS x64 is unsupported. VFS is at early development. |
| **@yao-pkg/pkg** in enhanced SEA mode | Stock Node binary; possible fallback for darwin-x64. |
| **Bun `--compile`** | Builds every target, but the runtime differs from Node: the full conformance suite would have to run under Bun too. |
| **Deno compile** | Same caveat as Bun about runtime divergence. |

**Recommendation:** ship no single executable in v1.

---

### 11. Open questions
Listed in the structured output.

### Design implications

- Keep rabbitmq-amqp-js-client 1.0.0 out of the engine's production path. Build `adapter-amqp10` directly on rhea 3.0.5, pinned exactly, with:
- vhost selected as `hostname: 'vhost:<v>'`;
- EXTERNAL via `enable_sasl_external` plus a TLS `cert`;
- percent-encoded v2 addresses;
- per-link open/close listeners;
- every filter sent as a described value with a symbol descriptor;
- timestamps sent as AMQP `timestamp` values.
Use the official client only as a differential-test oracle and as a target for upstream PRs.
- When starting any stream scan, compare the filters we requested with the filter-set the broker reports as applied in its attach reply. If any filter was dropped, fail closed and show 'broker ignored filter X'. Do not silently scan a whole stream. This also guards against future deprecation removals (`amqp_filter_set_bug` is already `removed` on main).
- Implement AMQP 1.0 peek with:
- `credit_window: 0` and `autoaccept`/`autosettle` off;
- `add_credit(N)` followed by `drain_credit()`;
- explicit settlement of every delivery before detach, with the outcome chosen by the per-version policy.
Never rely on rhea's default credit of 1000, which refills as messages arrive.
- For a live tap over AMQP 1.0:
- grant credit in small bounded windows (for example 64), only as the UI consumes;
- use pre-settled delivery only on tap-owned queues;
- show counts of dropped and sampled messages.
- Use amqplib 2.2.0 for AMQP 0-9-1. Run each risky operation (passive declare, get, exclusive/SAC access) on its own throwaway channel. Check `x-single-active-consumer` before `basic.get`, because RabbitMQ closes the channel with resource_locked. Treat a consume callback that receives `null` as a server cancel. Do not use global prefetch, which 4.3 silently downgrades.
- Put every protocol client behind a port interface (`Amqp091Port`, `Amqp10Port`, `StreamPort`, `MgmtHttpPort`). Run the same contract suite against amqplib and @cloudamqp/amqp-client, so the 0-9-1 library can be swapped if amqplib's single active maintainer stops.
- Default stream browsing to our AMQP 1.0 adapter on port 5672. Make rabbitmq-stream-js-client 1.1.0 an optional fast path behind a feature flag, use addressResolver load-balancer mode for port-forwards, and reconnect before an OAuth token expires because the client cannot refresh it.
- Build the management HTTP API client in-house with undici and zod, with golden fixtures for 3.13.7, 4.0.9, 4.1.8, 4.2.9 and 4.3.6. No maintained typed TS client exists, whereas Go has rabbit-hole and .NET has EasyNetQ.Management.Client.
- Run CI as a broker × runtime matrix:
- **Brokers:** RabbitMQ 3.13 through 4.3.6, plus the pivotalrabbitmq main nightly, which is allowed to fail.
- **Runtimes:** Node 24.22, Node 26.12, and Electron 45's Node via `ELECTRON_RUN_AS_NODE` on a test-fused binary.
- **Runners:** the full matrix on Linux runners only. macOS runs smoke tests against `brew install rabbitmq`. Windows runs packaging and smoke tests.
- Use separate Electron fuse profiles for tests and releases. Test binaries keep `nodeCliInspect` (needed by Playwright) and `RunAsNode` (needed for engine tests in Electron's Node). Release binaries disable both, plus NodeOptions. Because Electron's Node uses BoringSSL and ignores `NODE_EXTRA_CA_CERTS` once the NodeOptions fuse is off, load CAs in code: `tls.getCACertificates('system')` combined with per-profile CA bundles.
- Make the engine exit on its own from a SIGTERM handler, with a bounded drain of about 2 s, and have the main process escalate after a timeout. From Electron 46, `utilityProcess.kill()` no longer force-kills. Use only `safeStorage.*Async` APIs, because Electron 46 removes the synchronous ones.
- Pin TypeScript 6.0.3 for the whole workspace and ban TypeScript 7 and `@types/amqplib` with a lint or syncpack rule. Pin orval, NestJS and amqplib exactly. Do not add a direct fastify dependency that differs from the 5.12.5 that @nestjs/platform-fastify pins. AI agents will otherwise install npm `latest`.
- Persistence:
- Use node:sqlite with an in-repo Kysely dialect, about 30 lines that adapt `reader`/`all`/`run`/`iterate` and spread the parameters.
- Detect `Database ?? DatabaseSync` at runtime for Node 26.
- Store dates as ISO strings or epoch milliseconds, and enable `readBigInts` for u64 offsets.
- Run FTS5 search in a worker if profiling shows event-loop stalls.
- Keep better-sqlite3 13.0.3 (N-API) as a drop-in fallback.
- Generate contracts with zod 4 through @nestjs/swagger 12's `standardSchemaConverter`, backed by `z.toJSONSchema` or zod-openapi 6, emitting OpenAPI 3.1. Generate the Angular client with Orval 8 using retrievalClient 'httpClient', optionally 'both' to add httpResource reads. Fail CI on breaking spec diffs. Do not use nestjs-zod with Nest 12.
- Supply chain:
- Fail CI when the lockfile resolves any dependency from a git URL.
- If rabbitmq-amqp-js-client is installed anywhere, use pnpm overrides to pin its rhea to the registry's 3.0.5.
- Verify signatures with `npm audit signatures`, publish an SBOM, and require a minimum release age before updates.
- Do not ship a single-executable build in v1; npx, Docker and Electron cover all delivery modes. If one is needed later, use Node 26 `--build-sea` for linux, win and mac-arm64, plus @yao-pkg/pkg's enhanced SEA mode or Bun for darwin-x64, and run the full conformance suite on whichever runtime is chosen.
- Budget roughly 6–9 engineer-weeks (estimate) for the work TypeScript needs and Go or .NET would not:
- the rhea adapter;
- the typed management HTTP client;
- the conformance matrix;
- the upstream PRs.
Track it as a named workstream so the confirmed TypeScript-end-to-end decision does not quietly accumulate protocol debt.

### Open questions

- Confirm against a live broker that rabbitmq-amqp-js-client 1.0.0 on RabbitMQ 4.3.6 (default deprecated-feature settings) starts `Offset.first()` consumers at `next` and ignores Bloom `filterValues`, and that adding `deprecated_features.permit.amqp_filter_set_bug = true` restores the old behaviour. This is derived from code, not executed.
- Confirm empirically that rhea encodes a JS bigint as an empty AMQP map, and that the broker then ignores the offset spec on 4.0–4.3.
- Find out whether RabbitMQ 3.13.x supports stream offset and filter specs over AMQP 1.0. 3.13 used the pre-4.0 AMQP 1.0 plugin, so 3.13 stream browsing may have to use AMQP 0-9-1 with `x-stream-offset`.
- Check what RabbitMQ does with deliveries still unsettled when a link detaches, version by version (3.13, 4.0–4.2, 4.3): does it count them as delivery failures (incrementing delivery-count)? This decides whether explicit release before detach is strictly required.
- Measure NestJS 12 cold-start time inside an Electron 45 utilityProcess, with esbuild bundling and Electron's snapshot/code-cache boot (PR #52873), against a budget of about 400 ms until the first request is served.
- Test whether `tls.getCACertificates('system')` and PKCS#12 (`pfx`) client certificates work in Electron's BoringSSL-based Node, compared with stock Node 24.
- Measure node:sqlite FTS5 performance and event-loop blocking with 50k–200k queues and exchanges indexed, and decide whether search needs a worker thread.
- Find out which Node major Electron 46 ships with. Its branch cut on 2026-10-22 comes before Node 26 LTS on 2026-10-28, so my inference is Node 24, with Electron 47 moving to Node 26.
- Measure amqplib's CPU and GC cost for 1–10 MB messages during peek, move and replay, and check whether the draft PR #860 frame-slicing approach lands upstream.
- Ask whether coders51 will accept the fixes in §6.5 (filter encoding, credits #94, vhost #95, race #96), and on what timeline. This decides whether we keep our own adapter permanently or eventually converge on upstream.
- Ask whether cloudamqp/amqp-client.js would accept SASL EXTERNAL support. Without it, it is not a credible fallback for 0-9-1 with mTLS identity.
- Decide how Windows CI should test against a broker, given that Linux containers are unavailable on hosted Windows runners: a native RabbitMQ and Erlang install, or a remote broker.
- The @cloudamqp/amqp-client figure of about 300k msg/s publishing versus amqplib's 172k comes from the vendor (prior corpus) and has not been benchmarked here.

### Sources

- https://registry.npmjs.org/amqplib
- https://registry.npmjs.org/amqplib/2.2.0
- https://raw.githubusercontent.com/amqp-node/amqplib/v2.2.0/CHANGELOG.md
- https://raw.githubusercontent.com/amqp-node/amqplib/v2.2.0/README.md
- https://raw.githubusercontent.com/amqp-node/amqplib/v2.2.0/lib/credentials.js
- https://raw.githubusercontent.com/amqp-node/amqplib/v2.2.0/lib/connection.js
- https://raw.githubusercontent.com/amqp-node/amqplib/v2.2.0/lib/channel.js
- https://raw.githubusercontent.com/amqp-node/amqplib/v2.2.0/lib/channel_model.js
- https://raw.githubusercontent.com/amqp-node/amqplib/v2.2.0/lib/connect.js
- https://raw.githubusercontent.com/amqp-node/amqplib/v2.2.0/lib/recovery.js
- https://raw.githubusercontent.com/amqp-node/amqplib/v2.2.0/.github/workflows/test.yml
- https://api.github.com/repos/amqp-node/amqplib/commits?since=2026-01-01T00:00:00Z
- https://github.com/amqp-node/amqplib/pull/860
- https://registry.npmjs.org/@types/amqplib
- https://registry.npmjs.org/rabbitmq-amqp-js-client
- https://registry.npmjs.org/rabbitmq-amqp-js-client/1.0.0
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/src/environment.ts
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/src/connection.ts
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/src/rhea_wrapper.ts
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/src/consumer.ts
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/src/delivery_context.ts
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/src/message.ts
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/src/utils.ts
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/src/link_message_builder.ts
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/src/management.ts
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/src/publisher.ts
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/src/index.ts
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/test/e2e/consumer.test.ts
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/.github/workflows/main.yml
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/docker-compose.yml
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/package.json
- https://github.com/coders51/rabbitmq-amqp-js-client/pull/94
- https://github.com/coders51/rabbitmq-amqp-js-client/pull/95
- https://github.com/coders51/rabbitmq-amqp-js-client/issues/96
- https://github.com/coders51/rabbitmq-amqp-js-client/pull/79
- https://registry.npmjs.org/rhea
- https://registry.npmjs.org/rhea/3.0.5
- https://raw.githubusercontent.com/amqp/rhea/3.0.5/lib/types.js
- https://raw.githubusercontent.com/amqp/rhea/3.0.5/lib/link.js
- https://raw.githubusercontent.com/amqp/rhea/3.0.5/lib/terminus.js
- https://raw.githubusercontent.com/amqp/rhea/3.0.5/lib/sasl.js
- https://raw.githubusercontent.com/amqp/rhea/main/lib/connection.js
- https://github.com/amqp/rhea/commits/main
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_amqp_session.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.0/deps/rabbit/src/rabbit_amqp_session.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.0/deps/rabbit/src/rabbit_amqp_session.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.1.0/deps/rabbit/src/rabbit_amqp_session.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbit/src/rabbit_amqp_session.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/release-notes/4.3.0.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_amqp_management.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/amqp10_common/include/amqp10_filter.hrl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_amqp_filter_sql.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_channel.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_stream/docs/PROTOCOL.adoc
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_stream/src/rabbit_stream_reader.erl
- https://github.com/rabbitmq/rabbitmq-server/releases
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/amqp.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/client-libraries/amqp-client-libraries.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/client-libraries/devtools.md
- https://registry.npmjs.org/rabbitmq-stream-js-client
- https://raw.githubusercontent.com/coders51/rabbitmq-stream-js-client/v1.1.0/src/client.ts
- https://raw.githubusercontent.com/coders51/rabbitmq-stream-js-client/v1.1.0/src/connection.ts
- https://raw.githubusercontent.com/coders51/rabbitmq-stream-js-client/v1.1.0/src/requests/subscribe_request.ts
- https://raw.githubusercontent.com/coders51/rabbitmq-stream-js-client/v1.1.0/LICENSE
- https://raw.githubusercontent.com/coders51/rabbitmq-stream-js-client/v1.1.0/package.json
- https://raw.githubusercontent.com/coders51/rabbitmq-stream-js-client/v1.1.0/.github/workflows/main.yml
- https://github.com/coders51/rabbitmq-stream-js-client/releases
- https://github.com/coders51/rabbitmq-stream-js-client/pull/293
- https://registry.npmjs.org/@cloudamqp/amqp-client
- https://raw.githubusercontent.com/cloudamqp/amqp-client.js/v4.1.1/CHANGELOG.md
- https://raw.githubusercontent.com/cloudamqp/amqp-client.js/v4.1.1/src/amqp-base-client.ts
- https://registry.npmjs.org/rabbitmq-client
- https://raw.githubusercontent.com/cody-greene/node-rabbitmq-client/v5.0.8/src/Connection.ts
- https://raw.githubusercontent.com/cody-greene/node-rabbitmq-client/v5.0.8/src/Channel.ts
- https://github.com/rabbitmq/amqp091-go/releases
- https://raw.githubusercontent.com/rabbitmq/amqp091-go/v1.15.0/connection.go
- https://raw.githubusercontent.com/rabbitmq/amqp091-go/v1.15.0/auth.go
- https://raw.githubusercontent.com/rabbitmq/amqp091-go/v1.15.0/channel.go
- https://proxy.golang.org/github.com/rabbitmq/rabbitmq-amqp-go-client/@v/v1.0.0.info
- https://proxy.golang.org/github.com/rabbitmq/rabbitmq-amqp-go-client/@v/v1.4.0.info
- https://proxy.golang.org/github.com/rabbitmq/amqp091-go/@v/v1.15.0.info
- https://proxy.golang.org/github.com/rabbitmq/rabbitmq-stream-go-client/@v/v1.8.3.info
- https://github.com/rabbitmq/rabbitmq-amqp-go-client/releases
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-amqp-go-client/v1.4.0/pkg/rabbitmqamqp/amqp_types.go
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-amqp-go-client/v1.4.0/pkg/rabbitmqamqp/common.go
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-amqp-go-client/v1.4.0/pkg/rabbitmqamqp/amqp_connection.go
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-amqp-go-client/v1.4.0/pkg/rabbitmqamqp/amqp_consumer.go
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-amqp-go-client/v1.4.0/pkg/rabbitmqamqp/amqp_management.go
- https://github.com/rabbitmq/rabbitmq-stream-go-client/releases
- https://github.com/rabbitmq/rabbitmq-dotnet-client/releases
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-dotnet-client/v7.2.2/projects/RabbitMQ.Client/IConnection.cs
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-dotnet-client/v7.2.2/projects/RabbitMQ.Client/ConnectionFactory.cs
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-dotnet-client/v7.2.2/projects/RabbitMQ.Client/IChannel.cs
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-dotnet-client/v7.2.2/projects/RabbitMQ.Client/ExternalMechanismFactory.cs
- https://github.com/rabbitmq/rabbitmq-amqp-dotnet-client/releases
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-amqp-dotnet-client/v1.4.0/RabbitMQ.AMQP.Client/IConsumerBuilder.cs
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-amqp-dotnet-client/v1.4.0/RabbitMQ.AMQP.Client/Impl/AmqpConsumerBuilder.cs
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-amqp-dotnet-client/v1.4.0/RabbitMQ.AMQP.Client/Consts.cs
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-amqp-dotnet-client/v1.4.0/RabbitMQ.AMQP.Client/Impl/AddressBuilder.cs
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-amqp-dotnet-client/v1.4.0/RabbitMQ.AMQP.Client/Utils.cs
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-amqp-dotnet-client/v1.4.0/RabbitMQ.AMQP.Client/SaslMechanism.cs
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-amqp-dotnet-client/v1.4.0/RabbitMQ.AMQP.Client/ConnectionSettings.cs
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-amqp-dotnet-client/v1.4.0/RabbitMQ.AMQP.Client/IEntities.cs
- https://github.com/rabbitmq/rabbitmq-stream-dotnet-client/releases
- https://github.com/rabbitmq/rabbitmq-amqp-java-client/releases
- https://github.com/rabbitmq/rabbitmq-amqp-python-client/releases
- https://github.com/michaelklishin/rabbit-hole/releases
- https://github.com/michaelklishin/rabbitmq-http-api-rs/releases
- https://github.com/EasyNetQ/EasyNetQ.Management.Client/releases
- https://nodejs.org/dist/index.json
- https://nodejs.org/dist/v24.22.0/
- https://raw.githubusercontent.com/nodejs/Release/main/schedule.json
- https://raw.githubusercontent.com/nodejs/node/v24.22.0/doc/api/sqlite.md
- https://raw.githubusercontent.com/nodejs/node/v26.12.0/doc/api/sqlite.md
- https://raw.githubusercontent.com/nodejs/node/v26.12.0/doc/api/deprecations.md
- https://raw.githubusercontent.com/nodejs/node/v24.22.0/deps/sqlite/sqlite.gyp
- https://raw.githubusercontent.com/nodejs/node/v24.22.0/deps/sqlite/sqlite3.h
- https://raw.githubusercontent.com/nodejs/node/v24.22.0/doc/api/single-executable-applications.md
- https://raw.githubusercontent.com/nodejs/node/v26.12.0/doc/api/single-executable-applications.md
- https://raw.githubusercontent.com/nodejs/node/v24.22.0/doc/api/tls.md
- https://raw.githubusercontent.com/nodejs/node/v24.22.0/doc/api/cli.md
- https://raw.githubusercontent.com/nodejs/node/main/doc/changelogs/CHANGELOG_V24.md
- https://raw.githubusercontent.com/nodejs/node/main/doc/changelogs/CHANGELOG_V26.md
- https://github.com/nodejs/node/pull/63597
- https://releases.electronjs.org/releases.json
- https://releases.electronjs.org/schedule
- https://github.com/electron/electron/releases/tag/v44.0.0
- https://github.com/electron/electron/releases/tag/v44.8.0
- https://raw.githubusercontent.com/electron/electron/v44.8.0/docs/tutorial/fuses.md
- https://raw.githubusercontent.com/electron/electron/v44.8.0/docs/api/utility-process.md
- https://raw.githubusercontent.com/electron/electron/v44.8.0/docs/api/environment-variables.md
- https://raw.githubusercontent.com/electron/electron/v44.8.0/docs/tutorial/esm.md
- https://raw.githubusercontent.com/electron/electron/main/docs/tutorial/electron-timelines.md
- https://raw.githubusercontent.com/electron/electron/main/docs/breaking-changes.md
- https://github.com/electron/electron/pull/40047
- https://github.com/electron/electron/pull/52873
- https://github.com/electron/electron/issues/47671
- https://registry.npmjs.org/electron
- https://playwright.dev/docs/api/class-electron
- https://registry.npmjs.org/playwright
- https://registry.npmjs.org/@nestjs/core
- https://registry.npmjs.org/@nestjs/common
- https://registry.npmjs.org/@nestjs/platform-fastify
- https://registry.npmjs.org/@nestjs/testing
- https://registry.npmjs.org/@nestjs/cli
- https://registry.npmjs.org/@nestjs/swagger
- https://registry.npmjs.org/@nestjs/swagger/12.0.2
- https://github.com/nestjs/nest/releases/tag/v12.0.0
- https://github.com/nestjs/swagger/releases/tag/12.0.0
- https://github.com/nestjs/swagger/releases
- https://registry.npmjs.org/nestjs-zod
- https://registry.npmjs.org/@asteasolutions/zod-to-openapi
- https://registry.npmjs.org/zod-openapi
- https://registry.npmjs.org/zod
- https://raw.githubusercontent.com/colinhacks/zod/main/packages/docs/content/json-schema.mdx
- https://registry.npmjs.org/orval
- https://registry.npmjs.org/@orval/angular
- https://github.com/orval-labs/orval/releases
- https://raw.githubusercontent.com/orval-labs/orval/v8.43.0/docs/content/docs/guides/angular.mdx
- https://registry.npmjs.org/fastify
- https://registry.npmjs.org/typescript
- https://registry.npmjs.org/@angular/core
- https://registry.npmjs.org/@angular/compiler-cli/22.2.3
- https://registry.npmjs.org/kysely
- https://github.com/kysely-org/kysely/releases
- https://raw.githubusercontent.com/kysely-org/kysely/v0.29.6/src/dialect/sqlite/sqlite-dialect-config.ts
- https://registry.npmjs.org/-/v1/search?text=kysely%20node:sqlite&size=15
- https://registry.npmjs.org/kysely-generic-sqlite
- https://registry.npmjs.org/kysely-node-native-sqlite
- https://registry.npmjs.org/@pikku/kysely-node-sqlite
- https://raw.githubusercontent.com/better-auth/better-auth/main/packages/kysely-adapter/src/node-sqlite-dialect.ts
- https://raw.githubusercontent.com/better-auth/better-auth/main/packages/kysely-adapter/src/index.ts
- https://registry.npmjs.org/better-sqlite3
- https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0
- https://registry.npmjs.org/drizzle-orm
- https://registry.npmjs.org/pg
- https://registry.npmjs.org/testcontainers
- https://registry.npmjs.org/@testcontainers/rabbitmq
- https://raw.githubusercontent.com/testcontainers/testcontainers-node/v12.2.1/packages/modules/rabbitmq/src/rabbitmq-container.ts
- https://raw.githubusercontent.com/testcontainers/testcontainers-node/v12.2.1/packages/modules/rabbitmq/Dockerfile
- https://raw.githubusercontent.com/testcontainers/testcontainers-node/v12.2.1/docs/supported-container-runtimes.md
- https://raw.githubusercontent.com/actions/runner-images/main/images/windows/Windows2025-Readme.md
- https://raw.githubusercontent.com/actions/runner-images/main/images/macos/macos-15-Readme.md
- https://raw.githubusercontent.com/actions/runner-images/main/images/macos/macos-15-arm64-Readme.md
- https://github.com/actions/runner-images/issues/5948
- https://formulae.brew.sh/api/formula/rabbitmq.json
- https://hub.docker.com/v2/repositories/library/rabbitmq/tags
- https://hub.docker.com/v2/repositories/pivotalrabbitmq/rabbitmq/tags
- https://github.com/tauri-apps/tauri/releases
- https://raw.githubusercontent.com/tauri-apps/tauri/tauri-v3.0.0-alpha.5/crates/tauri-runtime-wry/Cargo.toml
- https://raw.githubusercontent.com/tauri-apps/tauri/tauri-v3.0.0-alpha.5/crates/tauri/Cargo.toml
- https://raw.githubusercontent.com/tauri-apps/tauri/tauri-v3.0.0-alpha.5/crates/tauri-runtime-cef/Cargo.toml
- https://crates.io/api/v1/crates/tauri-runtime-cef
- https://crates.io/api/v1/crates/wry
- https://github.com/tauri-apps/wry/issues/890
- https://github.com/tauri-apps/tauri/pull/14684
- https://github.com/tauri-apps/tauri/issues/16226
- https://github.com/Elanis/web-to-desktop-framework-comparison
- https://bun.com/docs/runtime/nodejs-compat
- https://bun.com/docs/bundler/executables
- https://github.com/oven-sh/bun/releases
- https://registry.npmjs.org/bun
- https://docs.deno.com/runtime/reference/cli/compile/
- https://github.com/denoland/deno/releases
- https://yao-pkg.github.io/pkg/architecture
- https://registry.npmjs.org/@yao-pkg/pkg
- https://registry.npmjs.org/postject

# Part 2: UI stack, distribution, signing and trademark

### Summary

Most UI-stack claims hold. Three corrections change the plan.

1. **PrimeNG is out entirely.** Since 22.0.0 (npm, 2026-07-15) PrimeNG ships under the proprietary "PrimeUI License": a licence key is required, it is compiled-only, it may not be redistributed "as a component library or development tool", and keys may not be published. The MIT line (21.x) declares Angular ^21 as a peer dependency, so it is no fallback for Angular 22.
2. **@nx/nest does not support NestJS 12.** Nx 23.3 (MIT) supports Angular 20–22, Vitest 3–5 and Playwright, and the module-boundaries lint rule is free. But @nx/nest 23.3.0 and 24.0.0-beta.2 declare @nestjs/core ">=10 <12", which excludes NestJS 12 (released 2026-08-27). Conformance and Owners require Nx Enterprise.
3. **Don't use ngx-monaco-editor-v2.** Version 22.0.5 still loads Monaco's AMD loader.js and pins monaco-editor ^0.56.0, which excludes 0.57. Use an own ESM wrapper around Monaco 0.57.

**Angular 22 claims are all confirmed** at the v22.2.3 tag:
- one major every 12 months (v23 around June 2027);
- TypeScript >=6.0 <6.1 (TS 7.0 "does not ship with an API");
- zoneless default since v21, OnPush default in v22;
- Signal Forms, resource and httpResource are @publicApi 22.0;
- @angular/aria left developer preview in 22.0.0;
- Vitest is the default CLI test runner.

**Other UI dependencies are permissively licensed:** Spartan 1.7.0, AG Grid Community 36.2 (the Enterprise-only feature list is confirmed), Cytoscape (WebGL preview limits confirmed), Foblex Flow, ngx-vflow, dagre 3.1.1, uPlot, ECharts 6, ngx-echarts, Transloco 8, @lucide/angular (ISC) and tinykeys 4.

**elkjs ("EPL-2.0 OR GPL-3.0-or-later") can ship in desktop binaries and Docker images under EPL-2.0** if it stays an unmodified separate file with the EPL text, a pointer to its source and a label. This matches ASF Category B and EPL FAQ 4.16–4.22.

**Signing claims are confirmed.**
- Apple costs $99/year; the fee waiver excludes individuals.
- Homebrew disabled casks failing Gatekeeper on 2026-09-01 and moved Intel Macs to Tier 3.
- Azure Artifact Signing costs $9.99/month, but individuals must be in the US or Canada.
- Microsoft Store registration is free, and Store-signed MSIX apps never show SmartScreen warnings. EV certificates no longer help.
- SignPath Foundation is free, but it requires a "verifiable reputation", GitHub-hosted runners, MFA and manual approval of every release. "SignPath Foundation" appears as the publisher. It refuses tools that "highlight exploitable vulnerabilities", which matters for the linting/advisor feature.
- For an EU individual the minimum is about $99/year (Apple). Windows goes through Store MSIX plus SignPath, or a Certum open-source certificate (€49–69).

**Trademark rules are confirmed.**
- Product names containing "RabbitMQ" or "RMQ" are prohibited.
- "<Name> for RabbitMQ" is the sanctioned pattern.
- Domains must not contain "RabbitMQ" or anything confusingly similar.
- The logos are reserved for Broadcom; attribute the mark with ®.
- Listing on rabbitmq.com is a pull request to rabbitmq-website's client-libraries/devtools.md.

### Verdicts

| ID | Verdict | Confidence | Verified statement |
| --- | --- | --- | --- |
| U1 | confirmed | high | **From primeng 22.0.0 the licence is proprietary.** 22.0.0 was published on npm on 2026-07-15 (RCs from 2026-06-28; latest is 22.1.2, 2026-09-29). It ships LICENSE.md "PrimeUI License", which says it is a "family of commercial UI libraries". It requires a licence key, is distributed compiled-only, and bans reverse-engineering and redistribution "as a component library or development tool". Letting third parties develop with it needs an OEM licence.  **A free Community tier exists but is not open source.** It covers organisations under US$1M revenue with fewer than 5 developers, fewer than 10 employees and under US$3M funding. LICENSE.md adds that individuals and non-commercial OSS projects "also qualify". Keys must be renewed every year and may not be published.  **There is no OSS programme.** primeui.dev says "PrimeUI does not include a separate open source program" and points OSS projects to the MIT versions (PrimeNG 21 and earlier).  **PrimeNG 21 is MIT but is no fallback.** The MIT terms apply to versions without the -lts suffix; the -lts builds were always commercial. 21.1.10 (2026-09-09) is MIT, but its peerDependencies require @angular/* ^21, so it cannot be used with Angular 22. |
| U2 | confirmed | high | All parts are correct.  **Release and support.** @angular/core 22.0.0 was published 2026-06-03. 22.x is Active until 2027-06, with LTS until 2028-06. From v22 Angular ships "A major release every 12 months" with 4–6 minor releases each; v23.0 is planned for "~ June 2027".  **TypeScript.** @angular/compiler-cli and @angular/build from 22.0.0 to 22.3.0-next.2 peer-depend on typescript ">=6.0 <6.1".  **TypeScript 7.** TS 7.0 (npm 7.0.2, 2026-07-08, now the npm `latest` tag) "does not ship with an API"; its package exports only `unstable/*` entry points. TS 7.1 is expected to bring a new API. `@typescript/typescript6` provides `tsc6` for side-by-side use.  **Change detection.** Zoneless has been the default since v21. In v22, components without a `changeDetection` setting are OnPush, and a migration adds `ChangeDetectionStrategy.Eager` to existing components.  **Stable APIs.** resource, rxResource, httpResource and Signal Forms are `@publicApi 22.0`; only the `experimentalWebMcpTool` option is still `@experimental`. @angular/aria's developer-preview tag was removed in 22.0.0.  **Testing.** `ng new` defaults `testRunner` to "vitest"; this was already the default in Angular CLI 21.0.0. |
| U3 | confirmed | high | **Versions and licence.** @spartan-ng/brain, cli and mcp 1.0.0 were published 2026-06-24. The latest is 1.7.0 (2026-10-14), with 1.8.0-beta.1 in pre-release. All are MIT.  **Built on CDK and Tailwind v4.** brain peer-depends on @angular/cdk >=21.0.0 <23.0.0 and tailwindcss >=4.0.0.  **Components.** libs/helm on main has 65 directories, about 63 of them components: command, context-menu, menubar, resizable, sidebar, sonner, table, kbd, scroll-area and others. libs/brain has 42.  **MCP server.** @spartan-ng/mcp (bin `spartan-mcp`) is an "MCP server exposing Spartan Angular UI documentation, components, and blocks".  **Licences of what the CLI adds.** All permissive: - @ng-icons/core: MIT - @ng-icons/lucide: ISC - tailwind-merge: MIT - tw-animate-css: MIT - class-variance-authority: Apache-2.0 - clsx: MIT - luxon: MIT |
| U4 | confirmed | high | **Licence and version.** ag-grid-community and ag-grid-angular 36.2.0 (2026-09-16) are MIT, as are their dependencies ag-stack 36.2.0 and ag-charts-types 14.2.0. ag-grid-enterprise is "Commercial".  **Enterprise-only modules.** Every feature listed in the claim is Enterprise-only: ContextMenu, ColumnMenu, Clipboard, CellSelection, SetFilter, MultiFilter, AdvancedFilter, RowGrouping, TreeData, MasterDetail, StatusBar, Find and ExcelExport. So are SideBar and tool panels, Pivot, SSRM, Row Numbers, Formulas, Batch Edit, Rich Select, PDF Export, Toolbar, AI Toolkit, Calculated Columns, editable header names and Notes.  **Community includes:** - DOM virtualisation; - RowSelection; - Text, Number, Date, BigInt, Quick, External and Custom filters; - CsvExport; - the infinite row model; - `applyTransactionAsync` (ClientSideRowModelApiModule).  **Building your own context menu.** Community keeps `suppressContextMenu`, `preventDefaultOnContextMenu` and `onCellContextMenu`.  **Angular support.** The compatibility table maps "Angular 20 - 22 → AG Grid 28 - 36+". AG Grid is "fully compatible with Zoneless". |
| U5 | confirmed | high | **Monaco.** - 0.53.0 (2025-09-08) "deprecates the AMD build", which is no longer supported. 0.57.0 still physically ships min/vs/loader.js. - 0.56.0 (2026-07-20) "Reorganizes the exported ESM modules to provide supported, tree-shakeable entry points" (monaco-editor/editor, features/*/register, languages/*/register). - 0.57.0 (2026-09-24) is npm latest. It is MIT and ships ThirdPartyNotices.txt.  **ngx-monaco-editor-v2.** 22.0.5 (2026-08-20) still injects `${baseUrl}/loader.js` and loads `vs/editor/editor.main` via `window.require`. Its peer `monaco-editor ^0.56.0` excludes 0.57.x. |
| U6 | confirmed | high | **Cytoscape.js WebGL.** The WebGL renderer is a preview introduced in 3.31.0 (2025-01-13), turned on with `renderer:{name:'canvas', webgl:true}`. Its options are "provisional and may change", and it uses webgl2. Current is 3.34.4 (2026-10-15, MIT). Limits: - "Only straight-line, haystack and bezier edges are supported"; - "Only solid colours ... no colour gradients"; - no dashed lines, overlays or underlays; - triangle arrows only; - a single centre edge label.  **elkjs 0.12.0** (2026-07-17) is "EPL-2.0 OR GPL-3.0-or-later": EPL-2.0 with GPL-3.0-or-later as the Exhibit A Secondary License. An Apache-2.0 project can distribute it unmodified in desktop binaries and Docker images by electing EPL-2.0, under these conditions: - ship the EPL-2.0 text and notices; - state where its Source Code can be obtained (EPL FAQ 4.17); - don't modify it; - keep it a separate module so our code is not a Modified Work (FAQ 4.22).  ASF policy lists EPL-2.0 in Category B: it may be included in binary form if it is "appropriately labelled". That policy is advisory for non-ASF projects.  **@dagrejs/dagre** 3.1.1 (2026-08-08) is MIT and maintained (3.0.0 in Mar 2026, 3.1.x in Aug 2026). Its dependency @dagrejs/graphlib 4.0.5 is MIT.  **@foblex/flow** 19.3.0 (2026-09-27) is MIT and active (pushed 2026-10-11, 7 open issues and PRs). It peer-depends on Angular >=17.3, and its @foblex/* dependencies are MIT.  **ngx-vflow** 2.7.0 (2026-09-03) is MIT and active (pushed 2026-10-15). It peer-depends on Angular >=19.2.17 and d3-drag/selection/zoom (ISC). |
| U7 | confirmed | high | All licences are as stated or permissive.  **uPlot** 1.6.32 is MIT. It has had no npm release since 2025-03-14, but the repo is active, with commits on 2026-10-16.  **ECharts** 6.1.0 (2026-05-19) is Apache-2.0. It ships a NOTICE file, and some source files embed d3 code under BSD-3-Clause (licenses/LICENSE-d3). Its dependency zrender 6.1.0 is BSD-3-Clause.  **ngx-echarts** 22.0.0 (2026-06-11) is MIT and peer-depends on Angular >=22 and echarts >=5. One maintainer releases once per Angular major; 148 issues and PRs are open.  **@jsverse/transloco** 8.4.0 (2026-06-13) is MIT, as are its dependencies @jsverse/utils and transloco-utils. The repo is active (pushed 2026-10-14).  **@lucide/angular** 1.58.0 (2026-10-16) is ISC; icons derived from Feather are MIT. It is the official, new package, first published as 1.0.0-beta.0 on 2026-03-19 and supporting Angular >=17. The legacy `lucide-angular` only supports Angular 13.x–21.x.  **tinykeys** 4.0.1 (2026-09-25) is MIT; 4.0.0 shipped 2026-05-20 and 6 issues are open. |
| U8 | nuanced | high | **Supported.** Nx 23.3.0 (2026-10-07) and all @nx/* plugins are MIT. - @nx/angular 23.3.0 peer-depends on @angular/build, @schematics/angular and ng-packagr ">= 20.0.0 < 23.0.0", so Angular 20–22 is supported. - Nx's Angular version matrix lists Angular ~22.1.0 → Nx >=23.2.0; 22.2 is not yet listed. - @nx/vitest supports vitest ^3, ^4 and ^5. - @nx/playwright supports @playwright/test ^1.36. - @nx/eslint supports ESLint 9 and 10.  **Not supported: NestJS 12.** @nx/nest 23.3.0, and even 24.0.0-beta.2 and the canaries, declares peer @nestjs/core and @nestjs/common ">=10.0.0 <12.0.0" and depends on @nestjs/schematics ^11. NestJS 12.0.0 was released 2026-08-27 (latest 12.1.3).  **Free.** The `@nx/enforce-module-boundaries` lint rule (ESLint or Oxlint, via @nx/eslint-plugin) is free and MIT.  **Nx Enterprise only.** The language-agnostic Conformance "Enforce Project Boundaries" rule and the Owners (CODEOWNERS) plugin require the Nx Enterprise plan; both were formerly Powerpack.  **Nx Cloud.** Managed remote cache, Nx Agents (distributed execution), Atomizer, flaky-task re-runs and self-healing CI are Nx Cloud features. The Hobby plan is free "forever" (50,000 credits/month, 5 contributors) and Team costs $29/month. A self-hosted remote cache built to Nx's published OpenAPI spec (`NX_SELF_HOSTED_REMOTE_CACHE_SERVER`) needs no licence. |
| U9 | confirmed | high | **SignPath Foundation (free).** Requirements: - an "OSI-approved Open Source license without commercial dual-licensing for all components"; - MFA for SignPath and repository access for all team members; - all workflow jobs on GitHub-hosted runners (for OSS); - manual approval for every release; - product name and version metadata enforced; - a "Code signing policy" section on the home and download pages crediting "Free code signing provided by SignPath.io, certificate by SignPath Foundation".  The certificate is issued to SignPath Foundation, "the publisher of the OSS project". There are also unclaimed conditions: - executables need "a certain verifiable reputation"; - the project must already be released; - a "No hacking tools" clause bars tools that "highlight exploitable vulnerabilities, e.g. by identifying unprotected network ports, missing password protection"; - a privacy clause covers data sent to systems the user did not specify.  **Azure Artifact Signing** (formerly Trusted Signing): - Basic: $9.99/month, 5,000 signatures/month. - Premium: $99.99/month, 100,000 signatures/month. - Overage: $0.005 per signature.  Public Trust certificates are available to organisations in the US, Canada, EU, UK, Australia, New Zealand, Japan, South Korea, Singapore, Switzerland, Norway and Israel. "Individual developers must be located in the United States or Canada." For individuals, the legal name and city/state/country appear on the certificate.  **Microsoft Store.** There are "no registration fees for either account type"; individuals verify with a government ID and a selfie. Store-distributed apps "are re-signed by Microsoft" and users "will never see a SmartScreen warning". This applies to MSIX ("Signed by the Store on submission"). MSI/EXE Store submissions must be signed by the developer with a CA certificate.  **EV certificates** "no longer bypass SmartScreen". On Windows 11, Smart App Control blocks unsigned files that lack reputation.  **Apple.** The Developer Program costs $99/year. The fee waiver requires a nonprofit, education or government entity and you must "Not be an individual, sole proprietor, or single-person business". Sequoia removed the Control-click Gatekeeper override.  **Homebrew.** - 5.0.0 (2025-11-12) announced: "We will disable all Homebrew/homebrew-cask casks that fail Gatekeeper checks in September 2026". - Casks now carry `disable! date: "2026-09-01", because: :fails_gatekeeper_check`. - 7.0.0 (2026-09-13) moved Intel macOS to Tier 3. - Homebrew stops running on Intel in Sept 2027.  **macOS 15 local network privacy.** Outgoing TCP to a local-network address requires permission, and apps should add NSLocalNetworkUsageDescription. Launchd daemons, root processes and command-line tools run from Terminal or SSH are exempt; VPN and routed traffic are not "local".  **Ubuntu 24.04 AppArmor.** Electron issue #42510 (SUID sandbox abort) is open, last updated 2026-08-25. electron-builder's fpm targets (deb, rpm and others) install an AppArmor profile in after-install; AppImage has no install hook. |
| C1 | nuanced | high | SignPath is free, but it is not available on day one. It also has constraints the corpus did not mention: - executables need "a certain verifiable reputation" and the project must already be released; - the "No hacking tools" clause bars "security diagnosis tools that actively scan for and highlight exploitable vulnerabilities, e.g. ... missing password protection", which could catch a broker linter that flags guest/default credentials or TLS-off listeners; - software that sends user data to systems the user did not specify must show a privacy policy at install time and offer an opt-out; - every release needs manual approval; - NSIS is not a supported nested container type, so the inner app exe and the installer need separate signing passes, or the project switches to MSI.  The Microsoft Store MSIX channel is a free, immediate alternative that avoids SmartScreen. |
| C2 | nuanced | high | The uPlot repo is active (commits on 2026-10-16), but the last npm release, 1.6.32, is from 2025-03-14, 19 months ago. Fixes reach npm slowly, so plan to pin and possibly vendor a git build behind the chart adapter. |
| C3 | nuanced | high | PrimeNG 21.x (non -lts) is MIT and still gets patches (21.1.10 on 2026-09-09). But it peer-depends on @angular/* ^21, so it is not a valid option with Angular 22. The MIT community fork Optimus UI (openng-org/optimus-ui, created 2026-06-29, 748 stars) exists but is too young to depend on. |
| C4 | confirmed | high | The disable was implemented. Hundreds of homebrew-cask casks (646 code-search hits) carry `disable! date: "2026-09-01", because: :fails_gatekeeper_check`. Acceptable-Casks requires that apps "pass Homebrew’s Gatekeeper checks", and the `--no-quarantine` flag is deprecated. The official cask therefore needs Developer ID signing and notarization. |

### Evidence

- **U1** (confirmed, high): https://cdn.jsdelivr.net/npm/primeng@22.1.2/LICENSE.md (identical in primeng@22.0.0/LICENSE.md):
- "This package is part of **PrimeUI**, a family of commercial UI libraries by PrimeTek Informatics."
- "A valid license key is required to use this software."
- "This software is distributed as a compiled package. You may not reverse-engineer, decompile, or extract its source code, redistribute it as a component library or development tool, or remove its license mechanisms. Redistributing the software so that third parties can develop with it requires a separate OEM License."
- Community tier: "Individuals, students, non-profits, and non-commercial open source projects also qualify."

https://primeui.dev/licenses/community:
- "PrimeUI does not include a separate open source program. Open source projects are welcome to use the MIT-licensed versions of our libraries (PrimeNG 21, PrimeVue 4, PrimeReact 10, and earlier)"
- "You may not, however, publicly publish or distribute your key"
- "Community Licenses are valid for 12 months"

https://registry.npmjs.org/primeng:
- 22.0.0 published 2026-07-15T21:54Z.
- 22.1.2 points to repository primefaces/primeng-nextchapter (GitHub API 404).
- 22.1.2 has the dependency "@primeui/license-manager": "^1.0.0".
- 21.1.10 has peer "@angular/core": "^21.0.7".

https://cdn.jsdelivr.net/npm/primeng@21.1.10/LICENSE.md:
- "## PRIMENG COMMUNITY VERSIONS LICENSE The MIT License (MIT)"
- "## PRIMENG LTS VERSIONS LICENSE (Versions with -lts suffix)" (a paid CLA).
- **U2** (confirmed, high): **angular/angular@v22.2.3** (https://raw.githubusercontent.com/angular/angular/v22.2.3/...):
- adev/src/content/reference/releases.md
  - L63-64: "A major release every 12 months / 4-6 minor releases for each major release"
  - L69: "Until Angular v22, Angular had a 6-month major release cycle"
  - L84: "v23.0 | ~ June 2027"
  - L101: "^22.0.0 | Active | 2026-06-03 | 2027-06 | 2028-06"
- CHANGELOG.md
  - L972: "# 22.0.0 (2026-06-03)"
  - L987: "TypeScript versions older than 6.0 are no longer supported."
  - L989: "Component with undefined `changeDetection` property are now `OnPush` by default."
  - L1105: "graduate signal forms APIs to public API"
- adev/src/content/guide/zoneless.md L14: "Zoneless is the default in Angular v21+"
- `@publicApi 22.0` annotations:
  - packages/core/src/resource/api.ts L77
  - packages/common/http/src/resource.ts L45
  - packages/core/rxjs-interop/src/rx_resource.ts L28
  - packages/forms/signals/src/api/structure.ts L49

**angular/components@v22.2.3** CHANGELOG.md L431: "remove developer preview tag from aria (#33232)", in the 22.0.0 section.

**angular/angular-cli@v22.2.3** packages/schematics/angular/ng-new/schema.json L111-116: `"testRunner": {... "enum": ["vitest","karma"], "default": "vitest"}`. The same default is in the 21.0.0 tag.

**npm registry:**
- https://registry.npmjs.org/@angular/compiler-cli/22.2.3: peer `"typescript":">=6.0 <6.1"`; the same for 22.0.0 and 22.3.0-next.2.
- https://registry.npmjs.org/typescript: 7.0.2 published 2026-07-08; exports `".":"./lib/version.cjs"` plus `./unstable/*`.

**TypeScript 7 announcement** https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/ (2026-07-08): "While TypeScript 7.0 is here, it does not ship with an API. We expect TypeScript 7.1 to ship with a new (and different) API"; "specialized type-checking within templates like Angular will also likely not use TypeScript 7."
- **U3** (confirmed, high): **npm registry:**
- https://registry.npmjs.org/@spartan-ng/brain: "1.0.0" 2026-06-24T00:22:14Z; latest 1.7.0 2026-10-14T21:08:50Z; license MIT; peer `{"tailwindcss":">=4.0.0","@angular/cdk":">=21.0.0 <23.0.0",...}`.
- https://registry.npmjs.org/@spartan-ng/mcp/1.7.0: description as quoted above; `"bin":{"spartan-mcp":"src/server.js"}`; license MIT.

**GitHub:**
- API repos/spartan-ng/spartan: license MIT, 2,951 stars, pushed 2026-10-16.
- contents/libs/helm: 65 directories.
- https://raw.githubusercontent.com/spartan-ng/spartan/main/libs/cli/src/generators/base/versions.ts: NG_ICONS_VERSION '^32.2.0', TAILWIND_MERGE_VERSION '^3.5.0'.
- **U4** (confirmed, high): **AG Grid docs** (the HTML pages return 403 to scripts; the .md variants are served):
- https://www.ag-grid.com/angular-data-grid/modules.md module table, e.g.:
  - "| [Context Menu] | `ContextMenuModule` | Enterprise |"
  - "| [Clipboard] | `ClipboardModule` | Enterprise |"
  - "| [Cell Selection] | `CellSelectionModule` | Enterprise |"
  - "| [Find] | `FindModule` | Enterprise |"
  - "| [CSV Export] | `CsvExportModule` |  |"
  - "| [Quick Filter] | `QuickFilterModule` |  |"
- https://www.ag-grid.com/angular-data-grid/compatibility.md:
  - "| 20 - 22 | 28 - 36+ |"
  - "AG Grid is fully compatible with Zoneless Angular applications with no additional configuration"
  - TypeScript: "36+ | >= 5.8.3"
- https://www.ag-grid.com/angular-data-grid/community-vs-enterprise.md: "AG Grid Community is available under the MIT licence and AG Grid Enterprise requires a commercial, EULA licence".

**ag-grid-community@36.2.0 typings and licence** (https://cdn.jsdelivr.net/npm/ag-grid-community@36.2.0/...):
- dist/types/src/clientSideRowModel/clientSideRowModelApi.d.ts declares `applyTransactionAsync`.
- dist/types/src/entities/gridOptions.d.ts: L66 `suppressContextMenu`, L72 `preventDefaultOnContextMenu`, L2711 `onCellContextMenu`.
- LICENSE.txt: "The MIT License".

**npm:** ag-grid-angular 36.2.0 peer `@angular/core >= 20.0.0`.
- **U5** (confirmed, high): **Monaco changelog** https://raw.githubusercontent.com/microsoft/monaco-editor/main/CHANGELOG.md:
- [0.53.0]: "This release deprecates the AMD build ... we don't offer support for it anymore. Please migrate to the ESM build."
- [0.56.0] Breaking Changes: "Reorganizes the exported ESM modules to provide supported, tree-shakeable entry points (#5155)".

**npm** https://registry.npmjs.org/monaco-editor:
- 0.53.0 published 2025-09-08
- 0.56.0 published 2026-07-20
- 0.57.0 published 2026-09-24 (latest)

**Monaco 0.57.0 file listing** https://data.jsdelivr.com/v1/packages/npm/monaco-editor@0.57.0?structure=flat: /min/vs/loader.js is present.

**ngx-monaco-editor-v2:**
- https://cdn.jsdelivr.net/npm/ngx-monaco-editor-v2@22.0.5/fesm2022/ngx-monaco-editor-v2.mjs
  - L53-58: `usedRequire.config(requireConfig); usedRequire([`vs/editor/editor.main`]`
  - L73: `loaderScript.src = `${baseUrl}/loader.js``
- The same code is in master base-editor.ts L76-100: https://raw.githubusercontent.com/miki995/ngx-monaco-editor-v2/master/projects/editor/src/lib/base-editor.ts
- https://registry.npmjs.org/ngx-monaco-editor-v2: peer `"monaco-editor":"^0.56.0"`.
- **U6** (confirmed, high): **Cytoscape.js:**
- https://blog.js.cytoscape.org/2025/01/13/webgl-preview/:
  - "Version 3.31 of Cytoscape.js contains a preview of a new WebGL renderer"
  - "Only straight-line, haystack and bezier edges are supported"
  - "Only solid colours are supported, no colour gradients"
  - "Any options or API being introduced are provisional"
- npm cytoscape 3.31.0 published 2025-01-13.
- https://raw.githubusercontent.com/cytoscape/cytoscape.js/unstable/src/extensions/renderer/canvas/index.mjs: L38 `CANVAS_TYPES = [ '2d', '2d', '2d', 'webgl2' ]`, L52 `if( options.webgl ){`.

**elkjs:**
- https://cdn.jsdelivr.net/npm/elkjs@0.12.0/package.json: `"license": "EPL-2.0 OR GPL-3.0-or-later"`.
- LICENSE.md Exhibit A: "Secondary Licenses ... GNU General Public License v3.0 or later".
- lib/elk.bundled.js header: "SPDX-License-Identifier: EPL-2.0 OR GPL-3.0-or-later".

**ASF third-party policy** https://www.apache.org/legal/resolved.html:
- "You may include software under the following licenses in binary form within an Apache product if you label the inclusion appropriately ... Eclipse Public License 2.0: EPL 2.0"
- "Any Category B licensed works may be included in binary-only form in Apache Software Foundation convenience binaries. Do not include Category B licensed works in source releases."

**Eclipse EPL-2.0 FAQ** (https://www.eclipse.org/legal/epl-2.0/faq/; content at https://www.eclipse.org/legal/documents/html/epl-2.0-faq.html):
- 4.16: "You may compile a Program licensed under the EPL without modification and commercially license the result in accordance with the terms of the EPL."
- 4.17: "you do need to include a statement indicating where the source code is available"
- 4.18: "The object code for the product may be distributed under a single license as long as it references the EPL portion and complies, for that portion, with the terms of the EPL."
- 4.22: a module added to the Program need not be EPL "as long as the module is not a Modified Work of the Program"
- 4.5: "if you have modified EPL-2.0 licensed source code and you distribute that code or binaries built from that code ... you must make the source code available"

**dagre, Foblex Flow, ngx-vflow:**
- npm @dagrejs/dagre: 3.0.0 2026-03-22, 3.1.0 2026-08-02, 3.1.1 2026-08-08, MIT.
- GitHub API: Foblex/f-flow MIT, 539 stars; artem-mangilev/ngx-vflow MIT, 487 stars.
- npm @foblex/flow 19.3.0 MIT; ngx-vflow 2.7.0 MIT.
- **U7** (confirmed, high): **npm registry** (https://registry.npmjs.org/<pkg>):
- uplot: 1.6.32 published 2025-03-14, MIT.
- echarts: 6.1.0 published 2026-05-19, Apache-2.0, deps zrender 6.1.0 and tslib 2.3.0.
- ngx-echarts: 22.0.0, peer `@angular/core >=22.0.0`.
- @jsverse/transloco: 8.4.0, MIT.
- @lucide/angular: 1.58.0, ISC; 1.0.0-beta.0 published 2026-03-19.
- lucide-angular: peer "13.x - 21.x".
- tinykeys: 4.0.1, MIT.

**Licence files:**
- https://cdn.jsdelivr.net/npm/echarts@6.1.0/NOTICE: "Apache ECharts Copyright 2017-2026 The Apache Software Foundation".
- https://cdn.jsdelivr.net/npm/echarts@6.1.0/LICENSE: "BSD 3-Clause (d3.js): The following files embed d3.js".
- https://raw.githubusercontent.com/lucide-icons/lucide/main/LICENSE: ISC, plus "The MIT License (MIT) (for the icons listed above)" for the Feather-derived icons.

**GitHub API:**
- leeoniya/uPlot pushed 2026-10-16; the commits endpoint shows a 2026-10-16 commit.
- xieziyu/ngx-echarts pushed 2026-06-11, 148 open.
- jsverse/transloco pushed 2026-10-14.
- jamiebuilds/tinykeys MIT, 6 open.
- **U8** (nuanced, high): **npm registry:**
- https://registry.npmjs.org/@nx/nest/23.3.0: peer `"@nestjs/core":">=10.0.0 <12.0.0"`; the same peer in 24.0.0-beta.2 (2026-10-14); dependency `@nestjs/schematics "^11.0.0"`.
- https://registry.npmjs.org/@nestjs/core: 12.0.0 published 2026-08-27, latest 12.1.3.
- https://registry.npmjs.org/@nx/angular/23.3.0: peer `"@angular/build":">= 20.0.0 < 23.0.0"`.
- @nx/vitest peer `"vitest":"^3.0.0 || ^4.0.0 || ^5.0.0"`; @nx/playwright peer `"@playwright/test":"^1.36.0"`; nx 23.3.0 is MIT.

**GitHub API:** repos/nrwl/nx license MIT.

**Nx docs:**
- https://nx.dev/docs/technologies/angular/guides/angular-nx-version-matrix: "~22.1.0 | latest | >=23.2.0".
- https://nx.dev/docs/features/enforce-module-boundaries: "Language-Agnostic Conformance ... use the Conformance plugin's Enforce Project Boundaries rule ... Requires Nx Enterprise plan".
- https://nx.dev/docs/enterprise/owners: "This plugin provides Nx Enterprise plan users the ability to configure and maintain code owners".
- https://nx.dev/docs/guides/tasks--caching/self-hosted-caching: "build your own self-hosted server using the OpenAPI specification"; "If you previously used Nx Powerpack for conformance rules or code ownership, those features are now part of Nx Enterprise".
- https://nx.dev/pricing: Hobby "Free forever ... 50,000 credits (resets monthly) 5 complimentary contributors"; Team $29/month.
- **U9** (confirmed, high): **SignPath:**
- https://signpath.org/terms:
  - "The project must use an OSI-approved Open Source license without commercial dual-licensing for all components."
  - "The code signing certificate is issued to SignPath Foundation. This means that SignPath Foundation is the publisher of the OSS project."
  - "All team members must use multi-factor authentication for both SignPath and source code repository access"
  - "“Free code signing provided by SignPath.io, certificate by SignPath Foundation”"
  - "Every release needs manual approval for signing."
  - "For executable programs ... we require a certain verifiable reputation."
  - "No hacking tools ... This includes security diagnosis tools that actively scan for and highlight exploitable vulnerabilities, e.g. by identifying unprotected network ports, missing password protection etc."
- https://docs.signpath.io/trusted-build-systems/github: "For OSS projects: All jobs of the GitHub worfklow leading up to the signing request were executed on GitHub-hosted agents".
- https://docs.signpath.io/artifact-configuration/reference: supported containers are pe, msi, cab, appx, nupkg, jar, zip and directory; NSIS is not listed.

**Azure Artifact Signing:**
- https://azure.microsoft.com/en-us/pricing/details/artifact-signing/ (data-amount attributes): Basic 9.99, Premium 99.99, quota "5,000" and "100,000", overage 0.005.
- https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart: "Public Trust certificates are available to organizations in the United States, Canada, the European Union, the United Kingdom, Australia, New Zealand, Japan, South Korea, Singapore, Switzerland, Norway, and Israel. Individual developers must be located in the United States or Canada."

**Microsoft Store and SmartScreen:**
- https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/open-a-developer-account: "there are no registration fees for either account type"; "Begin identity verification with a government-issued ID and selfie."
- https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation:
  - "Store-distributed apps are signed by a Microsoft certificate and are never subject to SmartScreen download warnings"
  - "EV certificates no longer bypass SmartScreen."
  - "Cost — Starts at $9.99/month"
  - "it can take several weeks and hundreds of clean installs"
  - "Smart App Control will block execution of unsigned files unless the file has a positive reputation"
- https://learn.microsoft.com/en-us/windows/msix/package/signing-package-overview: "Signed by the Store on submission".
- https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-package-requirements: "The binary and all of its Portable Executable (PE) files must be digitally signed with a code signing certificate that chains up to a certificate issued by a Certificate Authority"; "MSIX benefits include: Free Microsoft code signing and CDN hosting."

**Apple:**
- https://developer.apple.com/programs/: "$99 annual membership".
- https://developer.apple.com/support/membership-fee-waiver/: "Not be an individual, sole proprietor, or single-person business".
- https://developer.apple.com/news/?id=saqachfa: "users will no longer be able to Control-click to override Gatekeeper".

**Homebrew:**
- https://brew.sh/2025/11/12/homebrew-5.0.0/ (quoted above).
- https://brew.sh/2026/06/11/homebrew-6.0.0/: "remain on track to be disabled in September 2026".
- https://brew.sh/2026/09/13/homebrew-7.0.0/: "Intel Macs moving to Tier 3".
- https://raw.githubusercontent.com/Homebrew/homebrew-cask/HEAD/Casks/x/xld.rb L16: `disable! date: "2026-09-01", because: :fails_gatekeeper_check`. GitHub code search finds 646 casks.
- https://docs.brew.sh/Acceptable-Casks: "must pass Homebrew’s Gatekeeper checks".

**macOS local network privacy:** TN3179 https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy:
- "Making an outgoing TCP connection | yes"
- "If your app accesses the local network, add the NSLocalNetworkUsageDescription property to its Info.plist"
- "Command-line tools run from Terminal or over SSH" are automatically allowed
- macOS 15 introduced the feature

**Ubuntu AppArmor:**
- https://github.com/electron/electron/issues/42510: open, updated 2026-08-25.
- electron-builder templates/linux/after-install.tpl L29 "# Install apparmor profile. (Ubuntu 24+)" and L52 `apparmor_parser --replace`.
- src/targets/linux/FpmTarget.ts L190 "Install AppArmor support for ubuntu 24+".
- **U10** (confirmed, high): **Trademark guidelines** https://www.rabbitmq.com/trademark-guidelines, source https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/src/pages/trademark-guidelines.md (last changed 2026-01-02, copyright-year bump only):
- L95-98: "if you are developing a Foobar tool for RabbitMQ, acceptable project titles would be “Foobar for RabbitMQ""
- L103-106: "RabbitMQ-powered Foobar Product" and "to use a name such as “RabbitMQ Foobar.”" is likely "a trademark problem"
- L154: "Use of the logos is reserved solely for use by Broadcom in its unaltered form."
- L165-172 (Entity Names): "You may not form a company, use a company name, or create a software product name that includes the “RabbitMQ” trademark ... suggested you use terms such as ‘<product name> for RabbitMQ’ or ‘<product name>, RabbitMQ Edition."
- L196-199 (Domain Names): "You must not use RabbitMQ or any confusingly similar phrase in a domain name. For instance `www.rabbitmqhost.com` is not allowed."
- L209: "or create any mascot for the project"
- L214-223 (Variations): "* RMQ * MyRabbitMQ * RabbitMQ Messaging * RabbitMQ Guru"
- L239-243 (Combination Marks): "Foobar RabbitMQ"
- L245-249 (Web Tags)
- L251-256: "(i.e., ®) should appear at least with the first use ... "RabbitMQ is a trademark of Broadcom, Inc. in the U.S. and other countries.""

**Developer tools page** https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/client-libraries/devtools.md:
- L30: "Please [contact us](/contact) with suggestions"

**Listing PRs:**
- https://github.com/rabbitmq/rabbitmq-website/pull/2662 (merged_by michaelklishin).
- Follow-up commit "Developer Tools: small edits ... Avoid benchmarketing claims such as "high performance"."
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/CONTRIBUTING.md: PR process; contributor agreement "if needed" for non-trivial changes.
- **C1** (nuanced, high): https://signpath.org/terms:
- "For executable programs that may be downloaded and executed based on our signature, we require a certain verifiable reputation."
- "The project must already be released in the form that should be signed."
- the "No hacking tools" clause (quoted above)
- "Software that collects user data and transfers it to systems not specified by the user must a) describe this behavior in a privacy policy, b) display this policy during installation and c) include installation options to disable these functions."

https://docs.signpath.io/artifact-configuration/reference: supported container types.

https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation: Store re-signing.
- **C2** (nuanced, high): - https://registry.npmjs.org/uplot: latest 1.6.32, published 2025-03-14T; earlier 1.6.31 on 2024-09-28.
- GitHub API repos/leeoniya/uPlot/commits: newest commit 2026-10-16T06:26:47Z ("wip4").
- **C3** (nuanced, high): - https://registry.npmjs.org/primeng/21.1.10 peerDependencies: `{"@angular/cdk":"^21.0.0","@angular/core":"^21.0.7",...}`.
- https://cdn.jsdelivr.net/npm/primeng@21.1.10/LICENSE.md: "PRIMENG COMMUNITY VERSIONS LICENSE The MIT License".
- GitHub API repos/openng-org/optimus-ui: LICENSE.md is MIT ("Copyright (c) 2026 OpenNG / Copyright (c) 2016-2026 PrimeTek").
- **C4** (confirmed, high): - https://raw.githubusercontent.com/Homebrew/homebrew-cask/HEAD/Casks/x/xld.rb L16 and Casks/p/pb.rb L10: `disable! date: "2026-09-01", because: :fails_gatekeeper_check`.
- https://docs.brew.sh/Acceptable-Casks.
- https://brew.sh/2025/11/12/homebrew-5.0.0/: "--no-quarantine and --quarantine flags have been deprecated".

### Report

# UI stack, distribution/signing and trademark: verification report (as of 2026-10-16)

**Method.** Sources were npm registry JSON, GitHub (raw files at exact tags and the API via an authenticated `gh api` GET), official documentation and the licence texts. Anything not verified is labelled. All line numbers refer to the file at the tag given.

---

### 1. Verdicts at a glance

| ID | Verdict | One-line correction or precision |
| --- | --- | --- |
| U1 PrimeNG licence | **confirmed** | Proprietary "PrimeUI License" from 22.0.0 (npm 2026-07-15). The MIT line (21.x) peer-depends on Angular **^21 only**, so it is not a fallback for Angular 22. |
| U2 Angular 22 facts | **confirmed** | All parts verified at angular/angular `v22.2.3`. TS 7.0 "does not ship with an API". |
| U3 Spartan/ui | **confirmed** | 1.0.0 on 2026-06-24, 1.7.0 on 2026-10-14, MIT, CDK and Tailwind v4 peers, about 63 helm components, `@spartan-ng/mcp`. |
| U4 AG Grid Community 36 | **confirmed** | Feature split and Angular 20-22/zoneless support verified from AG Grid's own docs. |
| U5 Monaco / ngx-monaco-editor-v2 | **confirmed** | ngx-monaco-editor-v2 also pins `monaco-editor ^0.56.0`, which excludes 0.57. |
| U6 Graph libraries + elkjs EPL | **confirmed** | elkjs is distributable under EPL-2.0 if unmodified, kept separate, labelled and shipped with a source pointer. |
| U7 Charts, i18n, icons, keys | **confirmed** | Licences OK. uPlot has had no npm release since 2025-03-14. @lucide/angular is ISC, plus MIT for icons derived from Feather. |
| U8 Nx 23 | **nuanced** | `@nx/nest` (23.3.0 and even 24.0.0-beta.2) peer-depends on `@nestjs/core >=10 <12`, so **NestJS 12 is not supported**. Conformance and Owners need Nx Enterprise. |
| U9 Signing and distribution | **confirmed** | Store re-signing applies to **MSIX**. SignPath also requires a "verifiable reputation" and has a "No hacking tools" clause. |
| U10 Trademark and listing | **confirmed** | "Rabbit"-prefixed names and rabbit imagery are not explicitly regulated (grey area). Listing is a PR to `client-libraries/devtools.md`. |

---

### 2. Claim-by-claim evidence

### U1. PrimeNG licence change

**The licence file in v22 is proprietary.** `primeng@22.1.2/LICENSE.md` ([jsDelivr](https://cdn.jsdelivr.net/npm/primeng@22.1.2/LICENSE.md)) is identical in 22.0.0. It says:
- "This package is part of **PrimeUI**, a family of commercial UI libraries by PrimeTek Informatics."
- "A valid license key is required to use this software."
- "This software is distributed as a compiled package. You may not reverse-engineer … redistribute it as a component library or development tool, or remove its license mechanisms. Redistributing the software so that third parties can develop with it requires a separate OEM License."

**The free Community tier has eligibility limits.** It is open to organisations with less than $1M revenue, fewer than 5 developers, fewer than 10 employees and less than $3M funding. The licence adds that "Individuals, students, non-profits, and non-commercial open source projects also qualify."

**The Community licence is still not open source** ([primeui.dev/licenses/community](https://primeui.dev/licenses/community)):
- "PrimeUI does not include a separate open source program. Open source projects are welcome to use the MIT-licensed versions … (PrimeNG 21, PrimeVue 4, PrimeReact 10, and earlier)".
- Keys are "valid for 12 months".
- "You may not, however, publicly publish or distribute your key". That is fatal for a public repo and its CI.

**npm metadata** ([registry](https://registry.npmjs.org/primeng)):
- 22.0.0-rc.1 was published 2026-06-28, 22.0.0 on 2026-07-15 and 22.1.2 on 2026-09-29.
- 22.1.2 depends on `@primeui/license-manager`.
- Its repository `primefaces/primeng-nextchapter` returns 404, so it is not public.

**PrimeNG 21 is MIT, with two caveats.** `primeng@21.1.10/LICENSE.md` reads "PRIMENG COMMUNITY VERSIONS LICENSE: MIT". However:
- **`-lts` versions** fall under a separate paid licence.
- 21.1.10 peer-depends on `@angular/core ^21.0.7`, so it is **incompatible with Angular 22**.

**Verdict.** Ban `primeng@>=22` and `@primeui/*`. PrimeNG 21 is not a viable fallback either.

### U2. Angular 22

**Release and support** (`adev/src/content/reference/releases.md@v22.2.3`):
- L63-64: "A major release every 12 months / 4-6 minor releases for each major release".
- L69: "Until Angular v22, Angular had a 6-month major release cycle".
- L84: "v23.0 | ~ June 2027".
- L101: "^22.0.0 | Active | 2026-06-03 | 2027-06 | 2028-06".
- [Source file](https://raw.githubusercontent.com/angular/angular/v22.2.3/adev/src/content/reference/releases.md).

**TypeScript:**
- `@angular/compiler-cli` 22.0.0, 22.2.3 and 22.3.0-next.2, and `@angular/build` 22.2.3, all declare peer `typescript ">=6.0 <6.1"` ([npm](https://registry.npmjs.org/@angular/compiler-cli/22.2.3)).
- CHANGELOG L987: "TypeScript versions older than 6.0 are no longer supported."
- TypeScript 7.0 shipped as npm 7.0.2 on 2026-07-08 and is now `latest`. Its package exports only `./unstable/*` APIs.
- The blog post ([TS 7.0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)) says: "While TypeScript 7.0 is here, it does not ship with an API. We expect TypeScript 7.1 to ship with a new (and different) API". It adds that Angular template type-checking "will also likely not use TypeScript 7".
- `@typescript/typescript6` (bin `tsc6`) allows side-by-side use.

**Zoneless.** `guide/zoneless.md` L14: "Zoneless is the default in Angular v21+".

**OnPush.** CHANGELOG@v22.2.3 L989: "Component with undefined `changeDetection` property are now `OnPush` by default." A migration adds `ChangeDetectionStrategy.Eager`.

**Stable APIs:**
- `@publicApi 22.0` appears in `packages/core/src/resource/api.ts` (L77 and following), `packages/common/http/src/resource.ts` (L45), `rx_resource.ts` (L28) and `forms/signals/src/api/structure.ts` (L49).
- CHANGELOG L1105: "graduate signal forms APIs to public API".
- The `experimentalWebMcpTool` option stays `@experimental`.

**@angular/aria.** angular/components CHANGELOG@v22.2.3 L431, in the 22.0.0 section: "remove developer preview tag from aria (#33232)".

**Vitest.** Angular CLI `ng-new/schema.json@v22.2.3` L111-116 sets `"testRunner"` to default `"vitest"` (enum vitest or karma). It was already the default at 21.0.0 ([schema](https://raw.githubusercontent.com/angular/angular-cli/v22.2.3/packages/schematics/angular/ng-new/schema.json)).

### U3. Spartan/ui

- `@spartan-ng/brain`, `cli` and `mcp` 1.0.0 were published 2026-06-24T00:22Z. The latest is **1.7.0** (2026-10-14), with 1.8.0-beta.1 in pre-release. All are MIT ([npm](https://registry.npmjs.org/@spartan-ng/brain)).
- brain peer dependencies: `@angular/cdk >=21.0.0 <23.0.0`, `tailwindcss >=4.0.0`, `tw-animate-css`, `clsx` and `luxon`.
- The repo ([GitHub](https://github.com/spartan-ng/spartan)) is MIT with 2,951 stars and 94 open issues and PRs. `libs/helm` has 65 directories (about 63 components, including command, context-menu, menubar, resizable, sidebar, sonner, table, kbd and scroll-area). `libs/brain` has 42.
- The MCP server `@spartan-ng/mcp` 1.7.0 (bin `spartan-mcp`) is described as an "MCP server exposing Spartan Angular UI documentation, components, and blocks as AI-consumable tools".
- What the CLI adds ([versions.ts](https://raw.githubusercontent.com/spartan-ng/spartan/main/libs/cli/src/generators/base/versions.ts)):
  - `@ng-icons/*` ^32.2.0 (core is MIT, the lucide set is ISC);
  - `tailwind-merge` (MIT);
  - `class-variance-authority` (Apache-2.0).

### U4. AG Grid Community 36

**Versions and licences:**
- `ag-grid-community` and `ag-grid-angular` are at 36.2.0 (2026-09-16) and MIT. `ag-grid-angular` peer-depends on `@angular/core >= 20.0.0`.
- The dependencies `ag-stack` 36.2.0 and `ag-charts-types` 14.2.0 are MIT.
- `ag-grid-enterprise` is licensed "Commercial".

**Module split** ([modules.md](https://www.ag-grid.com/angular-data-grid/modules.md); the HTML pages return 403 to scripts):

| Tier | Modules |
| --- | --- |
| Enterprise | ContextMenu, ColumnMenu, Clipboard, CellSelection, SetFilter, MultiFilter, AdvancedFilter, RowGrouping, TreeData, MasterDetail, StatusBar, Find, ExcelExport, SideBar/ToolPanels, Pivot, SSRM, RowNumbers, Formulas, BatchEdit, RichSelect, PdfExport, Toolbar, AiToolkit, CalculatedColumns, ColumnHeaderEdit, Notes |
| Community | RowSelection, Text/Number/Date/BigInt/Quick/External/Custom filters, CsvExport, Pagination, PinnedRow, RowAutoHeight, CellSpan, UndoRedoEdit, GridState, the infinite row model, `applyTransactionAsync` |

`applyTransactionAsync` is declared in `dist/types/src/clientSideRowModel/clientSideRowModelApi.d.ts`.

**Angular and zoneless.** [compatibility.md](https://www.ag-grid.com/angular-data-grid/compatibility.md): "| 20 - 22 | 28 - 36+ |"; "fully compatible with Zoneless … with no additional configuration"; minimum TypeScript for 36+ is "5.8.3".

**Building your own context menu.** `gridOptions.d.ts` defines L66 `suppressContextMenu`, L72 `preventDefaultOnContextMenu` and L2711 `onCellContextMenu`.

### U5. Monaco

**Monaco releases** ([CHANGELOG](https://raw.githubusercontent.com/microsoft/monaco-editor/main/CHANGELOG.md)):
- **0.53.0** (2025-09-08): "This release deprecates the AMD build … we don't offer support for it anymore." The AMD build is still physically shipped: `min/vs/loader.js` exists in 0.57.0 ([listing](https://data.jsdelivr.com/v1/packages/npm/monaco-editor@0.57.0?structure=flat)).
- **0.56.0** (2026-07-20): "Reorganizes the exported ESM modules to provide supported, tree-shakeable entry points (#5155)". These are `monaco-editor/editor`, `features/<f>/register` and `languages/definitions/<l>/register`.
- **0.57.0** (2026-09-24) is `latest`. It is MIT and ships `ThirdPartyNotices.txt`, which covers MIT, Apache-2.0, Unicode, W3C and CC-BY-4.0 items.

**ngx-monaco-editor-v2 22.0.5** (2026-08-20) is still AMD-based. The published `fesm2022/ngx-monaco-editor-v2.mjs` loads it at L53-58 (`usedRequire([`vs/editor/editor.main`])`) and L73 (`loaderScript.src = `${baseUrl}/loader.js``). Its peer `monaco-editor ^0.56.0` excludes 0.57.

### U6. Graph and layout libraries

**Cytoscape.js:**
- The WebGL renderer has been a preview since 3.31.0 (2025-01-13) ([blog](https://blog.js.cytoscape.org/2025/01/13/webgl-preview/)).
- Enable it with `renderer:{name:'canvas', webgl:true}`. The options "are provisional and may change".
- It needs WebGL2 (`CANVAS_TYPES … 'webgl2'` in `src/extensions/renderer/canvas/index.mjs`).
- Limits:
  - "Only straight-line, haystack and bezier edges";
  - "Only solid colours … no colour gradients";
  - no dashed lines, overlays or underlays;
  - triangle arrows only;
  - one centre edge label.
- Current release is 3.34.4 (2026-10-15), MIT.

**elkjs 0.12.0** (2026-07-17):
- `package.json`: `"license": "EPL-2.0 OR GPL-3.0-or-later"`.
- `LICENSE.md` is the EPL-2.0 text, with Exhibit A naming GPL-3.0-or-later as the Secondary License.
- Bundle headers say "SPDX-License-Identifier: EPL-2.0 OR GPL-3.0-or-later".
- Section 3 has the full distribution analysis.

**@dagrejs/dagre** 3.1.1 (2026-08-08) is MIT. It released 3.0.0 in Mar 2026 and 3.1.0/3.1.1 in Aug 2026. Its dependency `@dagrejs/graphlib` 4.0.5 is MIT. The unscoped `dagre` 0.8.5 dates from 2019.

**Foblex Flow** `@foblex/flow` 19.3.0 (2026-09-27):
- MIT, as are its `@foblex/2d`, `utils`, `mediator` and `platform` dependencies.
- Peer-depends on Angular >=17.3.
- Repo pushed 2026-10-11, 539 stars, 7 open issues and PRs.
- Ships `AI.md`.

**ngx-vflow** 2.7.0 (2026-09-03):
- MIT.
- Peer-depends on Angular >=19.2.17 and d3-drag/selection/zoom (ISC).
- Repo pushed 2026-10-15, 487 stars.

### U7. Charts, i18n, icons and shortcuts

| Package | Latest (date) | Licence | Maintenance note |
| --- | --- | --- | --- |
| uplot | 1.6.32 (2025-03-14) | MIT | Repo active (commits on 2026-10-16) but **no npm release for 19 months** |
| echarts / zrender | 6.1.0 (2026-05-19) / 6.1.0 | Apache-2.0 (+NOTICE; d3-derived files BSD-3-Clause) / BSD-3-Clause | ASF project, 67.5k stars |
| ngx-echarts | 22.0.0 (2026-06-11) | MIT | Releases per Angular major; one maintainer; 148 open |
| @jsverse/transloco | 8.4.0 (2026-06-13) | MIT (deps `@jsverse/utils`, `transloco-utils` MIT) | Repo active |
| @lucide/angular | 1.58.0 (2026-10-16) | ISC + MIT for Feather-derived icons | New official package (beta 2026-03-19); legacy `lucide-angular` supports Angular 13–21 only |
| tinykeys | 4.0.1 (2026-09-25) | MIT | 4.0.0 on 2026-05-20; 6 open |

Sources: [npm](https://registry.npmjs.org/), the [ECharts NOTICE](https://cdn.jsdelivr.net/npm/echarts@6.1.0/NOTICE) and the [Lucide LICENSE](https://raw.githubusercontent.com/lucide-icons/lucide/main/LICENSE).

### U8. Nx 23

**Supported:**
- `nx` and all `@nx/*` 23.3.0 (2026-10-07) are MIT.
- `@nx/angular` peers are `>= 20.0.0 < 23.0.0`. Nx's [version matrix](https://nx.dev/docs/technologies/angular/guides/angular-nx-version-matrix) lists Angular ~22.1 → Nx >=23.2; 22.2 is not listed yet.
- `@nx/vitest` supports vitest ^3, ^4 and ^5.
- `@nx/playwright` supports ^1.36.
- `@nx/eslint` supports ESLint ^9 and ^10.

**Gap:** `@nx/nest` 23.3.0, 24.0.0-beta.2 and the canaries all declare peer `@nestjs/core >=10.0.0 <12.0.0` and depend on `@nestjs/schematics ^11`. NestJS 12.0.0 was released 2026-08-27 ([npm](https://registry.npmjs.org/@nestjs/core)).

**Free:** the `@nx/enforce-module-boundaries` lint rule.

**Enterprise:** Conformance ("Requires Nx Enterprise plan", [doc](https://nx.dev/docs/features/enforce-module-boundaries)) and Owners ([doc](https://nx.dev/docs/enterprise/owners)).

**Nx Cloud:** managed cache, Agents, Atomizer and self-healing CI. Hobby is free (50k credits/month, 5 contributors); Team costs $29/month ([pricing](https://nx.dev/pricing)).

**Self-hosted cache:** implementing the OpenAPI spec and setting `NX_SELF_HOSTED_REMOTE_CACHE_SERVER` needs no licence ([doc](https://nx.dev/docs/guides/tasks--caching/self-hosted-caching)).

### U9. Signing and distribution

All sub-claims are confirmed; details are in section 4.
- Microsoft Store re-signing applies to MSIX ("Signed by the Store on submission"). MSI and EXE submissions need a CA-issued signature ([MSI/EXE requirements](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-package-requirements)).
- Several SignPath constraints were missing from the claim; see C1 in the verdicts.

### U10. Trademark

Confirmed; details are in section 5.

---

### 3. Can an Apache-2.0 project ship elkjs (EPL-2.0 OR GPL-3.0-or-later)?

**Yes, under EPL-2.0, as an unmodified separate component.** The basis:
- **Eclipse EPL-2.0 FAQ** ([faq](https://www.eclipse.org/legal/epl-2.0/faq/), content at [this URL](https://www.eclipse.org/legal/documents/html/epl-2.0-faq.html)):
  - 4.16: one may "compile a Program licensed under the EPL without modification and commercially license the result in accordance with the terms of the EPL".
  - 4.17: source need not be bundled, "But you do need to include a statement indicating where the source code is available".
  - 4.18: the product "may be distributed under a single license as long as it references the EPL portion and complies, for that portion, with the terms of the EPL".
  - 4.22: an added module need not be EPL "as long as the module is not a Modified Work".
  - 4.5: modifications must be released as source under EPL-2.0.
- **ASF third-party policy** ([resolved.html](https://www.apache.org/legal/resolved.html)): EPL-2.0 is **Category B**. "You may include software under the following licenses in binary form within an Apache product if you label the inclusion appropriately". "Any Category B licensed works may be included in binary-only form … Do not include Category B licensed works in source releases." This is advisory for a non-ASF project, but it is a good benchmark.

**Compliance checklist** (desktop installers, Docker images and npm tarballs alike):
1. Elect EPL-2.0. Record "elkjs 0.12.0: EPL-2.0 (elected from EPL-2.0 OR GPL-3.0-or-later)" in THIRD_PARTY_NOTICES. Never rely on the GPL branch.
2. Ship elkjs's `LICENSE.md` (the EPL-2.0 text) and keep its copyright headers.
3. Add a source-availability statement: https://github.com/kieler/elkjs (tag 0.12.0) and https://github.com/eclipse/elk.
4. Do not modify elkjs, and do not let the bundler inline or re-minify it into our chunks. Copy `lib/elk-worker.min.js` (or `elk.bundled.js`) verbatim as an asset and start it with `new Worker(url)`. This keeps a clean module boundary under FAQ 4.22.
5. Label it prominently in the README, the About dialog and the licence screen (ASF "appropriately labelled").
6. Depend on it through npm; don't vendor its source into the repo.
7. MIT fallback: `@dagrejs/dagre` 3.1.1 covers simple layered layouts.

---

### 4. Licence compatibility of the proposed UI dependencies under Apache-2.0

ALLOW means compatible with notice retention only. COND means allowed with extra conditions. BAN means do not use.

| Dependency (role) | Version (date) | Licence | Verdict | Obligations and notes |
| --- | --- | --- | --- | --- |
| @angular/* incl. build, cli | 22.2.3 (2026-10-14) | MIT | ALLOW | Keep notices |
| @angular/cdk, @angular/aria | 22.2.3 | MIT | ALLOW | — |
| @spartan-ng/brain, cli, mcp | 1.7.0 (2026-10-14) | MIT | ALLOW | Helm code is **copied into our repo**: keep Spartan's MIT notice with it |
| tailwindcss / tailwind-merge / tw-animate-css / clsx | 4.3.3 / 3.7.0 / 1.4.0 / 2.1.1 | MIT | ALLOW | — |
| class-variance-authority | 0.7.1 | Apache-2.0 | ALLOW | Ships no NOTICE file |
| @ng-icons/core / @ng-icons/lucide | 36.1.0 | MIT / ISC | ALLOW | — |
| ngx-sonner | 3.1.0 (2025-03-28) | MIT | ALLOW | Low release activity |
| @ngrx/signals | 22.0.1 | MIT | ALLOW | — |
| ag-grid-community, ag-grid-angular (+ag-stack, ag-charts-types) | 36.2.0 (2026-09-16) | MIT | ALLOW | Keep behind an adapter |
| ag-grid-enterprise | 36.2.0 | Commercial EULA | **BAN** | Shows a watermark and console error without a key |
| @tanstack/angular-table / angular-virtual | 9.3.1 / 6.1.7 | MIT | ALLOW | — |
| cytoscape | 3.34.4 | MIT | ALLOW | WebGL mode is provisional |
| **elkjs** | 0.12.0 (2026-07-17) | EPL-2.0 OR GPL-3.0-or-later | **COND** | See section 3 |
| @dagrejs/dagre + @dagrejs/graphlib | 3.1.1 / 4.0.5 | MIT | ALLOW | — |
| @foblex/flow (+@foblex/*) | 19.3.0 | MIT | ALLOW | — |
| ngx-vflow (+d3-drag/selection/zoom) | 2.7.0 | MIT (+ISC) | ALLOW | — |
| monaco-editor | 0.57.0 | MIT + ThirdPartyNotices (MIT, Apache-2.0, Unicode, W3C, CC-BY-4.0 items) | ALLOW | Ship `ThirdPartyNotices.txt` |
| ngx-monaco-editor-v2 | 22.0.5 | MIT | ALLOW (licence) / **AVOID** (technical) | AMD loader; peer ^0.56.0 |
| uplot | 1.6.32 | MIT | ALLOW | No npm release since 2025-03 |
| echarts + zrender | 6.1.0 | Apache-2.0 + BSD-3-Clause | ALLOW | Reproduce ECharts NOTICE; carry `licenses/LICENSE-d3` |
| ngx-echarts | 22.0.0 | MIT | ALLOW | — |
| @jsverse/transloco (+utils) | 8.4.0 | MIT | ALLOW | — |
| @lucide/angular | 1.58.0 | ISC (+MIT for Feather-derived icons) | ALLOW | Ship both notices |
| tinykeys | 4.0.1 | MIT | ALLOW | — |
| @xterm/xterm | 6.0.0 | MIT | ALLOW | — |
| ngx-markdown / marked | 22.1.1 / 18.1.1 | MIT | ALLOW | — |
| dompurify | 3.4.17 | MPL-2.0 OR Apache-2.0 | ALLOW | Elect Apache-2.0 |
| rxjs / tslib / luxon | 7.8.2 / 2.8.1 / 3.7.2 | Apache-2.0 / 0BSD / MIT | ALLOW | — |
| angular-split | 20.0.0 (2025-07-21) | Apache-2.0 | ALLOW | Peer-depends on Angular >=19 |
| @vscode/codicons (only if used directly) | 0.0.46-24 | CC-BY-4.0 | COND | Attribution; ASF treats CC-BY as "label … only in binary form" |
| electron | 44.8.0 | MIT + Chromium third-party licences | ALLOW | Ship `LICENSE.electron.txt` and `LICENSES.chromium.html`. electron-builder **>=26.16.1** keeps them in the macOS .app ([#9407](https://github.com/electron-userland/electron-builder/issues/9407)) |
| primeng >=22 / @primeui/* | 22.1.2 | PrimeUI proprietary | **BAN** | Licence key; no redistribution as a development tool |
| primeng 21.x | 21.1.10 | MIT (non -lts) | **BAN** (technical) | Peer-depends on Angular ^21 |
| apexcharts | 8.3.1 | Community licence (<$2M) / commercial; OEM licence needed to embed in a product | **BAN** | [LICENSE.md](https://cdn.jsdelivr.net/npm/apexcharts@8.3.1/LICENSE.md) |

**CI allow-list:** MIT, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, Apache-2.0, "MPL-2.0 OR Apache-2.0".

**Named exceptions:** elkjs (EPL-2.0), and CC-BY-4.0 for assets only.

**Generate one THIRD_PARTY_NOTICES per artefact** (web bundle, desktop app, container image, npm CLI).

---

### 5. Distribution and signing plan for an individual maintainer

**Assumptions:**
- One natural person, resident in an **EU member state** (for example Portugal), with no company.
- Public GitHub repo, and the smallest budget possible.
- Electron for Windows, macOS and Linux, plus `npx`, a container image and a Helm chart.

### 5.1 Facts the plan relies on

**Apple Developer Program:**
- $99/year ([Apple](https://developer.apple.com/programs/)).
- The fee waiver requires an organisation and you must "Not be an individual, sole proprietor, or single-person business" ([waiver](https://developer.apple.com/support/membership-fee-waiver/)).
- On Sequoia users can no longer "Control-click to override Gatekeeper" ([Apple](https://developer.apple.com/news/?id=saqachfa)).

**Homebrew:**
- Since **2026-09-01**, casks that fail Gatekeeper carry `disable! … :fails_gatekeeper_check`. Example: [xld.rb](https://raw.githubusercontent.com/Homebrew/homebrew-cask/HEAD/Casks/x/xld.rb); the 5.0.0 notice is [here](https://brew.sh/2025/11/12/homebrew-5.0.0/).
- Intel macOS moved to Tier 3 in 7.0.0 ([7.0.0](https://brew.sh/2026/09/13/homebrew-7.0.0/)).
- Homebrew stops running on Intel in September 2027.

**Microsoft:**
- Store registration: "no registration fees for either account type". Individuals verify with a government ID and a selfie ([Partner Center](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/open-a-developer-account)).
- Store apps "are re-signed by Microsoft … Users will never see a SmartScreen warning" ([SmartScreen doc](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)). This applies to MSIX; MSI and EXE submissions need your own CA signature.
- "EV certificates no longer bypass SmartScreen". Reputation "can take several weeks and hundreds of clean installs". Smart App Control blocks unsigned files that have no reputation.

**Azure Artifact Signing** ([pricing](https://azure.microsoft.com/en-us/pricing/details/artifact-signing/), [quickstart](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)):
- Price: Basic $9.99/month (5,000 signatures); Premium $99.99/month (100,000); overage $0.005 per signature.
- Public Trust organisations: US, CA, EU, UK, AU, NZ, JP, KR, SG, CH, NO, IL.
- "Individual developers must be located in the United States or Canada." Your legal name and city/state/country appear on the certificate.

**SignPath Foundation** ([terms](https://signpath.org/terms)):
- Free, for an OSI licence with no commercial dual-licensing.
- Requires MFA, GitHub-hosted runners ([doc](https://docs.signpath.io/trusted-build-systems/github)) and manual approval of every release.
- Product name and version metadata must be set.
- Publish a "Code signing policy" with the credit line and team roles, plus a privacy statement.
- The certificate names **SignPath Foundation** as publisher.
- Executables need a **"verifiable reputation"**, and the project must already be released.
- The **"No hacking tools"** clause applies.
- Deep signing does not cover NSIS ([container types](https://docs.signpath.io/artifact-configuration/reference)).

**Certum "Open Source Code Signing"** (alternative for individuals):
- €49 in the cloud ("SimplySign") or €69 for a card-and-reader set ([cloud](https://shop.certum.eu/open-source-code-signing-on-simplysign.html), [set](https://shop.certum.eu/open-source-code-signing.html)).
- The certificate carries "natural person data prefixed with 'Open Source Developer'".
- Validity, renewal price and CI automation are **unverified**.

**macOS local network privacy** (TN3179, macOS 15+):
- Outgoing TCP to a local-network address needs permission.
- Add `NSLocalNetworkUsageDescription`.
- CLI tools run from Terminal are exempt ([TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)).

**Linux:**
- The Electron SUID-sandbox issue on Ubuntu 24.04+ is still open ([#42510](https://github.com/electron/electron/issues/42510)).
- electron-builder's fpm targets (deb, rpm) install an AppArmor profile in `after-install.tpl` L29-52 ([template](https://raw.githubusercontent.com/electron-userland/electron-builder/master/packages/app-builder-lib/templates/linux/after-install.tpl)); AppImage cannot.

**Free infrastructure:**
- GitHub Actions on standard runners for public repos ([billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)).
- GitHub Packages (GHCR) for public packages ([billing](https://docs.github.com/en/billing/concepts/product-billing/github-packages)).
- npm trusted publishing over OIDC with provenance ([npm](https://docs.npmjs.com/trusted-publishers)).
- Immutable GitHub Releases ([docs](https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/immutable-releases)).

### 5.2 Plan

**Stage A: first public releases**

1. **macOS (signed from day one).**
   - Enrol in the Apple Developer Program as an individual ($99/year; the Developer ID shows your legal name).
   - Use Hardened Runtime and notarise on GitHub macOS runners. Ship arm64 and x64 DMG plus zip, which electron-updater needs.
   - Add `NSLocalNetworkUsageDescription` through `mac.extendInfo`.
   - Publish an own Homebrew tap first. Submit to homebrew-cask later; it requires notability and a Gatekeeper pass.
2. **Windows.**
   - (a) Publish an **MSIX to the Microsoft Store** (free and Store-signed, so no SmartScreen warnings) as the recommended Windows channel. The Store handles updates.
   - (b) Also ship an **unsigned NSIS installer and zip**, labelled "preview", on GitHub Releases for users who avoid the Store. Document the SmartScreen and Smart App Control behaviour.
   - Releasing these builds is also a SignPath prerequisite ("already released").
3. **Linux.**
   - deb and rpm (x64 and arm64) are the primary formats, with the AppArmor profile.
   - AppImage is secondary, with the Ubuntu 24.04 sandbox caveat documented.
   - Publish `SHA256SUMS`, GitHub artifact attestations and immutable releases.
4. **Server and web.**
   - npm CLI for `npx` with trusted publishing and provenance.
   - GHCR multi-arch image signed with cosign keyless, plus SBOM and provenance.
   - Helm chart as an OCI artifact on GHCR.

**Stage B: once there is visible reputation** (several releases, downloads, stars)

5. **Apply to SignPath Foundation.**
   - Prerequisites: MFA everywhere, GitHub-hosted runners, branch protection and PR reviews, a code-signing-policy page with "Free code signing provided by SignPath.io, certificate by SignPath Foundation", team roles, and a privacy statement.
   - Pipeline: sign the app directory or `.exe` first, then build the NSIS installer, then sign the installer. That is two signing requests per release, each needing manual approval; switching to MSI avoids the second pass.
   - Then regenerate `latest.yml` and the blockmap so electron-updater hashes match.
6. **If SignPath declines** (reputation, or the hacking-tools clause), or "SignPath Foundation" as publisher is unacceptable:
   - Buy a **Certum Open Source** certificate (€49 cloud / €69 card; renewal unverified). It is issued in your own name, and reputation still has to accrue.
   - Or form a **legal entity in an eligible country** (the EU qualifies) and use **Azure Artifact Signing** at $9.99/month, which integrates directly with electron-builder.

**Stage C: wider channels**

7. winget-pkgs manifest pointing at the signed installer.
8. Flathub (offline build from source) and the Snap Store.
9. The official Homebrew cask.

### 5.3 Cost table (per year)

| Item | EU individual (assumed) | US/Canada individual | Notes |
| --- | --- | --- | --- |
| Apple Developer Program | $99 | $99 | Mandatory for macOS |
| Windows: Microsoft Store (MSIX) | $0 | $0 | ID and selfie check |
| Windows: SignPath Foundation | $0 | $0 | Needs reputation; publisher "SignPath Foundation" |
| Windows: Azure Artifact Signing | Not eligible as an individual ($119.88/yr only via an eligible-country organisation) | $119.88 (Basic, $9.99/month) | Legal name and city on the certificate |
| Windows: Certum OSS certificate (fallback) | €49–69 | €49–69 | Renewal and CI automation unverified |
| CI, GHCR, npm, GitHub Releases | $0 | $0 | Public repo, standard runners |
| **Year-1 minimum** | **$99** (+ domain) | **$99–219** (+ domain) | Domain cost not verified |

Country variants:
- Individuals elsewhere (e.g. Brazil, India) cannot get Azure Public Trust, even as an organisation. They should rely on SignPath, the Store or Certum.

---

### 6. Trademark-safe naming rules

Source: [trademark guidelines](https://www.rabbitmq.com/trademark-guidelines), file `src/pages/trademark-guidelines.md`, line numbers as cited.

**Rules**
1. No "RabbitMQ" inside the product, company, binary, npm, Docker, Helm or GitHub org name. Entity Names (L165-172): "You may not … create a software product name that includes the “RabbitMQ” trademark".
2. No variations or abbreviations: "RMQ", "MyRabbitMQ", "RabbitMQ Messaging" and "RabbitMQ Guru" are named as "not acceptable" (L214-223). No combination marks like "Foobar RabbitMQ" (L239-243).
3. Use the sanctioned descriptor: "Foobar for RabbitMQ" (L95-98), or "<product name> for RabbitMQ" / "<product name>, RabbitMQ Edition" (L170-171).
4. Domains: "You must not use RabbitMQ or any confusingly similar phrase in a domain name" (L196-199). This includes subdomains. URL paths such as `/docs/rabbitmq` are fine.
5. No RabbitMQ logo anywhere, including the app's connection dialogs: "reserved solely for use by Broadcom" (L154). No mascot (L209). Avoid rabbit silhouettes or orange "ear" shapes, which risk confusion with the logo.
6. "Rabbit"-prefixed names and rabbit imagery are not explicitly regulated, but are high-risk under "variation/takeoff" and "confusingly similar". The namespace is also crowded with RabbitMQ ecosystem projects: Rabbit Viz, Bunny (Ruby client), Hutch, lapin (Rust client), pika, Thumper and Warren. Avoid it.
7. Attribution: use ® on first use, plus "RabbitMQ® is a trademark of Broadcom, Inc. in the U.S. and other countries." (L251-256). Add a non-affiliation line: "<Name> is an independent open-source project, not affiliated with or endorsed by Broadcom."
8. Make no endorsement or "official" claims (L225-229). No "enterprise-class RabbitMQ"-style quality claims (Class or Quality section).
9. SEO: do not put the mark in titles or metatags "to influence search engine rankings" (L245-249). Use it descriptively and sparingly.
10. Before committing to a name, clear it on USPTO, EUIPO and WIPO, npm, GitHub, app stores and domains.

**Example name patterns**

| Pattern | Status | Why |
| --- | --- | --- |
| `<Coined>` + tagline "open-source workbench for RabbitMQ®" | Allowed | Nominative use |
| `<Coined> for RabbitMQ` | Allowed | L95-98, L170 |
| `<Coined>, RabbitMQ Edition` | Allowed | Suggested at L170-171 |
| `<Coined> Studio` / `<Coined> Console` (no mark) | Allowed | No mark used |
| Domain `<coined>.dev` with docs path `/rabbitmq` | Allowed | The mark is not in the domain name |
| npm `@<coined>/cli`, image `ghcr.io/<coined>/<coined>`, Helm chart `<coined>`, keyword `rabbitmq` | Allowed | Descriptive keyword only |
| `RabbitMQ Studio`, `RabbitMQ Workbench`, `RabbitMQ Manager` | Forbidden | Product name includes the mark |
| `<Coined> RabbitMQ`, `RabbitMQ <Coined>` | Forbidden | Combination mark (L239-243, L106) |
| `RMQ Studio`, `RMQ Commander`, `MyRabbitMQ`, `RabbitMQ Guru` | Forbidden | Listed variations (L220-223) |
| Domains `rabbitmq-<x>.dev`, `<x>-rabbitmq.io`, `rabbit-mq.tools`, `rabbitmqhost.com` | Forbidden | Domain rule (L196-199) |
| `RabbitMQ-powered <Coined>` | Forbidden for us | Reserved for noncommercial redistribution of RabbitMQ bits (L100-106) |
| `Rabbit<Anything>`, `Bunny…`, `Warren…`, rabbit logo or mascot | High risk; avoid | Takeoff, confusion and collisions |

**Getting listed on rabbitmq.com**
1. Open a PR against [rabbitmq/rabbitmq-website](https://github.com/rabbitmq/rabbitmq-website) editing `client-libraries/devtools.md`. Use the "Management Tools" or "Visualisation" section; the current entries are at L224-227.
2. Write one factual line: `[Name](url), a … for RabbitMQ`.
3. Precedents:
   - Warren came in via [PR #2662](https://github.com/rabbitmq/rabbitmq-website/pull/2662).
   - Both were merged by michaelklishin within about a day.
4. Expect the wording to be trimmed. The follow-up commit says "Avoid benchmarketing claims such as 'high performance'".
5. A contributor agreement applies only "if needed" for non-trivial changes ([CONTRIBUTING](https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/CONTRIBUTING.md)).

---

### 7. Corrections to the prior corpus

- **@nx/nest vs NestJS 12.** The corpus recommends Nx with "first-party plugins … Nest" alongside NestJS 12. @nx/nest's peer range excludes 12, so drive the engine with `@nx/js`/`@nx/node` or plain targets. *(U8)*
- **SignPath.** Better described as "best free option *once reputable*". It also has the hacking-tools and privacy clauses and the NSIS deep-signing gap. *(C1)*
- **uPlot.** "Repo active" is true, but npm releases are stale. *(C2)*
- **PrimeNG 21.** Not usable with Angular 22. *(C3)*
- **electron-builder licence files.** New finding: electron-builder before 26.16.1 dropped `LICENSE.electron.txt` and `LICENSES.chromium.html` from macOS `.app` bundles ([release](https://github.com/electron-userland/electron-builder/releases/tag/electron-builder@26.16.1)). Pin >=26.16.1.

### Design implications

- **Licence gate in CI.** Add a dependency-licence gate to CI with this allow-list: MIT, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, Apache-2.0, and 'MPL-2.0 OR Apache-2.0' (elect Apache). Named exceptions: elkjs (EPL-2.0) and CC-BY-4.0 for assets only. Hard-ban primeng>=22, @primeui/*, ag-grid-enterprise and apexcharts with a lint rule plus a lockfile check.
- **Notices per artefact.** Generate a THIRD_PARTY_NOTICES file for each artefact: web bundle, Electron app, container image and npm CLI. It must include:
- the ECharts NOTICE and LICENSE-d3;
- Monaco's ThirdPartyNotices.txt;
- Lucide ISC plus Feather MIT;
- Spartan's MIT notice for the copied helm code;
- Electron's LICENSE and LICENSES.chromium.html.

Pin electron-builder >=26.16.1 so the macOS .app keeps the Electron and Chromium licence files.
- **elkjs packaging.** Ship elkjs unmodified as a separate asset (lib/elk-worker.min.js) loaded in a Web Worker; never bundle or re-minify it into our chunks. Elect EPL-2.0, ship its LICENSE.md, and add a source pointer (kieler/elkjs at tag 0.12.0, eclipse/elk) to the About and licence screens. Keep @dagrejs/dagre (MIT) as a drop-in layered-layout fallback.
- **Monaco wrapper.** Use our own thin ESM wrapper around monaco-editor 0.57 (the 0.56+ tree-shakeable entry points, workers via `new Worker(new URL(...))`). Do not adopt ngx-monaco-editor-v2: it is AMD-based and its peer range pins 0.56.x.
- **AG Grid Community.** Keep it behind an internal grid adapter. Build our own context menu (via suppressContextMenu/onCellContextMenu plus CDK/Aria menus), clipboard handling, column chooser and status bar. Keep CSV export, Quick/Text/Number/Date filters and applyTransactionAsync batching; these are all Community.
- **Cytoscape WebGL.** Feature-detect WebGL2. In WebGL mode, restrict edge styles to straight, haystack or bezier with solid colours and centre labels only, and fall back to canvas otherwise. Treat the WebGL options as provisional and keep them behind the graph adapter.
- **Angular toolchain.** Pin TypeScript 6.0.x across the whole monorepo; Angular 22 requires >=6.0 <6.1. TS 7 may be used only as an optional, fast `tsc --noEmit` check on Node-only libraries. Use Vitest, the CLI default.
- **Nx setup.** Use @nx/angular, @nx/vitest, @nx/playwright and @nx/eslint-plugin; the module-boundaries rule is free. Do not depend on @nx/nest while it caps NestJS below 12. Build and serve the NestJS 12 engine with @nx/js/@nx/node or run-commands targets. Avoid Conformance and Owners (Nx Enterprise). For remote cache, use Nx Cloud Hobby or a self-hosted server implementing Nx's OpenAPI spec.
- **macOS signing.** Budget $99/year for Apple from day one. Notarise every macOS build, because unsigned apps can't be Control-click-opened on Sequoia, Homebrew disables casks that fail Gatekeeper, and auto-update requires signing. Start with an own Homebrew tap.
- **Windows channels.** Treat the Microsoft Store MSIX as the first-class Windows channel: free, Store-signed and free of SmartScreen warnings. Keep the NSIS/zip builds on GitHub Releases, and add SignPath signing once the project has reputation. Design the release pipeline so external signing runs before update metadata is generated: sign the app exe, build NSIS, sign the installer, then regenerate latest.yml and the blockmap.
- **SignPath 'No hacking tools' clause.** Frame the linting/upgrade advisor as configuration hygiene for brokers the user has explicitly connected to with credentials. Avoid network or port scanning, subnet broker discovery, and features that hunt for unprotected brokers or missing passwords. Confirm with SignPath before applying.
- **Privacy and telemetry.** Ship no telemetry by default. Any data sent to systems the user did not configure needs a privacy policy shown during installation and an opt-out (SignPath condition). AI/MCP features must talk only to endpoints the user configures.
- **macOS local network permission.** Add NSLocalNetworkUsageDescription (electron-builder `mac.extendInfo`). Detect denied local-network access from the engine utilityProcess and show actionable guidance. Note that npx/CLI mode run from Terminal is exempt and loopback/Docker port-forwarding is unaffected.
- **Linux packaging.** Make deb and rpm (x64 and arm64) the primary formats, with electron-builder's AppArmor profile. Ship AppImage as secondary with a documented Ubuntu 24.04 sandbox caveat, and never default to --no-sandbox.
- **Naming and branding.** Pick a coined, non-rabbit brand and use 'for RabbitMQ' as the descriptor. Keep 'rabbitmq' and 'RMQ' out of every identifier: product, domain, npm scope/package, Docker image, Helm chart, GitHub org/repo and binary. Use no RabbitMQ logo in the UI (text label or neutral broker icon). Add ® on first use, plus the Broadcom attribution and a non-affiliation line in the README, the About dialog and the site footer.
- **Discovery.** Once a public release exists, submit a one-line, factual PR to rabbitmq-website client-libraries/devtools.md with no performance or marketing claims.

### Open questions

- **SignPath acceptance.** What 'verifiable reputation' threshold does SignPath apply to a new Electron app? Would a broker linter that flags guest/default credentials, TLS-off listeners or an exposed management UI fall under its 'No hacking tools' clause? Ask SignPath before building the pipeline.
- **electron-builder with SignPath.** Signing happens outside the build: inner exe, then NSIS, then the installer, with two approvals per release, or switch to MSI. latest.yml and blockmap must be regenerated, and differential updates must keep working. Needs a prototype on GitHub-hosted Windows runners.
- **MSIX packaging of the Electron app.** Does it work with the utilityProcess engine and its loopback HTTP/WebSocket server (full-trust)? How do Store-managed updates coexist with electron-updater builds of the same app (separate app identities)?
- **Certum Open Source certificate.** Validity period, renewal price, and whether SimplySign cloud signing can be automated headlessly on GitHub-hosted runners. How quickly does SmartScreen reputation accrue for a personal 'Open Source Developer' certificate?
- **Bundling elkjs.** Would letting the bundler inline or minify elkjs into application chunks create an EPL-2.0 'Modified Work'? Get legal review, or simply enforce the separate-asset rule.
- **Trademark clearance.** Run USPTO, EUIPO and WIPO searches for candidate names. Broadcom's view of 'Rabbit'-prefixed names or rabbit imagery is unknown: the guidelines are silent listing is not a permission. An email to rabbitmq-core@groups.vmware.com could settle it.
- **@nx/nest timeline.** When will @nx/nest raise its peer range to NestJS 12? Do Nx's Node/webpack/esbuild executors handle NestJS 12's ESM packages? Spike before committing to the layout.
- **Nx and Angular 22.2.** Nx's version matrix stops at Angular ~22.1 (Nx 23.3). Verify that `nx migrate` and the generators behave with Angular 22.2.x.
- **uPlot and ngx-echarts maintenance.** uPlot has had no npm release since 2025-03-14, and ngx-echarts has a single maintainer. Decide whether to pin a git commit or fork behind the chart adapter.
- **Cytoscape WebGL in practice.** Test the provisional WebGL renderer on Linux GPU blocklists, VMs and remote desktops where WebGL2 may be unavailable, and in Electron 44.
- **macOS local network prompt.** Confirm that it is attributed to the app for connections made from an Electron utilityProcess, and how the denial path appears (connection stays pending vs fails).
- **Azure Artifact Signing eligibility.** The country list may change. If the maintainer forms a company in the EU, confirm the identity-validation lead time (1-20 business days per the docs) and any business-history requirement, which was not found in the docs.

### Sources

- https://cdn.jsdelivr.net/npm/primeng@22.1.2/LICENSE.md
- https://cdn.jsdelivr.net/npm/primeng@22.0.0/LICENSE.md
- https://cdn.jsdelivr.net/npm/primeng@21.1.10/LICENSE.md
- https://primeui.dev/licenses/community
- https://registry.npmjs.org/primeng
- https://registry.npmjs.org/primeng/22.1.2
- https://registry.npmjs.org/primeng/21.1.10
- https://api.github.com/repos/primefaces/primeng
- https://github.com/openng-org/optimus-ui
- https://registry.npmjs.org/@angular/core
- https://registry.npmjs.org/@angular/compiler-cli/22.2.3
- https://registry.npmjs.org/@angular/build/22.2.3
- https://registry.npmjs.org/@angular/aria
- https://registry.npmjs.org/typescript
- https://registry.npmjs.org/typescript/7.0.2
- https://registry.npmjs.org/@typescript/typescript6
- https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/
- https://raw.githubusercontent.com/angular/angular/v22.2.3/adev/src/content/reference/releases.md
- https://raw.githubusercontent.com/angular/angular/v22.2.3/CHANGELOG.md
- https://raw.githubusercontent.com/angular/angular/v22.2.3/adev/src/content/guide/zoneless.md
- https://raw.githubusercontent.com/angular/angular/v22.2.3/packages/core/src/resource/api.ts
- https://raw.githubusercontent.com/angular/angular/v22.2.3/packages/common/http/src/resource.ts
- https://raw.githubusercontent.com/angular/angular/v22.2.3/packages/core/rxjs-interop/src/rx_resource.ts
- https://raw.githubusercontent.com/angular/angular/v22.2.3/packages/forms/signals/src/api/structure.ts
- https://raw.githubusercontent.com/angular/components/v22.2.3/CHANGELOG.md
- https://raw.githubusercontent.com/angular/angular-cli/v22.2.3/packages/schematics/angular/ng-new/schema.json
- https://raw.githubusercontent.com/angular/angular-cli/21.0.0/packages/schematics/angular/ng-new/schema.json
- https://registry.npmjs.org/@spartan-ng/brain
- https://registry.npmjs.org/@spartan-ng/cli
- https://registry.npmjs.org/@spartan-ng/mcp
- https://github.com/spartan-ng/spartan
- https://raw.githubusercontent.com/spartan-ng/spartan/main/libs/cli/src/generators/base/versions.ts
- https://registry.npmjs.org/ag-grid-community
- https://registry.npmjs.org/ag-grid-angular
- https://registry.npmjs.org/ag-grid-enterprise
- https://registry.npmjs.org/ag-stack
- https://www.ag-grid.com/angular-data-grid/community-vs-enterprise.md
- https://www.ag-grid.com/angular-data-grid/modules.md
- https://www.ag-grid.com/angular-data-grid/compatibility.md
- https://www.ag-grid.com/angular-data-grid/infinite-scrolling.md
- https://www.ag-grid.com/angular-data-grid/data-update-high-frequency.md
- https://cdn.jsdelivr.net/npm/ag-grid-community@36.2.0/LICENSE.txt
- https://cdn.jsdelivr.net/npm/ag-grid-community@36.2.0/dist/types/src/clientSideRowModel/clientSideRowModelApi.d.ts
- https://cdn.jsdelivr.net/npm/ag-grid-community@36.2.0/dist/types/src/entities/gridOptions.d.ts
- https://registry.npmjs.org/monaco-editor
- https://raw.githubusercontent.com/microsoft/monaco-editor/main/CHANGELOG.md
- https://data.jsdelivr.com/v1/packages/npm/monaco-editor@0.57.0?structure=flat
- https://cdn.jsdelivr.net/npm/monaco-editor@0.57.0/ThirdPartyNotices.txt
- https://registry.npmjs.org/ngx-monaco-editor-v2
- https://cdn.jsdelivr.net/npm/ngx-monaco-editor-v2@22.0.5/fesm2022/ngx-monaco-editor-v2.mjs
- https://raw.githubusercontent.com/miki995/ngx-monaco-editor-v2/master/projects/editor/src/lib/base-editor.ts
- https://blog.js.cytoscape.org/2025/01/13/webgl-preview/
- https://registry.npmjs.org/cytoscape
- https://raw.githubusercontent.com/cytoscape/cytoscape.js/unstable/src/extensions/renderer/canvas/index.mjs
- https://raw.githubusercontent.com/cytoscape/cytoscape.js/unstable/documentation/demos/gpu/code.js
- https://registry.npmjs.org/elkjs
- https://cdn.jsdelivr.net/npm/elkjs@0.12.0/package.json
- https://cdn.jsdelivr.net/npm/elkjs@0.12.0/LICENSE.md
- https://cdn.jsdelivr.net/npm/elkjs@0.12.0/lib/elk.bundled.js
- https://www.apache.org/legal/resolved.html
- https://www.eclipse.org/legal/epl-2.0/faq/
- https://www.eclipse.org/legal/documents/html/epl-2.0-faq.html
- https://registry.npmjs.org/@dagrejs/dagre
- https://registry.npmjs.org/@dagrejs/graphlib
- https://registry.npmjs.org/@foblex/flow
- https://github.com/Foblex/f-flow
- https://raw.githubusercontent.com/Foblex/f-flow/main/README.md
- https://registry.npmjs.org/ngx-vflow
- https://github.com/artem-mangilev/ngx-vflow
- https://registry.npmjs.org/uplot
- https://github.com/leeoniya/uPlot
- https://registry.npmjs.org/echarts
- https://cdn.jsdelivr.net/npm/echarts@6.1.0/NOTICE
- https://cdn.jsdelivr.net/npm/echarts@6.1.0/LICENSE
- https://registry.npmjs.org/zrender
- https://registry.npmjs.org/ngx-echarts
- https://registry.npmjs.org/@jsverse/transloco
- https://registry.npmjs.org/@lucide/angular
- https://registry.npmjs.org/lucide-angular
- https://raw.githubusercontent.com/lucide-icons/lucide/main/LICENSE
- https://registry.npmjs.org/tinykeys
- https://registry.npmjs.org/dompurify
- https://registry.npmjs.org/angular-split
- https://registry.npmjs.org/@vscode/codicons
- https://cdn.jsdelivr.net/npm/apexcharts@8.3.1/LICENSE.md
- https://registry.npmjs.org/nx
- https://registry.npmjs.org/@nx/angular/23.3.0
- https://registry.npmjs.org/@nx/nest
- https://registry.npmjs.org/@nx/vitest
- https://registry.npmjs.org/@nx/playwright
- https://registry.npmjs.org/@nx/eslint/23.3.0
- https://registry.npmjs.org/@nestjs/core
- https://nx.dev/docs/features/enforce-module-boundaries
- https://nx.dev/docs/guides/tasks--caching/self-hosted-caching
- https://nx.dev/docs/enterprise/owners
- https://nx.dev/docs/technologies/angular/guides/angular-nx-version-matrix
- https://nx.dev/pricing
- https://signpath.org/terms
- https://docs.signpath.io/trusted-build-systems/github
- https://docs.signpath.io/artifact-configuration
- https://docs.signpath.io/artifact-configuration/reference
- https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart
- https://learn.microsoft.com/en-us/azure/artifact-signing/faq
- https://azure.microsoft.com/en-us/pricing/details/artifact-signing/
- https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/open-a-developer-account
- https://learn.microsoft.com/en-us/windows/msix/package/signing-package-overview
- https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-package-requirements
- https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation
- https://developer.apple.com/programs/
- https://developer.apple.com/support/membership-fee-waiver/
- https://developer.apple.com/news/?id=saqachfa
- https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy
- https://developer.apple.com/tutorials/data/documentation/technotes/tn3179-understanding-local-network-privacy.json
- https://brew.sh/2025/11/12/homebrew-5.0.0/
- https://brew.sh/2026/06/11/homebrew-6.0.0/
- https://brew.sh/2026/09/13/homebrew-7.0.0/
- https://docs.brew.sh/Acceptable-Casks
- https://raw.githubusercontent.com/Homebrew/homebrew-cask/HEAD/Casks/x/xld.rb
- https://raw.githubusercontent.com/Homebrew/homebrew-cask/HEAD/Casks/p/pb.rb
- https://github.com/electron/electron/issues/42510
- https://raw.githubusercontent.com/electron-userland/electron-builder/master/packages/app-builder-lib/templates/linux/after-install.tpl
- https://raw.githubusercontent.com/electron-userland/electron-builder/master/packages/app-builder-lib/src/targets/linux/FpmTarget.ts
- https://raw.githubusercontent.com/electron-userland/electron-builder/master/website/docs/linux.md
- https://raw.githubusercontent.com/electron-userland/electron-builder/master/packages/app-builder-lib/src/electron/ElectronFramework.ts
- https://github.com/electron-userland/electron-builder/issues/9407
- https://github.com/electron-userland/electron-builder/releases/tag/electron-builder@26.16.1
- https://shop.certum.eu/open-source-code-signing.html
- https://shop.certum.eu/open-source-code-signing-on-simplysign.html
- https://docs.npmjs.com/trusted-publishers
- https://docs.github.com/en/billing/concepts/product-billing/github-actions
- https://docs.github.com/en/billing/concepts/product-billing/github-packages
- https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/immutable-releases
- https://www.rabbitmq.com/trademark-guidelines
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/src/pages/trademark-guidelines.md
- https://www.rabbitmq.com/client-libraries/devtools
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/client-libraries/devtools.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/CONTRIBUTING.md
- https://github.com/rabbitmq/rabbitmq-website/pull/2410
- https://github.com/rabbitmq/rabbitmq-website/pull/2662
- https://github.com/ruby-amqp/bunny
- https://github.com/ruby-amqp/hutch
- https://github.com/amqp-rs/lapin
- https://github.com/pika/pika
- https://github.com/php-amqplib/Thumper
- https://github.com/linkedin/Burrow
