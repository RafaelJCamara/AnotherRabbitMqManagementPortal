# M1 developer checklist (Web 1.0 exit gate)

M1 ("Web 1.0", the single-user Docker web app, public release targeted for 2026-11-30 by [ADR-035](../adr/ADR-035-web-1-0-by-2026-11-30-desktop-after.md)) must satisfy **every** item below. It replaces any comparison against specific third-party products ([ADR-034](../adr/ADR-034-docs-policy.md)). No desktop item is part of this gate.

## A. Table stakes found in existing desktop tools

- [ ] DLQ explorer: copy messages into a local store, facet filters, throttled republish
- [ ] Live spy / tap with blind-spot disclosure
- [ ] Drain-time forecast
- [ ] Routing graph including DLX and alternate exchanges
- [ ] Effective-policy debugger with **correct** precedence
- [ ] Global search (Cmd/Ctrl+K) and in-list search
- [ ] Monaco publish editor with headers, properties and history
- [ ] Saved views; bulk purge/delete with guardrails
- [ ] Dark theme; AMQP connection strings

## B. Features tagged desktop-tools-parity in the catalogue

- [ ] CON-01 Connection profiles
- [ ] CON-02 Environment chrome and production lock
- [ ] EXP-04 Command palette, global search and keymap
- [ ] EXP-06 Entity detail tabs
- [ ] MSG-03 Side-effect-aware classic-queue peek
- [ ] MSG-07 Message viewer and diff
- [ ] MSG-10 Local message workspace
- [ ] MSG-11 Consume to workspace (extract)
- [ ] PUB-01 Publish studio
- [ ] PUB-02 Publish history
- [ ] TAP-02 Copied-binding shadow tap
- [ ] DLQ-02 Death history normaliser
- [ ] DLQ-03 Safe replay (basic)
- [ ] TOP-01 Topology graph
- [ ] MON-02 Live charts
- [ ] MON-05 Drain and fill forecast

PLAT-07 (Electron desktop shell) also carries the desktop-tools-parity tag, but it is not part of Web 1.0. It ships in M2 (Windows), M3 (Linux) and M4 (macOS), and it is checked at those exits (ADR-035).

## C. Beyond the market (required for Web 1.0)

- [ ] Stream browser (offset/timestamp; filters where the broker supports them)
- [ ] OAuth 2.0 / mTLS / SSH tunnels / SOCKS5 / HTTP CONNECT
- [ ] Version-correct, side-effect-aware peek with receipts (per the conformance matrix)
- [ ] Routing simulator
- [ ] Correct replay destinations (queue-first; never loops into the DLX)
- [ ] Accessibility (WCAG 2.2 AA) and i18n-ready UI
- [ ] Free and open source; no telemetry

## D. Usability gate

- [ ] Time-to-first-peek under 3 minutes from `docker run` (Windows, macOS and Linux hosts)

## E. Public release

- [ ] ADR-029 accepted (product name; brand clearance H-07 done), repo renamed and public, GHCR public, docs published (amendment A-22)
