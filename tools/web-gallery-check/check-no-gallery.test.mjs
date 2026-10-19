import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { check, galleryTraces, MARKERS } from './check-no-gallery.mjs';

const roots = [];
function build(files) {
  const root = mkdtempSync(join(tmpdir(), 'gallery-check-'));
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

const CLEAN = {
  'main-ABC.js': 'console.log("app")',
  'index.html': '<app-root>',
};
const WITH_GALLERY = {
  ...CLEAN,
  'chunk-XYZ.js': 'selectors:[["app-dev-gallery"]]',
};

describe('check-no-gallery', () => {
  it('AC-2 passes when production is clean and development has the gallery', () => {
    assert.deepEqual(check(build(CLEAN), build(WITH_GALLERY)), []);
  });

  it('AC-2 fails when a production file carries a marker, each marker', () => {
    for (const marker of MARKERS) {
      const production = build({ ...CLEAN, 'main-ABC.js': `x("${marker}")` });
      const problems = check(production, build(WITH_GALLERY));
      assert.equal(problems.length, 1, marker);
      assert.match(problems[0], /production build contains the gallery/);
    }
  });

  it('AC-2 fails when a production file is named after the gallery', () => {
    const production = build({ ...CLEAN, 'chunk-Gallery-ABC.js': 'x' });
    assert.equal(check(production, build(WITH_GALLERY)).length, 1);
  });

  it('AC-2 the markers are the ones the gallery source really carries', () => {
    const source = readFileSync(
      new URL('../../apps/web/src/app/gallery/gallery.ts', import.meta.url),
      'utf8',
    );
    assert.deepEqual(MARKERS, ['app-dev-gallery', 'Design system gallery']);
    for (const marker of MARKERS) {
      assert.ok(
        source.includes(marker),
        `gallery.ts no longer contains ${marker}`,
      );
    }
  });

  it('finds a marker in a nested directory', () => {
    const production = build({
      ...CLEAN,
      'media/deep/a.js': 'app-dev-gallery',
    });
    assert.equal(galleryTraces(production).length, 1);
  });

  it('fails when the development build shows nothing, so the scan is not blind', () => {
    const problems = check(build(CLEAN), build(CLEAN));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /cannot see it/);
  });

  it('fails on an empty production directory', () => {
    const problems = check(build({}), build(WITH_GALLERY));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /empty/);
  });
});
