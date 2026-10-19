import { describe, expect, it } from 'vitest';

import * as api from './index.ts';

describe('semantics public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'CapabilityRuleSchema',
      'CellKeySchema',
      'CellStatusSchema',
      'CitationSchema',
      'DelayedRetrySchema',
      'EVIDENCE_PATH',
      'EvidencePathSchema',
      'GateRuleSchema',
      'HazardRuleSchema',
      'LimitStateSchema',
      'PeekCapRowSchema',
      'PeekRoleSchema',
      'PresetIdSchema',
      'ProtocolSchema',
      'ProviderPresetSchema',
      'REQUIREMENTS',
      'RegistryDataError',
      'RegistryDataSchema',
      'SEMANTICS_VERSION',
      'SUPPORT_AREAS',
      'SemanticsCellSchema',
      'SemanticsGapError',
      'SettleActionSchema',
      'SettleEffectSchema',
      'SupportLevelSchema',
      'TapRuleSchema',
      'UNKNOWN_EXCHANGE_TYPE',
      'WarningDefSchema',
      'auditCells',
      'cellKeyString',
      'createRegistry',
      'isDoomed',
      'presetIdFor',
      'registryData',
      'resolveEra',
      'semanticsRegistry',
      'settleMatrix',
      'validateRegistryData',
    ]);
  });

  it('ships a registry that is built from validated data', () => {
    expect(api.semanticsRegistry.version).toBe(api.SEMANTICS_VERSION);
    expect(api.validateRegistryData(api.registryData)).toEqual([]);
  });
});
