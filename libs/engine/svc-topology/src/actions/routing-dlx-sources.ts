// routing.dlx-sources: Every queue that can dead-letter into a queue (amendment A-2)
// The answer keeps the pair the safety gates read: `sources` and `complete`. An empty list is "no
// hazard" only when `complete` is true, and nothing here folds the two into one verdict. Causes the
// library cannot see are added as reasons: a vhost that was read only in part, a policy match that
// could not be decided, and a list that is longer than the contract carries.
import { routingDlxSources } from '@app/contracts';
import { AppError, implementAction, type ActionImpl } from '@app/kernel';
import { dlxSources } from '@app/routing';

import { contextGaps } from '../internal/gaps';
import {
  loadVhost,
  routingInput,
  snapshotMeta,
  type ActionDeps,
} from '../internal/load';
import { SOURCES_LIMITS } from '../internal/routing-limits';
import {
  capList,
  dlxTruncationView,
  sourceView,
  unknownReasonView,
} from '../internal/routing-view';

/** The ports this action reads through (src/internal/load.ts). */
export type RoutingDlxSourcesDeps = ActionDeps;

export const createRoutingDlxSourcesAction = (
  deps: RoutingDlxSourcesDeps,
): ActionImpl<typeof routingDlxSources> =>
  implementAction(routingDlxSources, {
    execute: async (input, ctx) => {
      const loaded = await loadVhost(deps, input, ctx);
      const converted = await routingInput(deps, loaded);
      const target = converted.topology.queues.find(
        (queue) => queue.name === input.queue,
      );
      if (target === undefined) {
        throw new AppError('NOT_FOUND', {
          detail:
            loaded.snapshot.truncation.queues > 0
              ? 'The queue is not among the queues that were read; the vhost is larger than the limit.'
              : 'There is no such queue.',
        });
      }
      // The x-death sources the caller read from the messages the queue holds (OQ-1407).
      const held = [...new Set(input.heldDeathSources ?? [])].sort();
      const topology =
        held.length === 0
          ? converted.topology
          : {
              ...converted.topology,
              queues: converted.topology.queues.map((queue) =>
                queue === target ? { ...queue, heldDeathSources: held } : queue,
              ),
            };
      const result = dlxSources(topology, input.queue, {
        gaps: contextGaps(converted.gaps),
        limits: SOURCES_LIMITS,
      });

      // Causes the library cannot see, as reasons: the list is not complete because of them.
      const extra: ReturnType<typeof unknownReasonView>[] = [];
      if (converted.gaps.includes('truncated')) {
        extra.push({ code: 'truncated', subject: 'snapshot' });
      }
      if (converted.gaps.includes('policy-match-undecided')) {
        extra.push({ code: 'policy-match-undecided' });
      }
      const sources = capList(result.sources.map(sourceView));
      if (sources.more > 0)
        extra.push({ code: 'truncated', subject: 'sources' });
      const reasons = capList([
        ...result.unknownReasons.map(unknownReasonView),
        ...extra,
      ]);
      return {
        vhost: input.vhost,
        queue: input.queue,
        sources: sources.items,
        sourcesMore: sources.more,
        complete: result.complete && extra.length === 0,
        unknownReasons: reasons.items,
        unknownReasonsMore: reasons.more,
        truncation: dlxTruncationView(result.truncation),
        heldDeathSourcesConsidered: held,
        gaps: [...converted.gaps],
        snapshot: snapshotMeta(loaded.snapshot),
      };
    },
  });
