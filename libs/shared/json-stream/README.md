# json-stream

Incremental reader for large JSON arrays: yields the items, stops at a limit, bounded in bytes, in item size and in time.

Tags: `type:pure`, `runtime:isomorphic`. It imports nothing from the workspace and nothing from npm; it uses only web-standard globals (`TextDecoder`, `JSON`, `Uint8Array`).

Status: slice A of M0-48l ([spec](../../../docs/specs/M0-48l.md), issue #273). Slice B adds `value()` (the paged envelope), `close()`, the abort signal and the cooperative yield; until then `array()` takes no signal and does not yield to the event loop by itself, so the time bound is the caller's.

## Public API

- `openJson(source: AsyncIterable<Uint8Array>): Promise<JsonStream>` reads up to the first non-blank byte (blanks may span chunks) and stops pulling. `JsonStream.shape` is `array` (`[`), `object` (`{`), `other` or `empty` (nothing but blanks), from the bytes only, never from a product or a version.
- `JsonStream.array(limits): AsyncGenerator<unknown, ArrayEnd>` yields the items one by one. `limits` are `maxItems` (at least 1), `maxBytes` (bytes taken from the source), `maxItemBytes` (bytes of one item) and `maxDepth` (nesting inside one item, default 64). The generator returns the end:
  - `{ kind: 'complete', items, bytes }`: the closing bracket was seen and nothing but blanks follows; `items` is the exact length and `bytes` the length of the body.
  - `{ kind: 'item-limit', items, bytes }`: `maxItems` were delivered and one more follows. The length of the array is **not known** (at least `items + 1`); the rest is not read and not counted.

  An array of exactly `maxItems` items is `complete`, not cut.

- `JsonStreamError` with `reason` (`not-an-array`, `malformed`, `truncated`, `too-large`, `too-deep`, `trailing-data`, `aborted`), `offset` (bytes taken when the fault was found) and `delivered` (items delivered before it). `message` is one fixed text per reason.

How it works: a synchronous byte scanner finds where each item starts and ends (strings, escapes and bracket depth; the structural bytes are ASCII, so scanning bytes is exact in UTF-8), then each item is decoded with a fatal UTF-8 decoder and parsed with `JSON.parse`. Brackets are counted, not paired by kind: a mismatch shows as an item that does not parse, a body that ends, or an item over the byte limit, whichever comes first.

## Invariants

- Bounded (I-6): what is held is the current chunk plus the part of the current item that lay in earlier chunks (at most `maxItemBytes`). The whole array is never held. A body over `maxBytes`, an item over `maxItemBytes` and nesting over `maxDepth` fail the read; nesting is counted before `JSON.parse` runs, so the recursive parser never sees a deep body.
- Fail closed: a fault ends the read with an error. Items delivered before it are counted in `delivered`; the caller decides to drop them.
- No input in an error (I-10): every `message` is a fixed text, there is no `cause`, and neither the message nor `offset` nor `delivered` holds a byte of the input. The platform's own parse error text is dropped.
- The source is always settled: read to its end, or cancelled with `return()` (an early `break`, an error, the item limit). A `break` of the consumer reaches the source, so an HTTP body is closed and a scheduler slot is given back.
- One claim per stream: `array()` may be called once.
- Dependencies follow the type:pure row of blueprint 2.2; `pnpm nx lint json-stream` enforces them.

## Proof commands

```sh
pnpm nx show project json-stream
pnpm nx run-many -t lint typecheck test -p json-stream
pnpm nx test json-stream --testNamePattern=AC-
```

`src/testing/bindings.in-vhost.4.2.9.json` is a byte-for-byte copy of the recorded answer `testing/fixtures/mgmt/4.2.9/stats-off/bindings.inVhost.json` (a project of this kind may not import a file from outside itself).
