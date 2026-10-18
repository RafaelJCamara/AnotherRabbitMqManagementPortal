# Repository layout

> **Design-phase output (2026-10-16).** Amended by [`docs/plan/amendments.md`](../plan/amendments.md), which takes precedence, and re-sequenced web-first ([ADR-030](../adr/ADR-030-web-first-delivery-order.md), [`docs/product/milestones.md`](../product/milestones.md)). Content about a specific third-party product was removed under the docs policy ([ADR-034](../adr/ADR-034-docs-policy.md)).

```text
/                                        # greenfield Nx 23.3 + pnpm 12.14 workspace, Apache-2.0
|-- AGENTS.md                            # canonical agent guide: invariants I-1..I-14, generators, verify commands, WP rules
|-- CLAUDE.md                            # <=200 lines, imports @AGENTS.md
|-- .claude/{rules/{engine,ui,desktop,semantics,security}.md, skills/{new-action,new-adapter,new-ui-feature,new-semantics-cell,security-lane,release}, settings.json}
|-- LICENSE NOTICE SECURITY.md CONTRIBUTING.md(DCO, AI policy) GOVERNANCE.md TRADEMARKS.md CODEOWNERS(trust:critical paths)
|-- nx.json  package.json(packageManager pnpm@12.14.x, engines node>=24.15)  tsconfig.base.json(TS 6.0.3 strict)
|-- pnpm-workspace.yaml                  # exact catalogs; minimumReleaseAge 4320 + strict + reviewed exact-version excludes;
|                                        #   trustPolicy no-downgrade; blockExoticSubdeps; strictDepBuilds; allowBuilds; overrides (security lane)
|-- eslint.config.mjs                    # boundaries + confinement + banned list + custom rules
|-- docs/{adr/ADR-001..028.md + ADR-028-log.md(exclusions), architecture/, specs/WP-*.md, threat-model.md, compat.md, runbooks/(kek-escrow, restore, emergency)}
|-- apps/
|   |-- engine/src/{main.ts, compose-core.ts, modes/{desktop,local,team}.ts, modules.ts, workers/{plugin-host,capture}.ts}  # esbuild -> dist/engine/main.mjs (+metafile)
|   |-- web/                             # Angular 22.2 shell (one build; budgets; dev gallery route)
|   |-- desktop/src/{main/{index,engine-supervisor,protocol,windows,security,menus,power,keywrap,updater}.ts, preload/index.ts}
|   |   `-- electron-builder.{release,test}.yml   # 26.17.0; fuses; MSIX/NSIS/zip; dmg/zip; deb/rpm/AppImage
|   |-- cli/                             # serve | open | mcp (stdio shim) | lint | export | doctor | rewrap | audit verify
|   |-- conformance/  e2e-web/  e2e-desktop/  e2e-team/  perf/  chaos/
|-- libs/
|   |-- shared/{contracts, domain-model, semantics(src/data/*.data.ts), effective-config, routing, peek-planner, tap-planner,
|   |           replay-planner, deaths, topology-code, lint-rules, masking, forecast, live-protocol}/      # runtime:isomorphic
|   |-- engine/{kernel, jobs, live, transport, ports, persistence, adapter-mgmt-http, adapter-amqp091, adapter-amqp10,
|   |           adapter-stream, adapter-prometheus, adapter-k8s, net-dialer, net-truststore, secrets, plugin-host, decoders,
|   |           svc-connections, svc-identity, svc-capabilities, svc-explorer, svc-peek, svc-messages, svc-tap, svc-dlq,
|   |           svc-streams, svc-topology, svc-admin, svc-ops, svc-metrics, svc-alerts, svc-lint, svc-audit, svc-access,
|   |           svc-workspace, svc-mcp}/                              # each: README.md + src/{module.ts, actions/, topics.ts, jobs/, internal/}
|   |-- ui/{platform, data, design(helm/ copied w/ MIT notice), grid, graph(assets/elk/elk-worker.min.js unmodified), editor,
|   |       charts, commands, payload, feature-{connections,explorer,messages,tap,dlq,streams,topology,admin,metrics,lint,jobs,approvals,governance,settings}}/
|   |-- sdk/{plugin-sdk, header-registry}/                  # published later under the coined scope
|   `-- testkit/                                            # port fakes, createTestEngine, scenario engine, 100k-queue mgmt + 400k-series prom fakes
|-- testing/
|   |-- broker-lab/                      # Dockerfiles per version (plugins, 5552/15692, TLS, OAuth), 3-node + HAProxy + toxiproxy compose
|   |-- lab-evidence/<broker-version>/<CF-id>.json   # recorded independently of the registry (CODEOWNERS: lab-evidence)
|   |-- fixtures/{mgmt/<version>/, prometheus/, messages/<framework>/}
|   `-- oracle-amqp10/                   # differential oracle (rhea overridden to 3.0.5)
|-- tools/
|   |-- generators/                      # action, topic, job, service-module, adapter, ui-feature, lint-rule, decoder, semantics-cell, migration, conformance-cell
|   |-- eslint-rules/                    # no-broker-version-compare, no-mode-branching, bounded-buffers-only, honest-wording, no-inner-html
|   |-- arch-tests/                      # ts-morph: WritePort funnel, plan purity harness, service isolation
|   |-- supply-chain/                    # licence gate, lockfile gate, deps-allowlist.json, notices+SBOM from esbuild metafile, exclusion hygiene
|   `-- semantics-evidence/              # status-flip check (evidence artefact + CODEOWNERS)
|-- spikes/
|   `-- csp/                             # S-04 (M0-20) throwaway harness: CSP + Trusted Types with AG Grid, Monaco, ELK; libraries installed to tmp/, never the catalog
|-- packaging/
|   |-- docker/                          # Dockerfile (node:24-trixie-slim -> distroless nodejs24-debian13:nonroot), healthcheck.mjs, compose.yaml (+postgres:17)
|   `-- helm/<product>/                  # chart; migrations hook Job (DDL role); values.schema.json generated from TeamServerConfig
`-- .github/workflows/{ci, conformance-pr, conformance-nightly, mutation-nightly, perf-nightly, chaos-nightly, restore-drill, security-lane, release, codeql, scorecard}.yml  # actions pinned by SHA
```
