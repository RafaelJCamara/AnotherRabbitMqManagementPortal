// Starting the engine from a command line: parse the flags, let the mode file build its profile,
// compose, and announce. The one place a mode name is turned into a mode file, by table lookup.
import type { EngineMode } from '@app/contracts';
import { createLogger, type LogSink, type Logger } from '@app/kernel';

import { composeEngine, type Engine } from '../compose-core.ts';
import { createDesktopMode } from '../modes/desktop.ts';
import { createLocalMode } from '../modes/local.ts';
import { createTeamMode } from '../modes/team.ts';
import type { ModeFactory } from '../modes/types.ts';
import { coreModules } from '../modules/index.ts';
import { parseArgs } from './args.ts';
import type { CtlPort } from './ctl.ts';
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
  const logger = createLogger({
    level: args.logLevel ?? 'info',
    bindings: { service: 'engine', mode: args.mode },
    ...(io.logSink === undefined ? {} : { sink: io.logSink }),
  });
  const boot = await MODES[args.mode]({
    args,
    ctl: io.ctl,
    bundleDir: io.bundleDir,
    logger,
  });
  const engine = await composeEngine({
    profile: boot.profile,
    modules: coreModules,
    engineVersion: ENGINE_VERSION,
    logger,
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
  if (boot.launchUrl !== undefined && engine.address !== undefined) {
    io.console.write(`${boot.launchUrl(engine.address)}\n`);
  }
  io.ctl?.post({ t: 'ready', ...engine.ready });
  return { engine, logger };
}
