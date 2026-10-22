// M1-54 AC-22, the half that reads the chart library's source as text: no `innerHTML`, no animation or transition
// outside `@media (prefers-reduced-motion: no-preference)` (a chart never moves by itself, so reduced motion is
// honoured by construction), no direct network or socket call, no charting package, no forbidden claim, and no
// text of its own in a template (every text comes in through `ChartLabels`). It lives in a node tool because the
// library is browser code and may not read files. The mounted half is the component specs of `libs/ui/charts`.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = join(import.meta.dirname, '..', '..');
/** The components and the pure draw maths they use. */
const LIBRARIES = [
  join(ROOT, 'libs', 'ui', 'charts', 'src'),
  join(ROOT, 'libs', 'shared', 'chart-math', 'src'),
];

function sources() {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (
        /\.ts$/.test(entry.name) &&
        !/\.(spec|d)\.ts$/.test(entry.name) &&
        entry.name !== 'test-setup.ts' &&
        entry.name !== 'chart-spec-support.ts'
      ) {
        found.push({ path, text: readFileSync(path, 'utf8') });
      }
    }
  };
  for (const library of LIBRARIES) walk(library);
  return found;
}

describe('the chart library, read as text', () => {
  it('AC-22 it writes no innerHTML, calls no network, imports no charting package and makes no forbidden claim', () => {
    const files = sources();
    assert.ok(files.length >= 12, `only ${files.length} source files found`);
    const FORBIDDEN =
      /read-only|read only|non-destructive|nondestructive|without side effects/i;
    for (const file of files) {
      assert.doesNotMatch(
        file.text,
        /innerHTML|outerHTML|insertAdjacentHTML|bypassSecurityTrust/,
        file.path,
      );
      assert.doesNotMatch(
        file.text,
        /\bfetch\(|XMLHttpRequest|new WebSocket|EventSource|sendBeacon/,
        file.path,
      );
      assert.doesNotMatch(
        file.text,
        /from '(uplot|echarts|ngx-echarts|d3[^']*|chart\.js[^']*|highcharts[^']*)'/,
        file.path,
      );
      assert.doesNotMatch(file.text, FORBIDDEN, file.path);
    }
  });

  it('AC-22 no animation or transition exists outside prefers-reduced-motion: no-preference', () => {
    for (const file of sources()) {
      // Comments may talk about motion; code and styles may not. Remove the one place motion may live, then
      // none may be left.
      const code = file.text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      const outside = code.replace(
        /@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{[\s\S]*?\n {4}\}/g,
        '',
      );
      assert.doesNotMatch(
        outside,
        /\b(transition|animation|@keyframes|animate\(|requestAnimationFrame|setInterval)\b/,
        file.path,
      );
    }
  });
});
