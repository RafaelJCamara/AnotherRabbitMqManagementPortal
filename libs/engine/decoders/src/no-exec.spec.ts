import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...sources(path));
    } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
      out.push(path);
    }
  }
  return out;
}

// What would let a payload run code or reach outside the library: dynamic evaluation, a VM, a
// child process, a require, a dynamic import, the network, the file system, or a sandbox escape
// hatch. A pickle or PHP payload is only ever read as bytes (OQ-966).
const FORBIDDEN: [string, RegExp][] = [
  ['eval(', /\beval\s*\(/],
  ['new Function', /\bnew\s+Function\b/],
  ['Function(', /\bFunction\s*\(/],
  ['vm', /from\s+['"](?:node:)?vm['"]/],
  ['child_process', /(?:node:)?child_process/],
  ['require(', /\brequire\s*\(/],
  ['dynamic import', /\bimport\s*\(/],
  ['fs', /from\s+['"](?:node:)?fs(?:\/promises)?['"]/],
  ['net', /from\s+['"](?:node:)?(?:net|tls|http|https|dgram|dns)['"]/],
  ['console', /\bconsole\./],
  ['process.env', /\bprocess\.env\b/],
];

describe('the decoders library never loads what it reads', () => {
  const files = sources(join(import.meta.dirname));

  it('M1-10 AC-3 imports no module that can run or load code, and calls no dynamic evaluation', () => {
    expect(files.length).toBeGreaterThan(15);
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
        // comments may name what the code avoids
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      for (const [name, pattern] of FORBIDDEN) {
        expect(pattern.test(text), `${file} uses ${name}`).toBe(false);
      }
    }
  });

  it('M1-10 AC-3 imports only relative files and node built-ins (the worker cannot resolve aliases)', () => {
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(
        /(?:from|import)\s+['"]([^'"]+)['"]/g,
      )) {
        const specifier = match[1] ?? '';
        const ok =
          specifier.startsWith('./') ||
          specifier.startsWith('../') ||
          specifier.startsWith('node:');
        expect(ok, `${file} imports ${specifier}`).toBe(true);
        if (specifier.startsWith('.')) {
          expect(
            specifier.endsWith('.ts'),
            `${file} imports ${specifier}`,
          ).toBe(true);
        }
      }
    }
  });
});
