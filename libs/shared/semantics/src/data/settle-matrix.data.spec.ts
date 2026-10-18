import { describe, expect, it } from 'vitest';
import { auditCells } from '../audit.ts';
import { SemanticsCellSchema } from '../schema.ts';
import { settleMatrix } from './settle-matrix.data.ts';

describe('settleMatrix', () => {
  it('has only cells the schema accepts', () => {
    for (const cell of settleMatrix) {
      expect(SemanticsCellSchema.safeParse(cell).success, cell.id).toBe(true);
    }
  });

  it('passes the cell audit (unique ids and keys, conformance ids, evidence rules)', () => {
    expect(auditCells(settleMatrix)).toEqual([]);
  });
});
