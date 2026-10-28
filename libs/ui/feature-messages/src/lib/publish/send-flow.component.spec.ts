// The send flow as the person meets it: the studio page over a fake engine (M1-46 slice D). The router half of AC-27 and
// AC-31 is `libs/testkit/src/publish-ui/publish-calls.spec.ts`; the logic of the flow alone is `send-flow.spec.ts`.
import { TestBed } from '@angular/core/testing';
import { EngineProblemError } from '@app/ui-data';
import type { Problem } from '@app/contracts';
import { Subject, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { confirmedResult, FakeApi, openPlan } from './fake-api';
import { newRow } from './header-model';
import { profileFixture } from './profile-fixture';
import type { PublishResult } from './outcome-text';
import { leakedKeys, squash } from './spec-support';
import {
  mount,
  sendButton,
  settle,
  until,
  VALID,
  withDraft,
  type Bed,
} from './studio-bed';

const failure = (over: Partial<Problem> = {}): EngineProblemError =>
  new EngineProblemError({
    type: 'about:blank',
    title: 'Refused',
    status: 403,
    code: 'FORBIDDEN_BROKER',
    correlationId: 'x',
    retryable: false,
    ...over,
  });

const ready = (bed: Bed): Promise<void> =>
  until(
    bed,
    () => sendButton(bed).getAttribute('aria-disabled') === null,
    'Send is open',
  );

const text = (bed: Bed, selector: string): string =>
  squash(bed.el.querySelector(selector)?.textContent);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the send flow in the studio', () => {
  it('M1-46 AC-26 plans then executes once, with the button busy', async () => {
    const done = new Subject<{ output: PublishResult }>();
    const bed = await mount('/c/c1/publish', {
      seed: withDraft({
        ...VALID,
        body: { encoding: 'utf8', data: 'hello', language: 'plaintext' },
      }),
      engine: { plan: () => of(openPlan()), execute: () => done },
    });
    await ready(bed);
    expect(sendButton(bed).textContent.trim()).toBe('Send');

    sendButton(bed).click();
    sendButton(bed).click(); // twice, quickly
    await settle(bed.harness);

    const sent = bed.api.calls.filter((call) => call.id === 'messages.publish');
    expect(sent.map((call) => call.kind)).toEqual(['plan', 'execute']);
    expect(sent[0]).toMatchObject({
      input: {
        cid: 'c1',
        vhost: '/',
        exchange: '',
        routingKey: 'orders',
        body: { encoding: 'utf8', data: 'hello' },
        copies: 1,
        mandatory: true,
        confirm: true,
        timeoutMs: 5000,
      },
    });
    // Busy: the button says so, is closed, and gives its reason; no result yet.
    expect(sendButton(bed).textContent.trim()).toBe('Sending');
    expect(sendButton(bed).getAttribute('aria-disabled')).toBe('true');
    expect(text(bed, '.send .reason')).toContain(
      'A send is already in progress.',
    );
    expect(bed.el.querySelector('app-result-panel')).toBeNull();
    expect(text(bed, '[data-announce]')).toBe('Sending');

    done.next({ output: confirmedResult(2) });
    done.complete();
    await until(
      bed,
      () => bed.el.querySelector('app-result-panel') !== null,
      'the result panel',
    );
    expect(text(bed, 'app-result-panel .headline')).toBe(
      'The broker confirmed all 2 copies.',
    );
    expect(text(bed, '[data-announce]')).toBe(
      'The broker confirmed all 2 copies.',
    );
    expect(sendButton(bed).textContent.trim()).toBe('Send');
    expect(
      bed.api.calls.filter((c) => c.id === 'messages.publish'),
    ).toHaveLength(2);
    expect(leakedKeys(bed.el)).toEqual([]);

    // Clear removes the result.
    bed.el
      .querySelector<HTMLButtonElement>('app-result-panel ~ .after button')
      ?.click();
    await settle(bed.harness);
    expect(bed.el.querySelector('app-result-panel')).toBeNull();
  });

  it('keeps Send closed, with its reason, while the draft has something to fix, and makes no call', async () => {
    const bed = await mount('/c/c1/publish', {
      seed: withDraft({ ...VALID, copies: 101 }),
      engine: { plan: () => of(openPlan()) },
    });
    await until(
      bed,
      () => text(bed, '.send .reason').includes('to fix'),
      'the reason',
    );
    expect(sendButton(bed).getAttribute('aria-disabled')).toBe('true');
    expect(text(bed, '.send .reason')).toContain(
      '1 to fix before this can be sent.',
    );
    sendButton(bed).click();
    await settle(bed.harness);
    expect(bed.api.calls.map((call) => call.id)).toEqual(['connections.list']);
  });

  it('M1-46 AC-33 a failure before any outcome shows the Problem and keeps the form', async () => {
    const draft = {
      ...VALID,
      exchange: 'orders.x',
      routingKey: 'created',
      copies: 3,
    };
    const bed = await mount('/c/c1/publish', {
      seed: withDraft(draft),
      engine: {
        plan: () =>
          throwError(() =>
            failure({
              title: 'Forbidden on the broker',
              detail: 'No write permission on orders.x.',
              code: 'FORBIDDEN_BROKER',
            }),
          ),
      },
    });
    await ready(bed);
    const before = bed.store.draft('c1')();
    sendButton(bed).click();
    await until(
      bed,
      () => bed.el.querySelector('app-problem-alert') !== null,
      'the Problem',
    );
    const alert = text(bed, 'app-problem-alert');
    expect(alert).toContain('Forbidden on the broker');
    expect(alert).toContain('No write permission on orders.x.');
    expect(alert).toContain('FORBIDDEN_BROKER');
    expect(text(bed, 'app-problem-alert [data-hint]')).toBe(
      "The broker refused this connection's login for this exchange. Check the login of the connection and its permissions on the broker.",
    );
    expect(bed.el.querySelector('app-result-panel')).toBeNull();
    expect(bed.store.draft('c1')()).toBe(before); // the very same draft
    expect(bed.el.querySelector<HTMLInputElement>('#f-exchange')?.value).toBe(
      'orders.x',
    );
    expect(text(bed, '[data-announce]')).toContain('failure');
    expect(leakedKeys(bed.el)).toEqual([]);

    // The exchange does not exist: the engine says so when the plan runs.
    const missing = await mount('/c/c1/publish', {
      seed: withDraft({ ...VALID, exchange: 'nope' }),
      engine: {
        plan: () => of(openPlan()),
        execute: () =>
          throwError(() =>
            failure({ status: 404, code: 'NOT_FOUND', title: 'No exchange' }),
          ),
      },
    });
    await ready(missing);
    sendButton(missing).click();
    await until(
      missing,
      () => missing.el.querySelector('app-problem-alert') !== null,
      'the Problem',
    );
    expect(text(missing, 'app-problem-alert')).toContain('No exchange');
    expect(text(missing, 'app-problem-alert [data-hint]')).toContain(
      'did not find something the send needs',
    );
    expect(missing.el.querySelector('app-result-panel')).toBeNull();
    // A failed send is cleared by Clear, and does not block the next one.
    missing.el.querySelector<HTMLButtonElement>('.after button')?.click();
    await settle(missing.harness);
    expect(missing.el.querySelector('app-problem-alert')).toBeNull();
  });

  it('M1-46 AC-31 page: says the engine cannot publish yet, claims nothing was sent, and keeps the draft', async () => {
    const bed = await mount('/c/c1/publish', {
      seed: withDraft({ ...VALID, copies: 2 }),
      engine: {
        // The engine has no plan route, then refuses the direct call because no publish connection is wired.
        plan: () =>
          throwError(() => failure({ status: 404, code: 'NOT_FOUND' })),
        call: () =>
          throwError(() =>
            failure({
              status: 412,
              code: 'CAPABILITY_MISSING',
              title: 'Capability missing',
              detail: 'A publish connection is not available in this build.',
            }),
          ),
      },
    });
    await ready(bed);
    sendButton(bed).click();
    await until(
      bed,
      () => bed.el.querySelector('app-problem-alert') !== null,
      'the Problem',
    );
    expect(text(bed, 'app-problem-alert')).toContain('Capability missing');
    expect(text(bed, 'app-problem-alert')).toContain(
      'A publish connection is not available in this build.',
    );
    expect(text(bed, 'app-problem-alert [data-hint]')).toBe(
      'This engine build cannot publish yet: no publish connection is wired. Nothing was sent and nothing was saved to the history.',
    );
    expect(bed.el.querySelector('app-result-panel')).toBeNull();
    expect(bed.el.textContent).not.toContain('confirmed');
    expect(bed.store.draft('c1')().copies).toBe(2);
    expect(
      bed.api.calls
        .filter((c) => c.id === 'messages.publish')
        .map((c) => c.kind),
    ).toEqual(['plan', 'call']);
  });

  it('opens the dialog for a plan that asks, sends the consents and the phrase typed, and shows the result', async () => {
    const bed = await mount('/c/c1/publish', {
      seed: withDraft(VALID),
      engine: {
        plan: () =>
          of(
            openPlan({
              id: 'p7',
              consentsRequired: ['consent.prod-publish'],
              confirmationPhrase: 'publish',
            }),
          ),
        execute: () => of({ output: confirmedResult() }),
      },
    });
    await ready(bed);
    sendButton(bed).click();
    await until(
      bed,
      () => bed.el.querySelector('app-plan-dialog [role="dialog"]') !== null,
      'the dialog',
    );
    expect(bed.api.calls.some((call) => call.kind === 'execute')).toBe(false);
    expect(sendButton(bed).getAttribute('aria-disabled')).toBe('true');

    const box = bed.el.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    box?.click();
    const phrase = bed.el.querySelector<HTMLInputElement>('#plan-phrase');
    if (phrase === null) throw new Error('no phrase');
    phrase.value = 'publish';
    phrase.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(bed.harness);
    bed.el.querySelector<HTMLButtonElement>('app-dialog .primary')?.click();
    await until(
      bed,
      () => bed.el.querySelector('app-result-panel') !== null,
      'the result',
    );
    expect(bed.el.querySelector('app-plan-dialog')).toBeNull();
    expect(bed.api.calls.at(-1)).toMatchObject({
      kind: 'execute',
      planId: 'p7',
      request: { consents: ['consent.prod-publish'], confirmation: 'publish' },
    });

    // Cancel closes the dialog and runs nothing.
    const again = await mount('/c/c1/publish', {
      seed: withDraft(VALID),
      engine: {
        plan: () => of(openPlan({ consentsRequired: ['consent.x'] })),
      },
    });
    await ready(again);
    sendButton(again).click();
    await until(
      again,
      () => again.el.querySelector('app-plan-dialog') !== null,
      'the dialog',
    );
    again.el.querySelector<HTMLButtonElement>('app-dialog .secondary')?.click();
    await settle(again.harness);
    expect(again.el.querySelector('app-plan-dialog')).toBeNull();
    expect(again.api.calls.some((call) => call.kind === 'execute')).toBe(false);
  });

  it('M1-46 AC-35 a typed secret leaves no trace in the page', async () => {
    const canary = 'canary-8d1f3b7a-secret';
    const logs = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'debug'),
    ];
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const href = window.location.href;
    const traces = (bed: Bed): string =>
      [
        window.location.href,
        document.title,
        // Everything a screen reader is told as it happens.
        ...[
          ...bed.el.querySelectorAll(
            '[aria-live], [role="status"], [role="alert"]',
          ),
        ].map((el) => el.textContent),
        ...[...bed.el.querySelectorAll('[aria-label], [title]')].flatMap(
          (el) => [el.getAttribute('aria-label'), el.getAttribute('title')],
        ),
        JSON.stringify(Object.entries(localStorage)),
        JSON.stringify(Object.entries(sessionStorage)),
        ...logs.flatMap((spy) => spy.mock.calls.flat().map(String)),
      ].join('\n');
    const seed = withDraft({
      ...VALID,
      props: { userId: canary },
      headers: [newRow('x-token', 'string', canary)],
      body: { encoding: 'utf8', data: canary, language: 'plaintext' },
    });

    // The dialog of a plan that asks: no header value, property or body in it.
    const asked = await mount('/c/c1/publish', {
      seed,
      engine: {
        plan: () =>
          of(
            openPlan({
              consentsRequired: ['consent.a'],
              // An engine that sent more than it should: the dialog reads only the fields it names.
              preview: {
                exchange: '',
                routingKey: 'orders',
                copies: 1,
                bodyBytes: 22,
                headerCount: 1,
                body: canary,
                headers: { 'x-token': canary },
              },
            }),
          ),
      },
    });
    await ready(asked);
    // The page itself shows what was typed, in its own boxes; it must not say it anywhere else.
    sendButton(asked).click();
    await until(
      asked,
      () => asked.el.querySelector('app-plan-dialog') !== null,
      'the dialog',
    );
    const dialog = squash(
      asked.el.querySelector('app-plan-dialog')?.textContent,
    );
    expect(dialog).not.toContain(canary);
    expect(dialog).toContain('22'); // the size is there, the value is not
    expect(traces(asked)).not.toContain(canary);

    // A failure, and a result.
    const failed = await mount('/c/c1/publish', {
      seed,
      engine: { plan: () => throwError(() => failure({ title: 'Refused' })) },
    });
    await ready(failed);
    sendButton(failed).click();
    await until(
      failed,
      () => failed.el.querySelector('app-problem-alert') !== null,
      'the Problem',
    );
    expect(
      squash(failed.el.querySelector('app-problem-alert')?.textContent),
    ).not.toContain(canary);
    expect(traces(failed)).not.toContain(canary);

    const done = await mount('/c/c1/publish', {
      seed,
      engine: {
        plan: () => of(openPlan()),
        execute: () => of({ output: confirmedResult(3) }),
      },
    });
    await ready(done);
    sendButton(done).click();
    await until(
      done,
      () => done.el.querySelector('app-result-panel') !== null,
      'the result',
    );
    expect(
      squash(done.el.querySelector('app-result-panel')?.textContent),
    ).not.toContain(canary);
    expect(traces(done)).not.toContain(canary);
    expect(setItem).not.toHaveBeenCalled();
    expect(window.location.href).toBe(href);
    // The canary went where it must, and only there: to the engine, in the plan request.
    expect(JSON.stringify(done.api.calls[1])).toContain(canary);
  });

  it('M1-46 AC-36 a send in flight is not repeated or shown as done', async () => {
    const late = new Subject<{ output: PublishResult }>();
    const api = new FakeApi({
      profiles: [profileFixture('c1')],
      plan: () => of(openPlan()),
      execute: () => late,
    });
    const publishCalls = (): number =>
      api.calls.filter((call) => call.id === 'messages.publish').length;
    const first = await mount('/c/c1/publish', { api, seed: withDraft(VALID) });
    await ready(first);
    sendButton(first).click();
    await settle(first.harness);
    expect(late.observed).toBe(true);
    expect(publishCalls()).toBe(2);

    // The page is left: the request in flight is cancelled.
    TestBed.resetTestingModule();
    expect(late.observed).toBe(false);

    // Opened again: nothing is sent again and no stale success is shown, also when the old answer arrives.
    const second = await mount('/c/c1/publish', {
      api,
      seed: withDraft(VALID),
    });
    await ready(second);
    expect(second.el.querySelector('app-result-panel')).toBeNull();
    expect(sendButton(second).textContent.trim()).toBe('Send');
    late.next({ output: confirmedResult() });
    await settle(second.harness);
    expect(second.el.querySelector('app-result-panel')).toBeNull();
    expect(text(second, '[data-announce]')).toBe('');
    expect(publishCalls()).toBe(2);
  });
});

describe('the result panel on the page', () => {
  it('shows a result for a send whose answer holds a return, not a success', async () => {
    const returned: PublishResult = {
      copies: [{ index: 0, outcome: 'returned', reason: 'NO_ROUTE' }],
      summary: {
        confirmed: 0,
        nacked: 0,
        returned: 1,
        blocked: 0,
        timeout: 0,
        failed: 0,
        'not-sent': 0,
      },
      allConfirmed: false,
      historyId: 'h1',
      historyRecorded: true,
    };
    const bed = await mount('/c/c1/publish', {
      seed: withDraft(VALID),
      engine: {
        plan: () => of(openPlan()),
        execute: () => of({ output: returned }),
      },
    });
    await ready(bed);
    sendButton(bed).click();
    await until(
      bed,
      () => bed.el.querySelector('app-result-panel') !== null,
      'the result',
    );
    expect(bed.el.querySelector('[data-state="all-confirmed"]')).toBeNull();
    expect(text(bed, '[data-outcome="returned"] .label')).toBe(
      'returned: NO_ROUTE',
    );
    expect(text(bed, 'app-result-panel .headline')).toBe(
      '0 of 1 copies confirmed by the broker. Read each copy below.',
    );
  });
});
