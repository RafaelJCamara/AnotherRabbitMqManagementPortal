# Architecture Decision Records

ADRs use the MADR style (status, context/decision, rationale, alternatives, consequences). New or changed decisions follow the issue-first workflow: open a `type:adr` issue, then a PR that adds or updates `ADR-NNN-*.md`. Merged means Accepted. Superseded ADRs stay, with links both ways.

| ADR | Title | Status |
|---|---|---|
| [ADR-001](ADR-001-one-engine-bundle-one-ui-build-three-hosts.md) | One engine bundle, one UI build, three hosts | Accepted |
| [ADR-002](ADR-002-desktop-transport-messageport-per-page-load-tunnelling-the-r.md) | Desktop transport: MessagePort per page load tunnelling the REST router via fastify.inject | Accepted |
| [ADR-003](ADR-003-one-contract-registry-generated-openapi-asyncapi-no-client-c.md) | One contract registry; generated OpenAPI/AsyncAPI; no client codegen | Accepted |
| [ADR-004](ADR-004-fastify-5-12-7-only-with-an-adr-capped-in-house-kit-deviatio.md) | Fastify 5.12.7 only, with an ADR-capped in-house kit (deviation from DC-49's fastify clause) | Accepted |
| [ADR-005](ADR-005-multiplexed-live-protocol-with-credits-and-per-topic-qos.md) | Multiplexed live protocol with credits and per-topic QoS | Accepted |
| [ADR-006](ADR-006-single-fail-closed-actionexecutor-for-ui-cli-mcp-and-jobs.md) | Single fail-closed ActionExecutor for UI, CLI, MCP and jobs | Accepted |
| [ADR-007](ADR-007-data-driven-semantics-registry-tied-to-independent-lab-evide.md) | Data-driven semantics registry tied to independent lab evidence | Accepted |
| [ADR-008](ADR-008-peek-sequential-basic-get-mandatory-disposition-preflighted-.md) | Peek: sequential basic.get, mandatory disposition, preflighted rescue, nack plus qos barrier | Accepted |
| [ADR-009](ADR-009-five-role-typed-connection-roles-with-proof-typed-settlement.md) | Five role-typed connection roles with proof-typed settlement | Accepted |
| [ADR-010](ADR-010-dlq-replay-with-a-source-role-park-by-confirm-and-at-least-o.md) | DLQ replay with a source role, park-by-confirm and at-least-once identity | Accepted |
| [ADR-011](ADR-011-taps-pure-tapplanner-durable-firehose-leases-khepri-churn-bu.md) | Taps: pure TapPlanner, durable firehose leases, Khepri churn budgets | Accepted |
| [ADR-012](ADR-012-in-house-protocol-adapters-behind-ports.md) | In-house protocol adapters behind ports | Accepted |
| [ADR-013](ADR-013-kysely-over-node-sqlite-and-postgres-one-migration-set-ddl-d.md) | Kysely over node:sqlite and Postgres; one migration set; DDL/DML split | Accepted |
| [ADR-014](ADR-014-field-encryption-covering-secrets-captures-plans-and-journal.md) | Field encryption covering secrets, captures, plans and journals; backups and audit anchors | Accepted |
| [ADR-015](ADR-015-one-in-house-durable-job-runner-with-a-lease-shaped-jobstore.md) | One in-house durable job runner with a lease-shaped JobStore | Accepted |
| [ADR-016](ADR-016-local-web-container-mode-an-explicit-dc-36-bind-exception.md) | Local web container mode: an explicit DC-36 bind exception | Accepted |
| [ADR-017](ADR-017-local-ipc-with-mutual-hmac-challenge-response.md) | Local IPC with mutual HMAC challenge-response | Accepted |
| [ADR-018](ADR-018-team-server-v1-single-replica-recreate-guard-only-leader-sha.md) | Team server v1: single replica, Recreate, guard-only leader; shard-lease HA later | Accepted |
| [ADR-019](ADR-019-team-identity-oidc-bff-deny-by-default-rbac-four-eyes-approv.md) | Team identity: OIDC BFF, deny-by-default RBAC, four-eyes approval, per-connection broker credential modes | Accepted |
| [ADR-020](ADR-020-blast-radius-controls-emergency-revoke-and-maintenance-freez.md) | Blast-radius controls: emergency revoke and maintenance freeze | Accepted |
| [ADR-021](ADR-021-angular-22-ui-stack-and-rules.md) | Angular 22 UI stack and rules | Accepted |
| [ADR-022](ADR-022-plugin-sdk-data-first-registry-and-three-trust-tiers.md) | Plugin SDK: data-first registry and three trust tiers | Accepted |
| [ADR-023](ADR-023-in-house-tools-only-mcp-server-generated-from-actions.md) | In-house tools-only MCP server generated from actions | Accepted |
| [ADR-024](ADR-024-prometheus-first-demand-driven-metrics-behind-one-brokersche.md) | Prometheus-first, demand-driven metrics behind one BrokerScheduler | Accepted |
| [ADR-025](ADR-025-conformance-first-testing-with-failure-path-cells-and-mutati.md) | Conformance-first testing with failure-path cells and mutation testing | Accepted |
| [ADR-026](ADR-026-signed-telemetry-free-releases-with-exact-pins-and-opt-in-up.md) | Signed, telemetry-free releases with exact pins and opt-in updates | Accepted |
| [ADR-027](ADR-027-supply-chain-gates-with-a-reviewed-release-age-exclusion-lis.md) | Supply-chain gates with a reviewed release-age exclusion list and a security lane | Accepted |
| [ADR-028](ADR-028-doom-guard-applies-the-era-rule-literally.md) | Doom guard applies the era rule literally | Accepted |
| [ADR-029](ADR-029-product-name.md) | Product name and brand | Proposed |
| [ADR-030](ADR-030-web-first-delivery-order.md) | Web-first delivery order | Accepted |
| [ADR-031](ADR-031-fully-open-source.md) | Fully open source (Apache-2.0) | Accepted |
| [ADR-032](ADR-032-typescript-and-angular.md) | TypeScript end to end with Angular | Accepted |
| [ADR-033](ADR-033-github-as-system-of-record.md) | GitHub as system of record | Accepted |
| [ADR-034](ADR-034-docs-policy.md) | Docs policy (banned terms) | Accepted |

## Template

```markdown
# ADR-NNN: <title>

- **Status:** Proposed | Accepted | Superseded by ADR-XXX
- **Date:** YYYY-MM-DD
- **Issue:** #<n>

## Context
## Decision
## Rationale
## Alternatives considered
## Consequences
```
