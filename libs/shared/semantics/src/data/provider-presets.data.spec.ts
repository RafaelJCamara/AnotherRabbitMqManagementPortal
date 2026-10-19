import { ProviderSchema } from '@app/domain-model';
import { describe, expect, it } from 'vitest';
import {
  PresetIdSchema,
  presetIdFor,
  SUPPORT_AREAS,
  semanticsRegistry,
} from '../index.ts';
import { v } from '../testing/profile.ts';
import { providerPresets } from './provider-presets.data.ts';

const preset = (
  provider: (typeof ProviderSchema.options)[number],
  version: string | null = null,
  product: 'rabbitmq' | 'lavinmq' | 'apsaramq' = 'rabbitmq',
) =>
  semanticsRegistry.providerPreset(
    { provider, product },
    version === null ? null : v(version),
  );

describe('provider presets (fact sheet j.1)', () => {
  it('has one preset for every provider and every non-RabbitMQ product, and no other', () => {
    expect(providerPresets.map((entry) => entry.id).sort()).toEqual(
      [...PresetIdSchema.options].sort(),
    );
    for (const provider of ProviderSchema.options) {
      expect(preset(provider).id, provider).toBe(provider);
    }
    expect(preset('self-hosted', null, 'lavinmq').id).toBe('lavinmq');
    expect(preset('amazon-mq', null, 'apsaramq').id).toBe('apsaramq');
  });

  it('every preset is cited and rates every area', () => {
    for (const entry of providerPresets) {
      expect(entry.citations.length, entry.id).toBeGreaterThan(0);
      expect(Object.keys(entry.support).sort(), entry.id).toEqual(
        [...SUPPORT_AREAS].sort(),
      );
    }
  });

  it('Amazon MQ: 10 consumers per channel, 512 KiB messages, owned objects, 405 on operator policies', () => {
    const amazon = preset('amazon-mq', '4.2.9');

    expect(amazon.limits).toEqual({
      consumersPerChannelMax: 10,
      maxMessageBytes: 524288,
    });
    expect(amazon.tapNeedsExplicitOverflow).toBe(true);
    expect(amazon.prometheus).toEqual({
      perObjectAllowed: false,
      minIntervalSec: 60,
      ports: [16001, 16002, 16003],
    });
    expect(amazon.ownedObjects.map((object) => object.pattern)).toEqual([
      'AWS-DEFAULT-POLICY-*',
      'default_operator_policy_AWS_managed',
      'monitoring-AWS-OWNED-DO-NOT-DELETE',
    ]);
    expect(amazon.support.operatorPolicyEdit).toBe('config');
    expect(amazon.support.eventExchange).toBe('blocked');
    expect(amazon.support.streams).toBe('blocked');
  });

  it('Amazon MQ: the per-version corrections start at the documented versions', () => {
    const at = (version: string | null) => preset('amazon-mq', version).support;

    // Prometheus exists from 4.2; the tap is fully supported only below 4.0.
    expect(at('3.13.7')).toMatchObject({
      prometheus: 'blocked',
      tap: 'supported',
    });
    expect(at('4.1.8')).toMatchObject({
      prometheus: 'blocked',
      tap: 'partial',
    });
    expect(at('4.2.0')).toMatchObject({
      prometheus: 'supported',
      tap: 'partial',
    });
    expect(at('4.3.6')).toMatchObject({
      prometheus: 'supported',
      tap: 'partial',
    });
    expect(at('3.99.0')).toMatchObject({ tap: 'supported' });
    expect(at('4.0.0')).toMatchObject({ tap: 'partial' });
    // No version: the weaker base level, never the better one.
    expect(at(null)).toMatchObject({ prometheus: 'blocked', tap: 'partial' });
  });

  it('CloudAMQP shared is a tight plan: 20 connections, 200 channels, a budget of 2 (A-10)', () => {
    const shared = preset('cloudamqp-shared');

    expect(shared.limits).toEqual({ connectionMax: 20, channelMax: 200 });
    expect(shared.toolConnectionBudget).toBe(2);
    expect(shared.support.firehose).toBe('blocked');
    expect(shared.support.definitions).toBe('blocked');
  });

  it('only a tight plan sets a tool connection budget, and never above 3', () => {
    for (const entry of providerPresets) {
      if (entry.toolConnectionBudget !== undefined) {
        expect(entry.toolConnectionBudget, entry.id).toBeLessThanOrEqual(3);
      }
    }
    expect(preset('amazon-mq').toolConnectionBudget).toBeUndefined();
  });

  it('LavinMQ settles the HTTP get route only with an explicit requeue flag, and has no firehose or event exchange', () => {
    const lavin = preset('self-hosted', null, 'lavinmq');

    expect(lavin.httpGet).toBe('explicit-requeue-flag');
    expect(lavin.support.firehose).toBe('blocked');
    expect(lavin.support.eventExchange).toBe('blocked');
    for (const entry of providerPresets) {
      if (entry.id !== 'lavinmq') {
        expect(entry.httpGet, entry.id).not.toBe('explicit-requeue-flag');
      }
    }
  });

  it('the unknown provider and ApsaraMQ assume nothing', () => {
    const unknown = preset('unknown');

    expect(unknown.limits).toEqual({});
    expect(unknown.httpGet).toBe('unknown');
    expect(new Set(Object.values(unknown.support))).toEqual(new Set(['probe']));
    const apsara = preset('self-hosted', null, 'apsaramq');
    expect(apsara.httpGet).toBe('unknown');
    expect(apsara.support.peek).toBe('blocked');
  });

  it('only the Amazon MQ preset asks for an explicit overflow on taps', () => {
    for (const entry of providerPresets) {
      expect(entry.tapNeedsExplicitOverflow, entry.id).toBe(
        entry.id === 'amazon-mq',
      );
    }
  });

  it('the product, not the provider, picks the preset for a product that is not RabbitMQ', () => {
    expect(presetIdFor({ provider: 'amazon-mq', product: 'lavinmq' })).toBe(
      'lavinmq',
    );
    expect(
      presetIdFor({ provider: 'amazon-mq', product: 'tanzu-rabbitmq' }),
    ).toBe('amazon-mq');
    expect(presetIdFor({ provider: 'k8s-operator', product: 'unknown' })).toBe(
      'k8s-operator',
    );
  });
});
