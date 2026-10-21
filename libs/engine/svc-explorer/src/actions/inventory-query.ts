// inventory.query: Read a window of the inventory of a connection
// Slice A ships the contract and this stub only. The stub answers an empty window whose freshness
// says `unavailable` (I-13: never an empty list that looks complete); the index, the sweeper and the
// visibility check arrive with the slices that follow (docs/specs/M0-48.md).
import { inventoryQuery } from '@app/contracts';
import { implementAction, type ActionImpl } from '@app/kernel';

import type { ExplorerModuleDeps } from '../deps';

/** The ports this action reads through: a subset of the module's deps (src/deps.ts). */
export type InventoryQueryDeps = Pick<
  ExplorerModuleDeps,
  'connections' | 'profiles'
>;

export const createInventoryQueryAction: (
  deps: InventoryQueryDeps,
) => ActionImpl<typeof inventoryQuery> = () =>
  implementAction(inventoryQuery, {
    execute: (input) =>
      Promise.resolve({
        kind: input.kind,
        rows: [],
        window: { offset: input.window.offset, limit: input.window.limit },
        total: 0,
        matched: 0,
        version: 0,
        freshness: {
          state: 'unavailable' as const,
          complete: false,
          loaded: 0,
          truncated: false,
          dropped: 0,
          hazards: [],
          versionChanged: false,
          reason: 'The inventory index is not available yet.',
        },
      }),
  });
