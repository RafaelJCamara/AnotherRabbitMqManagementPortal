import { describe, expect, it } from 'vitest';
import { semanticsRegistry } from '../index.ts';
import { profile } from '../testing/profile.ts';
import { authCapabilityRules } from './auth-capabilities.data.ts';

const IDS = [
  'amqp091ClosesAtCredentialExpiry',
  'amqp10TokenRenewalEndpoint',
  'amqp091PreAuthFrame8192',
] as const;

/** Where each rule starts to hold (M1-23, OQ-1452). */
const FROM: Record<(typeof IDS)[number], string> = {
  amqp091ClosesAtCredentialExpiry: '4.2.6',
  amqp10TokenRenewalEndpoint: '4.1.0',
  amqp091PreAuthFrame8192: '4.1.0',
};

const GRID = [
  '3.13.7',
  '4.0.0',
  '4.0.9',
  '4.1.0',
  '4.1.8',
  '4.2.5',
  '4.2.6',
  '4.2.9',
  '4.3.0',
  '4.3.6',
  '4.4.0',
] as const;

const holds = (
  id: string,
  nodes: readonly (string | null)[] | string,
  options?: Parameters<typeof profile>[1],
): boolean => semanticsRegistry.capability(id, profile(nodes, options));

describe('auth capability rules (M1-23, OQ-1452)', () => {
  it('M1-23 AC-22 auth capability rules hold at their boundaries and fail conservatively', () => {
    // Exactly the three rules, each cited, none with a status or evidence of its own.
    expect(authCapabilityRules.map((rule) => rule.id).sort()).toEqual(
      [...IDS].sort(),
    );
    for (const rule of authCapabilityRules) {
      expect(rule.citations.length, rule.id).toBeGreaterThan(0);
      expect(Object.keys(rule).sort(), rule.id).toEqual([
        'appliesWhen',
        'citations',
        'id',
        'summary',
        'versions',
      ]);
    }

    // The boundaries are exact: the version named holds, the one before it does not.
    for (const id of IDS) {
      for (const version of [...GRID, '4.1.9', '4.2.7']) {
        const expected =
          version.localeCompare(FROM[id], undefined, { numeric: true }) >= 0;
        expect(holds(id, version), `${id} on ${version}`).toBe(expected);
      }
    }
    expect(holds('amqp091ClosesAtCredentialExpiry', '4.2.5')).toBe(false);
    expect(holds('amqp091ClosesAtCredentialExpiry', '4.2.6')).toBe(true);
    expect(holds('amqp10TokenRenewalEndpoint', '4.0.9')).toBe(false);
    expect(holds('amqp10TokenRenewalEndpoint', '4.1.0')).toBe(true);
    expect(holds('amqp091PreAuthFrame8192', '4.0.9')).toBe(false);
    expect(holds('amqp091PreAuthFrame8192', '4.1.0')).toBe(true);

    // The conservative side: one node outside the range, an unreadable node, an unnamed product
    // and a statistics-off profile (the rules do not depend on statistics) never earn a rule.
    for (const id of IDS) {
      expect(holds(id, ['4.3.6', '4.0.9']), `${id} mixed`).toBe(false);
      expect(holds(id, ['4.0.9', '4.3.6']), `${id} mixed, reversed`).toBe(
        false,
      );
      expect(holds(id, ['4.3.6', null]), `${id} unreadable node`).toBe(false);
      expect(holds(id, [null]), `${id} only unreadable`).toBe(false);
      expect(holds(id, ['4.3.6', '4.3.6']), `${id} uniform`).toBe(true);
      for (const product of ['lavinmq', 'apsaramq', 'unknown'] as const) {
        expect(holds(id, '4.4.0', { product }), `${id} ${product}`).toBe(false);
      }
      expect(holds(id, '4.3.6', { product: 'tanzu-rabbitmq' }), id).toBe(true);
      expect(holds(id, '4.0.9', { statsOff: true }), `${id} stats off`).toBe(
        false,
      );
      expect(holds(id, '4.3.6', { statsOff: true }), `${id} stats off`).toBe(
        true,
      );
    }
  });
});
