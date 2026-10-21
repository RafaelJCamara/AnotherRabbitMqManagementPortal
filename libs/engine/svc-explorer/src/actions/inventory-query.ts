// inventory.query: Read a window of the inventory of a connection
// A window is read from the engine-resident index and never from the broker (I-7, I-8): the first
// query of a connection starts its sweeps and is answered at once from what has been installed,
// labelled `loading` and incomplete (I-13), never held until the sweep ends.
import { inventoryQuery, type InventoryKind } from '@app/contracts';
import { AppError, implementAction, type ActionImpl } from '@app/kernel';

import type { ExplorerModuleDeps } from '../deps';
import type { BindingsStore } from '../internal/bindings';
import { describeFreshness, UNAVAILABLE_VERSION } from '../internal/freshness';
import type { Sweeper } from '../internal/sweeper';
import { readProfile } from '../internal/profile';
import type { ConnectionRow, ExchangeRow, QueueRow } from '../internal/rows';
import { requireVisible } from '../internal/visible';

/** The ports this action reads through: a subset of the module's deps (src/deps.ts) and the sweeper. */
export type InventoryQueryDeps = Pick<
  ExplorerModuleDeps,
  'connections' | 'profiles'
> & {
  readonly sweeper: Pick<Sweeper, 'touch' | 'index' | 'status'>;
  readonly bindings: BindingsStore;
};

/** The columns a window can be sorted by, per kind. */
const SORT_COLUMNS: Readonly<Record<InventoryKind, readonly string[]>> = {
  queues: [
    'name',
    'vhost',
    'type',
    'state',
    'node',
    'durable',
    'autoDelete',
    'exclusive',
    'messages',
    'messagesReady',
    'messagesUnacknowledged',
    'consumers',
    'policy',
    'operatorPolicy',
    'deliveryLimit',
  ],
  exchanges: ['name', 'vhost', 'type', 'durable', 'autoDelete', 'internal'],
  connections: [
    'name',
    'vhost',
    'user',
    'node',
    'state',
    'protocol',
    'channels',
    'peerHost',
    'ssl',
  ],
  bindings: ['source', 'destination', 'destinationType', 'routingKey', 'vhost'],
};

export const createInventoryQueryAction: (
  deps: InventoryQueryDeps,
) => ActionImpl<typeof inventoryQuery> = (deps) =>
  implementAction(inventoryQuery, {
    execute: async (input, ctx) => {
      const { cid, kind, window } = input;
      await requireVisible(deps.connections, cid, ctx.principal.id);
      const profile = await readProfile(deps.profiles, cid);
      if (
        input.sort !== undefined &&
        !SORT_COLUMNS[kind].includes(input.sort.column)
      ) {
        throw new AppError('VALIDATION_FAILED', {
          detail: 'The inventory cannot be sorted by that column.',
        });
      }

      if (kind === 'bindings') {
        // Bindings are never listed whole (I-7): exactly one vhost, read on demand, outside the sweep.
        const vhosts = input.filter?.vhosts;
        const [vhost] = vhosts ?? [];
        if (vhost === undefined || vhosts?.length !== 1) {
          throw new AppError('VALIDATION_FAILED', {
            detail:
              'A bindings query names exactly one vhost in filter.vhosts.',
          });
        }
        const read = await deps.bindings.window(
          cid,
          vhost,
          { ...window, filter: input.filter, sort: input.sort },
          ctx.signal,
        );
        return {
          kind,
          rows: [...read.rows],
          window: { offset: window.offset, limit: window.limit },
          total: read.total,
          matched: read.matched,
          version: read.version.version,
          freshness: describeFreshness({
            kind,
            installed: true,
            version: read.version,
            loaded: read.total,
            expected: read.expected,
            sweeping: false,
            profileHazards: profile.hazards,
            versionChanged: read.versionChanged,
            unpaged: read.unpaged,
            droppedIsMinimum: !read.countExact,
          }),
        };
      }

      deps.sweeper.touch(cid);
      const index = deps.sweeper.index(cid);
      const status = deps.sweeper.status(cid);
      const read = index?.window({
        kind,
        filter: input.filter,
        sort: input.sort,
        offset: window.offset,
        limit: window.limit,
        version: window.version,
      });
      const version = read?.version ?? UNAVAILABLE_VERSION;
      const total = read?.total ?? 0;
      const meta = {
        window: { offset: window.offset, limit: window.limit },
        total,
        matched: read?.matched ?? 0,
        version: version.version,
        freshness: describeFreshness({
          kind,
          installed: index?.has(kind) ?? false,
          version,
          loaded: total,
          expected: status.expected.get(kind),
          sweeping: status.sweeping,
          profileHazards: profile.hazards,
          versionChanged: read?.versionChanged ?? false,
        }),
      };
      // The index holds only rows of the kind that was asked for here.
      const rows = read?.rows ?? [];
      if (kind === 'queues') return { kind, rows: rows as QueueRow[], ...meta };
      if (kind === 'exchanges') {
        return { kind, rows: rows as ExchangeRow[], ...meta };
      }
      return { kind, rows: rows as ConnectionRow[], ...meta };
    },
  });
