import { Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import type { ProblemView } from '../problem';
import { scopeProviders } from '../testing/scope';
import { ConfirmDialog } from './confirm-dialog.component';

@Component({
  selector: 'app-dialog-host',
  imports: [ConfirmDialog],
  template: `
    <button id="opener" type="button">{{ openerText }}</button>
    @if (open()) {
      <app-confirm-dialog
        heading="Delete Lab"
        confirmLabel="Delete"
        cancelLabel="Cancel"
        busyLabel="Deleting"
        [busy]="busy()"
        [danger]="true"
        [problem]="problem()"
        [extraLabel]="extraLabel()"
        (confirmed)="log.push('confirmed')"
        (cancelled)="log.push('cancelled')"
        (extra)="log.push('extra')"
      >
        <p id="body-text">{{ bodyText }}</p>
      </app-confirm-dialog>
    }
  `,
})
class Host {
  readonly open = signal(true);
  readonly busy = signal(false);
  readonly problem = signal<ProblemView | null>(null);
  readonly extraLabel = signal<string | null>(null);
  readonly log: string[] = [];
  protected readonly openerText = 'opener';
  protected readonly bodyText = 'The stored credentials are removed.';
}

async function mount(): Promise<{
  fixture: ComponentFixture<Host>;
  el: HTMLElement;
  host: Host;
}> {
  TestBed.configureTestingModule({ providers: scopeProviders() });
  const fixture = TestBed.createComponent(Host);
  const el = fixture.nativeElement as HTMLElement;
  document.body.append(el);
  // The opener has focus before the dialog exists, as a pressed button would.
  el.querySelector<HTMLElement>('#opener')?.focus();
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, el, host: fixture.componentInstance };
}

const buttons = (el: HTMLElement): HTMLButtonElement[] => [
  ...el.querySelectorAll<HTMLButtonElement>('.dialog button'),
];

function press(
  target: Element,
  key: string,
  options: KeyboardEventInit = {},
): boolean {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('the confirmation dialog', () => {
  it('AC-11 is a labelled, described modal dialog and puts focus on Cancel first', async () => {
    const { el } = await mount();
    const dialog = el.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    const label = el.querySelector(
      `#${dialog?.getAttribute('aria-labelledby') ?? 'none'}`,
    );
    expect(label?.textContent).toBe('Delete Lab');
    const body = el.querySelector(
      `#${dialog?.getAttribute('aria-describedby') ?? 'none'}`,
    );
    expect(body?.textContent).toContain('The stored credentials are removed.');
    expect(buttons(el).map((b) => b.textContent.trim())).toEqual([
      'Cancel',
      'Delete',
    ]);
    expect(document.activeElement).toBe(buttons(el)[0]);
  });

  it('AC-11 Escape cancels, a press of Cancel cancels, a press of Delete confirms', async () => {
    const { fixture, el, host } = await mount();
    expect(press(buttons(el)[0] as Element, 'Escape')).toBe(true);
    buttons(el)[0]?.click();
    buttons(el)[1]?.click();
    fixture.detectChanges();
    expect(host.log).toEqual(['cancelled', 'cancelled', 'confirmed']);
  });

  it('AC-11 keeps Tab inside the dialog in both directions', async () => {
    const { el } = await mount();
    const [cancel, confirm] = buttons(el);
    confirm?.focus();
    expect(press(confirm as Element, 'Tab')).toBe(true);
    expect(document.activeElement).toBe(cancel);
    expect(press(cancel as Element, 'Tab', { shiftKey: true })).toBe(true);
    expect(document.activeElement).toBe(confirm);
    // Tab from the first control, not the last, is left to the browser.
    cancel?.focus();
    expect(press(cancel as Element, 'Tab')).toBe(false);
  });

  it('AC-11 gives focus back to the control that opened it when it closes', async () => {
    const { fixture, el, host } = await mount();
    expect(document.activeElement).toBe(buttons(el)[0]);
    host.open.set(false);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(el.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(el.querySelector('#opener'));
  });

  it('AC-11 while a call runs nothing can be pressed again, Escape does nothing and the label says so', async () => {
    const { fixture, el, host } = await mount();
    host.busy.set(true);
    fixture.detectChanges();
    const [cancel, confirm] = buttons(el);
    expect(confirm?.textContent.trim()).toBe('Deleting');
    expect(confirm?.getAttribute('aria-disabled')).toBe('true');
    expect(cancel?.getAttribute('aria-disabled')).toBe('true');
    confirm?.click();
    cancel?.click();
    press(cancel as Element, 'Escape');
    expect(host.log).toEqual([]);
  });

  it('AC-8 shows the failure as sent, as text, in an alert, with the gate reason, the source and the code, and an extra button', async () => {
    const { fixture, el, host } = await mount();
    host.problem.set({
      title: 'The delete is blocked',
      detail: 'Arm it. <img src=x onerror=alert(1)>',
      code: 'GATE_BLOCKED',
      gate: {
        reason: 'This is a production connection and it is locked.',
        source: 'prod-lock',
        fixAction: 'ops.arm',
        fixConnection: 'c1',
      },
    });
    host.extraLabel.set('Unlock this connection');
    // The alert is drawn once the scope's words have loaded.
    await vi.waitFor(() => {
      fixture.detectChanges();
      if (el.querySelector('[role="alert"]') === null) throw new Error('wait');
    });
    const alert = el.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('The delete is blocked');
    expect(alert?.textContent).toContain(
      'Arm it. <img src=x onerror=alert(1)>',
    );
    expect(alert?.querySelector('img')).toBeNull();
    expect(alert?.textContent).toContain(
      'This is a production connection and it is locked.',
    );
    expect(alert?.textContent).toContain('prod-lock');
    expect(alert?.querySelector('code')?.textContent).toBe('GATE_BLOCKED');
    expect(buttons(el).map((b) => b.textContent.trim())).toEqual([
      'Cancel',
      'Unlock this connection',
      'Delete',
    ]);
    buttons(el)[1]?.click();
    expect(host.log).toEqual(['extra']);
  });
});
