// Writing a recording to `testing/fixtures`, and comparing a fresh one with what is committed (the
// refresh-diff of `record-golden --check`). The comparison is by shape, not by value (skeleton.ts):
// two recordings of one broker differ in uptimes and counters, and a diff of those would never
// be empty.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { dirOf, type Recording } from './record.ts';
import { diffShapes, jsonShape, prometheusShape } from './skeleton.ts';
import type { FixtureEntry, FixtureManifest } from './types.ts';

/** Replaces the two directories of a recording (management and Prometheus) with the new files. */
export function writeRecording(root: string, recording: Recording): void {
  for (const kind of ['mgmt', 'prometheus'] as const) {
    rmSync(join(root, dirOf(kind, recording.target, recording.mode)), {
      recursive: true,
      force: true,
    });
  }
  for (const [path, content] of recording.files) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

export function readManifest(
  root: string,
  directory: string,
): FixtureManifest | undefined {
  const file = join(root, directory, 'manifest.json');
  return existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as FixtureManifest)
    : undefined;
}

function shapeOf(entry: FixtureEntry, content: string): string[] {
  if (entry.file.endsWith('.json')) {
    return jsonShape(JSON.parse(content));
  }
  if (entry.file.endsWith('.prom')) return prometheusShape(content);
  // A plain-text answer is its own shape: the broker's words are what a client matches on.
  return [content.trim()];
}

/** The client port of a connection name (`ip:port -> ip:port`) changes with every run. */
const stable = (text: string): string =>
  text.replace(/(%3A|:)\d{1,5}(?=%20-%3E| ->)/g, '$1PORT');

/** The fields of an entry that are not the broker's values: they say what was asked and answered. */
const describeEntry = (entry: FixtureEntry): string =>
  JSON.stringify({
    id: entry.id,
    method: entry.method,
    path: stable(entry.path),
    query: entry.query,
    sent: stable(entry.sent),
    auth: entry.auth,
    status: entry.status,
    file: entry.file,
    envelope: entry.envelope,
  });

/**
 * Differences between a fresh recording and the committed fixtures, as readable lines. Empty means
 * the committed fixtures still describe what the broker answers.
 */
export function compareRecording(root: string, fresh: Recording): string[] {
  const problems: string[] = [];
  for (const kind of ['mgmt', 'prometheus'] as const) {
    const directory = dirOf(kind, fresh.target, fresh.mode);
    const committed = readManifest(root, directory);
    const next = kind === 'mgmt' ? fresh.mgmt : fresh.prometheus;
    if (committed === undefined) {
      problems.push(`${directory}: no committed manifest`);
      continue;
    }
    for (const key of [
      'product',
      'version',
      'image',
      'digest',
      'stats',
    ] as const) {
      if (committed[key] !== next[key]) {
        problems.push(
          `${directory}: ${key} was ${committed[key]}, now ${next[key]}`,
        );
      }
    }
    if (committed.seed.sha256 !== next.seed.sha256) {
      problems.push(`${directory}: the seed changed; re-record`);
    }
    if (
      JSON.stringify(committed.seed.refused) !==
      JSON.stringify(next.seed.refused)
    ) {
      problems.push(
        `${directory}: refused seed steps were [${committed.seed.refused.join(', ')}], now [${next.seed.refused.join(', ')}]`,
      );
    }
    const was = new Map(committed.entries.map((entry) => [entry.id, entry]));
    const is = new Map(next.entries.map((entry) => [entry.id, entry]));
    for (const id of was.keys()) {
      if (!is.has(id)) problems.push(`${directory}/${id}: no longer recorded`);
    }
    for (const [id, entry] of is) {
      const before = was.get(id);
      if (before === undefined) {
        problems.push(`${directory}/${id}: new entry`);
        continue;
      }
      if (describeEntry(before) !== describeEntry(entry)) {
        problems.push(
          `${directory}/${id}: the request or the status changed (${String(before.status)} to ${String(entry.status)})`,
        );
      }
      const file = join(root, directory, before.file);
      if (!existsSync(file)) {
        problems.push(`${directory}/${id}: ${before.file} is missing`);
        continue;
      }
      const freshContent = fresh.files.get(`${directory}/${entry.file}`) ?? '';
      const { removed, added } = diffShapes(
        shapeOf(before, readFileSync(file, 'utf8')),
        shapeOf(entry, freshContent),
      );
      for (const line of removed)
        problems.push(`${directory}/${id}: - ${line}`);
      for (const line of added) problems.push(`${directory}/${id}: + ${line}`);
    }
  }
  return problems;
}
