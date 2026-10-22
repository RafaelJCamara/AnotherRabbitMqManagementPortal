// The tab sets of the entity pages (M1-42, R2, EXP-06). Data only: which tabs an entity has, which are
// built in this version and which feature gate each needs. The page renders the gate the engine sent for
// that feature id (the UI never computes authorisation); a tab that is not built, or whose gate is not
// open, is shown disabled with its reason. No tab of any set reaches a message from this work package.
import type { FeatureId } from '@app/contracts';

import type { ExplorerKind } from './ports';

export const ENTITY_TAB_IDS = [
  'overview',
  'messages',
  'browse',
  'publish',
  'tap',
  'consumers',
  'routing',
  'config',
  'charts',
  'forecast',
  'lint',
] as const;
export type EntityTabId = (typeof ENTITY_TAB_IDS)[number];

export interface EntityTabSpec {
  readonly id: EntityTabId;
  /** Its content exists in this version. Others are listed, disabled, with a reason. */
  readonly built: boolean;
  /** The feature gate (`profile.gates`) the tab needs, or `null` when it needs none. */
  readonly gate: FeatureId | null;
}

const gate = (id: string): FeatureId => id as FeatureId;

const built = (id: EntityTabId): EntityTabSpec => ({
  id,
  built: true,
  gate: null,
});
const later = (
  id: EntityTabId,
  needs: string | null = null,
): EntityTabSpec => ({
  id,
  built: false,
  gate: needs === null ? null : gate(needs),
});

/** EXP-06: Overview, Messages, Publish, Tap, Consumers, Routing, Config, Charts, Forecast, Lint. */
const QUEUE: readonly EntityTabSpec[] = [
  built('overview'),
  later('messages', 'amqp.peek'),
  later('publish', 'amqp.publish'),
  later('tap', 'amqp.tap'),
  built('consumers'),
  built('routing'),
  built('config'),
  later('charts'),
  later('forecast'),
  later('lint'),
];

/** A stream replaces Messages with Browse: it has no get-based read (EXP-06). */
const STREAM: readonly EntityTabSpec[] = [
  built('overview'),
  later('browse', 'streams.browse'),
  built('consumers'),
  built('routing'),
  built('config'),
];

const EXCHANGE: readonly EntityTabSpec[] = [
  built('overview'),
  later('publish', 'amqp.publish'),
  built('routing'),
  built('config'),
];

const OVERVIEW_ONLY: readonly EntityTabSpec[] = [built('overview')];

/**
 * The tabs of an entity. A queue is a stream when its `type` says so; until the row is known
 * (`row` is null) a queue has the queue set, and the page shows no tab strip before it has the row.
 */
export function tabSetFor(
  kind: ExplorerKind,
  row: { readonly type?: string | undefined } | null,
): readonly EntityTabSpec[] {
  switch (kind) {
    case 'queues':
      return row?.type === 'stream' ? STREAM : QUEUE;
    case 'exchanges':
      return EXCHANGE;
    case 'connections':
    case 'bindings':
      return OVERVIEW_ONLY;
  }
}

/** The tab an address names: none is the Overview; a name the set does not have is `null`. */
export function resolveTab(
  set: readonly EntityTabSpec[],
  raw: string | null,
): EntityTabSpec | null {
  if (raw === null) return set.find((tab) => tab.id === 'overview') ?? null;
  return set.find((tab) => tab.id === raw) ?? null;
}
