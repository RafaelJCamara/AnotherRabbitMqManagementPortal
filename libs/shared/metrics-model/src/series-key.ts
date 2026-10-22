// A stable key for a series reference, so a live item, a history answer and a chart line meet on the same string.
import type { SeriesRef } from './ports';

/** `metric`, then the node, then the queue (vhost and name), separated by characters a name cannot hold. */
export function refKey(ref: SeriesRef): string {
  return [
    ref.metric,
    ref.node ?? '',
    ref.queue === undefined ? '' : `${ref.queue.vhost}\u0000${ref.queue.name}`,
  ].join('\u0001');
}
