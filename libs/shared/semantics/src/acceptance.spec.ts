// The acceptance criteria of M0-13 (issue #12), asked of the registry this release ships.
import { describe, expect, it } from 'vitest';
import { semanticsRegistry } from './index.ts';
import { profile, v } from './testing/profile.ts';

describe('M0-13 acceptance', () => {
  it('AC-1 4.3.5 with stats off reports channels-400-stats-off and forbids disable_stats on /api/channels; 4.3.6 does neither', () => {
    const old = profile('4.3.5', { statsOff: true });
    const fixed = profile('4.3.6', { statsOff: true });

    expect(semanticsRegistry.hazards(old)).toContain('channels-400-stats-off');
    expect(
      semanticsRegistry.capability('channelsAcceptDisableStats', old),
    ).toBe(false);
    expect(semanticsRegistry.hazards(fixed)).not.toContain(
      'channels-400-stats-off',
    );
    expect(
      semanticsRegistry.capability('channelsAcceptDisableStats', fixed),
    ).toBe(true);
  });

  it('AC-2 tapRule(x-consistent-hash, 4.3.4) diverts without e2e, and peekCaps(4.0-4.2, quorum, admin, verified) is 20 default and 200 maximum', () => {
    expect(
      semanticsRegistry.tapRule('x-consistent-hash', v('4.3.4')),
    ).toMatchObject({ diverts: true, e2eAllowed: false });

    const caps = semanticsRegistry.peekCaps(
      '4.0-4.2',
      'quorum',
      'admin',
      'verified',
    );
    expect(caps.def).toBe(20);
    expect(caps.max).toBe(200);
  });
});
