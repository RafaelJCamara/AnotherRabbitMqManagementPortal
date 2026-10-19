import { ERAS, QueueTypeSchema, type Era } from '@app/domain-model';
import { describe, expect, it } from 'vitest';
import { semanticsRegistry } from '../index.ts';
import { PeekRoleSchema, type PeekRole } from '../caps.ts';
import { SemanticsGapError } from '../schema.ts';
import { peekCaps } from './peek-caps.data.ts';

const MIB16 = 16 * 1024 * 1024;

type Row = readonly [def: number, max: number];

/** The "Caps" column of fact sheet b.8 step 3, per era, queue type and role: [default, maximum]. */
const TABLE: Record<
  Era,
  Record<'classic' | 'quorum', Record<PeekRole, Row>>
> = {
  '3.13': {
    classic: { user: [20, 500], admin: [20, 500] },
    quorum: { user: [20, 50], admin: [20, 50] },
  },
  '4.0-4.2': {
    classic: { user: [20, 500], admin: [20, 500] },
    // Every return costs a delivery attempt here, so only administrators get 200.
    quorum: { user: [20, 50], admin: [20, 200] },
  },
  '4.3': {
    classic: { user: [20, 500], admin: [20, 500] },
    quorum: { user: [20, 500], admin: [20, 500] },
  },
  '4.4': {
    classic: { user: [20, 500], admin: [20, 500] },
    quorum: { user: [20, 500], admin: [20, 500] },
  },
};

describe('peek caps (fact sheet b.8)', () => {
  for (const era of ERAS) {
    for (const queueType of ['classic', 'quorum'] as const) {
      for (const role of PeekRoleSchema.options) {
        const [def, max] = TABLE[era][queueType][role];
        it(`${era} ${queueType} ${role}: default ${String(def)}, maximum ${String(max)}, 16 MiB`, () => {
          expect(
            semanticsRegistry.peekCaps(era, queueType, role, 'verified'),
          ).toEqual({ def, max, maxBytes: MIB16 });
        });
      }
    }
  }

  it('the table has one row for each of those combinations and no other', () => {
    expect(peekCaps).toHaveLength(
      ERAS.length * 2 * PeekRoleSchema.options.length,
    );
  });

  it('streams have no peek caps: they are read by offset, so a lookup is a gap', () => {
    for (const era of ERAS) {
      for (const role of PeekRoleSchema.options) {
        expect(() =>
          semanticsRegistry.peekCaps(era, 'stream', role, 'verified'),
        ).toThrow(SemanticsGapError);
      }
    }
    expect(QueueTypeSchema.options).toContain('stream');
  });

  it('a build that is not verified gets the conservative default as its ceiling', () => {
    for (const verification of [
      'unverified-patch',
      'unverified-minor',
      'unknown-build',
    ] as const) {
      expect(
        semanticsRegistry.peekCaps('4.3', 'quorum', 'user', verification),
      ).toEqual({ def: 20, max: 20, maxBytes: MIB16 });
      expect(
        semanticsRegistry.peekCaps('4.0-4.2', 'quorum', 'admin', verification),
      ).toEqual({ def: 20, max: 20, maxBytes: MIB16 });
      expect(
        semanticsRegistry.peekCaps('4.3', 'classic', 'admin', verification),
      ).toEqual({ def: 20, max: 20, maxBytes: MIB16 });
    }
  });

  it('an administrator never gets less than a user, and the default never exceeds the maximum', () => {
    for (const row of peekCaps) {
      expect(row.def, JSON.stringify(row)).toBeLessThanOrEqual(row.max);
    }
    for (const era of ERAS) {
      for (const queueType of ['classic', 'quorum'] as const) {
        const user = semanticsRegistry.peekCaps(
          era,
          queueType,
          'user',
          'verified',
        );
        const admin = semanticsRegistry.peekCaps(
          era,
          queueType,
          'admin',
          'verified',
        );
        expect(admin.max, `${era} ${queueType}`).toBeGreaterThanOrEqual(
          user.max,
        );
      }
    }
  });

  it('quorum queues are never allowed more than classic queues', () => {
    for (const era of ERAS) {
      for (const role of PeekRoleSchema.options) {
        expect(
          semanticsRegistry.peekCaps(era, 'quorum', role, 'verified').max,
        ).toBeLessThanOrEqual(
          semanticsRegistry.peekCaps(era, 'classic', role, 'verified').max,
        );
      }
    }
  });
});
