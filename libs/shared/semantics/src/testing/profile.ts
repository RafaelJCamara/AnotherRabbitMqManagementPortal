// Test helpers shared by the data specs: a parsed version and the slice of a BrokerProfile the
// registry reads. Not part of the public API.
import {
  parseSemVer,
  type BrokerProfile,
  type SemVer,
} from '@app/domain-model';

export const v = (text: string): SemVer => {
  const parsed = parseSemVer(text);
  if (parsed === null) throw new Error(`test setup: ${text} does not parse`);
  return parsed;
};

export type TestProfile = Pick<
  BrokerProfile,
  'versions' | 'stats' | 'featureFlags' | 'product'
>;

export interface ProfileOptions {
  readonly statsOff?: boolean;
  readonly flags?: BrokerProfile['featureFlags'];
  readonly product?: BrokerProfile['product'];
}

/**
 * A profile whose nodes run the given versions; a null entry is a node whose version could not
 * be read. Statistics are on unless `statsOff`.
 */
export function profile(
  nodes: readonly (string | null)[] | string,
  options: ProfileOptions = {},
): TestProfile {
  const list = typeof nodes === 'string' ? [nodes] : nodes;
  const perNode: Record<string, SemVer | null> = {};
  list.forEach((text, index) => {
    perNode[`rabbit@n${String(index)}`] = text === null ? null : v(text);
  });
  const known = Object.values(perNode).filter(
    (version): version is SemVer => version !== null,
  );
  return {
    product: options.product ?? 'rabbitmq',
    stats: { disabled: options.statsOff === true, queueTotals: true },
    featureFlags: options.flags ?? {},
    versions: {
      min: known.length === list.length ? (known[0] ?? null) : null,
      perNode,
      mixed: new Set(list).size > 1,
      build: 'oss',
    },
  };
}
