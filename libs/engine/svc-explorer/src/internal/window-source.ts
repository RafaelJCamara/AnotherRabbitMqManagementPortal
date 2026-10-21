// The source of the explorer.window topic (M0-48 slice E). A grid names the keys it shows; the
// source follows the sweeper's installs and publishes only what changed for those keys: an upsert
// of a visible row, a removal of a visible key that left the inventory, and one `~version` item
// when rows were added or removed (membership), so the grid can refresh its cache. The hub owns
// coalescing, pacing (maxHz), the ring bounds and `gap` then `snapshot` on overflow (I-6, I-13).
//
// The hub asks the source synchronously, but whether a caller may see a connection is an async
// read. So a subscription is admitted first: until then the snapshot is empty and nothing is
// followed (an unknown connection never gets an index, a sweep or a listener); once admitted, the
// current rows of the visible keys are published, which the outbox absorbs if the first snapshot
// has not been taken yet and sends as a delta if it has. An invisible and an unknown connection
// end the subscription with the same NOT_FOUND Problem.
import {
  EXPLORER_VERSION_KEY,
  type ConnectionId,
  type ExplorerWindowItemSchema,
  type ExplorerWindowParamsSchema,
  type Problem,
} from '@app/contracts';
import { AppError, toProblem } from '@app/kernel';
import type { TopicSource } from '@app/live';
import type { z } from 'zod';

import type { ExplorerModuleDeps } from '../deps';

import type { IndexChange } from './index';
import { readProfile } from './profile';
import type { IndexRow } from './rows';
import type { Sweeper } from './sweeper';
import { requireVisible } from './visible';

export type WindowParams = z.infer<typeof ExplorerWindowParamsSchema>;
export type WindowItem = z.infer<typeof ExplorerWindowItemSchema>;

export type WindowSourceDeps = Pick<
  ExplorerModuleDeps,
  'connections' | 'profiles'
> & { readonly sweeper: Pick<Sweeper, 'touch' | 'index' | 'onInstall'> };

export interface WindowSource extends TopicSource<WindowParams, WindowItem> {
  /** Ends every subscription (the engine is stopping) and refuses new ones. */
  stop(): void;
}

/** An item for a row: the key travels once, beside the row (the item contract explains why). */
function rowItem(row: IndexRow, version: number): WindowItem {
  const { key, ...rest } = row;
  return { key, version, row: rest };
}

const shuttingDown = (): Problem =>
  toProblem(
    new AppError('ENGINE_SHUTTING_DOWN', {
      detail: 'The engine is shutting down.',
    }),
  );

export function createWindowSource(deps: WindowSourceDeps): WindowSource {
  /** Live subscriptions admitted for a (principal, connection): what the snapshot may show. */
  const admitted = new Map<string, number>();
  const live = new Set<(problem?: Problem) => void>();
  let closed = false;
  const clearance = (principal: { id: string }, cid: ConnectionId): string =>
    `${principal.id}\u0000${cid}`;

  return {
    snapshot(params, principal) {
      const index = admitted.has(clearance(principal, params.cid))
        ? deps.sweeper.index(params.cid)
        : undefined;
      const items: WindowItem[] = [];
      if (index !== undefined) {
        const { version } = index.current();
        for (const row of index.byKeys(params.kind, [
          ...new Set(params.keys),
        ])) {
          items.push(rowItem(row, version));
        }
        items.push({ key: EXPLORER_VERSION_KEY, version });
      }
      // The hub ends a subscription whose snapshot is over a frame (OQ-125): the size is measured.
      return {
        value: items,
        bytes: Buffer.byteLength(JSON.stringify(items)),
      };
    },

    subscribe(params, principal, sink) {
      const id = clearance(principal, params.cid);
      const wanted = new Set<string>(params.keys);
      let phase: 'admitting' | 'following' | 'stopped' = 'admitting';
      let unfollow: (() => void) | undefined;

      const stop = (problem?: Problem): void => {
        if (phase === 'stopped') return;
        if (phase === 'following') {
          const left = (admitted.get(id) ?? 1) - 1;
          if (left > 0) admitted.set(id, left);
          else admitted.delete(id);
        }
        phase = 'stopped';
        unfollow?.();
        live.delete(stop);
        if (problem !== undefined) sink.end(problem);
      };

      const follow = (change: IndexChange): void => {
        if (change.kind !== params.kind) return;
        try {
          for (const row of change.upserts) {
            if (wanted.has(row.key)) {
              sink.publish(rowItem(row, change.version));
            }
          }
          for (const key of change.removes) {
            if (wanted.has(key)) sink.remove(key);
          }
          if (change.membershipChanged) {
            sink.publish({
              key: EXPLORER_VERSION_KEY,
              version: change.version,
            });
          }
        } catch (error) {
          // A listener must never break the sweep that installs the version.
          stop(toProblem(error));
        }
      };

      const admit = async (): Promise<void> => {
        if (closed) throw new AppError('ENGINE_SHUTTING_DOWN');
        await requireVisible(deps.connections, params.cid, principal.id);
        await readProfile(deps.profiles, params.cid);
      };

      live.add(stop);
      admit()
        .then(() => {
          if (phase !== 'admitting') return;
          phase = 'following';
          admitted.set(id, (admitted.get(id) ?? 0) + 1);
          deps.sweeper.touch(params.cid);
          unfollow = deps.sweeper.onInstall(params.cid, follow);
          const index = deps.sweeper.index(params.cid);
          if (index === undefined) return;
          const { version } = index.current();
          for (const row of index.byKeys(params.kind, [...wanted])) {
            sink.publish(rowItem(row, version));
          }
          sink.publish({ key: EXPLORER_VERSION_KEY, version });
        })
        .catch((error: unknown) => {
          stop(toProblem(error));
        });
      return () => {
        stop();
      };
    },

    stop() {
      closed = true;
      for (const end of [...live]) end(shuttingDown());
    },
  };
}
