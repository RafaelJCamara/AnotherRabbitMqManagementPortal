// What the check keeps of a registry cell. The dump script prints the cells of one revision as JSON
// and this schema reads them back, so the check does not depend on the registry library of the
// revision it looks at (the base revision may be older than the head).
import { z } from 'zod';
import { canonicalJson } from './evidence-format.ts';

export const CellSnapshotSchema = z.object({
  id: z.string().min(1),
  /** `cellKeyString(cell.key)`: the identity of a cell, because it is what a lookup uses. */
  keyString: z.string().min(1),
  era: z.string().min(1),
  effect: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .nullable(),
  status: z.enum(['code-derived', 'lab-verified', 'lab-contradicted']),
  conformance: z.array(z.string()),
  evidence: z.array(z.string()),
});
export type CellSnapshot = z.infer<typeof CellSnapshotSchema>;

export const DumpSchema = z.object({
  cells: z.array(CellSnapshotSchema),
  /** The era of each broker version asked for. */
  eras: z.record(z.string(), z.string()),
});

export const effectKey = (cell: CellSnapshot): string =>
  canonicalJson(cell.effect);
