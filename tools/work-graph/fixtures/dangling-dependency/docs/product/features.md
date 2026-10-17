# Feature catalogue (3 features)

Fixture catalogue for the graph validator self-test.

## Connections (2)

| ID | Feature | Milestone | Parity | Size | Personas |
| --- | --- | --- | --- | --- | --- |
| CON-01 | Connection profiles | M0 | desktop-tools-parity | M | DEV,OPS |
| CON-02 | Environment chrome | M0 | beyond | S | DEV |

#### CON-01 Connection profiles

- **Milestone:** M0 (design-phase tag: M0) · **Size:** M · **Parity:** desktop-tools-parity · **Personas:** DEV,OPS
- **Description:** Profiles.
- **Depends on:** -
- **Acceptance criteria:**
  - Given a pasted URI, then it is parsed

#### CON-02 Environment chrome

- **Milestone:** M0 (design-phase tag: M0) · **Size:** S · **Parity:** beyond · **Personas:** DEV
- **Description:** Chrome.
- **Depends on:** CON-01
- **Acceptance criteria:**
  - Given a PROD profile, then it is locked

## Monitoring (1)

| ID | Feature | Milestone | Parity | Size | Personas |
| --- | --- | --- | --- | --- | --- |
| MON-01 | Live charts | M1 | beyond | M | OPS |

#### MON-01 Live charts

- **Milestone:** M1 (design-phase tag: M1) · **Size:** M · **Parity:** beyond · **Personas:** OPS
- **Description:** Charts.
- **Depends on:** CON-01
- **Acceptance criteria:**
  - Given a queue, then a chart renders
