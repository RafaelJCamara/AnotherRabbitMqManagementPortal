// How a pool finds the codec worker, and the pool settings that go with it. Structural: this
// library (a `type:adapter`) cannot import @app/plugin-host (a `type:kernel`); the composition
// root passes the result to `createWorkerPool`.
import { DEFAULT_LIMITS } from './codecs/limits.ts';
import type { DecodedPayload, PayloadInput } from './payload/result.ts';

/**
 * The worker module, as a source file. Run from source (specs, `node`), this is the file next to
 * this one. In the engine bundle it must be a second esbuild entry emitted beside `main.mjs`
 * (OQ-1202): build the URL there with `new URL('./codec-worker.mjs', import.meta.url)`.
 */
export const codecWorkerUrl = new URL('./worker-entry.ts', import.meta.url);

export interface CodecPoolOptions {
  readonly workerUrl: URL;
  readonly sizeOfInput: (input: PayloadInput) => number;
  readonly sizeOfOutput: (output: DecodedPayload) => number;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
  readonly resourceLimits: {
    readonly maxOldGenerationSizeMb: number;
    readonly maxYoungGenerationSizeMb: number;
  };
}

/** Blueprint 11, tier 1: 250 ms a call, 64 MB old generation, input 16 MiB, output 4 MiB. */
export function codecPoolOptions(
  workerUrl: URL = codecWorkerUrl,
): CodecPoolOptions {
  return {
    workerUrl,
    sizeOfInput: (input) =>
      (input.body as unknown) instanceof Uint8Array ? input.body.byteLength : 0,
    sizeOfOutput: (output) => output.counters.viewBytes,
    maxInputBytes: DEFAULT_LIMITS.maxInputBytes,
    maxOutputBytes: DEFAULT_LIMITS.maxViewBytes,
    timeoutMs: 250,
    resourceLimits: {
      maxOldGenerationSizeMb: 64,
      maxYoungGenerationSizeMb: 16,
    },
  };
}
