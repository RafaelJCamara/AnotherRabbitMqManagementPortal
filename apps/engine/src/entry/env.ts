// The environment layer of the engine bundle (blueprint 9, OQ-111): `APP_*` variables read with the
// kernel's `loadConfig`, so an unknown key, a bad value or an unreadable secret file is an error
// that names the variable and never prints a value. `APP` is the placeholder product prefix
// (ADR-029); `<PRODUCT>_RUNTIME=container` is `APP_RUNTIME=container` (ADR-016).
//
//   APP_RUNTIME     container | native      container activates the ADR-016 exception
//   APP_HOST        the address to bind
//   APP_PORT        the port (container default 8765)
//   APP_DATA_DIR    the data directory (container default /data)
//   APP_KEK_PATH    the path of the key-encryption-key file (a path, not the key)
//   APP_UI_DIR      the web build to serve
//   APP_PUBLIC_ORIGIN  loopback-form origins, comma separated (A-12)
//   APP_TOKEN       the launch token; APP_TOKEN_FILE reads it from a file secret instead
//   APP_LOG_LEVEL   trace | debug | info | warn | error | fatal | silent
//
// A command-line flag wins over the variable. Everything is optional: an engine with no `APP_*`
// variable behaves exactly as before.
import { ConfigError, loadConfig } from '@app/kernel';
import { z } from 'zod';

import { UsageError } from './args.ts';

export const EnvConfigSchema = z.strictObject({
  runtime: z.enum(['native', 'container']).optional(),
  host: z.string().min(1).max(255).optional(),
  port: z.number().int().min(0).max(65_535).optional(),
  dataDir: z.string().min(1).max(4096).optional(),
  kekPath: z.string().min(1).max(4096).optional(),
  uiDir: z.string().min(1).max(4096).optional(),
  publicOrigin: z.string().min(1).max(2048).optional(),
  token: z.string().min(1).max(4096).optional(),
  logLevel: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
    .optional(),
});
export type EnvConfig = z.infer<typeof EnvConfigSchema>;

/** Reads the `APP_*` variables. A problem is a usage error (exit 64) whose text is safe to print. */
export function readEnvConfig(
  env: Readonly<Record<string, string | undefined>>,
  readFile?: (path: string) => string,
): EnvConfig {
  try {
    return loadConfig(EnvConfigSchema, {
      env,
      ...(readFile === undefined ? {} : { readFile }),
    });
  } catch (error) {
    if (error instanceof ConfigError) throw new UsageError(error.message);
    throw error;
  }
}
