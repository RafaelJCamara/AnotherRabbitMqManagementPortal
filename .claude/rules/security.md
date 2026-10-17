---
paths:
  - 'libs/engine/secrets/**'
  - 'libs/engine/net-*/**'
  - 'libs/engine/transport/**'
  - 'libs/engine/svc-identity/**'
  - 'libs/engine/svc-access/**'
  - 'libs/engine/svc-audit/**'
  - 'libs/engine/svc-mcp/**'
---

# Security rules

Applies to secrets, networking, transport, identity, access, audit and MCP. All of it is trust-critical: adversarial review plus a human CODEOWNERS approval. Source: blueprint sections 7 and 5.12, threat model T1-T13.

- **Secrets are write-only after entry (I-10).** Contract fields for secrets are write-only; they never reach the renderer, logs, URLs, argv or env. Field encryption covers secrets, captures, plan payloads and journals (AES-256-GCM). The canary-secret log scan must stay green.
- **All outbound sockets go through the Dialer and TrustStore (I-9).** Egress policy: allow-list per environment; deny loopback, link-local, metadata, RFC 1918, CGNAT, ULA and IPv4-mapped forms; DNS validated at connect time (custom `lookup` with `all: true`); `maxRedirections: 0`. The same policy covers OIDC discovery, JWKS, Vault and webhooks.
- **TrustStore:** default CAs plus system plus org CAs; per-profile CAs are added, never replace. No leaf pinning. The insecure switch shows a red banner.
- **No new listeners.** Desktop has no TCP listener. Local web binds 127.0.0.1 (or container mode with its explicit exception, ADR-016).
- **Request checks (transport):** exact Host allow-list, Origin check, `Sec-Fetch-Site: same-origin`, JSON-only bodies, no CORS headers ever, no mutating GETs. WebSocket upgrades need a single-use 30 s ticket bound to the principal. The carrier header is rejected from clients.
- **Local IPC** uses mutual HMAC challenge-response; the client verifies the server MAC before sending anything else; no secret crosses the wire (blueprint 7.4).
- **Authorisation is deny-by-default** (`PolicyEngine`, table-driven tests). Approvals need different principals. Peeks count as mutations for MCP.
- **Audit:** an attempt row is written before execution (fail closed), then a hash-chained outcome row. The application role is DML-only.
- **MCP:** only through the executor; opaque ids; mutating tools off by default and forced off for unverified broker versions; no token passthrough.
- **Team sessions:** `__Host-sid` cookie (HttpOnly, Secure, SameSite=Lax), CSRF by Origin check plus `X-CSRF-Token`.
- **No telemetry, no phone-home (I-12).**
- Any dependency change here is a supply-chain change: follow AGENTS.md section 4 and the `/security-lane` skill. Never log a request body, header value or token.
