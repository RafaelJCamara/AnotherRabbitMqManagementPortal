import { describe, expect, it } from 'vitest';

import { byText, definitions, exists, press, squash } from '../testing/dom';
import { FakeConnections, problemOf } from '../testing/fake-connections';
import { profileFixture } from '../testing/fixtures';
import {
  eventually,
  mountRouted,
  PAGE_TEST_TIMEOUT_MS,
  type RoutedBed,
} from '../testing/routed-bed';

const PROD_REASON =
  'This is a production connection and it is locked. Unlock it to make changes for 15 minutes.';

function prodFake(): FakeConnections {
  const fake = new FakeConnections();
  fake.profiles = [
    profileFixture('p1', { name: 'Orders prod', envClass: 'prod' }),
  ];
  return fake;
}

const deleteGate = (bed: RoutedBed): HTMLElement => {
  const gates = [...bed.el.querySelectorAll<HTMLElement>('app-gated')];
  const gate = gates.find((g) => squash(g.textContent).includes('Delete'));
  if (!gate) throw new Error('no delete control');
  return gate;
};

const lines = (bed: RoutedBed, verb: string): string[] =>
  bed.fake.requestLines.filter((line) => line.startsWith(verb));

const dialog = (bed: RoutedBed): HTMLElement | null =>
  bed.el.querySelector<HTMLElement>('[role="dialog"]');

const dialogEl = (bed: RoutedBed): HTMLElement => {
  const found = dialog(bed);
  if (!found) throw new Error('no dialog is open');
  return found;
};

async function ready(bed: RoutedBed, name: string): Promise<void> {
  await eventually(
    bed,
    () => bed.el.querySelector('h1')?.textContent.includes(name) === true,
    `the page of ${name}`,
  );
}

describe('a connection page', () => {
  it(
    'AC-1 a production connection that is not unlocked has a closed Delete with the reason and the source prod-lock, and pressing it does nothing',
    async () => {
      const bed = await mountRouted('/connections/p1', { fake: prodFake() });
      await ready(bed, 'Orders prod');
      const gate = deleteGate(bed);
      const control = gate.querySelector<HTMLButtonElement>('button');
      expect(control?.getAttribute('aria-disabled')).toBe('true');
      expect(squash(gate.textContent)).toContain(PROD_REASON);
      expect(squash(gate.textContent)).toContain('prod-lock');
      control?.click();
      bed.harness.detectChanges();
      expect(dialog(bed)).toBeNull();
      expect(lines(bed, 'DELETE')).toEqual([]);
      // The environment chrome says production and the lock line says locked.
      expect(
        bed.el.querySelector('app-env-chrome')?.getAttribute('data-env'),
      ).toBe('prod');
      expect(
        squash(bed.el.querySelector('[data-lock]')?.textContent),
      ).toContain('Locked');
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-1 Cancel and Escape in the unlock dialog call nothing; Unlock calls ops.arm once for that connection, opens Delete and then the window closes it again',
    async () => {
      const bed = await mountRouted('/connections/p1', { fake: prodFake() });
      await ready(bed, 'Orders prod');
      byText(bed.el, '.lock button', 'Unlock').click();
      await eventually(bed, () => dialog(bed) !== null, 'the unlock dialog');
      // It names the connection and its class, and says what it allows and that it is audited.
      const text = squash(dialog(bed)?.textContent);
      expect(text).toContain('Unlock Orders prod?');
      expect(text).toContain('Production connection');
      expect(text).toContain('15 minutes');
      expect(text).toContain('audit log');
      // Cancel focused first; Escape and Cancel both leave without a call.
      expect(document.activeElement?.textContent.trim()).toBe('Cancel');
      expect(press(byText(dialogEl(bed), 'button', 'Cancel'), 'Escape')).toBe(
        true,
      );
      bed.harness.detectChanges();
      expect(dialog(bed)).toBeNull();
      expect(lines(bed, 'POST /connections/p1/arm')).toEqual([]);

      byText(bed.el, '.lock button', 'Unlock').click();
      await eventually(bed, () => dialog(bed) !== null);
      byText(dialogEl(bed), 'button', 'Cancel').click();
      bed.harness.detectChanges();
      expect(lines(bed, 'POST /connections/p1/arm')).toEqual([]);

      byText(bed.el, '.lock button', 'Unlock').click();
      await eventually(bed, () => dialog(bed) !== null);
      byText(dialogEl(bed), 'button', 'Unlock').click();
      await eventually(
        bed,
        () =>
          dialog(bed) === null &&
          bed.el.querySelector('[data-lock="armed"]') !== null,
        'the unlocked page',
      );
      expect(lines(bed, 'POST /connections/p1/arm')).toHaveLength(1);
      expect(
        squash(bed.el.querySelector('[data-lock]')?.textContent),
      ).toContain('Unlocked until');
      // Delete is open now, and focus moved to the counterpart of the button that opened the dialog.
      expect(
        deleteGate(bed).querySelector('button')?.getAttribute('aria-disabled'),
      ).toBeNull();
      await eventually(
        bed,
        () =>
          document.activeElement?.textContent.includes('Lock again') === true,
        'focus on Lock again',
      );
      // At the end of the window the control closes again by itself.
      bed.clock.advance(15 * 60_000);
      await eventually(
        bed,
        () =>
          deleteGate(bed)
            .querySelector('button')
            ?.getAttribute('aria-disabled') === 'true',
        'the lock to return',
      );
      expect(
        squash(bed.el.querySelector('[data-lock]')?.textContent),
      ).toContain('Locked');
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-1 a refused unlock stays in the dialog as sent and arms nothing; Lock again calls ops.disarm',
    async () => {
      const fake = prodFake();
      fake.failure.arm = problemOf(403, 'FORBIDDEN_RBAC', {
        title: 'Forbidden',
        detail: 'Only a person at the UI or the CLI can arm a connection.',
      });
      const bed = await mountRouted('/connections/p1', { fake });
      await ready(bed, 'Orders prod');
      byText(bed.el, '.lock button', 'Unlock').click();
      await eventually(bed, () => dialog(bed) !== null);
      byText(dialogEl(bed), 'button', 'Unlock').click();
      await eventually(
        bed,
        () => dialog(bed)?.querySelector('[role="alert"]') != null,
        'the refusal',
      );
      expect(squash(dialog(bed)?.textContent)).toContain(
        'Only a person at the UI or the CLI can arm a connection.',
      );
      expect(squash(dialog(bed)?.textContent)).toContain('FORBIDDEN_RBAC');
      expect(bed.el.querySelector('[data-lock="armed"]')).toBeNull();
      // Now let it through, and lock again.
      fake.failure = {};
      byText(dialogEl(bed), 'button', 'Unlock').click();
      await eventually(
        bed,
        () => bed.el.querySelector('[data-lock="armed"]') !== null,
      );
      byText(bed.el, '.lock button', 'Lock again').click();
      await eventually(
        bed,
        () => bed.el.querySelector('[data-lock="locked"]') !== null,
        'the lock back',
      );
      expect(lines(bed, 'POST /connections/p1/disarm')).toHaveLength(1);
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-8 for a development connection the gate is open, and the engine locking it is shown as sent with the unlock offered, then the delete goes through',
    async () => {
      const fake = new FakeConnections().seed('c1', 'c2');
      const bed = await mountRouted('/connections/c1', { fake });
      await ready(bed, 'Broker c1');
      expect(
        deleteGate(bed).querySelector('button')?.getAttribute('aria-disabled'),
      ).toBeNull();
      deleteGate(bed).querySelector('button')?.click();
      await eventually(bed, () => dialog(bed) !== null, 'the delete dialog');
      const text = squash(dialog(bed)?.textContent);
      expect(text).toContain('Delete Broker c1?');
      expect(text).toContain('cannot be recovered');
      expect(document.activeElement?.textContent.trim()).toBe('Cancel');

      byText(dialogEl(bed), 'button', 'Delete').click();
      await eventually(
        bed,
        () => dialog(bed)?.querySelector('[role="alert"]') != null,
        'the engine refusal',
      );
      // The Problem as the engine sent it: title, detail, the gate's reason and source, and the code.
      const alert = squash(
        dialog(bed)?.querySelector('[role="alert"]')?.textContent,
      );
      expect(alert).toContain('The call is blocked');
      expect(alert).toContain('The production lock is on.');
      expect(alert).toContain(
        'This is a production connection and it is locked. Arm it to make changes for 15 minutes.',
      );
      expect(alert).toContain('prod-lock');
      expect(alert).toContain('GATE_BLOCKED');
      expect(lines(bed, 'DELETE')).toHaveLength(1);

      // The engine named ops.arm for this connection, so the dialog offers it.
      byText(dialogEl(bed), 'button', 'Unlock this connection').click();
      await eventually(
        bed,
        () => squash(dialog(bed)?.textContent).includes('Unlock Broker c1?'),
        'the unlock dialog',
      );
      byText(dialogEl(bed), 'button', 'Unlock').click();
      await eventually(
        bed,
        () => dialog(bed) === null && fake.armed.has('c1'),
        'the unlock',
      );

      // The person asks again; this time the engine allows it. The list opens and the row is gone.
      deleteGate(bed).querySelector('button')?.click();
      await eventually(bed, () => dialog(bed) !== null);
      byText(dialogEl(bed), 'button', 'Delete').click();
      await eventually(
        bed,
        () => bed.router.url === '/connections',
        'the list',
      );
      expect(lines(bed, 'DELETE')).toEqual([
        'DELETE /connections/c1',
        'DELETE /connections/c1',
      ]);
      await eventually(
        bed,
        () =>
          bed.el.querySelector('table') !== null &&
          !exists(bed.el, 'tbody a', 'Broker c1'),
        'the list without it',
      );
      expect(exists(bed.el, 'tbody a', 'Broker c2')).toBe(true);
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-8 a Problem that is not the lock is shown as sent and offers no unlock',
    async () => {
      const fake = new FakeConnections().seed('c1');
      fake.failure.delete = problemOf(409, 'BROKER_PRECONDITION_FAILED', {
        title: 'The connection is in use',
        detail: 'A job is using it.',
      });
      const bed = await mountRouted('/connections/c1', { fake });
      await ready(bed, 'Broker c1');
      deleteGate(bed).querySelector('button')?.click();
      await eventually(bed, () => dialog(bed) !== null);
      byText(dialogEl(bed), 'button', 'Delete').click();
      await eventually(
        bed,
        () => dialog(bed)?.querySelector('[role="alert"]') != null,
      );
      const text = squash(dialog(bed)?.textContent);
      expect(text).toContain('The connection is in use');
      expect(text).toContain('A job is using it.');
      expect(text).not.toContain('Unlock this connection');
      // The dialog stays; nothing was removed from the page's state.
      expect(bed.router.url).toBe('/connections/c1');
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-1 a connection the person does not own has a closed Delete with the engine-sent reason of ownership, whatever the lock says',
    async () => {
      const fake = new FakeConnections();
      fake.profiles = [
        profileFixture('t1', { name: 'Team broker', canEdit: false }),
      ];
      const bed = await mountRouted('/connections/t1', { fake });
      await ready(bed, 'Team broker');
      const gate = deleteGate(bed);
      expect(gate.querySelector('button')?.getAttribute('aria-disabled')).toBe(
        'true',
      );
      expect(squash(gate.textContent)).toContain(
        'Only the person who owns this connection can change or delete it.',
      );
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-4 the page shows each secret as set or not set with its date and never a value',
    async () => {
      const fake = new FakeConnections();
      fake.profiles = [
        profileFixture('s1', { name: 'Secrets' }),
        profileFixture('s2', { name: 'Bare', secretsSet: false }),
      ];
      const set = await mountRouted('/connections/s1', { fake });
      await ready(set, 'Secrets');
      const shown = definitions(set.el);
      expect(shown['Management secret']).toMatch(/^set \(/);
      expect(shown['AMQP secret']).toMatch(/^set \(/);
      expect(shown['Management API']).toBe('http://127.0.0.1:15672');
      expect(shown['AMQP address']).toBe(
        '127.0.0.1:5672, virtual host /, TLS off',
      );
      expect(shown['Management login']).toBe('user name and password, guest');
      const bare = await mountRouted('/connections/s2', { fake });
      await ready(bare, 'Bare');
      const none = definitions(bare.el);
      expect(none['Management secret']).toBe('not set');
      expect(none['AMQP secret']).toBe('not set');
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-8 an unknown connection says so with the engine problem, and an address that is no id says the same without a request',
    async () => {
      const missing = await mountRouted('/connections/nope', {
        fake: new FakeConnections().seed('c1'),
      });
      await eventually(
        missing,
        () =>
          exists(missing.el, 'p', 'There is no connection with this address.'),
        'the not-found text',
      );
      expect(squash(missing.el.textContent)).toContain('No such connection');
      expect(squash(missing.el.textContent)).toContain('NOT_FOUND');
    },
    PAGE_TEST_TIMEOUT_MS,
  );
});
