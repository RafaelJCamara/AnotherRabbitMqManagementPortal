// The sources of configuration, each turned into a nested object, and the merge between them.
// Precedence, highest first: environment, then *_FILE variables, then the config file, then
// defaults (blueprint 9).
import { parse, YAMLParseError } from 'yaml';

import { ConfigError } from './errors.ts';

export type Tree = Record<string, unknown>;

/** Keys that would change an object's prototype instead of adding a property. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isTree(value: unknown): value is Tree {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `PUBLIC_URL` -> `publicUrl`. Config keys are camelCase; the environment is UPPER_SNAKE. */
export function toCamelCase(segment: string): string {
  return segment
    .toLowerCase()
    .split('_')
    .map((word, index) =>
      index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join('');
}

/** `publicUrl` -> `PUBLIC_URL`. */
function toUpperSnake(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

/**
 * The environment variable that sets the key at `path`: `envVarName('APP', ['server',
 * 'publicUrl'])` is `APP_SERVER__PUBLIC_URL`. Append `_FILE` for the file-reading form.
 */
export function envVarName(prefix: string, path: readonly string[]): string {
  return `${prefix}_${path.map(toUpperSnake).join('__')}`;
}

function assertSafeKey(key: string, where: string): void {
  if (FORBIDDEN_KEYS.has(key)) {
    throw new ConfigError([
      { path: '', message: `the key "${key}" is not allowed (${where}).` },
    ]);
  }
}

/** Rejects forbidden keys anywhere in a parsed document. */
function assertSafeTree(value: unknown, where: string): void {
  if (Array.isArray(value)) {
    for (const entry of value) assertSafeTree(entry, where);
  } else if (isTree(value)) {
    for (const [key, entry] of Object.entries(value)) {
      assertSafeKey(key, where);
      assertSafeTree(entry, where);
    }
  }
}

/** Objects merge key by key; anything else (scalars, arrays) from `over` replaces `base`. */
export function mergeTrees(base: Tree, over: Tree): Tree {
  const out: Tree = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const current = out[key];
    out[key] =
      isTree(current) && isTree(value) ? mergeTrees(current, value) : value;
  }
  return out;
}

/** Sets `value` at `path`, creating objects on the way; two sources for one key conflict. */
export function setAtPath(
  tree: Tree,
  path: readonly string[],
  value: unknown,
  label: string,
): void {
  let node = tree;
  path.forEach((key, index) => {
    assertSafeKey(key, label);
    const last = index === path.length - 1;
    const current = node[key];
    if (last) {
      if (current !== undefined) {
        throw new ConfigError([
          {
            path: path.join('.'),
            message: `${label} conflicts with another variable for the same key.`,
          },
        ]);
      }
      node[key] = value;
    } else if (current === undefined) {
      const child: Tree = {};
      node[key] = child;
      node = child;
    } else if (isTree(current)) {
      node = current;
    } else {
      throw new ConfigError([
        {
          path: path.slice(0, index + 1).join('.'),
          message: `${label} conflicts with a variable that sets this key to a single value.`,
        },
      ]);
    }
  });
}

export interface EnvLayers {
  /** Values of `PREFIX_*` variables that are set directly. */
  env: Tree;
  /** Values read from the files named by `PREFIX_*_FILE` variables. */
  envFiles: Tree;
  /** Paths (joined with a NUL) whose value is a string from the environment or a file. */
  textual: Set<string>;
}

export const pathKey = (path: readonly (string | number | symbol)[]): string =>
  path.map(String).join('\u0000');

/** Reads the variables that start with `PREFIX_`. Everything else in the environment is ignored. */
export function readEnvLayers(
  prefix: string,
  env: Readonly<Record<string, string | undefined>>,
  readFile: (path: string) => string,
): EnvLayers {
  const layers: EnvLayers = { env: {}, envFiles: {}, textual: new Set() };
  const lead = `${prefix}_`;
  for (const name of Object.keys(env).sort()) {
    const raw = env[name];
    if (raw === undefined || !name.startsWith(lead)) continue;
    const rest = name.slice(lead.length);
    const isFile = rest.endsWith('_FILE') && rest.length > '_FILE'.length;
    const base = isFile ? rest.slice(0, -'_FILE'.length) : rest;
    const segments = base.split('__');
    if (
      segments.some((segment) => !/^[A-Z0-9]+(?:_[A-Z0-9]+)*$/.test(segment))
    ) {
      throw new ConfigError([
        {
          path: '',
          message: `the variable ${name} is not a valid configuration name (use UPPER_SNAKE words joined by "__").`,
        },
      ]);
    }
    const path = segments.map(toCamelCase);
    let value = raw;
    if (isFile) {
      try {
        value = readFile(raw).replace(/\r?\n$/, '');
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code ?? 'unreadable';
        throw new ConfigError([
          {
            path: path.join('.'),
            message: `cannot read the file named by ${name} (${code}).`,
          },
        ]);
      }
    }
    setAtPath(isFile ? layers.envFiles : layers.env, path, value, name);
    layers.textual.add(pathKey(path));
  }
  return layers;
}

/** Reads a JSON or YAML file (JSON is a subset of YAML) into an object. */
export function readConfigFile(
  file: string,
  readFile: (path: string) => string,
): Tree {
  let text: string;
  try {
    text = readFile(file);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code ?? 'unreadable';
    throw new ConfigError([
      { path: '', message: `cannot read the config file (${code}).` },
    ]);
  }
  let document: unknown;
  try {
    document = parse(text);
  } catch (cause) {
    // The message of a YAML error quotes the offending line, which can hold a secret.
    const where =
      cause instanceof YAMLParseError && cause.linePos
        ? ` at line ${String(cause.linePos[0].line)}, column ${String(cause.linePos[0].col)}`
        : '';
    throw new ConfigError([
      {
        path: '',
        message: `the config file is not valid JSON or YAML${where}.`,
      },
    ]);
  }
  if (document === null || document === undefined) return {};
  if (!isTree(document)) {
    throw new ConfigError([
      {
        path: '',
        message: 'the config file must hold an object at the top level.',
      },
    ]);
  }
  assertSafeTree(document, 'config file');
  return document;
}

export function checkDefaults(defaults: Tree): Tree {
  assertSafeTree(defaults, 'defaults');
  return defaults;
}
