// Reads the committed golden fixtures (testing/fixtures, M0-25). The recorder lives in
// `libs/testkit/src/golden` and an adapter may not import the testkit, so the manifest shape is
// declared here as far as the specs read it; `manifest.json` is the contract between the two.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FIXTURES_ROOT = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'testing',
  'fixtures',
);

export interface Entry {
  readonly id: string;
  readonly kind: 'endpoint' | 'error-probe' | 'prometheus';
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean>>;
  readonly body?: unknown;
  readonly sent: string;
  readonly auth: string;
  readonly status: number;
  readonly file: string;
  readonly bytes: number;
  readonly envelope?: boolean;
}

export interface Manifest {
  readonly schema: 1;
  readonly kind: 'mgmt' | 'prometheus';
  readonly product: 'rabbitmq' | 'lavinmq';
  readonly version: string;
  readonly image: string;
  readonly digest: string;
  readonly stats: 'on' | 'off' | 'n/a';
  readonly brokerConfig: readonly string[];
  readonly seed: {
    readonly id: string;
    readonly sha256: string;
    readonly refused: readonly string[];
  };
  readonly recorder: string;
  readonly entries: readonly Entry[];
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
}

export interface Recording {
  /** `4.3.6/stats-off`, `lavinmq-2.10.2/default`. */
  readonly key: string;
  /** The directory name of the target: `4.3.6`, `lavinmq-2.10.2`. */
  readonly target: string;
  readonly mode: string;
  readonly dir: string;
  readonly manifest: Manifest;
}

/** Every recording of one kind, in a stable order. */
export function loadRecordings(kind: 'mgmt' | 'prometheus'): Recording[] {
  const base = join(FIXTURES_ROOT, kind);
  if (!existsSync(base)) return [];
  const out: Recording[] = [];
  for (const target of readdirSync(base).sort()) {
    for (const mode of readdirSync(join(base, target)).sort()) {
      const dir = join(base, target, mode);
      const file = join(dir, 'manifest.json');
      if (!existsSync(file)) continue;
      out.push({
        key: `${target}/${mode}`,
        target,
        mode,
        dir,
        manifest: JSON.parse(readFileSync(file, 'utf8')) as Manifest,
      });
    }
  }
  return out;
}

export function textOf(recording: Recording, entry: Entry): string {
  return readFileSync(join(recording.dir, entry.file), 'utf8');
}

export function entryOf(recording: Recording, id: string): Entry {
  const entry = recording.manifest.entries.find(
    (candidate) => candidate.id === id,
  );
  if (entry === undefined) {
    throw new Error(`${recording.key} has no entry ${id}`);
  }
  return entry;
}

/** The parsed JSON answer of an entry. */
export function jsonOf(recording: Recording, id: string): unknown {
  return JSON.parse(textOf(recording, entryOf(recording, id))) as unknown;
}

/** The objects of a list answer, whether the broker paged it or sent a bare array. */
export function itemsOf(answer: unknown): Record<string, unknown>[] {
  if (Array.isArray(answer)) return answer as Record<string, unknown>[];
  const items = (answer as { items?: unknown }).items;
  return Array.isArray(items) ? (items as Record<string, unknown>[]) : [];
}
