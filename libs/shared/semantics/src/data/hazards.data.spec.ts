import { describe, expect, it } from 'vitest';
import { semanticsRegistry } from '../index.ts';
import { profile } from '../testing/profile.ts';
import { hazardRules } from './hazards.data.ts';

// Every version of the grid below is asked about every rule, so an off-by-one at either end of a
// range, a wrong fixed-in version or a dropped rule is caught by exactly one cell of the table.
const GRID = [
  '3.13.0',
  '3.13.7',
  '4.0.9',
  '4.1.3',
  '4.1.4',
  '4.1.8',
  '4.2.4',
  '4.2.5',
  '4.2.6',
  '4.2.7',
  '4.2.8',
  '4.2.9',
  '4.2.10',
  '4.3.0',
  '4.3.1',
  '4.3.2',
  '4.3.3',
  '4.3.4',
  '4.3.5',
  '4.3.6',
  '4.3.7',
  '4.4.0',
] as const;

const range = (from: string, to: string): string[] =>
  GRID.slice(GRID.indexOf(from as never), GRID.indexOf(to as never) + 1);

/** Versions of the grid each rule applies to, with statistics off and no feature flags known. */
const AFFECTED: Record<string, readonly string[]> = {
  'stats-off-policy-fields-missing': range('3.13.0', '4.2.4'),
  'channels-400-stats-off': range('3.13.0', '4.3.5'),
  'passive-declare-needs-configure': ['4.2.6', '4.3.0'],
  'topic-empty-binding-key-leak': ['4.3.0'],
  'topic-empty-binding-key-leak-flag-off': [],
  'chx-e2e-stale-bucket-silent-loss': range('4.3.0', '4.3.5'),
  'shovel-reject-loop': range('4.3.0', '4.3.6'),
  'amqp10-stream-filters-dropped': range('4.3.0', '4.4.0'),
  'consumer-timeout-undefined-assertion': range('4.3.0', '4.3.2'),
  'vhost-put-resets-default-queue-type': range('4.1.4', '4.4.0'),
  'vhost-put-resets-description-tags': [...GRID],
  'cors-unvalidated-request-headers': [
    ...range('3.13.0', '4.2.7'),
    '4.3.0',
    '4.3.1',
  ],
  'oauth-client-secret-leak': [
    ...range('3.13.0', '4.2.8'),
    '4.3.0',
    '4.3.1',
    '4.3.2',
  ],
  'http-log-oauth-client-id': range('3.13.0', '4.3.2'),
  'delivery-limit-tick-drift-ignored': range('4.3.0', '4.4.0'),
};

describe('hazard table (fact sheet section a)', () => {
  it('has exactly the rules the fixtures below describe', () => {
    expect(hazardRules.map((rule) => rule.id).sort()).toEqual(
      Object.keys(AFFECTED).sort(),
    );
  });

  it('every rule is cited and says what to do about it', () => {
    for (const rule of hazardRules) {
      expect(rule.citations.length, rule.id).toBeGreaterThan(0);
      expect(rule.summary.length, rule.id).toBeGreaterThan(20);
    }
  });

  for (const [id, affected] of Object.entries(AFFECTED)) {
    it(`${id} applies to exactly ${affected.length === 0 ? 'no version' : `${affected[0] ?? ''} to ${affected[affected.length - 1] ?? ''}`} of the grid`, () => {
      for (const version of GRID) {
        const reported = semanticsRegistry
          .hazards(profile(version, { statsOff: true }))
          .includes(id);
        expect(reported, `${id} on ${version}`).toBe(
          affected.includes(version),
        );
      }
    });
  }

  it('statistics-dependent rules are reported only while statistics are off', () => {
    const statsOn = (version: string): string[] =>
      semanticsRegistry.hazards(profile(version));

    expect(statsOn('4.3.5')).not.toContain('channels-400-stats-off');
    expect(statsOn('4.2.4')).not.toContain('stats-off-policy-fields-missing');
    expect(
      semanticsRegistry.hazards(profile('4.3.5', { statsOff: true })),
    ).toContain('channels-400-stats-off');
    expect(
      semanticsRegistry.hazards(profile('4.2.4', { statsOff: true })),
    ).toContain('stats-off-policy-fields-missing');
  });

  it('the topic empty-key fix of 4.3.1 is reported only while its feature flag is known to be disabled', () => {
    const flagOff = { topic_binding_projection_v5: 'disabled' } as const;
    const flagOn = { topic_binding_projection_v5: 'enabled' } as const;
    const flagGone = { topic_binding_projection_v5: 'unavailable' } as const;
    const ids = (
      flags: Record<string, 'enabled' | 'disabled' | 'unavailable'>,
    ) => semanticsRegistry.hazards(profile('4.3.1', { flags }));

    expect(ids(flagOff)).toContain('topic-empty-binding-key-leak-flag-off');
    expect(ids(flagOn)).not.toContain('topic-empty-binding-key-leak-flag-off');
    expect(ids(flagGone)).not.toContain(
      'topic-empty-binding-key-leak-flag-off',
    );
    expect(ids({})).not.toContain('topic-empty-binding-key-leak-flag-off');
    // 4.3.0 has the bug whatever the flag says; the flag rule starts at 4.3.1.
    expect(
      semanticsRegistry.hazards(profile('4.3.0', { flags: flagOn })),
    ).toContain('topic-empty-binding-key-leak');
    expect(
      semanticsRegistry.hazards(profile('4.3.0', { flags: flagOff })),
    ).not.toContain('topic-empty-binding-key-leak-flag-off');
  });

  it('a mixed cluster is reported against its oldest node, and a node that cannot be read hides nothing', () => {
    const ids = (nodes: (string | null)[]): string[] =>
      semanticsRegistry.hazards(profile(nodes, { statsOff: true }));

    expect(ids(['4.3.6', '4.3.5'])).toContain('channels-400-stats-off');
    expect(ids(['4.3.5', '4.3.6'])).toContain('channels-400-stats-off');
    expect(ids(['4.3.6', '4.3.7'])).not.toContain('channels-400-stats-off');
    expect(ids(['4.3.6', null])).toContain('channels-400-stats-off');
    expect(ids([null]).sort()).toEqual(
      Object.keys(AFFECTED)
        .filter((id) => id !== 'topic-empty-binding-key-leak-flag-off')
        .sort(),
    );
  });

  it('a product that is not RabbitMQ is not reported against the RabbitMQ table', () => {
    for (const product of ['lavinmq', 'apsaramq'] as const) {
      expect(
        semanticsRegistry.hazards(
          profile('4.3.5', { statsOff: true, product }),
        ),
      ).toEqual([]);
    }
    expect(
      semanticsRegistry.hazards(
        profile('4.3.5', { statsOff: true, product: 'tanzu-rabbitmq' }),
      ),
    ).toContain('channels-400-stats-off');
  });
});
