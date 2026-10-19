// Every conformance id a registry cell names has a lab-cell stub here (blueprint 5.2): a cell must
// not point at a lab cell that does not exist. The stub files are made by the `conformance-cell`
// generator; the evidence they will compare with is recorded elsewhere and never written here.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { registryData } from '@app/semantics';
import { describe, expect, it } from 'vitest';

describe('registry links', () => {
  it('every conformance id of a registry cell has a lab-cell stub', () => {
    const ids = new Set(registryData.cells.flatMap((cell) => cell.conformance));
    expect(ids.size).toBeGreaterThan(0);
    for (const id of ids) {
      const stub = join(
        import.meta.dirname,
        `${id.toLowerCase()}.cell.spec.ts`,
      );
      expect(existsSync(stub), `${id} needs ${stub}`).toBe(true);
    }
  });
});
