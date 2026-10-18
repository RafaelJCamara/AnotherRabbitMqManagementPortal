// Release data for the platform lane: published versions with their publish time (npm packument
// `time`, Node's index.json `date`) and the engines/peer ranges of one version. The network is
// behind the `Registry` interface so the self-test runs against fakes.
import { parseVersion } from './semver.ts';
import type { Platform } from './manifest.ts';

export interface Release {
  version: string;
  published: Date;
  /** Node only: the LTS codename once the release line is promoted, otherwise null. */
  lts: string | null;
}

export interface VersionDoc {
  version: string;
  engines: Record<string, string>;
  peerDependencies: Record<string, string>;
}

export interface Registry {
  /** Every stable release of a platform, in any order. */
  releases(platform: Platform): Promise<Release[]>;
  /** The metadata of `package@ref`, where ref is an exact version or a dist-tag. Null when it does not exist. */
  versionDoc(packageName: string, ref: string): Promise<VersionDoc | null>;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record(value))) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

/** Stable releases from an npm packument. A version without a valid publish time is skipped. */
export function npmReleases(packument: unknown): Release[] {
  const time = record(record(packument).time);
  const out: Release[] = [];
  for (const version of Object.keys(record(record(packument).versions))) {
    if (parseVersion(version) === null) continue;
    const stamp = time[version];
    const published = typeof stamp === 'string' ? new Date(stamp) : null;
    if (published === null || Number.isNaN(published.getTime())) continue;
    out.push({ version, published, lts: null });
  }
  return out;
}

/** Releases from https://nodejs.org/dist/index.json (`v26.12.0`, `date`, `lts`). */
export function nodeReleases(index: unknown): Release[] {
  const out: Release[] = [];
  if (!Array.isArray(index)) return out;
  for (const entry of index as unknown[]) {
    const item = record(entry);
    const raw = item.version;
    const date = item.date;
    if (typeof raw !== 'string' || typeof date !== 'string') continue;
    const version = raw.replace(/^v/, '');
    const published = new Date(`${date}T00:00:00Z`);
    if (parseVersion(version) === null || Number.isNaN(published.getTime()))
      continue;
    out.push({
      version,
      published,
      lts: typeof item.lts === 'string' ? item.lts : null,
    });
  }
  return out;
}

export function versionDocFrom(value: unknown): VersionDoc | null {
  const doc = record(value);
  if (typeof doc.version !== 'string') return null;
  return {
    version: doc.version,
    engines: stringMap(doc.engines),
    peerDependencies: stringMap(doc.peerDependencies),
  };
}

export type JsonFetcher = (url: string) => Promise<unknown>;

/** GET a JSON document; throws on a network error or a non-2xx answer. */
export const fetchJson: JsonFetcher = async (url) => {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'platform-upgrade-lane',
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`GET ${url} answered ${String(response.status)}`);
  }
  return await response.json();
};

const NPM = 'https://registry.npmjs.org';
const NODE_INDEX = 'https://nodejs.org/dist/index.json';

function npmPath(packageName: string): string {
  return packageName.startsWith('@')
    ? `@${encodeURIComponent(packageName.slice(1))}`
    : encodeURIComponent(packageName);
}

export function httpRegistry(get: JsonFetcher = fetchJson): Registry {
  // The Node index and each packument are read once per run.
  const memo = new Map<string, Promise<unknown>>();
  const once = (url: string): Promise<unknown> => {
    let hit = memo.get(url);
    if (hit === undefined) {
      hit = get(url);
      memo.set(url, hit);
    }
    return hit;
  };
  return {
    async releases(platform) {
      if (platform.source === 'node')
        return nodeReleases(await once(NODE_INDEX));
      if (platform.package === undefined)
        throw new Error(`${platform.id}: no npm package to read.`);
      return npmReleases(await once(`${NPM}/${npmPath(platform.package)}`));
    },
    async versionDoc(packageName, ref) {
      try {
        return versionDocFrom(
          await once(
            `${NPM}/${npmPath(packageName)}/${encodeURIComponent(ref)}`,
          ),
        );
      } catch (error) {
        if (String(error).includes('answered 404')) return null;
        throw error;
      }
    },
  };
}
