# decoders

Payload codecs (M1-10, MSG-08) and, later, the framework decoders of the DLQ centre (DC-53). The codecs turn the bytes of a message body into something a person can read: a tree, text, an opcode listing, or hex. They work on bytes only, never throw, and are bounded in input, output, depth and time. They are meant to run in the tier-1 worker pool of [`@app/plugin-host`](../plugin-host/README.md), off the main loop (I-5).

Tags: `type:adapter`, `runtime:node`. The codec sources import only relative `.ts` files and `node:` modules, because Node starts the worker itself and cannot resolve the `@app/*` aliases (a spec checks it).

## Public API

| Export                                                                                    | Notes                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decodePayload(input)`                                                                    | Pure and synchronous, **never throws**. `PayloadInput`: `body`, `bodyTruncated?`, `contentType?`, `contentEncoding?`, `queue?`, `rules?`, `limits?` (can only be tightened), `view?` (`hex` or `base64`). Returns a `DecodedPayload`.                 |
| `encodePayload(codec, value)`                                                             | The reversible half: text, json, msgpack, and the transforms (gzip, deflate, brotli, zstd, base64, hex) over bytes. Throws for a codec without an encoder.                                                                                         |
| `DecodedPayload`                                                                          | `codec`, `detected {type, mime, confidence, source: rule/header/sniff/fallback}`, `layers`, `view`, `error? {code, message, offset?}`, `notes`, `truncations`, `counters`.                                                                           |
| `PayloadView`                                                                             | `tree {value, text}`, `text {text, charset}`, `hex`, `base64`, `disassembly {deserialised: false}`.                                                                                                                                                 |
| `FORMAT_CODECS`, `TRANSFORM_CODECS`, `CodecPlugin`                                        | The registry. Format codecs: cloudevents, json, xml, msgpack, cbor, pickle, php, text. Transforms: gzip, deflate, brotli, zstd, base64, hex. `CodecPlugin {detect, decode, encode?}` is a stand-in until `plugin-sdk` lands (OQ-1201).             |
| `DEFAULT_LIMITS`, `CodecLimits`, `CODEC_MESSAGES`, `CodecErrorCode`                       | The limits (blueprint 11 tier 1) and the fixed error phrases.                                                                                                                                                                                       |
| `matchRule(rules, queue)`, `queueMatches(pattern, queue)`, `PayloadRule`                  | Per-queue rules: a pattern is exact or has one `*`; no regular expression.                                                                                                                                                                          |
| `codecWorkerUrl`, `codecPoolOptions()`                                                    | The worker module (`worker-entry.ts`) and the settings for `createWorkerPool`: 250 ms, 64 MB old generation, input 16 MiB, output 4 MiB.                                                                                                            |
| `builtinDecoders`, `DecoderPlugin`, `DecodeInput`, `NormalizedFailure`, `TypedHeaderValue` | The (still empty) DLQ framework decoders and their stand-in types, from the `decoder` generator. The `cloudevents` stub it generated was removed (OQ-1207).                                                                                         |

## How a body is decoded

1. A body above the input limit is shown as a hex prefix with `INPUT_LIMIT`.
2. The encodings are undone: the declared `content-encoding` (a list, last one first), then any gzip or zstd found by magic number. At most 3 layers; each layer's output is capped by the absolute cap and by a ratio cap while it inflates, so a bomb never allocates more than the allowance (`OUTPUT_LIMIT`, `RATIO_LIMIT`, `LAYER_LIMIT`).
3. The format: a **rule** for the queue, then the **content type**, then a **sniff** of the bytes, then hex. A specific content type is trusted: if its codec fails, the payload is shown as hex with the coded error (and the byte offset). A generic one (`text/plain`, `application/octet-stream`, none) lets the bytes decide, and a sniffed codec that fails leaves a note.
4. The view is cut to 4 MiB; every cut, every dropped node and every limit that fired is in `truncations` or `notes` (I-6, I-13).

## Invariants

- **Never throws, never loads.** `decodePayload` catches everything. Pickle streams and PHP `serialize()` text are shown as an opcode or token listing (`deserialised: false`); there is no `eval`, `Function`, `vm`, `child_process`, `require` or dynamic import in the library (a spec scans for them, OQ-1206).
- **Bounded.** Input 16 MiB, decompressed bytes 16 MiB (ratio 1000 above 64 KiB), 3 layers, depth 64, 200000 values, view 4 MiB, hex preview 64 KiB. A caller can only tighten them.
- **No payload bytes outside the view (I-10).** Errors are fixed phrases chosen by code; notes and truncations carry numbers; a property test plants a marker in hostile payloads and searches everything but the view.
- **Honest wording.** A pickle or PHP listing says "not loaded"; the words "safe" and "non-destructive" are not used.
- **Binary documents are first-party** (msgpack, cbor, xml; OQ-1201). Their declared lengths are checked against the bytes that are really left before anything is allocated.
- Not covered: protobuf, avro and other schema-bound formats (need a dependency, human-gated), CloudEvents binary mode (OQ-1207), a payload recorded from a real framework (OQ-1209).

Open questions: OQ-1200 to OQ-1209 in [docs/open-questions.md](../../../docs/open-questions.md).

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p decoders plugin-host testkit
```
