// Registry data for the audit-cells tests: one complete cell and one that only has a conformance id.
import type { RegistryData, SemanticsCell } from '@app/semantics';

const complete: SemanticsCell = {
  id: 'SEM-4.3-quorum-amqp091-amqp091.nack_requeue',
  key: {
    era: '4.3',
    queueType: 'quorum',
    protocol: 'amqp091',
    action: 'amqp091.nack_requeue',
  },
  effect: {
    deltaAC: 1,
    deltaDC: 0,
    countsTowardLimit: 'no',
    position: 'head',
    destructive: false,
  },
  citations: [{ kind: 'S', ref: 'sample citation' }],
  conformance: ['CF-SAMPLE-01'],
  status: 'code-derived',
  evidence: [],
};

const stub: SemanticsCell = {
  id: 'SEM-4.3-quorum-amqp091-amqp091.reject_requeue',
  key: { ...complete.key, action: 'amqp091.reject_requeue' },
  effect: null,
  citations: [],
  conformance: ['CF-SAMPLE-02'],
  status: 'code-derived',
  evidence: [],
};

const empty: Omit<RegistryData, 'cells'> = {
  version: 'sem-2026.10.1',
  warnings: [],
  hazards: [],
  gates: [],
  peekCaps: [],
  tapRules: [],
};

export const registryData: RegistryData = {
  ...empty,
  cells: [complete, stub],
};
