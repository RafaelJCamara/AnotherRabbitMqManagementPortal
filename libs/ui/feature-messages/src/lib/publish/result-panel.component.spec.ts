import { Component, signal } from '@angular/core';
import type { CopyOutcome } from '@app/contracts';
import { describe, expect, it } from 'vitest';

import { provideMessagesScope } from '../messages-scope';
import { OUTCOME_ORDER, type PublishResult } from './outcome-text';
import { ResultPanel } from './result-panel.component';
import { leakedKeys, squash } from './spec-support';
import { mountHost } from './studio-bed';

const ZERO = {
  confirmed: 0,
  nacked: 0,
  returned: 0,
  blocked: 0,
  timeout: 0,
  failed: 0,
  'not-sent': 0,
};

function resultOf(
  copies: readonly { outcome: CopyOutcome; reason?: string }[],
  over: Partial<PublishResult> = {},
): PublishResult {
  const summary = { ...ZERO };
  for (const copy of copies) summary[copy.outcome] += 1;
  return {
    copies: copies.map((copy, index) => ({ index, ...copy })),
    summary,
    allConfirmed: copies.every((copy) => copy.outcome === 'confirmed'),
    historyId: 'h1',
    historyRecorded: true,
    ...over,
  };
}

@Component({
  imports: [ResultPanel],
  providers: [provideMessagesScope()],
  template: `<app-result-panel [result]="result()" />`,
})
class Host {
  readonly result = signal<PublishResult>(resultOf([{ outcome: 'confirmed' }]));
}

const rows = (el: HTMLElement) =>
  [...el.querySelectorAll('ol.copies > li')].map((li) => ({
    outcome: li.getAttribute('data-outcome'),
    index: li.getAttribute('data-index'),
    text: [...li.querySelectorAll('p')]
      .map((p) => squash(p.textContent))
      .join(' '),
  }));

describe('<app-result-panel>', () => {
  it('M1-46 AC-28 distinguishes confirmed, nacked and returned and every other outcome', async () => {
    const fixture = await mountHost(Host);
    const el = fixture.nativeElement as HTMLElement;
    const show = async (result: PublishResult): Promise<void> => {
      fixture.componentInstance.result.set(result);
      fixture.detectChanges();
      await fixture.whenStable();
    };

    await show(
      resultOf([
        { outcome: 'confirmed' },
        { outcome: 'nacked' },
        { outcome: 'returned', reason: 'NO_ROUTE' },
      ]),
    );
    expect(rows(el)).toEqual([
      {
        outcome: 'confirmed',
        index: '0',
        text: 'Copy 1 Confirmed The broker confirmed this copy. What happens to it afterwards is not reported here.',
      },
      {
        outcome: 'nacked',
        index: '1',
        text: 'Copy 2 Nacked The broker refused this copy with a negative confirm. It was not accepted.',
      },
      {
        outcome: 'returned',
        index: '2',
        text: 'Copy 3 returned: NO_ROUTE The broker found no queue for this exchange and routing key, and returned the message to the publisher. The broker did not keep it for this publish.',
      },
    ]);
    // Not every copy is confirmed: no success state, and the headline counts what was.
    expect(el.querySelector('[data-state="all-confirmed"]')).toBeNull();
    expect(el.querySelector('[data-state="not-all"]')).not.toBeNull();
    expect(squash(el.querySelector('.headline')?.textContent)).toBe(
      '1 of 3 copies confirmed by the broker. Read each copy below.',
    );
    expect(el.textContent).not.toContain('confirmed all');

    // All seven outcomes: each under its own words, in order, with its own count.
    await show(
      resultOf([
        { outcome: 'confirmed' },
        { outcome: 'nacked', reason: 'refused' },
        { outcome: 'returned', reason: 'NO_ROUTE' },
        { outcome: 'blocked' },
        { outcome: 'timeout' },
        { outcome: 'failed', reason: 'BROKER_UNREACHABLE' },
        { outcome: 'not-sent' },
      ]),
    );
    expect(rows(el).map((row) => row.outcome)).toEqual([
      'confirmed',
      'nacked',
      'returned',
      'blocked',
      'timeout',
      'failed',
      'not-sent',
    ]);
    expect(rows(el).map((row) => row.index)).toEqual([
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
    ]);
    const labels = [...el.querySelectorAll('ol.copies .label')].map((label) =>
      squash(label.textContent),
    );
    expect(labels).toEqual([
      'Confirmed',
      'Nacked',
      'returned: NO_ROUTE',
      'Blocked',
      'Timed out',
      'failed: BROKER_UNREACHABLE',
      'Not sent',
    ]);
    expect(new Set(labels).size).toBe(7);
    expect(
      squash(el.querySelector('li[data-outcome="nacked"]')?.textContent),
    ).toContain('Detail: refused');
    expect(
      squash(el.querySelector('li[data-outcome="timeout"]')?.textContent),
    ).toContain('The broker may still have routed this copy.');
    // The seven counts, always all seven, in order.
    const summary = [...el.querySelectorAll('ul.summary li')].map((li) => [
      li.getAttribute('data-summary'),
      squash(li.textContent),
    ]);
    expect(summary).toEqual([
      ['confirmed', 'Confirmed: 1'],
      ['nacked', 'Nacked: 1'],
      ['returned', 'Returned: 1'],
      ['blocked', 'Blocked: 1'],
      ['timeout', 'Timed out: 1'],
      ['failed', 'Failed: 1'],
      ['not-sent', 'Not sent: 1'],
    ]);
    expect(summary.map(([name]) => name)).toEqual([...OUTCOME_ORDER]);
    expect(el.querySelector('ul.summary')?.getAttribute('aria-label')).toBe(
      'Outcomes by count',
    );
    expect(el.querySelector('ol.copies')?.getAttribute('aria-label')).toBe(
      'Outcome of each copy',
    );
    expect(leakedKeys(el)).toEqual([]);

    // N copies are N rows, also at the contract's most; counts of zero still show.
    await show(
      resultOf(
        Array.from({ length: 100 }, () => ({ outcome: 'confirmed' as const })),
      ),
    );
    expect(rows(el)).toHaveLength(100);
    expect(squash(el.querySelector('.headline')?.textContent)).toBe(
      'The broker confirmed all 100 copies.',
    );
    expect(
      el.querySelector('li[data-summary="nacked"]')?.textContent,
    ).toContain('0');

    // One copy, confirmed: the success line says so in the singular and names nothing beyond the broker's confirm.
    await show(resultOf([{ outcome: 'confirmed' }]));
    expect(el.querySelector('[data-state="all-confirmed"]')).not.toBeNull();
    expect(squash(el.querySelector('.headline')?.textContent)).toBe(
      'The broker confirmed the copy.',
    );
    expect(squash(el.querySelector('.note')?.textContent)).toBe(
      'A publish is a write: this page cannot take it back.',
    );
  });

  it('M1-46 AC-34 flags a publish that was not saved to the history', async () => {
    const fixture = await mountHost(Host);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-notice]')).toBeNull();

    fixture.componentInstance.result.set(
      resultOf([{ outcome: 'confirmed' }], {
        historyRecorded: false,
        historyId: undefined as never,
      }),
    );
    fixture.detectChanges();
    await fixture.whenStable();
    const notice = el.querySelector('[data-notice="history-not-recorded"]');
    expect(squash(notice?.textContent)).toBe(
      'The message was published, but this publish could not be saved to the history.',
    );
    // The publish still stands: the outcome is shown as it was.
    expect(el.querySelector('[data-state="all-confirmed"]')).not.toBeNull();
  });
});
