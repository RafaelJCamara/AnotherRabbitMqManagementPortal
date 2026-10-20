import { describe, expect, it } from 'vitest';
import { parseLabVersions } from './lab-versions.ts';
import { planConformance } from './plan.ts';
import {
  parseChangedFiles,
  parseProjectList,
  parseRevision,
  parseShards,
  renderOutputs,
} from './plan-input.ts';

describe('plan input parsers', () => {
  it('accepts a commit or a plain ref and refuses everything else as unknown', () => {
    expect(parseRevision('origin/main')).toBe('origin/main');
    expect(parseRevision('0123456789abcdef0123456789abcdef01234567')).toBe(
      '0123456789abcdef0123456789abcdef01234567',
    );
    expect(parseRevision(' HEAD~1 ')).toBe('HEAD~1');
    for (const bad of [
      undefined,
      '',
      '0000000000000000000000000000000000000000',
      '--upload-pack=x',
      '-f',
      'a b',
      'a;b',
      '$(x)',
      'a\nb',
    ]) {
      expect(parseRevision(bad), String(bad)).toBeNull();
    }
  });

  it('reads the shard count: default 2, 1 to 16, nothing else', () => {
    expect(parseShards(undefined)).toBe(2);
    expect(parseShards('')).toBe(2);
    expect(parseShards('1')).toBe(1);
    expect(parseShards('16')).toBe(16);
    for (const bad of ['0', '17', '-1', '2.5', 'two', '1e1']) {
      expect(() => parseShards(bad), bad).toThrow(/SHARDS/);
    }
  });

  it('reads the Nx project list only when it is a list of names', () => {
    expect(parseProjectList('["a","b"]\n')).toEqual(['a', 'b']);
    expect(parseProjectList('[]')).toEqual([]);
    for (const bad of ['', 'a\nb', '{"a":1}', '[1]', 'null', '["a",null]']) {
      expect(parseProjectList(bad), bad).toBeNull();
    }
  });

  it('splits the NUL separated changed files', () => {
    expect(parseChangedFiles('a/b.ts\0c d.ts\0')).toEqual(['a/b.ts', 'c d.ts']);
    expect(parseChangedFiles('')).toEqual([]);
  });

  it('renders the two workflow outputs on single lines', () => {
    const plan = planConformance({
      affectedProjects: ['semantics'],
      changedFiles: [],
      versions: ['4.3.6'],
      shards: 1,
    });
    expect(renderOutputs(plan)).toBe(
      'affected=true\nmatrix={"include":[{"version":"4.3.6","shard":"1/1"}]}\n',
    );
  });

  it('reads the lab versions strictly', () => {
    expect(
      parseLabVersions('{"brokers":[{"version":"4.3.6"},{"version":"4.2.9"}]}'),
    ).toEqual(['4.3.6', '4.2.9']);
    for (const bad of [
      '{}',
      '{"brokers":[]}',
      '{"brokers":[{"version":"4.3"}]}',
      '{"brokers":[{"version":"4.3.6"},{"version":"4.3.6"}]}',
      '{"brokers":[{}]}',
    ]) {
      expect(() => parseLabVersions(bad), bad).toThrow();
    }
  });
});
