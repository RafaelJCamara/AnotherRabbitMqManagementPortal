import { describe, expect, it } from 'vitest';

import * as api from './index.ts';

describe('semantics public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual([
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
      'ProtocolSchema',
      'REQUIREMENTS',
      'RegistryDataError',
      'RegistryDataSchema',
      'SEMANTICS_VERSION',
      'SemanticsCellSchema',
      'SemanticsGapError',
      'SettleActionSchema',
      'SettleEffectSchema',
      'TapRuleSchema',
      'UNKNOWN_EXCHANGE_TYPE',
      'WarningDefSchema',
      'auditCells',
      'cellKeyString',
      'createRegistry',
      'isDoomed',
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
