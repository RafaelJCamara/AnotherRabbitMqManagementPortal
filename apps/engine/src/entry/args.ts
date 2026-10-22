// The command line of the engine bundle: `node main.mjs --mode=desktop|local|team [flags]`.
// Strict on purpose: a flag that is not listed, one given twice, or a value of the wrong shape
// stops the start with a usage error that names the flag and never prints a value (a value may be
// the path of a secret).
import { EngineModeSchema } from '@app/contracts';
import { z } from 'zod';

/** Flag name to the key it sets. */
const FLAGS = {
  mode: 'mode',
  port: 'port',
  'data-dir': 'dataDir',
  'kek-file': 'kekFile',
  'ui-dir': 'uiDir',
  'log-level': 'logLevel',
  host: 'host',
  'public-origin': 'publicOrigin',
  'token-file': 'tokenFile',
} as const;
type Flag = keyof typeof FLAGS;

/** Flags with no value: `--open` asks for a browser, `--no-open` says explicitly that none is wanted. */
const SWITCHES = { '--open': true, '--no-open': false } as const;

export const EngineArgsSchema = z.strictObject({
  mode: EngineModeSchema,
  /** Local mode only; 0 asks the operating system for a free port. */
  port: z.number().int().min(0).max(65_535).optional(),
  dataDir: z.string().min(1).max(4096).optional(),
  kekFile: z.string().min(1).max(4096).optional(),
  uiDir: z.string().min(1).max(4096).optional(),
  /** Local mode: the address to bind (loopback unless the container exception applies, ADR-016). */
  host: z.string().min(1).max(255).optional(),
  /** Local mode: loopback-form origins this engine is reached at, comma separated (A-12). */
  publicOrigin: z.string().min(1).max(2048).optional(),
  /** Local mode: a file holding the launch token. The path is never printed. */
  tokenFile: z.string().min(1).max(4096).optional(),
  /** Local mode: open the default browser at the launch URL (default: no). */
  open: z.boolean().optional(),
  logLevel: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
    .optional(),
});
export type EngineArgs = z.infer<typeof EngineArgsSchema>;

/** Raised for anything wrong with how the engine was started. The message is safe to print. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

const isFlag = (name: string): name is Flag => Object.hasOwn(FLAGS, name);

export function parseArgs(argv: readonly string[]): EngineArgs {
  const raw = new Map<string, string>();
  let open: boolean | undefined;
  for (const arg of argv) {
    if (Object.hasOwn(SWITCHES, arg)) {
      if (open !== undefined) {
        throw new UsageError('--open and --no-open were given more than once.');
      }
      open = SWITCHES[arg as keyof typeof SWITCHES];
      continue;
    }
    const match = /^--([a-z-]+)=(.*)$/s.exec(arg);
    const name = match?.[1];
    if (name === undefined || !isFlag(name)) {
      throw new UsageError(
        `Unknown argument. Flags are written --name=value: ${Object.keys(FLAGS)
          .map((flag) => `--${flag}`)
          .join(', ')}, --open, --no-open.`,
      );
    }
    if (raw.has(FLAGS[name])) {
      throw new UsageError(`--${name} was given twice.`);
    }
    raw.set(FLAGS[name], match?.[2] ?? '');
  }
  const candidate: Record<string, unknown> = Object.fromEntries(raw);
  if (open !== undefined) candidate.open = open;
  const port = raw.get('port');
  // `Number('')` is 0 and `Number('1e3')` is 1000: only plain digits are a port.
  if (port !== undefined) {
    candidate.port = /^\d+$/.test(port) ? Number(port) : Number.NaN;
  }
  const parsed = EngineArgsSchema.safeParse(candidate);
  if (!parsed.success) {
    const flags = new Set(
      parsed.error.issues.map((issue) => {
        const key = String(issue.path[0]);
        if (key === 'open') return '--open';
        const flag = Object.entries(FLAGS).find(([, value]) => value === key);
        return `--${flag?.[0] ?? key}`;
      }),
    );
    throw new UsageError(
      `Missing or invalid value for ${[...flags].join(', ')}.`,
    );
  }
  return parsed.data;
}
