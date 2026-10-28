import { Component, signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import { provideMessagesScope } from '../messages-scope';
import { Dialog } from './dialog.component';
import type { ProblemView } from './problem';
import { squash } from './spec-support';
import { mountHost } from './studio-bed';

@Component({
  imports: [Dialog],
  providers: [provideMessagesScope()],
  template: `
    <button id="opener" type="button">{{ text }}</button>
    @if (open()) {
      <app-dialog
        heading="Heading"
        confirmLabel="Go"
        cancelLabel="Stop"
        busyLabel="Going"
        [busy]="busy()"
        [confirmClosed]="closed()"
        [problem]="problem()"
        (confirmed)="confirmed = confirmed + 1"
        (cancelled)="cancelled = cancelled + 1"
      >
        <p id="body">{{ text }}</p>
        <input id="inner" type="text" />
      </app-dialog>
    }
  `,
})
class Host {
  readonly text = 'Body text';
  readonly open = signal(true);
  readonly busy = signal(false);
  readonly closed = signal(false);
  readonly problem = signal<ProblemView | null>(null);
  confirmed = 0;
  cancelled = 0;
}

const settle = async (fixture: {
  detectChanges(): void;
  whenStable(): Promise<unknown>;
}): Promise<void> => {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
};

const dialogOf = (el: Element): HTMLElement => {
  const found = el.querySelector<HTMLElement>('[role="dialog"]');
  if (found === null) throw new Error('no dialog');
  return found;
};

const key = (el: Element, name: string, shift = false): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', {
    key: name,
    shiftKey: shift,
    bubbles: true,
    cancelable: true,
  });
  el.dispatchEvent(event);
  return event;
};

describe('<app-dialog>', () => {
  it('is a labelled modal that puts Cancel first and gives focus back to what opened it', async () => {
    const fixture = await mountHost(Host);
    const host = fixture.componentInstance;
    const el = fixture.nativeElement as HTMLElement;
    const opener = el.querySelector<HTMLButtonElement>('#opener');
    host.open.set(false);
    await settle(fixture);
    opener?.focus();
    host.open.set(true);
    await settle(fixture);
    await settle(fixture);

    const dialog = el.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    const title = el.querySelector('h2');
    expect(dialog?.getAttribute('aria-labelledby')).toBe(title?.id);
    expect(squash(title?.textContent)).toBe('Heading');
    expect(dialog?.getAttribute('aria-describedby')).toBe(
      el.querySelector('.body')?.id,
    );
    expect(squash(el.querySelector('.body')?.textContent)).toBe('Body text');
    expect(document.activeElement).toBe(el.querySelector('.secondary'));
    expect(squash(el.querySelector('.secondary')?.textContent)).toBe('Stop');
    expect(squash(el.querySelector('.primary')?.textContent)).toBe('Go');

    host.open.set(false);
    await settle(fixture);
    expect(document.activeElement).toBe(opener);
  });

  it('confirms and cancels, and does neither while a call is on its way or while confirm is held closed', async () => {
    const fixture = await mountHost(Host);
    const host = fixture.componentInstance;
    const el = fixture.nativeElement as HTMLElement;
    const confirm = el.querySelector<HTMLButtonElement>('.primary');
    const cancel = el.querySelector<HTMLButtonElement>('.secondary');
    expect(confirm?.hasAttribute('aria-disabled')).toBe(false);
    expect(cancel?.hasAttribute('aria-disabled')).toBe(false);
    confirm?.click();
    cancel?.click();
    expect([host.confirmed, host.cancelled]).toEqual([1, 1]);

    // Held closed: focusable, said to be disabled, and nothing is emitted.
    host.closed.set(true);
    await settle(fixture);
    expect(confirm?.getAttribute('aria-disabled')).toBe('true');
    expect(cancel?.hasAttribute('aria-disabled')).toBe(false);
    confirm?.click();
    expect(host.confirmed).toBe(1);

    // Busy: both are disabled, the confirm button shows the busy words, Escape does nothing.
    host.closed.set(false);
    host.busy.set(true);
    await settle(fixture);
    expect(confirm?.getAttribute('aria-disabled')).toBe('true');
    expect(cancel?.getAttribute('aria-disabled')).toBe('true');
    expect(squash(confirm?.textContent)).toBe('Going');
    confirm?.click();
    cancel?.click();
    key(dialogOf(el), 'Escape');
    expect([host.confirmed, host.cancelled]).toEqual([1, 1]);

    host.busy.set(false);
    await settle(fixture);
    expect(squash(confirm?.textContent)).toBe('Go');
    const escape = key(dialogOf(el), 'Escape');
    expect(escape.defaultPrevented).toBe(true);
    expect(host.cancelled).toBe(2);
    // A failure of the call is shown as sent.
    host.problem.set({
      title: 'Refused',
      detail: null,
      code: 'FORBIDDEN_RBAC',
      gate: null,
    });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(
        squash(el.querySelector('app-problem-alert')?.textContent),
      ).toContain('Refused');
    });
  });

  it('keeps Tab inside the dialog, wrapping at both ends and pulling focus back from outside', async () => {
    const fixture = await mountHost(Host);
    const el = fixture.nativeElement as HTMLElement;
    const panel = dialogOf(el);
    const cancel = el.querySelector<HTMLButtonElement>('.secondary');
    const confirm = el.querySelector<HTMLButtonElement>('.primary');
    const inner = el.querySelector<HTMLInputElement>('#inner');

    // The Tab order is the body's input, Cancel, then Go.
    confirm?.focus();
    expect(key(panel, 'Tab').defaultPrevented).toBe(true); // last -> first
    expect(document.activeElement).toBe(inner);
    cancel?.focus();
    expect(key(panel, 'Tab').defaultPrevented).toBe(false); // in the middle: the browser moves it
    inner?.focus();
    expect(key(panel, 'Tab', true).defaultPrevented).toBe(true); // first, backwards -> last
    expect(document.activeElement).toBe(confirm);
    cancel?.focus();
    expect(key(panel, 'Tab', true).defaultPrevented).toBe(false);
    confirm?.focus();
    expect(key(panel, 'Tab', true).defaultPrevented).toBe(false);

    // Focus that is somewhere else is pulled in.
    el.querySelector<HTMLButtonElement>('#opener')?.focus();
    expect(key(panel, 'Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(inner);
    // Other keys are left alone.
    expect(key(panel, 'a').defaultPrevented).toBe(false);
  });
});
