// Detection for the platform upgrade lane (A-25): which platform has a newer stable major that is
// old enough to adopt (the ADR-027 release-age gate), and what registry metadata says about its
// compatibility with the rest of the pinned set. Pure over a `Registry`, so it is tested with fakes.
import type { CheckSpec, Manifest, Pin, Platform } from './manifest.ts';
import type { Registry, Release } from './registry.ts';
import { parseVersion, satisfies } from './semver.ts';

export type CheckStatus = 'ok' | 'incompatible' | 'unknown';

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  blocking: boolean;
  detail: string;
}

/** What the opener needs to file one upgrade issue. Every field is data; nothing is markup. */
export interface Candidate {
  platform: string;
  name: string;
  pinned: string;
  major: number;
  version: string;
  /** ISO time the target version was published. */
  published: string;
  /** ISO time the first stable release of the new major was published. */
  ga: string;
  /** ISO time the upgrade is due (GA plus the runbook window), or null. */
  due: string | null;
  cadence: string;
  adrGated: boolean;
  /** Node only: the LTS codename, or null while the line is not LTS. */
  lts: string | null;
  checks: CheckResult[];
}

export interface Plan {
  generatedAt: string;
  ageGateMinutes: number;
  candidates: Candidate[];
}

export type PlatformStatus =
  | 'current'
  | 'aging'
  | 'deferred'
  | 'candidate'
  | 'error';

export interface PlatformReport {
  id: string;
  name: string;
  pinned: string;
  pinSource: Pin['source'];
  status: PlatformStatus;
  /** Highest stable version of the highest newer major, even if it is still inside the age gate. */
  newest: { version: string; published: string } | null;
  /** When the newest major becomes old enough to adopt (status `aging`). */
  eligibleAt: string | null;
  candidate: Candidate | null;
  error: string | null;
}

export interface DetectContext {
  manifest: Manifest;
  pins: Record<string, Pin>;
  /** The pnpm catalog, for packages checked at their pinned version. */
  catalog: Record<string, string>;
  registry: Registry;
  now: Date;
  /** `minimumReleaseAge` of pnpm-workspace.yaml, in minutes. */
  ageGateMinutes: number;
}

function major(version: string): number {
  return parseVersion(version)?.major ?? -1;
}

function compare(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === null || pb === null) return 0;
  return pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch;
}

function pinOf(ctx: DetectContext, platformId: string): string {
  const pin = ctx.pins[platformId];
  if (pin === undefined) throw new Error(`no pin for platform ${platformId}`);
  return pin.version;
}

/** The repository's pinned version of an npm package, from a platform pin or the catalog. */
function pinnedPackageVersion(
  ctx: DetectContext,
  packageName: string,
): string | null {
  const platform = ctx.manifest.platforms.find(
    (p) => p.package === packageName,
  );
  if (platform !== undefined) return pinOf(ctx, platform.id);
  return ctx.catalog[packageName] ?? null;
}

async function runCheck(
  check: CheckSpec,
  platform: Platform,
  target: string,
  ctx: DetectContext,
): Promise<CheckResult> {
  const base = {
    id: check.id,
    label: check.label,
    blocking: check.blocking === true,
  };
  const unknown = (detail: string): CheckResult => ({
    ...base,
    status: 'unknown',
    detail,
  });
  try {
    let ref: string | null;
    if (check.at === 'target') ref = target;
    else if (check.at === 'latest') ref = 'latest';
    else ref = pinnedPackageVersion(ctx, check.package);
    if (ref === null)
      return unknown(`${check.package} is not pinned in this repository.`);
    const doc = await ctx.registry.versionDoc(check.package, ref);
    if (doc === null)
      return unknown(`${check.package}@${ref} is not published (yet).`);

    const subjectVersion =
      check.subject.version === 'target' &&
      check.subject.platform === platform.id
        ? target
        : pinOf(ctx, check.subject.platform);
    const what = check.kind === 'engines-node' ? 'node' : (check.peer ?? '');
    const range =
      check.kind === 'engines-node'
        ? doc.engines.node
        : doc.peerDependencies[what];
    const subjectName = ctx.manifest.platforms.find(
      (p) => p.id === check.subject.platform,
    )?.name;
    const subject = `${subjectName ?? check.subject.platform} ${subjectVersion}`;
    if (range === undefined)
      return unknown(
        `${check.package}@${doc.version} declares no ${check.kind === 'engines-node' ? 'engines.node' : `peer ${what}`} range.`,
      );
    const fits = satisfies(subjectVersion, range);
    if (fits === null)
      return unknown(
        `${check.package}@${doc.version}: could not read the range "${range}".`,
      );
    return {
      ...base,
      status: fits ? 'ok' : 'incompatible',
      detail: `${check.package}@${doc.version} requires ${what} ${range}; ${subject} ${fits ? 'is inside it' : 'is outside it'}.`,
    };
  } catch (error) {
    return unknown(`registry lookup failed: ${String(error)}`);
  }
}

function earliest(releases: Release[]): Release {
  return releases.reduce((a, b) => (b.published < a.published ? b : a));
}

export async function evaluatePlatform(
  platform: Platform,
  ctx: DetectContext,
): Promise<PlatformReport> {
  const pin = ctx.pins[platform.id];
  if (pin === undefined) throw new Error(`no pin for platform ${platform.id}`);
  const report: PlatformReport = {
    id: platform.id,
    name: platform.name,
    pinned: pin.version,
    pinSource: pin.source,
    status: 'current',
    newest: null,
    eligibleAt: null,
    candidate: null,
    error: null,
  };
  const pinnedMajor = major(pin.version);
  const releases = (await ctx.registry.releases(platform)).filter((r) => {
    const m = major(r.version);
    return m > pinnedMajor && (platform.majors === 'all' || m % 2 === 0);
  });
  if (releases.length === 0) return report;

  const newest = releases.reduce((a, b) =>
    compare(b.version, a.version) > 0 ? b : a,
  );
  report.newest = {
    version: newest.version,
    published: newest.published.toISOString(),
  };

  const cutoff = ctx.now.getTime() - ctx.ageGateMinutes * 60_000;
  const eligible = releases.filter((r) => r.published.getTime() <= cutoff);
  if (eligible.length === 0) {
    report.status = 'aging';
    const first = earliest(
      releases.filter((r) => major(r.version) === major(newest.version)),
    );
    report.eligibleAt = new Date(
      first.published.getTime() + ctx.ageGateMinutes * 60_000,
    ).toISOString();
    return report;
  }

  const targetMajor = Math.max(...eligible.map((r) => major(r.version)));
  const inMajor = releases.filter((r) => major(r.version) === targetMajor);
  const target = eligible
    .filter((r) => major(r.version) === targetMajor)
    .reduce((a, b) => (compare(b.version, a.version) > 0 ? b : a));
  const ga = earliest(inMajor);
  const due =
    platform.windowDays === null
      ? null
      : new Date(
          ga.published.getTime() + platform.windowDays * 86_400_000,
        ).toISOString();
  const checks: CheckResult[] = [];
  for (const check of platform.checks) {
    checks.push(await runCheck(check, platform, target.version, ctx));
  }
  const candidate: Candidate = {
    platform: platform.id,
    name: platform.name,
    pinned: pin.version,
    major: targetMajor,
    version: target.version,
    published: target.published.toISOString(),
    ga: ga.published.toISOString(),
    due,
    cadence: platform.cadence,
    adrGated: platform.adrGated,
    lts: target.lts,
    checks,
  };
  report.candidate = candidate;
  report.status = checks.some((c) => c.blocking && c.status !== 'ok')
    ? 'deferred'
    : 'candidate';
  return report;
}

/** Evaluates every platform. A platform whose lookup fails is reported with status `error`. */
export async function detect(
  ctx: DetectContext,
): Promise<{ plan: Plan; reports: PlatformReport[] }> {
  const reports: PlatformReport[] = [];
  for (const platform of ctx.manifest.platforms) {
    try {
      reports.push(await evaluatePlatform(platform, ctx));
    } catch (error) {
      const pin = ctx.pins[platform.id];
      reports.push({
        id: platform.id,
        name: platform.name,
        pinned: pin?.version ?? '?',
        pinSource: pin?.source ?? 'fallback',
        status: 'error',
        newest: null,
        eligibleAt: null,
        candidate: null,
        error: String(error),
      });
    }
  }
  const candidates = reports.flatMap((r) =>
    r.status === 'candidate' && r.candidate !== null ? [r.candidate] : [],
  );
  return {
    plan: {
      generatedAt: ctx.now.toISOString(),
      ageGateMinutes: ctx.ageGateMinutes,
      candidates,
    },
    reports,
  };
}
