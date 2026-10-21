// Libraries that a generator creates on first use (docs/architecture/generators.md) and that a work
// package has since adopted. The generator tests copy the repository's tsconfig.base.json to start
// from a real workspace, but a copy that already registers one of these aliases would make the
// generator refuse to create the library, so the copy drops them.
//
// `@app/ports` is in the list for the adapter generator: it imports the port from the alias when the
// alias exists, and the tests use made-up port names (`DemoPort`) that the real package does not
// export. Dropping it keeps them on the stand-in port file (OQ-61).
//
// `@app/feature-explorer` is the explorer UI (M0-54): the action and topic generator tests generate a
// UI feature named `explorer` of their own.
const ADOPTED_ALIASES = [
  '@app/feature-explorer',
  '@app/persistence',
  '@app/ports',
  '@app/semantics',
] as const;

interface TsConfigBase {
  compilerOptions?: { paths?: Record<string, string[]> };
}

/** `tsconfig.base.json` text without the given path aliases. */
export function withoutAliases(
  tsconfigBase: string,
  aliases: readonly string[],
): string {
  const base = JSON.parse(tsconfigBase) as TsConfigBase;
  const paths = base.compilerOptions?.paths;
  if (paths) {
    for (const alias of aliases) Reflect.deleteProperty(paths, alias);
  }
  return `${JSON.stringify(base, null, 2)}\n`;
}

/** `tsconfig.base.json` text without the path aliases of the adopted first-use libraries. */
export function withoutAdoptedAliases(tsconfigBase: string): string {
  return withoutAliases(tsconfigBase, ADOPTED_ALIASES);
}

/**
 * The UI features the generator tests create under the same name. The end-to-end workspace keeps
 * every other alias but copies no `libs/ui`, so these go too.
 */
export const UI_FEATURE_ALIASES: readonly string[] = ['@app/feature-explorer'];
