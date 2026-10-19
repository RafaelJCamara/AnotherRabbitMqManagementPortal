// The broker versions of the lab with their pinned digest and semantics era. The era comes from the
// registry's own resolver (`resolveEra`), so no version comparison is written here (I-3).
import { parseSemVer } from '@app/domain-model';
import { semanticsRegistry } from '@app/semantics';
import { loadPinnedDigests } from '../driver/lab-endpoint.ts';

export interface LabVersion {
  readonly version: string;
  readonly digest: string;
  readonly era: string;
}

export const eraOfVersion = (version: string): string => {
  const parsed = parseSemVer(version);
  if (parsed === null) throw new Error(`"${version}" is not a broker version`);
  // Plain version numbers with positive evidence for 4.3: this asks which behaviour the release has.
  return semanticsRegistry.resolveEra({
    nodeVersions: [parsed],
    ff43Enabled: true,
    qqMachineVersions: [],
    build: 'oss',
    lastVerified: [],
  }).era;
};

export function labVersions(
  pins: ReadonlyMap<string, string> = loadPinnedDigests(),
): LabVersion[] {
  return [...pins].map(([version, digest]) => ({
    version,
    digest,
    era: eraOfVersion(version),
  }));
}
