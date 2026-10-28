import { Component, signal } from '@angular/core';
import type { EnginePlan } from '@app/ui-data';
import { describe, expect, it } from 'vitest';

import { openPlan } from './fake-api';
import { provideMessagesScope } from '../messages-scope';
import {
  PlanDialog,
  previewView,
  type PlanAnswer,
} from './plan-dialog.component';
import type { ProblemView } from './problem';
import { leakedKeys, squash } from './spec-support';
import { mountHost } from './studio-bed';

@Component({
  imports: [PlanDialog],
  providers: [provideMessagesScope()],
  template: `<app-plan-dialog
    [plan]="plan()"
    [busy]="busy()"
    [problem]="problem()"
    (confirmed)="answers.push($event)"
    (cancelled)="cancels = cancels + 1"
  />`,
})
class Host {
  readonly plan = signal<EnginePlan>(openPlan());
  readonly busy = signal(false);
  readonly problem = signal<ProblemView | null>(null);
  readonly answers: PlanAnswer[] = [];
  cancels = 0;
}

const wording = (el: HTMLElement) => squash(el.textContent);
const execute = (el: HTMLElement): HTMLButtonElement => {
  const button = el.querySelector<HTMLButtonElement>('.primary');
  if (button === null) throw new Error('no Execute');
  return button;
};

async function refresh(fixture: {
  detectChanges(): void;
  whenStable(): Promise<unknown>;
}): Promise<void> {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

describe('<app-plan-dialog>', () => {
  it("M1-46 AC-30 renders the plan's gates, consents and phrase and executes only what it allows", async () => {
    const fixture = await mountHost(Host);
    const host = fixture.componentInstance;
    const el = fixture.nativeElement as HTMLElement;

    // The preview: target and size, never a value; a missing field reads "not reported".
    host.plan.set(
      openPlan({
        consentsRequired: ['consent.prod-publish', 'consent.cost'],
        confirmationPhrase: 'publish orders',
        gates: [
          {
            id: 'g-info',
            blocking: false,
            reason: 'Only a note',
          },
        ],
        warnings: [
          {
            id: 'W-9',
            severity: 'warn',
            textKey: 'warn.prod',
            textVersion: 1,
          },
        ],
      }),
    );
    await refresh(fixture);
    expect(
      el.querySelector('[role="dialog"]')?.getAttribute('aria-modal'),
    ).toBe('true');
    expect(squash(el.querySelector('h2')?.textContent)).toBe(
      'Send this message?',
    );
    const field = (name: string): string =>
      squash(el.querySelector(`[data-field="${name}"]`)?.textContent);
    expect(field('exchange')).toBe('(default exchange)');
    expect(field('routingKey')).toBe('orders');
    expect(field('copies')).toBe('1');
    expect(field('bodyBytes')).toBe('5');
    expect(field('headerCount')).toBe('0');
    // A gate that does not block is not listed; a warning is, as sent.
    expect(el.querySelector('[data-needs="gates"]')).toBeNull();
    expect(wording(el)).not.toContain('Only a note');
    expect(
      squash(el.querySelector('[data-needs="warnings"] h3')?.textContent),
    ).toBe('Warnings');
    expect(
      squash(el.querySelector('[data-needs="warnings"] li')?.textContent),
    ).toBe('warn W-9');

    // Closed until every consent is given and the phrase is typed exactly.
    const boxes = [
      ...el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ];
    expect(boxes).toHaveLength(2);
    expect(
      [...el.querySelectorAll('.consent code')].map((c) => c.textContent),
    ).toEqual(['consent.prod-publish', 'consent.cost']);
    expect(execute(el).getAttribute('aria-disabled')).toBe('true');
    expect(el.querySelector('[data-closed]')).not.toBeNull();
    execute(el).click();
    expect(host.answers).toEqual([]);

    boxes[0]?.click();
    boxes[1]?.click();
    await refresh(fixture);
    expect(execute(el).getAttribute('aria-disabled')).toBe('true'); // the phrase is still missing
    const phrase = el.querySelector<HTMLInputElement>('#plan-phrase');
    if (phrase === null) throw new Error('no phrase');
    expect(wording(el)).toContain('Type publish orders to confirm');
    phrase.value = 'publish order';
    phrase.dispatchEvent(new Event('input', { bubbles: true }));
    await refresh(fixture);
    expect(execute(el).getAttribute('aria-disabled')).toBe('true'); // not exactly
    phrase.value = 'publish orders';
    phrase.dispatchEvent(new Event('input', { bubbles: true }));
    await refresh(fixture);
    expect(execute(el).hasAttribute('aria-disabled')).toBe(false);
    expect(el.querySelector('[data-closed]')).toBeNull();

    // Untick one consent: closed again; tick it: open, and the answer carries what was given.
    boxes[1]?.click();
    await refresh(fixture);
    expect(execute(el).getAttribute('aria-disabled')).toBe('true');
    boxes[1]?.click();
    await refresh(fixture);
    execute(el).click();
    expect(host.answers).toEqual([
      {
        consents: ['consent.prod-publish', 'consent.cost'],
        confirmation: 'publish orders',
      },
    ]);

    // A blocking gate: shown with its reason, source and fix, and Execute never opens, whatever else is given.
    host.plan.set(
      openPlan({
        gates: [
          {
            id: 'g1',
            blocking: true,
            reason: 'Production is locked',
            source: 'prod-lock',
            fix: {
              actionId: 'ops.arm' as never,
              input: { connectionId: 'c1' },
            },
          },
          { id: 'g2', blocking: true, reason: '' },
        ],
      }),
    );
    await refresh(fixture);
    const gates = squash(el.querySelector('[data-needs="gates"]')?.textContent);
    expect(gates).toContain('Blocked by');
    expect(gates).toContain('Production is locked');
    expect(gates).toContain('Source: prod-lock');
    expect(gates).toContain('Fixed by: ops.arm');
    expect(gates).toContain('The engine gave no reason.');
    expect(execute(el).getAttribute('aria-disabled')).toBe('true');
    execute(el).click();
    expect(host.answers).toHaveLength(1);

    // Approvals still missing: said, and Execute stays closed; once granted it opens.
    host.plan.set(
      openPlan({
        approvals: {
          required: 2,
          granted: [{ by: 'a', at: 1, decision: 'approve' }],
        },
      }),
    );
    await refresh(fixture);
    expect(
      squash(el.querySelector('[data-needs="approvals"]')?.textContent),
    ).toBe('Approvals still needed: 1. This page cannot grant them.');
    expect(execute(el).getAttribute('aria-disabled')).toBe('true');
    host.plan.set(
      openPlan({
        approvals: {
          required: 1,
          granted: [{ by: 'a', at: 1, decision: 'approve' }],
        },
      }),
    );
    await refresh(fixture);
    expect(el.querySelector('[data-needs="approvals"]')).toBeNull();
    expect(execute(el).hasAttribute('aria-disabled')).toBe(false);
    execute(el).click();
    expect(host.answers.at(-1)).toEqual({
      consents: [],
      confirmation: undefined,
    });
    expect(leakedKeys(el)).toEqual([]);
  });

  it('shows no value of the message: a preview with more than the plan names is read for its named fields only', async () => {
    const canary = 'canary-2c9e7f41';
    const fixture = await mountHost(Host);
    fixture.componentInstance.plan.set(
      openPlan({
        preview: {
          exchange: 'orders',
          routingKey: 'a.b',
          copies: 3,
          bodyBytes: 1024,
          headerCount: 2,
          body: canary,
          headers: { token: canary },
        },
      }),
    );
    await refresh(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(wording(el)).not.toContain(canary);
    expect(
      squash(el.querySelector('[data-field="exchange"]')?.textContent),
    ).toBe('orders');
    expect(
      squash(el.querySelector('[data-field="bodyBytes"]')?.textContent),
    ).toBe('1024');
    // A preview the engine did not send reads "not reported", never blank or zero.
    fixture.componentInstance.plan.set(openPlan({ preview: null }));
    await refresh(fixture);
    for (const name of [
      'exchange',
      'routingKey',
      'copies',
      'bodyBytes',
      'headerCount',
    ]) {
      expect(
        squash(el.querySelector(`[data-field="${name}"]`)?.textContent),
        name,
      ).toBe('not reported');
    }
  });

  it('cancels with the button and with Escape, and does nothing while the execute is on its way', async () => {
    const fixture = await mountHost(Host);
    const host = fixture.componentInstance;
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('.secondary')?.click();
    expect(host.cancels).toBe(1);
    el.querySelector('[role="dialog"]')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(host.cancels).toBe(2);

    host.busy.set(true);
    await refresh(fixture);
    expect(squash(execute(el).textContent)).toBe('Sending');
    el.querySelector<HTMLButtonElement>('.secondary')?.click();
    execute(el).click();
    expect(host.cancels).toBe(2);
    expect(host.answers).toEqual([]);

    // A refusal of the execute stays in the dialog as the engine sent it.
    host.busy.set(false);
    host.problem.set({
      title: 'Phrase does not match',
      detail: null,
      code: 'CONFIRMATION_MISMATCH',
      gate: null,
    });
    await refresh(fixture);
    expect(
      squash(el.querySelector('app-problem-alert')?.textContent),
    ).toContain('Phrase does not match');
  });

  it('reads the preview field by field', () => {
    expect(
      previewView({
        exchange: '',
        routingKey: 'k',
        copies: 2,
        bodyBytes: 3,
        headerCount: 4,
      }),
    ).toEqual({
      exchange: '',
      routingKey: 'k',
      copies: 2,
      bodyBytes: 3,
      headerCount: 4,
    });
    expect(previewView('text')).toEqual({
      exchange: null,
      routingKey: null,
      copies: null,
      bodyBytes: null,
      headerCount: null,
    });
    expect(previewView({ exchange: 1, routingKey: 2, copies: '3' })).toEqual({
      exchange: null,
      routingKey: null,
      copies: null,
      bodyBytes: null,
      headerCount: null,
    });
  });

  it('shows a zero and an empty key as they are, lists nothing the plan does not ask for, and keeps the phrase box plain', async () => {
    const fixture = await mountHost(Host);
    const el = fixture.nativeElement as HTMLElement;
    fixture.componentInstance.plan.set(
      openPlan({
        preview: {
          exchange: 'fanout.x',
          routingKey: '',
          copies: 0,
          bodyBytes: 0,
          headerCount: 0,
        },
      }),
    );
    await refresh(fixture);
    const field = (name: string): string =>
      squash(el.querySelector(`[data-field="${name}"]`)?.textContent);
    expect(field('routingKey')).toBe('');
    expect(field('copies')).toBe('0');
    expect(field('bodyBytes')).toBe('0');
    expect(field('headerCount')).toBe('0');
    expect(el.querySelector('[data-needs]')).toBeNull();
    expect(el.querySelector('fieldset')).toBeNull();
    expect(el.querySelector('[data-closed]')).toBeNull();
    expect(execute(el).hasAttribute('aria-disabled')).toBe(false);

    fixture.componentInstance.plan.set(openPlan({ confirmationPhrase: 'go' }));
    await refresh(fixture);
    const phrase = el.querySelector<HTMLInputElement>('#plan-phrase');
    expect(phrase?.getAttribute('spellcheck')).toBe('false');
    expect(phrase?.getAttribute('autocomplete')).toBe('off');
    expect(phrase?.getAttribute('autocapitalize')).toBe('off');
    expect(el.querySelector('label[for="plan-phrase"]')?.textContent).toContain(
      'Type go to confirm',
    );
  });
});
