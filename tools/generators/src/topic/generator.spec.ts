import type { Tree } from '@nx/devkit';
import { describe, expect, it } from 'vitest';

import { serviceModuleGenerator } from '../service-module/generator.ts';
import {
  diffOf,
  expectFormatted,
  filesOf,
  workspaceTree,
} from '../shared/test-utils.ts';
import { topicGenerator } from './generator.ts';
import type { TopicOptions } from './schema.ts';

const TAP: TopicOptions = {
  name: 'tap.messages',
  module: 'svc-tap',
  flow: 'credit',
  qos: 'sampled',
  permission: 'tap.start',
};

async function topicTree(): Promise<Tree> {
  const tree = workspaceTree();
  await serviceModuleGenerator(tree, { name: 'svc-tap' });
  return tree;
}

const generate = async (options: TopicOptions, tree?: Tree) => {
  const target = tree ?? (await topicTree());
  const diff = await diffOf(target, () =>
    topicGenerator(target, options).then(() => undefined),
  );
  return { tree: target, ...diff };
};

type Change = { [K in keyof TopicOptions]?: TopicOptions[K] | undefined };

describe('topic generator: what it creates', () => {
  it('creates the contract, a fixture and a spec for a sampled credit topic', async () => {
    const { created } = await generate(TAP);

    expect(Object.keys(created).sort()).toEqual([
      'libs/engine/svc-tap/src/topics.tap-messages-topic.fixture.ts',
      'libs/engine/svc-tap/src/topics.tap-messages-topic.spec.ts',
      'libs/shared/contracts/src/registry/tap-messages-topic.ts',
    ]);
    expect(created).toMatchSnapshot();
    await expectFormatted(created);
  });

  it('creates a keyed snapshot-delta topic with a latest rate', async () => {
    const { created } = await generate({
      name: 'explorer.window',
      module: 'svc-tap',
      flow: 'snapshot-delta',
      qos: 'latest',
      permission: 'broker.read',
      maxHz: 4,
      ringItems: 500,
      ringBytes: 262144,
    });

    expect(created).toMatchSnapshot();
    await expectFormatted(created);
  });

  it('bounds the ring by default, in items and in bytes (I-6)', async () => {
    const { created } = await generate(TAP);
    const contract =
      created['libs/shared/contracts/src/registry/tap-messages-topic.ts'] ?? '';

    expect(contract).toContain('ring: { items: 1000, bytes: 1048576 }');
    expect(contract).toContain('key: (item) => item.id');
    expect(contract).not.toContain('maxHz');
  });
});

describe('topic generator: registrations', () => {
  it('adds the topic to the registry, the contracts index and the module', async () => {
    const { updated } = await generate(TAP);

    const registry =
      updated['libs/shared/contracts/src/registry/index.ts'] ?? '';
    expect(registry).toContain(
      "import { tapMessagesTopic } from './tap-messages-topic.ts';",
    );
    expect(registry).toMatch(/topics: \[tapMessagesTopic,?\s*\]/);
    expect(updated['libs/shared/contracts/src/index.ts']).toContain(
      "export * from './registry/tap-messages-topic.ts';",
    );
    const topics = updated['libs/engine/svc-tap/src/topics.ts'] ?? '';
    expect(topics).toContain(
      "import { tapMessagesTopic } from '@app/contracts';",
    );
    expect(topics).toMatch(
      /topics: readonly unknown\[\] = \[\s*tapMessagesTopic,?\s*\]/,
    );
  });

  it('leaves the actions of the registry alone', async () => {
    const tree = await topicTree();
    const before =
      filesOf(tree)['libs/shared/contracts/src/registry/index.ts'] ?? '';

    const { updated } = await generate(TAP, tree);

    const after = updated['libs/shared/contracts/src/registry/index.ts'] ?? '';
    expect(after).toContain('actions: [metaGet, opsArm, opsDisarm]');
    expect(before).toContain('actions: [metaGet, opsArm, opsDisarm]');
  });
});

describe('topic generator: refusals', () => {
  const refuses = async (
    options: TopicOptions,
    message: RegExp,
  ): Promise<void> => {
    const tree = await topicTree();
    const before = filesOf(tree);

    await expect(topicGenerator(tree, options)).rejects.toThrow(message);

    expect(filesOf(tree)).toEqual(before);
  };

  it.each<[string, Change, RegExp]>([
    ['an id without a dot', { name: 'tap' }, /must look like namespace\.name/],
    ['an unknown flow', { flow: 'push' }, /--flow must be one of/],
    ['an unknown qos', { qos: 'best-effort' }, /--qos must be one of/],
    [
      'a sampled topic on the snapshot-delta flow',
      { flow: 'snapshot-delta' },
      /needs --flow=credit/,
    ],
    ['a latest topic without a rate', { qos: 'latest' }, /pass --max-hz/],
    [
      'a rate of zero',
      { qos: 'latest', maxHz: 0 },
      /--max-hz must be a positive number/,
    ],
    [
      'a negative ring',
      { ringItems: -1 },
      /--ring-items must be a positive number/,
    ],
    [
      'a ring of a fraction of an item',
      { ringItems: 1.5 },
      /--ring-items must be a whole number/,
    ],
    [
      'an unbounded ring',
      { ringBytes: Infinity },
      /--ring-bytes must be a positive number/,
    ],
    ['a permission without a dot', { permission: 'tap' }, /area\.verb/],
    ['a module that does not exist', { module: 'svc-nope' }, /does not exist/],
    ['a module that is not kebab-case', { module: 'Svc Tap' }, /kebab-case/],
  ])('refuses %s', async (_name, change, message) => {
    await refuses({ ...TAP, ...change } as TopicOptions, message);
  });

  it('refuses a topic id that is already declared', async () => {
    const { tree } = await generate(TAP);

    await expect(topicGenerator(tree, TAP)).rejects.toThrow(/already declared/);
  });

  it('refuses a topic whose id an action already uses', async () => {
    const tree = await topicTree();
    tree.write(
      'libs/shared/contracts/src/registry/other.ts',
      "export const x = defineAction({ id: 'tap.messages' });\n",
    );

    await expect(topicGenerator(tree, TAP)).rejects.toThrow(
      /already declared in/,
    );
  });
});

describe('topic generator: the generated spec', () => {
  it('holds the topic to the kit invariants, the frames it travels in, its key and its module', async () => {
    const { created } = await generate(TAP);
    const spec =
      created['libs/engine/svc-tap/src/topics.tap-messages-topic.spec.ts'] ??
      '';

    expect(spec).toContain('checkRegistry({ actions: [], topics: [topic] })');
    expect(spec).toContain('ServerFrameSchema');
    expect(spec).toContain("t: 'data'");
    expect(spec).toContain('sampledEvery: 2');
    expect(spec).toContain('createTapModule(createTapFakeDeps()).topics');
    expect(spec).toContain('it.todo');
  });

  it('checks a snapshot, then a delta that removes by key, for the snapshot-delta flow', async () => {
    const { created } = await generate({
      ...TAP,
      flow: 'snapshot-delta',
      qos: 'lossless',
    });
    const spec =
      created['libs/engine/svc-tap/src/topics.tap-messages-topic.spec.ts'] ??
      '';

    expect(spec).toContain("t: 'snapshot'");
    expect(spec).toContain("t: 'delta'");
    expect(spec).toContain('removes: [topic.key?.(item)');
    expect(spec).not.toContain('sampledEvery');
  });
});
