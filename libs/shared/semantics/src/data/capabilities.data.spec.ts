import { describe, expect, it } from 'vitest';
import { SemanticsGapError } from '../schema.ts';
import { semanticsRegistry } from '../index.ts';
import { profile } from '../testing/profile.ts';
import { capabilityRules } from './capabilities.data.ts';

const GRID = [
  '3.13.0',
  '3.13.1',
  '3.13.7',
  '4.0.9',
  '4.1.8',
  '4.2.0',
  '4.2.4',
  '4.2.5',
  '4.2.6',
  '4.2.9',
  '4.3.0',
  '4.3.1',
  '4.3.5',
  '4.3.6',
  '4.4.0',
] as const;

const from = (version: string): string[] =>
  GRID.slice(GRID.indexOf(version as never));

interface Expected {
  /** Versions for which the capability holds with statistics on. */
  readonly statsOn: readonly string[];
  /** Versions for which it holds with statistics off. */
  readonly statsOff: readonly string[];
}

const ALWAYS = (versions: readonly string[]): Expected => ({
  statsOn: versions,
  statsOff: versions,
});
/** Holds with statistics on at every version, and from `version` with statistics off. */
const WHEN_STATS_OFF = (version: string): Expected => ({
  statsOn: [...GRID],
  statsOff: from(version),
});

const EXPECTED: Record<string, Expected> = {
  channelsAcceptDisableStats: ALWAYS(from('4.3.6')),
  channelsListWithStatsOff: WHEN_STATS_OFF('4.3.6'),
  policyFieldsWithStatsOff: WHEN_STATS_OFF('4.2.5'),
  connectionStaticInfoWithStatsOff: WHEN_STATS_OFF('4.2.6'),
  enableQueueTotalsOnQueueLists: ALWAYS([...GRID]),
  enableQueueTotalsOnSingleQueue: ALWAYS(from('3.13.1')),
  prometheusQueueFilter: ALWAYS(from('4.3.0')),
  delayedRetryArguments: ALWAYS(from('4.3.0')),
  delayedRetryPolicyKeys: ALWAYS(from('4.3.1')),
  apiAuthEndpoint: ALWAYS(GRID.slice(0, GRID.indexOf('4.2.0'))),
};

describe('capability predicates (DC-32)', () => {
  it('has exactly the capabilities the fixtures below describe, each cited', () => {
    expect(capabilityRules.map((rule) => rule.id).sort()).toEqual(
      Object.keys(EXPECTED).sort(),
    );
    for (const rule of capabilityRules) {
      expect(rule.citations.length, rule.id).toBeGreaterThan(0);
    }
  });

  for (const [id, expected] of Object.entries(EXPECTED)) {
    it(`${id} holds for exactly the expected versions, with statistics on and off`, () => {
      for (const version of GRID) {
        expect(
          semanticsRegistry.capability(id, profile(version)),
          `${id} on ${version}, statistics on`,
        ).toBe(expected.statsOn.includes(version));
        expect(
          semanticsRegistry.capability(
            id,
            profile(version, { statsOff: true }),
          ),
          `${id} on ${version}, statistics off`,
        ).toBe(expected.statsOff.includes(version));
      }
    });
  }

  it('a mixed cluster holds a capability only when its oldest node does', () => {
    const holds = (nodes: string[]): boolean =>
      semanticsRegistry.capability(
        'channelsAcceptDisableStats',
        profile(nodes),
      );

    expect(holds(['4.3.6', '4.3.6'])).toBe(true);
    expect(holds(['4.3.6', '4.3.5'])).toBe(false);
    expect(holds(['4.3.5', '4.3.6'])).toBe(false);
  });

  it('a node whose version cannot be read never earns a capability', () => {
    expect(
      semanticsRegistry.capability(
        'channelsAcceptDisableStats',
        profile(['4.3.6', null]),
      ),
    ).toBe(false);
    expect(
      semanticsRegistry.capability(
        'channelsAcceptDisableStats',
        profile([null]),
      ),
    ).toBe(false);
    // The "< 4.2.0" capability must not be granted on an unreadable version either.
    expect(
      semanticsRegistry.capability('apiAuthEndpoint', profile([null])),
    ).toBe(false);
    // Even a statistics-off rule: with statistics off an unreadable node does not hold it.
    expect(
      semanticsRegistry.capability(
        'channelsListWithStatsOff',
        profile([null], { statsOff: true }),
      ),
    ).toBe(false);
  });

  it('a product the rule does not name never earns a capability', () => {
    for (const product of ['lavinmq', 'apsaramq', 'unknown'] as const) {
      expect(
        semanticsRegistry.capability(
          'channelsAcceptDisableStats',
          profile('4.4.0', { product }),
        ),
        product,
      ).toBe(false);
      expect(
        semanticsRegistry.capability(
          'channelsListWithStatsOff',
          profile('4.3.5', { product }),
        ),
        `${product} with statistics on`,
      ).toBe(false);
    }
    expect(
      semanticsRegistry.capability(
        'channelsAcceptDisableStats',
        profile('4.3.6', { product: 'tanzu-rabbitmq' }),
      ),
    ).toBe(true);
  });

  it('an id nobody described is a gap, never a default answer', () => {
    expect(() =>
      semanticsRegistry.capability(
        'channelsAcceptEverything',
        profile('4.4.0'),
      ),
    ).toThrow(SemanticsGapError);
  });
});
