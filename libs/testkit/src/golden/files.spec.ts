import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { compareRecording, readManifest, writeRecording } from './files.ts';
import { LAVINMQ, type Recording } from './record.ts';
import type { FixtureEntry, FixtureManifest } from './types.ts';

const entry = (
  id: string,
  file: string,
  extra: Partial<FixtureEntry> = {},
): FixtureEntry => ({
  id,
  kind: 'endpoint',
  method: 'GET',
  path: `/api/${id}`,
  sent: `/api/${id}`,
  auth: 'guest',
  status: 200,
  file,
  bytes: 1,
  ...extra,
});

function manifest(
  kind: 'mgmt' | 'prometheus',
  entries: FixtureEntry[],
): FixtureManifest {
  return {
    schema: 1,
    kind,
    product: 'lavinmq',
    version: '2.10.2',
    image: LAVINMQ.image,
    digest: LAVINMQ.digest,
    stats: 'n/a',
    brokerConfig: [],
    seed: { id: 's', sha256: 'abc', refused: [] },
    recorder: 'test',
    entries,
    skipped: [],
  };
}

function recording(answers: Record<string, unknown>, prom: string): Recording {
  const entries = Object.keys(answers).map((id) => entry(id, `${id}.json`));
  const mgmt = manifest('mgmt', entries);
  const promManifest = manifest('prometheus', [
    entry('prometheus.metrics', 'prometheus.metrics.prom', {
      kind: 'prometheus',
    }),
  ]);
  const files = new Map<string, string>([
    [`mgmt/lavinmq-2.10.2/default/manifest.json`, JSON.stringify(mgmt)],
    [
      `prometheus/lavinmq-2.10.2/default/manifest.json`,
      JSON.stringify(promManifest),
    ],
    [`prometheus/lavinmq-2.10.2/default/prometheus.metrics.prom`, prom],
  ]);
  for (const [id, body] of Object.entries(answers)) {
    files.set(`mgmt/lavinmq-2.10.2/default/${id}.json`, JSON.stringify(body));
  }
  return {
    target: LAVINMQ,
    mode: 'default',
    files,
    mgmt,
    prometheus: promManifest,
  };
}

const PROM = '# TYPE lavinmq_up gauge\nlavinmq_up 1\n';

describe('writing and comparing recordings', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'golden-files-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes the manifests and the answers, replacing what an earlier recording left', () => {
    writeRecording(root, recording({ a: { x: 1 }, b: [] }, PROM));
    writeRecording(root, recording({ a: { x: 1 } }, PROM));
    const written = readManifest(root, 'mgmt/lavinmq-2.10.2/default');
    expect(written?.entries.map((e) => e.id)).toEqual(['a']);
    expect(() =>
      readFileSync(join(root, 'mgmt/lavinmq-2.10.2/default/b.json')),
    ).toThrow();
    expect(readManifest(root, 'mgmt/nope/default')).toBeUndefined();
  });

  it('finds no difference when only values change (uptimes, counters, label values)', () => {
    writeRecording(root, recording({ a: { uptime: 1, name: 'one' } }, PROM));
    const later = recording(
      { a: { uptime: 99, name: 'two' } },
      '# TYPE lavinmq_up gauge\nlavinmq_up 7\n',
    );
    expect(compareRecording(root, later)).toEqual([]);
  });

  it('reports a field that appears or disappears, and a changed status or version', () => {
    writeRecording(root, recording({ a: { x: 1, policy: 'p' } }, PROM));
    const drift = recording({ a: { x: 1, extra: true } }, PROM);
    const withStatus: Recording = {
      ...drift,
      mgmt: {
        ...drift.mgmt,
        version: '2.11.0',
        entries: drift.mgmt.entries.map((e) => ({ ...e, status: 500 })),
      },
    };
    const problems = compareRecording(root, withStatus);
    expect(problems).toContain(
      'mgmt/lavinmq-2.10.2/default: version was 2.10.2, now 2.11.0',
    );
    expect(problems).toContain(
      'mgmt/lavinmq-2.10.2/default/a: - $.policy: string',
    );
    expect(problems).toContain(
      'mgmt/lavinmq-2.10.2/default/a: + $.extra: boolean',
    );
    expect(
      problems.some((line) =>
        line.includes('the request or the status changed (200 to 500)'),
      ),
    ).toBe(true);
  });

  it('reports new and removed entries, a changed seed, and a missing committed recording', () => {
    writeRecording(root, recording({ a: {}, b: {} }, PROM));
    const next = recording({ a: {}, c: {} }, PROM);
    const changedSeed: Recording = {
      ...next,
      mgmt: {
        ...next.mgmt,
        seed: { id: 's', sha256: 'zzz', refused: ['x (400)'] },
      },
    };
    const problems = compareRecording(root, changedSeed);
    expect(problems).toContain(
      'mgmt/lavinmq-2.10.2/default/b: no longer recorded',
    );
    expect(problems).toContain('mgmt/lavinmq-2.10.2/default/c: new entry');
    expect(problems).toContain(
      'mgmt/lavinmq-2.10.2/default: the seed changed; re-record',
    );
    expect(problems.some((line) => line.includes('refused seed steps'))).toBe(
      true,
    );
    const elsewhere = mkdtempSync(join(tmpdir(), 'golden-empty-'));
    try {
      expect(compareRecording(elsewhere, next)).toEqual([
        'mgmt/lavinmq-2.10.2/default: no committed manifest',
        'prometheus/lavinmq-2.10.2/default: no committed manifest',
      ]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('ignores the client port of a connection name but not its host or the path otherwise', () => {
    const named = (path: string): Recording => {
      const base = recording({ one: { x: 1 } }, PROM);
      const mgmt = {
        ...base.mgmt,
        entries: base.mgmt.entries.map((e) => ({ ...e, path, sent: path })),
      };
      const files = new Map(base.files);
      files.set(
        'mgmt/lavinmq-2.10.2/default/manifest.json',
        JSON.stringify(mgmt),
      );
      return { ...base, mgmt, files };
    };
    writeRecording(
      root,
      named('/api/connections/192.0.2.1%3A41000%20-%3E%20192.0.2.2%3A5672'),
    );
    expect(
      compareRecording(
        root,
        named('/api/connections/192.0.2.1%3A52000%20-%3E%20192.0.2.2%3A5672'),
      ),
    ).toEqual([]);
    expect(
      compareRecording(
        root,
        named('/api/connections/192.0.2.9%3A41000%20-%3E%20192.0.2.2%3A5672'),
      ).length,
    ).toBeGreaterThan(0);
  });

  it('compares a plain-text answer word for word', () => {
    const textual = (body: string): Recording => {
      const base = recording({}, PROM);
      const mgmt = manifest('mgmt', [
        entry('health', 'health.txt', { status: 404 }),
      ]);
      const files = new Map(base.files);
      files.set('mgmt/lavinmq-2.10.2/default/health.txt', body);
      return { ...base, mgmt, files };
    };
    writeRecording(root, textual('404 Not Found\n'));
    writeFileSync(
      join(root, 'mgmt/lavinmq-2.10.2/default/manifest.json'),
      JSON.stringify(textual('').mgmt),
    );
    expect(compareRecording(root, textual('404 Not Found\n'))).toEqual([]);
    expect(compareRecording(root, textual('Gone')).length).toBe(2);
  });
});
