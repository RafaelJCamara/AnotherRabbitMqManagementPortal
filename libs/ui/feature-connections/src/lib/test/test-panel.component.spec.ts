import { ENGINE_PARSE } from '@app/ui-data';
import { describe, expect, it } from 'vitest';

import { byText, exists, squash, type } from '../testing/dom';
import { FakeConnections, problemOf } from '../testing/fake-connections';
import { CANARY } from '../testing/fixtures';
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

/** The block of one test (management or AMQP) in the panel. */
const block = (
  bed: RoutedBed,
  heading: 'Management API' | 'AMQP',
): HTMLElement => {
  const one = [
    ...bed.el.querySelectorAll<HTMLElement>('app-test-panel .one'),
  ].find((el) => squash(el.querySelector('h3')?.textContent) === heading);
  if (!one) throw new Error(`no ${heading} block`);
  return one;
};

const run = (bed: RoutedBed, heading: 'Management API' | 'AMQP'): void => {
  block(bed, heading).querySelector('button')?.click();
};

const result = (bed: RoutedBed, heading: 'Management API' | 'AMQP'): string =>
  squash(block(bed, heading).querySelector('.result')?.textContent);

const requests = (
  bed: RoutedBed,
  line: string,
): { body: Record<string, unknown> }[] =>
  bed.fake.bodies.filter((b) => b.line === line);

async function createForm(bed: RoutedBed): Promise<void> {
  await eventually(
    bed,
    () => bed.el.querySelector('#f-name') !== null,
    'the form',
  );
}

/** Types the address and the login of a lab broker, then waits until the tests can aim at them. */
async function fillAddress(bed: RoutedBed): Promise<void> {
  type(field(bed, 'f-http-host'), '127.0.0.1');
  type(field(bed, 'f-http-username'), 'guest');
  type(field(bed, 'f-http-secret'), CANARY);
  await eventually(
    bed,
    () =>
      block(bed, 'AMQP')
        .querySelector('button')
        ?.getAttribute('aria-disabled') === null,
    'the tests to open',
  );
}

describe('the test panel', () => {
  it(
    'AC-5 on the create form with nothing to aim at the buttons are closed, say why and send nothing',
    async () => {
      const bed = await mountRouted('/connections/new', {
        fake: new FakeConnections(),
      });
      await createForm(bed);
      expect(
        squash(bed.el.querySelector('app-test-panel')?.textContent),
      ).toContain('Enter an address and a login first.');
      expect(
        block(bed, 'AMQP')
          .querySelector('button')
          ?.getAttribute('aria-disabled'),
      ).toBe('true');
      run(bed, 'Management API');
      run(bed, 'AMQP');
      bed.harness.detectChanges();
      expect(bed.fake.requestLines.filter((l) => l.includes('/test-'))).toEqual(
        [],
      );
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-5 each test sends its own call with the form draft, and shows its own result in its own live region',
    async () => {
      const bed = await mountRouted('/connections/new', {
        fake: new FakeConnections(),
      });
      await createForm(bed);
      await fillAddress(bed);
      await eventually(
        bed,
        () =>
          block(bed, 'AMQP')
            .querySelector('button')
            ?.getAttribute('aria-disabled') === null,
        'open buttons',
      );
      run(bed, 'Management API');
      await eventually(
        bed,
        () => result(bed, 'Management API').includes('answered in 12 ms'),
        'the management result',
      );
      // The management result: the broker's words, as data.
      const http = result(bed, 'Management API');
      expect(http).toContain('RabbitMQ 4.3.6');
      expect(http).toContain('rabbit@a');
      expect(http).toContain('guest');
      expect(http).toContain('administrator');
      expect(http).toContain('http://127.0.0.1:15672');
      // The AMQP side has not been touched.
      expect(result(bed, 'AMQP')).toBe('');
      expect(requests(bed, 'POST /connections/test-amqp')).toEqual([]);
      expect(requests(bed, 'POST /connections/test-http')).toHaveLength(1);
      expect(requests(bed, 'POST /connections/test-http')[0]?.body).toEqual({
        draft: {
          http: {
            host: '127.0.0.1',
            auth: { kind: 'basic', username: 'guest', password: CANARY },
          },
          amqp: {
            auth: { kind: 'plain', username: 'guest', password: CANARY },
          },
        },
      });
      run(bed, 'AMQP');
      await eventually(
        bed,
        () => result(bed, 'AMQP').includes('opened and closed in 8 ms'),
        'the AMQP result',
      );
      expect(result(bed, 'AMQP')).toContain('127.0.0.1:5672, virtual host /');
      expect(result(bed, 'AMQP')).toContain('amqp.peek');
      expect(result(bed, 'AMQP')).toContain('Available');
      // Both live regions are polite and named by their heading.
      for (const heading of ['Management API', 'AMQP'] as const) {
        const region = block(bed, heading).querySelector('.result');
        expect(region?.getAttribute('aria-live')).toBe('polite');
        expect(region?.getAttribute('aria-labelledby')).not.toBeNull();
      }
      // The draft's secret is in the two test bodies and in no page text.
      expect(squash(document.body.textContent)).not.toContain(CANARY);
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-5 a failed test is an answer with its own cause, hint and the engine words as sent, and a second run replaces only its own result',
    async () => {
      const fake = new FakeConnections();
      fake.testHttp = () => ({
        ok: false,
        target: { url: 'http://127.0.0.1:15672' },
        tookMs: 30,
        failure: {
          code: 'HTTP_AUTH_REFUSED',
          message: 'The management API refused the login.',
        },
      });
      fake.testAmqp = () => ({
        ok: false,
        target: { host: '127.0.0.1', port: 5672, tls: false, vhost: '/' },
        tookMs: 5,
        failure: {
          code: 'AMQP_PORT_BLOCKED',
          message: 'AMQP port blocked: nothing answered.',
        },
        gates: {
          'amqp.peek': {
            enabled: false,
            reason: 'The AMQP endpoint could not be reached.',
          },
        },
      });
      const bed = await mountRouted('/connections/new', { fake });
      await createForm(bed);
      await fillAddress(bed);
      run(bed, 'Management API');
      run(bed, 'AMQP');
      await eventually(
        bed,
        () =>
          result(bed, 'Management API').includes('The login was refused') &&
          result(bed, 'AMQP').includes('Nothing answered on the AMQP port'),
        'both failures',
      );
      expect(result(bed, 'Management API')).toContain(
        'Check the user name and the password or token.',
      );
      expect(result(bed, 'Management API')).toContain(
        'The management API refused the login.',
      );
      expect(result(bed, 'AMQP')).toContain(
        'AMQP port blocked: nothing answered.',
      );
      // Every gate is closed with the reason of the failure.
      expect(result(bed, 'AMQP')).toContain('Not available');
      expect(result(bed, 'AMQP')).toContain(
        'The AMQP endpoint could not be reached.',
      );
      const amqpBefore = result(bed, 'AMQP');
      // The management test now passes; the AMQP result stays as it was.
      fake.testHttp = () => ({
        ok: true,
        target: { url: 'http://127.0.0.1:15672' },
        tookMs: 7,
        broker: { product: 'RabbitMQ', version: '4.3.6', tags: [] },
      });
      run(bed, 'Management API');
      await eventually(
        bed,
        () => result(bed, 'Management API').includes('answered in 7 ms'),
        'the new management result',
      );
      expect(result(bed, 'Management API')).not.toContain(
        'The login was refused',
      );
      expect(result(bed, 'AMQP')).toBe(amqpBefore);
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-5 every failure code the contract names has its own heading and hint, and a code this build does not know is shown as the code',
    async () => {
      const codes = [
        ['HTTP_UNREACHABLE', 'The management API could not be reached'],
        ['HTTP_TIMEOUT', 'The management API did not answer in time'],
        ['HTTP_EGRESS_DENIED', 'The engine may not connect to this address'],
        ['HTTP_TLS_UNTRUSTED', 'The certificate is not trusted'],
        ['HTTP_AUTH_REFUSED', 'The login was refused'],
        [
          'HTTP_MISSING_TAG',
          'The user has no tag that allows the management API',
        ],
        ['HTTP_NOT_MANAGEMENT', 'This is not a management API'],
        ['HTTP_UNEXPECTED', 'The answer was not what a management API sends'],
        ['SECRET_UNAVAILABLE', 'The stored login could not be opened'],
        ['HTTP_FROM_A_NEWER_ENGINE', 'HTTP_FROM_A_NEWER_ENGINE'],
      ] as const;
      const fake = new FakeConnections();
      let next = 0;
      fake.testHttp = () => ({
        ok: false,
        target: { url: 'http://127.0.0.1:15672' },
        tookMs: 1,
        failure: { code: codes[next]?.[0] ?? '', message: 'engine words' },
      });
      // A production build skips the parse, so a code from a newer engine reaches the page: do the same here.
      const bed = await mountRouted('/connections/new', {
        fake,
        providers: [{ provide: ENGINE_PARSE, useValue: false }],
      });
      await createForm(bed);
      await fillAddress(bed);
      for (const [index, [, heading]] of codes.entries()) {
        next = index;
        run(bed, 'Management API');
        await eventually(
          bed,
          () => result(bed, 'Management API').includes(heading),
          heading,
        );
        // A known code has a hint in the page's own words; an unknown one has none and still shows the engine's.
        expect(result(bed, 'Management API')).toContain('engine words');
      }
      const amqpCodes = [
        ['AMQP_PORT_BLOCKED', 'Nothing answered on the AMQP port'],
        ['AMQP_EGRESS_DENIED', 'The engine may not connect to this address'],
        ['AMQP_TLS_UNTRUSTED', 'The certificate is not trusted'],
        ['AMQP_AUTH_REFUSED', 'The login was refused'],
        ['AMQP_VHOST_REFUSED', 'The virtual host was refused'],
        ['AMQP_UNEXPECTED', 'The AMQP connection failed in an unexpected way'],
      ] as const;
      let nextAmqp = 0;
      fake.testAmqp = () => ({
        ok: false,
        target: { host: 'h', port: 5672, tls: false, vhost: '/' },
        tookMs: 1,
        failure: {
          code: amqpCodes[nextAmqp]?.[0] ?? '',
          message: 'amqp words',
        },
        gates: {},
      });
      for (const [index, [, heading]] of amqpCodes.entries()) {
        nextAmqp = index;
        run(bed, 'AMQP');
        await eventually(
          bed,
          () => result(bed, 'AMQP').includes(heading),
          heading,
        );
      }
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-5 a test that is running cannot be started again, and says it is running',
    async () => {
      const fake = new FakeConnections();
      let release: () => void = () => undefined;
      fake.holdTests = new Promise<void>((resolve) => {
        release = resolve;
      });
      const bed = await mountRouted('/connections/new', { fake });
      await createForm(bed);
      await fillAddress(bed);
      run(bed, 'Management API');
      await eventually(
        bed,
        () =>
          squash(
            block(bed, 'Management API').querySelector('button')?.textContent,
          ) === 'Testing',
        'the running label',
      );
      expect(
        block(bed, 'Management API')
          .querySelector('button')
          ?.getAttribute('aria-disabled'),
      ).toBe('true');
      run(bed, 'Management API');
      run(bed, 'Management API');
      release();
      await eventually(
        bed,
        () => result(bed, 'Management API').includes('answered in'),
        'the result',
      );
      expect(requests(bed, 'POST /connections/test-http')).toHaveLength(1);
      expect(
        squash(
          block(bed, 'Management API').querySelector('button')?.textContent,
        ),
      ).toBe('Test');
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-5 a Problem of the engine (a refused draft) is shown as sent in the test that asked',
    async () => {
      const fake = new FakeConnections();
      fake.failure.testAmqp = problemOf(400, 'VALIDATION_FAILED', {
        title: 'The draft is not valid',
        detail: 'A host is needed.',
      });
      const bed = await mountRouted('/connections/new', { fake });
      await createForm(bed);
      await fillAddress(bed);
      run(bed, 'AMQP');
      await eventually(
        bed,
        () => result(bed, 'AMQP').includes('A host is needed.'),
        'the problem',
      );
      expect(result(bed, 'AMQP')).toContain('The draft is not valid');
      expect(result(bed, 'AMQP')).toContain('VALIDATION_FAILED');
      expect(result(bed, 'Management API')).toBe('');
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-5 the broker AMQP ports can be used for the form, the TLS one when TLS is on',
    async () => {
      const bed = await mountRouted('/connections/new', {
        fake: new FakeConnections(),
      });
      await createForm(bed);
      await fillAddress(bed);
      run(bed, 'Management API');
      await eventually(
        bed,
        () => exists(bed.el, 'app-test-panel button', 'Use for the AMQP port'),
        'the offer',
      );
      expect(result(bed, 'Management API')).toContain(
        'listens on 5672 (plain) and 5671 (TLS)',
      );
      byText(bed.el, 'app-test-panel button', 'Use for the AMQP port').click();
      await eventually(
        bed,
        () => field(bed, 'f-amqp-port').value === '5672',
        'the plain port',
      );
      field(bed, 'f-amqp-port').value = '';
      const tlsBoxes = [
        ...bed.el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
      ];
      tlsBoxes[1]?.click();
      await eventually(bed, () => tlsBoxes[1]?.checked === true);
      byText(bed.el, 'app-test-panel button', 'Use for the AMQP port').click();
      await eventually(
        bed,
        () => field(bed, 'f-amqp-port').value === '5671',
        'the TLS port',
      );
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-5 on a saved connection both tests use the stored login: the call carries the id and no secret',
    async () => {
      const bed = await mountRouted('/connections/c1', {
        fake: new FakeConnections().seed('c1'),
      });
      await eventually(
        bed,
        () => bed.el.querySelector('app-test-panel') !== null,
        'the panel',
      );
      expect(
        squash(bed.el.querySelector('app-test-panel')?.textContent),
      ).toContain('These tests use the saved connection');
      run(bed, 'Management API');
      run(bed, 'AMQP');
      await eventually(
        bed,
        () =>
          result(bed, 'Management API') !== '' && result(bed, 'AMQP') !== '',
      );
      expect(requests(bed, 'POST /connections/test-http')[0]?.body).toEqual({
        cid: 'c1',
      });
      expect(requests(bed, 'POST /connections/test-amqp')[0]?.body).toEqual({
        cid: 'c1',
      });
    },
    PAGE_TEST_TIMEOUT_MS,
  );
});
