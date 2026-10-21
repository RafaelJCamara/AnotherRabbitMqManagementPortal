import { describe, expect, it } from 'vitest';

import { mountShell, routed, settleShell, visit } from '../test-fixtures';
import {
  FakeLive,
  StatusBackend,
  brokerProfileBody,
  connectionBody,
} from './status-fixtures';

const text = (host: HTMLElement, selector: string): string | undefined =>
  host.querySelector(selector)?.textContent.trim();

describe('status bar', () => {
  it('AC-11 the status bar shows profile, environment, version, era, stats mode, lock and health', async () => {
    const backend = new StatusBackend();
    backend.connections.set(
      'c1',
      connectionBody('c1', 'Staging cluster', 'staging'),
    );
    backend.profiles.set(
      'c1',
      brokerProfileBody('c1', { stats: { disabled: true, queueTotals: true } }),
    );
    backend.connections.set('c2', connectionBody('c2', 'Old cluster', 'prod'));
    backend.profiles.set(
      'c2',
      brokerProfileBody('c2', {
        version: '4.3.7',
        era: '4.0-4.2',
        conservative: true,
        verification: 'unverified-patch',
        stats: { disabled: true, queueTotals: false },
      }),
    );
    const live = new FakeLive();
    live.state.set('ready');
    const bed = await mountShell(undefined, backend, undefined, [
      live.provider,
    ]);

    await visit(bed, '/c/c1/explorer');
    const host = routed(bed);
    const bar = (selector: string) => text(host, `app-status-bar ${selector}`);
    const env = host.querySelector('app-status-bar app-env-chrome');
    expect(env?.getAttribute('data-env')).toBe('staging');
    expect(env?.textContent.trim()).toBe('[[status.env.staging]]');
    expect(
      bar(
        '.segment:not(.version):not(.era):not(.stats):not(.lock):not(.health) .value',
      ),
    ).toBe('Staging cluster');
    expect(bar('.version .value')).toBe('4.3.6');
    expect(bar('.era .badge')).toBe('4.3');
    expect(host.querySelector('.era .note')).toBeNull();
    expect(bar('.stats .value')).toBe('[[status.stats.totalsOnly]]');
    expect(bar('.lock .value')).toBe('[[status.lock.locked]]');
    expect(bar('.health .value')).toBe('[[status.health.ok]]');
    // A verified build has no banner.
    expect(host.querySelector('app-verification-banner .banner')).toBeNull();

    // Another profile, no reload: the bar follows, the conservative era is marked, the banner shows.
    await visit(bed, '/c/c2/explorer');
    expect(host.querySelector('app-env-chrome')?.getAttribute('data-env')).toBe(
      'prod',
    );
    expect(bar('.version .value')).toBe('4.3.7');
    expect(bar('.era .badge')).toBe('4.0-4.2');
    expect(bar('.era .note')).toBe('[[status.eraConservative]]');
    expect(bar('.stats .value')).toBe('[[status.stats.off]]');
    const banner = host.querySelector('app-verification-banner .banner');
    expect(banner?.getAttribute('data-verification')).toBe('unverified-patch');
    expect(banner?.textContent).toContain(
      '[[status.verification.unverifiedPatch]]',
    );
    expect(banner?.textContent).toContain('4.3.7');

    // The live session drops: the bar says so.
    live.state.set('reconnecting');
    await settleShell(bed);
    expect(bar('.health .value')).toBe('[[status.health.reconnecting]]');
    live.state.set('down');
    await settleShell(bed);
    expect(bar('.health .value')).toBe('[[status.health.down]]');
  });

  it('AC-12 missing or failed profile data never looks safer than the strictest reading', async () => {
    const backend = new StatusBackend();
    backend.profiles.set('c1', null); // answered, with no profile
    // c2: the profile call fails; neither connection answers connections.get (no class known).
    const live = new FakeLive();
    live.state.set('down');
    const bed = await mountShell(undefined, backend, undefined, [
      live.provider,
    ]);
    const strictest = (host: HTMLElement) => {
      const bar = (selector: string) =>
        text(host, `app-status-bar ${selector}`);
      expect(
        host.querySelector('app-env-chrome')?.getAttribute('data-env'),
      ).toBe('prod');
      expect(bar('.version .value')).toBe('[[status.unknown]]');
      expect(bar('.era .value')).toBe('[[status.unknown]]');
      expect(bar('.stats .value')).toBe('[[status.unknown]]');
      expect(bar('.lock .value')).toBe('[[status.lock.locked]]');
      expect(bar('.health .value')).toBe('[[status.health.down]]');
      expect(
        host
          .querySelector('app-verification-banner .banner')
          ?.getAttribute('data-verification'),
      ).toBe('unknown-build');
    };

    // The profile has not been answered yet: a neutral loading state, no banner (OQ-346).
    backend.hold();
    await bed.harness.navigateByUrl('/c/c1/explorer');
    await settleShellLoading(bed);
    const host = routed(bed);
    expect(text(host, 'app-status-bar')).toContain('[[status.loading]]');
    expect(host.querySelector('app-status-bar app-env-chrome')).toBeNull();
    expect(host.querySelector('app-verification-banner .banner')).toBeNull();
    expect(host.querySelector('app-status-bar .version')).toBeNull();

    // Answered with no profile.
    backend.release();
    await settleShell(bed);
    strictest(host);

    // The profile call fails.
    await visit(bed, '/c/c2/explorer');
    strictest(host);
    expect(backend.profileRequests).toEqual(['c1', 'c2']);
  });
});

/** Settles the DOM without waiting for requests the spec is holding back. */
async function settleShellLoading(bed: Awaited<ReturnType<typeof mountShell>>) {
  for (let round = 0; round < 5; round += 1) {
    bed.harness.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
