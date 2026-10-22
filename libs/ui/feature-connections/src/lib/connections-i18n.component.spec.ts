// M0-52 AC-11, the mounted half: every visible string of the connections pages is a Transloco key or engine data.
// The pages are mounted with a scope that answers `[[connections.<path>]]` for every text, so the spec sees which
// key each text, `aria-label`, `title` and placeholder came from, and that the key exists. The other half (every
// key literal of the source exists, every key is asked for, no forbidden claim, no `innerHTML`) reads the source as
// text and lives in the node tool `web-gallery-check` (`connections-i18n-source.test.mjs`).
import { describe, expect, it } from 'vitest';

import en from '../i18n/en.json';
import { markedConnectionsScope } from '../testing';
import { CONNECTIONS_SCOPE_LOADER } from './connections-scope';
import { byText, type, squash } from './testing/dom';
import { FakeConnections, problemOf } from './testing/fake-connections';
import { CANARY, profileFixture } from './testing/fixtures';
import {
  eventually,
  mountRouted,
  PAGE_TEST_TIMEOUT_MS,
  type RoutedBed,
} from './testing/routed-bed';

interface Tree {
  readonly [key: string]: string | Tree;
}

function leaves(tree: Tree, path: string): string[] {
  return Object.entries(tree).flatMap(([name, value]) =>
    typeof value === 'string'
      ? [`${path}.${name}`]
      : leaves(value, `${path}.${name}`),
  );
}

const KEY_SET = new Set(leaves(en, 'connections'));

/** The engine's own words and data that the fixtures put on screen: names, addresses, versions, ids, codes. */
const ENGINE_DATA: readonly RegExp[] = [
  /^[\d.,\s:/()-]*$/,
  /^(Broker c\d+|Lab|Orders prod|Team broker)$/,
  /^(127\.0\.0\.1|guest|rabbit@a|rabbitmq|RabbitMQ|administrator|4\.3(\.6)?|http:\/\/127\.0\.0\.1:15672)$/,
  /^(amqp\.[a-z]+|streams\.browse|future\.thing|prod-lock|[A-Z_]{4,})$/,
  /^\(?[A-Z][a-z]{2} \d+, \d{4}, [\d: ]+(AM|PM)\)?$/,
  /^(www\.rabbitmq\.com|insecure\.example)$/,
  /^\d+:\d+(:\d+)?$/,
  /^(not enabled|No such connection|The call is blocked|The production lock is on\.|The profile is not valid|Check http\.host\.|engine words|amqp words)/,
  /^(This is a production connection and it is locked\. Arm it to make changes for 15 minutes\.|The user has no write permission\.|The engine said:)/,
  /^[^[\]]*(guest|127\.0\.0\.1)[^[\]]*$/,
];

function visibleStrings(root: Element): string[] {
  const found: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = squash(node.textContent);
      if (text !== '') found.push(text);
      return;
    }
    if (node instanceof Element) {
      for (const name of [
        'aria-label',
        'title',
        'placeholder',
        'alt',
        'label',
      ]) {
        const value = node.getAttribute(name)?.trim();
        if (value) found.push(value);
      }
    }
    node.childNodes.forEach(walk);
  };
  walk(root);
  return found;
}

function classify(el: Element): { keys: Set<string>; strangers: string[] } {
  const keys = new Set<string>();
  const strangers: string[] = [];
  for (const text of visibleStrings(el)) {
    const markers = [
      ...text.matchAll(/\[\[(connections\.[A-Za-z0-9._@-]+)\]\]/g),
    ];
    if (markers.length > 0) {
      for (const marker of markers)
        if (marker[1] !== undefined) keys.add(marker[1]);
      const rest = text.replace(/\[\[[^\]]*\]\]/g, '').trim();
      if (
        rest !== '' &&
        !/^[\s,;:()/·–.-]*$/.test(rest) &&
        !ENGINE_DATA.some((p) => p.test(rest))
      ) {
        strangers.push(text);
      }
    } else if (!ENGINE_DATA.some((pattern) => pattern.test(text))) {
      strangers.push(text);
    }
  }
  return { keys, strangers };
}

const field = (bed: RoutedBed, id: string): HTMLInputElement => {
  const el = bed.el.querySelector<HTMLInputElement>(`#${id}`);
  if (!el) throw new Error(`no field ${id}`);
  return el;
};

const section = (bed: RoutedBed): Element => {
  const el = bed.el.querySelector('app-capability-section');
  if (!el) throw new Error('no capability section');
  return el;
};

const markedScope = {
  provide: CONNECTIONS_SCOPE_LOADER,
  useValue: markedConnectionsScope,
};

async function mount(url: string, fake: FakeConnections): Promise<RoutedBed> {
  return await mountRouted(url, { fake, providers: [markedScope] });
}

async function ready(bed: RoutedBed, selector: string): Promise<void> {
  await eventually(
    bed,
    () => bed.el.querySelector(selector) !== null,
    selector,
  );
}

describe('the connections strings', () => {
  it('AC-11 every visible string of the list, the connection page, its dialogs and the form is a Transloco key or engine data', async () => {
    const seen = new Set<string>();
    const take = (bed: RoutedBed, label: string): void => {
      const shown = classify(bed.el);
      expect(shown.strangers, label).toEqual([]);
      for (const key of shown.keys)
        expect(KEY_SET.has(key), `${label}: ${key}`).toBe(true);
      for (const key of shown.keys) seen.add(key);
    };

    // The list: rows, then the same page when the engine cannot be read.
    const fake = new FakeConnections();
    fake.profiles = [
      profileFixture('p1', { name: 'Orders prod', envClass: 'prod' }),
      profileFixture('c1', { name: 'Lab' }),
      profileFixture('t1', {
        name: 'Team broker',
        canEdit: false,
        secretsSet: false,
      }),
    ];
    let bed = await mount('/connections', fake);
    await ready(bed, 'tbody tr');
    take(bed, 'list');
    const failing = new FakeConnections();
    failing.failure.list = problemOf(503, 'INTERNAL', {
      title: 'The call is blocked',
    });
    bed = await mount('/connections', failing);
    await ready(bed, '[role="alert"]');
    take(bed, 'list failed');
    bed = await mount('/connections', new FakeConnections());
    await eventually(
      bed,
      () =>
        bed.el.querySelector('p') !== null &&
        !bed.el.querySelector('[role="status"]'),
      'empty',
    );
    take(bed, 'list empty');

    // A production connection: the closed gate, the unlock dialog and its refusal, the unlocked line.
    bed = await mount('/connections/p1', fake);
    await ready(bed, 'app-gated');
    await eventually(
      bed,
      () =>
        bed.el.querySelector('table.gates') !== null ||
        bed.el.querySelector('app-capability-section p') !== null,
    );
    take(bed, 'prod page');
    byText(bed.el, '.lock button', '[[connections.lock.unlock]]').click();
    await ready(bed, '[role="dialog"]');
    take(bed, 'unlock dialog');
    fake.failure.arm = problemOf(403, 'FORBIDDEN_RBAC', {
      title: 'The call is blocked',
    });
    byText(
      bed.el,
      '[role="dialog"] button',
      '[[connections.lock.dialog.confirm]]',
    ).click();
    await ready(bed, '[role="dialog"] [role="alert"]');
    take(bed, 'unlock refused');
    fake.failure = {};
    byText(
      bed.el,
      '[role="dialog"] button',
      '[[connections.lock.dialog.confirm]]',
    ).click();
    await ready(bed, '[data-lock="armed"]');
    take(bed, 'unlocked');

    // A connection of someone else, a delete dialog with the engine's refusal and the unlock offered.
    bed = await mount('/connections/t1', fake);
    await ready(bed, 'app-gated');
    take(bed, 'not owner');
    bed = await mount('/connections/c1', fake);
    await ready(bed, 'app-gated');
    bed.el.querySelector<HTMLButtonElement>('app-gated button')?.click();
    await ready(bed, '[role="dialog"]');
    take(bed, 'delete dialog');
    byText(
      bed.el,
      '[role="dialog"] button',
      '[[connections.delete.confirm]]',
    ).click();
    await ready(bed, '[role="dialog"] [role="alert"]');
    take(bed, 'delete refused');
    bed = await mount('/connections/nope', fake);
    await ready(bed, '[role="alert"]');
    take(bed, 'missing');

    // The create form: empty, with its errors, with the draft tests passing and failing.
    const form = new FakeConnections();
    bed = await mount('/connections/new', form);
    await ready(bed, 'form');
    take(bed, 'create form');
    byText(
      bed.el,
      'button[type="submit"]',
      '[[connections.form.create]]',
    ).click();
    await ready(bed, '.summary');
    take(bed, 'create errors');
    type(field(bed, 'f-name'), 'Lab');
    type(field(bed, 'f-http-host'), '127.0.0.1');
    type(field(bed, 'f-http-username'), 'guest');
    type(field(bed, 'f-http-secret'), CANARY);
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
      'two results',
    );
    take(bed, 'tests passed');
    form.testHttp = () => ({
      ok: false,
      target: { url: 'x' },
      tookMs: 1,
      failure: { code: 'HTTP_AUTH_REFUSED', message: 'engine words' },
    });
    form.testAmqp = () => ({
      ok: false,
      target: { host: 'h', port: 5672, tls: false, vhost: '/' },
      tookMs: 1,
      failure: { code: 'AMQP_VHOST_REFUSED', message: 'amqp words' },
      gates: { 'amqp.peek': { enabled: false } },
    });
    for (const button of bed.el.querySelectorAll<HTMLButtonElement>(
      'app-test-panel .one button',
    ))
      button.click();
    await eventually(
      bed,
      () => bed.el.querySelectorAll('app-test-panel .bad').length === 2,
      'two failures',
    );
    take(bed, 'tests failed');

    // The edit form with a moved address.
    bed = await mount('/connections/c1/edit', fake);
    await ready(bed, '#f-name');
    take(bed, 'edit form');
    type(field(bed, 'f-http-host'), 'other.example');
    byText(bed.el, 'app-gated', '[[connections.form.save]]')
      .querySelector('button')
      ?.click();
    await ready(bed, '.summary');
    take(bed, 'edit errors');

    expect(seen.size).toBeGreaterThan(60);
  }, 60_000);

  it(
    "AC-11 the capability section's words are keys in every state it can be in",
    async () => {
      const states: ((fake: FakeConnections) => void)[] = [
        () => undefined,
        (fake) => (fake.profile = null),
        (fake) =>
          (fake.failure.profile = problemOf(503, 'BROKER_UNREACHABLE', {
            title: 'The call is blocked',
          })),
        (fake) =>
          (fake.profile = () => ({
            gates: {
              'amqp.peek': { enabled: true, mode: 'degraded' },
              'future.thing': 'no',
            },
          })),
      ];
      for (const [index, arrange] of states.entries()) {
        const fake = new FakeConnections().seed('c1');
        arrange(fake);
        const bed = await mount('/connections/c1', fake);
        await eventually(
          bed,
          () =>
            bed.el.querySelector('app-capability-section h2') !== null &&
            !squash(
              bed.el.querySelector('app-capability-section')?.textContent,
            ).includes('[[connections.capabilities.loading]]'),
          'the section',
        );
        const shown = classify(section(bed));
        expect(shown.strangers, `state ${String(index)}`).toEqual([]);
        for (const key of shown.keys) expect(KEY_SET.has(key), key).toBe(true);
      }
      // The probe's steps and the broker facts.
      const fake = new FakeConnections().seed('c1');
      const bed = await mount('/connections/c1', fake);
      await eventually(
        bed,
        () =>
          bed.el.querySelector('app-capability-section table.gates') !== null,
      );
      byText(
        bed.el,
        'app-capability-section button',
        '[[connections.capabilities.check]]',
      ).click();
      await eventually(
        bed,
        () => bed.el.querySelector('table.steps') !== null,
        'the steps',
      );
      const shown = classify(section(bed));
      expect(shown.strangers).toEqual([]);
      for (const key of shown.keys) expect(KEY_SET.has(key), key).toBe(true);
      expect(shown.keys.size).toBeGreaterThan(20);
    },
    PAGE_TEST_TIMEOUT_MS * 2,
  );
});
