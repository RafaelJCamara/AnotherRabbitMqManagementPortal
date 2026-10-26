# ADR-035: Web 1.0 public release by 2026-11-30; desktop after

- **Status:** Accepted
- **Date:** 2026-10-26
- **Decided by:** maintainer
- **Issue:** #292
- **Amends:** [ADR-030](ADR-030-web-first-delivery-order.md) (the delivery order stays; this ADR adds a date and takes desktop work out of M0 and M1)

## Context

ADR-030 already put the single-user Docker web app first, but M0 and M1 still carried desktop work: the Electron spikes at the tail of M1 (M1-67, M1-68), the Electron lab cells (U-16, U-21), the Windows signing accounts (H-09), the Electron leg of the nightly conformance run, and "PLAT-07 Electron desktop shell" on the Web 1.0 checklist. The plan's only targets were "~Dec 2026" for M0 and "~Mar 2027" for M1.

## Decision

1. **The web version is the only goal until it ships.** "Web 1.0" means M0 and M1: the single-user Docker web app with the full M1 developer scope ([milestones](../product/milestones.md), [M1 checklist](../product/m1-checklist.md)).
2. **Target date: public release on 2026-11-30.** The GitHub milestone M1 is due that day.
3. **Full scope; the date is a target.** No M1 feature is cut to make the date. If the work is late, the date slips and the scope stays.
4. **Public, not only feature-complete.** Amendment A-22 still holds (nothing public before ADR-029 merges), so the product name (ADR-029, #145) and brand clearance (H-07, #144) are on the critical path.
5. **Desktop work leaves M0 and M1** and moves to M2, where it opens the milestone:

   | Item | Was | Now |
   | --- | --- | --- |
   | Spike S-01/S-02/S-03: MessagePort tunnel, utilityProcess cold start, node:sqlite in Electron (#84) | M1-67 | M2-P18 |
   | Spike S-07/S-10: Electron crypto/TLS and Windows packaging/signing (#85) | M1-68 | M2-P19 |
   | U-16 Electron runtime lab cell (#163) | M1 | M2 |
   | U-21 Signing pipeline lab cell (#166) | M1 | M2 |
   | H-09 Microsoft Partner Center, Certum certificate, maintainer identity (#155) | M1 | M2 |
   | PLAT-07 Electron desktop shell on the Web 1.0 checklist | M1 checklist | M2 exit |
   | Electron's Node leg of the nightly conformance run (M0-42) | M0 | M2 |

   Desktop parts that earlier re-sequencing already moved (the `app://` half of M1-11, native menus of M1-41, the OS deep-link scheme of M1-42, the desktop OAuth flow of M1-24, the desktop release parts of M0-68) stay in M2–M4.
6. **After Web 1.0** the ADR-030 order applies unchanged: Windows (M2) → Linux (M3) → macOS (M4) → free team server (M5) → M6–M8.
7. **Checkpoints** on the way to 2026-11-30 (targets, not gates):

   | Date | Checkpoint |
   | --- | --- |
   | 2026-11-13 | M0 exit (internal alpha): conformance gate on (IP-4), matrix v0, container image and image release workflow. GitHub milestone M0 is due that day |
   | 2026-11-16 | ADR-029 accepted after H-07; the peek chaos run of M1-38 has started its 7 clean nights |
   | 2026-11-23 | Beta freeze: every M1 feature merged; only a11y, i18n, docs, the security review and fixes after this |
   | 2026-11-27 | Repo renamed and made public, GHCR public, docs published |
   | 2026-11-30 | Web 1.0 "Developer" public release (M1-59, RC-M1) |

8. **Agents pick critical-path work first.** Issues on the path to the release carry the label `priority:critical-path`; the list is in amendment A-26.

## Rationale

- One Docker artefact gives the fastest feedback and needs no signing accounts or OS approvals. Every hour spent on desktop before Web 1.0 delays the only release on the calendar.
- The desktop abstractions that must exist early (ADR-002 transport, `EngineTransport`/`PlatformBridge`, engine mode files, the fake-port transport test) are already in M0 or landed, so desktop is still deferred, not designed out.

## Alternatives considered

- **Fixed date, cut scope** (mark issues P0/P1/P2 and move the rest to a Web 1.1). Rejected by the maintainer: the full Web 1.0 scope is wanted.
- **Feature-complete on 2026-11-30, public later.** Rejected: the maintainer wants the public release on that date.
- **Team server (M5) before desktop.** Rejected: the ADR-030 order after Web 1.0 stays.

## Consequences

- **Schedule risk is high and is accepted.** The plan sizes M0 at about 95–115 agent-days and M1 at about 115–120. On 2026-10-26, 53 M0 and 73 M1 issues were open, and the last week closed 3–4 issues a day. Meeting the date needs several parallel writers every day and same-day human review of trust-critical work and lab evidence (A-21). If that does not hold, the date moves (decision 3).
- **Human items are on the critical path:** the codename (H-01), agent identity (H-02), Docker and the self-hosted runner (H-03, H-04), provider test brokers (H-05, for the M0 exit run), IdP tenants (H-08, for the auth lab), brand clearance (H-07) and ADR-029, and approval of the CI-recorded lab evidence.
- **M1-38 has a calendar floor:** it needs 7 clean chaos nights, so it must start by 2026-11-16 at the latest.
- **M2 opens with its spikes.** They no longer de-risk M2 in advance, and the Windows signing lead time (H-09) now falls inside M2. The maintainer may still open the free accounts early, but they are not on the Web 1.0 path.
- **Docs updated in the same change:** amendment A-26, the plan (§3, §6.2, §6.5, §8), the product roadmap, the milestones page, the M1 checklist, the execution plan, the release checklists, the work-item graph and its index, `AGENTS.md` and `README.md`.
