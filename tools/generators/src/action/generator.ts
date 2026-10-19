// Blueprint 4, "How an agent adds an endpoint". One command adds an action to the engine, test
// first: the contract, an `implementAction` stub whose bodies fail, the registrations, a unit spec
// (contract, plan purity, deny by default, audit attempt and outcome, receipt), an HTTP spec and a
// UI command stub. Nothing is overwritten, and a check that fails writes nothing.
import { logger, type Tree } from '@nx/devkit';

import {
  appendToArray,
  appendToPropertyArray,
  appendImport,
  appendLine,
} from '../shared/source-edit.ts';
import {
  CONTRACTS_INDEX,
  MANIFEST,
  REGISTRY_DIR,
  REGISTRY_INDEX,
  assertEndpointFree,
  assertFree,
  assertIdFree,
  requireFeature,
  requireService,
} from '../shared/service.ts';
import { Writer } from '../shared/writer.ts';
import { parseAction, type ActionModel } from './model.ts';
import type { ActionOptions } from './schema.ts';
import {
  actionFile,
  commandFile,
  commandSpecFile,
  contractFile,
  fixtureFile,
  httpSpecFile,
  sampleInputText,
  unitSpecFile,
} from './templates.ts';

interface Plan {
  /** Files to create, by path. */
  created: Record<string, string>;
  serviceRoot: string;
  featureRoot: string | undefined;
}

function plan(writer: Writer, model: ActionModel): Plan {
  const serviceRoot = requireService(writer, model.module);
  const featureRoot =
    model.feature === undefined
      ? undefined
      : requireFeature(writer, model.feature);
  assertIdFree(writer, model.id, 'action');
  if (model.http !== undefined) {
    assertEndpointFree(writer, model.http.method, model.http.path);
  }

  const created: Record<string, string> = {
    [`${REGISTRY_DIR}/${model.stem}.ts`]: contractFile(model),
    [`${serviceRoot}/src/actions/${model.stem}.ts`]: actionFile(model),
    [`${serviceRoot}/src/actions/${model.stem}.fixture.ts`]: fixtureFile(model),
    [`${serviceRoot}/src/actions/${model.stem}.spec.ts`]: unitSpecFile(model),
  };
  if (model.http !== undefined) {
    created[`libs/testkit/src/http/${model.stem}.http.spec.ts`] =
      httpSpecFile(model);
  }
  if (featureRoot !== undefined) {
    created[`${featureRoot}/src/commands/${model.stem}.command.ts`] =
      commandFile(model);
    created[`${featureRoot}/src/commands/${model.stem}.command.spec.ts`] =
      commandSpecFile(model);
  }
  assertFree(writer, Object.keys(created));
  return { created, serviceRoot, featureRoot };
}

/** A key of parsed JSON, set as an own data property: no key can reach a prototype. */
function define(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** The object at `key` (its own property, not an inherited one), created when absent. */
function ownObject(
  parent: Record<string, unknown>,
  key: string,
  file: string,
): Record<string, unknown> {
  if (!Object.hasOwn(parent, key)) {
    const created: Record<string, unknown> = {};
    define(parent, key, created);
    return created;
  }
  const existing = parent[key];
  if (
    typeof existing !== 'object' ||
    existing === null ||
    Array.isArray(existing)
  ) {
    throw new Error(
      `${file}: "${key}" is not an object; refusing to replace what is there.`,
    );
  }
  return existing as Record<string, unknown>;
}

/** Rewrites an existing file through `edit`, or fails with the hint when it is missing. */
function edit(
  writer: Writer,
  path: string,
  hint: string,
  change: (text: string) => string,
): void {
  writer.write(path, change(writer.require(path, hint)));
}

function register(writer: Writer, model: ActionModel, where: Plan): void {
  const { camel, stem } = model;
  const factory = `create${model.pascal}Action`;
  edit(writer, REGISTRY_INDEX, 'The contract registry must exist.', (text) =>
    appendToPropertyArray(
      appendImport(
        text,
        REGISTRY_INDEX,
        `import { ${camel} } from './${stem}.ts';`,
      ),
      REGISTRY_INDEX,
      'registry',
      'actions',
      camel,
    ),
  );
  edit(writer, CONTRACTS_INDEX, 'The contracts index must exist.', (text) =>
    appendLine(text, `export * from './registry/${stem}.ts';`),
  );

  const actions = `${where.serviceRoot}/src/actions/index.ts`;
  edit(
    writer,
    actions,
    `Was ${model.module} made by the service-module generator?`,
    (text) =>
      appendToArray(
        appendImport(text, actions, `import { ${factory} } from './${stem}';`),
        actions,
        'actionFactories',
        factory,
      ),
  );
  const index = `${where.serviceRoot}/src/index.ts`;
  edit(
    writer,
    index,
    `Was ${model.module} made by the service-module generator?`,
    (text) =>
      appendLine(text, `export { ${factory} } from './actions/${stem}';`),
  );

  // The plan-purity manifest of the architecture tests: one entry per implementAction call site.
  const fakes = `create${model.modulePascal}FakeDeps`;
  edit(
    writer,
    MANIFEST,
    'The architecture tests (tools/arch-tests) must exist.',
    (text) =>
      appendToArray(
        appendImport(
          appendImport(
            text,
            MANIFEST,
            `import { ${factory} } from '@app/${model.module}';`,
          ),
          MANIFEST,
          `import { ${fakes} } from '@app/${model.module}';`,
        ),
        MANIFEST,
        'manifest',
        `{ path: '${where.serviceRoot}/src/actions/${stem}.ts', impl: ${factory}(${fakes}()), input: ${sampleInputText(model)} }`,
      ),
  );

  if (where.featureRoot !== undefined && model.feature !== undefined) {
    const featureIndex = `${where.featureRoot}/src/index.ts`;
    edit(
      writer,
      featureIndex,
      `Was feature-${model.feature} made by the ui-feature generator?`,
      (text) =>
        appendLine(
          text,
          `export { ${camel}Command } from './commands/${stem}.command';`,
        ),
    );
    const i18n = `${where.featureRoot}/src/i18n/en.json`;
    edit(
      writer,
      i18n,
      `Was feature-${model.feature} made by the ui-feature generator?`,
      (text) => {
        const scopes = JSON.parse(text) as Record<string, unknown>;
        const commands = ownObject(
          ownObject(scopes, model.feature ?? '', i18n),
          'commands',
          i18n,
        );
        // A title someone already wrote is theirs.
        if (!Object.hasOwn(commands, camel))
          define(commands, camel, model.summary);
        return `${JSON.stringify(scopes, null, 2)}\n`;
      },
    );
  }
}

export async function actionGenerator(
  tree: Tree,
  options: ActionOptions,
): Promise<() => void> {
  const writer = new Writer(tree);
  const model = parseAction(options);
  const where = plan(writer, model);

  for (const [path, content] of Object.entries(where.created)) {
    writer.write(path, content);
  }
  register(writer, model, where);
  await writer.flush();

  return () => {
    logger.info(
      [
        `${model.id} is declared and registered; its tests fail until it is implemented.`,
        `1. Describe the real input and output in ${REGISTRY_DIR}/${model.stem}.ts, then add a value for each new required field to ${where.serviceRoot}/src/actions/${model.stem}.fixture.ts.`,
        `2. Implement ${where.serviceRoot}/src/actions/${model.stem}.ts (see docs/golden-path/).`,
        `3. pnpm nx run contracts:api-docs   (regenerates the committed OpenAPI and AsyncAPI documents)`,
        `4. pnpm nx run-many -t lint typecheck test -p ${model.module},testkit,arch-tests,contracts`,
        `5. pnpm nx run contracts:api-docs-check`,
      ].join('\n'),
    );
  };
}

export default actionGenerator;
