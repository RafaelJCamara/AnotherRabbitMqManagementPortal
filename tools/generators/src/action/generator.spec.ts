import type { Tree } from '@nx/devkit';
import { describe, expect, it } from 'vitest';

import { serviceModuleGenerator } from '../service-module/generator.ts';
import { uiFeatureGenerator } from '../ui-feature/generator.ts';
import {
  filesOf,
  diffOf,
  expectFormatted,
  workspaceTree,
} from '../shared/test-utils.ts';
import { actionGenerator } from './generator.ts';
import type { ActionOptions } from './schema.ts';

const LIST: ActionOptions = {
  name: 'explorer.queues.list',
  module: 'svc-catalog',
  feature: 'explorer',
  kind: 'query',
  http: 'GET /connections/{cid}/queues',
  permission: 'broker.read',
  mcp: 'read',
  cli: 'queues list',
};

const PURGE: ActionOptions = {
  name: 'queues.purge',
  module: 'svc-admin',
  kind: 'command',
  http: 'POST /connections/{cid}/queues/{qkey}/purge',
  permission: 'messages.purge',
  risk: 'critical',
  planning: 'required',
  mcp: 'mutating',
  cli: 'queues purge',
};

/** A workspace with the services and UI features the golden paths use. */
async function actionTree(): Promise<Tree> {
  const tree = workspaceTree();
  await serviceModuleGenerator(tree, { name: 'svc-catalog' });
  await serviceModuleGenerator(tree, { name: 'svc-admin' });
  await uiFeatureGenerator(tree, {
    name: 'explorer',
    route: '/c/:cid/explorer',
  });
  await uiFeatureGenerator(tree, { name: 'admin', route: '/c/:cid/admin' });
  return tree;
}

const generate = async (options: ActionOptions, tree?: Tree) => {
  const target = tree ?? (await actionTree());
  const diff = await diffOf(target, () =>
    actionGenerator(target, options).then(() => undefined),
  );
  return { tree: target, ...diff };
};

describe('action generator: what it creates', () => {
  it('creates the contract, stub, fixture, unit spec, HTTP spec and UI command for a query', async () => {
    const { created } = await generate(LIST);

    expect(Object.keys(created).sort()).toEqual([
      'libs/engine/svc-catalog/src/actions/explorer-queues-list.fixture.ts',
      'libs/engine/svc-catalog/src/actions/explorer-queues-list.spec.ts',
      'libs/engine/svc-catalog/src/actions/explorer-queues-list.ts',
      'libs/shared/contracts/src/registry/explorer-queues-list.ts',
      'libs/testkit/src/http/explorer-queues-list.http.spec.ts',
      'libs/ui/feature-explorer/src/commands/explorer-queues-list.command.spec.ts',
      'libs/ui/feature-explorer/src/commands/explorer-queues-list.command.ts',
    ]);
    expect(created).toMatchSnapshot();
    await expectFormatted(created);
  });

  it('creates the same files for a planned, critical command with two path parameters', async () => {
    const { created } = await generate(PURGE);

    expect(created).toMatchSnapshot();
    await expectFormatted(created);
  });

  it('creates a job action that answers 202 and has no UI command with --feature=none', async () => {
    const { created } = await generate({
      name: 'jobs.start-purge',
      module: 'svc-admin',
      kind: 'job',
      http: 'POST /connections/{cid}/purge-jobs',
      permission: 'messages.purge',
      risk: 'high',
      planning: 'optional',
      feature: 'none',
    });

    expect(
      Object.keys(created).some((path) => path.startsWith('libs/ui/')),
    ).toBe(false);
    expect(created).toMatchSnapshot();
    await expectFormatted(created);
  });

  it('declares nothing HTTP-shaped without --http, and so writes no HTTP spec', async () => {
    const { created } = await generate({
      name: 'queues.reindex',
      module: 'svc-admin',
      kind: 'command',
      permission: 'topology.admin',
      risk: 'low',
      planning: 'none',
    });

    expect(Object.keys(created).some((path) => path.includes('/http/'))).toBe(
      false,
    );
    expect(
      created['libs/shared/contracts/src/registry/queues-reindex.ts'],
    ).not.toContain('http:');
  });
});

describe('action generator: what the contract says', () => {
  const contractOf = async (options: ActionOptions): Promise<string> => {
    const { created } = await generate(options);
    const [path] = Object.keys(created).filter((file) =>
      file.includes('/contracts/'),
    );
    return created[path ?? ''] ?? '';
  };

  it('puts path parameters in the strict input and the connection in the target', async () => {
    const contract = await contractOf(PURGE);

    expect(contract).toContain('cid: ConnectionIdSchema');
    expect(contract).toContain('qkey: ObjectKeySchema');
    expect(contract).toContain('z.strictObject');
    expect(contract).toContain(
      'target: (input) => ({ connectionId: input.cid })',
    );
  });

  it('audits every mutation with attempt and outcome, and a plain query with none', async () => {
    expect(await contractOf(PURGE)).toContain("audit: 'attempt+outcome'");
    expect(await contractOf(LIST)).toContain("audit: 'none'");
  });

  it('audits a query whose MCP tool is mutating, because that is a mutation', async () => {
    const contract = await contractOf({
      ...LIST,
      mcp: 'mutating',
      risk: 'low',
      planning: 'optional',
    });

    expect(contract).toContain("audit: 'attempt+outcome'");
    expect(contract).toContain('mutating: true');
  });

  it('exposes MCP only as asked: read is not mutating, none is absent', async () => {
    expect(await contractOf(LIST)).toContain('mutating: false');
    expect(await contractOf({ ...LIST, mcp: 'none' })).not.toContain('mcp:');
  });

  it('keeps the summary on one quoted line and defaults it to the id in words', async () => {
    expect(await contractOf(LIST)).toContain("summary: 'Explorer queues list'");
    expect(await contractOf({ ...LIST, summary: "It's here" })).toContain(
      'summary: "It\'s here"',
    );
  });
});

describe('action generator: registrations', () => {
  it('adds the contract to the registry and the contracts index', async () => {
    const { updated } = await generate(PURGE);

    const registry =
      updated['libs/shared/contracts/src/registry/index.ts'] ?? '';
    expect(registry).toContain(
      "import { queuesPurge } from './queues-purge.ts';",
    );
    expect(registry).toMatch(/actions: \[[^\]]*queuesPurge,?\s*\]/);
    expect(updated['libs/shared/contracts/src/index.ts']).toContain(
      "export * from './registry/queues-purge.ts';",
    );
  });

  it('lists the action in its module and exports it', async () => {
    const { updated } = await generate(PURGE);

    expect(updated['libs/engine/svc-admin/src/actions/index.ts']).toContain(
      "import { createQueuesPurgeAction } from './queues-purge';",
    );
    expect(updated['libs/engine/svc-admin/src/actions/index.ts']).toMatch(
      /ActionImpl\)\[\] = \[\s*createQueuesPurgeAction,?\s*\];/,
    );
    expect(updated['libs/engine/svc-admin/src/index.ts']).toContain(
      "export { createQueuesPurgeAction } from './actions/queues-purge';",
    );
  });

  it('adds the plan-purity manifest entry with a sample input', async () => {
    const { updated } = await generate(PURGE);
    const manifest =
      updated['tools/arch-tests/src/registered-actions.ts'] ?? '';

    expect(manifest).toContain(
      "import { createQueuesPurgeAction } from '@app/svc-admin';",
    );
    expect(manifest).toContain(
      "import { createAdminFakeDeps } from '@app/svc-admin';",
    );
    expect(manifest).toContain(
      "path: 'libs/engine/svc-admin/src/actions/queues-purge.ts'",
    );
    expect(manifest).toContain(
      'impl: createQueuesPurgeAction(createAdminFakeDeps())',
    );
    expect(manifest).toContain("input: { cid: 'c1', qkey: 'LwBvcmRlcnM' }");
  });

  it('adds the UI command to the feature index and its title to the i18n scope', async () => {
    const { updated } = await generate(LIST);

    expect(updated['libs/ui/feature-explorer/src/index.ts']).toContain(
      "export { explorerQueuesListCommand } from './commands/explorer-queues-list.command';",
    );
    expect(
      JSON.parse(updated['libs/ui/feature-explorer/src/i18n/en.json'] ?? '{}'),
    ).toEqual({
      explorer: {
        title: 'Explorer',
        commands: { explorerQueuesList: 'Explorer queues list' },
      },
    });
  });

  it('writes the i18n title as data even when the feature or the command is named like an Object property', async () => {
    const tree = await actionTree();
    await uiFeatureGenerator(tree, { name: 'constructor', route: '/c/:cid/c' });

    const { updated } = await generate(
      {
        ...LIST,
        name: 'to.string',
        http: 'GET /connections/{cid}/to-string',
        feature: 'constructor',
      },
      tree,
    );

    const en = JSON.parse(
      updated['libs/ui/feature-constructor/src/i18n/en.json'] ?? '{}',
    ) as Record<string, unknown>;
    expect(Object.keys(en)).toEqual(['constructor']);
    expect(en.constructor).toEqual({
      title: 'Constructor',
      commands: { toString: 'To string' },
    });
    // Nothing leaked onto the prototype of every object.
    expect(({} as Record<string, unknown>).commands).toBeUndefined();
  });

  it('does not read a missing i18n scope through the prototype', async () => {
    const tree = await actionTree();
    await uiFeatureGenerator(tree, { name: 'constructor', route: '/c/:cid/c' });
    tree.write('libs/ui/feature-constructor/src/i18n/en.json', '{}');

    const { updated } = await generate(
      { ...LIST, feature: 'constructor' },
      tree,
    );

    expect(
      JSON.parse(
        updated['libs/ui/feature-constructor/src/i18n/en.json'] ?? '{}',
      ),
    ).toEqual({
      constructor: { commands: { explorerQueuesList: 'Explorer queues list' } },
    });
  });

  it('keeps a title someone wrote, and refuses to replace an i18n scope that is not an object', async () => {
    const tree = await actionTree();
    const path = 'libs/ui/feature-explorer/src/i18n/en.json';
    tree.write(
      path,
      JSON.stringify({
        explorer: {
          title: 'Explorer',
          commands: { explorerQueuesList: 'Mine' },
        },
      }),
    );
    const kept = await generate(LIST, tree);
    expect(JSON.parse(kept.updated[path] ?? '{}')).toMatchObject({
      explorer: { commands: { explorerQueuesList: 'Mine' } },
    });

    const broken = await actionTree();
    broken.write(path, JSON.stringify({ explorer: 'text' }));
    await expect(actionGenerator(broken, LIST)).rejects.toThrow(
      /is not an object/,
    );
  });

  it('adds a second action beside the first without touching it', async () => {
    const first = await generate(PURGE);
    const second = await generate(
      {
        ...PURGE,
        name: 'queues.delete',
        http: 'DELETE /connections/{cid}/queues/{qkey}',
      },
      first.tree,
    );

    const files = filesOf(second.tree);
    expect(files['libs/engine/svc-admin/src/actions/index.ts']).toContain(
      'createQueuesPurgeAction',
    );
    expect(files['libs/engine/svc-admin/src/actions/index.ts']).toContain(
      'createQueuesDeleteAction',
    );
    expect(files['libs/shared/contracts/src/registry/index.ts']).toContain(
      'queuesDelete]',
    );
  });
});

type Change = { [K in keyof ActionOptions]?: ActionOptions[K] | undefined };

describe('action generator: refusals', () => {
  const refuses = async (
    options: ActionOptions,
    message: RegExp,
  ): Promise<void> => {
    const tree = await actionTree();
    const before = filesOf(tree);

    await expect(actionGenerator(tree, options)).rejects.toThrow(message);

    // Nothing was written: the refusal comes before the first file.
    expect(filesOf(tree)).toEqual(before);
  };

  it.each<[string, Change, RegExp]>([
    [
      'an id without a dot',
      { name: 'purge' },
      /must look like namespace\.name/,
    ],
    [
      'an id in capitals',
      { name: 'Queues.Purge' },
      /must look like namespace\.name/,
    ],
    ['an unknown kind', { kind: 'mutation' }, /--kind must be one of/],
    [
      'a command without risk',
      { risk: undefined },
      /state --risk and --planning/,
    ],
    [
      'a command without planning',
      { planning: undefined },
      /state --risk and --planning/,
    ],
    [
      'a critical action that is not planned',
      { planning: 'none' },
      /must be planned/,
    ],
    [
      'a high-risk action that is not planned',
      { risk: 'high', planning: 'none' },
      /must be planned/,
    ],
    [
      'a query with a mutating MCP tool and no stated risk',
      {
        kind: 'query',
        http: 'GET /connections/{cid}/probe',
        risk: undefined,
        planning: undefined,
      },
      /state --risk and --planning/,
    ],
    [
      'a critical query with a mutating MCP tool that is not planned',
      {
        kind: 'query',
        http: 'GET /connections/{cid}/probe',
        planning: 'none',
      },
      /must be planned/,
    ],
    ['a command presented as a read tool', { mcp: 'read' }, /read tool/],
    [
      'a command bound to GET',
      { http: 'GET /connections/{cid}/purge' },
      /GET can only be bound to a query/,
    ],
    [
      'a path outside the router alphabet',
      { http: 'POST /a/b%2Fc' },
      /may only hold letters/,
    ],
    ['an empty path segment', { http: 'POST /a//b' }, /may only hold letters/],
    [
      'a path parameter twice',
      { http: 'POST /a/{cid}/b/{cid}' },
      /unique name/,
    ],
    [
      'a path parameter with odd characters',
      { http: 'POST /a/{c-id}' },
      /unique name/,
    ],
    [
      'a method that does not exist',
      { http: 'TRACE /a' },
      /method "TRACE" must be one of/,
    ],
    [
      'an http binding without a path',
      { http: 'POST' },
      /must be METHOD \/path/,
    ],
    ['a permission without a dot', { permission: 'purge' }, /area\.verb/],
    [
      'a three-part permission',
      { permission: 'messages.peek.budgeted' },
      /area\.verb/,
    ],
    [
      'a permission in capitals',
      { permission: 'Messages.Purge' },
      /area\.verb/,
    ],
    ['a cli command with a quote', { cli: "queues' purge" }, /must be words/],
    ['a bad since', { since: 'v1' }, /major\.minor/],
    ['a multi-line summary', { summary: 'one\ntwo' }, /one line/],
    [
      'a summary that claims a read-only peek',
      { summary: 'A read-only look at messages' },
      /side-effect-aware peek/,
    ],
    [
      'a summary that says non-destructive',
      { summary: 'Non-destructive peek' },
      /side-effect-aware peek/,
    ],
    ['a module that is not kebab-case', { module: '../kernel' }, /kebab-case/],
    ['a module that does not exist', { module: 'svc-nope' }, /does not exist/],
    [
      'a UI feature that does not exist',
      { feature: 'nope' },
      /Create it first/,
    ],
  ])('refuses %s', async (_name, change, message) => {
    // Object.assign: a `risk: undefined` in a change removes the option, as leaving it out does.
    await refuses(Object.assign({}, PURGE, change), message);
  });

  it('refuses a project that is not a service module', async () => {
    const tree = await actionTree();
    // A project named like a service but tagged as something else must not be written into.
    tree.write(
      'libs/engine/svc-fake/project.json',
      JSON.stringify({ name: 'svc-fake', tags: ['type:kernel'] }),
    );

    await expect(
      actionGenerator(tree, { ...PURGE, module: 'svc-fake' }),
    ).rejects.toThrow(/not the type:service project/);
  });

  it('refuses an id that is already declared, and an endpoint that is already bound', async () => {
    const { tree } = await generate(PURGE);

    await expect(
      actionGenerator(tree, { ...PURGE, http: 'POST /other' }),
    ).rejects.toThrow(/action id "queues\.purge" is already declared/);
    await expect(
      actionGenerator(tree, {
        ...PURGE,
        name: 'queues.empty',
        http: 'POST /connections/{id}/queues/{k}/purge',
      }),
    ).rejects.toThrow(/already bound by an action/);
  });

  it('refuses to overwrite a file that is already there', async () => {
    const tree = await actionTree();
    tree.write(
      'libs/engine/svc-admin/src/actions/queues-purge.fixture.ts',
      '// mine\n',
    );

    await expect(actionGenerator(tree, PURGE)).rejects.toThrow(
      /Refusing to overwrite/,
    );
    expect(
      tree.read(
        'libs/engine/svc-admin/src/actions/queues-purge.fixture.ts',
        'utf-8',
      ),
    ).toBe('// mine\n');
  });

  it('fails clearly when the architecture manifest is missing', async () => {
    const tree = await actionTree();
    tree.delete('tools/arch-tests/src/registered-actions.ts');

    await expect(actionGenerator(tree, PURGE)).rejects.toThrow(
      /architecture tests/,
    );
  });
});

describe('action generator: the generated tests state the invariants', () => {
  const specOf = async (options: ActionOptions): Promise<string> => {
    const { created } = await generate(options);
    const [path] = Object.keys(created).filter((file) =>
      file.endsWith(
        '/actions/' + options.name.replaceAll('.', '-') + '.spec.ts',
      ),
    );
    return created[path ?? ''] ?? '';
  };

  it('checks plan purity, deny by default, audit attempt and outcome, and the receipt of a mutation', async () => {
    const spec = await specOf(PURGE);

    expect(spec).toContain('checkPlanPurity');
    expect(spec).toContain('denyAllAuthorizer');
    expect(spec).toContain("code: 'FORBIDDEN_RBAC'");
    expect(spec).toContain('engine.audit.attempts');
    expect(spec).toContain('attemptSeq: 1');
    expect(spec).toContain('engine.receipts.records');
  });

  it('checks a query leaves no audit row and no receipt, and has no plan to purify', async () => {
    const spec = await specOf(LIST);

    expect(spec).not.toContain('checkPlanPurity');
    expect(spec).toContain('a query leaves no audit row and no receipt');
  });

  it('expects a job action to answer with a job', async () => {
    const spec = await specOf({
      ...PURGE,
      name: 'jobs.start-purge',
      kind: 'job',
    });

    expect(spec).toContain("expect(done.kind).toBe('job')");
  });

  it('stubs execute, plan and revalidate with a Problem that fails until implemented', async () => {
    const { created } = await generate(PURGE);
    const stub =
      created['libs/engine/svc-admin/src/actions/queues-purge.ts'] ?? '';

    expect(stub).toContain("new AppError('INTERNAL'");
    expect(stub).toContain('plan: () => Promise.reject(notImplemented())');
    expect(stub).toContain(
      'revalidate: () => Promise.reject(notImplemented())',
    );
    expect(stub).toContain('execute: () => Promise.reject(notImplemented())');
    const code = stub
      .split('\n')
      .filter((line) => !line.startsWith('//'))
      .join('\n');
    expect(code).not.toContain('ctx.writes');
  });

  it('gives a plain query no plan or revalidate stub, because implementAction wants none', async () => {
    const { created } = await generate(LIST);
    const stub =
      created['libs/engine/svc-catalog/src/actions/explorer-queues-list.ts'] ??
      '';

    expect(stub).not.toContain('plan:');
    expect(stub).not.toContain('revalidate:');
  });

  it('expects 428 and a plan for a critical command over HTTP, and 200 for a query', async () => {
    const purge =
      (await generate(PURGE)).created[
        'libs/testkit/src/http/queues-purge.http.spec.ts'
      ] ?? '';
    const list =
      (await generate(LIST)).created[
        'libs/testkit/src/http/explorer-queues-list.http.spec.ts'
      ] ?? '';

    expect(purge).toContain('expect(answer.statusCode).toBe(428)');
    expect(purge).toContain("code: 'PLAN_REQUIRED'");
    expect(purge).toContain("'idempotency-key': KEY");
    expect(list).toContain('expect(answer.statusCode).toBe(200)');
    expect(list).not.toContain('idempotency-key');
  });

  it('arms the connection of the path before a mutation runs, and not for a query', async () => {
    const purge =
      (await generate(PURGE)).created[
        'libs/testkit/src/http/queues-purge.http.spec.ts'
      ] ?? '';
    const list =
      (await generate(LIST)).created[
        'libs/testkit/src/http/explorer-queues-list.http.spec.ts'
      ] ?? '';

    expect(purge).toContain("engine.arm('c1')");
    expect(list).not.toContain('engine.arm');
  });
});
