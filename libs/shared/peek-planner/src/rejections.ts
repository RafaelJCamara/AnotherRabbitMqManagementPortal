// Rejections (M1-12 R2): a plan that cannot be made returns a closed code, closed reason codes and
// a text key, never prose. The UI words them from `i18n/en/peek-planner.json`; an unknown code
// cannot be built because the constructor takes the code as a type.
import type { WarningRef } from '@app/contracts';
import type { Disposition } from './types.ts';

/** The order of this list is the order of R2 (the first match wins). */
export const REJECTION_CODES = [
  'INVALID_REQUEST',
  'GATE',
  'STREAM_QUEUE',
  'EXCLUSIVE',
  'UNVERIFIED_BROKER',
  'NO_QUORUM',
  'SAC_ACTIVE',
  'SEMANTICS_GAP',
  'LIMIT_MINUS1_313',
  'OVERLIMIT_DLQ',
  'BUDGET_TOO_SMALL',
  'METHOD_UNAVAILABLE',
  'NO_SAFE_DISPOSITION',
  'RESCUE_PREFLIGHT_FAILED',
] as const;
export type RejectionCode = (typeof REJECTION_CODES)[number];

/** Why, in finer grain than the code. A rejection always has at least one. */
export const REASON_CODES = [
  // INVALID_REQUEST
  'count-invalid',
  'queue-key-invalid',
  'max-bytes-invalid',
  'preflight-number-invalid',
  'raise-limit-value-invalid',
  'typed-consent-mismatch',
  // GATE, STREAM_QUEUE, EXCLUSIVE, UNVERIFIED_BROKER, NO_QUORUM, SAC_ACTIVE
  'gate-disabled',
  'queue-is-stream',
  'exclusive-owned-by-other',
  'unverified-broker',
  'quorum-unhealthy',
  'sac-active-consumer',
  // SEMANTICS_GAP, LIMIT_MINUS1_313, OVERLIMIT_DLQ
  'semantics-gap',
  'limit-minus1-destructive',
  'dlx-sources-over-limit',
  'dlx-source-unbounded',
  // BUDGET_TOO_SMALL
  'rtt-invalid',
  'rtt-exceeds-target',
  'hold-hard-abort-too-small',
  'avg-message-exceeds-bytes',
  // METHOD_UNAVAILABLE
  'amqp10-not-available',
  'sac-consumer-path-unavailable',
  'http-limit-finite',
  'http-limit-unknown',
  'http-era-not-strict',
  'http-not-provably-non-dlx',
  'http-held-death-unchecked',
  // NO_SAFE_DISPOSITION
  'limit-unknown',
  'dlx-evidence-unverified',
  'no-safe-disposition',
  'let-broker-handle-non-human',
  'raise-limit-not-admin',
  'raise-limit-capped',
  'raise-limit-protected-name',
  'raise-limit-unknown-limit',
  'raise-limit-stale',
  // RESCUE_PREFLIGHT_FAILED
  'no-rescue',
  'rescue-queue-not-ready',
  'rescue-overflow-unsafe',
  'rescue-permission',
  'rescue-alarm',
  'rescue-publish-blocked',
  'rescue-stale',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** A one-click fix the UI can offer; data, because no policy-write action exists yet (OQ-1434). */
export interface SuggestedFix {
  readonly kind: 'delivery-limit-policy';
  readonly queue: string;
  /** Always `-1`: unlimited is safe in every era where the registry allows it. */
  readonly limit: -1;
  /** The lowest finite limit that is safe; `null` when a source is unlimited (only `-1` is). */
  readonly minimumFinite: number | null;
}

export interface PeekRejection {
  readonly rejected: true;
  readonly code: RejectionCode;
  readonly textKey: string;
  readonly textVersion: 1;
  readonly reasons: readonly ReasonCode[];
  readonly warnings: readonly WarningRef[];
  readonly fix?: SuggestedFix;
  /** Dispositions a person could choose instead (R8). */
  readonly offers?: readonly Disposition['kind'][];
}

export const TEXT_VERSION = 1;

/** The scope of the planner's translation file; also the first segment of every text key. */
export const TEXT_SCOPE = 'peek-planner';

export const rejectionTextKey = (code: RejectionCode): string =>
  `${TEXT_SCOPE}.rejections.${code}.v${String(TEXT_VERSION)}`;

export const reasonTextKey = (reason: ReasonCode): string =>
  `${TEXT_SCOPE}.reasons.${reason}.v${String(TEXT_VERSION)}`;

export const HONEST_LABEL_KEY = `${TEXT_SCOPE}.honestLabel.v${String(TEXT_VERSION)}`;

const compareText = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

export interface RejectionExtras {
  readonly warnings?: readonly WarningRef[] | undefined;
  readonly fix?: SuggestedFix | undefined;
  readonly offers?: readonly Disposition['kind'][] | undefined;
}

/**
 * Builds a rejection. Reasons are de-duplicated and sorted so that two runs agree; at least one is
 * required (the first argument is a tuple type).
 */
export function reject(
  code: RejectionCode,
  reasons: readonly [ReasonCode, ...ReasonCode[]],
  extras: RejectionExtras = {},
): PeekRejection {
  const result: {
    -readonly [K in keyof PeekRejection]: PeekRejection[K];
  } = {
    rejected: true,
    code,
    textKey: rejectionTextKey(code),
    textVersion: TEXT_VERSION,
    reasons: [...new Set(reasons)].sort(compareText),
    warnings: [...(extras.warnings ?? [])].sort((a, b) =>
      compareText(a.id, b.id),
    ),
  };
  if (extras.fix !== undefined) result.fix = extras.fix;
  if (extras.offers !== undefined) {
    result.offers = [...extras.offers].sort(compareText);
  }
  return result;
}

export const isRejection = (value: unknown): value is PeekRejection =>
  typeof value === 'object' &&
  value !== null &&
  (value as { rejected?: unknown }).rejected === true;
