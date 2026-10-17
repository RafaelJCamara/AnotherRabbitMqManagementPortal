// Pin gate (DC-49, DC-50, ADR-027): exact catalog pins, the pnpm supply-chain settings, logged
// exclusions, required versions and the banned-package list.
import {
  asRecord,
  asStringList,
  catalogEntries,
  compareVersions,
  dedupe,
  DEPENDENCY_SECTIONS,
  isExactVersion,
  major,
  tryParseLockfile,
  violation,
} from './shared.ts';
import type { Violation, Workspace } from './shared.ts';

export const PIN_RULES = [
  'config.supply-chain-setting',
  'pin.non-exact-version',
  'pin.manifest-not-catalog',
  'pin.exclusion-not-exact',
  'pin.exclusion-unlogged',
  'pin.typescript-version',
  'pin.required-version',
  'pin.electron-builder-min',
  'ban.types-amqplib',
  'ban.primeng',
  'ban.primeui',
  'ban.ag-grid-enterprise',
  'ban.apexcharts',
  'ban.oasdiff-npm',
  'ban.nx-nest',
] as const;

/** DC-49: TypeScript 6.0.3 only; fastify 5.12.7 (ADR-004 deviation); amqplib and rhea exact. */
export const REQUIRED_PINS: Record<string, string> = {
  typescript: '6.0.3',
  fastify: '5.12.7',
  amqplib: '2.2.0',
  rhea: '3.0.5',
};

/**
 * Transitive copies of a required-pin package that the workspace tolerates. Only the lockfile may
 * carry them: the catalog must still pin the required version.
 */
export const TRANSITIVE_PIN_EXCEPTIONS: Record<string, string> = {
  'typescript@4.9.5':
    'Direct dependency of release-please (release tooling, M0-06). Never used to build or typecheck the product.',
};

/** DC-50: electron-builder 26.15.3 (npm `latest`) is below the minimum. */
export const ELECTRON_BUILDER_MIN = '26.16.1';

interface Ban {
  rule: string;
  reason: string;
  matches: (name: string) => boolean;
  /** When set, only these versions are banned. Sources without a version skip this ban. */
  versionBanned?: (version: string) => boolean;
}

export const BANS: Ban[] = [
  {
    rule: 'ban.types-amqplib',
    reason:
      'amqplib 2.x ships its own types; @types/amqplib shadows them (DC-49).',
    matches: (n) => n === '@types/amqplib',
  },
  {
    rule: 'ban.primeng',
    reason:
      'PrimeNG 22 and later is not licence-compatible with Apache-2.0 (DC-50).',
    matches: (n) => n === 'primeng',
    versionBanned: (v) => major(v) >= 22,
  },
  {
    rule: 'ban.primeui',
    reason: '@primeui/* is not licence-compatible with Apache-2.0 (DC-50).',
    matches: (n) => n.startsWith('@primeui/'),
  },
  {
    rule: 'ban.ag-grid-enterprise',
    reason: 'AG Grid Enterprise is commercial (DC-50). Use AG Grid Community.',
    matches: (n) =>
      n === 'ag-grid-enterprise' || n.startsWith('@ag-grid-enterprise/'),
  },
  {
    rule: 'ban.apexcharts',
    reason:
      'ApexCharts is not licence-compatible with Apache-2.0 (DC-50). Use uPlot or ECharts.',
    matches: (n) => n === 'apexcharts' || n === 'ng-apexcharts',
  },
  {
    rule: 'ban.oasdiff-npm',
    reason:
      'The npm package `oasdiff` is a security placeholder, not the Go tool. Install the binary instead.',
    matches: (n) => n === 'oasdiff',
  },
  {
    rule: 'ban.nx-nest',
    reason: 'The engine runs on Fastify without NestJS (DC-49, ADR-004).',
    matches: (n) => n === '@nx/nest',
  },
];

const REQUIRED_SETTINGS: {
  key: string;
  ok: (value: unknown) => boolean;
  expected: string;
}[] = [
  {
    key: 'minimumReleaseAge',
    ok: (v) => typeof v === 'number' && v >= 4320,
    expected: 'a number of at least 4320 (3 days)',
  },
  { key: 'minimumReleaseAgeStrict', ok: (v) => v === true, expected: 'true' },
  {
    key: 'minimumReleaseAgeIgnoreMissingTime',
    ok: (v) => v === false,
    expected: 'false (critique: a missing time must fail, not skip the gate)',
  },
  {
    key: 'trustPolicy',
    ok: (v) => v === 'no-downgrade',
    expected: 'no-downgrade',
  },
  { key: 'blockExoticSubdeps', ok: (v) => v === true, expected: 'true' },
  { key: 'strictDepBuilds', ok: (v) => v === true, expected: 'true' },
  {
    key: 'allowBuilds',
    ok: (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
    expected: 'an explicit map of package -> boolean',
  },
];

const EXACT_EXCLUSION =
  /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function checkSettings(ws: Workspace): Violation[] {
  const out: Violation[] = [];
  for (const { key, ok, expected } of REQUIRED_SETTINGS) {
    if (!ok(ws.settings[key])) {
      out.push(
        violation(
          'pin',
          'config.supply-chain-setting',
          key,
          `pnpm-workspace.yaml: \`${key}\` must be ${expected}; found ${JSON.stringify(ws.settings[key]) ?? 'nothing'}.`,
        ),
      );
    }
  }
  if (ws.settings['dangerouslyAllowAllBuilds'] === true) {
    out.push(
      violation(
        'pin',
        'config.supply-chain-setting',
        'dangerouslyAllowAllBuilds',
        'pnpm-workspace.yaml: `dangerouslyAllowAllBuilds` must not be true.',
      ),
    );
  }
  return out;
}

function checkExclusions(ws: Workspace): Violation[] {
  const out: Violation[] = [];
  const rows = ws.exclusionLog
    .split(/\r?\n/)
    .filter((line) => line.trimStart().startsWith('|'));
  for (const setting of ['minimumReleaseAgeExclude', 'trustPolicyExclude']) {
    for (const entry of asStringList(ws.settings[setting])) {
      if (!EXACT_EXCLUSION.test(entry)) {
        out.push(
          violation(
            'pin',
            'pin.exclusion-not-exact',
            `${setting}: ${entry}`,
            `${setting} entries must be exact \`name@x.y.z\`; "${entry}" is not.`,
          ),
        );
        continue;
      }
      const logged = rows.some(
        (row) => row.includes(`\`${setting}\``) && row.includes(`\`${entry}\``),
      );
      if (!logged) {
        out.push(
          violation(
            'pin',
            'pin.exclusion-unlogged',
            `${setting}: ${entry}`,
            `${entry} is excluded in ${setting} but has no row in docs/adr/ADR-027-log.md.`,
          ),
        );
      }
    }
  }
  return out;
}

interface Resolved {
  name: string;
  version: string;
  source: string;
}

/** Every package version the repository declares or resolves, with where it came from. */
function resolvedVersions(ws: Workspace): Resolved[] {
  const out: Resolved[] = catalogEntries(ws.settings)
    .filter((e) => isExactVersion(e.spec))
    .map((e) => ({
      name: e.name,
      version: e.spec,
      source: `catalog ${e.catalog}`,
    }));
  const lock = tryParseLockfile(ws);
  for (const pkg of lock?.packages ?? []) {
    if (pkg.version !== '')
      out.push({ name: pkg.name, version: pkg.version, source: 'lockfile' });
  }
  return out;
}

function checkExactness(ws: Workspace): Violation[] {
  const out: Violation[] = [];
  for (const e of catalogEntries(ws.settings)) {
    if (!isExactVersion(e.spec)) {
      out.push(
        violation(
          'pin',
          'pin.non-exact-version',
          `${e.name}@${e.spec}`,
          `Catalog "${e.catalog}" must pin ${e.name} to an exact version; "${e.spec}" is a range or alias.`,
        ),
      );
    }
  }
  for (const [name, spec] of Object.entries(
    asRecord(ws.settings['overrides']),
  )) {
    if (typeof spec !== 'string' || !isExactVersion(spec)) {
      out.push(
        violation(
          'pin',
          'pin.non-exact-version',
          `override ${name}`,
          `overrides must be exact versions; ${name} is "${String(spec)}".`,
        ),
      );
    }
  }
  for (const manifest of ws.manifests) {
    for (const section of DEPENDENCY_SECTIONS) {
      if (section === 'peerDependencies') continue;
      for (const [name, spec] of Object.entries(
        asRecord(manifest.json[section]),
      )) {
        const value = String(spec);
        if (!value.startsWith('catalog:') && !value.startsWith('workspace:')) {
          out.push(
            violation(
              'pin',
              'pin.manifest-not-catalog',
              `${manifest.path}: ${name}`,
              `${manifest.path} ${section}.${name} is "${value}"; declare it once in the pnpm-workspace.yaml catalog and use "catalog:".`,
            ),
          );
        }
      }
    }
  }
  return out;
}

function checkRequiredVersions(ws: Workspace): Violation[] {
  const out: Violation[] = [];
  for (const r of resolvedVersions(ws)) {
    const required = REQUIRED_PINS[r.name];
    if (
      required !== undefined &&
      r.version !== required &&
      !(
        r.source === 'lockfile' &&
        `${r.name}@${r.version}` in TRANSITIVE_PIN_EXCEPTIONS
      )
    ) {
      const rule =
        r.name === 'typescript'
          ? 'pin.typescript-version'
          : 'pin.required-version';
      out.push(
        violation(
          'pin',
          rule,
          `${r.name}@${r.version}`,
          `${r.name} must be exactly ${required} (${r.source} has ${r.version}).`,
        ),
      );
    }
    if (
      r.name === 'electron-builder' &&
      compareVersions(r.version, ELECTRON_BUILDER_MIN) < 0
    ) {
      out.push(
        violation(
          'pin',
          'pin.electron-builder-min',
          `${r.name}@${r.version}`,
          `electron-builder must be at least ${ELECTRON_BUILDER_MIN} (DC-50); ${r.source} has ${r.version}.`,
        ),
      );
    }
  }
  return out;
}

function checkBans(ws: Workspace): Violation[] {
  const out: Violation[] = [];
  const seen: { name: string; version: string | undefined; source: string }[] =
    resolvedVersions(ws).map((r) => ({ ...r }));
  for (const e of catalogEntries(ws.settings))
    seen.push({
      name: e.name,
      version: isExactVersion(e.spec) ? e.spec : undefined,
      source: `catalog ${e.catalog}`,
    });
  for (const name of Object.keys(asRecord(ws.settings['overrides'])))
    seen.push({ name, version: undefined, source: 'overrides' });
  for (const manifest of ws.manifests) {
    for (const section of DEPENDENCY_SECTIONS) {
      for (const name of Object.keys(asRecord(manifest.json[section])))
        seen.push({ name, version: undefined, source: manifest.path });
    }
  }
  for (const item of seen) {
    for (const ban of BANS) {
      if (!ban.matches(item.name)) continue;
      if (ban.versionBanned !== undefined) {
        if (item.version === undefined || !ban.versionBanned(item.version))
          continue;
      }
      const subject =
        item.version === undefined ? item.name : `${item.name}@${item.version}`;
      out.push(
        violation(
          'pin',
          ban.rule,
          subject,
          `${subject} (${item.source}) is banned: ${ban.reason}`,
        ),
      );
    }
  }
  return out;
}

export function checkPins(ws: Workspace): Violation[] {
  return dedupe([
    ...checkSettings(ws),
    ...checkExclusions(ws),
    ...checkExactness(ws),
    ...checkRequiredVersions(ws),
    ...checkBans(ws),
  ]);
}
