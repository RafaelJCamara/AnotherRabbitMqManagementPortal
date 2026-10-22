import { afterEach, describe, expect, it, vi } from 'vitest';

import { byText, exists, squash, type } from '../testing/dom';
import { FakeConnections, problemOf } from '../testing/fake-connections';
import { CANARY, profileFixture } from '../testing/fixtures';
import {
  eventually,
  mountRouted,
  PAGE_TEST_TIMEOUT_MS,
  type RoutedBed,
} from '../testing/routed-bed';

const field = (bed: RoutedBed, id: string): HTMLInputElement => {
  const el = bed.el.querySelector<HTMLInputElement>(`#${id}`);
  if (!el) throw new Error(`no field ${id}`);
  return el;
};

const submitButton = (bed: RoutedBed): HTMLButtonElement => {
  const el = bed.el.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!el) throw new Error('no submit button');
  return el;
};

const posts = (
  bed: RoutedBed,
): { line: string; body: Record<string, unknown> }[] =>
  bed.fake.bodies.filter((b) => b.line === 'POST /connections');

/** The open dialog; throws when there is none. */
const dialogEl = (bed: RoutedBed): HTMLElement => {
  const found = bed.el.querySelector<HTMLElement>('[role="dialog"]');
  if (!found) throw new Error('no dialog is open');
  return found;
};

/** Every key and value a storage holds, as text. */
function dump(storage: Storage): string {
  const out: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key !== null) out.push(`=${storage.getItem(key) ?? ''}`);
  }
  return out.join('\n');
}

async function opened(bed: RoutedBed): Promise<void> {
  await eventually(
    bed,
    () => bed.el.querySelector('form') !== null,
    'the form',
  );
}

/** Fills the fields a lab broker needs, with the canary as the secret. */
function fillLab(bed: RoutedBed): void {
  type(field(bed, 'f-name'), 'Lab');
  type(field(bed, 'f-http-host'), '127.0.0.1');
  type(field(bed, 'f-http-port'), '15672');
  type(field(bed, 'f-http-username'), 'guest');
  type(field(bed, 'f-http-secret'), CANARY);
  type(field(bed, 'f-amqp-host'), '127.0.0.1');
  type(field(bed, 'f-amqp-port'), '5672');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the create form', () => {
  it(
    'AC-3 a filled form sends exactly one connections.create with the typed fields and lands on the new connection',
    async () => {
      const bed = await mountRouted('/connections/new', {
        fake: new FakeConnections(),
      });
      await opened(bed);
      fillLab(bed);
      bed.harness.detectChanges();
      submitButton(bed).click();
      await eventually(
        bed,
        () => bed.router.url === '/connections/c1',
        'the new connection',
      );
      expect(posts(bed)).toHaveLength(1);
      expect(posts(bed)[0]?.body).toEqual({
        name: 'Lab',
        envClass: 'dev',
        http: {
          host: '127.0.0.1',
          port: 15672,
          auth: { kind: 'basic', username: 'guest', password: CANARY },
        },
        amqp: {
          host: '127.0.0.1',
          port: 5672,
          auth: { kind: 'plain', username: 'guest', password: CANARY },
        },
      });
      // The directory read the engine's list again, so the list and the switcher show it.
      expect(
        bed.fake.requestLines.filter((l) => l === 'GET /connections').length,
      ).toBeGreaterThan(0);
      await eventually(
        bed,
        () => squash(bed.el.querySelector('h1')?.textContent) === 'Lab',
        'the page of the new connection',
      );
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-15 right after a create the new connection is probed once, so the explorer works on its first use, and the page lands on it only afterwards',
    async () => {
      const fake = new FakeConnections();
      // Hold the probe to see the state between the save and the landing.
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const inner = fake.handler;
      let probeAsked = false;
      fake.handler = async (request) => {
        if (request.url.endsWith('/probe')) {
          probeAsked = true;
          await held;
        }
        return inner(request);
      };
      const bed = await mountRouted('/connections/new', { fake });
      await opened(bed);
      fillLab(bed);
      bed.harness.detectChanges();
      submitButton(bed).click();
      await eventually(
        bed,
        () =>
          probeAsked &&
          exists(bed.el, '.status', 'Checking what the broker offers'),
        'the probe running and said in words',
      );
      // Saved, not yet landed: the page waits for the check.
      expect(bed.router.url).toBe('/connections/new');
      release();
      await eventually(
        bed,
        () => bed.router.url === '/connections/c1',
        'the new connection',
      );
      expect(fake.requestLines.filter((l) => l.endsWith('/probe'))).toEqual([
        'POST /connections/c1/probe',
      ]);
      // The create came first, then the probe, and the probe carries no body (and so no secret).
      const order = fake.requestLines.filter(
        (l) => l === 'POST /connections' || l.endsWith('/probe'),
      );
      expect(order).toEqual([
        'POST /connections',
        'POST /connections/c1/probe',
      ]);
      expect(fake.bodies.filter((b) => b.line.endsWith('/probe'))).toEqual([]);
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-15 a probe that fails does not undo the save: the page lands on the connection, and a refused create is not probed',
    async () => {
      const failing = new FakeConnections();
      failing.failure.probe = problemOf(502, 'BROKER_UNREACHABLE', {
        title: 'Broker unreachable',
      });
      const bed = await mountRouted('/connections/new', { fake: failing });
      await opened(bed);
      fillLab(bed);
      bed.harness.detectChanges();
      submitButton(bed).click();
      await eventually(
        bed,
        () => bed.router.url === '/connections/c1',
        'the new connection although the probe failed',
      );
      expect(failing.requestLines).toContain('POST /connections/c1/probe');
      expect(failing.profiles.map((p) => p.id)).toEqual(['c1']);

      // A create the engine refuses has nothing to probe.
      const refused = new FakeConnections();
      refused.failure.create = problemOf(422, 'VALIDATION_FAILED', {
        title: 'The profile is not valid',
      });
      const other = await mountRouted('/connections/new', { fake: refused });
      await opened(other);
      fillLab(other);
      submitButton(other).click();
      await eventually(
        other,
        () => exists(other.el, '[role="alert"]', 'The profile is not valid'),
        'the problem',
      );
      expect(refused.requestLines.some((l) => l.endsWith('/probe'))).toBe(
        false,
      );
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-3 a production connection can be created with nothing unlocked, because the engine lets a local command through',
    async () => {
      const bed = await mountRouted('/connections/new', {
        fake: new FakeConnections(),
      });
      await opened(bed);
      fillLab(bed);
      bed.el
        .querySelector<HTMLInputElement>('input[name="env"][value="prod"]')
        ?.click();
      bed.harness.detectChanges();
      submitButton(bed).click();
      await eventually(bed, () => posts(bed).length === 1, 'the create');
      expect(posts(bed)[0]?.body.envClass).toBe('prod');
      expect(bed.fake.requestLines.some((l) => l.endsWith('/arm'))).toBe(false);
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-3 an empty form sends nothing, lists what is wrong, marks and describes the fields and puts focus on the first',
    async () => {
      const bed = await mountRouted('/connections/new', {
        fake: new FakeConnections(),
      });
      await opened(bed);
      submitButton(bed).click();
      await eventually(
        bed,
        () => bed.el.querySelector('.summary[role="alert"]') !== null,
        'the summary',
      );
      expect(posts(bed)).toEqual([]);
      const summary = squash(bed.el.querySelector('.summary')?.textContent);
      expect(summary).toContain('Name: This field is needed.');
      expect(summary).toContain('Host: This field is needed.');
      const name = field(bed, 'f-name');
      expect(name.getAttribute('aria-invalid')).toBe('true');
      const describedBy = name.getAttribute('aria-describedby') ?? '';
      expect(squash(bed.el.querySelector(`#${describedBy}`)?.textContent)).toBe(
        'This field is needed.',
      );
      await eventually(
        bed,
        () => document.activeElement === name,
        'focus on the first invalid field',
      );
      // A field that is fine is not marked.
      expect(field(bed, 'f-http-port').getAttribute('aria-invalid')).toBeNull();
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-7 the strip above the form follows the class before anything is saved, and says the name',
    async () => {
      const bed = await mountRouted('/connections/new', {
        fake: new FakeConnections(),
      });
      await opened(bed);
      const chrome = (): Element | null =>
        bed.el.querySelector('app-env-chrome');
      expect(chrome()?.getAttribute('data-env')).toBe('dev');
      type(field(bed, 'f-name'), 'Orders');
      for (const [value, label] of [
        ['staging', 'Staging'],
        ['prod', 'Production'],
        ['local', 'Local'],
      ] as const) {
        bed.el
          .querySelector<HTMLInputElement>(
            `input[name="env"][value="${value}"]`,
          )
          ?.click();
        await eventually(
          bed,
          () => chrome()?.getAttribute('data-env') === value,
          `the ${value} strip`,
        );
        expect(squash(chrome()?.textContent)).toContain(label);
        expect(squash(chrome()?.textContent)).toContain('Orders');
      }
      // All five classes are offered, as radios of one group, and none is hidden behind colour.
      expect(bed.el.querySelectorAll('input[name="env"]')).toHaveLength(5);
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-3 the same login for AMQP hides the AMQP login fields; a separate one is sent as typed',
    async () => {
      const bed = await mountRouted('/connections/new', {
        fake: new FakeConnections(),
      });
      await opened(bed);
      expect(bed.el.querySelector('#f-amqp-username')).toBeNull();
      byText(
        bed.el,
        'label.check',
        'Use the same user name and password for AMQP',
      )
        .querySelector('input')
        ?.click();
      await eventually(
        bed,
        () => bed.el.querySelector('#f-amqp-username') !== null,
        'the AMQP login',
      );
      type(field(bed, 'f-name'), 'Two');
      type(field(bed, 'f-http-host'), 'mq');
      type(field(bed, 'f-http-username'), 'ops');
      type(field(bed, 'f-http-secret'), 'one');
      type(field(bed, 'f-amqp-username'), 'app');
      type(field(bed, 'f-amqp-secret'), 'two');
      submitButton(bed).click();
      await eventually(bed, () => posts(bed).length === 1);
      const body = posts(bed)[0]?.body as { http: unknown; amqp: unknown };
      expect(body.http).toEqual({
        host: 'mq',
        auth: { kind: 'basic', username: 'ops', password: 'one' },
      });
      expect(body.amqp).toEqual({
        auth: { kind: 'plain', username: 'app', password: 'two' },
      });
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-3 a pasted URI goes in the uri field with nothing parsed by the page, and the field is a masked input',
    async () => {
      const bed = await mountRouted('/connections/new', {
        fake: new FakeConnections(),
      });
      await opened(bed);
      const uri = field(bed, 'f-uri');
      expect(uri.type).toBe('password');
      expect(uri.getAttribute('autocomplete')).toBe('new-password');
      type(field(bed, 'f-name'), 'From a URI');
      type(uri, `amqp://guest:${CANARY}@mq.example:5671/orders`);
      submitButton(bed).click();
      await eventually(bed, () => posts(bed).length === 1, 'the create');
      expect(posts(bed)[0]?.body).toEqual({
        name: 'From a URI',
        envClass: 'dev',
        uri: `amqp://guest:${CANARY}@mq.example:5671/orders`,
      });
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-4 a typed secret, a password and a pasted URI are in no URL, text, attribute, storage or console output, before, during and after a failed and a successful save',
    async () => {
      const calls: string[] = [];
      for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
          calls.push(args.map(String).join(' '));
        });
      }
      const fake = new FakeConnections();
      fake.failure.create = problemOf(400, 'VALIDATION_FAILED', {
        title: 'The profile is not valid',
        detail: 'Check http.host.',
      });
      const bed = await mountRouted('/connections/new', { fake });
      await opened(bed);
      fillLab(bed);
      type(field(bed, 'f-uri'), `amqp://u:${CANARY}@h/`);
      const everywhere = (): string =>
        [
          document.body.innerHTML,
          document.body.textContent,
          bed.router.url,
          location.href,
          dump(localStorage),
          dump(sessionStorage),
          calls.join('\n'),
          document.title,
        ].join('\n');
      expect(everywhere()).not.toContain(CANARY);
      // The inputs are masked and hold the value only as their live value, not as an attribute.
      for (const id of ['f-http-secret', 'f-uri']) {
        expect(field(bed, id).type).toBe('password');
        expect(field(bed, id).getAttribute('value')).toBeNull();
        expect(field(bed, id).value).toContain(CANARY);
      }
      submitButton(bed).click();
      await eventually(
        bed,
        () => bed.el.querySelector('[role="alert"]') !== null,
        'the failure',
      );
      expect(squash(bed.el.textContent)).toContain('The profile is not valid');
      expect(everywhere()).not.toContain(CANARY);
      // The failed save keeps what was typed, so a retry needs no retyping.
      expect(field(bed, 'f-http-secret').value).toBe(CANARY);
      fake.failure = {};
      submitButton(bed).click();
      await eventually(
        bed,
        () => bed.router.url.startsWith('/connections/c'),
        'the saved connection',
      );
      expect(everywhere()).not.toContain(CANARY);
      // The secret travelled only in the two bodies of the create.
      expect(bed.fake.requestLines.join('\n')).not.toContain(CANARY);
      expect(
        JSON.stringify(
          bed.fake.bodies.filter((b) => b.line !== 'POST /connections'),
        ),
      ).not.toContain(CANARY);
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-3 an engine refusal of the create is shown as sent and the form stays',
    async () => {
      const fake = new FakeConnections();
      fake.failure.create = problemOf(422, 'VALIDATION_FAILED', {
        title: 'The profile is not valid',
        detail: 'The URI has a user name but no password.',
      });
      const bed = await mountRouted('/connections/new', { fake });
      await opened(bed);
      fillLab(bed);
      submitButton(bed).click();
      await eventually(
        bed,
        () =>
          exists(
            bed.el,
            '[role="alert"]',
            'The URI has a user name but no password.',
          ),
        'the problem',
      );
      expect(bed.router.url).toBe('/connections/new');
      expect(
        squash(bed.el.querySelector('form [role="alert"]')?.textContent),
      ).toContain('VALIDATION_FAILED');
    },
    PAGE_TEST_TIMEOUT_MS,
  );
});

describe('the edit form', () => {
  it(
    'AC-4 shows what is stored with every secret empty and marked as set, and saves without sending a secret',
    async () => {
      const bed = await mountRouted('/connections/c1/edit', {
        fake: new FakeConnections().seed('c1'),
      });
      await eventually(
        bed,
        () => bed.el.querySelector('#f-name') !== null,
        'the edit form',
      );
      expect(field(bed, 'f-name').value).toBe('Broker c1');
      expect(field(bed, 'f-http-host').value).toBe('127.0.0.1');
      expect(field(bed, 'f-http-secret').value).toBe('');
      expect(field(bed, 'f-http-secret').placeholder).toBe(
        'set - leave empty to keep',
      );
      expect(
        squash(bed.el.querySelector('#f-http-secret-hint')?.textContent),
      ).toContain('A secret is stored.');
      // The edit form has no URI field.
      expect(bed.el.querySelector('#f-uri')).toBeNull();
      type(field(bed, 'f-name'), 'Renamed');
      bed.fake.armed.add('c1');
      byText(bed.el, 'app-gated', 'Save changes')
        .querySelector('button')
        ?.click();
      await eventually(
        bed,
        () => bed.router.url === '/connections/c1',
        'the connection page',
      );
      const patch = bed.fake.bodies.find(
        (b) => b.line === 'PATCH /connections/c1',
      );
      expect(patch?.body.name).toBe('Renamed');
      expect(JSON.stringify(patch?.body)).not.toMatch(/password|token/);
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-1 on a production connection Save is closed until the unlock is confirmed; Enter in a field does not get round it',
    async () => {
      const fake = new FakeConnections();
      fake.profiles = [
        profileFixture('p1', { name: 'Orders prod', envClass: 'prod' }),
      ];
      const bed = await mountRouted('/connections/p1/edit', { fake });
      await eventually(bed, () => bed.el.querySelector('#f-name') !== null);
      const save = byText(bed.el, 'app-gated', 'Save changes');
      expect(save.querySelector('button')?.getAttribute('aria-disabled')).toBe(
        'true',
      );
      expect(squash(save.textContent)).toContain('prod-lock');
      save.querySelector('button')?.click();
      bed.el
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { cancelable: true }));
      bed.harness.detectChanges();
      expect(
        bed.fake.requestLines.filter((l) => l.startsWith('PATCH')),
      ).toEqual([]);
      // Unlock, then Save works.
      byText(bed.el, '.lock button', 'Unlock').click();
      await eventually(
        bed,
        () => bed.el.querySelector('[role="dialog"]') !== null,
      );
      byText(dialogEl(bed), 'button', 'Unlock').click();
      await eventually(
        bed,
        () => bed.el.querySelector('[data-lock="armed"]') !== null,
        'the unlock',
      );
      expect(
        byText(bed.el, 'app-gated', 'Save changes')
          .querySelector('button')
          ?.getAttribute('aria-disabled'),
      ).toBeNull();
      byText(bed.el, 'app-gated', 'Save changes')
        .querySelector('button')
        ?.click();
      await eventually(
        bed,
        () => bed.router.url === '/connections/p1',
        'the saved page',
      );
      expect(
        bed.fake.requestLines.filter((l) => l.startsWith('PATCH')),
      ).toHaveLength(1);
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-8 for a development connection the engine locking the update is shown as sent, with the unlock offered; after it the same Save goes through',
    async () => {
      const bed = await mountRouted('/connections/c1/edit', {
        fake: new FakeConnections().seed('c1'),
      });
      await eventually(bed, () => bed.el.querySelector('#f-name') !== null);
      byText(bed.el, 'app-gated', 'Save changes')
        .querySelector('button')
        ?.click();
      await eventually(
        bed,
        () => exists(bed.el, '[role="alert"]', 'GATE_BLOCKED'),
        'the engine refusal',
      );
      const alert = squash(
        bed.el.querySelector('form [role="alert"]')?.textContent,
      );
      expect(alert).toContain('The call is blocked');
      expect(alert).toContain('prod-lock');
      expect(bed.router.url).toBe('/connections/c1/edit');
      byText(bed.el, 'form button', 'Unlock this connection').click();
      await eventually(
        bed,
        () => bed.el.querySelector('[role="dialog"]') !== null,
      );
      byText(dialogEl(bed), 'button', 'Unlock').click();
      await eventually(
        bed,
        () =>
          bed.fake.armed.has('c1') &&
          bed.el.querySelector('[role="dialog"]') === null,
        'the unlock',
      );
      byText(bed.el, 'app-gated', 'Save changes')
        .querySelector('button')
        ?.click();
      await eventually(
        bed,
        () => bed.router.url === '/connections/c1',
        'the saved page',
      );
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-4 moving an address asks for the secret again before sending, because a stored secret does not follow it',
    async () => {
      const bed = await mountRouted('/connections/c1/edit', {
        fake: new FakeConnections().seed('c1'),
      });
      await eventually(bed, () => bed.el.querySelector('#f-name') !== null);
      bed.fake.armed.add('c1');
      type(field(bed, 'f-http-host'), 'other.example');
      byText(bed.el, 'app-gated', 'Save changes')
        .querySelector('button')
        ?.click();
      await eventually(
        bed,
        () => exists(bed.el, '.summary li', 'The address changed'),
        'the summary',
      );
      expect(
        bed.fake.requestLines.filter((l) => l.startsWith('PATCH')),
      ).toEqual([]);
      type(field(bed, 'f-http-secret'), CANARY);
      byText(bed.el, 'app-gated', 'Save changes')
        .querySelector('button')
        ?.click();
      await eventually(
        bed,
        () => bed.router.url === '/connections/c1',
        'the saved page',
      );
      const patch = bed.fake.bodies.find(
        (b) => b.line === 'PATCH /connections/c1',
      );
      expect((patch?.body.http as { host: string }).host).toBe('other.example');
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-8 an unknown connection to edit says so and shows no form',
    async () => {
      const bed = await mountRouted('/connections/nope/edit', {
        fake: new FakeConnections(),
      });
      await eventually(
        bed,
        () => exists(bed.el, '[role="alert"]', 'No such connection'),
        'the not-found problem',
      );
      expect(bed.el.querySelector('form')).toBeNull();
    },
    PAGE_TEST_TIMEOUT_MS,
  );
});
