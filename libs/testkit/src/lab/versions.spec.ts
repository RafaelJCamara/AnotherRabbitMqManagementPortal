import { describe, expect, it } from 'vitest';

import {
  findBroker,
  imageTag,
  loadBrokerVersions,
  parseBrokerVersions,
} from './versions.ts';

const digest = `sha256:${'a'.repeat(64)}`;
const entry = { version: '4.3.6', digest, support: 'tier-1' };

describe('broker versions', () => {
  it('AC-1 lists the five versions of the M0 exit criteria, each pinned by digest', () => {
    const brokers = loadBrokerVersions();
    expect(brokers.map((broker) => broker.version)).toEqual([
      '3.13.7',
      '4.0.9',
      '4.1.8',
      '4.2.9',
      '4.3.6',
    ]);
    for (const broker of brokers) {
      expect(broker.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    expect(new Set(brokers.map((broker) => broker.digest)).size).toBe(5);
  });

  it('refuses a floating tag, a missing digest and a duplicate', () => {
    expect(() =>
      parseBrokerVersions({ brokers: [{ ...entry, version: 'latest' }] }),
    ).toThrow(/exact x\.y\.z/);
    expect(() =>
      parseBrokerVersions({ brokers: [{ ...entry, version: '4.3' }] }),
    ).toThrow(/exact x\.y\.z/);
    expect(() =>
      parseBrokerVersions({ brokers: [{ ...entry, digest: '4.3.6' }] }),
    ).toThrow(/pinned by digest/);
    expect(() =>
      parseBrokerVersions({
        brokers: [{ ...entry, digest: `sha256:${'a'.repeat(63)}` }],
      }),
    ).toThrow(/pinned by digest/);
    expect(() => parseBrokerVersions({ brokers: [entry, entry] })).toThrow(
      /twice/,
    );
    expect(() => parseBrokerVersions([])).toThrow(/"brokers"/);
  });

  it('finds a version or lists the known ones', () => {
    expect(findBroker('4.3.6', [entry]).digest).toBe(digest);
    expect(() => findBroker('4.3.7', [entry])).toThrow(
      'Known versions: 4.3.6.',
    );
  });

  it('tags the local image by version', () => {
    expect(imageTag('4.3.6')).toBe('broker-lab/rabbitmq:4.3.6');
  });
});
