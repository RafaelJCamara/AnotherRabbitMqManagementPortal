// What the UI sends to prove who it is to the engine. These are engine credentials (the local launch
// token, the team CSRF token), never broker credentials. On the desktop the MessagePort tunnel
// strips and replaces them (blueprint 3.3), so the source stays empty there.
import { InjectionToken } from '@angular/core';

export interface EngineCredentials {
  /** The local launch token, sent as `Authorization: Bearer`. */
  readonly bearer?: string;
  /** The team CSRF token, sent as `X-CSRF-Token` on unsafe methods. */
  readonly csrf?: string;
}

/** A function, so a token that is renewed or cleared is read fresh on every request. */
export type EngineCredentialsSource = () => EngineCredentials;

export const ENGINE_CREDENTIALS = new InjectionToken<EngineCredentialsSource>(
  'ENGINE_CREDENTIALS',
  { providedIn: 'root', factory: () => () => ({}) },
);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function credentialHeaders(
  credentials: EngineCredentials,
  method: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (credentials.bearer !== undefined && credentials.bearer !== '') {
    headers.authorization = `Bearer ${credentials.bearer}`;
  }
  if (
    credentials.csrf !== undefined &&
    credentials.csrf !== '' &&
    !SAFE_METHODS.has(method.toUpperCase())
  ) {
    headers['x-csrf-token'] = credentials.csrf;
  }
  return headers;
}

/** Engine URLs are same-origin paths. Credentials are never attached to anything else. */
export const isEngineUrl = (url: string): boolean =>
  url.startsWith('/') && !url.startsWith('//');
