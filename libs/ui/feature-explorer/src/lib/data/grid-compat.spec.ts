import type {
  ExplorerKind,
  InventoryRows,
  InventoryWindowSource,
} from '@app/explorer-model';
import { createFakeExplorerData } from '@app/explorer-model/testing';
import { createInventoryWindowSource } from '@app/explorer-model';
import type { EngineWindowSource } from '@app/ui-grid';
import { describe, expect, it } from 'vitest';

/**
 * The model declares the grid's window types as plain shapes (it cannot import `ui-grid`). This is
 * the compile-time guard that they stay assignable: a drift fails `typecheck` of this project.
 */
function asGridSource<K extends ExplorerKind>(
  source: InventoryWindowSource<K>,
): EngineWindowSource<InventoryRows[K]> {
  return source;
}

describe('the explorer window source and ui-grid', () => {
  it('is assignable to the grid EngineWindowSource for every kind', () => {
    const data = createFakeExplorerData();
    const queues = asGridSource(
      createInventoryWindowSource(data, {
        cid: 'c1',
        kind: 'queues',
        filter: {},
      }),
    );
    const bindings = asGridSource(
      createInventoryWindowSource(data, {
        cid: 'c1',
        kind: 'bindings',
        filter: { vhosts: ['/'] },
      }),
    );
    expect(queues.rowId).toBeTypeOf('function');
    expect(bindings.rowId).toBeTypeOf('function');
  });
});
