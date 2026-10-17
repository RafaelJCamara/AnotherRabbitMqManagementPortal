// Licence gates (DC-50, amendment A-19, M0-73). Two gates with different strictness:
//   1. Dev/build lockfile gate: every package in the install graph. Broader permissive allow-list
//      plus a hard deny list (GPL, AGPL, SSPL, BUSL, proprietary). Tooling-only licences pass only
//      through named exceptions, each logged in docs/adr/ADR-027-log.md (`checkExceptionLog`).
//      Runs against `pnpm licenses list --json`.
//   2. Shipped-artefact gate: only what is bundled into a release. Exactly DC-50, with its own
//      (much shorter) exception list. Input is the bundled-package list that bundled-packages.ts
//      derives from the esbuild metafile / Angular stats (electron-builder file list from M2).
//      A dev/build exception never applies here: a package that is fine in the toolchain is still
//      rejected when it reaches a shipped artefact.
import { dedupe, violation } from './shared.ts';
import type { Licence, LockPackage, Violation } from './shared.ts';

export const LICENCE_RULES = [
  'licence.denied',
  'licence.not-allowed',
  'licence.unknown',
  'licence.unverified',
  'licence.shipped-not-allowed',
  'licence.exception-unlogged',
] as const;

/** Dev/build allow-list. Permissive licences only; build-time data (caniuse-lite) is CC-BY-4.0. */
export const DEV_ALLOWED = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'CC-BY-4.0',
  'ISC',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'Python-2.0',
  'Unlicense',
  'WTFPL',
  'Zlib',
]);

/** Copyleft, source-available and proprietary identifiers that never enter the install graph. */
export const DENIED_PATTERN =
  /^(?:A?GPL|SSPL|BUSL|Commons-Clause|Elastic|Proprietary|UNLICENSED|CC-BY-NC|CC-BY-ND|CC-BY-SA|SEE LICENSE|LicenseRef)/i;

/** Shipped artefacts: DC-50 exactly. Compound `MPL-2.0 OR Apache-2.0` is satisfied through its Apache-2.0 branch. */
export const SHIPPED_ALLOWED = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Apache-2.0',
]);

export interface NamedException {
  /** Exact package name, or a name prefix when `prefix` is true. */
  name: string;
  prefix?: boolean;
  /** Limits the exception to one version when set. */
  version?: string;
  /** The exact licence string the package declares, which the exception accepts. */
  license: string;
  reason: string;
}

/** Dev/build gate exceptions. */
export const DEV_EXCEPTIONS: NamedException[] = [
  {
    name: 'elkjs',
    license: 'EPL-2.0',
    reason:
      'DC-50 named exception: unmodified ELK worker asset, EPL-2.0 notice shipped.',
  },
  {
    name: '@img/sharp-',
    prefix: true,
    license: 'Apache-2.0 AND LGPL-3.0-or-later',
    reason:
      'sharp prebuilt binaries bundle libvips (LGPL, dynamically linked). Docs-site image tooling pulled by astro; build-time only, never part of a shipped product artefact.',
  },
  {
    name: '@img/sharp-',
    prefix: true,
    license: 'LGPL-3.0-or-later',
    reason:
      'libvips binaries for sharp (see above). Build-time only for the docs site.',
  },
  {
    name: 'spdx-exceptions',
    license: 'CC-BY-3.0',
    reason:
      'SPDX exception list data, attribution licence. Dev-only (release-please); not shipped.',
  },
  {
    name: 'union',
    version: '0.5.0',
    license: 'Unknown',
    reason:
      'package.json declares no licence, the shipped LICENSE file is MIT text. Dev-only (http-server, pulled by @nx/web).',
  },
];

/** Shipped-artefact gate exceptions (DC-50). CC-BY-4.0 for assets is handled by `kind: asset`. */
export const SHIPPED_EXCEPTIONS: NamedException[] = [
  {
    name: 'elkjs',
    license: 'EPL-2.0',
    reason:
      'DC-50 named exception: unmodified ELK worker asset, EPL-2.0 notice shipped.',
  },
];

// ---- SPDX expressions ------------------------------------------------------------------------

type Expr =
  | { kind: 'id'; id: string }
  | { kind: 'and' | 'or'; left: Expr; right: Expr };

function tokenise(text: string): string[] {
  return text.match(/\(|\)|[^\s()]+/g) ?? [];
}

/** Parses `(A OR B) AND C WITH exception`. Falls back to one opaque identifier on any syntax problem. */
export function parseSpdx(text: string): Expr {
  const tokens = tokenise(text);
  let pos = 0;
  const peek = (): string | undefined => tokens[pos];
  const isOp = (token: string | undefined, op: string): boolean =>
    token !== undefined && token.toUpperCase() === op;

  function atom(): Expr {
    const token = tokens[pos++];
    if (token === undefined) throw new Error('unexpected end');
    if (token === '(') {
      const inner = or();
      if (tokens[pos++] !== ')') throw new Error('missing )');
      return inner;
    }
    if (
      token === ')' ||
      isOp(token, 'AND') ||
      isOp(token, 'OR') ||
      isOp(token, 'WITH')
    )
      throw new Error(`unexpected ${token}`);
    let id = token;
    if (isOp(peek(), 'WITH')) {
      pos++;
      const exception = tokens[pos++];
      if (exception === undefined) throw new Error('missing exception');
      id = `${token} WITH ${exception}`;
    }
    return { kind: 'id', id };
  }
  function and(): Expr {
    let left = atom();
    while (isOp(peek(), 'AND')) {
      pos++;
      left = { kind: 'and', left, right: atom() };
    }
    return left;
  }
  function or(): Expr {
    let left = and();
    while (isOp(peek(), 'OR')) {
      pos++;
      left = { kind: 'or', left, right: and() };
    }
    return left;
  }

  try {
    const expr = or();
    if (pos !== tokens.length) throw new Error('trailing tokens');
    return expr;
  } catch {
    return { kind: 'id', id: text.trim() };
  }
}

export function isSatisfied(
  expr: Expr,
  allowed: (id: string) => boolean,
): boolean {
  switch (expr.kind) {
    case 'id':
      return allowed(expr.id.replace(/\+$/, ''));
    case 'and':
      return (
        isSatisfied(expr.left, allowed) && isSatisfied(expr.right, allowed)
      );
    case 'or':
      return (
        isSatisfied(expr.left, allowed) || isSatisfied(expr.right, allowed)
      );
  }
}

export function identifiers(expr: Expr): string[] {
  return expr.kind === 'id'
    ? [expr.id]
    : [...identifiers(expr.left), ...identifiers(expr.right)];
}

function matches(e: NamedException, lic: Licence): boolean {
  return (
    (e.prefix === true ? lic.name.startsWith(e.name) : e.name === lic.name) &&
    (e.version === undefined || e.version === lic.version) &&
    e.license === lic.license
  );
}

function hasException(exceptions: NamedException[], lic: Licence): boolean {
  return exceptions.some((e) => matches(e, lic));
}

/** Which gate an exception belongs to. The log row names this scope. */
export type ExceptionScope = 'dev/build' | 'shipped';

function exceptionLabel(e: NamedException): string {
  return `${e.name}${e.version === undefined ? '' : `@${e.version}`}${e.prefix === true ? '*' : ''}`;
}

/**
 * Every named exception is explicit and logged: it needs a row in the "Named gate exceptions"
 * table of docs/adr/ADR-027-log.md that names the package (backticked), the declared licence and
 * the gate scope. An exception nobody reviewed fails the gate.
 */
export function checkExceptionLog(log: string): Violation[] {
  const heading = log.search(/^## Named gate exceptions\s*$/m);
  const rest = heading === -1 ? '' : log.slice(heading + 3);
  const next = rest.search(/^## /m);
  const rows = (next === -1 ? rest : rest.slice(0, next))
    .split(/\r?\n/)
    .filter((line) => line.trimStart().startsWith('|'));
  const out: Violation[] = [];
  const scoped: [ExceptionScope, NamedException[]][] = [
    ['dev/build', DEV_EXCEPTIONS],
    ['shipped', SHIPPED_EXCEPTIONS],
  ];
  for (const [scope, exceptions] of scoped) {
    for (const e of exceptions) {
      const label = exceptionLabel(e);
      const logged = rows.some(
        (row) =>
          row.includes(`\`${label}\``) &&
          row.includes(e.license) &&
          row.includes(scope),
      );
      if (!logged) {
        out.push(
          violation(
            'licence',
            'licence.exception-unlogged',
            `${scope}: ${label} ${e.license}`,
            `The ${scope} licence exception for ${label} (${e.license}) has no row in the "Named gate exceptions" table of docs/adr/ADR-027-log.md.`,
          ),
        );
      }
    }
  }
  return dedupe(out);
}

/** Exceptions that let a package through, for the gate output: no exception stays silent. */
export function appliedExceptions(
  licences: Licence[],
  scope: ExceptionScope,
): string[] {
  const exceptions = scope === 'shipped' ? SHIPPED_EXCEPTIONS : DEV_EXCEPTIONS;
  const applied = new Set<string>();
  for (const lic of licences) {
    const hit = exceptions.find((e) => matches(e, lic));
    if (hit !== undefined)
      applied.add(`${lic.name}@${lic.version} (${lic.license}): ${hit.reason}`);
  }
  return [...applied].sort();
}

// ---- Gates -----------------------------------------------------------------------------------

/** Dev/build lockfile gate over every installed package. */
export function checkDevLicences(licences: Licence[]): Violation[] {
  const out: Violation[] = [];
  for (const lic of licences) {
    const subject = `${lic.name}@${lic.version}`;
    if (hasException(DEV_EXCEPTIONS, lic)) continue;
    if (lic.license.trim() === '' || /^unknown$/i.test(lic.license.trim())) {
      out.push(
        violation(
          'licence',
          'licence.unknown',
          subject,
          `${subject} declares no licence.`,
        ),
      );
      continue;
    }
    const expr = parseSpdx(lic.license);
    if (isSatisfied(expr, (id) => DEV_ALLOWED.has(id))) continue;
    const denied = identifiers(expr).some((id) => DENIED_PATTERN.test(id));
    out.push(
      denied
        ? violation(
            'licence',
            'licence.denied',
            subject,
            `${subject} is licensed ${lic.license}, which is on the hard deny list.`,
          )
        : violation(
            'licence',
            'licence.not-allowed',
            subject,
            `${subject} is licensed ${lic.license}, which is not on the allow-list.`,
          ),
    );
  }
  return dedupe(out);
}

/** Shipped-artefact gate: exactly DC-50. */
export function checkShippedLicences(licences: Licence[]): Violation[] {
  const out: Violation[] = [];
  for (const lic of licences) {
    const subject = `${lic.name}@${lic.version}`;
    if (hasException(SHIPPED_EXCEPTIONS, lic)) continue;
    if (lic.kind === 'asset' && lic.license === 'CC-BY-4.0') continue;
    if (isSatisfied(parseSpdx(lic.license), (id) => SHIPPED_ALLOWED.has(id)))
      continue;
    out.push(
      violation(
        'licence',
        'licence.shipped-not-allowed',
        subject,
        `${subject} (${lic.kind ?? 'code'}) is licensed ${lic.license}, which DC-50 does not allow in a shipped artefact.`,
      ),
    );
  }
  return dedupe(out);
}

/**
 * Every package the install graph needs on this platform must have licence data. A stale
 * node_modules or a package that `pnpm licenses` cannot see would otherwise pass silently.
 */
export function checkLicenceCoverage(
  lockPackages: LockPackage[],
  licences: Licence[],
): Violation[] {
  const known = new Set(licences.map((l) => `${l.name}@${l.version}`));
  const out: Violation[] = [];
  for (const pkg of lockPackages) {
    // Non-registry sources are rejected by the lockfile gate; their lockfile key is not a version.
    if (
      pkg.bootstrap ||
      pkg.platformRestricted ||
      pkg.optionalOnly ||
      /[:/]/.test(pkg.version)
    )
      continue;
    if (!known.has(`${pkg.name}@${pkg.version}`)) {
      out.push(
        violation(
          'licence',
          'licence.unverified',
          `${pkg.name}@${pkg.version}`,
          `No licence data for ${pkg.name}@${pkg.version}. Run \`pnpm install\` so node_modules matches the lockfile.`,
        ),
      );
    }
  }
  return out;
}
