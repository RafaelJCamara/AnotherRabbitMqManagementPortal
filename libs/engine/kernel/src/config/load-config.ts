// loadConfig(schema): the one way the engine reads its configuration (blueprint 9).
//
//   precedence   environment > *_FILE variables > config file > defaults
//   environment  PREFIX_SECTION__KEY=value, keys in UPPER_SNAKE for the camelCase key
//                (APP_SERVER__PUBLIC_URL sets server.publicUrl); PREFIX_..._FILE=/path reads
//                the value from a file, the form container secrets use
//   unknown keys rejected, in every source
//   errors name the key and the rule and never print a value (I-10)
//
// Values from the environment are text. When the schema wants a number, a boolean, an array or an
// object there, the text is converted (numbers and booleans from their literal form, arrays and
// objects from JSON), so schemas stay plain zod with no coercion helpers.
import { readFileSync } from 'node:fs';

import { z } from 'zod';

import { ConfigError, type ConfigIssue } from './errors.ts';
import {
  checkDefaults,
  isTree,
  mergeTrees,
  pathKey,
  readConfigFile,
  readEnvLayers,
  type Tree,
} from './layers.ts';

export interface LoadConfigOptions {
  /** Environment variables start with this and an underscore. Default `APP` (the product name is a placeholder, ADR-029). */
  envPrefix?: string;
  /** Default: `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** A JSON or YAML file. Optional; when given it must exist. */
  file?: string;
  /** Values below the file and above the defaults of the schema itself. */
  defaults?: Tree;
  /** Default: read as UTF-8 from disk. */
  readFile?: (path: string) => string;
}

const MAX_COERCION_ROUNDS = 3;

const readUtf8 = (path: string): string => readFileSync(path, 'utf8');

function getAt(tree: unknown, path: readonly PropertyKey[]): unknown {
  let node = tree;
  for (const key of path) {
    if (!isTree(node) && !Array.isArray(node)) return undefined;
    node = (node as Record<PropertyKey, unknown>)[key];
  }
  return node;
}

function setAt(tree: Tree, path: readonly PropertyKey[], value: unknown): void {
  const parent = getAt(tree, path.slice(0, -1));
  const last = path.at(-1);
  if (last !== undefined && (isTree(parent) || Array.isArray(parent))) {
    (parent as Record<PropertyKey, unknown>)[last] = value;
  }
}

/** The converted value, or undefined when the text is not a literal of the wanted type. */
function convert(text: string, expected: string): unknown {
  switch (expected) {
    case 'number':
    case 'int': {
      const trimmed = text.trim();
      const number = Number(trimmed);
      return trimmed !== '' && Number.isFinite(number) ? number : undefined;
    }
    case 'boolean': {
      const lower = text.trim().toLowerCase();
      if (lower === 'true' || lower === '1') return true;
      if (lower === 'false' || lower === '0') return false;
      return undefined;
    }
    case 'array':
    case 'object': {
      try {
        const parsed: unknown = JSON.parse(text);
        return (expected === 'array' ? Array.isArray(parsed) : isTree(parsed))
          ? parsed
          : undefined;
      } catch {
        return undefined;
      }
    }
    default:
      return undefined;
  }
}

/** Keys of the input that the schema's output does not have: it dropped them, so it did not know them. */
function droppedKeys(
  input: unknown,
  output: unknown,
  path: readonly string[] = [],
): string[] {
  if (isTree(input) && isTree(output)) {
    return Object.keys(input).flatMap((key) =>
      key in output
        ? droppedKeys(input[key], output[key], [...path, key])
        : [[...path, key].join('.')],
    );
  }
  if (Array.isArray(input) && Array.isArray(output)) {
    return input.flatMap((entry, index) =>
      droppedKeys(entry, output[index], [...path, String(index)]),
    );
  }
  return [];
}

const toIssues = (error: z.ZodError): ConfigIssue[] =>
  error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));

/**
 * Loads and validates the configuration. Returns the parsed value of `schema`; throws a
 * `ConfigError` listing every problem. Build the schema with `z.strictObject` so that zod reports
 * unknown keys itself; the loader also rejects any key a lenient schema would silently drop, so a
 * schema must not rename or restructure keys with a transform.
 */
export function loadConfig<S extends z.ZodType>(
  schema: S,
  options: LoadConfigOptions = {},
): z.output<S> {
  const readFile = options.readFile ?? readUtf8;
  const layers = readEnvLayers(
    options.envPrefix ?? 'APP',
    options.env ?? process.env,
    readFile,
  );

  let merged: Tree = checkDefaults(options.defaults ?? {});
  if (options.file !== undefined) {
    merged = mergeTrees(merged, readConfigFile(options.file, readFile));
  }
  // A copy, because conversion below edits it and the sources may be shared objects.
  merged = structuredClone(
    mergeTrees(mergeTrees(merged, layers.envFiles), layers.env),
  );

  for (let round = 0; ; round += 1) {
    const result = schema.safeParse(merged);
    if (result.success) {
      const unknown = droppedKeys(merged, result.data);
      if (unknown.length > 0) {
        throw new ConfigError(
          unknown.map((path) => ({ path, message: 'unknown key.' })),
        );
      }
      return result.data;
    }
    // Convert text from the environment where the schema wants another type, then try again.
    let converted = false;
    if (round < MAX_COERCION_ROUNDS) {
      for (const issue of result.error.issues) {
        if (
          issue.code !== 'invalid_type' ||
          !layers.textual.has(pathKey(issue.path))
        ) {
          continue;
        }
        const current = getAt(merged, issue.path);
        if (typeof current !== 'string') continue;
        const value = convert(current, issue.expected);
        if (value !== undefined) {
          setAt(merged, issue.path, value);
          converted = true;
        }
      }
    }
    if (!converted) throw new ConfigError(toIssues(result.error));
  }
}
