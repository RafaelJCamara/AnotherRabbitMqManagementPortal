// Which exchange types the simulator models (M1-02, R4). Everything else is reported unknown, with
// a hint code for the types whose behaviour is known in outline (OQ-1105). Nothing here guesses a
// routing result: a hint says why the answer cannot be computed from the topology alone.
import type { UnknownHint } from './types.ts';

export type ModelledType = 'direct' | 'fanout' | 'topic' | 'headers';

export function modelledType(type: string): ModelledType | null {
  switch (type) {
    case 'direct':
    case 'fanout':
    case 'topic':
    case 'headers':
      return type;
    default:
      return null;
  }
}

export function unknownHint(type: string): UnknownHint {
  switch (type) {
    case 'x-consistent-hash':
    case 'x-modulus-hash':
      return 'hash-single-destination';
    case 'x-random':
    case 'x-local-random':
      return 'random-single-destination';
    case 'x-delayed-message':
      return 'delayed';
    case 'x-recent-history':
      return 'recent-history';
    default:
      return 'unmodelled';
  }
}
