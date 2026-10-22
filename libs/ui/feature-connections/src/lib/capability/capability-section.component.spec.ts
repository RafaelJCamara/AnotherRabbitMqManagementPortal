import { describe, expect, it } from 'vitest';

import { byText, definitions, squash } from '../testing/dom';
import {
  brokerProfileBody,
  FakeConnections,
  problemOf,
} from '../testing/fake-connections';
import {
  eventually,
  mountRouted,
  PAGE_TEST_TIMEOUT_MS,
  type RoutedBed,
} from '../testing/routed-bed';

const section = (bed: RoutedBed): HTMLElement => {
  const el = bed.el.querySelector<HTMLElement>('app-capability-section');
  if (!el) throw new Error('no capability section');
  return el;
};

/** The rows of the gate table as `name | state | why`. */
const gateRows = (bed: RoutedBed): string[] =>
  [...section(bed).querySelectorAll('table.gates tbody tr')].map((row) =>
    [...row.children]
      .map((cell) => squash(cell.textContent))
      .join(' | ')
      .trim(),
  );

async function opened(fake: FakeConnections): Promise<RoutedBed> {
  const bed = await mountRouted('/connections/c1', { fake });
  await eventually(
    bed,
    () =>
      bed.el.querySelector('app-capability-section') !== null &&
      !squash(section(bed).textContent).includes('Reading the capabilities.'),
    'the capabilities',
  );
  return bed;
}

describe('the capability section', () => {
  it(
    'AC-6 shows each gate of the cached profile as the engine sent it: open, closed with the reason and an https source link, and the broker facts',
    async () => {
      const bed = await opened(new FakeConnections().seed('c1'));
      expect(gateRows(bed)).toEqual([
        'Side-effect-aware peek | Available |',
        'Publish | Not available | The user has no write permission. Source: www.rabbitmq.com',
      ]);
      const link = section(bed).querySelector<HTMLAnchorElement>('a.source');
      expect(link?.getAttribute('href')).toBe(
        'https://www.rabbitmq.com/docs/access-control',
      );
      expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
      expect(link?.getAttribute('target')).toBe('_blank');
      const facts = definitions(section(bed));
      expect(facts.Product).toBe('rabbitmq');
      expect(facts.Version).toBe('4.3.6');
      expect(facts.Era).toBe('4.3');
      expect(facts.Statistics).toBe('Full');
      // A verified build needs no banner.
      expect(section(bed).querySelector('.banner')).toBeNull();
      // Nothing the page showed is a claim the engine did not make.
      expect(squash(section(bed).textContent)).not.toMatch(
        /non-destructive|read-only|safe peek/i,
      );
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-6 a gate that is degraded, malformed or from an unsafe source reads as the fail-closed rules say',
    async () => {
      const fake = new FakeConnections().seed('c1');
      fake.profile = (cid) =>
        brokerProfileBody(cid, {
          gates: {
            'amqp.peek': {
              enabled: true,
              mode: 'degraded',
              reason: 'Statistics are off.',
            },
            'amqp.tap': 'yes',
            'amqp.publish': { enabled: 'true' },
            'amqp.replay': {
              enabled: false,
              reason: 'No.',
              source: 'http://insecure.example/x',
            },
            'streams.browse': { enabled: false, source: 'javascript:alert(1)' },
            'future.thing': { enabled: true },
          },
        });
      const bed = await opened(fake);
      // In the order of the ids, as the engine's record has them.
      expect(gateRows(bed)).toEqual([
        'Side-effect-aware peek | Available with limits | Statistics are off.',
        'Publish | Not available | The engine gave no reason.',
        'Replay | Not available | No. Source: http://insecure.example/x',
        'Live tap | Not available | The engine gave no reason.',
        'future.thing | Available |',
        'Stream browsing | Not available | The engine gave no reason. Source: javascript:alert(1)',
      ]);
      // Only an absolute https source is a link.
      expect(section(bed).querySelectorAll('a.source')).toHaveLength(0);
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-6 a connection that was never probed says so and shows no feature as available',
    async () => {
      const fake = new FakeConnections().seed('c1');
      fake.profile = null;
      const bed = await opened(fake);
      expect(squash(section(bed).textContent)).toContain(
        'This connection has not been probed yet.',
      );
      expect(section(bed).querySelector('table')).toBeNull();
      expect(squash(section(bed).textContent)).not.toContain('Available');
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-6 a failed read says the capabilities are not known, with the Problem as sent, and never available',
    async () => {
      const fake = new FakeConnections().seed('c1');
      fake.failure.profile = problemOf(503, 'BROKER_UNREACHABLE', {
        title: 'The broker did not answer',
        detail: 'Connection refused.',
      });
      const bed = await opened(fake);
      const text = squash(section(bed).textContent);
      expect(text).toContain('The capabilities are not known.');
      expect(text).toContain('The broker did not answer');
      expect(text).toContain('Connection refused.');
      expect(text).toContain('BROKER_UNREACHABLE');
      expect(section(bed).querySelector('table')).toBeNull();
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-6 a profile this build cannot read says so, shows the strongest banner, and still lists the gates it was sent; a profile with no gates is not "all open"',
    async () => {
      const fake = new FakeConnections().seed('c1');
      fake.profile = () => ({ gates: { 'amqp.peek': { enabled: true } } });
      const bed = await opened(fake);
      expect(squash(section(bed).textContent)).toContain(
        'could not be read by this version of the app',
      );
      expect(
        section(bed).querySelector(
          '.banner[data-verification="unknown-build"]',
        ),
      ).not.toBeNull();
      expect(gateRows(bed)).toEqual(['Side-effect-aware peek | Available |']);

      const none = new FakeConnections().seed('c1');
      none.profile = (cid) => brokerProfileBody(cid, { gates: {} });
      const second = await opened(none);
      expect(squash(section(second).textContent)).toContain(
        'The engine listed no features',
      );
      expect(section(second).querySelector('table.gates')).toBeNull();
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-6 an unverified build shows its banner with the version',
    async () => {
      const fake = new FakeConnections().seed('c1');
      fake.profile = (cid) =>
        brokerProfileBody(cid, {
          verification: 'unverified-minor',
          gates: { 'amqp.peek': { enabled: true } },
        });
      const bed = await opened(fake);
      const banner = section(bed).querySelector(
        '.banner[data-verification="unverified-minor"]',
      );
      expect(squash(banner?.textContent)).toContain(
        "No version of this broker's minor release has been through a conformance run.",
      );
      expect(squash(banner?.textContent)).toContain('4.3.6');
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-6 Check capabilities probes once, shows the twelve steps with the engine detail, replaces the card, and cannot be started twice',
    async () => {
      const fake = new FakeConnections().seed('c1');
      fake.profile = null;
      const bed = await opened(fake);
      expect(squash(section(bed).textContent)).toContain('not been probed yet');
      fake.profile = (cid) =>
        brokerProfileBody(cid, { gates: { 'amqp.peek': { enabled: true } } });
      const press = byText(section(bed), 'button', 'Check capabilities');
      press.click();
      press.click();
      await eventually(
        bed,
        () => section(bed).querySelector('table.steps') !== null,
        'the steps',
      );
      expect(
        bed.fake.requestLines.filter((l) => l === 'POST /connections/c1/probe'),
      ).toHaveLength(1);
      const steps = [
        ...section(bed).querySelectorAll('table.steps tbody tr'),
      ].map((row) =>
        [...row.children]
          .map((cell) => squash(cell.textContent))
          .join(' | ')
          .trim(),
      );
      expect(steps).toHaveLength(12);
      expect(steps[0]).toBe('TLS | Answered |');
      expect(steps).toContain('Prometheus | Not available | not enabled');
      expect(gateRows(bed)).toEqual(['Side-effect-aware peek | Available |']);
      expect(squash(section(bed).textContent)).not.toContain(
        'not been probed yet',
      );
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-6 a refused probe is shown as sent and the card that was there stays',
    async () => {
      const fake = new FakeConnections().seed('c1');
      const bed = await opened(fake);
      const before = gateRows(bed);
      fake.failure.probe = problemOf(401, 'UNAUTHENTICATED', {
        title: 'The broker refused the login',
        detail: 'Check the stored secret.',
      });
      byText(section(bed), 'button', 'Check capabilities').click();
      await eventually(
        bed,
        () => section(bed).querySelector('[role="alert"]') !== null,
        'the refusal',
      );
      expect(
        squash(section(bed).querySelector('[role="alert"]')?.textContent),
      ).toContain('The broker refused the login');
      expect(gateRows(bed)).toEqual(before);
      expect(section(bed).querySelector('table.steps')).toBeNull();
    },
    PAGE_TEST_TIMEOUT_MS,
  );
});
