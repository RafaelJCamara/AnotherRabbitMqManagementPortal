import { describe, expect, it } from 'vitest';

import { openPlan } from './fake-api';
import { needsReview, planNeeds } from './plan-needs';

const gate = (blocking: boolean, reason = 'no') => ({
  id: 'g1',
  blocking,
  reason,
});
const warning = {
  id: 'W-1' as const,
  severity: 'warn' as const,
  textKey: 'warn.x',
  textVersion: 1,
};
const grant = (decision: 'approve' | 'reject') => ({
  by: 'someone',
  at: 1,
  decision,
});

describe('what a plan asks', () => {
  it('asks nothing of a plan that has no gate, consent, phrase, approval or warning', () => {
    const plan = openPlan();
    expect(planNeeds(plan)).toEqual({
      blocking: [],
      consents: [],
      phrase: null,
      approvalsMissing: 0,
      warnings: [],
    });
    expect(needsReview(plan)).toBe(false);
  });

  it('keeps only the gates that block', () => {
    const plan = openPlan({ gates: [gate(false), gate(true, 'locked')] });
    expect(planNeeds(plan).blocking).toEqual([gate(true, 'locked')]);
    expect(needsReview(plan)).toBe(true);
    expect(needsReview(openPlan({ gates: [gate(false)] }))).toBe(false);
  });

  it('reads consents, the phrase (an empty one is none) and warnings as sent', () => {
    expect(
      planNeeds(openPlan({ consentsRequired: ['c.one', 'c.two'] })).consents,
    ).toEqual(['c.one', 'c.two']);
    expect(needsReview(openPlan({ consentsRequired: ['c.one'] }))).toBe(true);
    expect(planNeeds(openPlan({ confirmationPhrase: 'publish' })).phrase).toBe(
      'publish',
    );
    expect(needsReview(openPlan({ confirmationPhrase: 'publish' }))).toBe(true);
    expect(planNeeds(openPlan({ confirmationPhrase: '' })).phrase).toBeNull();
    expect(needsReview(openPlan({ confirmationPhrase: '' }))).toBe(false);
    expect(planNeeds(openPlan({ warnings: [warning] })).warnings).toEqual([
      warning,
    ]);
    expect(needsReview(openPlan({ warnings: [warning] }))).toBe(true);
  });

  it('counts the approvals still missing: a rejection is not an approval, and a surplus is none missing', () => {
    const missing = (required: number, granted: ('approve' | 'reject')[]) =>
      planNeeds(
        openPlan({ approvals: { required, granted: granted.map(grant) } }),
      ).approvalsMissing;
    expect(missing(2, [])).toBe(2);
    expect(missing(2, ['approve'])).toBe(1);
    expect(missing(2, ['approve', 'reject'])).toBe(1);
    expect(missing(1, ['approve', 'approve'])).toBe(0);
    expect(missing(0, [])).toBe(0);
    expect(
      needsReview(openPlan({ approvals: { required: 1, granted: [] } })),
    ).toBe(true);
    expect(
      needsReview(
        openPlan({ approvals: { required: 1, granted: [grant('approve')] } }),
      ),
    ).toBe(false);
  });
});
