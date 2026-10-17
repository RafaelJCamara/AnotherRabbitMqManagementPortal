# Authentication, connectivity and threat model

> **Verified research (2026-10-16).** Source read at exact release tags and primary docs; **not yet lab-tested**. The conformance suite (M0) confirms or corrects every runtime claim. Content about a specific third-party product was removed under the docs policy ([ADR-034](../adr/ADR-034-docs-policy.md)).

_Verification task `auth-network-security` · 2026-10-16_

## Summary

I checked these findings against RabbitMQ source at v3.13.7, v4.0.9, v4.1.8, v4.2.9 and v4.3.6, the draft 4.4.0 release notes on main, and the current source of the clients and runtimes we plan to use.

**OAuth 2.0 works on every protocol from a third-party TypeScript client.**
- The HTTP API accepts `Authorization: Bearer <JWT>` whenever rabbitmq_auth_backend_oauth2 is in the HTTP auth chain. `management.oauth_enabled` only controls the UI login.
- AMQP 0-9-1, AMQP 1.0 and streams take the JWT as the SASL PLAIN password; the username is ignored.

**Behaviour changes by version, so the engine must know the broker version.**
- 4.0.8 and 4.1.0 added a separate HTTP auth chain (`http_dispatch.auth_backends`).
- 4.1.0 added AMQP 1.0 token renewal (`PUT /auth/tokens`), raised the AMQP 0-9-1 pre-auth frame to 8 KB, and stopped sending the Entra/Auth0 request parameters by default.
- From 4.2.6 and 4.3.0, AMQP 0-9-1 connections are closed with CONNECTION_FORCED when the token expires. The 4.3 docs still say they are not closed.
- The HTTP access log shows the real OAuth username only from 4.3.3.
- The 4.4 draft breaks UAA through stricter OIDC discovery checks.
- Bearer headers over about 4 KB get HTTP 431 (Cowboy's default limit); only advanced.config raises it.

**Clients.**
- amqplib 2.2.0 has `updateSecret` and EXTERNAL. Its built-in recovery reconnects with the original credentials unless given a credentials object that returns the current token.
- rabbitmq-amqp-js-client 1.0.0 has `refreshToken` but no EXTERNAL option, and pulls its rhea dependency straight from GitHub.
- rabbitmq-stream-js-client 1.1.0 has EXTERNAL and only a fixed-endpoint load-balancer resolver. It cannot renew a token on an open connection. Its "1.1.0 OIDC" item is npm trusted publishing, not OAuth.

**Prior-corpus claims that are wrong.**
- No `?token=` exception exists in code for `/api/definitions`.
- Chrome's Local Network Access protection has covered WebSockets since Chrome 147, but it is turned off in Electron.
- Reading a stream over AMQP needs no leader connection, but the connected node must host a member of the stream.

**Recommended architecture.**
- One identity subsystem with pluggable credential providers: password, OAuth with PKCE and a loopback redirect (RFC 8252) plus issuer pinning, device code, an external token command, x.509/EXTERNAL, Vault/OpenBao dynamic users, and a delegated user token.
- A token manager that refreshes per protocol.
- One policy-enforcing dialer: direct, SOCKS5, HTTP CONNECT, ssh2 or system OpenSSH, and Kubernetes port-forward.
- A MessagePort, not loopback TCP, between the desktop UI and the engine.
- Team server: a credential mode per connection (delegated OAuth preferred, then Vault dynamic users, then a service account), always under the tool's own RBAC and audit log.
- The MCP endpoint must be its own OAuth resource and must never pass tokens through. CVE-2026-18655 shows how prompt injection can steer broker credentials or OAuth tokens to an attacker's host.

## Verdicts

| ID | Verdict | Confidence | Verified statement |
| --- | --- | --- | --- |
| V01 | confirmed | high | HTTP API: `Authorization: Bearer <jwt>` (any version 3.13–4.4) or Basic with the JWT as password (`-u ignored:<jwt>`) unless `management.disable_basic_auth=true`. AMQP 0-9-1, AMQP 1.0 and the stream protocol: SASL PLAIN with the JWT as password; the username is ignored. |
| V02 | confirmed | high | aud must contain `auth_oauth2.resource_server_id` (or a `resource_servers.N.id`) unless `verify_aud=false`. Scope format is `<prefix><configure\|read\|write>:<vhost_pattern>/<name_pattern>[/<routing_key_pattern>]`, plus `<prefix>tag:<tag>`. The prefix defaults to `<resource_server_id>.`; `scope_prefix` can override it, including an empty prefix. `exp` is required by default (`require_exp=true`). The `iss` claim is never checked: tokens are trusted through the provider's signing keys and routed by aud. |
| V03 | confirmed | high | 3.13.0 added multiple OAuth 2 resources, each with its own provider, and issuer-based OIDC discovery (PR #10012). Tokens are routed to a resource server by aud. |
| V04 | refuted | medium | The first half is true: with `disable_basic_auth=true`, Basic is rejected for every user ('HTTP access denied: basic auth disabled'). The definitions exception is not in the code. In every checked version the definitions handler uses the normal Authorization-header check, and no handler parses a `token` query parameter. The sentence repeated in the 3.13, 4.0, 4.2 and 4.3 docs is stale. Send `Authorization: Bearer` to /api/definitions like any other endpoint. |
| V05 | refuted | high | Bearer tokens work whenever the oauth2 backend is in the HTTP auth chain (`http_dispatch.auth_backends`, or else `auth_backends`). `management.oauth_enabled` only switches on the UI's SP-initiated login and the content of `/api/auth`. |
| V06 | nuanced | high | It exists from 4.0.8 (backport) and 4.1.0 (PR #13467). It lets the HTTP API use a different authN/authZ chain from the messaging protocols, so a connection profile may need different credentials for HTTP and for AMQP. |
| V07 | confirmed | high | Open-source RabbitMQ accepts only signed JWTs. Token introspection for opaque tokens was built only into commercial Tanzu RabbitMQ (issue #8662, closed 2025-08-19), so Google, which issues opaque access tokens, is unsupported. Amazon MQ also states it supports no introspection, no opaque tokens and no revocation checks. |
| V08 | confirmed | high | amqplib 2.2.0 (2026-09-28) has `ChannelModel.updateSecret(newSecret: Buffer, reason)`, which sends connection.update-secret and waits for update-secret-ok. It was added in 0.10.4; event forwarding was fixed in 1.0.7 (#849). The recovering model also has updateSecret. Caveat: reconnects reuse the original URL and credentials. To make reconnects use the current token, pass a custom `socketOptions.credentials` object whose `response()` returns it; `response()` is called on every connect. |
| V09 | confirmed | high | `Connection.refreshToken(token)` sends HTTP-over-AMQP `PUT /auth/tokens` with the token as a binary body and updates the password used on reconnect. It is present by 0.3.3 and in 1.0.0 (2026-06-25). The broker side needs RabbitMQ 4.1+; 4.0 closes AMQP 1.0 connections at expiry and has no renewal endpoint. |
| V10 | nuanced | high | The broker supports renewal on an open stream connection by re-sending SaslAuthenticate with the same mechanism and username (3.13.0, #9187), and closes the connection at expiry ('Token expired', 3.13.0, #10292). A different username is refused. rabbitmq-stream-js-client 1.1.0 offers no renewal API, so the engine must reconnect with a fresh token before expiry and resume from tracked offsets. |
| V11 | refuted | high | PR #293, 'Add OIDC login and publish', only changes the GitHub Actions release workflow, to publish to npm through OIDC trusted publishing. The client has no OAuth or OIDC feature beyond passing a JWT as the PLAIN password. The same is true of rabbitmq-amqp-js-client PR #79. |
| V12 | confirmed | high | From 4.0.0 the native AMQP 1.0 reader closes the connection at expiry with amqp:unauthorized-access 'credential expired'. From 4.1.0 a client can renew first with PUT /auth/tokens; 4.0.x has no way to renew. On 3.13 (rabbitmq_amqp1_0 plugin) I found no explicit expiry handling in the plugin reader; that case is not verified. |
| V13 | nuanced | high | This holds only for 3.13 through 4.2.5. There, the channel clears its permission cache every `channel_tick_interval` (60 s), so later permission-checked operations fail, while existing consumers keep receiving messages. From 4.2.6 and 4.3.0 (PR #16092, commit 501ad947) the reader arms an expiry timer and closes the connection with 320 CONNECTION_FORCED 'credential expired'. update-secret now clears the cache at once and re-checks consumers, cancelling those that lost read access. The 4.3 docs and the release notes do not mention the disconnect. |
| V14 | confirmed | high | Cowboy's default `max_header_value_length` of 4096 bytes also applies to the Authorization header (`max_authorization_header_value_length` defaults to it). Bearer JWTs over roughly 4 KB therefore get 431, and Basic with the JWT as password fails sooner because base64 adds about 33%. The only fix is advanced.config `{rabbitmq_management, [{listener, [{cowboy_opts, [{max_header_value_length, N}]}]}]}`; no rabbitmq.conf key exists in 4.1.8, 4.2.9, 4.3.6 or main. A user reported the problem still present on 4.2 on 2026-09-24. |
| V15 | confirmed | high | The token version is set by the resource app's manifest `requestedAccessTokenVersion` (null or 1 gives v1, 2 gives v2), whichever endpoint the client used. In v2 tokens `aud` is always the API's client-ID GUID and `iss` ends in /v2.0. In v1 tokens `aud` is the client ID or the App ID URI (`api://...`), depending on the request, and `iss` is sts.windows.net. `preferred_username` exists only in v2; `upn` and `unique_name` only in v1. `sub` is pairwise per application. App roles arrive in `roles`, delegated scopes in `scp` (a space-separated string). The groups claim overflows at 200 groups in a JWT. A mismatch between `resource_server_id` (and hence the scope prefix) and `aud` is the usual cause of 'Not authorized' (#13887). |
| V16 | confirmed | high | The draft 4.4.0 notes validate discovery responses per OIDC Discovery §4.3: endpoints must be https and the issuer must match the discovery URL. This breaks UAA, whose issuer is its token endpoint URL. The workaround is to set `auth_oauth2.discovery.verify_issuer=false` and/or `auth_oauth2.discovery.verify_https_endpoints=false` before upgrading (#17363). |
| V17 | confirmed | high | Confirmed. The underlying cause is a 4.1.0 change (#12235): the management UI stopped sending a default `resource` parameter (Entra v2 rejects it) and a default `audience` parameter (Auth0 needs it). These must now be set explicitly through `management.oauth_authorization_endpoint_params.*` and `oauth_token_endpoint_params.*`, alongside the Entra 'Expose an API' scope setup. |
| V18 | confirmed | high | Per RFC 8252 the app must use the system browser, never an embedded webview (§8.12). The redirect should be `http://127.0.0.1:{port}/path` (§7.3: the server MUST allow any port); `localhost` is NOT RECOMMENDED (§8.3). RFC 9700 (Jan 2025) says public clients MUST use PKCE, and their refresh tokens MUST be sender-constrained or rotated. Identity providers differ: Entra ignores the port for localhost redirects on the 'Mobile and desktop applications' platform (http://127.0.0.1 needs a manifest edit; [::1] is unsupported). Keycloak matches loopback redirects regardless of port. Okta (2022 staff statement) and Auth0 (community reports) historically did not support ephemeral ports. |
| V19 | nuanced | medium | Technically yes. The management UI is a public client, and the unauthenticated `GET /api/auth` returns its client_id, scopes, issuer, resource servers and endpoint parameters. Its tokens would carry the same aud and scopes. But the IdP admin must add our loopback redirect: the UI only registers `<base>/js/oidc-oauth/login-callback.html`. On Entra, a redirect of SPA type requires an Origin header when the code is redeemed (AADSTS9002327) and limits refresh tokens to 24 hours, so a 'Mobile and desktop' redirect must be added. UAA needs a client secret even to refresh. The better pattern is a dedicated public client registration ('<tool> desktop') with the same API scopes and audience mapping, with reuse kept as a fallback. |
| V20 | confirmed | medium | Headlamp states that it only forwards the token to the Kubernetes API server, which accepts or rejects it. By default it forwards the id_token (`-oidc-use-access-token=true` switches to the access token). For RabbitMQ we must forward an access token issued for the broker's audience and scopes, never an ID token, because RabbitMQ does not check the token type. |
| V21 | confirmed | high | Queue, exchange, binding, vhost, policy, parameter, user and permission events carry `user_who_performed_action`. For OAuth users this is the name taken from `preferred_username_claims` (default `[sub, client_id]`). On Entra `sub` is a pairwise opaque ID, so configure `preferred_username`, `upn` or `oid`. With a shared service account every event names that account. |
| V22 | confirmed | high | On 3.13 through 4.2.9 and 4.3.0 through 4.3.2, a bearer request is logged under `management.oauth_client_id` (empty if unset). 4.3.3 (released 2026-07-20) logs the backend-resolved username (#16879/#16884/#16889). The 4.2.x backport (#16887) was not merged, so 4.2.x still logs the client ID. |
| V23 | confirmed | high | Both 2025-11-25 and the current 2026-07-28 revision require MCP servers to accept only tokens issued to themselves (audience validation per RFC 8707) and say they 'MUST NOT pass through the token it received from the MCP client'. Calls to upstream APIs must use separately issued tokens. 2026-07-28 also removes protocol sessions (stateless). |
| V24 | confirmed | high | amqplib `credentials.external()` sends mechanism EXTERNAL with an empty response; the client certificate goes in the TLS socket options (cert/key/pfx/ca). The broker needs rabbitmq_auth_mechanism_ssl, EXTERNAL in `auth_mechanisms` and peer verification. The username comes from DN, CN or SAN (`ssl_cert_login_from`); any password is ignored. The HTTP API has no certificate login: mTLS there is transport-only (`management.ssl.verify`, `fail_if_no_peer_cert`) and Basic or Bearer is still needed. |
| V25 | confirmed | high | undici's connector passes its `connect` options straight to tls.connect/net.connect (cert, key, pfx, ca, servername, checkServerIdentity, lookup), and `connect` can also be a custom function returning our own socket. ProxyAgent has `requestTls` and `proxyTls`. Private keys held in OS stores, smartcards or TPMs are not reachable from Node; in desktop mode, Electron's `net` (Chromium) can use them through select-client-certificate. |
| V26 | confirmed | high | `--use-system-ca` (added in v23.8.0; non-Windows/macOS from v23.9.0), `NODE_USE_SYSTEM_CA=1` (v24.6.0), `tls.getCACertificates('default'\|'system'\|'bundled'\|'extra')` (v23.10.0/v22.15.0) and `tls.setDefaultCACertificates()` (v24.5.0) all exist. A per-connection `ca` option replaces the defaults rather than adding to them, so concatenate. Current Node 24 is 24.22.0 (2026-10-14). |
| V27 | confirmed | high | The nodeOptions fuse controls both NODE_OPTIONS and NODE_EXTRA_CA_CERTS. Packaged apps reject NODE_OPTIONS apart from `--max-http-header-size` and `--http-parser`, and `--use-openssl-ca`/`--use-bundled-ca` do not work because Node's crypto is built on BoringSSL. Electron 44.8.0 (2026-10-15) bundles Node 24.22.0 and Chromium 152, so `tls.setDefaultCACertificates` should be available in the engine; it still needs testing under BoringSSL. |
| V28 | confirmed | high | Dates: OAuth 2.0 on 2025-09-03, LDAP on 2025-11-17, HTTP auth on 2026-01-06 (4.2+), X.509 auth and mTLS on 2026-01-08 (4.2+), and private networking to private IdPs and brokers on 2026-06-18. Limits: - OAuth: no private-CA IdP certificates, no client secret (so no UAA), no static signing keys, no introspection or revocation. - LDAP: LDAPS only; the server had to be internet-reachable before private networking. - The management API does not support strict mTLS. - The supported-protocols page lists AMQP 0-9-1, AMQP 1.0 and JMS only. - Every broker has a protected `monitoring-AWS-OWNED-DO-NOT-DELETE` user. |
| V29 | nuanced | high | ssh2 1.17.0 (2025-08-20) supports connection hopping (`sock: stream` from `forwardOut`), agents (OpenSSH socket, Pageant, Windows pipes), `agentForward`, ed25519/ECDSA/RSA keys, encrypted keys and keyboard-interactive login (MFA). It does not support OpenSSH certificate authentication (issue #1495 open since 2026-05-05), which Teleport, Vault SSH CA and smallstep setups need. It also has an install script with optional native dependencies and no npm provenance. |
| V30 | nuanced | high | For HTTP, undici ProxyAgent covers HTTP and HTTPS proxies (CONNECT for https targets) and SOCKS5 through Socks5ProxyAgent, which is experimental, appeared in undici 7.23.0 and resolves DNS at the proxy. For raw AMQP or stream TCP, `socks` 2.8.10 (SOCKS v4/v4a/v5/v5h, user/pass, proxy chains) returns a raw socket. That socket can be handed to tls.connect({socket}) for amqps, but plain-TCP amqplib and the stream client cannot take a supplied socket and need a local forwarder or an upstream patch. |
| V31 | nuanced | medium | @kubernetes/client-node 2.0.0 port-forwards to a pod, not a Service, one port per call ('Only one port is currently supported'), over WebSocket, with kubeconfig exec, OIDC, Azure and GCP auth. The cluster operator creates Service `<name>` (ClusterIP by default), headless `<name>-nodes`, pods `<name>-server-N.<name>-nodes.<ns>.svc.<domain>` and the secret `<name>-default-user`. Traffic forwarded into a pod probably reaches RabbitMQ from loopback (inference). |
| V32 | nuanced | high | Only the load-balancer mode exists: `addressResolver: {enabled: true, endpoint?: {host, port}}`. The client keeps connecting to the fixed endpoint, up to (2 + leader + replicas)^2 attempts, until the node it lands on matches the chosen one. Publishers pick the leader and consumers a random replica. There is no per-node address-mapping function like Java's AddressResolver, so a single SSH tunnel to one node of a multi-node cluster usually fails. On the broker, `stream.advertised_host` and `advertised_port` (plus TLS variants) are returned unvalidated, and the docs advise not setting them behind load balancers. |
| V33 | nuanced | high | No leader connection is needed, but the node the AMQP connection lands on must run a member of the stream (leader or replica). Otherwise consume fails with precondition_failed: 'stream ... does not have a running replica on the local node'. Streams are replicated to every node by default, but nodes added later get no replicas and `x-initial-cluster-size` can shrink the set. |
| V34 | confirmed | high | Confirmed: `getSelectedStorageBackend()` returns `basic_text`. More points: - safeStorage runs only in the main process. - Electron 44 recommends the async API (`encryptStringAsync`, `decryptStringAsync`, `isAsyncEncryptionAvailable`); the main-branch docs say the sync API is removed in Electron 46. - DPAPI on Windows does not protect from other apps running as the same user. - On macOS an inconsistently signed app re-triggers Keychain prompts after updates. |
| V35 | confirmed | high | @napi-rs/keyring 2.1.1 (2026-10-10, MIT, npm provenance) uses the macOS Keychain, Windows Credential Manager, and on Linux the Secret Service, falling back to kernel keyutils. keyutils 'is completely in-memory and will not persist across reboots', so force `{linux:{store:'secret-service'}}` or offer a master password. |
| V36 | confirmed | high | Vault and OpenBao create RabbitMQ users through the management API, using administrator credentials held by Vault. Each role maps to vhosts, vhost_topics and tags; usernames follow a configurable `username_template`; users are leased and deleted on revocation. The broker must keep a user-store backend (internal) in its chain, so the engine does not work on OAuth-only brokers. |
| V37 | refuted | high | Chrome 142 (Oct 2025) gated fetch, subresources and iframes from public origins to local and loopback addresses behind a permission prompt. WebSockets followed in Chrome 147 (April 2026) and WebTransport after that. Enterprise policies LocalNetworkAccessAllowedForUrls and LocalNetworkAccessBlockedForUrls apply. LNA does not apply loopback-to-loopback or to non-browser clients, and an Electron issue thread said in June 2026 that it is 'currently hard disabled in Electron'. |
| V38 | confirmed | high | Confirmed for fetch, subresources and subframe navigation from Chrome 142; WebSockets since 147. Requesting the permission is restricted to secure contexts. |
| V39 | confirmed | high | CVE-2026-18655 (bulletin published 2026-08-03): awslabs.amazon-mq-mcp-server 2.0.23 and earlier did not restrict the endpoints of its broker-connection tools, so a prompt injection could change the broker hostname and send credentials or OAuth tokens there. Fixed in 2.0.24. Workaround: turn off auto-approval for `rabbitmq_broker_initialize_connection` and `rabbitmq_broker_initialize_connection_with_oauth`. |
| V40 | nuanced | high | The RabbitMQ docs list coders51/rabbitmq-amqp-js-client as the RabbitMQ AMQP 1.0 JavaScript client. Version 1.0.0 (2026-06-25) is ISC-licensed and has npm provenance. It depends on `rhea: github:amqp/rhea`, a git dependency resolved at install time; rhea's main branch has a `prepare` script. rhea's npm release 3.0.5 (2026-04-28) lacks two later decoder-hardening commits ('Bound AMQP compound element count during decode', 2026-05-07; 'Bound nesting depth when decoding AMQP compound and described types', 2026-09-30). The client exposes no SASL EXTERNAL option, only a typed TLS subset (key/cert/ca/rejectUnauthorized), and no custom socket for OAuth connections. |
| V41 | confirmed | high | Before authentication the broker caps AMQP 0-9-1 frames at 4096 bytes up to 4.0.x and 8192 bytes from 4.1.0 (`initial_frame_max`, #13541/#13542), so tokens of about 4–8 KB fail with frame_too_large. amqplib below 0.10.6/0.10.7 used frame_max 4096; 2.x defaults to 131072. AMQP 1.0 in 4.0 already allowed 8192 bytes during SASL. |
| V42 | confirmed | high | update-secret, PUT /auth/tokens and stream re-authentication all fail if the new token resolves to a different username (`mismatch_username_after_token_refresh`). An AMQP connection therefore can never be handed from one user to another: the team server needs per-user connections in delegated mode. |
| V43 | confirmed | high | `GET /api/auth` needs no authentication. Through 4.2.8 and 4.3.2 it returns `oauth_client_secret` whenever one is configured (typically for UAA). 4.2.9 and 4.3.3 strip it and route token calls through a server-side proxy (#16664/#16892). Our advisor should flag this. |
| V44 | confirmed | high | `auth_oauth2.https.hostname_verification` defaults to `none` for JWKS and discovery fetches. The official Okta tutorial template sets `auth_oauth2.verify_aud = false`. ANONYMOUS is enabled by default since 4.0 and maps to `anonymous_login_user` (guest), which is limited to loopback. The OAuth backend does no revocation checks. |

### Evidence

- **V01** (confirmed, high): rabbit_web_dispatch_access_control.erl@v4.3.6 parse_credentials/2: `{bearer, Token} -> ... {bearer, <<"">>, Token}`; @v3.13.7 L101-105 `{bearer, Token} -> Username = AuthConfig#auth_settings.oauth_client_id, is_authorized(...)`. Docs https://www.rabbitmq.com/docs/oauth2 (versioned_docs/version-4.3/oauth2.md): 'The Client application passes the token as password ... The username field is ignored.' https://www.rabbitmq.com/docs/management shows `curl -i -u ignored:<token>` and Bearer.
- **V02** (confirmed, high): version-4.3/oauth2.md sections Scope-to-Permission translation, Scope Prefix, Token validation; no non-comment `iss` handling anywhere in deps/rabbitmq_auth_backend_oauth2/src@v4.3.6 (grep). rabbit_oauth2_resource_server.erl@v4.3.6 `resolve_resource_server_from_audience` -> `{error, no_matching_aud_found}`.
- **V03** (confirmed, high): release-notes/3.13.0.md L516-526 (#10012); oauth2.md 'Multiple Resource Servers Configuration' and 'Multiple OAuth Providers Configuration'.
- **V04** (refuted, medium): rabbit_mgmt_wm_definitions.erl: @v3.13.7 L139-140, @v4.2.9 L278-279, @v4.3.6 L316-317 `is_authorized(ReqData, Context) -> rabbit_mgmt_util:is_authorized_admin(ReqData, Context).`; rabbit_web_dispatch_access_control.erl@v4.3.6 parse_credentials/2 reads only `cowboy_req:parse_header(<<"authorization">>, ...)`; management UI downloads definitions with XHR+Blob (priv/www/js/main.js@v4.3.6 L894-930); docs text versioned_docs/version-4.3/management/index.md L505-507.
- **V05** (refuted, high): rabbit_web_dispatch_access_control.erl@v3.13.7 bearer branch has no oauth_enabled check; @v4.3.6 get_auth_backends/0 L391-397 uses `application:get_env(rabbitmq_web_dispatch, auth_backends)` and falls back to `rabbit, auth_backends`.
- **V06** (nuanced, high): deps/rabbitmq_web_dispatch/priv/schema/rabbitmq_web_dispatch.schema: absent at v4.0.0–v4.0.7, present at v4.0.8, v4.0.9, v4.1.0, v4.3.6; release-notes/4.0.8.md L134-150 example `auth_backends.1 = ldap` / `http_dispatch.auth_backends.1 = http`.
- **V07** (confirmed, high): https://github.com/rabbitmq/rabbitmq-server/issues/8662 ('This Ended Up Being a Tanzu RabbitMQ-specific Feature'); version-4.3/oauth2-examples-google.md L24-28; https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/oauth-for-amq-for-rabbitmq.md.
- **V08** (confirmed, high): lib/channel_model.js@v2.2.0 L22-23; lib/connection.js@v2.2.0 L358-364 `_updateSecret` -> `defs.ConnectionUpdateSecret`; CHANGELOG.md v0.10.4/v1.0.7; channel_api.js@v2.2.0 `openModel = () => ... raw_connect(url, connectionOptions, cb)`; lib/connect.js openFrames `response: credentials.response()`.
- **V09** (confirmed, high): coders51/rabbitmq-amqp-js-client@v1.0.0 src/management.ts L251-258 (`.sendTo('/auth/tokens')`, `.setBody(Buffer.from(token, 'ascii'))`), src/connection.ts L113-118; rabbit_amqp_management.erl@v4.3.6 `handle_http_req(<<"PUT">>, [<<"auth">>, <<"tokens">>], ...) -> {binary, Token} = ReqPayload, ok = rabbit_amqp_reader:set_credential(ConnPid, Token), {<<"204">>, ...}`; release-notes/4.1.0.md #12599.
- **V10** (nuanced, high): rabbit_stream_reader.erl@v4.3.6 handle_frame_post_auth `{sasl_authenticate, NewMechanism, NewSaslBin}` -> complete_secret_update / 'Not allowed to change username'; `open(info, token_expired, ...) -> {stop, {shutdown, <<"Token expired">>}}`; release-notes/3.13.0.md L455-462; stream-js-client v1.1.0 src/connection.ts sends SaslAuthenticateRequest only during open (L572), no refresh API in src/client.ts.
- **V11** (refuted, high): https://github.com/coders51/rabbitmq-stream-js-client/pull/293 files: `.github/workflows/release-package.yml +8 -6` only; https://github.com/coders51/rabbitmq-amqp-js-client/pull/79 same file only.
- **V12** (confirmed, high): rabbit_amqp_reader.erl@v4.0.0 and @v4.0.9 handle credential_expired; @v4.3.6 L243-245 `error_frame(?V_1_0_AMQP_ERROR_UNAUTHORIZED_ACCESS, "credential expired", [])`; rabbit_amqp_management.erl@v4.0.9 has no auth/tokens route; deps/rabbitmq_amqp1_0/src/rabbit_amqp1_0_reader.erl@v3.13.7 has no 'expir' matches.
- **V13** (nuanced, high): rabbit_reader.erl@v4.3.6 L687-725 (`closing AMQP connection ~ts of user '~ts': credential has expired`, terminate -> amqp_error(connection_forced)); credential_expired absent @v4.2.5, present @v4.2.6/@v4.3.0; rabbit_channel.erl@v4.1.8 L784-797 tick clears cache, update_user_state does not recheck; @v4.3.6 recheck_consumers/1 L1776-1793; deps/rabbit/Makefile@v4.1.8 L109 `{channel_tick_interval, 60000}`; version-4.3/oauth2.md 'Token expiration and refresh'.
- **V14** (confirmed, high): https://github.com/rabbitmq/rabbitmq-server/issues/13761 (3.13.7 + Keycloak; maintainer: 'overriding Cowboy's header size limit is the correct solution'); cowboy doc/src/manual/cowboy_http.asciidoc `max_header_value_length (4096)`, changelog 2.15 added max_authorization_header_value_length; rabbitmq-components.mk@v4.3.6 `dep_cowboy = hex 2.19.0`; rabbitmq_management.schema has no header-size mapping.
- **V15** (confirmed, high): https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens ('The values of null and 1 result in v1.0 tokens, and the value of 2 results in v2.0 tokens'); https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference (aud, iss, sub pairwise, overage 200); https://github.com/rabbitmq/rabbitmq-server/discussions/13887 (fix: resource_server_id = api://{AppID} plus scope_prefix).
- **V16** (confirmed, high): https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.4.0.md L28-41 and 'Auth Backend OAuth 2 Plugin' section.
- **V17** (confirmed, high): https://github.com/rabbitmq/rabbitmq-server/discussions/13887 (comment by michaelklishin, 2025-05-12); https://github.com/rabbitmq/rabbitmq-server/issues/12235; release-notes/4.1.0.md L594-597; version-4.3/oauth2-examples-auth0.md L110-118.
- **V18** (confirmed, high): https://www.rfc-editor.org/rfc/rfc8252 L511-522, L610-614, §8.12; https://www.rfc-editor.org/rfc/rfc9700 §2.1.1 and §2.2.2 ('Refresh tokens for public clients MUST be sender-constrained or use refresh token rotation'); https://learn.microsoft.com/en-us/entra/identity-platform/reply-url (Localhost exceptions); keycloak services/.../oidc/utils/RedirectUtils.java (LOOPBACK_INTERFACES, port normalized to 80 when matching); https://devforum.okta.com/t/loopback-interface-redirection-ephemeral-ports-wildcard-ports-in-localhost-redirect-uri/22197; https://community.auth0.com/t/allow-wildcard-port-in-redirect-uri-as-per-rfc-8252/98409.
- **V19** (nuanced, medium): rabbit_mgmt_wm_auth.erl@v3.13.7 L150-151 `is_authorized(ReqData, Context) -> {true, ReqData, Context}`; priv/www/js/oidc-oauth/helper.js@v4.3.6 L147-155 (`redirect_uri: rabbit_base_uri() + "/js/oidc-oauth/login-callback.html"`, `userStore ... localStorage`); management docs 'the management UI is a public app'; https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens (24h SPA, 90 days otherwise); https://learn.microsoft.com/en-us/answers/questions/1601797/aadsts9002327-tokens-issued-for-the-single-page-ap.
- **V20** (confirmed, medium): https://headlamp.dev/docs/latest/installation/in-cluster/oidc ('Headlamp only forwards the token to the API server, and the API server is what accepts or rejects it'); RabbitMQ validates signature/exp/aud only (V02).
- **V21** (confirmed, high): rabbit_amqqueue.erl@v4.3.6 L1911-1914 `rabbit_event:notify(queue_deleted, [..., {user_who_performed_action, ActingUser}])`; GitHub code search hits in rabbit_policy.erl, rabbit_vhost.erl, rabbit_exchange.erl, rabbit_binding.erl, rabbit_runtime_parameters.erl; oauth2.hrl@v4.3.6 L12 `DEFAULT_PREFERRED_USERNAME_CLAIMS, [<<"sub">>, <<"client_id">>]`.
- **V22** (confirmed, high): rabbit_web_dispatch_access_control.erl@v4.2.9 L101-105 `Username = AuthConfig#auth_settings.oauth_client_id`; `set_authenticated_username` absent @v4.3.2, present @v4.3.3; release-notes/4.3.3.md L218-221; https://github.com/rabbitmq/rabbitmq-server/issues/16559.
- **V23** (confirmed, high): modelcontextprotocol/modelcontextprotocol main: docs/specification/2025-11-25/basic/authorization.mdx L690-692; docs/specification/2026-07-28/basic/authorization/security-considerations.mdx L124-126; docs/docs/2026-07-28/tutorials/security/security_best_practices.mdx 'Token Passthrough' L278-348; 2026-07-28/changelog.mdx.
- **V24** (confirmed, high): lib/credentials.js@v2.2.0 L31-34; deps/rabbitmq_auth_mechanism_ssl/README.md@v4.3.6; version-4.3/access-control.md L118-121; rabbitmq_management.schema@v4.3.6 has only ssl.fail_if_no_peer_cert (no cert-login key); rabbit_web_dispatch_access_control.erl reads only the authorization header.
- **V25** (confirmed, high): nodejs/undici lib/core/connect.js@v8.12.2 L92-102 (`tls.connect({ highWaterMark: 16384, ...options, servername, ... })`); docs/docs/api/ProxyAgent.md@v8.12.2; electron docs/api/utility-process.md (`respondToAuthRequestsFromMainProcess` routes client-certificate selection to app#select-client-certificate).
- **V26** (confirmed, high): https://raw.githubusercontent.com/nodejs/node/v24.x/doc/api/cli.md L3302-3356 and L3966-3976; doc/api/tls.md L2361-2421 and L2035-2040 ('the default list would be completely replaced (instead of being concatenated)').
- **V27** (confirmed, high): https://raw.githubusercontent.com/electron/electron/main/docs/tutorial/fuses.md L56-66; docs/api/environment-variables.md L27-64, L101-105; https://releases.electronjs.org/releases.json (44.8.0 node 24.22.0 chrome 152.0.7977.167).
- **V28** (confirmed, high): https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/amazon-mq-release-notes.md; oauth-for-amq-for-rabbitmq.md; configure-mtls.md ('Strict mTLS is not supported for the management API'); ldap-for-amq-for-rabbitmq.md; rabbitmq-supported-protocols.md; private-networking.md L159.
- **V29** (nuanced, high): https://raw.githubusercontent.com/mscdex/ssh2/v1.17.0/README.md (Connection hopping, agent/agentForward, host key algorithms); https://github.com/mscdex/ssh2/issues/1495; https://registry.npmjs.org/ssh2/1.17.0 (scripts.install, optionalDependencies cpu-features/nan).
- **V30** (nuanced, high): undici@v8.12.2 docs/docs/api/Socks5ProxyAgent.md ('introduced_in=v7.23.0', 'Stability: 1 - Experimental', 'DNS resolution is delegated to the proxy'), ProxyAgent.md; https://raw.githubusercontent.com/JoshGlazebrook/socks/master/README.md; amqplib lib/connect.js@v2.2.0 L171-175 (`net.connect(sockopts)` / `tls.connect(sockopts)`).
- **V31** (nuanced, medium): https://raw.githubusercontent.com/kubernetes-client/javascript/2.0.0/src/portforward.ts L22-46; src/config.ts (ExecAuth, AzureAuth, GCP, OpenIDConnectAuth); rabbitmq-website kubernetes/operator/using-operator/index.md L143-144, L1137-1144, L1273-1296.
- **V32** (nuanced, high): coders51/rabbitmq-stream-js-client@v1.1.0 src/client.ts L889-914, L979-1003, L1160-1170; version-4.3/stream-connections.md (Advertised Host and Port; Client Workaround With a Load Balancer); version-4.3/stream.md L196-212.
- **V33** (nuanced, high): rabbit_stream_queue.erl@v4.3.6 consume/3 L352-398 (`{undefined, _} -> {error, precondition_failed, "stream ~ts does not have a running replica on the local node"`); same message @v3.13.7 L333; version-4.3/streams.md L123-125, L404-413.
- **V34** (confirmed, high): https://raw.githubusercontent.com/electron/electron/main/docs/api/safe-storage.md L11-25, L80-95; docs/api/safe-storage.md@44-x-y (Process: Main; async recommended).
- **V35** (confirmed, high): https://raw.githubusercontent.com/Brooooooklyn/keyring-node/main/README.md L20-43; https://registry.npmjs.org/@napi-rs/keyring.
- **V36** (confirmed, high): https://developer.hashicorp.com/vault/docs/secrets/rabbitmq; https://developer.hashicorp.com/vault/api-docs/secret/rabbitmq (username_template, password_policy, verify_connection, vhost_topics); https://openbao.org/docs/secrets/rabbitmq/.
- **V37** (refuted, high): https://chromestatus.com/feature/5197681148428288 (ship stage desktop_first 147); https://developer.chrome.com/blog/local-network-access (2025 text lists WebSockets as not yet gated); https://www.phoronix.com/news/Chrome-147-Stable-Released; https://github.com/electron/electron/issues/48655 (comments 2025-11-24, 2026-06-24).
- **V38** (confirmed, high): https://developer.chrome.com/blog/local-network-access (Update 2025-09-29: 'launching in Chrome 142').
- **V39** (confirmed, high): https://aws.amazon.com/security/security-bulletins/2026-070-aws/.
- **V40** (nuanced, high): rabbitmq-website client-libraries/amqp-client-libraries.md L34; coders51/rabbitmq-amqp-js-client@v1.0.0 package.json and src/environment.ts L14-33, src/rhea_wrapper.ts L55-138; https://raw.githubusercontent.com/amqp/rhea/main/package.json (prepare); https://github.com/amqp/rhea/compare/3.0.5...main (ahead_by=3).
- **V41** (confirmed, high): release-notes/4.1.0.md L45-60, L172-186, L259-262; version-4.3/troubleshooting-oauth2.md L34-83; rabbit_amqp_reader.erl@v4.0.9 `-define(INITIAL_MAX_FRAME_SIZE, 8192)` ('Allow for potentially large sets of tokens during the SASL exchange'); amqplib CHANGELOG v0.10.6.
- **V42** (confirmed, high): rabbit_auth_backend_oauth2.erl@v4.3.6 L219-224 ensure_same_username/3; rabbit_stream_reader.erl@v4.3.6 'Not allowed to change username'.
- **V43** (confirmed, high): rabbit_mgmt_wm_auth.erl@v3.13.7 L128 `to_tuple(oauth_client_secret, ManagementProps)`, L150-151; @v4.2.8 L186; @v4.3.6 comments 'The OAuth 2 client secret must never reach the browser', adjust_client_secret/2; release-notes/4.2.9.md L167-170, 4.3.3.md L186-189.
- **V44** (confirmed, high): version-4.3/oauth2.md variables table (hostname_verification default none); https://raw.githubusercontent.com/rabbitmq/rabbitmq-oauth2-tutorial/next/conf/okta/rabbitmq.conf.tmpl; version-4.3/access-control.md L983-990; release-notes/4.0.1.md L144-147; Amazon MQ OAuth doc ('doesn't perform token revocation checks').

## Report

# Enterprise sign-in, connectivity and threat model (verified 2026-10-16)

**Scope.** The engine is written in TypeScript and runs on Node 24 in three places:

- **Desktop:** an Electron 44.8.0 `utilityProcess`. Electron 44.8.0 bundles Node 24.22.0 and Chromium 152 ([releases.json](https://releases.electronjs.org/releases.json)).
- **Local web:** started with `npx` or as a Docker container.
- **Team server:** NestJS 12.

**RabbitMQ versions checked.** Source was read at the latest tags of each line: **v3.13.7, v4.0.9, v4.1.8, v4.2.9 and v4.3.6** ([tags](https://api.github.com/repos/rabbitmq/rabbitmq-server/tags)). For the next release I used the drafts on main ([4.4.0.md](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.4.0.md), 4.3.7.md and 5.0.0.md).

**How to read references.** `file@tag Lnn` points to a raw file at that tag, for example `https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_reader.erl`.

## 0. Findings that change the design

1. **Bearer tokens on the HTTP API work whenever the OAuth 2 backend is in the HTTP authentication chain.**
   - `management.oauth_enabled` only turns on the management UI's login button.
   - Code: `rabbit_web_dispatch_access_control.erl@v4.3.6` (`parse_credentials/2`, `get_auth_backends/0`).
2. **From 4.0.8 and 4.1.0, the HTTP API can have its own authentication chain** (`http_dispatch.auth_backends`, [#13467](https://github.com/rabbitmq/rabbitmq-server/pull/13467)).
   - A connection profile therefore needs separate HTTP and AMQP credentials.
3. **From 4.2.6 and 4.3.0, AMQP 0-9-1 connections are force-closed when their token expires.**
   - The close is `320 CONNECTION_FORCED "credential expired"`. Since the same change, update-secret also re-checks consumers ([#16092](https://github.com/rabbitmq/rabbitmq-server/pull/16092), commit [501ad947](https://github.com/rabbitmq/rabbitmq-server/commit/501ad947cd6bbcc9486fe96e0d073992bfe52cc4)).
   - Earlier versions never disconnect. Consumers keep running on an expired token.
   - The [4.3 docs](https://www.rabbitmq.com/docs/oauth2#token-expiration) still describe the old behaviour.
4. **AMQP 1.0 token renewal (`PUT /auth/tokens`) needs 4.1+** ([#12599](https://github.com/rabbitmq/rabbitmq-server/pull/12599)).
   - On 4.0, AMQP 1.0 connections are closed at expiry with no way to renew.
5. **Tokens over roughly 4 KB fail on the HTTP API with 431.** Cowboy's default `max_header_value_length` is 4096 bytes.
   - No `rabbitmq.conf` key changes this; only `advanced.config` does ([#13761](https://github.com/rabbitmq/rabbitmq-server/issues/13761), [Cowboy manual](https://raw.githubusercontent.com/ninenines/cowboy/master/doc/src/manual/cowboy_http.asciidoc)).
   - Prefer `Bearer` over Basic-with-token: base64 makes the Basic header about 33% longer.
6. **The `?token=` exception for `/api/definitions` described in the docs is not in the code.** All versions use the normal Authorization header for that endpoint.
7. **`GET /api/auth` is unauthenticated, which makes it a discovery source for SSO.**
   - It returns the issuer, client_id, scopes, resource servers and endpoint parameters.
   - Before 4.2.9 and 4.3.3 it also leaked `oauth_client_secret`.
8. **Client support (details in §2.3):**
   - amqplib 2.2.0: `updateSecret` and EXTERNAL.
   - rabbitmq-amqp-js-client 1.0.0: `refreshToken`, no EXTERNAL option, rhea pulled from GitHub.
   - rabbitmq-stream-js-client 1.1.0: EXTERNAL; only a fixed-endpoint load-balancer resolver; no token re-authentication. Its "1.1.0 OIDC" changelog item is npm trusted publishing, not OAuth.
9. **Streams behind tunnels.**
   - The stream protocol through a single tunnel to a multi-node cluster is fragile.
   - AMQP-based stream reads avoid the leader requirement, but the connected node must host a member of the stream (`rabbit_stream_queue.erl@v4.3.6` L352-398).
10. **Browser and Electron.**
    - Chrome's Local Network Access gates public→loopback fetch since Chrome 142 and **WebSockets since Chrome 147** ([chromestatus](https://chromestatus.com/feature/5197681148428288)).
    - It is hard-disabled in Electron ([electron#48655](https://github.com/electron/electron/issues/48655)), so the desktop app must not rely on it.
    - Use a MessagePort between UI and engine instead of loopback TCP.
11. **MCP.** The specification forbids passing a client's token through to downstream services, in both [2025-11-25](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2025-11-25/basic/authorization.mdx) and the current [2026-07-28](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/basic/authorization/security-considerations.mdx) revision.
    - [CVE-2026-18655](https://aws.amazon.com/security/security-bulletins/2026-070-aws/) shows how prompt injection can redirect broker credentials and OAuth tokens to an attacker's host.

## 1. Recommended identity and connectivity architecture

### 1.1 Engine subsystems shared by all modes

**A. `CredentialProvider` plugins, chosen per connection profile.** Each protocol (HTTP, AMQP 0-9-1, AMQP 1.0, stream) can use a different provider.

| Provider | Use | Notes |
| --- | --- | --- |
| `password` | internal, LDAP or HTTP-backend users | Never put credentials in URIs. Pass them as credential objects. |
| `oauth-pkce-loopback` | desktop and local-web SSO | System browser, PKCE S256, `state` and `nonce`. Check `iss` per RFC 9207 when the server returns it. The redirect listener runs on `http://127.0.0.1:0/cb`. Uses openid-client 6.8.8 ([README](https://raw.githubusercontent.com/panva/openid-client/v6.8.8/README.md)). |
| `oauth-device-code` | headless, Docker, SSH sessions | Entra, Keycloak, Okta and Auth0 all offer device flow. |
| `oauth-client-credentials` | team-server service accounts | Entra puts app roles assigned to the service principal into `roles`. |
| `token-command` | enterprises with existing CLIs | Runs an external command that prints a token, like a kubeconfig exec plugin: `az account get-access-token --resource api://...`, `kubelogin`, a vendor CLI. No OAuth client registration is needed. |
| `static-token` | manual paste | Shows the token's expiry. |
| `x509` | mTLS | SASL EXTERNAL for AMQP and stream. For HTTPS, the certificate is transport only, plus Basic or Bearer. |
| `vault-dynamic` | Vault or OpenBao RabbitMQ engine | Leased broker users ([Vault](https://developer.hashicorp.com/vault/docs/secrets/rabbitmq), [OpenBao](https://openbao.org/docs/secrets/rabbitmq/)). |
| `delegated-user` | team server only | The signed-in user's access token for the broker's audience (§1.4). |

**B. `TokenManager`.** One per (identity, issuer, audience). Algorithm in §2.4.

**C. `Dialer`.** Every outbound socket goes through one dialer that applies the SSRF/egress policy and returns a Duplex stream:

```
direct | socks5(socks 2.8.10) | httpConnect(undici Client.connect) | ssh(ssh2: jump chain via `sock`)
| systemSsh(`ssh -W host:port`, honours ~/.ssh/config, OpenSSH certs, FIDO keys, ProxyJump)
| k8sPortForward(@kubernetes/client-node 2.0.0 or `kubectl port-forward`) | (optional) awsSsm(`aws ssm start-session`)
```

How the socket reaches each library:

- **amqps (amqplib):** `tls.connect({socket})`. amqplib passes `socketOptions` straight through.
- **undici:** a custom `connect` function, or `connect` options ([connect.js@v8.12.2](https://raw.githubusercontent.com/nodejs/undici/v8.12.2/lib/core/connect.js) L92-134).
- **rhea used directly:** `connection_details().connect` ([rhea connection.js](https://raw.githubusercontent.com/amqp/rhea/main/lib/connection.js) L332).
- **Plain-TCP amqplib and the stream client:** they cannot take a supplied socket. Use a per-connection Unix-socket or pipe forwarder (Node's `net.connect({path})`; amqplib passes `path` through), with loopback TCP as a last resort. Also send upstream PRs for a socket-factory hook.
- **Tunnels to an IP address:** always pass `servername` and `checkServerIdentity`. amqplib only sets `servername` itself when the host is not an IP ([connect.js@v2.2.0](https://raw.githubusercontent.com/amqp-node/amqplib/v2.2.0/lib/connect.js) L103, L136).

**D. `TrustStore`.**

- At engine start, call `tls.setDefaultCACertificates([...bundled, ...system, ...orgCAs])`. This needs Node 24.5+; `tls.getCACertificates('system')` needs 23.10+ ([tls.md](https://raw.githubusercontent.com/nodejs/node/v24.x/doc/api/tls.md)).
- Per profile, set `ca` = defaults + profile CAs. The `ca` option replaces the defaults rather than adding to them.
- Each profile has an "insecure" switch that shows a red banner when on and is never on by default.
- Show a TLS diagnostics panel (chain, SAN, expiry, SNI used).
- In Electron, `NODE_EXTRA_CA_CERTS` and `NODE_OPTIONS` are ignored once the nodeOptions fuse is disabled ([fuses.md](https://raw.githubusercontent.com/electron/electron/main/docs/tutorial/fuses.md) L56-66). Do everything programmatically.

**E. `SecretVault`.** Secrets are encrypted with AES-256-GCM using a data key (DEK); the key that wraps the DEK depends on the mode (§4).

### 1.2 Desktop (Electron, engine in `utilityProcess`)

**UI↔engine transport.** Use `MessageChannelMain`: main forks the engine, sends `port1` to it and `port2` to the renderer ([utility-process.md](https://raw.githubusercontent.com/electron/electron/main/docs/api/utility-process.md) L79-100). There is then no TCP listener, so no DNS rebinding, no CSRF, no CORS and no exposure to LNA. Keep a transport-agnostic RPC layer in Angular, with a MessagePort adapter for desktop and a WebSocket adapter for local web.

**If the loopback HTTP+WS transport is kept anyway:**

- Bind `127.0.0.1:0`.
- Use a 256-bit per-launch token, delivered through MessagePort or preload. Never put it in argv: process command lines are readable by other users on Linux.
- Accept only an exact `Host` of `127.0.0.1:<port>`.
- Accept only the Origin of the app's own `app://` scheme.
- Require `Authorization: Bearer`; use no cookies.
- For WebSockets, carry the token in the subprotocol (the [Kubernetes precedent](https://github.com/kubernetes/kubernetes/blob/master/staging/src/k8s.io/apiserver/pkg/authentication/request/websocket/protocol.go) is `base64url.bearer.authorization.k8s.io.`) or in a one-time ticket, and check Origin on upgrade.
- Reject `Sec-Fetch-Site: cross-site`.

**CLI and MCP.** A stdio MCP shim, started by the AI client, talks to the engine over a Unix domain socket or Windows named pipe protected by OS permissions. It presents a scoped capability token (read-only by default), never TCP.

**HTTPS to the management API.** Default to Electron `net.fetch` inside the utility process. It is Chromium's network stack ([net.md](https://raw.githubusercontent.com/electron/electron/main/docs/api/net.md)), which gives:

- system proxy, PAC and WPAD;
- NTLM, Kerberos and Negotiate proxy authentication;
- the OS trust store;
- client certificates on smartcards or TPMs, via `respondToAuthRequestsFromMainProcess` and `app#select-client-certificate`.

Fall back to undici. For raw AMQP TCP, discover proxies with `session.resolveProxy()`.

**Broker SSO flow.**

1. Call `GET /api/auth`.
2. Show the issuer and client_id and ask the user to confirm. Pin the issuer to the profile.
3. Run PKCE with a loopback redirect in the **system browser**. Embedded webviews are forbidden by [RFC 8252 §8.12](https://www.rfc-editor.org/rfc/rfc8252).
4. Request the broker's scopes and endpoint parameters, for example Auth0 `audience` or Entra `api://…/scope`.

Prefer a dedicated public client registration. Reusing the management UI's client works only after the IdP admin adds a loopback redirect, and on Entra it must be the "Mobile and desktop applications" platform, not SPA ([reply-url](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url)).

**Secrets.** Wrap the DEK with `safeStorage.encryptStringAsync` in main. Electron 44 recommends the async API, and main-branch docs say the sync API is removed in Electron 46 ([safe-storage.md](https://raw.githubusercontent.com/electron/electron/main/docs/api/safe-storage.md)). Alternatively, call `@napi-rs/keyring` directly in the engine. If `getSelectedStorageBackend()==='basic_text'`, or the keyring falls back to keyutils, require a master password.

**Hardening.**

- Fuses: RunAsNode, NodeOptions and NodeCliInspect off; ASAR integrity and OnlyLoadAppFromAsar on.
- Renderer: sandbox, contextIsolation, a strict CSP, `setWindowOpenHandler` deny, and `shell.openExternal` only for allow-listed URLs.
- Signed builds and signed updates.

### 1.3 Local web (`npx` / Docker)

- Same engine and UI, using the WebSocket transport.
- **Binding:**
  - Bind `127.0.0.1` by default.
  - Refuse `0.0.0.0` or `::` unless real authentication (OIDC or an admin password) and TLS are configured.
- **Login:**
  - Print a tokenised URL with the token in the `#fragment`, so it stays out of logs and `Referer`, as [Jupyter](https://raw.githubusercontent.com/jupyter-server/jupyter_server/main/docs/source/operators/security.rst) does.
  - The UI keeps the token in memory and sends it as a Bearer header.
- **Request checks:**
  - Allow-list `Host` (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost` and configured names) to block DNS rebinding.
  - Check Origin and `Sec-Fetch-*`.
  - Accept JSON bodies only; nothing changes state on GET.
- **Docker:**
  - Document `-p 127.0.0.1:PORT:PORT`. Published ports are "insecure by default" and reachable from outside ([port publishing](https://docs.docker.com/engine/network/port-publishing/)), and Docker traffic bypasses ufw ([packet filtering](https://docs.docker.com/engine/network/packet-filtering-firewalls/)).
  - Inside the container the peer address is never loopback, so always require the token there.
- **LNA:** Chrome ≥142/147 prompts before public sites reach loopback. Treat this as defence in depth, not a control.
- **Pinning:** pin versions in docs (`npx <pkg>@x.y.z`) and publish with provenance.

### 1.4 Team server (NestJS, multi-user)

**User login.**

- OIDC authorization code + PKCE as a confidential client, using the BFF pattern: tokens stay on the server ([draft-ietf-oauth-browser-based-apps-27](https://datatracker.ietf.org/doc/draft-ietf-oauth-browser-based-apps/)).
- `__Host-` session cookie with SameSite=Lax plus a CSRF token.
- Group or app-role claims map to tool roles; SCIM is optional.

**Broker credential mode, chosen by an admin per connection:**

| Mode | When | Who enforces permissions | Audit attribution on the broker |
| --- | --- | --- | --- |
| **Delegated OAuth** (preferred; Headlamp-like) | broker runs `rabbitmq_auth_backend_oauth2` with the same or a trusted IdP | the **broker** (user's scopes), and the tool's RBAC on top: the effective right is the intersection | events name the user per `preferred_username_claims`. The HTTP access log names the user only from 4.3.3 |
| **Vault/OpenBao dynamic** | broker has an internal backend | broker (role's permissions) and the tool's RBAC | the generated user, with `username_template` embedding the user. Map it back in our audit |
| **Personal credentials** | LDAP brokers | broker (LDAP groups) and the tool's RBAC | the user |
| **Service account** | fallback | **the tool's RBAC only** | the service account. Put the user ID in the AMQP `connection_name`; our audit log is the record of truth |

**Delegated OAuth mechanics.**

- At sign-in, also obtain an access token for the broker's audience. Entra issues one resource per access token, so use a separate token request or the multi-resource refresh token. Keycloak can mint multi-audience tokens through audience mappers.
- Alternatively, exchange tokens with RFC 8693: Keycloak ≥26.2 supports [standard token exchange](https://www.keycloak.org/2025/05/standard-token-exchange-kc-26-2); on Entra, use the On-Behalf-Of flow.
- Forward **access tokens only, never ID tokens.** RabbitMQ does not check token type, and Headlamp forwards `id_token` by default ([Headlamp OIDC](https://headlamp.dev/docs/latest/installation/in-cluster/oidc)).
- Keep **per-user connection pools** keyed by (user, broker, vhost, protocol). A connection cannot change username ([`ensure_same_username/3`](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_auth_backend_oauth2/src/rabbit_auth_backend_oauth2.erl)).
- Refresh tokens with update-secret on AMQP 0-9-1 and `PUT /auth/tokens` on AMQP 1.0; reconnect stream connections.
- Store refresh tokens envelope-encrypted and revoke them at logout.

**Background jobs** (alerts, throttled DLQ replay) run under explicit service identities, or a user's offline token with "job X on behalf of Y" recorded in audit.

**Own audit log:** append-only, recording who, what, broker, vhost, before/after, approval and request ID. Correlate it with broker events from `amq.rabbitmq.event` (`user_who_performed_action`) and export to SIEM.

**Isolation.**

- Exclusive and tap queues are per session.
- Message bodies are never cached across users.
- Message decoding runs in worker threads with `resourceLimits` and size caps.

### 1.5 MCP / AI surface

- **Desktop:** stdio MCP shim → engine over the Unix socket or pipe.
- **Team server:** `/mcp` is its own OAuth resource:
  - Protected Resource Metadata (RFC 9728), with audience = MCP URL (RFC 8707).
  - It accepts only tokens issued to itself.
  - It maps the token subject to a tool user, then uses that user's broker credential mode (§1.4).
  - It never forwards the MCP token.
- **Tools:**
  - Connections are referenced only by **opaque IDs created by humans**. The model can never supply hosts, URLs or credentials; that is the CVE-2026-18655 lesson.
  - Mutating tools are off by default and require human approval.
  - Payloads are returned as quoted, size-capped, control-character-stripped data, with secret-looking headers masked.
  - Model output is rendered as text: no remote images, CSP `img-src 'self'`.

## 2. Matrices

### 2.1 Authentication method × protocol

| Method | HTTP API (15672/15671) | AMQP 0-9-1 | AMQP 1.0 | Stream (5552/5551) |
| --- | --- | --- | --- | --- |
| Internal user + password | `Basic`; refused when `management.disable_basic_auth=true` | PLAIN / AMQPLAIN | SASL PLAIN (native 4.0+; 3.13 uses the `rabbitmq_amqp1_0` plugin) | PLAIN |
| LDAP / HTTP backend (+cache) | same as above, relayed. HTTP may use a different chain from 4.0.8/4.1 | PLAIN | PLAIN | PLAIN |
| OAuth 2.0 JWT | `Authorization: Bearer <jwt>` any time the backend is in the HTTP chain; or `Basic ignored:<jwt>` unless basic is disabled; header limit 4096 bytes by default (431) | PLAIN with the JWT as password, username ignored; renewal by `connection.update-secret`; pre-auth frame 4096 bytes (≤4.0) or 8192 bytes (4.1+) | PLAIN with the JWT; renewal by `PUT /auth/tokens` (4.1+) | PLAIN with the JWT; renewal by SASL re-authentication on the open connection, same username (3.13+) |
| Opaque tokens / introspection | Tanzu only ([#8662](https://github.com/rabbitmq/rabbitmq-server/issues/8662)) | Tanzu only | Tanzu only | Tanzu only |
| X.509 (`rabbitmq_auth_mechanism_ssl`) | **not a login method**: only transport mTLS (`management.ssl.verify`, `fail_if_no_peer_cert`), plus Basic or Bearer | SASL EXTERNAL | SASL EXTERNAL | SASL EXTERNAL |
| ANONYMOUS (default since 4.0, logs in as `anonymous_login_user` = guest, which is loopback-only) | n/a | yes, by default | yes, by default | not verified |
| Vault/OpenBao dynamic | as an internal user | as internal | as internal | as internal |

Sources: [oauth2](https://www.rabbitmq.com/docs/oauth2), [management](https://www.rabbitmq.com/docs/management), [access-control](https://www.rabbitmq.com/docs/access-control), `rabbit_web_dispatch_access_control.erl@v4.3.6`, [4.0.1 release notes](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.0.1.md) L144-147, and the [x509 plugin README](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_auth_mechanism_ssl/README.md).

### 2.2 Behaviour × RabbitMQ version

| Capability / behaviour | 3.13.7 | 4.0.x | 4.1.x | 4.2.x | 4.3.x | 4.4 draft |
| --- | --- | --- | --- | --- | --- | --- |
| HTTP Bearer (no `oauth_enabled` needed) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Separate HTTP authentication chain | ✗ | from 4.0.8 | ✓ | ✓ | ✓ | ✓ |
| Multiple resource servers and providers; issuer-based discovery | ✓ (3.13.0, [#10012](https://github.com/rabbitmq/rabbitmq-server/pull/10012)) | ✓ | ✓ | ✓ | ✓ | ✓ plus strict discovery validation (UAA breaks; `auth_oauth2.discovery.verify_issuer/verify_https_endpoints`) |
| Discovery path/params configurable; nested scope claims; scope aliases in rabbitmq.conf | ✗ | ✗ | ✓ ([4.1.0](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.1.0.md)) | ✓ | ✓ | ✓ plus regex scope extraction ([#16196](https://github.com/rabbitmq/rabbitmq-server/pull/16196)) |
| UI sends default `resource`/`audience` | yes | yes | **no**; must configure (#12235) | no | no | no |
| AMQP 0-9-1 pre-auth frame size | 4096 | 4096 | 8192 | 8192 | 8192 | 8192 |
| AMQP 0-9-1 at token expiry | not closed; new operations fail after the cache clears (≤60 s); consumers continue | same | same | ≤4.2.5 same; **≥4.2.6 closed** (320) | **closed** | closed |
| AMQP 0-9-1 update-secret re-checks consumers | ✗ | ✗ | ✗ | ≥4.2.6 | ✓ | ✓ |
| AMQP 1.0 at expiry / renewal | plugin (not verified) | closed, no renewal | renew via PUT /auth/tokens, closed otherwise | same | same | same |
| Stream protocol | re-authentication and close-at-expiry | ✓ | ✓ | ✓ | ✓ | ✓ |
| Auth cache passes token expiry through ([#16100](https://github.com/rabbitmq/rabbitmq-server/pull/16100)); JWT scope cap 2048 | ✗ | ✗ | ✗ | ≥4.2.6 | ✓ | ✓ |
| HTTP access-log username for OAuth | `oauth_client_id` | same | same | same (4.2.9 too) | **resolved user ≥4.3.3** | ✓ |
| Unauthenticated `/api/auth` leaks `oauth_client_secret` | yes | yes | yes | ≤4.2.8 | ≤4.3.2 | no |
| 431 for headers >4096 bytes (no `rabbitmq.conf` key) | yes | yes | yes | yes | yes | yes |
| `GET /api/auth/hash_password/{pw}` → `POST /api/auth/hash_password` |  |  |  |  |  | changed in 4.4 |

Evidence:
- `rabbit_reader.erl@v4.3.6` L687-725; `rabbit_channel.erl@v4.1.8` L784-797.
- `deps/rabbit/Makefile@v4.1.8` L109 (`channel_tick_interval` 60000).
- `rabbit_amqp_reader.erl@v4.0.9` and `@v4.3.6` L243-245; `rabbit_amqp_management.erl@v4.3.6` (auth/tokens).
- `rabbit_stream_reader.erl@v4.3.6`; [3.13.0 release notes](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/3.13.0.md) L455-462.
- [4.2.6](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.2.6.md), [4.3.3](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.3.3.md) and [4.2.9](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.2.9.md) release notes.
- `rabbit_mgmt_wm_auth.erl@v3.13.7` L128 and L150.

### 2.3 Node client-library support (current versions)

| Capability | amqplib **2.2.0** (0-9-1) | rabbitmq-amqp-js-client **1.0.0** (1.0) | rhea **3.0.5** (1.0, raw) | rabbitmq-stream-js-client **1.1.0** |
| --- | --- | --- | --- | --- |
| JWT as password | ✓ | ✓ (`oauth:{token}`) | ✓ | ✓ |
| Renew in place | `updateSecret()` ✓ | `refreshToken()` → PUT /auth/tokens (broker 4.1+) | manual | ✗ → reconnect |
| Reconnect uses the fresh token | only with a custom `credentials` object (`response()` runs on every connect) | ✓ (password bridge) | n/a | manual |
| SASL EXTERNAL | `credentials.external()` | ✗ (not exposed) | `enable_sasl_external` plus cert | `mechanism:'EXTERNAL'` (0.6.1+) |
| TLS options | full `tls.connect` options incl. `socket`, `servername`, `lookup` | typed subset; extra keys pass at runtime | full | `ssl` object passed as-is |
| Supply a socket or tunnel | amqps ✓ (`socket`); plain ✗ | ✗ | ✓ (`connection_details.connect`) | ✗ |
| Address translation for advertised hosts | n/a | n/a | n/a | load-balancer mode only (fixed endpoint, retry loop) |
| Supply chain | 0 dependencies, provenance | provenance; `rhea: github:amqp/rhea` | npm release lacks 2 decoder-hardening commits | provenance |

Sources: [amqplib connect.js](https://raw.githubusercontent.com/amqp-node/amqplib/v2.2.0/lib/connect.js), [credentials.js](https://raw.githubusercontent.com/amqp-node/amqplib/v2.2.0/lib/credentials.js), [CHANGELOG](https://raw.githubusercontent.com/amqp-node/amqplib/v2.2.0/CHANGELOG.md), [amqp-js environment.ts](https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/src/environment.ts), [rhea_wrapper.ts](https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/src/rhea_wrapper.ts), [management.ts](https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/src/management.ts), [stream client.ts](https://raw.githubusercontent.com/coders51/rabbitmq-stream-js-client/v1.1.0/src/client.ts), [rhea compare](https://github.com/amqp/rhea/compare/3.0.5...main), and npm provenance from registry `dist.attestations`.

### 2.4 Token-refresh algorithm (engine)

```
acquire(token): parse exp/iat (no signature check needed client-side); record username claim
preflight: len("Bearer "+jwt) > 4000 → warn "HTTP 431 likely" (suggest lean tokens / app roles / advanced.config)
           AMQP 0-9-1 PLAIN response > 4000 (broker ≤4.0) or > 8000 (4.1+) → warn frame_too_large
schedule refresh at iat + 0.75·(exp−iat) (≥60 s before exp, jitter ±10%)
on refresh(newToken):
  assert username(newToken) == username(old)   // broker rejects mismatch_username_after_token_refresh
  HTTP: swap header; on 401 → one refresh + retry for idempotent requests only
  AMQP 0-9-1: await conn.updateSecret(Buffer.from(newToken), 'refresh'); failure → reconnect via lazy credentials
  AMQP 1.0: broker ≥4.1 → connection.refreshToken(newToken); broker 4.0 → planned reconnect before exp
  Stream: open new connection with newToken, resume consumers at stored offsets, close old
on refresh failure near exp: broker ≤4.2.5 (0-9-1) → engine itself cancels its taps/consumers at exp
                             (avoid zombie consumers); ≥4.2.6 → expect 320 CONNECTION_FORCED
```

## 3. Network paths

### 3.1 SSH bastions

Use ssh2 1.17.0 ([README](https://raw.githubusercontent.com/mscdex/ssh2/v1.17.0/README.md)):

- **Jump chains:** `forwardOut` gives a stream, which becomes `sock` for the next hop.
- **Agents:** OpenSSH socket, Pageant, and the Windows OpenSSH pipe; `agentForward`.
- **Keys and MFA:** ed25519, ECDSA and RSA keys; keyboard-interactive login for MFA.
- **Host keys:** trust on first use, with `known_hosts` import.

ssh2 has **no OpenSSH certificate authentication** ([#1495](https://github.com/mscdex/ssh2/issues/1495)). Offer a "system OpenSSH" mode (`ssh -W host:port bastion`), which inherits ProxyJump, certificates, FIDO keys and GSSAPI from `~/.ssh/config`. AWS's own advice for private Amazon MQ brokers is `ssh -D` (SOCKS5) through a bastion ([configuring-private-broker](https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/configuring-private-broker.md)).

**Warning:** an SSH tunnel that ends on the broker host, or a Kubernetes port-forward, makes connections look local. The guest user's loopback-only restriction and 4.0+ ANONYMOUS→guest then work for **any local process** that can reach the forwarded port. Avoid TCP forwarders; prefer in-process streams or permission-protected Unix sockets.

### 3.2 Proxies

- **HTTP API:** undici `ProxyAgent` with `requestTls` and `proxyTls`. `Socks5ProxyAgent` is experimental and resolves DNS at the proxy, so our IP checks cannot inspect the resolved address. On the team server, only use admin-defined proxies ([Socks5ProxyAgent.md](https://raw.githubusercontent.com/nodejs/undici/v8.12.2/docs/docs/api/Socks5ProxyAgent.md)).
- **AMQP TCP:** `socks` 2.8.10 ([README](https://raw.githubusercontent.com/JoshGlazebrook/socks/master/README.md)) or an HTTP CONNECT tunnel.
- **Desktop:** Electron `net` and `session.resolveProxy()` give system and PAC proxies plus Kerberos/NTLM.

### 3.3 Kubernetes

[PortForward](https://raw.githubusercontent.com/kubernetes-client/javascript/2.0.0/src/portforward.ts) targets a pod, one port per call. Discovery:

- the `RabbitmqCluster` custom resource;
- pods `<name>-server-N`;
- the admin secret `<name>-default-user`, read only with explicit consent and Kubernetes RBAC ([operator docs](https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/kubernetes/operator/using-operator/index.md)).

### 3.4 Amazon MQ

- Private brokers sit behind PrivateLink VPC endpoints, and Route 53 resolves them only inside the VPC.
- Reach them from outside through a bastion (SSH or SOCKS), SSM port forwarding or a VPN.
- Keep SNI and hostname checks on `b-xxxx.mq.<region>.on.aws` through any tunnel ([private-networking](https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/private-networking.md)).
- The supported-protocols page lists AMQP 0-9-1, AMQP 1.0 and JMS, but no stream protocol, so browse streams over AMQP ([supported protocols](https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-supported-protocols.md)).

### 3.5 Streams behind tunnels and NAT

- **Broker side:** `advertised_host` and `advertised_port` are returned without validation ([stream.md](https://www.rabbitmq.com/docs/stream#advertised-host-port)). The docs say not to set them behind load balancers ([stream-connections](https://www.rabbitmq.com/docs/stream-connections)).
- **JS client:** only fixed-endpoint retry loops exist.
- **Our approach:**
  1. Read streams over **AMQP 1.0 or 0-9-1 with `x-stream-offset` and filters** through the single tunnel.
  2. Use the stream protocol only when nodes are directly reachable, or with **per-node tunnels plus an address-translation function**. That function needs an upstream PR or fork; the Java client's `AddressResolver` is the model.
  3. On "does not have a running replica on the local node", tell the user which nodes host the stream.

## 4. Credential storage

- **Desktop:**
  - Per-secret AES-256-GCM in SQLite. The DEK is wrapped by OS storage: safeStorage async API in main (Keychain, DPAPI, libsecret/kwallet) or `@napi-rs/keyring` in the engine ([README](https://raw.githubusercontent.com/Brooooooklyn/keyring-node/main/README.md)).
  - On Linux, `basic_text` uses a "hardcoded plaintext password", and keyutils is "in-memory and will not persist across reboots". In both cases use a master password with scrypt (`crypto.argon2` from Node 24.7+ if Electron supports it).
  - Windows DPAPI does not protect from other apps running as the same user.
  - Never store OAuth tokens in `localStorage`. The official UI does ([helper.js@v4.3.6](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/priv/www/js/oidc-oauth/helper.js) L147).
- **Team server:** envelope encryption, with a data key per secret or tenant and a key-encryption key from cloud KMS, Vault Transit or OpenBao Transit, or from an env/file for small installs. Rotate keys; never log secrets.
- **Vault/OpenBao dynamic credentials** remove long-lived broker passwords, with leases and `username_template` ([Vault API](https://developer.hashicorp.com/vault/api-docs/secret/rabbitmq)).
- **Redaction everywhere:** AMQP URIs, Authorization headers, `x-` headers carrying JWTs, and shovel/federation URIs in definitions. RabbitMQ main has `redact_uris_in_definition` ([rabbit_shovel_parameters.erl](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_shovel/src/rabbit_shovel_parameters.erl)), but which responses it covers is unverified.

## 5. Identity-provider and hosting gotchas

**Entra ID**

1. The token version comes from the resource app's `requestedAccessTokenVersion`. v2: `aud` = API client-ID GUID. v1: client ID or `api://…`. Align `resource_server_id` and the scope prefix with `aud`, or you get 'Not authorized' ([access-tokens](https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens), [#13887](https://github.com/rabbitmq/rabbitmq-server/discussions/13887)).
2. Expose an API scope and request **only** it, plus `openid profile offline_access`. Graph scopes produce a token RabbitMQ cannot validate ([Entra example](https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/versioned_docs/version-4.3/oauth2-examples-entra-id/index.md)).
3. Permissions:
   - App roles arrive in `roles` → `additional_scopes_key = roles`.
   - Delegated scopes arrive in `scp`, a space-separated string.
   - With custom signing keys, set `auth_oauth2.discovery_endpoint_params.appid` (4.1+).
4. `sub` is pairwise, so audit shows opaque IDs. Use `preferred_username` (v2), `upn`/`unique_name` (v1) or `oid`. Groups overflow at 200 ([claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference)). Large tokens hit the 431 limit.
5. Since 4.1, do not send `resource` (Entra v2 rejects it) ([#12235](https://github.com/rabbitmq/rabbitmq-server/issues/12235)).
6. Redirects:
   - Use the "Mobile and desktop" platform; the port is ignored for localhost.
   - `http://127.0.0.1` needs a manifest edit; `[::1]` is unsupported.
   - SPA-type redirects require an Origin header at code redemption (AADSTS9002327) and get 24-hour refresh tokens; other clients get 90 days ([refresh-tokens](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens)).
7. Access tokens live 60–90 minutes ([configurable lifetimes](https://learn.microsoft.com/en-us/entra/identity-platform/configurable-token-lifetimes)).

**Keycloak**

1. Add an audience mapper (hardcoded claim) with `resource_server_id` ([Keycloak example](https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/versioned_docs/version-4.3/oauth2-examples-keycloak.md)).
2. Roles live in `realm_access.roles` and `resource_access.*`; nested paths need 4.1+ plus aliases.
3. Large tokens cause 431 ([#13761](https://github.com/rabbitmq/rabbitmq-server/issues/13761)). Keycloak 24+ "lightweight access tokens" strip roles unless mappers add them back.
4. Loopback redirects match any port ([RedirectUtils.java](https://raw.githubusercontent.com/keycloak/keycloak/main/services/src/main/java/org/keycloak/protocol/oidc/utils/RedirectUtils.java)). Client policies such as the Secure Redirect URIs Enforcer may block http loopback.

**Okta**

1. Use a custom authorization server (`/oauth2/default`).
2. The official RabbitMQ template sets `verify_aud = false`, which accepts any audience; lint it ([template](https://raw.githubusercontent.com/rabbitmq/rabbitmq-oauth2-tutorial/next/conf/okta/rabbitmq.conf.tmpl)).
3. `discovery_endpoint_path` may need `.well-known/oauth-authorization-server`.
4. Ephemeral loopback ports were historically unsupported ([Okta devforum](https://devforum.okta.com/t/loopback-interface-redirection-ephemeral-ports-wildcard-ports-in-localhost-redirect-uri/22197)). Fall back to fixed ports or the device flow.

**Auth0**

1. Send `audience=<resource_server_id>` on both the authorize and token requests. Since 4.1 the UI needs `management.oauth_*_endpoint_params.audience` ([template](https://raw.githubusercontent.com/rabbitmq/rabbitmq-oauth2-tutorial/next/conf/auth0/rabbitmq.conf.tmpl)).
2. Permissions arrive in `permissions` → `additional_scopes_key = permissions`.
3. Wildcard loopback ports were historically unsupported.

**UAA**

1. A client secret is needed to refresh, so public desktop clients must re-authenticate.
2. The 4.4 draft breaks discovery; set the `verify_issuer` / `verify_https_endpoints` flags.
3. Amazon MQ cannot use UAA, because it does not support a client secret.

**Google:** issues opaque tokens, so it is unsupported in open-source RabbitMQ ([Google example](https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/versioned_docs/version-4.3/oauth2-examples-google.md)).

**Generic RabbitMQ**

- `iss` is not validated.
- `hostname_verification` defaults to `none` for JWKS and discovery fetches.
- No revocation checks.
- Commercial-only: the IdP forward proxy ([commercial features](https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/src/pages/commercial-features.js)). Tanzu also has a stream browser in its UI.
- The auth cache did not cache reconnects in 4.x; fixed in the 4.4 draft ([#16255](https://github.com/rabbitmq/rabbitmq-server/issues/16255)). Avoid connection churn on LDAP/HTTP-backed brokers.

**Hosting**

- **Amazon MQ** ([release notes](https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/amazon-mq-release-notes.md)):
  - OAuth: no private-CA IdP certificates, no client secret, no static keys ([OAuth doc](https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/oauth-for-amq-for-rabbitmq.md)).
  - LDAP: LDAPS only; internet-reachable before the June 2026 private networking feature ([LDAP doc](https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/ldap-for-amq-for-rabbitmq.md)).
  - X.509 and mTLS need 4.2+, and strict mTLS is not available on the management API ([mTLS doc](https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/configure-mtls.md)).
  - Hide and protect the `monitoring-AWS-OWNED-DO-NOT-DELETE` user.
- **CloudAMQP:** OAuth on dedicated instances ≥3.13, configured through the console ([CloudAMQP docs](https://www.cloudamqp.com/docs/cloudamqp-oauth2.html)).
- **Kubernetes:** advertised stream hostnames do not resolve from laptops, and port-forwarded connections look local.
- **Docker:** see §1.3.

## 6. Threat model

| # | Threat | Applies to | Mitigation | Implemented in |
| --- | --- | --- | --- | --- |
| T1 | DNS rebinding / CSRF / cross-site WebSocket hijacking against the loopback engine | desktop (if HTTP), local web | MessagePort on desktop. On HTTP: exact Host allow-list, Origin and `Sec-Fetch-Site` checks, bearer token instead of cookies, WebSocket ticket or subprotocol token, JSON-only, no GET mutations. Precedent: MCP Inspector [CVE-2025-49596](https://www.recordedfuture.com/blog/anthropic-mcp-inspector-cve-2025-49596) | engine `transport` module (Fastify onRequest + upgrade hook); Electron main wiring |
| T2 | Other local processes or users reach engine ports or tunnel forwarders | desktop, local web | 256-bit token never in argv, env or URL query; Unix socket or pipe with OS permissions for CLI/MCP; in-process tunnel streams; forwarders accept only the expected connections and are short-lived | engine `dialer`, `ipc` |
| T3 | Tunnels or port-forwards make clients "local" (guest, ANONYMOUS) | desktop | warn on same-host tunnels; never use guest; advisor flags ANONYMOUS and guest | dialer, linting rules |
| T4 | Secrets at rest stolen (laptop, backups, DB dump) | all | AES-256-GCM vault with keychain- or KMS-wrapped DEK; master password on Linux basic_text or keyutils; KMS / Vault Transit on server; redaction in logs and exports | `secrets-*` packages |
| T5 | OAuth refresh-token theft or replay | desktop, server | RFC 9700 rotation or sender constraint; keychain storage; short access tokens. Brokers never revoke and ≤4.2.5 keeps consumers alive, so the engine cuts its own consumers at expiry | `TokenManager` |
| T6 | SSRF through user-supplied broker, OIDC, JWKS or Vault URLs | team server (also desktop via `/api/auth`) | admin allow-list of hosts, CIDRs and ports per environment; deny link-local, metadata, loopback and private ranges by default; connect-time DNS validation in a custom `lookup` (handle `all:true`) for net, tls and undici; no redirects; sanitized errors; egress NetworkPolicy or proxy; issuer pinning and user confirmation for broker-advertised IdPs | `dialer.policy`, `oidc-discovery` |
| T7 | Malicious or compromised broker (crafted frames, headers, payloads, HTML) | all | TLS verification on by default; decoder caps (pin rhea with the bounding fixes, header depth and size limits); render payloads as text; Angular sanitizer with `innerHTML` banned; CSP; Electron sandbox, navigation guards and `openExternal` allow-list | `codec`, UI, Electron main |
| T8 | Cross-user leakage on the team server | team server | per-user (delegated) or per-session connections; exclusive tap queues per session; no cross-user body cache; tenant-scoped IDs; worker `resourceLimits`; quotas | `session-manager` |
| T9 | Confused deputy / over-privileged service account | team server | deny-by-default tool RBAC on every action, intersected with broker permissions; separate read-only and write accounts; four-eyes approval for destructive operations | RBAC guard, approvals |
| T10 | Audit gaps (broker logs show the service account or client_id) | team server | own append-only audit log; user ID in AMQP `connection_name`; correlate broker events; warn on broker <4.3.3 or 4.2.x access-log attribution and Entra pairwise `sub` | `audit` module |
| T11 | MCP token passthrough / confused deputy | team server, desktop | MCP endpoint as its own OAuth resource (RFC 8707/9728); never forward tokens; use token exchange or OBO or stored delegated tokens; stdio locally | `mcp` module |
| T12 | Prompt injection through payloads or queue names leading to tool misuse or credential exfiltration ([CVE-2026-18655](https://aws.amazon.com/security/security-bulletins/2026-070-aws/)) | AI features | model can never set endpoints or credentials; read-only default; human approval for mutations; payload quoting, caps and control-character stripping; mask secrets; egress limits | `mcp`, `ai-policy` |
| T13 | Data exfiltration through AI output rendering | UI | plain-text rendering; no remote images (CSP `img-src 'self'`); no automatic link fetching | UI |
| T14 | Supply chain: npm takeovers ([debug/chalk 2025-09-08](https://endorlabs.com/learn/major-supply-chain-attack-compromises-popular-npm-packages-including-chalk-and-debug), [Shai-Hulud](https://content.govdelivery.com/accounts/USDHSCISA/bulletins/3f408db)), git dependencies, install scripts, AI-hallucinated packages ([arXiv 2406.10279](https://arxiv.org/abs/2406.10279)) | build | lockfile with integrity; `--ignore-scripts` plus explicit native rebuilds; pin `rhea` to a reviewed commit through overrides; `npm audit signatures`; dependency allow-list for coding agents; minimum release age; SBOM; signed containers and Electron builds and updates; Actions pinned by SHA | CI / repo policy |
| T15 | Electron runtime tampering | desktop | fuses, ASAR integrity, code signing and notarisation | electron-builder config |
| T16 | TLS MITM or broken corporate interception | all | system plus organisation CAs; profile pinning; set `servername` on tunnels; insecure mode needs explicit opt-in | `TrustStore` |
| T17 | Oversized tokens or frames (431, frame_too_large) | all | preflight size checks, prefer Bearer, guidance (app roles, lean tokens, advanced.config) | `TokenManager`, advisor |

## 7. Lab test plan

Run on Testcontainers with RabbitMQ 3.13.7, 4.0.9, 4.1.8, 4.2.5, 4.2.9, 4.3.2, 4.3.6 and main, against Keycloak 26 and an Entra test tenant:

1. Behaviour at token expiry and on update-secret, per protocol and version.
2. The 431 threshold for Bearer and for Basic.
3. Pre-auth frame limits with amqplib, rhea and the stream client.
4. `/api/definitions` with `?token=`.
5. `/api/auth` contents per version.
6. Stream reads through a single tunnel, over the stream protocol and over AMQP.
7. Electron 44: `tls.getCACertificates('system')`, `setDefaultCACertificates`, `crypto.argon2`, safeStorage async, and keychain prompts from the utilityProcess.
8. `net.fetch` client-certificate selection with a smartcard.
9. amqps through an ssh2 channel (`socket` option).
10. Kubernetes port-forward with client-node.
11. Loopback-port acceptance on Okta and Auth0.

## Design implications

- Build one identity subsystem in the engine with pluggable CredentialProviders: password, oauth-pkce-loopback, oauth-device-code, oauth-client-credentials, token-command, static-token, x509/EXTERNAL, vault-dynamic and delegated-user. Profiles must hold separate credentials for HTTP and AMQP/stream, because the HTTP API can use its own auth chain (http_dispatch.auth_backends, 4.0.8+/4.1+).
- Build broker SSO auto-configuration from the unauthenticated GET /api/auth (issuer, client_id, scopes, resource servers, endpoint params). Show the issuer to the user, pin it to the profile and check it against an allow-list, so a malicious broker cannot phish users or trigger SSRF.
- Desktop OAuth: use the system browser (never an embedded BrowserWindow), PKCE S256, and a 127.0.0.1 loopback redirect on an ephemeral port. Fall back to a list of registered fixed ports for Okta/Auth0, and to device-code. Document a dedicated public client registration per IdP; on Entra use the 'Mobile and desktop applications' platform, never SPA.
- Ship IdP presets and a config validator:
- Entra: set requestedAccessTokenVersion=2; resource_server_id must match aud; roles claim; no `resource` parameter; Graph-scope warning; pairwise `sub` → set preferred_username_claims.
- Keycloak: audience mapper; nested role paths.
- Okta: custom authorization server; flag verify_aud=false.
- Auth0: `audience` parameter; permissions claim.
- UAA: needs a client secret; 4.4 verify_issuer flags.
- TokenManager: refresh at 75% of lifetime and check that the username claim is unchanged.
- AMQP 0-9-1: amqplib updateSecret, plus a custom credentials object with a lazy response() so recovery reconnects use the current token.
- AMQP 1.0 on 4.1+: rabbitmq-amqp-js-client refreshToken; on 4.0, reconnect before expiry.
- Stream: reconnect with offset resume.
- HTTP: retry once on 401, idempotent requests only.
- Detect the broker version and adapt expiry handling. On 3.13–4.2.5 the engine must itself cancel its taps and consumers at token expiry, because the broker leaves them running. On 4.2.6+/4.3 expect 320 CONNECTION_FORCED and reconnect without user-visible disruption.
- Check token size before use. Warn when a Bearer header exceeds about 4,000 bytes (HTTP 431, which only advanced.config cowboy_opts fixes), or when the AMQP 0-9-1 PLAIN response exceeds 4,096 bytes on ≤4.0 or 8,192 bytes on 4.1+. Always send Bearer rather than Basic-with-token.
- Desktop transport: make an Electron MessagePort (MessageChannelMain between renderer and utilityProcess) the default. The Angular RPC layer must be transport-agnostic (MessagePort for desktop, WebSocket for local web). If loopback HTTP is kept: 127.0.0.1 only, a token never in argv/env/URL, exact Host/Origin checks, no cookies, WebSocket token via subprotocol or one-time ticket.
- Expose a Unix-domain-socket / named-pipe endpoint with OS permissions for the CLI and the stdio MCP shim, with scoped capability tokens. Never open a TCP listener for local MCP.
- In desktop mode, send management-API HTTPS through Electron net.fetch in the utilityProcess (system proxy/PAC, Kerberos/NTLM, OS trust store, smartcard client certificates via respondToAuthRequestsFromMainProcess), with undici as the portable path. Use session.resolveProxy() to tunnel raw AMQP.
- TrustStore: at engine start call tls.setDefaultCACertificates(bundled + system + org CAs); per-profile `ca` must be concatenated with the defaults because it replaces them; always set servername/checkServerIdentity on tunnelled or IP connections. Do not depend on NODE_EXTRA_CA_CERTS or NODE_OPTIONS, which are ignored once the Electron nodeOptions fuse is disabled.
- Dialer abstraction covering direct, SOCKS5 (socks), HTTP CONNECT, ssh2 (jump chains, agents including Pageant and the Windows OpenSSH pipe, keyboard-interactive, host-key pinning) and a system-OpenSSH mode (`ssh -W`) for OpenSSH certificates, FIDO keys and ProxyJump, plus Kubernetes port-forward. Inject sockets in process where possible (amqps tls socket, undici connect, rhea connection_details); otherwise use a permission-restricted Unix-socket forwarder.
- Send upstream PRs or keep thin forks: a socket-factory hook for amqplib and rabbitmq-stream-js-client; a function-based address resolver and SASL re-authentication for the stream client; EXTERNAL and full TLS/socket options for rabbitmq-amqp-js-client.
- Stream browser: default to AMQP 1.0/0-9-1 stream consumers (x-stream-offset, filters) over the existing connection or tunnel. Use the stream protocol only when nodes are reachable or per-node tunnels have an address map. Explain 'does not have a running replica on the local node' and point to the nodes that host the stream. On Amazon MQ, always use AMQP.
- Team server: per-connection broker credential modes (delegated OAuth preferred; Vault/OpenBao dynamic for internal-auth brokers; personal credentials for LDAP; service account as fallback), always intersected with the tool's deny-by-default RBAC. Delegated mode needs per-user connection pools, because a connection's username cannot change on refresh.
- Delegated OAuth: obtain access tokens for the broker's audience at login, through token exchange (Keycloak 26.2 RFC 8693, Entra OBO) or a stored refresh token (envelope-encrypted, revoked at logout). Forward only access tokens, never ID tokens. Remember Entra issues one resource per access token.
- Audit: keep the tool's own append-only audit log as the record of truth. Put the user ID in the AMQP connection_name; correlate amq.rabbitmq.event user_who_performed_action; warn when broker attribution is unreliable (HTTP access log shows the client ID before 4.3.3 and on all 4.2.x; Entra pairwise sub; service-account mode).
- MCP: the team server's /mcp is its own OAuth resource (Protected Resource Metadata, RFC 8707 audience check) and never passes tokens through. Tools reference connections only by opaque IDs created by humans (CVE-2026-18655 lesson). Mutating tools are off by default and need human approval; payloads are quoted, size-capped and masked; output is rendered as text without remote images.
- SSRF egress policy on the team server: an admin allow-list of broker hosts, CIDRs and ports per environment; deny link-local, cloud-metadata, loopback and private ranges by default; DNS validation at connect time via a custom lookup for net, tls and undici; no HTTP redirects; the same policy for OIDC discovery, JWKS and Vault URLs; deploy with an egress NetworkPolicy.
- Secrets: desktop vault (AES-256-GCM DEK wrapped by safeStorage's async API in main or @napi-rs/keyring forced to the Secret Service); require a master password when the backend is Linux basic_text or keyutils; team server envelope encryption with KMS, Vault Transit or OpenBao Transit; redact URIs, Authorization headers, JWT-bearing x- headers and shovel/federation URIs in every log and export.
- Add broker security rules to the linter/upgrade advisor:
- verify_aud=false; hostname_verification=none
- ANONYMOUS enabled / guest present
- basic auth still on alongside OAuth
- /api/auth leaking the client secret (<4.2.9/4.3.3)
- 0-9-1 expiry semantics (<4.2.6)
- access-log attribution (<4.3.3)
- UAA + 4.4 discovery change
- Entra token-version/aud mismatch
- oversized tokens
- Local web: bind 127.0.0.1 by default; refuse public binds without real auth and TLS; put the startup token in the URL fragment; Host/Origin allow-lists; Docker docs must say `-p 127.0.0.1:...` because published ports bypass ufw; always require the token inside containers.
- Supply chain for an AI-agent-built codebase:
- Pin the git dependency `rhea` (pulled by rabbitmq-amqp-js-client) to a reviewed commit that includes the decoder-bounding fixes.
- Install with --ignore-scripts and rebuild native modules explicitly (keyring; ssh2 optional deps).
- Verify npm provenance; enforce a dependency allow-list and minimum release age against slopsquatting and account takeovers.
- SBOM; signed containers and Electron updates; GitHub Actions pinned by SHA.
- Electron hardening baseline: fuses RunAsNode/NodeOptions/NodeCliInspect off; ASAR integrity and OnlyLoadAppFromAsar on; renderer sandbox and contextIsolation; strict CSP; window-open and navigation guards; shell.openExternal allow-list for message-payload links; consistent code signing so macOS Keychain stops re-prompting.
- Provider-aware connection wizard: Amazon MQ (protocols AMQP 0-9-1/1.0/JMS only, no stream port; monitoring-AWS-OWNED user hidden and protected; strict mTLS unavailable on the management API; private brokers via bastion SOCKS/SSM with SNI preserved), CloudAMQP (OAuth on dedicated ≥3.13), Kubernetes RabbitmqCluster discovery (pods, -nodes headless service, default-user secret only with consent), Tanzu (opaque tokens, IdP forward proxy).

## Open questions

- Do tls.getCACertificates('system'), tls.setDefaultCACertificates() (Node 24.5+) and crypto.argon2 (Node 24.7+) work inside Electron 44's BoringSSL-based Node 24.22 on Windows, macOS and Linux? This must be tested before relying on them.
- Is Chromium Local Network Access still hard-disabled in Electron 44/45? If the loopback HTTP transport is kept, how are requests from the app:// origin to 127.0.0.1 treated? (electron#48655; Electron's permission handlers can now receive 'local-network-access'.)
- Does a TLS session over an ssh2 channel passed as tls.connect({socket}) behave correctly with amqplib (setNoDelay/keepAlive no-ops, backpressure, heartbeats)? Same question for the Unix-socket forwarder path with net.connect({path}).
- Does the documented '?token=' query parameter for /api/definitions work in any shipped version? Code at 3.13.7–4.3.6 says no; needs a lab confirmation.
- AMQP 1.0 on 3.13 (rabbitmq_amqp1_0 plugin): what happens when an OAuth token expires? No explicit handling was found in the plugin reader.
- At what JWT sizes do 431 and frame_too_large actually occur, per version and protocol, with real Entra and Keycloak tokens? Does setting Cowboy max_authorization_header_value_length through advanced.config work on 4.2/4.3, given one user still sees failures on 4.2 (2026-09-24 comment on #13761)?
- Do Okta and Auth0 support RFC 8252 ephemeral loopback ports in 2026? Current evidence is a 2022 Okta staff answer and Auth0 community threads.
- Can the management UI's existing Entra app registration be reused by adding a 'Mobile and desktop' localhost redirect, and are aud, roles and consent identical? Do Keycloak deployments usually allow adding http://127.0.0.1/* to the UI client?
- Do Entra OBO and Keycloak 26.2 standard token exchange produce RabbitMQ-audience tokens that keep the claims RabbitMQ needs (roles or scopes, preferred_username) for delegated team-server and MCP flows?
- Does @kubernetes/client-node 2.0.0's WebSocket port-forward work against the cluster versions targeted (and through EKS/AKS/GKE exec auth)? Is spawning kubectl preferable?
- Amazon MQ: is the stream protocol truly unavailable (the supported-protocols page omits it)? Does the June 2026 private networking feature lift the 'public CA only' rule for OAuth IdP certificates?
- Does macOS prompt for Keychain access when @napi-rs/keyring runs in the Electron utilityProcess helper rather than main? Is safeStorage's async API usable early enough at startup for the engine to unlock its vault?
- Which management API responses redact shovel/federation URI credentials (redact_uris_in_definition exists on main), and is /api/definitions export still unredacted on 4.2/4.3?
- Is the rhea decoder hardening on main (element-count and nesting bounds) needed in practice? Does amqplib have equivalent limits on nested header tables and arrays when decoding untrusted messages?
- Does the 4.x auth-cache regression (reconnects not cached, fixed on main for 4.4) also apply to LDAP-backed 4.3.x brokers, making the tool's connection reuse critical?
- Does the stream protocol support ANONYMOUS by default in 4.0+, as AMQP does? This was not verified.

## Sources

- https://api.github.com/repos/rabbitmq/rabbitmq-server/tags?per_page=100
- https://api.github.com/repos/rabbitmq/rabbitmq-server/releases
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.4.0.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.3.7.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.3.3.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.3.0.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.2.9.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.2.6.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.1.0.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.0.8.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.0.1.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/3.13.0.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_web_dispatch/src/rabbit_web_dispatch_access_control.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.9/deps/rabbitmq_web_dispatch/src/rabbit_web_dispatch_access_control.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v3.13.7/deps/rabbitmq_web_dispatch/src/rabbit_web_dispatch_access_control.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_web_dispatch/priv/schema/rabbitmq_web_dispatch.schema
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.0.8/deps/rabbitmq_web_dispatch/priv/schema/rabbitmq_web_dispatch.schema
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/src/rabbit_mgmt_util.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v3.13.7/deps/rabbitmq_management/src/rabbit_mgmt_util.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/src/rabbit_mgmt_wm_definitions.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v3.13.7/deps/rabbitmq_management/src/rabbit_mgmt_wm_definitions.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.9/deps/rabbitmq_management/src/rabbit_mgmt_wm_definitions.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/src/rabbit_mgmt_wm_auth.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v3.13.7/deps/rabbitmq_management/src/rabbit_mgmt_wm_auth.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.2.8/deps/rabbitmq_management/src/rabbit_mgmt_wm_auth.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/priv/www/js/oidc-oauth/helper.js
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/priv/www/js/main.js
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/priv/www/js/prefs.js
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_management/priv/schema/rabbitmq_management.schema
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_management/test/rabbit_mgmt_http_SUITE.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_reader.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.1.8/deps/rabbit/src/rabbit_channel.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_channel.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.1.8/deps/rabbit/Makefile
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.0.9/deps/rabbit/src/rabbit_amqp_reader.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_amqp_reader.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_amqp_management.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v3.13.7/deps/rabbitmq_amqp1_0/src/rabbit_amqp1_0_reader.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_stream/src/rabbit_stream_reader.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_stream_queue.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v3.13.7/deps/rabbit/src/rabbit_stream_queue.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_auth_backend_oauth2/src/rabbit_auth_backend_oauth2.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_auth_backend_oauth2/include/oauth2.hrl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbitmq_auth_mechanism_ssl/README.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_amqqueue.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/deps/rabbitmq_shovel/src/rabbit_shovel_parameters.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/rabbitmq-components.mk
- https://github.com/rabbitmq/rabbitmq-server/issues/13761
- https://github.com/rabbitmq/rabbitmq-server/issues/16559
- https://github.com/rabbitmq/rabbitmq-server/pull/16879
- https://github.com/rabbitmq/rabbitmq-server/pull/16884
- https://github.com/rabbitmq/rabbitmq-server/pull/16887
- https://github.com/rabbitmq/rabbitmq-server/pull/16092
- https://github.com/rabbitmq/rabbitmq-server/commit/501ad947cd6bbcc9486fe96e0d073992bfe52cc4
- https://github.com/rabbitmq/rabbitmq-server/pull/16100
- https://github.com/rabbitmq/rabbitmq-server/issues/8662
- https://github.com/rabbitmq/rabbitmq-server/discussions/13887
- https://github.com/rabbitmq/rabbitmq-server/issues/12235
- https://github.com/rabbitmq/rabbitmq-server/pull/13467
- https://github.com/rabbitmq/rabbitmq-server/pull/12599
- https://github.com/rabbitmq/rabbitmq-server/pull/10012
- https://github.com/rabbitmq/rabbitmq-server/issues/16255
- https://www.rabbitmq.com/docs/oauth2
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/versioned_docs/version-4.3/oauth2.md
- https://www.rabbitmq.com/docs/management
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/versioned_docs/version-4.3/management/index.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/versioned_docs/version-3.13/management/index.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/versioned_docs/version-4.3/troubleshooting-oauth2.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/versioned_docs/version-4.3/oauth2-examples-entra-id/index.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/versioned_docs/version-4.3/oauth2-examples-auth0.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/versioned_docs/version-4.3/oauth2-examples-keycloak.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/versioned_docs/version-4.3/oauth2-examples-okta.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/versioned_docs/version-4.3/oauth2-examples-google.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/versioned_docs/version-4.3/stream-connections.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/versioned_docs/version-4.3/stream.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/versioned_docs/version-4.3/streams.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/versioned_docs/version-4.3/access-control.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/versioned_docs/version-4.3/ldap.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/client-libraries/amqp-client-libraries.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/src/pages/commercial-features.js
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/kubernetes/operator/using-operator/index.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-oauth2-tutorial/next/conf/okta/rabbitmq.conf.tmpl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-oauth2-tutorial/next/conf/auth0/rabbitmq.conf.tmpl
- https://raw.githubusercontent.com/ninenines/cowboy/master/doc/src/manual/cowboy_http.asciidoc
- https://registry.npmjs.org/amqplib
- https://raw.githubusercontent.com/amqp-node/amqplib/v2.2.0/lib/connect.js
- https://raw.githubusercontent.com/amqp-node/amqplib/v2.2.0/lib/connection.js
- https://raw.githubusercontent.com/amqp-node/amqplib/v2.2.0/lib/credentials.js
- https://raw.githubusercontent.com/amqp-node/amqplib/v2.2.0/lib/channel_model.js
- https://raw.githubusercontent.com/amqp-node/amqplib/v2.2.0/lib/recovery.js
- https://raw.githubusercontent.com/amqp-node/amqplib/v2.2.0/channel_api.js
- https://raw.githubusercontent.com/amqp-node/amqplib/v2.2.0/CHANGELOG.md
- https://registry.npmjs.org/rabbitmq-amqp-js-client
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/package.json
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/src/connection.ts
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/src/environment.ts
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/src/management.ts
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/v1.0.0/src/rhea_wrapper.ts
- https://github.com/coders51/rabbitmq-amqp-js-client/pull/79
- https://registry.npmjs.org/rabbitmq-stream-js-client
- https://raw.githubusercontent.com/coders51/rabbitmq-stream-js-client/v1.1.0/src/client.ts
- https://raw.githubusercontent.com/coders51/rabbitmq-stream-js-client/v1.1.0/src/connection.ts
- https://github.com/coders51/rabbitmq-stream-js-client/pull/293
- https://github.com/coders51/rabbitmq-stream-js-client/releases
- https://registry.npmjs.org/rhea
- https://raw.githubusercontent.com/amqp/rhea/main/lib/connection.js
- https://raw.githubusercontent.com/amqp/rhea/main/package.json
- https://github.com/amqp/rhea/compare/3.0.5...main
- https://raw.githubusercontent.com/mscdex/ssh2/v1.17.0/README.md
- https://github.com/mscdex/ssh2/issues/1495
- https://registry.npmjs.org/ssh2/1.17.0
- https://raw.githubusercontent.com/JoshGlazebrook/socks/master/README.md
- https://registry.npmjs.org/socks
- https://raw.githubusercontent.com/nodejs/undici/v8.12.2/docs/docs/api/Socks5ProxyAgent.md
- https://raw.githubusercontent.com/nodejs/undici/v8.12.2/docs/docs/api/ProxyAgent.md
- https://raw.githubusercontent.com/nodejs/undici/v8.12.2/lib/core/connect.js
- https://registry.npmjs.org/undici
- https://raw.githubusercontent.com/kubernetes-client/javascript/2.0.0/src/portforward.ts
- https://raw.githubusercontent.com/kubernetes-client/javascript/2.0.0/src/config.ts
- https://registry.npmjs.org/@kubernetes/client-node
- https://raw.githubusercontent.com/Brooooooklyn/keyring-node/main/README.md
- https://registry.npmjs.org/@napi-rs/keyring
- https://raw.githubusercontent.com/panva/openid-client/v6.8.8/README.md
- https://registry.npmjs.org/openid-client
- https://raw.githubusercontent.com/nodejs/node/v24.x/doc/api/cli.md
- https://raw.githubusercontent.com/nodejs/node/v24.x/doc/api/tls.md
- https://raw.githubusercontent.com/nodejs/node/v24.x/doc/api/crypto.md
- https://github.com/nodejs/node/releases
- https://releases.electronjs.org/releases.json
- https://raw.githubusercontent.com/electron/electron/main/docs/tutorial/fuses.md
- https://raw.githubusercontent.com/electron/electron/main/docs/api/environment-variables.md
- https://raw.githubusercontent.com/electron/electron/main/docs/api/utility-process.md
- https://raw.githubusercontent.com/electron/electron/main/docs/api/safe-storage.md
- https://raw.githubusercontent.com/electron/electron/44-x-y/docs/api/safe-storage.md
- https://raw.githubusercontent.com/electron/electron/main/docs/api/net.md
- https://github.com/electron/electron/issues/48655
- https://github.com/electron/electron/pull/53170
- https://developer.chrome.com/blog/local-network-access
- https://chromestatus.com/feature/5197681148428288
- https://www.phoronix.com/news/Chrome-147-Stable-Released
- https://www.rfc-editor.org/rfc/rfc8252
- https://www.rfc-editor.org/rfc/rfc9700
- https://datatracker.ietf.org/doc/draft-ietf-oauth-browser-based-apps/
- https://learn.microsoft.com/en-us/entra/identity-platform/reply-url
- https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference
- https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens
- https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens
- https://learn.microsoft.com/en-us/entra/identity-platform/configurable-token-lifetimes
- https://learn.microsoft.com/en-us/answers/questions/1601797/aadsts9002327-tokens-issued-for-the-single-page-ap
- https://raw.githubusercontent.com/keycloak/keycloak/main/services/src/main/java/org/keycloak/protocol/oidc/utils/RedirectUtils.java
- https://www.keycloak.org/docs/latest/server_admin/index.html
- https://www.keycloak.org/2025/05/standard-token-exchange-kc-26-2
- https://folio-org.atlassian.net/wiki/spaces/FOLIJET/pages/887324704/EUREKA-704+Lightweight+access+tokens+configuration+in+Keycloak
- https://devforum.okta.com/t/loopback-interface-redirection-ephemeral-ports-wildcard-ports-in-localhost-redirect-uri/22197
- https://community.auth0.com/t/allow-wildcard-port-in-redirect-uri-as-per-rfc-8252/98409
- https://headlamp.dev/docs/latest/installation/in-cluster/oidc
- https://github.com/kubernetes/kubernetes/blob/master/staging/src/k8s.io/apiserver/pkg/authentication/request/websocket/protocol.go
- https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2025-11-25/basic/authorization.mdx
- https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/basic/authorization/security-considerations.mdx
- https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/changelog.mdx
- https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/docs/2026-07-28/tutorials/security/security_best_practices.mdx
- https://aws.amazon.com/security/security-bulletins/2026-070-aws/
- https://www.recordedfuture.com/blog/anthropic-mcp-inspector-cve-2025-49596
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/amazon-mq-release-notes.md
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/oauth-for-amq-for-rabbitmq.md
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/ssl-for-amq-for-rabbitmq.md
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/configure-mtls.md
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/ldap-for-amq-for-rabbitmq.md
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-supported-protocols.md
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/configuring-private-broker.md
- https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/private-networking.md
- https://aws.amazon.com/about-aws/whats-new/2025/09/amazon-mq-supports-oauth-20
- https://www.cloudamqp.com/docs/cloudamqp-oauth2.html
- https://techdocs.broadcom.com/us/en/vmware-tanzu/data-solutions/tanzu-rabbitmq-on-kubernetes/4-0/tanzu-rabbitmq-kubernetes/oauth2.html
- https://developer.hashicorp.com/vault/docs/secrets/rabbitmq
- https://developer.hashicorp.com/vault/api-docs/secret/rabbitmq
- https://openbao.org/docs/secrets/rabbitmq/
- https://docs.docker.com/engine/network/port-publishing/
- https://docs.docker.com/engine/network/packet-filtering-firewalls/
- https://raw.githubusercontent.com/jupyter-server/jupyter_server/main/docs/source/operators/security.rst
- https://arxiv.org/abs/2406.10279
- https://content.govdelivery.com/accounts/USDHSCISA/bulletins/3f408db
- https://endorlabs.com/learn/major-supply-chain-attack-compromises-popular-npm-packages-including-chalk-and-debug
