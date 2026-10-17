import { describe, expect, it } from 'vitest';

import {
  diffOf,
  expectFormatted,
  parseJson,
  workspaceTree,
} from '../shared/test-utils.ts';
import { decoderGenerator } from './generator.ts';

const registryFile = 'libs/sdk/header-registry/header-registry.json';

interface Registry {
  frameworks: Record<string, unknown>;
}

describe('decoder', () => {
  it('creates a builtin decoder with registry entry, fixtures and skeleton', async () => {
    const tree = workspaceTree();

    const { created } = await diffOf(tree, () =>
      decoderGenerator(tree, { framework: 'masstransit', tier: 'builtin' }),
    );

    expect(created).toMatchSnapshot();
    await expectFormatted(created);
  });

  it('creates only data for a declarative decoder', async () => {
    const tree = workspaceTree();

    const { created } = await diffOf(tree, () =>
      decoderGenerator(tree, { framework: 'celery', tier: 'declarative' }),
    );

    expect(
      Object.keys(created).filter((path) => path.startsWith('libs/engine')),
    ).toEqual([]);
    expect(
      Object.keys(parseJson<Registry>(created[registryFile]).frameworks),
    ).toEqual(['celery']);
    expect(created['testing/fixtures/messages/celery/README.md']).toContain(
      'celery fixtures',
    );
  });

  it('defaults to the builtin tier', async () => {
    const tree = workspaceTree();

    await decoderGenerator(tree, { framework: 'wolverine' });

    expect(tree.exists('libs/engine/decoders/src/builtin/wolverine.ts')).toBe(
      true,
    );
  });

  it('keeps the registry sorted and registers every builtin decoder', async () => {
    const tree = workspaceTree();
    await decoderGenerator(tree, { framework: 'wolverine' });
    await decoderGenerator(tree, { framework: 'celery', tier: 'declarative' });
    await decoderGenerator(tree, { framework: 'masstransit' });

    const registry = parseJson<Registry>(
      tree.read(registryFile, 'utf-8') ?? '',
    );
    expect(Object.keys(registry.frameworks)).toEqual([
      'celery',
      'masstransit',
      'wolverine',
    ]);
    const index = tree.read(
      'libs/engine/decoders/src/builtin/index.ts',
      'utf-8',
    );
    expect(index).toMatch(/\[\s*wolverineDecoder,\s*masstransitDecoder,?\s*\]/);
  });

  it('refuses a framework that is already registered', async () => {
    const tree = workspaceTree();
    await decoderGenerator(tree, { framework: 'celery', tier: 'declarative' });

    await expect(
      decoderGenerator(tree, { framework: 'celery', tier: 'declarative' }),
    ).rejects.toThrow('already exists');
  });
});
