import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { defineJob, isDefinedJob, JOB_TYPE_PATTERN } from './define-job.ts';
import type { JobDef } from './types.ts';

const schema = z.strictObject({ n: z.number() });

function body(overrides: Partial<JobDef> = {}): JobDef {
  return {
    type: 'replay.run',
    version: 1,
    input: schema,
    checkpoint: schema,
    output: schema,
    resumable: false,
    async *run() {
      await Promise.resolve();
      yield { kind: 'checkpoint' as const };
      return { n: 1 };
    },
    onDrain: () => Promise.resolve(),
    ...overrides,
  };
}

describe('defineJob', () => {
  it('mints a frozen definition that isDefinedJob recognises', () => {
    const def = defineJob(body());

    expect(isDefinedJob(def)).toBe(true);
    expect(Object.isFrozen(def)).toBe(true);
    expect(def.type).toBe('replay.run');
  });

  it('is the only way to a definition: a literal, a spread copy and a proxy are not minted', () => {
    const def = defineJob(body());

    expect(isDefinedJob(body())).toBe(false);
    expect(isDefinedJob({ ...def })).toBe(false);
    expect(isDefinedJob(new Proxy(def, {}))).toBe(false);
    expect(isDefinedJob(null)).toBe(false);
    expect(isDefinedJob('replay.run')).toBe(false);
  });

  it('needs onDrain: a job must say how it parks what it holds (DC-04)', () => {
    expect(() => defineJob(body({ onDrain: undefined } as never))).toThrow(
      /onDrain is required/,
    );
  });

  it('needs run, a declared resumable flag and zod schemas', () => {
    expect(() => defineJob(body({ run: undefined } as never))).toThrow(
      /run is required/,
    );
    expect(() => defineJob(body({ resumable: undefined } as never))).toThrow(
      /resumable must be declared/,
    );
    expect(() => defineJob(body({ checkpoint: {} } as never))).toThrow(
      /checkpoint must be a zod schema/,
    );
    expect(() => defineJob(body({ input: {} } as never))).toThrow(
      /input must be a zod schema/,
    );
    expect(() => defineJob(body({ output: {} } as never))).toThrow(
      /output must be a zod schema/,
    );
  });

  it('checks the type and the version', () => {
    for (const type of [
      'replay',
      'Replay.run',
      'replay.',
      '.run',
      '',
      'a b.c',
    ]) {
      expect(() => defineJob(body({ type }))).toThrow(/type must look like/);
    }
    expect(() => defineJob(body({ type: `a.${'b'.repeat(100)}` }))).toThrow(
      /type must look like/,
    );
    for (const version of [0, -1, 1.5, Number.NaN]) {
      expect(() => defineJob(body({ version }))).toThrow(/version/);
    }
    expect(JOB_TYPE_PATTERN.test('queues.purge-all')).toBe(true);
  });

  it('keeps the optional hooks it was given, and only those', () => {
    const plain = defineJob(body());
    const full = defineJob(
      body({
        concurrencyKey: () => 'k',
        throttle: () => ({ perSec: 1 }),
        preflight: () => Promise.resolve({ ok: true }),
      }),
    );

    expect(Object.keys(plain)).not.toContain('concurrencyKey');
    expect(Object.keys(plain)).not.toContain('preflight');
    expect(Object.keys(plain)).not.toContain('throttle');
    expect(full.concurrencyKey?.({ n: 1 })).toBe('k');
    expect(full.throttle?.({ n: 1 })).toEqual({ perSec: 1 });
  });
});
