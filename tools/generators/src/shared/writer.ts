// Every generator writes through a Writer. It remembers which files were touched and formats
// exactly those with Prettier on flush, using the workspace options, so generated files already
// satisfy `prettier --check` in a real checkout and in the in-memory tree of the unit tests.
import type { Tree } from '@nx/devkit';
import { format, type Options } from 'prettier';

const FORMATTED = new Set([
  '.ts',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
]);
const DEFAULT_OPTIONS: Options = { singleQuote: true, endOfLine: 'lf' };

const extensionOf = (path: string): string => {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot);
};

export class Writer {
  readonly tree: Tree;
  readonly #touched = new Set<string>();

  constructor(tree: Tree) {
    this.tree = tree;
  }

  exists(path: string): boolean {
    return this.tree.exists(path);
  }

  read(path: string): string | null {
    return this.tree.read(path, 'utf-8');
  }

  /** Reads a file that must exist, with a message that tells an agent what to do. */
  require(path: string, hint: string): string {
    const text = this.read(path);
    if (text === null) throw new Error(`${path} not found. ${hint}`);
    return text;
  }

  write(path: string, content: string): void {
    this.tree.write(path, content);
    this.#touched.add(path);
  }

  writeJson(path: string, value: unknown): void {
    this.write(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller states the shape of the JSON file.
  readJson<T>(path: string): T {
    const text = this.require(
      path,
      'Run the generator from the workspace root.',
    );
    return JSON.parse(text) as T;
  }

  /** Formats every file this writer touched. */
  async flush(): Promise<void> {
    const prettierrc = this.read('.prettierrc');
    const workspaceOptions: Options =
      prettierrc === null ? {} : (JSON.parse(prettierrc) as Options);
    const options: Options = { ...DEFAULT_OPTIONS, ...workspaceOptions };

    for (const path of this.#touched) {
      if (!FORMATTED.has(extensionOf(path))) continue;
      const text = this.read(path);
      if (text === null) continue;
      this.tree.write(path, await format(text, { ...options, filepath: path }));
    }
  }
}
