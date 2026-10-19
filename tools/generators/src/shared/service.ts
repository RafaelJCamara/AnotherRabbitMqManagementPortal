// What the action, topic and job generators share: finding the service module they extend, the
// contract registry they add to, and the rule that a generator never overwrites a file.
import type { Writer } from './writer.ts';

export const CONTRACTS_ROOT = 'libs/shared/contracts';
export const REGISTRY_DIR = `${CONTRACTS_ROOT}/src/registry`;
export const REGISTRY_INDEX = `${REGISTRY_DIR}/index.ts`;
export const CONTRACTS_INDEX = `${CONTRACTS_ROOT}/src/index.ts`;
export const MANIFEST = 'tools/arch-tests/src/registered-actions.ts';

interface ProjectJson {
  name?: string;
  tags?: string[];
}

/** The root of a project of the given layer, or an error that says how to create it. */
export function requireProject(
  writer: Writer,
  root: string,
  name: string,
  tag: string,
  hint: string,
): string {
  const path = `${root}/project.json`;
  const project = writer.exists(path)
    ? writer.readJson<ProjectJson>(path)
    : undefined;
  if (project === undefined) {
    throw new Error(`${name} does not exist (${path} not found). ${hint}`);
  }
  if (project.name !== name || !project.tags?.includes(tag)) {
    throw new Error(
      `${path} is not the ${tag} project "${name}"; refusing to write into it.`,
    );
  }
  return root;
}

export function requireService(writer: Writer, module: string): string {
  return requireProject(
    writer,
    `libs/engine/${module}`,
    module,
    'type:service',
    `Create it first: pnpm nx g @app/generators:service-module ${module}`,
  );
}

export function requireFeature(writer: Writer, feature: string): string {
  const name = `feature-${feature}`;
  return requireProject(
    writer,
    `libs/ui/${name}`,
    name,
    'type:ui-feature',
    `Create it first: pnpm nx g @app/generators:ui-feature ${feature} --route='/c/:cid/${feature}', or pass --feature=none.`,
  );
}

/** A generator adds files; it never replaces one. Names every clash, writes nothing. */
export function assertFree(writer: Writer, paths: readonly string[]): void {
  const taken = paths.filter((path) => writer.exists(path));
  if (taken.length > 0) {
    throw new Error(
      `Refusing to overwrite: ${taken.join(', ')} already exist${taken.length === 1 ? 's' : ''}. Is this already generated?`,
    );
  }
}

/** The text of every contract file that could already declare `needle` (an id or a binding). */
export function registrySources(writer: Writer): Record<string, string> {
  const sources: Record<string, string> = {};
  if (!writer.exists(REGISTRY_INDEX)) {
    throw new Error(
      `${REGISTRY_INDEX} not found. Run the generator from the workspace root; the contract registry must exist.`,
    );
  }
  for (const entry of writer.tree.children(REGISTRY_DIR)) {
    const path = `${REGISTRY_DIR}/${entry}`;
    if (entry.endsWith('.ts') && writer.tree.isFile(path)) {
      sources[path] = writer.read(path) ?? '';
    }
  }
  return sources;
}

export function assertIdFree(
  writer: Writer,
  id: string,
  what: 'action' | 'topic',
): void {
  for (const [path, text] of Object.entries(registrySources(writer))) {
    if (text.includes(`id: '${id}'`)) {
      throw new Error(`The ${what} id "${id}" is already declared in ${path}.`);
    }
  }
}

/** `POST /a/{x}` and `POST /a/{y}` are one endpoint (kit invariant one-endpoint-one-action). */
export function assertEndpointFree(
  writer: Writer,
  method: string,
  path: string,
): void {
  const normal = (value: string): string => value.replace(/\{[^{}/]*\}/g, '{}');
  const wanted = `${method} ${normal(path)}`;
  const binding = /http:\s*\{\s*method:\s*'([A-Z]+)',\s*path:\s*'([^']*)'/g;
  for (const [file, text] of Object.entries(registrySources(writer))) {
    for (const match of text.matchAll(binding)) {
      if (`${match[1] ?? ''} ${normal(match[2] ?? '')}` === wanted) {
        throw new Error(
          `${method} ${path} is already bound by an action in ${file}; one endpoint belongs to one action.`,
        );
      }
    }
  }
}
