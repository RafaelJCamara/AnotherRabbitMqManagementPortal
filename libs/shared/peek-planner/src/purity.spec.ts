import { semanticsRegistry } from '@app/semantics';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { planPeek } from './plan.ts';
import { NOW, SCENARIOS, build, deepFreeze, unattended } from './testing.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AC-5 pure, total and deterministic', () => {
  it('AC-5 does not touch its input, repeats exactly and reads no clock or randomness', () => {
    const clock = vi.spyOn(Date, 'now');
    const random = vi.spyOn(Math, 'random');
    const perf = vi.spyOn(performance, 'now');
    for (const scenario of SCENARIOS) {
      const { request, facts } = build(scenario);
      // A frozen input throws on any write. The registry is shared and not frozen by us.
      const frozen = {
        request: deepFreeze(request),
        facts: {
          ...facts,
          profile: deepFreeze(facts.profile),
          preflight: deepFreeze(facts.preflight),
          principal: deepFreeze({ ...facts.principal }),
        },
      };
      const before = JSON.stringify(frozen);
      const first = planPeek(frozen.request, frozen.facts);
      const second = planPeek(frozen.request, frozen.facts);
      expect(second, scenario.name).toEqual(first);
      expect(JSON.stringify(frozen), scenario.name).toBe(before);
      expect(first, scenario.name).not.toBe(second);
    }
    expect(clock).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
    expect(perf).not.toHaveBeenCalled();
  });

  it('AC-5 uses nowMs for freshness only: it never changes a plan for a person', () => {
    const scenario = SCENARIOS[0];
    if (scenario === undefined) throw new Error('no scenario');
    const now = build(scenario, NOW);
    const later = build(scenario, NOW + 3_600_000);
    expect(planPeek(later.request, later.facts)).toEqual(
      planPeek(now.request, now.facts),
    );
    // A non-human run is held to the age of its rescue check.
    const run = { ...scenario, principal: unattended };
    const fresh = build(run, NOW);
    const stale = build(run, NOW + 3_600_000);
    expect(planPeek(fresh.request, fresh.facts)).toMatchObject({
      preview: { disposition: { kind: 'quarantine' } },
    });
    expect(planPeek(stale.request, stale.facts)).toMatchObject({
      rejected: true,
      code: 'NO_SAFE_DISPOSITION',
    });
  });

  it('AC-5 returns data that shares nothing with the input or the registry', () => {
    const scenario = SCENARIOS[0];
    if (scenario === undefined) throw new Error('no scenario');
    const { request, facts } = build(scenario);
    const result = planPeek(request, facts);
    if ('rejected' in result) throw new Error(result.code);
    const cell = semanticsRegistry.cell({
      era: '4.0-4.2',
      queueType: 'quorum',
      protocol: 'amqp091',
      action: 'amqp091.nack_requeue',
      limit: 'finite',
    });
    expect(result.preview.expected[0]?.effect).toEqual(cell.effect);
    expect(result.preview.expected[0]?.effect).not.toBe(cell.effect);
    expect(result.preview.limit.reasons).not.toBe(
      facts.preflight.queue.visibleLimits,
    );
  });
});
