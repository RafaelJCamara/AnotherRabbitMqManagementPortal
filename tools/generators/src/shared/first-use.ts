// Libraries that a generator creates on first use (docs/architecture/generators.md) and that a work
// package has since adopted. The generator tests copy the repository's tsconfig.base.json to start
// from a real workspace, but a copy that already registers one of these aliases would make the
// generator refuse to create the library, so the copy drops them.
//
// `@app/ports` is in the list for the adapter generator: it imports the port from the alias when the
// alias exists, and the tests use made-up port names (`DemoPort`) that the real package does not
// export. Dropping it keeps them on the stand-in port file (OQ-61).
const ADOPTED_ALIASES = [
  '@app/persistence',
  '@app/ports',
  '@app/semantics',
] as const;

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
