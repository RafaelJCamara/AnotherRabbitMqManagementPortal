// Peek caps (fact sheet b.8 step 3, blueprint 5.4): messages per peek (`def` is the default, `max`
// the ceiling) and bytes per peek, by era, queue type and role. Rows come from the "Caps" column of
// the plan table: classic queues 20 / 500; quorum queues 20 / 50 on 3.13 and 4.0-4.2 (administrators
// 200 on 4.0-4.2, where every return costs a delivery attempt) and 20 / 500 on 4.3 and later.
//
// Streams have no row on purpose: they are read by offset with their own limits (count, bytes or
// time), not through a peek, so a lookup for one is a SemanticsGapError. A build that is not
// verified gets the conservative (4.0-4.2) row's default as its ceiling; that rule is in `caps.ts`.
//
// The byte cap is 16 MiB on every row. The fact sheet states it for classic queues and for quorum
// queues on 4.3 and later; for the older quorum rows it states no byte cap, and 16 MiB is carried
// over from the same table (see docs/open-questions.md, OQ-360).
import type { PeekCapRow } from '../caps.ts';

const SIXTEEN_MIB = 16 * 1024 * 1024;

export const peekCaps: readonly PeekCapRow[] = [
  // Classic queues: the same in every era.
  {
    era: '3.13',
    queueType: 'classic',
    role: 'user',
    def: 20,
    max: 500,
    maxBytes: SIXTEEN_MIB,
  },
  {
    era: '3.13',
    queueType: 'classic',
    role: 'admin',
    def: 20,
    max: 500,
    maxBytes: SIXTEEN_MIB,
  },
  {
    era: '4.0-4.2',
    queueType: 'classic',
    role: 'user',
    def: 20,
    max: 500,
    maxBytes: SIXTEEN_MIB,
  },
  {
    era: '4.0-4.2',
    queueType: 'classic',
    role: 'admin',
    def: 20,
    max: 500,
    maxBytes: SIXTEEN_MIB,
  },
  {
    era: '4.3',
    queueType: 'classic',
    role: 'user',
    def: 20,
    max: 500,
    maxBytes: SIXTEEN_MIB,
  },
  {
    era: '4.3',
    queueType: 'classic',
    role: 'admin',
    def: 20,
    max: 500,
    maxBytes: SIXTEEN_MIB,
  },
  {
    era: '4.4',
    queueType: 'classic',
    role: 'user',
    def: 20,
    max: 500,
    maxBytes: SIXTEEN_MIB,
  },
  {
    era: '4.4',
    queueType: 'classic',
    role: 'admin',
    def: 20,
    max: 500,
    maxBytes: SIXTEEN_MIB,
  },
  // Quorum queues.
  {
    era: '3.13',
    queueType: 'quorum',
    role: 'user',
    def: 20,
    max: 50,
    maxBytes: SIXTEEN_MIB,
  },
  {
    era: '3.13',
    queueType: 'quorum',
    role: 'admin',
    def: 20,
    max: 50,
    maxBytes: SIXTEEN_MIB,
  },
  {
    era: '4.0-4.2',
    queueType: 'quorum',
    role: 'user',
    def: 20,
    max: 50,
    maxBytes: SIXTEEN_MIB,
  },
  {
    era: '4.0-4.2',
    queueType: 'quorum',
    role: 'admin',
    def: 20,
    max: 200,
    maxBytes: SIXTEEN_MIB,
  },
  {
    era: '4.3',
    queueType: 'quorum',
    role: 'user',
    def: 20,
    max: 500,
    maxBytes: SIXTEEN_MIB,
  },
  {
    era: '4.3',
    queueType: 'quorum',
    role: 'admin',
    def: 20,
    max: 500,
    maxBytes: SIXTEEN_MIB,
  },
  {
    era: '4.4',
    queueType: 'quorum',
    role: 'user',
    def: 20,
    max: 500,
    maxBytes: SIXTEEN_MIB,
  },
  {
    era: '4.4',
    queueType: 'quorum',
    role: 'admin',
    def: 20,
    max: 500,
    maxBytes: SIXTEEN_MIB,
  },
];
