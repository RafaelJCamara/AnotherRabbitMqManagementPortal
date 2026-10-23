// A cell without a conformance id, and a duplicate of it: the audit must fail on both.
import type { RegistryData, SemanticsCell } from '@app/semantics';

const cell: SemanticsCell = {
  id: 'SEM-4.3-quorum-amqp091-amqp091.nack_requeue',
  key: {
    era: '4.3',
    queueType: 'quorum',
    protocol: 'amqp091',
    action: 'amqp091.nack_requeue',
  },
  effect: null,
  citations: [],
  conformance: [],
  status: 'code-derived',
  evidence: [],
};

export const registryData: RegistryData = {
  version: 'sem-2026.10.1',
  cells: [cell, { ...cell }],
  warnings: [],
  hazards: [],
  capabilities: [],
  gates: [],
  peekCaps: [],
  tapRules: [],
  providerPresets: [],
  effectiveConfig: { merges: [], resolutions: [], warnings: [] },
};
