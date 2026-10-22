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

/** The engine's API lives below this path; credentials go to nothing outside it. */
const ENGINE_PATH_PREFIX = '/api/';

// Backslash, C0 controls and DEL: the URL parser treats `\` as `/` in a special scheme and drops
// tabs and newlines, so `/\evil.example` and `/<TAB>/evil.example` both become `//evil.example`.
const FORBIDDEN_URL_CHARACTERS = /[\\\u0000-\u001f\u007f]/;

/** The page's own origin; a fixed stand-in where there is no page (a node-side spec of a caller). */
const pageOrigin = (): string =>
  typeof location === 'undefined' ? 'http://engine.invalid' : location.origin;

/**
 * Engine URLs are same-origin paths below `/api/`. Credentials are never attached to anything else.
 * The URL is parsed the way the browser will resolve it, and the parsed origin and path are what
 * is checked, so a prefix test on the raw text cannot be fooled by `/\host`, an encoded dot
 * segment (`/api/%2e%2e/x`) or a protocol-relative form.
 */
export const isEngineUrl = (url: string): boolean => {
  if (!url.startsWith('/') || url.startsWith('//')) return false;
  if (FORBIDDEN_URL_CHARACTERS.test(url)) return false;
  const origin = pageOrigin();
  let parsed: URL;
  try {
    parsed = new URL(url, origin);
  } catch {
    return false;
  }
  return (
    parsed.origin === new URL(origin).origin &&
    parsed.pathname.startsWith(ENGINE_PATH_PREFIX)
  );
};
