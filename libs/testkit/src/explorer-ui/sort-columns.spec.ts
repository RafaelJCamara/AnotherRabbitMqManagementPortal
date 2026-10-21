// M0-54 AC-12: the columns the explorer UI offers to sort by are the ones the engine accepts. The UI keeps
// its own lists (explorer-model, Q-11); this spec runs the real window source of the model over the real
// `inventory.query` action through the real router, so a column added to one side and not the other fails here.
import {
  COLUMNS_BY_KIND,
  EXPLORER_KINDS,
  createInventoryWindowSource,
  sortableColumns,
  type ExplorerData,
  type ExplorerKind,
  type InventoryQueryInput,
  type InventoryQueryOutput,
} from '@app/explorer-model';
import {
  createExplorerFakeDeps,
  createInventoryQueryAction,
} from '@app/svc-explorer';
import { afterEach, describe, expect, it } from 'vitest';

import { createTestEngine, type TestEngine } from '../create-test-engine.ts';

let engine: TestEngine;

afterEach(async () => {
  await engine.close();
});

/** The explorer's data port over the real router: every `inventory.query` is an HTTP request to the engine. */
function overRouter(): ExplorerData {
  return {
    async query(input: InventoryQueryInput): Promise<InventoryQueryOutput> {
      const { cid, ...body } = input;
      const answer = await engine.inject({
        method: 'POST',
        path: `/connections/${cid}/inventory/queries`,
        payload: body,
      });
      if (answer.statusCode !== 200) {
        throw new Error(`${String(answer.statusCode)} ${answer.body}`);
      }
      return answer.json<InventoryQueryOutput>();
    },
    follow() {
      throw new Error('this spec reads windows only');
    },
  };
}

const sourceFor = (kind: ExplorerKind) =>
  createInventoryWindowSource(overRouter(), {
    cid: 'c1',
    kind,
    filter: kind === 'bindings' ? { vhosts: ['/'] } : {},
  });

describe('the sortable columns of the explorer UI', () => {
  it('AC-12 the sortable columns of the UI are the ones the engine accepts', async () => {
    engine = createTestEngine({
      actions: [
        createInventoryQueryAction(
          createExplorerFakeDeps({ ownerId: 'local-token' }),
        ),
      ],
    });
    const controller = new AbortController();
    for (const kind of EXPLORER_KINDS) {
      const source = sourceFor(kind);
      const offered = sortableColumns(kind);
      expect(offered.length).toBeGreaterThan(0);

      // Every column the UI marks sortable is accepted, in both directions, as `{column, dir}`.
      for (const column of offered) {
        for (const direction of ['asc', 'desc'] as const) {
          const answer = await source.window(
            {
              offset: 0,
              limit: 200,
              sort: [{ columnId: column, direction }],
            },
            controller.signal,
          );
          expect(answer.rows.length).toBeLessThanOrEqual(200);
        }
      }

      // Every column it does not mark is refused by the engine, so the UI is right not to offer it.
      const notOffered = COLUMNS_BY_KIND[kind]
        .filter((c) => !offered.includes(c.id))
        .map((c) => c.id);
      for (const column of [...notOffered, 'no-such-column']) {
        await expect(
          source.window(
            {
              offset: 0,
              limit: 200,
              sort: [{ columnId: column, direction: 'asc' }],
            },
            controller.signal,
          ),
        ).rejects.toThrow(/400/);
      }
      source.destroy();
    }
  });
});
