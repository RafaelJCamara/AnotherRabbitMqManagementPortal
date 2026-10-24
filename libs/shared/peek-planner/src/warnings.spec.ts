import { SemanticsGapError, semanticsRegistry } from '@app/semantics';
import { describe, expect, it } from 'vitest';

import texts from '../i18n/en/peek-planner.json' with { type: 'json' };
import { lookup } from './testing.ts';
import {
  consentIds,
  PLANNER_WARNING_IDS,
  plannerWarning,
  sortWarnings,
  warningRef,
} from './warnings.ts';

describe('planner warnings', () => {
  it('owns four warnings, all consents, each with a text in the file', () => {
    expect([...PLANNER_WARNING_IDS]).toEqual([
      'W-BROKER-UNVERIFIED',
      'W-DLX-UNVERIFIED',
      'W-LIMIT-UNKNOWN',
      'W-SEMANTICS-GAP',
    ]);
    for (const id of PLANNER_WARNING_IDS) {
      const warning = plannerWarning(id);
      expect(warning.severity).toBe('consent');
      expect(warning.textVersion).toBe(1);
      expect(lookup(warning.textKey), id).toMatch(/\S/);
    }
    expect(Object.keys(texts.warnings).sort()).toEqual([
      ...PLANNER_WARNING_IDS,
    ]);
  });

  it('takes the severity of a b.8 warning from the registry, not from the planner', () => {
    expect(warningRef(semanticsRegistry, 'W-OVERLIMIT').severity).toBe('block');
    expect(warningRef(semanticsRegistry, 'W-BUDGET').severity).toBe('consent');
    expect(warningRef(semanticsRegistry, 'W-TAIL').severity).toBe('warn');
    const stub = {
      ...semanticsRegistry,
      warning: () => ({
        id: plannerWarning('W-LIMIT-UNKNOWN').id,
        severity: 'info' as const,
        textKey: 'x',
        textVersion: 1,
      }),
    };
    expect(warningRef(stub, 'W-BUDGET').severity).toBe('info');
    // An id the planner owns never reaches the registry.
    expect(warningRef(stub, 'W-LIMIT-UNKNOWN').severity).toBe('consent');
  });

  it('lets a gap in the registry through, for the caller to handle', () => {
    expect(() => warningRef(semanticsRegistry, 'W-NO-SUCH-ONE')).toThrow(
      SemanticsGapError,
    );
  });

  it('sorts by id and lists a warning once', () => {
    const a = warningRef(semanticsRegistry, 'W-TAIL');
    const b = warningRef(semanticsRegistry, 'W-BUDGET');
    expect(sortWarnings([a, b, a]).map((w) => w.id)).toEqual([
      'W-BUDGET',
      'W-TAIL',
    ]);
  });

  it('asks for a consent for each consent warning and the extra ids, sorted, once', () => {
    const list = [
      warningRef(semanticsRegistry, 'W-TAIL'),
      warningRef(semanticsRegistry, 'W-DELAY'),
      warningRef(semanticsRegistry, 'W-BUDGET'),
      warningRef(semanticsRegistry, 'W-BUDGET'),
    ];
    expect(consentIds(list, ['disposition:let-broker-handle'])).toEqual([
      'W-BUDGET',
      'W-DELAY',
      'disposition:let-broker-handle',
    ]);
    expect(consentIds([])).toEqual([]);
  });
});
