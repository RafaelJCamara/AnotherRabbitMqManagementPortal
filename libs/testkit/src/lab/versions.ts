import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The broker-lab folder of the repository (Dockerfile, versions.json, compose files). */
export const LAB_DIR = fileURLToPath(
  new URL('../../../../testing/broker-lab/', import.meta.url),
);

/** One supported broker: the version, and the pinned digest of its official management image. */
export interface BrokerImage {
  readonly version: string;
  readonly digest: string;
  readonly support: string;
}

const VERSION = /^\d+\.\d+\.\d+$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Validates the contents of versions.json. Throws on anything but a clean, pinned list. */
export function parseBrokerVersions(json: unknown): BrokerImage[] {
  if (!isRecord(json) || !Array.isArray(json.brokers)) {
    throw new Error('versions.json must be an object with a "brokers" array');
  }
  const seen = new Set<string>();
  return (json.brokers as unknown[]).map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(
        `versions.json brokers[${String(index)}] is not an object`,
      );
    }
    const { version, digest, support } = entry;
    if (typeof version !== 'string' || !VERSION.test(version)) {
      throw new Error(
        `versions.json brokers[${String(index)}].version must be an exact x.y.z release`,
      );
    }
    if (typeof digest !== 'string' || !DIGEST.test(digest)) {
      throw new Error(
        `versions.json ${version}: digest must be sha256:<64 hex digits> (images are pinned by digest)`,
      );
    }
    if (typeof support !== 'string') {
      throw new Error(`versions.json ${version}: support must be a string`);
    }
    if (seen.has(version)) {
      throw new Error(`versions.json lists ${version} twice`);
    }
    seen.add(version);
    return { version, digest, support };
  });
}

/** Reads and validates `versions.json`. */
export function loadBrokerVersions(labDir: string = LAB_DIR): BrokerImage[] {
  const text = readFileSync(`${labDir}versions.json`, 'utf8');
  return parseBrokerVersions(JSON.parse(text));
}

/** Looks one version up; the error lists what is available. */
export function findBroker(
  version: string,
  brokers: readonly BrokerImage[] = loadBrokerVersions(),
): BrokerImage {
  const found = brokers.find((broker) => broker.version === version);
  if (!found) {
    throw new Error(
      `No broker-lab image for ${version}. Known versions: ${brokers.map((broker) => broker.version).join(', ')}.`,
    );
  }
  return found;
}

/** The local tag of the image built from the Dockerfile for a version. */
export const imageTag = (version: string): string =>
  `broker-lab/rabbitmq:${version}`;
