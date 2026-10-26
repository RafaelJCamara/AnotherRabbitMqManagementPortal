// Where a broker login comes from (CON-07, DC-37). A provider hands the TokenManager a credential
// for one connection and protocol; it never keeps one. The credential holds its secret in a
// `SecretValue`, and a provider that cannot give one rejects with an `AppError` whose text is fixed
// and holds no secret, no user name, no command line and no response body (I-10).
import type { CredentialProtocol } from '@app/ports';
import { z } from 'zod';

import { DEFAULT_USERNAME_CLAIMS } from './internal/claims';
import type { SecretValue } from './internal/secret-value';

export type ProviderKind =
  | 'password'
  | 'client-credentials'
  | 'token-command'
  | 'static-token'
  | 'x509-external';

/** Times are epoch milliseconds, as the kernel clock reports them. */
export type IssuedCredential =
  | { kind: 'password'; username: string; password: SecretValue }
  | {
      kind: 'bearer';
      token: SecretValue;
      issuedAt: number;
      expiresAt: number | null;
      username: string | null;
    }
  | { kind: 'external' };

export interface CredentialProvider {
  readonly kind: ProviderKind;
  acquire(
    request: { connectionId: string; protocol: CredentialProtocol },
    signal: AbortSignal,
  ): Promise<IssuedCredential>; // rejects with an AppError (a Problem), never a secret
}

/** Bounds of the token command (OQ-1460): a configured command is code execution, so it is capped. */
export const TOKEN_COMMAND_DEFAULT_TIMEOUT_MS = 10_000;
export const TOKEN_COMMAND_MAX_TIMEOUT_MS = 60_000;
export const TOKEN_COMMAND_DEFAULT_MAX_STDOUT_BYTES = 16_384;
export const TOKEN_COMMAND_MAX_STDOUT_BYTES = 65_536;

const UsernameClaimsSchema = z
  .array(z.string().min(1).max(64))
  .min(1)
  .max(8)
  .default([...DEFAULT_USERNAME_CLAIMS]);

/**
 * An absolute path: POSIX (`/usr/bin/x`), a Windows drive (`C:\x` or `C:/x`) or a UNC share
 * (`\\host\share`). A bare name would be looked up on PATH and a relative one against the working
 * directory, so neither is accepted: the person names the exact program that runs.
 */
const ABSOLUTE_PATH = /^(?:\/(?!\/)|[A-Za-z]:[\\/]|\\\\[^\\])/;

/** No control characters: a NUL or a newline has no place in a file name or an argument. */
const ArgSchema = z.string().max(1024).refine(hasNoControlCharacters);

function hasNoControlCharacters(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/;

/**
 * A token endpoint the engine may call (OQ-1462): `https`, or `http` only for a loopback issuer (the
 * lab). A login in the URL would be a secret in a URL (I-10), and a fragment is never sent.
 */
function isAcceptableEndpoint(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '') {
    return false;
  }
  if (url.protocol === 'https:') return url.hostname !== '';
  return (
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' ||
      url.hostname === '[::1]' ||
      LOOPBACK_V4.test(url.hostname))
  );
}

/**
 * The non-secret settings of a provider, a strict union keyed by `kind`. The secret itself (a
 * password, a token, a client secret) stays in the profile's sealed credential.
 */
export const ProviderConfigSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('password') }),
  z.strictObject({
    kind: z.literal('client-credentials'),
    endpoint: z.string().min(1).max(2048).refine(isAcceptableEndpoint, {
      message: 'The token endpoint must be https, or http on a loopback host.',
    }),
    clientId: z.string().min(1).max(256).refine(hasNoControlCharacters),
    scope: z
      .string()
      .min(1)
      .max(1024)
      .refine(hasNoControlCharacters)
      .optional(),
    audience: z
      .string()
      .min(1)
      .max(512)
      .refine(hasNoControlCharacters)
      .optional(),
    usernameClaims: UsernameClaimsSchema,
  }),
  z.strictObject({
    kind: z.literal('static-token'),
    usernameClaims: UsernameClaimsSchema,
  }),
  z.strictObject({
    kind: z.literal('token-command'),
    file: z
      .string()
      .min(1)
      .max(1024)
      .refine(hasNoControlCharacters)
      .refine((file) => ABSOLUTE_PATH.test(file), {
        message: 'The command must be an absolute path.',
      }),
    args: z.array(ArgSchema).max(32).default([]),
    timeoutMs: z
      .number()
      .int()
      .min(100)
      .max(TOKEN_COMMAND_MAX_TIMEOUT_MS)
      .default(TOKEN_COMMAND_DEFAULT_TIMEOUT_MS),
    maxStdoutBytes: z
      .number()
      .int()
      .min(64)
      .max(TOKEN_COMMAND_MAX_STDOUT_BYTES)
      .default(TOKEN_COMMAND_DEFAULT_MAX_STDOUT_BYTES),
    usernameClaims: UsernameClaimsSchema,
  }),
  z.strictObject({ kind: z.literal('x509-external') }),
]);
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
