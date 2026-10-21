// End-to-end proof of M0-35: the action, topic and job generators run through the real `nx g` CLI in
// a throwaway copy of the workspace, the generated tests fail until the work is done (AC-1), and
// once it is done as docs/golden-path/ describes, lint, typecheck, test and api-docs-check pass
// (AC-2). The golden-path pages are the source of the work: the `sh generate` blocks are the
// commands that run, and each `file=` block is written over the file it names. A page that drifts
// from the generators fails here.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TempWorkspace, repoRoot, type RunResult } from './workspace.ts';

const PAGES = ['explorer.queues.list', 'queues.purge', 'tap.messages'] as const;

interface Block {
  language: string;
  info: string;
  text: string;
}

/** The fenced code blocks of a page, with the words after the language kept as `info`. */
function blocksOf(markdown: string): Block[] {
  return [...markdown.matchAll(/^```(\w*)([^\n]*)\n([\s\S]*?)^```$/gm)].map(
    (match) => ({
      language: match[1] ?? '',
      info: (match[2] ?? '').trim(),
      text: match[3] ?? '',
    }),
  );
}

/** `--a='b c' "d"` as words, the way a shell splits it: quotes group, and may sit inside a word. */
function words(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let open: string | undefined;
  let started = false;
  for (const char of line) {
    if (open !== undefined) {
      if (char === open) open = undefined;
      else current += char;
    } else if (char === "'" || char === '"') {
      open = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) out.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) out.push(current);
  return out;
}

const page = (name: string): Block[] =>
  blocksOf(
    readFileSync(join(repoRoot, 'docs', 'golden-path', `${name}.md`), 'utf8'),
  );

let workspace: TempWorkspace;

/** Nx prints a task's output only when it fails, unless asked to stream it. */
const STREAM = '--output-style=stream';

const ok = (result: RunResult): void => {
  expect(result.status, result.output).toBe(0);
};

const write = (path: string, content: string): void => {
  const full = join(workspace.root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
};

/** Runs every `pnpm nx g @app/generators:...` line of the `sh generate` blocks of a page. */
function generate(name: string): void {
  for (const block of page(name)) {
    if (block.language !== 'sh' || block.info !== 'generate') continue;
    for (const line of block.text.split('\n').filter(Boolean)) {
      const [pnpm, nx, g, generator, ...rest] = words(line);
      expect([pnpm, nx, g]).toEqual(['pnpm', 'nx', 'g']);
      ok(workspace.nx('g', generator ?? '', ...rest, '--no-interactive'));
    }
  }
}

/** Writes every `file=` block of a page over (or beside) the generated files. */
function implement(name: string): string[] {
  const written: string[] = [];
  for (const block of page(name)) {
    const path = /^file=(\S+)$/.exec(block.info)?.[1];
    if (path === undefined) continue;
    write(path, block.text);
    written.push(path);
  }
  return written;
}

const PROJECTS = [
  'svc-catalog',
  'svc-admin',
  'svc-tap',
  'svc-batch',
  'feature-explorer',
  'feature-admin',
  'contracts',
  'arch-tests',
];

beforeAll(() => {
  workspace = new TempWorkspace({ full: true });
  for (const name of PAGES) generate(name);
  // A job needs no page: it is a definition made with defineJob of @app/jobs.
  ok(
    workspace.nx(
      'g',
      '@app/generators:service-module',
      'svc-batch',
      '--no-interactive',
    ),
  );
  ok(
    workspace.nx(
      'g',
      '@app/generators:job',
      'queues.purge-many',
      '--module=svc-batch',
      '--no-interactive',
    ),
  );
}, 600_000);

afterAll(() => {
  workspace.dispose();
});

describe('the golden-path pages', () => {
  it('each page has a generate block, and files that its commands create or replace', () => {
    for (const name of PAGES) {
      const blocks = page(name);
      expect(
        blocks.some(
          (block) => block.language === 'sh' && block.info === 'generate',
        ),
        name,
      ).toBe(true);
      expect(
        blocks.filter((block) => block.info.startsWith('file=')).length,
        name,
      ).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('AC-1 the generated tests fail until the work is done', () => {
  const failsWith = (result: RunResult, text: string): void => {
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain(text);
  };

  it('a generated action fails with its own "not implemented" Problem, yet its safety checks pass', () => {
    const result = workspace.nx('test', 'svc-admin', '--skip-nx-cache', STREAM);

    failsWith(result, 'queues.purge is not implemented yet');
    // The generated spec has tests that hold before any code is written: they pass, which shows the
    // failures above are the missing implementation and not a broken spec.
    expect(result.output).toMatch(/\d+ passed/);
    expect(result.output).toMatch(/\d+ failed/);
  }, 600_000);

  it('the generated HTTP spec fails through the real router too', () => {
    const result = workspace.nx(
      'test',
      'testkit',
      '--skip-nx-cache',
      STREAM,
      '--',
      'src/http/queues-purge',
    );

    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toMatch(/\d+ failed/);
  }, 600_000);

  it('a generated job fails until run() and onDrain() are written', () => {
    const result = workspace.nx('test', 'svc-batch', '--skip-nx-cache', STREAM);

    failsWith(result, 'the job queues.purge-many is not implemented yet');
  }, 600_000);

  it('a generated topic is declared and checked at once (nothing to implement yet)', () => {
    ok(workspace.nx('test', 'svc-tap', '--skip-nx-cache'));
  }, 600_000);
});

describe('AC-2 a generated action implemented per the golden path passes every check', () => {
  const implemented: string[] = [];

  it('writes the golden-path files over the generated ones, and a job beside them', () => {
    for (const name of PAGES) implemented.push(...implement(name));
    write(
      'libs/engine/svc-batch/src/jobs/queues-purge-many.ts',
      `import { defineJob, type JobEvent } from '@app/jobs';
import { z } from 'zod';

export const QueuesPurgeManyInputSchema = z.strictObject({});
export const QueuesPurgeManyCheckpointSchema = z.strictObject({
  done: z.number().int().nonnegative(),
});
export const QueuesPurgeManyOutputSchema = z.strictObject({});
type Output = z.infer<typeof QueuesPurgeManyOutputSchema>;

export const queuesPurgeManyJob = defineJob({
  type: 'queues.purge-many',
  version: 1,
  input: QueuesPurgeManyInputSchema,
  checkpoint: QueuesPurgeManyCheckpointSchema,
  output: QueuesPurgeManyOutputSchema,
  resumable: true,
  async *run(ctx): AsyncGenerator<JobEvent, Output, void> {
    yield { kind: 'progress', done: ctx.checkpoint?.done ?? 0 };
    if (ctx.signal.aborted) return {};
    await ctx.save({ done: 1 });
    yield { kind: 'checkpoint' };
    return {};
  },
  onDrain: () => Promise.resolve(),
});
`,
    );
    expect(implemented).toContain(
      'libs/engine/svc-admin/src/actions/queues-purge.ts',
    );
  });

  it('the API documents are drift until they are regenerated, then they are not', () => {
    const before = workspace.nx(
      'run',
      'contracts:api-docs-check',
      '--skip-nx-cache',
      STREAM,
    );
    expect(before.status, before.output).not.toBe(0);
    expect(before.output).toContain('no longer match the contract registry');

    ok(workspace.nx('run', 'contracts:api-docs', '--skip-nx-cache'));
    const after = workspace.nx(
      'run',
      'contracts:api-docs-check',
      '--skip-nx-cache',
    );
    ok(after);

    const openapi = readFileSync(
      join(workspace.root, 'docs', 'api', 'openapi.v1.json'),
      'utf8',
    );
    expect(openapi).toContain('/connections/{cid}/queues/{qkey}/purge');
    expect(openapi).toContain('explorer.queues.list');
    const asyncapi = readFileSync(
      join(workspace.root, 'docs', 'api', 'asyncapi.v1.json'),
      'utf8',
    );
    expect(asyncapi).toContain('tap.messages');
  }, 600_000);

  it('lint, typecheck and test pass on every project the generators touched', () => {
    ok(
      workspace.nx(
        'run-many',
        '-t',
        'lint',
        'typecheck',
        'test',
        '-p',
        [...PROJECTS, 'testkit'].join(','),
        '--skip-nx-cache',
        '--parallel=2',
      ),
    );
  }, 1_800_000);

  it('Prettier has nothing to change in what was generated and written', () => {
    ok(
      workspace.prettier(
        '--check',
        'libs/engine/svc-catalog',
        'libs/engine/svc-admin',
        'libs/engine/svc-tap',
        'libs/engine/svc-batch',
        'libs/ui',
        'libs/shared/contracts/src/registry',
        'libs/testkit/src/http',
        'tools/arch-tests/src/registered-actions.ts',
      ),
    );
  });
});
