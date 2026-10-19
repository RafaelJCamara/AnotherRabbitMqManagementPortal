// A lab-verified cell whose evidence file does not exist: only the file-existence check sees it.
import type { RegistryData } from '@app/semantics';

export const registryData: RegistryData = {
  version: 'sem-2026.10.1',
  cells: [
    {
      id: 'SEM-4.3-quorum-amqp091-amqp091.nack_requeue',
      key: {
        era: '4.3',
        queueType: 'quorum',
        protocol: 'amqp091',
        action: 'amqp091.nack_requeue',
      },
      effect: null,
      citations: [],
      conformance: ['CF-SAMPLE-01'],
      status: 'lab-verified',
      evidence: ['testing/lab-evidence/4.3.6/CF-SAMPLE-01.json'],
    },
  ],
  warnings: [],
  hazards: [],
  capabilities: [],
  gates: [],
  peekCaps: [],
  tapRules: [],
  providerPresets: [],
};
