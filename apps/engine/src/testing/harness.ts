// Test support for the composition root: a temporary data directory, a logger that keeps its
// lines, and an in-process engine started through the same `startEngine` the bundle uses.
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CtlFrame } from '@app/contracts';

import { createCtlPort, type CtlPort } from '../entry/ctl.ts';
import { startEngine, type StartedEngine } from '../entry/start.ts';

export interface TempDir {
  readonly dir: string;
  cleanup(): Promise<void>;
}

export async function tempDir(prefix = 'engine-spec-'): Promise<TempDir> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return {
    dir,
    cleanup: () =>
      rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  };
}

/** A control channel whose peer is the test: `send` is what main would post, `posted` is the reply. */
export interface FakeCtl {
  readonly port: CtlPort;
  readonly posted: CtlFrame[];
  send(message: unknown): void;
}

export function createFakeCtl(): FakeCtl {
  let deliver: (message: unknown) => void = () => undefined;
  const posted: CtlFrame[] = [];
  const port = createCtlPort({
    post: (message) => {
      posted.push(message as CtlFrame);
    },
    onMessage: (handler) => {
      deliver = handler;
    },
  });
  return {
    port,
    posted,
    send: (message) => {
      deliver(message);
    },
  };
}

export interface RunningEngine extends StartedEngine {
  /** What the engine wrote to its logger, one JSON line each. */
  readonly lines: string[];
  /** What it wrote to the console (the launch URL). */
  readonly consoleText: string[];
  readonly base: string | undefined;
  readonly token: string | undefined;
}

/** Starts an engine the way the bundle does, with its output kept for the assertions. */
export async function startForTest(
  argv: readonly string[],
  ctl?: CtlPort,
): Promise<RunningEngine> {
  const lines: string[] = [];
  const consoleText: string[] = [];
  const started = await startEngine(argv, {
    console: {
      write: (text: string) => {
        consoleText.push(text);
      },
    },
    ctl,
    bundleDir: join(tmpdir(), 'engine-spec-no-bundle', 'dist'),
    logSink: {
      write: (line: string) => {
        lines.push(line);
      },
    },
  });
  const { address } = started.engine;
  const url = consoleText.join('').trim();
  const token = /#t=([A-Za-z0-9_-]+)$/.exec(url)?.[1];
  return {
    ...started,
    lines,
    consoleText,
    base:
      address === undefined
        ? undefined
        : `http://${address.host}:${String(address.port)}`,
    token,
  };
}

export const localArgs = (
  dir: string,
  extra: readonly string[] = [],
): string[] => ['--mode=local', '--port=0', `--data-dir=${dir}`, ...extra];

export const randomKey = (): Uint8Array => new Uint8Array(randomBytes(32));
