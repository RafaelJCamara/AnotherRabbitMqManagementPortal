// The lab broker versions the CI workflows plan over: testing/broker-lab/versions.json (M0-14).
// Node built-ins only, so a workflow step can run the CLIs that use it with `node` and no build.
import { readFileSync } from 'node:fs';

/** An exact `major.minor.patch`; the workflows never plan over a range or a tag. */
export const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

export const VERSIONS_FILE = 'testing/broker-lab/versions.json';

/** The versions of the file, in file order; refuses an empty list, a duplicate or a version that is not exact. */
export function parseLabVersions(text: string): string[] {
  const parsed: unknown = JSON.parse(text);
  const brokers =
    typeof parsed === 'object' && parsed !== null && 'brokers' in parsed
      ? parsed.brokers
      : undefined;
  if (!Array.isArray(brokers) || brokers.length === 0) {
    throw new Error(`${VERSIONS_FILE} lists no broker`);
  }
  const versions = brokers.map((broker: unknown) => {
    const version =
      typeof broker === 'object' && broker !== null && 'version' in broker
        ? broker.version
        : undefined;
    if (typeof version !== 'string' || !EXACT_VERSION.test(version)) {
      throw new Error(`${VERSIONS_FILE}: a broker version is not exact`);
    }
    return version;
  });
  if (new Set(versions).size !== versions.length) {
    throw new Error(`${VERSIONS_FILE} lists a version twice`);
  }
  return versions;
}

export function readLabVersions(path: string): string[] {
  return parseLabVersions(readFileSync(path, 'utf8'));
}
