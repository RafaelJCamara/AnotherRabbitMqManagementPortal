// The dead-letter family (fact sheet b.2 row 4) and what it means for the delivery counters of
// the dead-letter target (b.4). The cell effect cannot carry the carry-over itself (the schema has
// no field for it, OQ-390); the era facts are in the citations and the conformance ids:
//  - 4.3: the delivery and acquired counts are copied into annotations and the target quorum queue
//    seeds its delivery count from them (CF-CARRY-*), so a limit-exceeded dead letter arrives with
//    DC = L + 1 and its first return of any kind drops it unless the target has a larger limit;
//  - 4.0-4.2: the limit counter is AC, which is not carried: the target grants a fresh budget;
//  - 3.13: no carry-over code, and the 1.0 plugin maps modified(df=false) to reject(requeue=false).
// The counter deltas of the 3.13 cells are 0 because the fact sheet gives none (OQ-391).
import type { SemanticsCell } from '../schema.ts';
import {
  AMQP_SESSION_43,
  CHANNEL_42,
  CHANNEL_430,
  DOCS_QQ,
  FIFO_313_RETURN,
  FIFO_42_INCR,
  FIFO_42_LIMIT,
  FIFO_43_CARRY,
  FIFO_43_RETURN,
  M3_DEVTO,
  MC_AMQP,
  PLUGIN_313,
} from './citations.ts';

export const dlxCarryover: readonly SemanticsCell[] = [
  {
    id: 'SEM-3.13-quorum-amqp091-amqp091.no_requeue',
    key: {
      era: '3.13',
      queueType: 'quorum',
      protocol: 'amqp091',
      action: 'amqp091.no_requeue',
    },
    effect: {
      deltaAC: 0,
      deltaDC: 0,
      countsTowardLimit: 'no',
      position: 'dlx-or-drop',
      destructive: true,
    },
    citations: [FIFO_313_RETURN, DOCS_QQ],
    conformance: ['CF-CARRY-01'],
    status: 'code-derived',
    evidence: [],
  },
  {
    id: 'SEM-4.0-4.2-quorum-amqp091-amqp091.no_requeue',
    key: {
      era: '4.0-4.2',
      queueType: 'quorum',
      protocol: 'amqp091',
      action: 'amqp091.no_requeue',
    },
    effect: {
      deltaAC: 1,
      deltaDC: 1,
      countsTowardLimit: 'no',
      position: 'dlx-or-drop',
      destructive: true,
    },
    citations: [FIFO_42_LIMIT, FIFO_42_INCR, CHANNEL_42, DOCS_QQ],
    conformance: ['CF-CARRY-01'],
    status: 'code-derived',
    evidence: [],
  },
  {
    id: 'SEM-4.3-quorum-amqp091-amqp091.no_requeue',
    key: {
      era: '4.3',
      queueType: 'quorum',
      protocol: 'amqp091',
      action: 'amqp091.no_requeue',
    },
    effect: {
      deltaAC: 1,
      deltaDC: 1,
      countsTowardLimit: 'no',
      position: 'dlx-or-drop',
      destructive: true,
    },
    citations: [
      FIFO_43_CARRY,
      FIFO_43_RETURN,
      CHANNEL_430,
      MC_AMQP,
      M3_DEVTO,
      DOCS_QQ,
    ],
    conformance: ['CF-CARRY-01'],
    status: 'code-derived',
    evidence: [],
  },
  {
    id: 'SEM-3.13-quorum-amqp10-amqp10.rejected',
    key: {
      era: '3.13',
      queueType: 'quorum',
      protocol: 'amqp10',
      action: 'amqp10.rejected',
    },
    effect: {
      deltaAC: 0,
      deltaDC: 0,
      countsTowardLimit: 'no',
      position: 'dlx-or-drop',
      destructive: true,
    },
    citations: [FIFO_313_RETURN, PLUGIN_313, DOCS_QQ],
    conformance: ['CF-CARRY-02'],
    status: 'code-derived',
    evidence: [],
  },
  {
    id: 'SEM-4.0-4.2-quorum-amqp10-amqp10.rejected',
    key: {
      era: '4.0-4.2',
      queueType: 'quorum',
      protocol: 'amqp10',
      action: 'amqp10.rejected',
    },
    effect: {
      deltaAC: 1,
      deltaDC: 1,
      countsTowardLimit: 'no',
      position: 'dlx-or-drop',
      destructive: true,
    },
    citations: [FIFO_42_LIMIT, FIFO_42_INCR, DOCS_QQ],
    conformance: ['CF-CARRY-02'],
    status: 'code-derived',
    evidence: [],
  },
  {
    id: 'SEM-4.3-quorum-amqp10-amqp10.rejected',
    key: {
      era: '4.3',
      queueType: 'quorum',
      protocol: 'amqp10',
      action: 'amqp10.rejected',
    },
    effect: {
      deltaAC: 1,
      deltaDC: 1,
      countsTowardLimit: 'no',
      position: 'dlx-or-drop',
      destructive: true,
    },
    citations: [
      FIFO_43_CARRY,
      FIFO_43_RETURN,
      AMQP_SESSION_43,
      MC_AMQP,
      M3_DEVTO,
      DOCS_QQ,
    ],
    conformance: ['CF-CARRY-02'],
    status: 'code-derived',
    evidence: [],
  },
  {
    id: 'SEM-3.13-quorum-amqp10-amqp10.modified_df_false',
    key: {
      era: '3.13',
      queueType: 'quorum',
      protocol: 'amqp10',
      action: 'amqp10.modified_df_false',
    },
    effect: {
      deltaAC: 0,
      deltaDC: 0,
      countsTowardLimit: 'no',
      position: 'dlx-or-drop',
      destructive: true,
    },
    citations: [FIFO_313_RETURN, PLUGIN_313, DOCS_QQ],
    conformance: ['CF-SETTLE-06'],
    status: 'code-derived',
    evidence: [],
  },
];
