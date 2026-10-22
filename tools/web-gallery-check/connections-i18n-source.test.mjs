// M0-52 AC-11, the half that reads the connections feature's source as text: every key literal of the source is a key of the
// English file, every key of the file is asked for somewhere, and neither the file nor the source makes a claim the
// honest-wording rule (DC-15) forbids or writes `innerHTML`. It lives in a node tool, not in the feature or in
// the testkit, because the feature is browser code and may not read files, and a generated e2e workspace of the
// testkit has no connections feature. The other half (what the mounted pages show) is `connections-i18n.component.spec.ts` in the feature.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const FEATURE = join(
  import.meta.dirname,
  '..',
  '..',
  'libs',
  'ui',
  'feature-connections',
  'src',
);

const en = JSON.parse(readFileSync(join(FEATURE, 'i18n', 'en.json'), 'utf8'));

function leaves(tree, path) {
  return Object.entries(tree).flatMap(([name, value]) =>
    typeof value === 'string'
      ? [`${path}.${name}`]
      : leaves(value, `${path}.${name}`),
  );
}

function texts(tree) {
  return Object.values(tree).flatMap((value) =>
    typeof value === 'string' ? [value] : texts(value),
  );
}

const KEYS = leaves(en, 'connections');

/** The library's own source (templates are inline): no specs and no spec helpers (`lib/testing`). */
function sources() {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'testing') walk(path);
      } else if (
        /\.(ts|html)$/.test(entry.name) &&
        !/\.(spec|d)\.ts$/.test(entry.name) &&
        entry.name !== 'test-setup.ts'
      ) {
        found.push({ path, text: readFileSync(path, 'utf8') });
      }
    }
  };
  walk(FEATURE);
  // `src/testing.ts` is the marked scope for the specs of the apps that mount the feature, not product code.
  return found.filter((file) => !file.path.endsWith(join('src', 'testing.ts')));
}

/** A key literal as written in the source, with `${...}` parts as wildcards. */
function literalPatterns(text) {
  const found = [];
  for (const match of text.matchAll(
    /(['"`])(connections\.(?:[A-Za-z0-9_.-]|\$\{[^}]*\})+)\1/g,
  )) {
    found.push(match[2]);
  }
  return found;
}

function toRegExp(literal) {
  const escaped = literal
    .split(/\$\{[^}]*\}/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&'))
    .join('[A-Za-z0-9_.-]+'); // a value can itself be dotted: `views.create`
  // A literal that ends in a dot is the front of a key the code finishes with a value (`'...facet.' + facet`).
  const tail = literal.endsWith('.') ? '[A-Za-z0-9_.-]+' : '';
  return new RegExp(`^${escaped}${tail}$`);
}

describe('the connections strings, read as text', () => {
  it('AC-11 every key literal of the source is a key of the English file, and every key is asked for', () => {
    const files = sources();
    assert.ok(files.length > 12, `only ${files.length} source files found`);
    const literals = files.flatMap((file) => literalPatterns(file.text));
    assert.ok(literals.length > 40, `only ${literals.length} key literals`);

    // Every literal names a key (or, with a wildcard, at least one).
    for (const literal of literals) {
      const regExp = toRegExp(literal);
      assert.ok(
        KEYS.some((key) => regExp.test(key)),
        `no key for ${literal}`,
      );
    }
    // Every key is named by some literal; the names a template builds from engine data are wildcards above.
    const patterns = literals.map(toRegExp);
    const unused = KEYS.filter((key) => !patterns.some((p) => p.test(key)));
    assert.deepEqual(unused, [], 'keys no source asks for');
  });

  it('AC-11 neither the English file nor the source makes a forbidden claim or writes innerHTML', () => {
    const FORBIDDEN =
      /read-only|read only|non-destructive|nondestructive|without side effects/i;
    const words = texts(en);
    assert.equal(words.length, KEYS.length);
    for (const word of words) assert.doesNotMatch(word, FORBIDDEN);
    for (const file of sources()) {
      assert.doesNotMatch(
        file.text,
        /innerHTML|outerHTML|insertAdjacentHTML|bypassSecurityTrust/,
        file.path,
      );
      assert.doesNotMatch(file.text, FORBIDDEN, file.path);
    }
  });
});
