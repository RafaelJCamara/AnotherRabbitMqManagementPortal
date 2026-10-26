// The token-command provider: a command the person configured prints a token (a bare JWT, or JSON
// with `access_token` and optionally `expires_in`). A configured command is code execution, so it
// runs through `CommandRunnerPort` with an argument array and no shell, a timeout and an output cap
// (OQ-1460). Neither its output nor its command line reaches an error: a failure gives a fixed text.
import { AppError, type Clock } from '@app/kernel';
import type { CommandRunnerPort } from '@app/ports';

import { bearerCredential } from '../internal/bearer';
import type { CredentialProvider, ProviderConfig } from '../provider';

type TokenCommandConfig = Extract<ProviderConfig, { kind: 'token-command' }>;

const FAILURE_TEXT = {
  'spawn-failed': 'The token command could not be started.',
  'exit-nonzero': 'The token command failed.',
  timeout: 'The token command did not finish in time.',
  'too-large': 'The token command printed more than the allowed output.',
} as const;

/** The token and the lifetime from what the command printed, or undefined when it is neither form. */
function parseOutput(
  stdout: string,
): { token: string; expiresInSeconds: number | null } | undefined {
  const text = stdout.trim();
  if (text === '') return undefined;
  if (text.startsWith('{')) {
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value !== 'object' || value === null) return undefined;
      const { access_token: token, expires_in: lifetime } = value as {
        access_token?: unknown;
        expires_in?: unknown;
      };
      if (typeof token !== 'string' || token === '') return undefined;
      return {
        token,
        expiresInSeconds: typeof lifetime === 'number' ? lifetime : null,
      };
    } catch {
      return undefined;
    }
  }
  return /\s/.test(text) ? undefined : { token: text, expiresInSeconds: null };
}

export function createTokenCommandProvider(deps: {
  readonly config: TokenCommandConfig;
  /** Absent where the delivery mode does not allow commands: the provider then fails closed. */
  readonly runner: CommandRunnerPort | undefined;
  readonly clock: Clock;
}): CredentialProvider {
  const { config } = deps;
  return {
    kind: 'token-command',
    async acquire(_request, signal) {
      if (deps.runner === undefined) {
        throw new AppError('GATE_BLOCKED', {
          detail: 'Token commands are not available in this delivery mode.',
        });
      }
      const result = await deps.runner.run(
        { file: config.file, args: config.args },
        { timeoutMs: config.timeoutMs, maxStdoutBytes: config.maxStdoutBytes },
        signal,
      );
      if (!result.ok) {
        throw new AppError('UNAUTHENTICATED', {
          detail: FAILURE_TEXT[result.reason],
        });
      }
      // The runner enforces the cap; a runner that does not is not trusted to.
      if (Buffer.byteLength(result.stdout, 'utf8') > config.maxStdoutBytes) {
        throw new AppError('UNAUTHENTICATED', {
          detail: FAILURE_TEXT['too-large'],
        });
      }
      const output = parseOutput(result.stdout);
      if (output === undefined) {
        throw new AppError('VALIDATION_FAILED', {
          detail:
            'The token command printed neither a token nor JSON with access_token.',
        });
      }
      return bearerCredential({
        token: output.token,
        usernameClaims: config.usernameClaims,
        clock: deps.clock,
        expiresInSeconds: output.expiresInSeconds,
        requireExpiry: false,
      });
    },
  };
}
