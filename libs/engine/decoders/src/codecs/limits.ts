// The limits of a decode (blueprint 11, trust tier 1; OQ-1204). A caller can only tighten them.
export interface CodecLimits {
  /** A body above this is not decoded; a prefix is shown in hex. */
  readonly maxInputBytes: number;
  /** Text, a tree's pretty text, or a listing above this is cut. */
  readonly maxViewBytes: number;
  /** All the layers of decompression together may not produce more than this. */
  readonly maxDecodedBytes: number;
  /** Output over input, checked once the output passes `ratioFloorBytes`. */
  readonly maxRatio: number;
  readonly ratioFloorBytes: number;
  readonly maxLayers: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
  /** The prefix of the bytes a hex or base64 view shows. */
  readonly previewBytes: number;
}

const MIB = 1024 * 1024;

export const DEFAULT_LIMITS: CodecLimits = Object.freeze({
  maxInputBytes: 16 * MIB,
  maxViewBytes: 4 * MIB,
  maxDecodedBytes: 16 * MIB,
  maxRatio: 1000,
  ratioFloorBytes: 64 * 1024,
  maxLayers: 3,
  maxDepth: 64,
  maxNodes: 200_000,
  previewBytes: 64 * 1024,
});

/** The effective limits: each is the smaller of the caller's value and the default. */
export function tightenLimits(asked: unknown): CodecLimits {
  if (typeof asked !== 'object' || asked === null) return DEFAULT_LIMITS;
  const out: Record<string, number> = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof CodecLimits)[]) {
    const value = (asked as Record<string, unknown>)[key];
    if (
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0
    ) {
      out[key] = Math.min(value, DEFAULT_LIMITS[key]);
    }
  }
  return Object.freeze(out) as unknown as CodecLimits;
}
