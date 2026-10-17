// A decoder for a messaging framework (ADR-022, DC-53). Every decoder gets a header-registry
// entry (libs/sdk/header-registry) and a fixture folder (testing/fixtures/messages/<framework>).
// The `builtin` tier also gets a code skeleton in libs/engine/decoders; the `declarative` tier is
// pure data interpreted by the generic decoder, so it gets nothing else.
import type { Tree } from '@nx/devkit';

import { ensureLibrary, type LibrarySpec } from '../shared/library.ts';
import { assertKebab, nameVariants, quote } from '../shared/names.ts';
import { appendImport, appendToArray } from '../shared/source-edit.ts';
import { Writer } from '../shared/writer.ts';
import type { DecoderOptions } from './schema.ts';

const DECODERS = 'libs/engine/decoders';
const REGISTRY_LIB = 'libs/sdk/header-registry';
const REGISTRY_FILE = `${REGISTRY_LIB}/header-registry.json`;
const FIXTURES = 'testing/fixtures/messages';
const BUILTIN_INDEX = `${DECODERS}/src/builtin/index.ts`;

// Mirrors docs/architecture/core-interfaces.md, "Plugin SDK (DC-53)". Replace the file with
// imports from @app/contracts once the contracts kit exports these types.
const DECODER_TYPES = `export type TypedHeaderValue =
  | {
      t:
        | 'string'
        | 'long'
        | 'int'
        | 'short'
        | 'byte'
        | 'double'
        | 'float'
        | 'bool'
        | 'timestamp'
        | 'decimal'
        | 'bytes'
        | 'void';
      v: unknown;
    }
  | { t: 'array'; v: TypedHeaderValue[] }
  | { t: 'table'; v: Record<string, TypedHeaderValue> };

export interface DecodeInput {
  headers: Readonly<Record<string, TypedHeaderValue>>;
  properties: Readonly<Record<string, unknown>>;
  body: Uint8Array;
  bodyTruncated: boolean;
  queue?: string;
  protocol: 'amqp091' | 'amqp10';
  era: string;
}

export interface NormalizedFailure {
  framework: string;
  messageId?: string;
  logicalIds: Record<string, string>;
  exception?: { type?: string; message?: string; frames?: string[] };
  deaths: {
    queue: string;
    reason: 'rejected' | 'expired' | 'maxlen' | 'delivery_limit';
    count: number;
    scheduledNotFailed?: boolean;
  }[];
  infrastructure?: 'delay' | 'retry' | 'none';
}

export interface DecoderPlugin {
  apiVersion: 1;
  id: string;
  tier: 'builtin' | 'declarative' | 'sandboxed';
  frameworks: readonly string[];
  /** 0 means "not this framework", 1 means certain. */
  detect(message: DecodeInput): number;
  decode(message: DecodeInput): NormalizedFailure;
  fingerprint(
    failure: NormalizedFailure,
    level: 'type' | 'type+frame' | 'type+frame+template',
  ): string;
  replayPlan(
    failure: NormalizedFailure,
    context: { knownQueues: ReadonlySet<string> },
  ): {
    destinationQueue?: string;
    stripHeaders: string[];
    preserveIds: string[];
    confidence: number;
  } | null;
}
`;

function decodersLibrary(): LibrarySpec {
  return {
    name: 'decoders',
    type: 'adapter',
    runtime: 'node',
    root: DECODERS,
    trustCritical: false,
    importPath: '@app/decoders',
    projectType: 'library',
    readme: {
      purpose:
        'Decoders that turn a failed message into a normalised failure (DC-53): the built-in code decoders and the generic declarative engine.',
      publicApi: [
        '`builtinDecoders`: every built-in decoder.',
        '`DecoderPlugin`, `DecodeInput`, `NormalizedFailure`, `TypedHeaderValue`: the plugin shape.',
      ],
      invariants: [
        'A decoder never throws on a message it does not recognise: `detect` returns 0.',
        'Most frameworks are pure data in `libs/sdk/header-registry`; code is only for body envelopes and fingerprints.',
        'Every decoder has fixtures in `testing/fixtures/messages/<framework>`.',
      ],
      proof: ['pnpm nx test decoders'],
    },
    files: {
      'src/index.ts': `export type {
  DecodeInput,
  DecoderPlugin,
  NormalizedFailure,
  TypedHeaderValue,
} from './types';
export { builtinDecoders } from './builtin';
`,
      'src/types.ts': DECODER_TYPES,
      'src/builtin/index.ts': `import type { DecoderPlugin } from '../types';

export const builtinDecoders: readonly DecoderPlugin[] = [];
`,
      'src/index.spec.ts': `import { describe, expect, it } from 'vitest';

import * as api from './index';

describe('decoders public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual(['builtinDecoders']);
  });
});
`,
    },
  };
}

function registryLibrary(): LibrarySpec {
  return {
    name: 'header-registry',
    type: 'sdk',
    runtime: 'isomorphic',
    root: REGISTRY_LIB,
    trustCritical: false,
    importPath: '@app/header-registry',
    projectType: 'library',
    readme: {
      purpose:
        'The machine-readable header registry (DC-53): per framework, the header mappings, queue naming conventions and delay-infrastructure patterns that the declarative decoder interprets.',
      publicApi: ['`header-registry.json`: the registry, published as data.'],
      invariants: [
        'Frameworks are sorted by id, and each has `displayName`, `headers`, `queueConventions` and `delayPatterns`.',
        'The file is data only; code belongs in a built-in decoder.',
      ],
    },
    files: {
      'src/index.ts': `// The registry itself is header-registry.json at the project root.
export {};
`,
      'src/index.spec.ts': `import { describe, expect, it } from 'vitest';

import * as api from './index';

describe('header-registry public API', () => {
  it('exports no code', () => {
    expect(Object.keys(api)).toEqual([]);
  });
});
`,
      'header-registry.json': `${JSON.stringify({ version: 1, frameworks: {} }, null, 2)}\n`,
    },
  };
}

interface Registry {
  version: number;
  frameworks: Record<string, unknown>;
}

export function builtinDecoderFiles(
  framework: string,
  camel: string,
): Record<string, string> {
  return {
    [`src/builtin/${framework}.ts`]: `import type { DecoderPlugin } from '../types';

export const ${camel}Decoder: DecoderPlugin = {
  apiVersion: 1,
  id: ${quote(`builtin.${framework}`)},
  tier: 'builtin',
  frameworks: [${quote(framework)}],
  // 0 means "not ${framework}", 1 means certain. Never claims a message until implemented.
  detect: () => 0,
  decode: () => {
    throw new Error('The ${framework} decoder does not implement decode yet.');
  },
  fingerprint: () => {
    throw new Error('The ${framework} decoder does not implement fingerprint yet.');
  },
  replayPlan: () => null,
};
`,
    [`src/builtin/${framework}.spec.ts`]: `import { describe, expect, it } from 'vitest';

import type { DecodeInput } from '../types';
import { ${camel}Decoder } from './${framework}';

const empty: DecodeInput = {
  headers: {},
  properties: {},
  body: new Uint8Array(),
  bodyTruncated: false,
  protocol: 'amqp091',
  era: '4.3',
};

describe('${framework} decoder', () => {
  it('does not claim a message with no framework headers', () => {
    expect(${camel}Decoder.detect(empty)).toBe(0);
  });

  it.todo('decodes every message in testing/fixtures/messages/${framework}');
});
`,
  };
}

const FIXTURE_README = (framework: string): string => `# ${framework} fixtures

Recorded messages from ${framework} that the ${framework} decoder must handle. One JSON file per
case, named after the case, holding the \`DecodeInput\` fields (headers, properties, body as base64)
and an \`expected\` object with the normalised failure.

Record fixtures from a real run; do not write them from memory.
`;

export async function decoderGenerator(
  tree: Tree,
  options: DecoderOptions,
): Promise<void> {
  const writer = new Writer(tree);
  assertKebab(options.framework, 'framework');
  const framework = options.framework;
  const tier = options.tier ?? 'builtin';
  const { camel, pascal } = nameVariants(framework);
  const fixtureDir = `${FIXTURES}/${framework}`;
  if (writer.exists(`${fixtureDir}/README.md`)) {
    throw new Error(`${fixtureDir} already exists.`);
  }

  ensureLibrary(writer, registryLibrary());
  const registry = writer.readJson<Registry>(REGISTRY_FILE);
  if (framework in registry.frameworks) {
    throw new Error(`${REGISTRY_FILE} already has an entry for ${framework}.`);
  }
  registry.frameworks = Object.fromEntries(
    Object.entries({
      ...registry.frameworks,
      [framework]: {
        displayName: pascal,
        headers: {},
        queueConventions: [],
        delayPatterns: [],
      },
    }).sort(([a], [b]) => a.localeCompare(b)),
  );
  writer.writeJson(REGISTRY_FILE, registry);

  writer.write(`${fixtureDir}/README.md`, FIXTURE_README(framework));

  if (tier === 'builtin') {
    ensureLibrary(writer, decodersLibrary());
    const index = writer.require(
      BUILTIN_INDEX,
      `${DECODERS} exists but has no builtin registry; restore src/builtin/index.ts.`,
    );
    if (writer.exists(`${DECODERS}/src/builtin/${framework}.ts`)) {
      throw new Error(
        `${DECODERS}/src/builtin/${framework}.ts already exists.`,
      );
    }
    for (const [path, content] of Object.entries(
      builtinDecoderFiles(framework, camel),
    )) {
      writer.write(`${DECODERS}/${path}`, content);
    }
    const withImport = appendImport(
      index,
      BUILTIN_INDEX,
      `import { ${camel}Decoder } from './${framework}';`,
    );
    writer.write(
      BUILTIN_INDEX,
      appendToArray(
        withImport,
        BUILTIN_INDEX,
        'builtinDecoders',
        `${camel}Decoder`,
      ),
    );
  }

  await writer.flush();
}

export default decoderGenerator;
