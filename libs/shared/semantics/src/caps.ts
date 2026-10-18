// Peek caps (blueprint 5.4): how many messages one peek may take by default and at most, and how
// many bytes, per era, queue type and role. A broker build that is not verified gets the
// conservative row's defaults as its ceiling (blueprint 5.2, "Verification state").
import {
  EraSchema,
  QueueTypeSchema,
  type Era,
  type QueueType,
  type Verification,
} from '@app/domain-model';
import { z } from 'zod';
import { RegistryDataError, SemanticsGapError } from './schema.ts';

export const PeekRoleSchema = z.enum(['user', 'admin']);
export type PeekRole = z.infer<typeof PeekRoleSchema>;

const positiveInt = z.number().int().positive();

export const PeekCapRowSchema = z
  .strictObject({
    era: EraSchema,
    queueType: QueueTypeSchema,
    role: PeekRoleSchema,
    def: positiveInt,
    max: positiveInt,
    maxBytes: positiveInt,
  })
  .refine((row) => row.def <= row.max, {
    message: 'the default count must not exceed the maximum',
  });
export type PeekCapRow = z.infer<typeof PeekCapRowSchema>;

export interface PeekCaps {
  readonly def: number;
  readonly max: number;
  readonly maxBytes: number;
}

/** The era whose rules are the conservative fallback (blueprint 5.2). */
const CONSERVATIVE_ERA: Era = '4.0-4.2';

const rowKey = (era: Era, queueType: QueueType, role: PeekRole): string =>
  `${era}|${queueType}|${role}`;

/**
 * Builds the lookup. A missing row throws SemanticsGapError. For a build that is not `verified`
 * the result is capped by the conservative era's row: both the default and the maximum count
 * are at most that row's default count, and the byte cap at most its byte cap.
 */
export function buildPeekCaps(
  rows: readonly PeekCapRow[],
): (
  era: Era,
  queueType: QueueType,
  role: PeekRole,
  verification: Verification,
) => PeekCaps {
  const byKey = new Map<string, PeekCapRow>();
  for (const row of rows) {
    const key = rowKey(row.era, row.queueType, row.role);
    if (byKey.has(key)) {
      throw new RegistryDataError([`peek caps ${key} are defined twice`]);
    }
    byKey.set(key, row);
  }

  const find = (era: Era, queueType: QueueType, role: PeekRole): PeekCapRow => {
    const key = rowKey(era, queueType, role);
    const row = byKey.get(key);
    if (row === undefined) {
      throw new SemanticsGapError({ table: 'peek-caps', id: key });
    }
    return row;
  };

  return (era, queueType, role, verification) => {
    const row = find(era, queueType, role);
    if (verification === 'verified') {
      return { def: row.def, max: row.max, maxBytes: row.maxBytes };
    }
    const conservative = find(CONSERVATIVE_ERA, queueType, role);
    return {
      def: Math.min(row.def, conservative.def),
      max: Math.min(row.max, conservative.def),
      maxBytes: Math.min(row.maxBytes, conservative.maxBytes),
    };
  };
}
