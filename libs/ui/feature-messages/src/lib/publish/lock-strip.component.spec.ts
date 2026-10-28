import { Component, signal, viewChild } from '@angular/core';
import type { EnvClass, Problem } from '@app/contracts';
import { ARMING_CLOCK, EngineProblemError } from '@app/ui-data';
import { Subject, of, throwError } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { provideMessagesScope } from '../messages-scope';
import { FakeApi, provideFakeApi, type FakeApiHandlers } from './fake-api';
import { LockStrip } from './lock-strip.component';
import { squash } from './spec-support';
import { mountHost } from './studio-bed';

@Component({
  imports: [LockStrip],
  providers: [provideMessagesScope()],
  template: `<app-lock-strip
    [cid]="'c1'"
    name="Production"
    [envClass]="envClass()"
  />`,
})
class Host {
  readonly envClass = signal<EnvClass | null>('prod');
  readonly strip = viewChild.required(LockStrip);
}

const refused = (title: string): EngineProblemError =>
  new EngineProblemError({
    type: 'about:blank',
    title,
    status: 403,
    code: 'FORBIDDEN_RBAC',
    correlationId: 'x',
    retryable: false,
  } satisfies Problem);

async function open(handlers: FakeApiHandlers = {}) {
  const api = new FakeApi(handlers);
  const fixture = await mountHost(Host, [
    provideFakeApi(api),
    {
      provide: ARMING_CLOCK,
      useValue: { now: () => Date.now(), after: () => () => undefined },
    },
  ]);
  const el = fixture.nativeElement as HTMLElement;
  const settle = async (): Promise<void> => {
    for (let round = 0; round < 3; round++) {
      fixture.detectChanges();
      await fixture.whenStable();
      await Promise.resolve();
    }
  };
  const button = (): HTMLButtonElement => {
    const found = el.querySelector<HTMLButtonElement>('.lock button');
    if (found === null) throw new Error('no lock button');
    return found;
  };
  return { api, fixture, el, settle, button };
}

describe('<app-lock-strip>', () => {
  it('shows nothing for a connection the lock does not apply to, and the lock for one it does', async () => {
    const bed = await open();
    expect(bed.el.querySelector('[data-lock="locked"]')).not.toBeNull();
    expect(bed.el.querySelector('.lock')?.getAttribute('aria-label')).toBe(
      'Lock of this connection',
    );
    for (const env of ['dev', 'local', 'test', 'staging'] as const) {
      bed.fixture.componentInstance.envClass.set(env);
      await bed.settle();
      expect(bed.el.querySelector('.lock'), env).toBeNull();
    }
    // Not known reads as production.
    bed.fixture.componentInstance.envClass.set(null);
    await bed.settle();
    expect(bed.el.querySelector('[data-lock="locked"]')).not.toBeNull();
  });

  it("asks before it unlocks, keeps the dialog open with the engine's refusal, and clears it on a new try", async () => {
    let attempt = 0;
    const bed = await open({
      arm: () => {
        attempt += 1;
        return attempt === 1
          ? throwError(() => refused('Not allowed to unlock'))
          : of({ armedAt: Date.now(), expiresAt: Date.now() + 900_000 });
      },
    });
    bed.button().click();
    await bed.settle();
    bed.el.querySelector<HTMLButtonElement>('app-dialog .primary')?.click();
    await bed.settle();
    expect(
      squash(bed.el.querySelector('app-dialog app-problem-alert')?.textContent),
    ).toContain('Not allowed to unlock');
    expect(bed.el.querySelector('[data-lock="locked"]')).not.toBeNull();

    // Cancel, open again: the old refusal is gone.
    bed.el.querySelector<HTMLButtonElement>('app-dialog .secondary')?.click();
    await bed.settle();
    expect(bed.el.querySelector('app-dialog')).toBeNull();
    bed.button().click();
    await bed.settle();
    expect(bed.el.querySelector('app-dialog app-problem-alert')).toBeNull();

    // The second try works: the dialog closes, the strip says so, and focus is on the control that is there now.
    bed.el.querySelector<HTMLButtonElement>('app-dialog .primary')?.click();
    await bed.settle();
    await bed.settle();
    expect(bed.el.querySelector('app-dialog')).toBeNull();
    expect(bed.el.querySelector('[data-lock="armed"]')).not.toBeNull();
    expect(squash(bed.button().textContent)).toBe('Lock again');
    expect(document.activeElement).toBe(bed.button());
  });

  it('is busy while the engine answers: the control says so and the dialog shows the busy words', async () => {
    const answer = new Subject<{ armedAt: number; expiresAt: number }>();
    const bed = await open({ arm: () => answer });
    expect(bed.button().hasAttribute('aria-disabled')).toBe(false);
    bed.button().click();
    await bed.settle();
    bed.el.querySelector<HTMLButtonElement>('app-dialog .primary')?.click();
    await bed.settle();
    expect(bed.button().getAttribute('aria-disabled')).toBe('true');
    expect(
      squash(bed.el.querySelector('app-dialog .primary')?.textContent),
    ).toBe('Unlocking');
    answer.next({ armedAt: Date.now(), expiresAt: Date.now() + 900_000 });
    answer.complete();
    await bed.settle();
    expect(bed.button().hasAttribute('aria-disabled')).toBe(false);
  });

  it('locks again, shows a refusal of that, and moves focus to the control that is there afterwards', async () => {
    let attempt = 0;
    const held = new Subject<{ wasArmed: boolean }>();
    const bed = await open({
      disarm: () => {
        attempt += 1;
        return attempt === 1 ? held : of({ wasArmed: true });
      },
    });
    bed.button().click();
    await bed.settle();
    bed.el.querySelector<HTMLButtonElement>('app-dialog .primary')?.click();
    await bed.settle();
    await bed.settle();
    expect(bed.el.querySelector('[data-lock="armed"]')).not.toBeNull();

    bed.button().click(); // Lock again: on its way
    await bed.settle();
    expect(bed.button().getAttribute('aria-disabled')).toBe('true');
    held.error(refused('Cannot lock')); // refused
    await bed.settle();
    expect(bed.button().hasAttribute('aria-disabled')).toBe(false);
    expect(
      squash(bed.el.querySelector('app-problem-alert')?.textContent),
    ).toContain('Cannot lock');
    expect(bed.el.querySelector('[data-lock="armed"]')).not.toBeNull();

    bed.button().click(); // and again: it works, and the old refusal goes
    await bed.settle();
    await bed.settle();
    expect(bed.el.querySelector('app-problem-alert')).toBeNull();
    expect(bed.el.querySelector('[data-lock="locked"]')).not.toBeNull();
    expect(squash(bed.button().textContent)).toBe('Unlock…');
    expect(document.activeElement).toBe(bed.button());
  });

  it('can be opened by the page when the engine named the unlock as the fix, also with no strip shown', async () => {
    const bed = await open();
    bed.fixture.componentInstance.envClass.set('dev');
    await bed.settle();
    expect(bed.el.querySelector('.lock')).toBeNull();
    bed.fixture.componentInstance.strip().open();
    await bed.settle();
    expect(squash(bed.el.querySelector('app-dialog h2')?.textContent)).toBe(
      'Unlock Production?',
    );
  });
});
