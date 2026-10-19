// Reads recorded evidence for the three-way assertion. Read only: nothing in the conformance suite
// writes `testing/lab-evidence` (I-14, amendment A-20); the recorder does, in the CI workflow only.
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROKER_VERSION, CF_ID } from '../record/evidence.ts';
import type { EvidenceFile } from './three-way.ts';

/** The repository's evidence tree. */
export const EVIDENCE_ROOT = fileURLToPath(
  new URL('../../../../testing/lab-evidence', import.meta.url),
);

const MAX_BYTES = 4 * 1024 * 1024;

/** `<root>/<version>/<CF-id>.json` as the store finds it: present, missing, or unreadable (a link, too large). */
export function readEvidenceFile(
  root: string,
  version: string,
  cfId: string,
): EvidenceFile {
  if (!BROKER_VERSION.test(version) || !CF_ID.test(cfId)) {
    throw new Error(
      `"${version}" / "${cfId}" is not a broker version and a conformance id`,
    );
  }
  const path = `${version}/${cfId}.json`;
  const file = join(root, version, `${cfId}.json`);
  let stat;
  try {
    stat = lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'missing', path };
    }
    throw error;
  }
  if (!stat.isFile() || stat.size > MAX_BYTES)
    return { kind: 'unreadable', path };
  return { kind: 'present', path, text: readFileSync(file, 'utf8') };
}
