import { semanticsRegistry } from '@app/semantics';
import { parseSemVer, type BrokerProfile } from '@app/domain-model';
import { describe, expect, it } from 'vitest';
import { deathContext, INTERPRETED_CAPABILITY } from './context.ts';

type Profile = Pick<BrokerProfile, 'versions' | 'stats' | 'product'>;

function profile(...nodes: (string | null)[]): Profile {
  const perNode: Record<string, ReturnType<typeof parseSemVer>> = {};
  nodes.forEach((text, index) => {
    perNode[`rabbit@n${String(index)}`] =
      text === null ? null : parseSemVer(text);
  });
  return {
    product: 'rabbitmq',
    stats: { disabled: false, queueTotals: true },
    versions: {
      min: null,
      perNode,
      mixed: new Set(nodes).size > 1,
      build: 'oss',
    },
  };
}

const capability = semanticsRegistry.capability.bind(semanticsRegistry);

describe('the broker context from the registry', () => {
  it('M1-04 AC-11 asks the registry capability and reads 3.13 as interpreting, 4.x as opaque', () => {
    expect(INTERPRETED_CAPABILITY).toBe('clientDeathHeaderInterpreted');
    expect(deathContext(capability, profile('3.13.7'))).toEqual({
      clientDeathInterpreted: true,
    });
    for (const version of ['4.0.9', '4.1.8', '4.2.9', '4.3.6', '4.4.0']) {
      expect(deathContext(capability, profile(version)), version).toEqual({
        clientDeathInterpreted: false,
      });
    }
  });

  it('M1-04 AC-11 reads a mixed cluster and an unreadable node as not interpreting', () => {
    expect(deathContext(capability, profile('3.13.7', '4.0.9'))).toEqual({
      clientDeathInterpreted: false,
    });
    expect(deathContext(capability, profile('3.13.7', null))).toEqual({
      clientDeathInterpreted: false,
    });
  });

  it('M1-04 AC-11 turns a registry gap or any throw into unknown', () => {
    const gap = (): boolean => {
      throw new Error('semantics gap');
    };
    expect(deathContext(gap, profile('3.13.7'))).toEqual({
      clientDeathInterpreted: null,
    });
  });
});
