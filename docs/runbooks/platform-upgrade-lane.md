# Runbook: platform upgrade lane (~10% of capacity)

| Platform | Target |
|---|---|
| Electron (from M2) | Within 4 weeks of each stable major. Only the latest 3 majors are supported |
| Angular / TypeScript | Within one month of GA. Angular 23 is expected around June 2027; move to TypeScript 7 only once Angular supports it |
| Node | Move the container and team images to Node 26 well before Node 24 reaches EOL (2028-04-30) |
| Nx, fastify | Nx 24 and fastify 6 as they land, each through an ADR-gated issue |

For every bump:
1. Open an issue.
2. Run the conformance suite and the deny-all egress E2E.
3. Check the bundle budgets.
4. Update the pins and the docs.
