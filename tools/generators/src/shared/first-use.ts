// Libraries that a generator creates on first use (docs/architecture/generators.md) and that a work
// package has since adopted. The generator tests copy the repository's tsconfig.base.json to start
// from a real workspace, but a copy that already registers one of these aliases would make the
// generator refuse to create the library, so the copy drops them.
const ADOPTED_ALIASES = ['@app/semantics'] as const;

interface TsConfigBase {
  compilerOptions?: { paths?: Record<string, string[]> };
}

/** `tsconfig.base.json` text without the path aliases of the adopted first-use libraries. */
export function withoutAdoptedAliases(tsconfigBase: string): string {
  const base = JSON.parse(tsconfigBase) as TsConfigBase;
  const paths = base.compilerOptions?.paths;
  if (paths) {
    for (const alias of ADOPTED_ALIASES) Reflect.deleteProperty(paths, alias);
  }
  return `${JSON.stringify(base, null, 2)}\n`;
}
