// The plugin contract: what `pnpm nx g @app/generators:<name>` needs to resolve, and the flag
// names that docs/plan/execution-plan.md section 2.5 (and so the agent skills) promise.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as barrel from './index.ts';
import { repoRoot } from './shared/test-utils.ts';

const pluginRoot = join(repoRoot, 'tools', 'generators');
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller states the shape of the JSON file.
const readJson = <T>(path: string): T =>
  JSON.parse(readFileSync(path, 'utf8')) as T;

interface GeneratorEntry {
  factory: string;
  schema: string;
  description: string;
}
interface Schema {
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

const collection = readJson<{ generators: Record<string, GeneratorEntry> }>(
  join(pluginRoot, 'generators.json'),
);

describe('generators.json', () => {
  it('offers the generators of the M0-08 scope', () => {
    expect(Object.keys(collection.generators).sort()).toEqual([
      'adapter',
      'conformance-cell',
      'decoder',
      'eslint-rule',
      'library',
      'lint-rule',
      'migration',
      'semantics-cell',
      'service-module',
      'ui-feature',
    ]);
  });

  describe.each(Object.entries(collection.generators))('%s', (name, entry) => {
    it('has a factory and a schema on disk', () => {
      expect(existsSync(join(pluginRoot, `${entry.factory}.ts`))).toBe(true);
      expect(existsSync(join(pluginRoot, entry.schema))).toBe(true);
      expect(entry.description.length).toBeGreaterThan(10);
    });

    it('has a strict schema whose required options are declared', () => {
      const schema = readJson<Schema>(join(pluginRoot, entry.schema));

      expect(schema.additionalProperties).toBe(false);
      for (const required of schema.required ?? []) {
        expect(
          Object.keys(schema.properties),
          `${name}: ${required}`,
        ).toContain(required);
      }
    });

    it('exports a default function, also reachable through the barrel', async () => {
      const module = (await import(
        `${join(pluginRoot, entry.factory)}.ts`
      )) as {
        default: unknown;
      };

      expect(module.default).toBeTypeOf('function');
      expect(Object.values(barrel)).toContain(module.default);
    });
  });
});

describe('command forms of docs/plan/execution-plan.md section 2.5', () => {
  const options = (generator: string): string[] => {
    const entry = collection.generators[generator];
    if (!entry) throw new Error(`no generator ${generator}`);
    return Object.keys(
      readJson<Schema>(join(pluginRoot, entry.schema)).properties,
    );
  };

  it.each([
    ['adapter', ['name', 'port', 'confine']],
    ['ui-feature', ['name', 'route']],
    ['eslint-rule', ['id']],
    ['lint-rule', ['id', 'severity', 'since']],
    ['decoder', ['framework', 'tier']],
    ['semantics-cell', ['era', 'queueType', 'protocol', 'action', 'cf']],
    ['conformance-cell', ['id']],
    ['service-module', ['name']],
    ['migration', ['name']],
    ['library', ['name', 'type']],
  ])('%s takes %j', (generator, expected) => {
    expect(options(generator)).toEqual(expect.arrayContaining(expected));
  });

  it('takes the first positional argument as the name or id', () => {
    for (const [name, entry] of Object.entries(collection.generators)) {
      if (name === 'semantics-cell') continue;
      const schema = readJson<{
        properties: Record<
          string,
          { $default?: { $source: string; index: number } }
        >;
      }>(join(pluginRoot, entry.schema));
      const positional = Object.entries(schema.properties).filter(
        ([, property]) => property.$default?.$source === 'argv',
      );
      expect(positional, name).toHaveLength(1);
      expect(positional[0]?.[1].$default?.index).toBe(0);
    }
  });
});

describe('plugin registration', () => {
  it('points package.json at generators.json', () => {
    const manifest = readJson<{ name: string; generators: string }>(
      join(pluginRoot, 'package.json'),
    );

    expect(manifest).toMatchObject({
      name: '@app/generators',
      generators: './generators.json',
    });
  });

  it('registers the @app/generators path alias', () => {
    const base = readJson<{
      compilerOptions: { paths: Record<string, string[]> };
    }>(join(repoRoot, 'tsconfig.base.json'));

    expect(base.compilerOptions.paths['@app/generators']).toEqual([
      './tools/generators/src/index.ts',
    ]);
  });
});
