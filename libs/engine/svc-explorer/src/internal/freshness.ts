// What an answer says about the data it came from (I-13). Every reason is a fixed string: no broker
// text and no URL ever reaches an output (I-10).
import type { FreshnessSchema, InventoryKind } from '@app/contracts';
import type { z } from 'zod';

import type { IndexVersion } from './index';

export type Freshness = z.infer<typeof FreshnessSchema>;

export const REASONS = {
  loading: 'The first read of the inventory is still running.',
  failed:
    'The last read of the inventory failed; these rows are from an earlier read.',
  partial: 'Part of the inventory could not be read.',
  unavailable: 'The inventory is not being read.',
} as const;

/**
 * Registry hazard ids that explain a missing column in the rows of a kind. The profile lists the
 * hazards that apply to its broker (the registry decides that, I-3); this table only says which of
 * them concern which rows.
 */
const ROW_HAZARDS: Readonly<Record<InventoryKind, readonly string[]>> = {
  queues: ['stats-off-policy-fields-missing'],
  exchanges: [],
};

export interface FreshnessInput {
  kind: InventoryKind;
  /** The kind has been installed at least once. */
  installed: boolean;
  version: IndexVersion;
  /** Rows of this kind in the index. */
  loaded: number;
  expected: number | undefined;
  /** A sweep is running now. */
  sweeping: boolean;
  profileHazards: readonly string[];
  versionChanged: boolean;
}

export function describeFreshness(input: FreshnessInput): Freshness {
  const { installed, version } = input;
  let state: Freshness['state'];
  let reason: string | undefined;
  if (version.stale) {
    state = installed ? 'stale' : 'unavailable';
    reason = installed ? REASONS.failed : REASONS.unavailable;
  } else if (!installed || (!version.complete && input.sweeping)) {
    state = 'loading';
    reason = REASONS.loading;
  } else if (version.complete) {
    state = 'live';
  } else {
    state = 'stale';
    reason = REASONS.partial;
  }
  return {
    state,
    ...(version.version > 0 ? { sweptAt: version.sweptAt } : {}),
    // Never claimed while a kind is missing or was read partially.
    complete: installed && version.complete,
    loaded: input.loaded,
    ...(input.expected === undefined ? {} : { expected: input.expected }),
    truncated: version.truncated,
    dropped: version.dropped,
    hazards: ROW_HAZARDS[input.kind].filter((id) =>
      input.profileHazards.includes(id),
    ),
    versionChanged: input.versionChanged,
    ...(reason === undefined ? {} : { reason }),
  };
}

/** The freshness of a connection whose index does not exist (the module was stopped). */
export const UNAVAILABLE_VERSION: IndexVersion = {
  version: 0,
  sweptAt: 0,
  complete: false,
  dropped: 0,
  truncated: false,
  stale: true,
};
