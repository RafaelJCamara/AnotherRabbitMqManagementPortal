// What topics.metrics-live-topic.spec.ts checks. Edit this file, not the spec, as the topic grows.

/** Params that pass the topic's params schema. */
export const sampleParams = { cid: 'c1', queues: [] };

/** An item that passes the topic's item schema. */
export const sampleItem = {
  key: 'messages',
  ref: { metric: 'messages' },
  t: 1_700_000_000_000,
  v: 12,
};
