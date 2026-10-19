import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BUNDLES_MAX,
  BUNDLE_DIR,
  createDataDirBundleSink,
} from './data-dir-bundles.ts';
import { tempDir, type TempDir } from './testing/harness.ts';

const dirs: TempDir[] = [];
async function newDir(): Promise<string> {
  const made = await tempDir('bundle-sink-');
  dirs.push(made);
  return made.dir;
}
afterEach(async () => {
  for (const made of dirs.splice(0)) await made.cleanup();
});

const TOKEN = 'abcdefghij0123456789';
const bytes = (text: string) => new TextEncoder().encode(text);
const names = (dir: string) => readdirSync(join(dir, BUNDLE_DIR));

describe('the data-directory bundle sink', () => {
  it('writes the bundle byte for byte into its own directory under the token', async () => {
    const dir = await newDir();
    const sink = createDataDirBundleSink(dir);
    const data = Uint8Array.from({ length: 4096 }, (_, index) => index % 251);

    expect(await sink.write(TOKEN, data)).toBe('written');

    expect(names(dir)).toEqual([`bundle-${TOKEN}.json`]);
    expect(
      Buffer.from(data).equals(
        readFileSync(join(dir, BUNDLE_DIR, `bundle-${TOKEN}.json`)),
      ),
    ).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, BUNDLE_DIR)).mode & 0o777).toBe(0o700);
      expect(
        statSync(join(dir, BUNDLE_DIR, `bundle-${TOKEN}.json`)).mode & 0o777,
      ).toBe(0o600);
    }
  });

  it('a token is good once: the second use overwrites nothing and says unknown', async () => {
    const dir = await newDir();
    const sink = createDataDirBundleSink(dir);
    await sink.write(TOKEN, bytes('first'));

    expect(await sink.write(TOKEN, bytes('second'))).toBe('unknown-token');

    expect(
      readFileSync(join(dir, BUNDLE_DIR, `bundle-${TOKEN}.json`), 'utf8'),
    ).toBe('first');
  });

  it.each([
    '../../escape-0123456789',
    '..\\..\\escape-0123456789',
    'a/b/c/d/e/f/g/h/i/j/k/l',
    'C:\\temp\\x-0123456789012',
    'with.dot.0123456789012345',
    'short',
    '',
    'x'.repeat(129),
    `${TOKEN}\0.json`,
  ])('refuses %j as a token and creates nothing', async (token) => {
    const dir = await newDir();
    const sink = createDataDirBundleSink(dir);

    expect(await sink.write(token, bytes('x'))).toBe('unknown-token');

    expect(existsSync(join(dir, BUNDLE_DIR))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses to fill the directory: at BUNDLES_MAX files a new bundle is an error, not a silent drop', async () => {
    const dir = await newDir();
    await mkdir(join(dir, BUNDLE_DIR), { recursive: true });
    for (let n = 0; n < BUNDLES_MAX; n += 1) {
      await writeFile(join(dir, BUNDLE_DIR, `old-${String(n)}.json`), '{}');
    }
    const sink = createDataDirBundleSink(dir);

    await expect(sink.write(TOKEN, bytes('x'))).rejects.toThrow(
      /already holds/,
    );

    expect(names(dir)).toHaveLength(BUNDLES_MAX);
  });

  it('leaves no half a bundle when the write fails', async () => {
    const dir = await newDir();
    const sink = createDataDirBundleSink(dir);

    // Not bytes: the write throws after the file was created.
    await expect(sink.write(TOKEN, 42 as never)).rejects.toThrow();

    expect(names(dir)).toEqual([]);
  });
});
