import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  diffOf,
  expectFormatted,
  parseJson,
  workspaceTree,
} from '../shared/test-utils.ts';
import {
  ERAS,
  PROTOCOLS,
  QUEUE_TYPES,
  SETTLE_ACTIONS,
  semanticsCellGenerator,
} from './generator.ts';

const root = 'libs/shared/semantics';
const data = `${root}/src/data/settle-matrix.data.ts`;

const base = {
  era: '4.3',
  queueType: 'quorum',
  protocol: 'amqp091',
  action: 'amqp091.nack_requeue',
  cf: 'CF-QQ-42-GUARD-01',
};

describe('semantics-cell', () => {
  it('creates the trust:critical library and a code-derived cell', async () => {
    const tree = workspaceTree();

    const { created } = await diffOf(tree, () =>
      semanticsCellGenerator(tree, base),
    );

    expect(created).toMatchSnapshot();
    expect(
      parseJson<{ tags: string[] }>(created[`${root}/project.json`]).tags,
    ).toEqual(['type:pure', 'runtime:isomorphic', 'trust:critical']);
    await expectFormatted(created);
  });

  it('leaves the effect unset and the evidence empty (I-14)', async () => {
    const tree = workspaceTree();

    await semanticsCellGenerator(tree, base);

    const text = tree.read(data, 'utf-8') ?? '';
    expect(text).toContain('effect: null');
    expect(text).toContain("status: 'code-derived'");
    expect(text).toContain('evidence: []');
    expect(text).toContain("conformance: ['CF-QQ-42-GUARD-01']");
  });

  it('appends further cells and includes the optional key parts in the id', async () => {
    const tree = workspaceTree();
    await semanticsCellGenerator(tree, base);

    await semanticsCellGenerator(tree, {
      ...base,
      era: '4.0-4.2',
      limit: 'finite',
      delayedRetry: 'all',
      cf: 'CF-QQ-42-GUARD-02',
    });

    const text = tree.read(data, 'utf-8') ?? '';
    expect(text).toContain("'SEM-4.3-quorum-amqp091-amqp091.nack_requeue'");
    expect(text).toContain(
      "'SEM-4.0-4.2-quorum-amqp091-amqp091.nack_requeue-limit-finite-delayed-all'",
    );
    expect(text).toContain("limit: 'finite'");
  });

  it('accepts the number the Nx CLI makes of --era=4.3', async () => {
    const tree = workspaceTree();

    await semanticsCellGenerator(tree, { ...base, era: 4.3 });

    expect(tree.read(data, 'utf-8')).toContain("era: '4.3'");
  });

  it('refuses a duplicate cell', async () => {
    const tree = workspaceTree();
    await semanticsCellGenerator(tree, base);

    await expect(semanticsCellGenerator(tree, base)).rejects.toThrow(
      'already has the cell',
    );
  });

  it.each([
    ['era', '5.0'],
    ['queueType', 'lazy'],
    ['protocol', 'mqtt'],
    ['action', 'ack'],
  ])('refuses an unknown %s', async (option, value) => {
    await expect(
      semanticsCellGenerator(workspaceTree(), { ...base, [option]: value }),
    ).rejects.toThrow('must be one of');
  });

  it('refuses a malformed conformance id', async () => {
    await expect(
      semanticsCellGenerator(workspaceTree(), { ...base, cf: 'cf-1' }),
    ).rejects.toThrow('conformance id');
  });

  it('keeps schema.json in step with the accepted values', () => {
    const schema = parseJson<{
      properties: Record<string, { enum?: string[] }>;
    }>(readFileSync(join(import.meta.dirname, 'schema.json'), 'utf8'));

    expect(schema.properties.queueType?.enum).toEqual([...QUEUE_TYPES]);
    expect(schema.properties.protocol?.enum).toEqual([...PROTOCOLS]);
    expect(schema.properties.action?.enum).toEqual([...SETTLE_ACTIONS]);
    expect(ERAS).toEqual(['3.13', '4.0-4.2', '4.3', '4.4']);
  });
});
