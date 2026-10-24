// routing.dead-letter: Where a message goes when it dies in a queue, and the loops of that queue
// The pure dead-letter walk of @app/routing over the vhost as read, with the dead-letter loops that
// include the queue. A drop loop (no queue in it can reject) is told from a retry ring by the
// consumers that acknowledge, which the snapshot read best effort (OQ-1411).
import { routingDeadLetter } from '@app/contracts';
import { AppError, implementAction, type ActionImpl } from '@app/kernel';
import { deadLetterPath, findDlxLoops, indexDeadLetters } from '@app/routing';

import {
  loadVhost,
  routingInput,
  snapshotMeta,
  type ActionDeps,
} from '../internal/load';
import { DEAD_LETTER_LIMITS } from '../internal/routing-limits';
import {
  capList,
  deadLetterPathView,
  dlxTruncationView,
  loopView,
  noteView,
} from '../internal/routing-view';

/** The ports this action reads through (src/internal/load.ts). */
export type RoutingDeadLetterDeps = ActionDeps;

export const createRoutingDeadLetterAction = (
  deps: RoutingDeadLetterDeps,
): ActionImpl<typeof routingDeadLetter> =>
  implementAction(routingDeadLetter, {
    execute: async (input, ctx) => {
      const loaded = await loadVhost(deps, input, ctx);
      const converted = await routingInput(deps, loaded);
      const index = indexDeadLetters(converted.topology);
      const walk = deadLetterPath(index, input.queue, {
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(input.keys === undefined ? {} : { keys: input.keys }),
        limits: DEAD_LETTER_LIMITS,
      });
      if (!walk.startFound) {
        const cut = loaded.snapshot.truncation.queues > 0;
        throw new AppError('NOT_FOUND', {
          detail: cut
            ? 'The queue is not among the queues that were read; the vhost is larger than the limit.'
            : 'There is no such queue.',
        });
      }
      const loops = findDlxLoops(index, DEAD_LETTER_LIMITS);
      const reached = capList(walk.reached);
      return {
        vhost: input.vhost,
        queue: input.queue,
        paths: walk.paths.map(deadLetterPathView),
        reached: reached.items,
        reachedMore: reached.more,
        exact: walk.exact && converted.gaps.length === 0,
        notes: walk.notes.map(noteView),
        truncation: dlxTruncationView(walk.truncation),
        loops: loops.loops
          .filter((loop) => loop.queues.includes(input.queue))
          .map(loopView),
        loopsTruncation: dlxTruncationView(loops.truncation),
        consumers: loaded.snapshot.consumers,
        gaps: [...converted.gaps],
        snapshot: snapshotMeta(loaded.snapshot),
      };
    },
  });
