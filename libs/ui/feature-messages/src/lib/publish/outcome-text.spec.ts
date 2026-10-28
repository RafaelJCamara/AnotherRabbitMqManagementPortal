import { COPY_OUTCOMES } from '@app/contracts';
import { describe, expect, it } from 'vitest';

import { copyText, OUTCOME_ORDER, outcomeName } from './outcome-text';
import { BANNED_WORDS, english, englishTexts } from './spec-support';

describe('outcome words', () => {
  it('M1-46 AC-29 outcome wording is honest', () => {
    // timeout: no confirm in time, and the broker may still have routed it.
    const timeout = copyText(english, { outcome: 'timeout' });
    expect(timeout.label).toBe('Timed out');
    expect(timeout.explanation).toBe(
      'No confirm arrived in time. The broker may still have routed this copy.',
    );
    // confirmed: the broker's confirm and nothing more; never delivered, never consumed.
    const confirmed = copyText(english, { outcome: 'confirmed' });
    expect(confirmed.label).toBe('Confirmed');
    expect(confirmed.explanation).toBe(
      'The broker confirmed this copy. What happens to it afterwards is not reported here.',
    );
    expect(`${confirmed.label} ${confirmed.explanation}`).not.toMatch(
      /deliver|consum|receiv|arriv/i,
    );
    // returned: the broker's reply code, as sent, and what it means.
    const returned = copyText(english, {
      outcome: 'returned',
      reason: 'NO_ROUTE',
    });
    expect(returned.label).toBe('returned: NO_ROUTE');
    expect(returned.explanation).toBe(
      'The broker found no queue for this exchange and routing key, and returned the message to the publisher. The broker did not keep it for this publish.',
    );
    // No sentence of the studio about a publish carries a word the honest-wording rule keeps out.
    for (const prefix of [
      'publish.outcome',
      'publish.result',
      'publish.hint',
      'publish.plan',
      'publish.send',
      'publish.lock',
    ]) {
      for (const [path, text] of englishTexts(prefix)) {
        expect(text, path).not.toMatch(BANNED_WORDS);
      }
    }
  });

  it('gives every outcome its own name, in the order the summary shows', () => {
    expect([...OUTCOME_ORDER].sort()).toEqual([...COPY_OUTCOMES].sort());
    expect(
      OUTCOME_ORDER.map((outcome) => outcomeName(english, outcome)),
    ).toEqual([
      'Confirmed',
      'Nacked',
      'Returned',
      'Blocked',
      'Timed out',
      'Failed',
      'Not sent',
    ]);
  });

  it('words each outcome apart and shows the engine text as sent', () => {
    expect(copyText(english, { outcome: 'nacked' })).toEqual({
      label: 'Nacked',
      explanation:
        'The broker refused this copy with a negative confirm. It was not accepted.',
      detail: null,
    });
    expect(copyText(english, { outcome: 'blocked' })).toEqual({
      label: 'Blocked',
      explanation:
        'The broker blocked the connection, so nothing was sent for this copy.',
      detail: null,
    });
    expect(copyText(english, { outcome: 'not-sent' })).toEqual({
      label: 'Not sent',
      explanation: 'The send stopped before this copy, so it was not sent.',
      detail: null,
    });
    // A short text from the engine is shown as sent; an empty one is no text.
    expect(
      copyText(english, { outcome: 'nacked', reason: 'broker refused' }).detail,
    ).toBe('Detail: broker refused');
    expect(copyText(english, { outcome: 'timeout', reason: '' }).detail).toBe(
      null,
    );
    expect(
      copyText(english, { outcome: 'blocked', reason: 'blocked' }).detail,
    ).toBe('Detail: blocked');
    expect(
      copyText(english, { outcome: 'not-sent', reason: 'stopped' }).detail,
    ).toBe('Detail: stopped');
    expect(
      copyText(english, { outcome: 'confirmed', reason: 'ok' }).detail,
    ).toBe('Detail: ok');
    expect(
      copyText(english, { outcome: 'timeout', reason: 'late' }).detail,
    ).toBe('Detail: late');
  });

  it('keeps the broker reply code of a return, and says when there is none or it is another one', () => {
    expect(copyText(english, { outcome: 'returned' })).toEqual({
      label: 'Returned',
      explanation: 'The broker returned this message to the publisher.',
      detail: null,
    });
    expect(copyText(english, { outcome: 'returned', reason: '' }).label).toBe(
      'Returned',
    );
    expect(
      copyText(english, { outcome: 'returned', reason: 'NO_CONSUMERS' }),
    ).toEqual({
      label: 'returned: NO_CONSUMERS',
      explanation:
        'The broker returned this message to the publisher (reply code NO_CONSUMERS).',
      detail: null,
    });
  });

  it('shows the contract error code of a copy that failed, and says so when it is not reported', () => {
    expect(
      copyText(english, { outcome: 'failed', reason: 'BROKER_UNREACHABLE' }),
    ).toEqual({
      label: 'failed: BROKER_UNREACHABLE',
      explanation:
        "This copy could not be sent. The code is the contract's error code.",
      detail: null,
    });
    expect(copyText(english, { outcome: 'failed' }).label).toBe('Failed');
  });
});
