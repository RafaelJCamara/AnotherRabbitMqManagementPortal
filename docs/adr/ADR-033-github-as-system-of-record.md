# ADR-033: GitHub as system of record

- **Status:** Accepted
- **Date:** 2026-10-16
- **Decided by:** maintainer

## Decision
- **Milestones:** every milestone is a GitHub milestone (M0–M8).
- **Issues:** every piece of work is a GitHub issue: work package, epic, spike, lab cell, ADR, human prerequisite, or release & exit checklist. **No work without an issue.**
- **PRs:** every PR references its issue (`Closes #n`). The CI check that enforces this arrives with the repository bootstrap work packages.
- **Docs-as-code:** everything else lives in `docs/`: plan, research, product, architecture, ADRs, runbooks. Docs change in the same PR as the behaviour they describe.
- **Project board:** a GitHub Project board tracks progress once the `project` token scope is granted. Fields: Status, Milestone, Wave, Lane, Area, Size, Trust-critical.

## Consequences
- The initial issues were generated from [docs/plan/work-items.json](../plan/work-items.json); the index with issue links is [docs/plan/work-items.md](../plan/work-items.md).
- Epics for later milestones are broken into work-package issues when their milestone opens.
