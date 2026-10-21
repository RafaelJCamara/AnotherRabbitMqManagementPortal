import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';

import {
  GZIP_LEVEL,
  INITIAL_LIMIT,
  initialReferences,
  LAZY_EXCEPTIONS,
  LAZY_LIMIT,
  measure,
} from './check-budgets.mjs';

const roots = [];
function build(files) {
  const root = mkdtempSync(join(tmpdir(), 'web-budgets-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Deterministic bytes that gzip cannot shrink much, so a size is stable across machines. */
function noise(bytes) {
  const parts = [];
  let seed = 'budgets';
  for (let length = 0; length < bytes; length += 32) {
    seed = createHash('sha256').update(seed).digest('hex');
    parts.push(seed);
  }
  return parts.join('').slice(0, bytes);
}
const gz = (content) => gzipSync(content, { level: GZIP_LEVEL }).length;

const INDEX = [
  '<!doctype html><html><head>',
  '<link rel="stylesheet" href="styles-AAA.css">',
  '<link rel="modulepreload" href="chunk-BBB.js">',
  '</head><body><app-root></app-root>',
  '<script src="main-CCC.js" type="module"></script>',
  '</body></html>',
].join('');

function output(sizes = {}) {
  return {
    'index.html': INDEX,
    'styles-AAA.css': noise(sizes.styles ?? 200),
    'chunk-BBB.js': noise(sizes.chunk ?? 300),
    'main-CCC.js': noise(sizes.main ?? 400),
    ...(sizes.lazy === undefined ? {} : { 'lazy-DDD.js': noise(sizes.lazy) }),
  };
}

describe('web budgets', () => {
  it('AC-3 fails above the initial limit, passes at it, checks lazy chunks and rejects an empty output', () => {
    const files = output();
    const dir = build(files);
    const exact =
      gz(files['styles-AAA.css']) +
      gz(files['chunk-BBB.js']) +
      gz(files['main-CCC.js']);

    // passes at the limit, fails one byte above it, and names the files with their sizes
    assert.deepEqual(measure(dir, { initialLimit: exact }).problems, []);
    const over = measure(dir, { initialLimit: exact - 1 });
    assert.equal(over.initial.total, exact);
    assert.equal(over.problems.length, 1);
    assert.match(over.problems[0], new RegExp(`${exact} bytes gzip`));
    for (const file of ['styles-AAA.css', 'chunk-BBB.js', 'main-CCC.js']) {
      assert.match(over.problems[0], new RegExp(file.replace('.', '\\.')));
    }

    // the real limits
    assert.equal(INITIAL_LIMIT, 350_000);
    assert.equal(LAZY_LIMIT, 200_000);
    assert.deepEqual(measure(dir).problems, []);

    // a lazy chunk is checked on its own, and does not count as initial
    const lazyFiles = output({ lazy: 3_000 });
    const lazyDir = build(lazyFiles);
    const lazySize = gz(lazyFiles['lazy-DDD.js']);
    const lazyOk = measure(lazyDir, { lazyLimit: lazySize });
    assert.deepEqual(lazyOk.problems, []);
    assert.equal(lazyOk.initial.total, exact);
    assert.deepEqual(lazyOk.lazy, [
      { file: 'lazy-DDD.js', size: lazySize, limit: lazySize },
    ]);
    const lazyOver = measure(lazyDir, { lazyLimit: lazySize - 1 });
    assert.equal(lazyOver.problems.length, 1);
    assert.match(lazyOver.problems[0], /lazy-DDD\.js/);

    // a scan that sees nothing proves nothing
    assert.notDeepEqual(measure(build({})).problems, []);
    assert.notDeepEqual(
      measure(join(tmpdir(), 'web-budgets-missing')).problems,
      [],
    );
    assert.notDeepEqual(
      measure(build({ 'index.html': '<html></html>' })).problems,
      [],
    );
    assert.notDeepEqual(
      measure(build({ 'index.html': 'not html at all', 'main.js': 'x' }))
        .problems,
      [],
    );
    const missing = output();
    delete missing['main-CCC.js'];
    assert.match(measure(build(missing)).problems.join('\n'), /main-CCC\.js/);
  });

  it('reads scripts, modulepreloads and stylesheets and ignores other links and other origins', () => {
    const html = [
      '<link rel="icon" href="favicon.ico">',
      '<link href="styles.css" rel="stylesheet">',
      "<link rel='modulepreload' href='/chunk-1.js?v=2'>",
      '<link rel="stylesheet" href="https://cdn.example/x.css">',
      '<script src="//cdn.example/y.js"></script>',
      '<script src="main.js" type="module"></script>',
      '<script>inline()</script>',
    ].join('\n');
    assert.deepEqual(initialReferences(html).toSorted(), [
      'chunk-1.js',
      'main.js',
      'styles.css',
    ]);
  });

  it('measures nested lazy chunks by their path and skips files that are not code', () => {
    const files = {
      ...output(),
      'media/pic.png': noise(5_000),
      'chunk-ZZZ.js.map': noise(5_000),
      'deep/lazy-EEE.js': noise(100),
    };
    const result = measure(build(files));
    assert.deepEqual(
      result.lazy.map(({ file }) => file),
      ['deep/lazy-EEE.js'],
    );
  });

  it('gives the chunk that holds AG Grid its own limit and every other chunk the lazy limit (ADR-021, OQ-757)', () => {
    const [grid] = LAZY_EXCEPTIONS;
    assert.ok(grid);
    assert.ok(grid.limit > LAZY_LIMIT);
    // A lazy chunk of about 215 000 bytes gzip with the marker in it: over the lazy limit, inside the exception.
    const marked = (bytes) => `${grid.marker}${noise(bytes)}`;
    const big = { ...output(), 'lazy-GRID.js': marked(400_000) };
    const bigSize = gz(big['lazy-GRID.js']);
    assert.ok(bigSize > LAZY_LIMIT && bigSize < grid.limit, String(bigSize));
    assert.deepEqual(measure(build(big)).problems, []);
    // The same bytes without the marker are an ordinary chunk and fail at the lazy limit.
    const plain = { ...output(), 'lazy-PLAIN.js': noise(400_000) };
    const plainProblems = measure(build(plain)).problems;
    assert.equal(plainProblems.length, 1);
    assert.match(plainProblems[0], new RegExp(`limit of ${LAZY_LIMIT}`));
    // The exception is a ceiling too: a marked chunk above it fails and names the exception's limit.
    const huge = { ...output(), 'lazy-HUGE.js': marked(800_000) };
    const hugeProblems = measure(build(huge)).problems;
    assert.equal(hugeProblems.length, 1);
    assert.match(hugeProblems[0], new RegExp(`limit of ${grid.limit}`));
  });
});
