# domain-model

`@app/domain-model`: typed SemVer, version ranges and the `BrokerProfile` (DC-31, schemaVersion 1), the vocabulary the semantics registry and the engine share. Written once in zod, like the contracts it builds on.

Tags: `type:pure`, `runtime:isomorphic`. Depends on `@app/contracts` (branded ids, `GateDecision`) and `zod`.

## Public API

| Area           | Exports                                                                                                                      | File                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Vocabularies   | `Era` / `EraSchema` / `ERAS`, `QueueType`, `Verification`, `Product`, `Provider`, `Build` (types and schemas)                | `src/ids.ts`           |
| SemVer         | `SemVer` / `SemVerSchema`, `parseSemVer` (null when malformed), `compareSemVer`, `lowestSemVer`, `formatCoreVersion`          | `src/semver.ts`        |
| Version ranges | `parseVersionRange` (null when malformed), `rangeIncludes`, `VersionRange`, `VersionRangeTextSchema` (for data tables)       | `src/version-range.ts` |
| BrokerProfile  | `BrokerProfile` / `BrokerProfileSchema`, `BROKER_PROFILE_SCHEMA_VERSION`                                                      | `src/broker-profile.ts` |

## Version ranges

A closed grammar, parsed strictly (a typo in a data file fails at build time): comparators `< <= > >= =`, partial versions as x-ranges (`4.3`, `4.x`, `4.3.*`), a space for AND, `||` for OR, `*` for any version. There is no `^`, `~` or hyphen range. Pre-releases take part by plain semver precedence, with no npm-style exclusion, so `<4.3.6` includes `4.3.6-rc.1`: a hazard is reported rather than hidden.

## Invariants

- Parsing never guesses: `parseSemVer` and `parseVersionRange` return `null` for anything outside the grammar. A version that does not parse is an unknown build, and callers treat it conservatively.
- Version comparison lives here as mechanism only. Version-dependent broker behaviour is still data in `@app/semantics` (I-3); `@app/no-broker-version-compare` applies to this library, so it compares versions through `compareSemVer` and `rangeIncludes` and never against literals.
- `BrokerProfile` is a strict schema: unknown keys fail, and `schemaVersion` is the literal `1`. A new shape needs a new schema version and a migration.
- Isomorphic: no Node builtins.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p domain-model
```
