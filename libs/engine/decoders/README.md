# decoders

Decoders that turn a failed message into a normalised failure (DC-53): the built-in code decoders and the generic declarative engine.

Tags: `type:adapter`, `runtime:node`.

## Public API

- `builtinDecoders`: every built-in decoder.
- `DecoderPlugin`, `DecodeInput`, `NormalizedFailure`, `TypedHeaderValue`: the plugin shape.

## Invariants

- A decoder never throws on a message it does not recognise: `detect` returns 0.
- Most frameworks are pure data in `libs/sdk/header-registry`; code is only for body envelopes and fingerprints.
- Every decoder has fixtures in `testing/fixtures/messages/<framework>`.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p decoders
pnpm nx test decoders
```
