// The words of an outcome (R5, DC-15, I-13). One copy, one outcome, one text: `confirmed` is the broker's confirm and
// nothing more, `returned` keeps the broker's reply code, `timeout` says the broker may still have routed it. The
// engine's `reason` is shown as sent (the contract bounds it to a reply code, an error code or a short fixed text).
// The keys are literals so a source check can see every one.
import type { CopyOutcome, OutputOf, messagesPublish } from '@app/contracts';

import type { Translate } from '../translate';

/** The engine's answer to a publish: every copy once, the seven counts and whether all were confirmed. */
export type PublishResult = OutputOf<typeof messagesPublish>;

/** The outcomes in the order the summary shows them. */
export const OUTCOME_ORDER: readonly CopyOutcome[] = [
  'confirmed',
  'nacked',
  'returned',
  'blocked',
  'timeout',
  'failed',
  'not-sent',
];

const NAMES: Readonly<Record<CopyOutcome, string>> = {
  confirmed: 'publish.outcome.name.confirmed',
  nacked: 'publish.outcome.name.nacked',
  returned: 'publish.outcome.name.returned',
  blocked: 'publish.outcome.name.blocked',
  timeout: 'publish.outcome.name.timeout',
  failed: 'publish.outcome.name.failed',
  'not-sent': 'publish.outcome.name.notSent',
};

/** The short name of an outcome, for the summary. */
export function outcomeName(t: Translate, outcome: CopyOutcome): string {
  return t(NAMES[outcome]);
}

export interface CopyText {
  /** What the copy row leads with; for `returned` and `failed` it carries the code as sent. */
  readonly label: string;
  /** One sentence on what the outcome means and what it does not. */
  readonly explanation: string;
  /** The engine's short text, when the label does not already carry it. */
  readonly detail: string | null;
}

/** The text of one copy of the answer. */
export function copyText(
  t: Translate,
  copy: { readonly outcome: CopyOutcome; readonly reason?: string | undefined },
): CopyText {
  const reason =
    copy.reason === undefined || copy.reason === '' ? null : copy.reason;
  switch (copy.outcome) {
    case 'confirmed':
      return text(
        t,
        'publish.outcome.name.confirmed',
        'publish.outcome.explain.confirmed',
        reason,
      );
    case 'nacked':
      return text(
        t,
        'publish.outcome.name.nacked',
        'publish.outcome.explain.nacked',
        reason,
      );
    case 'blocked':
      return text(
        t,
        'publish.outcome.name.blocked',
        'publish.outcome.explain.blocked',
        reason,
      );
    case 'timeout':
      return text(
        t,
        'publish.outcome.name.timeout',
        'publish.outcome.explain.timeout',
        reason,
      );
    case 'not-sent':
      return text(
        t,
        'publish.outcome.name.notSent',
        'publish.outcome.explain.notSent',
        reason,
      );
    case 'returned':
      if (reason === null) {
        return {
          label: t('publish.outcome.name.returned'),
          explanation: t('publish.outcome.explain.returned'),
          detail: null,
        };
      }
      return {
        label: t('publish.outcome.returnedLabel', { reason }),
        explanation:
          reason === 'NO_ROUTE'
            ? t('publish.outcome.explain.noRoute')
            : t('publish.outcome.explain.returnedCode', { reason }),
        detail: null,
      };
    case 'failed':
      return {
        label:
          reason === null
            ? t('publish.outcome.name.failed')
            : t('publish.outcome.failedLabel', { reason }),
        explanation: t('publish.outcome.explain.failed'),
        detail: null,
      };
  }
}

function text(
  t: Translate,
  nameKey: string,
  explainKey: string,
  reason: string | null,
): CopyText {
  return {
    label: t(nameKey),
    explanation: t(explainKey),
    detail: reason === null ? null : t('publish.outcome.detail', { reason }),
  };
}
