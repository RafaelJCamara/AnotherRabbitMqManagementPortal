// The registry data this release ships. Each table is a typed constant in its own `*.data.ts` file;
// this file only assembles them. M0-12 fills the cells (settle matrix, broker-side counter events,
// dead-letter family, delayed retry); M0-13 fills the other tables (gates stay empty: no work
// package owns a feature gate yet).
import type { RegistryData } from '../registry.ts';
import { capabilityRules } from './capabilities.data.ts';
import { counters } from './counters.data.ts';
import { delayedRetry } from './delayed-retry.data.ts';
import { dlxCarryover } from './dlx-carryover.data.ts';
import { hazardRules } from './hazards.data.ts';
import { peekCaps } from './peek-caps.data.ts';
import { providerPresets } from './provider-presets.data.ts';
import { settleMatrix } from './settle-matrix.data.ts';
import { tapRules } from './tap-rules.data.ts';
import { warnings } from './warnings.data.ts';

export const SEMANTICS_VERSION = 'sem-2026.10.1';

export const registryData: RegistryData = {
  version: SEMANTICS_VERSION,
  cells: [...settleMatrix, ...delayedRetry, ...dlxCarryover, ...counters],
  warnings: [...warnings],
  hazards: [...hazardRules],
  capabilities: [...capabilityRules],
  gates: [],
  peekCaps: [...peekCaps],
  tapRules: [...tapRules],
  providerPresets: [...providerPresets],
};
