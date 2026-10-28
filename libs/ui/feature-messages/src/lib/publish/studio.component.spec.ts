import type { Problem } from '@app/contracts';
import { EngineProblemError } from '@app/ui-data';
import { Subject, of, throwError } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { confirmedResult } from './fake-api';
import { profileFixture } from './profile-fixture';
import { squash } from './spec-support';
import {
  field,
  mount,
  sendButton,
  settle,
  typeInto,
  until,
  VALID,
  withDraft,
  type Bed,
} from './studio-bed';

const refusal = (over: Partial<Problem> = {}): EngineProblemError =>
  new EngineProblemError({
    type: 'about:blank',
    title: 'Locked',
    status: 403,
    code: 'GATE_BLOCKED',
    correlationId: 'x',
    retryable: false,
    ...over,
  });

const strip = (bed: Bed): Element | null =>
  bed.el.querySelector('app-lock-strip [data-lock]');
const stripButton = (bed: Bed): HTMLButtonElement => {
  const button = bed.el.querySelector<HTMLButtonElement>(
    'app-lock-strip .lock button',
  );
  if (button === null) throw new Error('no lock button');
  return button;
};

describe('<app-publish-studio>', () => {
  it('M1-46 AC-22 mandatory and confirms are fixed facts, not options', async () => {
    const bed = await mount('/c/c1/publish');
    const facts = [...bed.el.querySelectorAll('[data-fact]')];
    expect(facts.map((fact) => fact.getAttribute('data-fact'))).toEqual([
      'mandatory',
      'confirm',
    ]);
    expect(facts[0]?.textContent).toContain('Mandatory is always on');
    expect(facts[1]?.textContent).toContain('Publisher confirms are always on');
    // Nothing that could switch either off: no checkbox, no radio, and no control named for them.
    expect(
      bed.el.querySelector(
        'input[type="checkbox"], input[type="radio"], [role="switch"], [role="checkbox"]',
      ),
    ).toBeNull();
    for (const control of bed.el.querySelectorAll(
      'input, select, textarea, button',
    )) {
      expect(
        `${control.id} ${control.getAttribute('name') ?? ''} ${control.getAttribute('aria-label') ?? ''}`,
      ).not.toMatch(/mandatory|confirm/i);
    }
    // The draft cannot carry them either.
    expect(Object.keys(bed.store.draft('c1')())).not.toContain('mandatory');
    expect(Object.keys(bed.store.draft('c1')())).not.toContain('confirm');
  });

  it('M1-46 AC-25 prefills from the address and ignores the rest', async () => {
    const bed = await mount(
      '/c/c1/publish?vhost=tenant-a&exchange=orders&routingKey=a.b&other=1&copies=50',
    );
    expect(field(bed, 'f-vhost').value).toBe('tenant-a');
    expect(field(bed, 'f-exchange').value).toBe('orders');
    expect(field(bed, 'f-routingKey').value).toBe('a.b');
    expect(field(bed, 'f-copies').value).toBe('1'); // not a parameter the studio reads
    const draft = bed.store.draft('c1')();
    expect(draft).toMatchObject({
      vhost: 'tenant-a',
      exchange: 'orders',
      routingKey: 'a.b',
      copies: 1,
    });
    expect(bed.el.querySelector('[role="alert"]')).toBeNull();

    // A value over the bound is refused by name and never cut; the others are still used.
    const long = 'x'.repeat(300);
    const refused = await mount(
      `/c/c1/publish?exchange=${long}&routingKey=${'k'.repeat(255)}`,
    );
    expect(field(refused, 'f-exchange').value).toBe('');
    expect(field(refused, 'f-routingKey').value).toBe('k'.repeat(255));
    const alert = refused.el.querySelector('[role="alert"]')?.textContent ?? '';
    expect(alert).toContain('exchange');
    expect(alert).toContain('255');
    expect(alert).not.toContain('routingKey');
    expect(alert).not.toContain(long);
  });

  it('shows nothing and asks nothing of the engine without a connection', async () => {
    const bed = await mount('/c/c1/publish', { cid: null });
    expect(bed.el.querySelector('section, h1, input')).toBeNull();
    expect(bed.host.editors).toHaveLength(0);
  });

  it('composes: each field reaches the draft, a limit is named at its field, and the draft outlives the page', async () => {
    const bed = await mount('/c/c1/publish');
    typeInto(field(bed, 'f-vhost'), 'shop');
    typeInto(field(bed, 'f-exchange'), 'orders.x');
    typeInto(field(bed, 'f-routingKey'), 'created');
    typeInto(field(bed, 'f-copies'), '101');
    typeInto(field(bed, 'f-timeoutMs'), '99');
    typeInto(field(bed, 'prop-appId'), 'a'.repeat(256));
    await settle(bed.harness);
    expect(bed.store.draft('c1')()).toMatchObject({
      vhost: 'shop',
      exchange: 'orders.x',
      routingKey: 'created',
      copies: 101,
      timeoutMs: 99,
      props: { appId: 'a'.repeat(256) },
    });
    const text = (id: string): string =>
      bed.el.querySelector(`#${id}-error`)?.textContent ?? '';
    expect(text('f-copies')).toContain('Between 1 and 100');
    expect(text('f-timeoutMs')).toContain('Between 100 and 30000');
    expect(text('prop-appId')).toContain('At most 255');
    expect(field(bed, 'f-copies').getAttribute('aria-invalid')).toBe('true');
    expect(field(bed, 'f-copies').getAttribute('aria-describedby')).toBe(
      'f-copies-error',
    );
    expect(bed.el.querySelector('[role="status"]')?.textContent).toContain(
      '3 to fix',
    );

    // A number cleared is flagged, not turned into a value; fixing the fields lifts the marks.
    typeInto(field(bed, 'f-copies'), '');
    await settle(bed.harness);
    expect(text('f-copies')).toContain('Between 1 and 100');
    typeInto(field(bed, 'f-copies'), '100');
    typeInto(field(bed, 'f-timeoutMs'), '30000');
    typeInto(field(bed, 'prop-appId'), '');
    await settle(bed.harness);
    expect(bed.el.querySelector('.error')).toBeNull();
    expect(bed.el.querySelector('[role="status"]')?.textContent.trim()).toBe(
      '',
    );
    expect(bed.store.draft('c1')().props).toEqual({});

    // Leaving and coming back shows the same draft.
    await bed.harness.navigateByUrl('/c/c1/publish?other=1');
    await settle(bed.harness);
    expect(field(bed, 'f-exchange').value).toBe('orders.x');
  });

  it('edits the properties, the headers and the body into the draft', async () => {
    const bed = await mount('/c/c1/publish');
    const mode = bed.el.querySelector<HTMLSelectElement>('#prop-deliveryMode');
    if (mode === null) throw new Error('no delivery mode');
    mode.value = '2';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
    typeInto(field(bed, 'prop-priority'), '7');
    typeInto(field(bed, 'prop-contentType'), 'text/plain');
    await settle(bed.harness);
    expect(bed.store.draft('c1')().props).toEqual({
      deliveryMode: 2,
      priority: 7,
      contentType: 'text/plain',
    });
    mode.value = '';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
    typeInto(field(bed, 'prop-priority'), '');
    await settle(bed.harness);
    expect(bed.store.draft('c1')().props).toEqual({
      contentType: 'text/plain',
    });
    // The delivery mode shown is the draft's, also when the page is opened again.
    mode.value = '1';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
    await settle(bed.harness);
    await bed.harness.navigateByUrl('/c/c1/publish?other=1');
    await settle(bed.harness);
    const again = bed.el.querySelector<HTMLSelectElement>('#prop-deliveryMode');
    if (again === null) throw new Error('no delivery mode');
    expect(again.value).toBe('1');
    expect(bed.store.draft('c1')().props.deliveryMode).toBe(1);
    again.value = '';
    again.dispatchEvent(new Event('change', { bubbles: true }));
    await settle(bed.harness);
    expect(bed.store.draft('c1')().props).toEqual({
      contentType: 'text/plain',
    });

    // The body: the editor's text is the draft's, and the size is the encoded one.
    bed.host.editors[0]?.type('héllo');
    await settle(bed.harness);
    expect(bed.store.draft('c1')().body.data).toBe('héllo');
    expect(bed.el.textContent).toContain('6 of 1048576 bytes');
    const encoding = bed.el.querySelector<HTMLSelectElement>('#f-encoding');
    if (encoding === null) throw new Error('no encoding');
    encoding.value = 'base64';
    encoding.dispatchEvent(new Event('change', { bubbles: true }));
    await settle(bed.harness);
    expect(bed.store.draft('c1')().body.encoding).toBe('base64');
    expect(bed.el.textContent).toContain('not valid base64');
    const language = bed.el.querySelector<HTMLSelectElement>('#f-language');
    if (language === null) throw new Error('no language');
    language.value = 'json';
    language.dispatchEvent(new Event('change', { bubbles: true }));
    language.value = 'nonsense';
    language.dispatchEvent(new Event('change', { bubbles: true }));
    await settle(bed.harness);
    expect(bed.store.draft('c1')().body.language).toBe('json');
    expect(bed.host.editors[0]?.language).toBe('json');

    // The headers: a row added in the table is a row of the draft, and a bad JSON holds the send back.
    bed.el.querySelector<HTMLButtonElement>('button.add')?.click();
    await settle(bed.harness);
    expect(bed.store.draft('c1')().headers).toHaveLength(1);
    // A row with no name holds the JSON view back, and naming it lets the switch through.
    bed.el.querySelector<HTMLButtonElement>('button.mode-json')?.click();
    await settle(bed.harness);
    expect(bed.store.draft('c1')().headerMode).toBe('grid');
    typeInto(bed.el.querySelector('tbody input'), 'x-id');
    bed.el.querySelector<HTMLButtonElement>('button.mode-json')?.click();
    await settle(bed.harness);
    expect(bed.store.draft('c1')().headerMode).toBe('json');
  });

  it('uses a plain text box when the code editor cannot be loaded, and loses nothing', async () => {
    const bed = await mount('/c/c1/publish', { loadFails: true });
    expect(bed.el.textContent).toContain('code editor could not be loaded');
    const box = bed.el.querySelector('textarea');
    typeInto(box, 'plain text');
    await settle(bed.harness);
    expect(bed.store.draft('c1')().body.data).toBe('plain text');
    expect(bed.el.querySelector('textarea')?.value).toBe('plain text');
    expect(bed.el.querySelector('textarea')?.getAttribute('spellcheck')).toBe(
      'false',
    );
    expect(bed.el.querySelector('textarea')?.getAttribute('aria-label')).toBe(
      'Message body',
    );
  });

  it('M1-46 AC-32 shows the prod lock as sent and arms through ArmingStore', async () => {
    const bed = await mount('/c/c1/publish', {
      seed: withDraft(VALID),
      engine: {
        profiles: [
          profileFixture('c1', { envClass: 'prod', name: 'Production' }),
        ],
        plan: () => throwError(() => refusal()),
        execute: () => of({ output: confirmedResult() }),
      },
    });
    await until(bed, () => strip(bed) !== null, 'the lock strip');
    const publishCalls = (): number =>
      bed.api.calls.filter((call) => call.id === 'messages.publish').length;

    // Unarmed: the lock as the engine's rule, Send closed with its reason and source, and no call.
    expect(strip(bed)?.getAttribute('data-lock')).toBe('locked');
    expect(squash(strip(bed)?.textContent)).toContain(
      'Locked. Changes that name this connection need an unlock first.',
    );
    expect(sendButton(bed).getAttribute('aria-disabled')).toBe('true');
    const reason = squash(bed.el.querySelector('.send .reason')?.textContent);
    expect(reason).toContain(
      'This connection is locked. Unlock it to send messages for 15 minutes.',
    );
    expect(reason).toContain('Source: prod-lock');
    sendButton(bed).click();
    await settle(bed.harness);
    expect(publishCalls()).toBe(0);

    // The unlock asks first, names the connection, and Cancel changes nothing.
    stripButton(bed).click();
    await settle(bed.harness);
    expect(squash(bed.el.querySelector('app-dialog h2')?.textContent)).toBe(
      'Unlock Production?',
    );
    expect(
      squash(bed.el.querySelector('app-dialog .body')?.textContent),
    ).toContain('The unlock is recorded in the audit log.');
    bed.el.querySelector<HTMLButtonElement>('app-dialog .secondary')?.click();
    await settle(bed.harness);
    expect(bed.el.querySelector('app-dialog')).toBeNull();
    expect(bed.api.calls.some((call) => call.id === 'ops.arm')).toBe(false);
    expect(sendButton(bed).getAttribute('aria-disabled')).toBe('true');

    // Confirm: one `ops.arm` for this connection, then the strip says so and Send is open.
    stripButton(bed).click();
    await settle(bed.harness);
    bed.el.querySelector<HTMLButtonElement>('app-dialog .primary')?.click();
    await until(
      bed,
      () => strip(bed)?.getAttribute('data-lock') === 'armed',
      'the armed strip',
    );
    expect(
      bed.api.calls
        .filter((call) => call.id === 'ops.arm')
        .map((call) => call.kind === 'call' && call.input),
    ).toEqual([{ connectionId: 'c1' }]);
    expect(squash(strip(bed)?.textContent)).toContain('Unlocked until');
    expect(sendButton(bed).hasAttribute('aria-disabled')).toBe(false);

    // Armed, and the engine still refuses with its rule: shown as a Problem, with the hint.
    sendButton(bed).click();
    await until(
      bed,
      () => bed.el.querySelector('app-problem-alert') !== null,
      'the Problem',
    );
    expect(
      squash(bed.el.querySelector('app-problem-alert')?.textContent),
    ).toContain('GATE_BLOCKED');
    expect(
      squash(
        bed.el.querySelector('app-problem-alert [data-hint]')?.textContent,
      ),
    ).toContain('The engine refused because a rule is in the way.');
    expect(publishCalls()).toBe(1); // the plan; nothing was executed
  });

  it('fails closed on a connection whose class is not known, and shows no lock for an open one', async () => {
    const unknown = await mount('/c/c1/publish', {
      seed: withDraft(VALID),
      engine: { profiles: [] },
    });
    await until(unknown, () => strip(unknown) !== null, 'the lock strip');
    expect(strip(unknown)?.getAttribute('data-lock')).toBe('locked');
    expect(sendButton(unknown).getAttribute('aria-disabled')).toBe('true');

    const open = await mount('/c/c1/publish', { seed: withDraft(VALID) });
    await until(
      open,
      () => sendButton(open).getAttribute('aria-disabled') === null,
      'Send open',
    );
    expect(open.el.querySelector('app-lock-strip [data-lock]')).toBeNull();
  });

  it('offers the unlock when the engine refused with the lock and named it as the fix', async () => {
    const bed = await mount('/c/c1/publish', {
      seed: withDraft(VALID),
      engine: {
        plan: () =>
          throwError(() =>
            refusal({
              gate: {
                enabled: false,
                reason: 'Locked until armed',
                source: 'prod-lock',
                fix: {
                  actionId: 'ops.arm' as never,
                  input: { connectionId: 'c1' },
                },
              },
            }),
          ),
      },
    });
    await until(
      bed,
      () => sendButton(bed).getAttribute('aria-disabled') === null,
      'Send open',
    );
    sendButton(bed).click();
    await until(
      bed,
      () => bed.el.querySelector('app-problem-alert') !== null,
      'the Problem',
    );
    expect(
      squash(bed.el.querySelector('app-problem-alert')?.textContent),
    ).toContain('Locked until armed');
    const unlock = [
      ...bed.el.querySelectorAll<HTMLButtonElement>('.after button'),
    ].find((button) => squash(button.textContent) === 'Unlock this connection');
    if (unlock === undefined) throw new Error('no unlock offered');
    unlock.click();
    await settle(bed.harness);
    expect(squash(bed.el.querySelector('app-dialog h2')?.textContent)).toBe(
      'Unlock Broker c1?',
    );
    bed.el.querySelector<HTMLButtonElement>('app-dialog .primary')?.click();
    await until(
      bed,
      () => bed.el.querySelector('app-dialog') === null,
      'the dialog closed',
    );
    expect(bed.api.calls.filter((call) => call.id === 'ops.arm')).toHaveLength(
      1,
    );

    // A refusal without that fix offers nothing.
    const plain = await mount('/c/c1/publish', {
      seed: withDraft(VALID),
      engine: { plan: () => throwError(() => refusal()) },
    });
    await until(
      plain,
      () => sendButton(plain).getAttribute('aria-disabled') === null,
      'Send open',
    );
    sendButton(plain).click();
    await until(
      plain,
      () => plain.el.querySelector('app-problem-alert') !== null,
      'the Problem',
    );
    expect(
      [...plain.el.querySelectorAll('.after button')].map((button) =>
        squash(button.textContent),
      ),
    ).toEqual(['Clear']);
  });

  it('waits for the connection to be read before it says what the lock is, and keeps Send closed meanwhile', async () => {
    const list = new Subject<{ items: ReturnType<typeof profileFixture>[] }>();
    const bed = await mount('/c/c1/publish', {
      seed: withDraft(VALID),
      engine: { list: () => list },
    });
    expect(bed.el.querySelector('app-lock-strip')).toBeNull();
    expect(sendButton(bed).getAttribute('aria-disabled')).toBe('true');
    expect(
      squash(bed.el.querySelector('.send .reason')?.textContent),
    ).toContain('Reading the environment of this connection before sending.');
    list.next({ items: [profileFixture('c1', { envClass: 'prod' })] });
    list.complete();
    await until(bed, () => strip(bed) !== null, 'the lock strip');
    expect(strip(bed)?.getAttribute('data-lock')).toBe('locked');
  });
});
