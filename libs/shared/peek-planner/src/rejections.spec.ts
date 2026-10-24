import { describe, expect, it } from 'vitest';

import texts from '../i18n/en/peek-planner.json' with { type: 'json' };
import {
  HONEST_LABEL_KEY,
  isRejection,
  REASON_CODES,
  reasonTextKey,
  reject,
  REJECTION_CODES,
  rejectionTextKey,
} from './rejections.ts';
import { lookup } from './testing.ts';

describe('rejections', () => {
  it('has every code and every reason in the translation file, with a text', () => {
    for (const code of REJECTION_CODES) {
      expect(lookup(rejectionTextKey(code)), code).toMatch(/\S/);
    }
    for (const reason of REASON_CODES) {
      expect(lookup(reasonTextKey(reason)), reason).toMatch(/\S/);
    }
    expect(lookup(HONEST_LABEL_KEY)).toMatch(/Side-effect-aware peek/);
  });

  it('has no text in the file that no code or reason uses', () => {
    const reasons = Object.keys(texts.reasons).sort();
    expect(reasons).toEqual([...REASON_CODES].sort());
    expect(Object.keys(texts.rejections).sort()).toEqual(
      [...REJECTION_CODES].sort(),
    );
  });

  it('keeps the codes and reasons unique', () => {
    expect(new Set(REJECTION_CODES).size).toBe(REJECTION_CODES.length);
    expect(new Set(REASON_CODES).size).toBe(REASON_CODES.length);
  });

  it('builds a rejection with sorted, de-duplicated reasons and a text key', () => {
    const rejection = reject('EXCLUSIVE', [
      'rescue-stale',
      'exclusive-owned-by-other',
      'rescue-stale',
    ]);
    expect(rejection).toEqual({
      rejected: true,
      code: 'EXCLUSIVE',
      textKey: 'peek-planner.rejections.EXCLUSIVE.v1',
      textVersion: 1,
      reasons: ['exclusive-owned-by-other', 'rescue-stale'],
      warnings: [],
    });
    expect(isRejection(rejection)).toBe(true);
  });

  it('carries a fix and the offers only when given', () => {
    const plain = reject('GATE', ['gate-disabled']);
    expect('fix' in plain).toBe(false);
    expect('offers' in plain).toBe(false);
    const rich = reject('OVERLIMIT_DLQ', ['dlx-sources-over-limit'], {
      fix: {
        kind: 'delivery-limit-policy',
        queue: 'q',
        limit: -1,
        minimumFinite: 22,
      },
      offers: ['quarantine', 'let-broker-handle'],
    });
    expect(rich.fix?.minimumFinite).toBe(22);
    expect(rich.offers).toEqual(['let-broker-handle', 'quarantine']);
  });

  it('recognises only a rejection', () => {
    expect(isRejection(null)).toBe(false);
    expect(isRejection({ preview: {} })).toBe(false);
    expect(isRejection({ rejected: false })).toBe(false);
  });
});
