import type { Era } from '@app/domain-model';
import { semanticsRegistry } from '@app/semantics';
import { describe, expect, it } from 'vitest';

import { planPeek } from './plan.ts';
import { isRejection } from './rejections.ts';
import {
  classicQueue,
  factsOf,
  preflightOf,
  profileOf,
  queueOf,
  requestOf,
  type ProfileOptions,
} from './testing.ts';
import type { PeekRequest, PreflightQueue } from './types.ts';

/** The warning ids of the plan, or the rejection code when there is none. */
function warningsOf(
  era: Era,
  queue: PreflightQueue,
  options: { request?: Partial<PeekRequest>; profile?: ProfileOptions } = {},
): string[] {
  const result = planPeek(
    requestOf(options.request),
    factsOf(era, preflightOf(queue), {
      profile: profileOf(era, options.profile),
    }),
  );
  if (isRejection(result)) return [`rejected:${result.code}`];
  return result.warnings.map((w) => w.id);
}

const unlimited = (
  limitState: 'unset' | 'minus1',
  extra: Partial<PreflightQueue> = {},
): PreflightQueue =>
  queueOf({ deliveryLimit: { kind: 'unlimited' }, limitState, ...extra });

const read = (type: 'disabled' | 'all' | 'failed' | 'returned') =>
  ({ type }) as const;

describe('AC-15 warnings follow R10', () => {
  it('AC-15 always warns of the hold, the crash path and the redelivered flag', () => {
    for (const era of ['3.13', '4.0-4.2', '4.3'] as const) {
      expect(warningsOf(era, classicQueue())).toEqual([
        'W-CRASH',
        'W-HOLD',
        'W-REDELIVERED',
      ]);
    }
  });

  it('AC-15 asks for the budget consent where a return is counted against the limit with the acquired count', () => {
    expect(warningsOf('4.0-4.2', queueOf())).toContain('W-BUDGET');
    expect(warningsOf('3.13', queueOf())).not.toContain('W-BUDGET');
    expect(
      warningsOf('4.3', queueOf({ delayedRetry: read('disabled') })),
    ).not.toContain('W-BUDGET');
  });

  it('AC-15 asks for the 3.13 consent where the delivery count itself is raised', () => {
    expect(warningsOf('3.13', queueOf())).toContain('W-313');
    expect(warningsOf('3.13', unlimited('unset'))).toContain('W-313');
    expect(warningsOf('4.0-4.2', queueOf())).not.toContain('W-313');
    expect(
      warningsOf('4.3', queueOf({ delayedRetry: read('disabled') })),
    ).not.toContain('W-313');
  });

  it('AC-15 warns of the tail where the cell puts the message at the back', () => {
    expect(warningsOf('3.13', unlimited('unset'))).toContain('W-TAIL');
    expect(warningsOf('4.0-4.2', unlimited('minus1'))).toContain('W-TAIL');
    expect(
      warningsOf(
        '4.3',
        unlimited('minus1', { delayedRetry: read('disabled') }),
      ),
    ).not.toContain('W-TAIL');
    expect(warningsOf('4.0-4.2', queueOf())).not.toContain('W-TAIL');
  });

  it('AC-15 asks for the delay consent where the cell delays the message, or when the type was not read', () => {
    for (const type of ['all', 'returned'] as const) {
      expect(
        warningsOf('4.3', queueOf({ delayedRetry: read(type) })),
        type,
      ).toContain('W-DELAY');
    }
    for (const type of ['failed', 'disabled'] as const) {
      expect(
        warningsOf('4.3', queueOf({ delayedRetry: read(type) })),
        type,
      ).not.toContain('W-DELAY');
    }
    // Not read on an era whose cells have the dimension: the delay is possible, so ask.
    expect(warningsOf('4.3', queueOf())).toContain('W-DELAY');
    // An era whose cells do not have the dimension ignores the type.
    expect(
      warningsOf('4.0-4.2', queueOf({ delayedRetry: read('all') })),
    ).not.toContain('W-DELAY');
  });

  it('AC-15 warns of a TTL and asks for consent near a drop-head limit', () => {
    expect(warningsOf('4.0-4.2', queueOf({ ttlMs: 60_000 }))).toContain(
      'W-TTL',
    );
    expect(warningsOf('4.0-4.2', queueOf())).not.toContain('W-TTL');
    const near = (extra: Partial<PreflightQueue>) =>
      queueOf({ overflow: 'drop-head', maxLength: 100, ...extra });
    // 70 ready + 20 peeked = 90 % of 100
    expect(warningsOf('4.0-4.2', near({ ready: 70 }))).toContain('W-DROPHEAD');
    expect(warningsOf('4.0-4.2', near({ ready: 69 }))).not.toContain(
      'W-DROPHEAD',
    );
    // An unread count is treated as a hit.
    expect(warningsOf('4.0-4.2', near({ ready: undefined }))).toContain(
      'W-DROPHEAD',
    );
    expect(
      warningsOf('4.0-4.2', near({ ready: 99, overflow: 'reject-publish' })),
    ).not.toContain('W-DROPHEAD');
    expect(
      warningsOf('4.0-4.2', queueOf({ overflow: 'drop-head', ready: 99 })),
    ).not.toContain('W-DROPHEAD');
  });

  it('AC-15 uses the clamped count, not the requested one, for the drop-head share', () => {
    const queue = queueOf({
      overflow: 'drop-head',
      maxLength: 1000,
      ready: 100,
    });
    // 100 ready + 50 (the cap) = 150, far from 900; a request of 900 would have been 1000.
    expect(
      warningsOf('4.0-4.2', queue, { request: { count: 900 } }),
    ).not.toContain('W-DROPHEAD');
  });

  it('AC-15 knows single active consumer queues', () => {
    expect(
      warningsOf('4.3', classicQueue({ singleActiveConsumer: true })),
    ).toContain('W-SAC-CQ');
    const quorumSac = queueOf({
      singleActiveConsumer: true,
      delayedRetry: read('disabled'),
    });
    expect(warningsOf('4.3', quorumSac)).toContain('W-SAC-QQ');
    // 4.0-4.2: the timeout is a channel close, so a consumer cannot be the abort budget.
    expect(warningsOf('4.0-4.2', quorumSac)).toEqual([
      'rejected:METHOD_UNAVAILABLE',
    ]);
  });

  it('AC-15 warns of a stat that disagrees with the arguments, and of mixed versions', () => {
    const disagree = queueOf({
      limitDisagreement: {
        stat: { kind: 'unlimited' },
        computed: { kind: 'finite', value: 20 },
      },
    });
    expect(warningsOf('4.0-4.2', disagree)).toContain('W-UPGRADED');
    expect(warningsOf('4.0-4.2', queueOf())).not.toContain('W-UPGRADED');
    expect(
      warningsOf('4.0-4.2', queueOf(), { profile: { mixed: true } }),
    ).toContain('W-MIXED');
    expect(warningsOf('4.0-4.2', queueOf())).not.toContain('W-MIXED');
  });

  it('AC-15 takes each severity from the registry, lists a warning once and sorts them', () => {
    const result = planPeek(
      requestOf(),
      factsOf(
        '4.0-4.2',
        preflightOf(
          queueOf({
            ttlMs: 60_000,
            overflow: 'drop-head',
            maxLength: 100,
            ready: 99,
          }),
        ),
      ),
    );
    if (isRejection(result)) throw new Error(result.code);
    const idList = result.warnings.map((w) => w.id);
    expect(idList).toEqual([...new Set(idList)].sort());
    for (const warning of result.warnings) {
      expect(warning.severity, warning.id).toBe(
        semanticsRegistry.warning(warning.id).severity,
      );
    }
    const consents = result.warnings
      .filter((w) => w.severity === 'consent')
      .map((w) => w.id);
    expect(result.consentsRequired).toEqual(consents);
    expect(consents).toEqual(['W-BUDGET', 'W-DROPHEAD']);
  });
});
