import { describe, expect, it } from 'vitest';

import type { PolicyRow, QueueRow } from './rows';
import {
  alternateExchangeOf,
  resolveQueueConfig,
  toTopologyExchange,
  toTopologyQueue,
  type SettingsInput,
} from './settings';
import type { PolicyList } from './snapshot';
import { sampleProfile } from '../testing';

const version = sampleProfile().versions.min;

const read = (...policies: PolicyRow[]): PolicyList => ({
  state: 'read',
  policies,
});
const unreadable: PolicyList = { state: 'unreadable' };
const policy = (
  name: string,
  definition: Record<string, unknown>,
  over: Partial<PolicyRow> = {},
): PolicyRow => ({
  name,
  pattern: '.*',
  'apply-to': 'queues',
  priority: 0,
  definition,
  ...over,
});
const settings = (over: Partial<SettingsInput> = {}): SettingsInput => ({
  policies: read(),
  operatorPolicies: read(),
  version,
  ...over,
});
const quorum = (over: Partial<QueueRow> = {}): QueueRow => ({
  name: 'q',
  type: 'quorum',
  arguments: {},
  policy: null,
  operator_policy: null,
  delivery_limit: 20,
  ...over,
});
const queueOf = (
  row: QueueRow,
  input: SettingsInput = settings(),
  acking: ReadonlySet<string> = new Set(),
) => toTopologyQueue(row, resolveQueueConfig(row, input), acking);

describe('M1-20 AC-6 queue settings resolve argument over policy and fail unknown', () => {
  it('takes the dead-letter exchange from the argument alone', () => {
    const q = queueOf(
      quorum({ arguments: { 'x-dead-letter-exchange': 'dlx' } }),
    );
    expect(q.deadLetter).toEqual({ status: 'set', exchange: 'dlx' });
    expect(q.type).toBe('quorum');
  });

  it('takes it from a user policy when no argument sets it', () => {
    const q = queueOf(
      quorum({ policy: 'p' }),
      settings({
        policies: read(policy('p', { 'dead-letter-exchange': 'pdlx' })),
      }),
    );
    expect(q.deadLetter).toEqual({ status: 'set', exchange: 'pdlx' });
  });

  it('lets the argument beat the user policy and even an operator policy', () => {
    const q = queueOf(
      quorum({
        arguments: { 'x-dead-letter-exchange': 'arg-dlx' },
        policy: 'p',
        operator_policy: 'o',
      }),
      settings({
        policies: read(policy('p', { 'dead-letter-exchange': 'user-dlx' })),
        operatorPolicies: read(
          policy('o', { 'dead-letter-exchange': 'operator-dlx' }),
        ),
      }),
    );
    expect(q.deadLetter).toEqual({ status: 'set', exchange: 'arg-dlx' });
  });

  it('carries a fixed routing key and the strategy', () => {
    const q = queueOf(
      quorum({
        arguments: {
          'x-dead-letter-exchange': 'dlx',
          'x-dead-letter-routing-key': 'dead',
          'x-dead-letter-strategy': 'at-least-once',
          'x-overflow': 'reject-publish',
        },
      }),
    );
    expect(q.deadLetter).toEqual({
      status: 'set',
      exchange: 'dlx',
      routingKey: 'dead',
      strategy: 'at-least-once',
    });
  });

  it('has no dead letter when nothing sets one', () => {
    expect(queueOf(quorum()).deadLetter).toBeUndefined();
  });

  it('takes the smaller of the argument and the policy for the limits', () => {
    const q = queueOf(
      quorum({
        arguments: { 'x-message-ttl': 5000, 'x-max-length': 10 },
        policy: 'p',
      }),
      settings({
        policies: read(policy('p', { 'message-ttl': 1000, 'max-length': 50 })),
      }),
    );
    expect(q.messageTtlMs).toBe(1000);
    expect(q.maxLength).toBe(10);
  });

  it('gives an unknown dead letter when a policy layer cannot be read, unless an argument settles it whole', () => {
    const open = settings({ policies: unreadable });
    expect(queueOf(quorum(), open).deadLetter).toEqual({ status: 'unknown' });
    // The exchange from the argument is not enough: an unread policy may set the routing key.
    expect(
      queueOf(quorum({ arguments: { 'x-dead-letter-exchange': 'dlx' } }), open)
        .deadLetter,
    ).toEqual({ status: 'unknown' });
    expect(
      queueOf(
        quorum({
          arguments: {
            'x-dead-letter-exchange': 'dlx',
            'x-dead-letter-routing-key': 'dead',
          },
        }),
        open,
      ).deadLetter,
    ).toEqual({ status: 'set', exchange: 'dlx', routingKey: 'dead' });
  });

  it('keeps the argument limits when a policy is unreadable and never invents a policy limit', () => {
    const q = queueOf(
      quorum({ arguments: { 'x-message-ttl': 5000 } }),
      settings({ operatorPolicies: unreadable }),
    );
    expect(q.messageTtlMs).toBe(5000);
    expect(q.maxLength).toBeUndefined();
  });

  it('tells a layer: none, one policy, unreadable, not listed, ambiguous', () => {
    const named = resolveQueueConfig(
      quorum({ policy: 'p' }),
      settings({ policies: read(policy('p', {})) }),
    );
    expect(named.layers.user).toMatchObject({
      state: 'policy',
      policy: { name: 'p' },
    });
    expect(resolveQueueConfig(quorum(), settings()).layers.user).toEqual({
      state: 'none',
    });
    expect(
      resolveQueueConfig(
        quorum({ policy: 'p' }),
        settings({ policies: unreadable }),
      ).layers.user,
    ).toEqual({ state: 'unknown', why: 'unreadable' });
    expect(
      resolveQueueConfig(quorum({ policy: 'gone' }), settings()).layers.user,
    ).toEqual({ state: 'unknown', why: 'not-listed' });
    // The stat is absent (statistics off): the list is matched, and two policies that tie are undecided.
    const tie = resolveQueueConfig(
      quorum({ policy: undefined }),
      settings({ policies: read(policy('a', {}), policy('b', {})) }),
    );
    expect(tie.layers.user).toEqual({ state: 'unknown', why: 'ambiguous' });
    expect(tie.undecided).toBe(true);
    expect(tie.effective).toBeNull();
  });

  it('matches by pattern when the broker did not send the policy name', () => {
    const matched = resolveQueueConfig(
      quorum({ name: 'orders.q', policy: undefined }),
      settings({
        policies: read(
          policy(
            'orders',
            { 'dead-letter-exchange': 'odlx' },
            {
              pattern: '^orders\\.',
            },
          ),
          policy('other', { 'dead-letter-exchange': 'x' }, { pattern: '^zzz' }),
        ),
      }),
    );
    expect(matched.layers.user).toMatchObject({
      state: 'policy',
      policy: { name: 'orders' },
    });
    expect(matched.statsMissing).toBe(true);
  });

  it('reads the delivery limit from the queue stat, a negative one as unlimited and an odd one as unknown', () => {
    expect(queueOf(quorum({ delivery_limit: 20 })).deliveryLimit).toEqual({
      kind: 'finite',
      value: 20,
    });
    expect(queueOf(quorum({ delivery_limit: 0 })).deliveryLimit).toEqual({
      kind: 'finite',
      value: 0,
    });
    expect(queueOf(quorum({ delivery_limit: -1 })).deliveryLimit).toEqual({
      kind: 'unlimited',
    });
    expect(queueOf(quorum({ delivery_limit: 'soon' })).deliveryLimit).toEqual({
      kind: 'unknown',
    });
  });

  it('asks the resolver for the delivery limit when the stat is not a number', () => {
    const viaPolicy = queueOf(
      quorum({ delivery_limit: null, policy: 'p' }),
      settings({ policies: read(policy('p', { 'delivery-limit': 7 })) }),
    );
    expect(viaPolicy.deliveryLimit).toEqual({ kind: 'finite', value: 7 });
    const viaArgument = queueOf(
      quorum({
        delivery_limit: undefined,
        arguments: { 'x-delivery-limit': 9 },
      }),
    );
    expect(viaArgument.deliveryLimit).toEqual({ kind: 'finite', value: 9 });
    // With a layer that cannot be read nothing is resolved: unknown, never a default.
    expect(
      queueOf(
        quorum({ delivery_limit: undefined }),
        settings({ policies: unreadable }),
      ).deliveryLimit,
    ).toEqual({ kind: 'unknown' });
  });

  it('gives a classic or a stream queue no delivery limit at all', () => {
    expect(
      queueOf({
        name: 'c',
        type: 'classic',
        policy: null,
        operator_policy: null,
      }).deliveryLimit,
    ).toBeUndefined();
    expect(
      queueOf({
        name: 's',
        type: 'stream',
        policy: null,
        operator_policy: null,
      }).deliveryLimit,
    ).toBeUndefined();
  });

  it('flags the stat fields the broker left out, and only those', () => {
    const missing = (row: QueueRow) =>
      resolveQueueConfig(row, settings()).statsMissing;
    expect(missing(quorum())).toBe(false);
    expect(missing(quorum({ policy: undefined }))).toBe(true);
    expect(missing(quorum({ operator_policy: undefined }))).toBe(true);
    expect(missing(quorum({ delivery_limit: undefined }))).toBe(true);
    // A classic queue has no delivery limit to miss.
    expect(
      missing({
        name: 'c',
        type: 'classic',
        policy: null,
        operator_policy: null,
      }),
    ).toBe(false);
  });

  it('marks a queue with a consumer that acknowledges as rejectable, and no other', () => {
    const row = quorum({ name: 'busy' });
    expect(queueOf(row, settings(), new Set(['busy'])).rejectable).toBe(true);
    expect(queueOf(row, settings(), new Set(['other'])).rejectable).toBe(
      undefined,
    );
  });

  it('leaves the type out when the row names one the registry does not know', () => {
    const row: QueueRow = {
      name: 'x',
      type: 'lazy-thing',
      policy: null,
      operator_policy: null,
    };
    const config = resolveQueueConfig(row, settings());
    expect(config.type).toBeNull();
    expect(config.effective).toBeNull();
    expect(toTopologyQueue(row, config, new Set()).type).toBeUndefined();
  });

  it('takes the overflow only from the three values the broker has', () => {
    expect(
      queueOf(quorum({ arguments: { 'x-overflow': 'reject-publish-dlx' } }))
        .overflow,
    ).toBe('reject-publish-dlx');
    expect(
      queueOf(quorum({ arguments: { 'x-overflow': 'nonsense' } })).overflow,
    ).toBeUndefined();
  });
});

describe('M1-20 AC-6 alternate exchange: argument, else user policy', () => {
  const x = (over: Record<string, unknown> = {}) => ({
    name: 'ex',
    type: 'direct',
    ...over,
  });

  it('prefers the argument, then the matching policy, and says none when nothing matches', () => {
    expect(
      alternateExchangeOf(
        x({ arguments: { 'alternate-exchange': 'ae' } }),
        read(),
      ),
    ).toEqual({ value: 'ae', undecided: false });
    expect(
      alternateExchangeOf(
        x(),
        read(
          policy(
            'p',
            { 'alternate-exchange': 'pae' },
            { 'apply-to': 'exchanges', pattern: '^ex$' },
          ),
        ),
      ),
    ).toEqual({ value: 'pae', undecided: false });
    expect(alternateExchangeOf(x(), read())).toEqual({
      value: null,
      undecided: false,
    });
  });

  it('cannot tell when the policies are unreadable or tie', () => {
    expect(alternateExchangeOf(x(), unreadable)).toEqual({
      value: undefined,
      undecided: false,
    });
    expect(
      alternateExchangeOf(
        x(),
        read(
          policy(
            'a',
            { 'alternate-exchange': '1' },
            { 'apply-to': 'exchanges' },
          ),
          policy(
            'b',
            { 'alternate-exchange': '2' },
            { 'apply-to': 'exchanges' },
          ),
        ),
      ),
    ).toEqual({ value: undefined, undecided: true });
  });

  it('keeps an internal exchange internal and leaves an unknown alternate exchange out', () => {
    const converted = toTopologyExchange(x({ internal: true }), unreadable);
    expect(converted.exchange).toEqual({
      name: 'ex',
      type: 'direct',
      internal: true,
    });
  });
});
