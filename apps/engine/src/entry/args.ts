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
} as const;
type Flag = keyof typeof FLAGS;

export const EngineArgsSchema = z.strictObject({
  mode: EngineModeSchema,
  /** Local mode only; 0 asks the operating system for a free port. */
  port: z.number().int().min(0).max(65_535).optional(),
  dataDir: z.string().min(1).max(4096).optional(),
  kekFile: z.string().min(1).max(4096).optional(),
  uiDir: z.string().min(1).max(4096).optional(),
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
  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.*)$/s.exec(arg);
    const name = match?.[1];
    if (name === undefined || !isFlag(name)) {
      throw new UsageError(
        `Unknown argument. Flags are written --name=value: ${Object.keys(FLAGS)
          .map((flag) => `--${flag}`)
          .join(', ')}.`,
      );
    }
    if (raw.has(FLAGS[name])) {
      throw new UsageError(`--${name} was given twice.`);
    }
    raw.set(FLAGS[name], match?.[2] ?? '');
  }
  const candidate: Record<string, unknown> = Object.fromEntries(raw);
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
