// Public API of the broker-lab project: where its files live. The images, the helpers and the
// verify command are in libs/testkit (startBroker) and the targets of project.json.
import { resolve } from 'node:path';

/** Absolute path of the broker-lab folder (Dockerfile, versions.json, compose.3node.yaml, ...). */
export const BROKER_LAB_DIR = resolve(import.meta.dirname, '..');
