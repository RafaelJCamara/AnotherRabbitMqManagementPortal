// Name handling shared by the generators.
import { names } from '@nx/devkit';

const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function assertKebab(value: string, what: string): void {
  if (!KEBAB.test(value)) {
    throw new Error(
      `${what} "${value}" must be kebab-case: lowercase letters, digits and single hyphens, starting with a letter.`,
    );
  }
}

/** `svc-demo` gives `SvcDemo`, `svcDemo`, `svc-demo`. */
export function nameVariants(value: string): {
  pascal: string;
  camel: string;
  kebab: string;
} {
  const variants = names(value);
  return {
    pascal: variants.className,
    camel: variants.propertyName,
    kebab: variants.fileName,
  };
}

/** Removes a leading `prefix` so `svc-demo` and `demo` give the same stem. */
export function stem(value: string, prefix: string): string {
  return value.startsWith(`${prefix}-`)
    ? value.slice(prefix.length + 1)
    : value;
}

/** `Id` strings that become TypeScript identifiers must look like one. */
export function assertIdentifier(value: string, what: string): void {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)) {
    throw new Error(
      `${what} "${value}" must be a valid TypeScript identifier.`,
    );
  }
}

/** Splits a comma-separated option into trimmed, non-empty items. */
export function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** A string safe to place between single quotes in generated source. */
export function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
