// M0-52 AC-12, the UI half: every request the connections pages make, over every flow they have, is one of the
// calls of this feature, with the method and the path of its contract, and no secret is in any path or query. The
// answers are parsed against the contract (the testbed runs the real `EngineApi` with parsing on, so a call whose
// answer did not fit would have failed the flow). The other half, the same calls through the real router over the
// real actions, is `libs/testkit/src/connections-ui/connections-calls.spec.ts`.
import { describe, expect, it } from 'vitest';

import { byText, type } from './testing/dom';
import { FakeConnections } from './testing/fake-connections';
import { CANARY, profileFixture } from './testing/fixtures';
import {
  eventually,
  mountRouted,
  PAGE_TEST_TIMEOUT_MS,
  type RoutedBed,
} from './testing/routed-bed';

/** What the feature may call, by the HTTP binding of its contracts. */
const ALLOWED: readonly RegExp[] = [
  /^GET \/connections$/, // connections.list
  /^GET \/connections\/[^/]+$/, // connections.get
  /^POST \/connections$/, // connections.create
  /^PATCH \/connections\/[^/]+$/, // connections.update
  /^DELETE \/connections\/[^/]+$/, // connections.delete
  /^POST \/connections\/test-http$/, // connections.test-http
  /^POST \/connections\/test-amqp$/, // connections.test-amqp
  /^GET \/connections\/[^/]+\/profile$/, // profile.get
  /^POST \/connections\/[^/]+\/probe$/, // probe.run
  /^POST \/connections\/[^/]+\/arm$/, // ops.arm
  /^POST \/connections\/[^/]+\/disarm$/, // ops.disarm
];

const dialogEl = (bed: RoutedBed): HTMLElement => {
  const found = bed.el.querySelector<HTMLElement>('[role="dialog"]');
  if (!found) throw new Error('no dialog');
  return found;
};

describe('the requests of the connections pages', () => {
  it(
    'AC-12 every request of every flow is a call of this feature, and no secret is in a path or a query',
    async () => {
      const fake = new FakeConnections();
      fake.profiles = [profileFixture('p1', { envClass: 'prod' })];
      // Create, with the draft tests.
      let bed = await mountRouted('/connections/new', { fake });
      await eventually(bed, () => bed.el.querySelector('#f-name') !== null);
      const set = (id: string, value: string): void => {
        const el = bed.el.querySelector<HTMLInputElement>(`#${id}`);
        if (!el) throw new Error(id);
        type(el, value);
      };
      set('f-name', 'Lab');
      set('f-http-host', '127.0.0.1');
      set('f-http-username', 'guest');
      set('f-http-secret', CANARY);
      set('f-uri', `amqp://u:${CANARY}@h/`);
      await eventually(
        bed,
        () =>
          bed.el.querySelector('app-test-panel button[aria-disabled]') === null,
      );
      for (const button of bed.el.querySelectorAll<HTMLButtonElement>(
        'app-test-panel .one button',
      ))
        button.click();
      await eventually(
        bed,
        () => bed.el.querySelectorAll('app-test-panel .ok').length === 2,
      );
      byText(bed.el, 'button[type="submit"]', 'Add the connection').click();
      await eventually(
        bed,
        () => bed.router.url.startsWith('/connections/c'),
        'the new connection',
      );
      // The page of a production connection: probe, tests, unlock, lock again.
      bed = await mountRouted('/connections/p1', { fake });
      await eventually(bed, () => bed.el.querySelector('app-gated') !== null);
      byText(
        bed.el,
        'app-capability-section button',
        'Check capabilities',
      ).click();
      await eventually(bed, () => bed.el.querySelector('table.steps') !== null);
      for (const button of bed.el.querySelectorAll<HTMLButtonElement>(
        'app-test-panel .one button',
      ))
        button.click();
      await eventually(
        bed,
        () => bed.el.querySelectorAll('app-test-panel .ok').length === 2,
      );
      byText(bed.el, '.lock button', 'Unlock').click();
      await eventually(
        bed,
        () => bed.el.querySelector('[role="dialog"]') !== null,
      );
      byText(dialogEl(bed), 'button', 'Unlock').click();
      await eventually(
        bed,
        () => bed.el.querySelector('[data-lock="armed"]') !== null,
      );
      byText(bed.el, '.lock button', 'Lock again').click();
      await eventually(
        bed,
        () => bed.el.querySelector('[data-lock="locked"]') !== null,
      );
      // Edit and delete of a connection that is armed.
      fake.profiles.push(profileFixture('d1'));
      fake.armed.add('d1');
      bed = await mountRouted('/connections/d1/edit', { fake });
      await eventually(bed, () => bed.el.querySelector('#f-name') !== null);
      bed.el.querySelector<HTMLButtonElement>('app-gated button')?.click();
      await eventually(bed, () => bed.router.url === '/connections/d1');
      bed = await mountRouted('/connections/d1', { fake });
      await eventually(bed, () => bed.el.querySelector('app-gated') !== null);
      bed.el.querySelector<HTMLButtonElement>('app-gated button')?.click();
      await eventually(
        bed,
        () => bed.el.querySelector('[role="dialog"]') !== null,
      );
      byText(dialogEl(bed), 'button', 'Delete').click();
      await eventually(bed, () => bed.router.url === '/connections');

      const lines = fake.requestLines;
      expect(lines.length).toBeGreaterThan(20);
      for (const line of lines) {
        expect(
          ALLOWED.some((pattern) => pattern.test(line)),
          line,
        ).toBe(true);
        expect(line, line).not.toContain(CANARY);
        expect(line, line).not.toContain('?' + 'password');
      }
      // Every call of the contract that the feature owns was made at least once.
      for (const verb of [
        'POST /connections',
        'PATCH /connections/d1',
        'DELETE /connections/d1',
        'POST /connections/test-http',
        'POST /connections/test-amqp',
        'GET /connections/p1/profile',
        'POST /connections/p1/probe',
        'POST /connections/p1/arm',
        'POST /connections/p1/disarm',
      ]) {
        expect(lines, verb).toContain(verb);
      }
      // Nothing it called changes a broker or reads a message: there is no such call in the allow-list, and the
      // secret travelled only in the bodies of the create and the two tests of the draft.
      const withSecret = fake.bodies
        .filter((b) => JSON.stringify(b.body).includes(CANARY))
        .map((b) => b.line)
        .sort();
      expect(withSecret).toEqual([
        'POST /connections',
        'POST /connections/test-amqp',
        'POST /connections/test-http',
      ]);
    },
    PAGE_TEST_TIMEOUT_MS * 3,
  );
});
