import { Component, signal } from '@angular/core';
import { describe, expect, it } from 'vitest';

import { provideMessagesScope } from '../messages-scope';
import type { ProblemView } from './problem';
import { ProblemAlert } from './problem-alert.component';
import { leakedKeys, squash } from './spec-support';
import { mountHost } from './studio-bed';

@Component({
  imports: [ProblemAlert],
  providers: [provideMessagesScope()],
  template: `<app-problem-alert [problem]="problem()" />`,
})
class Host {
  readonly problem = signal<ProblemView>({
    title: 'Title',
    detail: null,
    code: null,
    gate: null,
  });
}

describe('<app-problem-alert>', () => {
  it('shows the engine Problem as sent, then a fixed hint chosen by its code', async () => {
    const fixture = await mountHost(Host);
    const el = fixture.nativeElement as HTMLElement;
    const show = async (problem: ProblemView): Promise<void> => {
      fixture.componentInstance.problem.set(problem);
      fixture.detectChanges();
      await fixture.whenStable();
    };

    expect(el.querySelector('[role="alert"]')).not.toBeNull();
    expect(squash(el.textContent)).toBe('Title');

    await show({
      title: 'Refused',
      detail: 'Because of a rule.',
      code: 'GATE_BLOCKED',
      gate: {
        reason: 'Locked',
        source: 'prod-lock',
        fixAction: 'ops.arm',
        fixConnection: 'c1',
      },
    });
    const text = squash(el.textContent);
    expect(text).toContain('Refused');
    expect(text).toContain('Because of a rule.');
    expect(text).toContain('Why: Locked Source: prod-lock');
    expect(text).toContain('Code: GATE_BLOCKED');
    expect(squash(el.querySelector('[data-hint]')?.textContent)).toContain(
      'The engine refused because a rule is in the way.',
    );

    // A gate with a reason and no source says no source; a gate with no reason says nothing of a gate.
    await show({
      title: 'Refused',
      detail: null,
      code: 'INTERNAL',
      gate: {
        reason: 'Locked',
        source: null,
        fixAction: null,
        fixConnection: null,
      },
    });
    expect(squash(el.textContent)).toContain('Why: Locked');
    expect(squash(el.textContent)).not.toContain('Source');
    expect(el.querySelector('[data-hint]')).toBeNull(); // no hint for a code it does not know
    await show({
      title: 'Refused',
      detail: null,
      code: 'INTERNAL',
      gate: {
        reason: null,
        source: 'prod-lock',
        fixAction: null,
        fixConnection: null,
      },
    });
    expect(squash(el.textContent)).not.toContain('Why');
    expect(squash(el.textContent)).not.toContain('prod-lock');

    // A failure with no title says that the request failed.
    await show({ title: '', detail: null, code: null, gate: null });
    expect(squash(el.textContent)).toBe('The request failed.');
    expect(leakedKeys(el)).toEqual([]);
  });
});
