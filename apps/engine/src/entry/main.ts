// The process entry: start the engine, stop it on SIGINT, SIGTERM or `ctl:shutdown` with the
// budgeted drain, and turn a failed start into one JSON line on stderr and an exit code.
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { toProblem, type DrainReason } from '@app/kernel';
import { SchemaTooNewError } from '@app/persistence';
import { SecretsError } from '@app/secrets';

import { DataDirLockedError } from '../data-dir-lock.ts';
import { ModeRefusedError } from '../modes/types.ts';
import { UsageError } from './args.ts';
import { createCtlPort, detectCtlTransport, type CtlPort } from './ctl.ts';
import { startEngine } from './start.ts';

/** Exit codes follow sysexits.h where one fits. */
export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 64,
  locked: 75,
  refused: 78,
} as const;

export interface StartFailure {
  readonly exitCode: number;
  /** The one line written to stderr. It names a reason and a safe detail, never a secret (I-10). */
  readonly line: Readonly<Record<string, unknown>>;
}

export function describeFailure(error: unknown): StartFailure {
  const base = { event: 'engine.start.failed' } as const;
  if (error instanceof UsageError) {
    return {
      exitCode: EXIT.usage,
      line: { ...base, reason: 'usage', detail: error.message },
    };
  }
  if (error instanceof DataDirLockedError) {
    return {
      exitCode: EXIT.locked,
      line: {
        ...base,
        reason: 'data-dir-locked',
        detail: error.message,
        ...(error.holderPid === undefined
          ? {}
          : { holderPid: error.holderPid }),
      },
    };
  }
  if (error instanceof ModeRefusedError) {
    return {
      exitCode: EXIT.refused,
      line: { ...base, reason: 'mode-unavailable', detail: error.message },
    };
  }
  if (error instanceof SecretsError) {
    // The vault's errors are written to say little: a code, never a key, a passphrase or a path.
    return {
      exitCode: EXIT.refused,
      line: {
        ...base,
        reason: 'vault',
        code: error.code,
        detail: error.message,
      },
    };
  }
  if (error instanceof SchemaTooNewError) {
    return {
      exitCode: EXIT.refused,
      line: { ...base, reason: 'schema-too-new', problem: error.problem },
    };
  }
  // Anything else: the Problem mapping keeps the code and drops the message of an unknown error.
  const problem = toProblem(error, { correlationId: 'engine-start' });
  return {
    exitCode: EXIT.failure,
    line: { ...base, reason: 'failed', problem },
  };
}

const DRAIN_MS = 2000;
/** The longest drain a supervisor may ask for; a larger number would overflow the timers below. */
const MAX_DRAIN_MS = 30_000;
/** Past the drain and this, the process is stuck and exits with a failure. */
const BACKSTOP_SLACK_MS = 3000;

/** The drain budget of a ctl:shutdown: what main asked for, within what a timer can hold. */
export function drainBudgetMs(requestedMs: number): number {
  return Math.min(Math.max(requestedMs, 1), MAX_DRAIN_MS);
}

/** Exits once what was written to the console has been handed to the operating system. */
function exitAfterFlush(code: number): void {
  process.stdout.write('', () => {
    process.stderr.write('', () => {
      process.exit(code);
    });
  });
}

export async function main(argv: readonly string[]): Promise<void> {
  const transport = detectCtlTransport(process);
  const ctl: CtlPort | undefined =
    transport === undefined ? undefined : createCtlPort(transport);
  // A shutdown that arrives while the engine is still starting is honoured as soon as it is up.
  let stopNow: ((reason: DrainReason, totalMs: number) => void) | undefined;
  let requestedEarly: number | undefined;
  ctl?.onFrame((frame) => {
    if (frame.t !== 'shutdown') return;
    if (stopNow === undefined) requestedEarly = frame.deadlineMs;
    else stopNow('quit', drainBudgetMs(frame.deadlineMs));
  });
  try {
    const { engine, logger } = await startEngine(argv, {
      console: process.stdout,
      ctl,
      bundleDir: dirname(fileURLToPath(import.meta.url)),
      sinceStart: () => performance.now(),
    });
    let stopping = false;
    const stop = (reason: DrainReason, totalMs: number): void => {
      if (stopping) return;
      stopping = true;
      setTimeout(() => {
        exitAfterFlush(EXIT.failure);
      }, totalMs + BACKSTOP_SLACK_MS).unref();
      engine
        .drain(reason, totalMs)
        .then(() => engine.close())
        .then(
          () => {
            logger.info({ event: 'engine.stopped', reason }, 'engine stopped');
            exitAfterFlush(EXIT.ok);
          },
          (error: unknown) => {
            logger.error({ event: 'engine.stop.failed', err: error }, 'stop');
            exitAfterFlush(EXIT.failure);
          },
        );
    };
    process.once('SIGINT', () => {
      stop('sigterm', DRAIN_MS);
    });
    process.once('SIGTERM', () => {
      stop('sigterm', DRAIN_MS);
    });
    stopNow = stop;
    if (requestedEarly !== undefined)
      stop('quit', drainBudgetMs(requestedEarly));
    ctl?.onInvalid((fields) => {
      logger.warn(
        { event: 'engine.ctl.invalid', fields },
        'a control frame was refused',
      );
    });
  } catch (error) {
    const failure = describeFailure(error);
    process.stderr.write(`${JSON.stringify(failure.line)}\n`);
    exitAfterFlush(failure.exitCode);
  }
}
