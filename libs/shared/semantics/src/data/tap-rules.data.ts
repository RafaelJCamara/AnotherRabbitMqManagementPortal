// Tap rules (fact sheet c.1 and c.2, DC-18, blueprint 5.7): per exchange type, whether a tap
// diverts messages from the real consumers, whether an exchange-to-exchange (e2e) tap is allowed,
// and whether the planner refuses the tap unless the user accepts the diversion. A type that is
// not listed (a plugin type nobody described) is refused, assumed to divert and denied e2e: that
// is `UNKNOWN_EXCHANGE_TYPE` in `tap-rules.ts`, not a default written here.
//
// The baseline of a row is written for the worst version; an override relaxes it for versions
// known to behave better.
import type { TapRule } from '../tap-rules.ts';

export const tapRules: readonly TapRule[] = [
  // Types that copy a message to every matching destination: a tap adds a copy, it takes none.
  {
    exchangeType: 'direct',
    diverts: false,
    e2eAllowed: true,
    refuseByDefault: false,
  },
  {
    exchangeType: 'topic',
    diverts: false,
    e2eAllowed: true,
    refuseByDefault: false,
  },
  {
    exchangeType: 'fanout',
    diverts: false,
    e2eAllowed: true,
    refuseByDefault: false,
  },
  {
    exchangeType: 'headers',
    diverts: false,
    e2eAllowed: true,
    refuseByDefault: false,
  },
  // Replays its cache into a new tap; it takes nothing, but a replay into an exchange would reach
  // that exchange's consumers, so e2e stays denied.
  {
    exchangeType: 'x-recent-history',
    diverts: false,
    e2eAllowed: false,
    refuseByDefault: false,
  },
  // Single-destination types: each message goes to one destination, so a tap takes a share.
  // The consistent-hash tap takes its weight share. E2e is never allowed below 4.3.6, where
  // deleting the destination exchange leaves a stale ring bucket and loses messages silently.
  {
    exchangeType: 'x-consistent-hash',
    diverts: true,
    e2eAllowed: false,
    refuseByDefault: true,
    overrides: [{ versions: '>=4.3.6', e2eAllowed: true }],
  },
  // Takes about 1/(N+1) and remaps almost every key, which breaks per-key ordering.
  {
    exchangeType: 'x-modulus-hash',
    diverts: true,
    e2eAllowed: false,
    refuseByDefault: true,
  },
  // Takes 1/(N+1).
  {
    exchangeType: 'x-random',
    diverts: true,
    e2eAllowed: false,
    refuseByDefault: true,
  },
  // Its destination must be an existing classic queue, so e2e is impossible; a tap sees only
  // messages published on its own node.
  {
    exchangeType: 'x-local-random',
    diverts: true,
    e2eAllowed: false,
    refuseByDefault: true,
  },
];
