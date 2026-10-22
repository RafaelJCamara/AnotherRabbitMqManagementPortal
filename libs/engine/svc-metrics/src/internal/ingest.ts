// From scraped samples to stored points. A round is one pass over every target of a plan: each
// sample is mapped to a series by the catalogue, and when the commit comes one value per series is
// chosen and stored with one timestamp, so the nodes of a cluster do not write the same cluster-wide
// series several times (OQ-868).
//
//  - a cluster series (messages, connections, ...) is cluster-wide on every node: the value of the
//    lowest node name wins;
//  - a node series (memory, disk) keeps its node;
//  - a queue series is the leader's value when the round saw the queue's `membership="leader"`
//    sample, else the lowest node's.
//
// Candidates are bounded (`maxRoundCandidates`); a sample past it, a sample of a queue nobody asked
// for and a value that is not a finite number are counted, not stored (I-6, I-13).
import type { ConnectionId } from '@app/contracts';
import type { PromSample } from '@app/ports';

import type { MetricsLimits } from '../deps';

import { isQueueInfo, metricOf } from './catalog';
import {
  queueKeyOf,
  type HotStore,
  type SeriesParts,
  type SeriesSource,
} from './store-hot';

export interface RoundSummary {
  /** Points stored. */
  readonly stored: number;
  /** Series the store refused (the queue-series cap). */
  readonly refused: number;
  /** Samples not stored: over the round's limit, not finite, or of a queue nobody asked for. */
  readonly droppedSamples: number;
}

export interface Round {
  add(node: string, sample: PromSample): void;
  commit(
    store: HotStore,
    cid: ConnectionId,
    at: number,
    meta: { source: SeriesSource; approximate: boolean },
  ): RoundSummary;
}

interface Candidate {
  readonly node: string;
  readonly value: number;
}

interface Pending {
  readonly parts: SeriesParts;
  readonly candidates: Candidate[];
}

const SEP = '\u001f';

/**
 * Starts a round. `wantedQueues` are the queues somebody asked for (`vhost SEP name` keys); samples of
 * other queues are ignored, which keeps an unfiltered detailed read from filling the store.
 */
export function beginRound(
  limits: Pick<MetricsLimits, 'maxRoundCandidates'>,
  wantedQueues: ReadonlySet<string>,
): Round {
  const pending = new Map<string, Pending>();
  const leaders = new Map<string, string>();
  let candidates = 0;
  let droppedSamples = 0;

  return {
    add(node, sample) {
      if (isQueueInfo(sample.name)) {
        const { vhost, queue, membership } = sample.labels;
        if (
          vhost !== undefined &&
          queue !== undefined &&
          membership === 'leader'
        ) {
          leaders.set(queueKeyOf(vhost, queue), node);
        }
        return;
      }
      const def = metricOf(sample.name);
      if (def === undefined) return;
      if (!Number.isFinite(sample.value)) {
        droppedSamples++;
        return;
      }
      let parts: SeriesParts;
      let key: string;
      if (def.scope === 'queue') {
        const { vhost, queue } = sample.labels;
        if (vhost === undefined || queue === undefined) return;
        if (!wantedQueues.has(queueKeyOf(vhost, queue))) {
          droppedSamples++;
          return;
        }
        parts = { metric: def.id, vhost, queue };
        key = `${def.id}${SEP}${vhost}${SEP}${queue}`;
      } else if (def.scope === 'node') {
        parts = { metric: def.id, node };
        key = `${def.id}${SEP}${node}`;
      } else {
        parts = { metric: def.id };
        key = def.id;
      }
      if (candidates >= limits.maxRoundCandidates) {
        droppedSamples++;
        return;
      }
      candidates++;
      const entry = pending.get(key) ?? { parts, candidates: [] };
      entry.candidates.push({ node, value: sample.value });
      pending.set(key, entry);
    },

    commit(store, cid, at, meta) {
      let stored = 0;
      let refused = 0;
      for (const entry of pending.values()) {
        const { parts } = entry;
        const leader =
          parts.vhost !== undefined && parts.queue !== undefined
            ? leaders.get(queueKeyOf(parts.vhost, parts.queue))
            : undefined;
        const sorted = [...entry.candidates].sort((a, b) =>
          a.node < b.node ? -1 : a.node > b.node ? 1 : 0,
        );
        const chosen = sorted.find((c) => c.node === leader) ?? sorted[0];
        if (chosen === undefined) continue;
        if (store.append(cid, parts, meta, { t: at, v: chosen.value })) {
          stored++;
        } else {
          refused++;
        }
      }
      store.endRound(cid);
      pending.clear();
      return { stored, refused, droppedSamples };
    },
  };
}
