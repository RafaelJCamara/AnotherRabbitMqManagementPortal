// Starting the engine from a command line: parse the flags, let the mode file build its profile,
// compose, and announce. The one place a mode name is turned into a mode file, by table lookup.
import type { EngineMode } from '@app/contracts';
import { createLogger, type LogSink, type Logger } from '@app/kernel';

import { composeEngine, type Engine } from '../compose-core.ts';
import { createDesktopMode } from '../modes/desktop.ts';
import { createLocalMode } from '../modes/local.ts';
import { createTeamMode } from '../modes/team.ts';
import type { ModeFactory } from '../modes/types.ts';
import { createLogTail } from '../log-tail.ts';
import { coreModules } from '../modules/index.ts';
import { parseArgs } from './args.ts';
import type { CtlPort } from './ctl.ts';
import { readEnvConfig } from './env.ts';
import { ENGINE_VERSION } from './version.ts';

const MODES: Readonly<Record<EngineMode, ModeFactory>> = {
  desktop: createDesktopMode,
  local: createLocalMode,
  team: createTeamMode,
};

export interface EntryIo {
  /** Where the launch URL goes (never the logger). */
  readonly console: { write(text: string): unknown };
  readonly ctl: CtlPort | undefined;
  readonly bundleDir: string;
  /** Default: the kernel logger's own (standard output). */
  readonly logSink?: LogSink;
  /** Milliseconds since the process started, for the ready line. */
  readonly sinceStart?: () => number;
  /** The process environment (`APP_*`, read by `readEnvConfig`). Default: none. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Opens the default browser at a URL (`--open`). Called once, after the listener is up. The URL
   * holds the launch token, so an implementation must not put it on a command line (I-10).
   */
  readonly openBrowser?: (url: string) => Promise<void>;
}

export interface StartedEngine {
  readonly engine: Engine;
  readonly logger: Logger;
}

export async function startEngine(
  argv: readonly string[],
  io: EntryIo,
): Promise<StartedEngine> {
  const args = parseArgs(argv);
  const env = readEnvConfig(io.env ?? {});
  // The newest lines are also held for the diagnostics bundle (the kernel hands each redacted line
  // to `onLine`); the sink is the kernel's own (standard output) unless a test gave one.
  const logs = createLogTail();
  const logger = createLogger({
    level: args.logLevel ?? env.logLevel ?? 'info',
    bindings: { service: 'engine', mode: args.mode },
    ...(io.logSink === undefined ? {} : { sink: io.logSink }),
    onLine: (line) => {
      logs.add(line);
    },
  });
  const boot = await MODES[args.mode]({
    args,
    ctl: io.ctl,
    bundleDir: io.bundleDir,
    logger,
    env,
  });
  const engine = await composeEngine({
    profile: boot.profile,
    modules: coreModules,
    engineVersion: ENGINE_VERSION,
    logger,
    logs,
  });
  const pending = engine.reconciliation
    .filter((report) => report.outcome.status === 'pending')
    .map((report) => report.name);
  logger.info(
    {
      event: 'engine.ready',
      contract: engine.ready.contract,
      schemaHash: engine.ready.schemaHash,
      vault: engine.vault().state,
      reconciliationPending: pending,
      ...(engine.address === undefined ? {} : { port: engine.address.port }),
      ...(io.sinceStart === undefined
        ? {}
        : { startupMs: Math.round(io.sinceStart()) }),
    },
    'engine ready',
  );
  if (engine.address !== undefined) {
    // Console only: the notice and the URL are for the person at the terminal, and the URL holds
    // the token. The mode decides what they say; the logger sees none of it.
    const lines = boot.notice?.(engine.address) ?? [];
    if (lines.length > 0) io.console.write(`${lines.join('\n')}\n`);
    if (boot.launchUrl !== undefined) {
      const url = boot.launchUrl(engine.address);
      io.console.write(`${url}\n`);
      if (boot.openOnReady === true && io.openBrowser !== undefined) {
        // A browser that will not open is no reason to stop: the URL above is still usable.
        io.openBrowser(url).catch(() => {
          logger.warn(
            { event: 'engine.open.failed' },
            'the browser could not be opened; use the URL printed above',
          );
        });
      }
    }
  }
  io.ctl?.post({ t: 'ready', ...engine.ready });
  return { engine, logger };
}
