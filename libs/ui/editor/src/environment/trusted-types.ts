import type {
  EditorRealm,
  MonacoPolicyRequest,
  MonacoPolicyResult,
  TrustedPolicyLike,
  TrustedTypesFactoryLike,
} from './realm';

/** The two policy names the engine's `trusted-types` directive lists for the editor (S-04). */
export const WORKER_POLICY_NAME = 'app-worker-url';
export const HTML_POLICY_NAME = 'app-monaco-html';

/**
 * The only script URLs the worker policy mints: same-origin paths of the two Monaco workers. A2
 * replaces the fixed names by content-hashed ones generated at build time (OQ-1512); the rule that
 * the list is a fixed set per build does not change.
 */
export const EDITOR_WORKER_PATHS: readonly string[] = [
  '/workers/editor.worker.js',
  '/workers/json.worker.js',
];

/** The worker script Monaco needs for a language label (`json` has its own, the rest share one). */
export function workerPathFor(label: string): string {
  return label === 'json'
    ? '/workers/json.worker.js'
    : '/workers/editor.worker.js';
}

export class WorkerUrlError extends TypeError {
  constructor(readonly rejected: string) {
    super(`worker script not allowed: ${rejected}`);
    this.name = 'WorkerUrlError';
  }
}

/**
 * Returns the absolute URL of a listed worker script, or throws. It accepts the path (`/workers/x.js`)
 * or that path on the page's own origin and nothing else: no other origin, no query, no fragment, no
 * credentials, no `..`, no encoded or backslash variant (the input must equal what the URL parser
 * made of it).
 */
export function checkWorkerUrl(
  value: string,
  location: EditorRealm['location'],
): string {
  let url: URL;
  try {
    url = new URL(value, location.href);
  } catch {
    throw new WorkerUrlError(value);
  }
  // The page origin plus the path is the whole URL: this is also what rejects another origin, a
  // query, a fragment, credentials and an opaque origin ('null', 'file:'), which never equals it.
  if (
    url.href !== `${location.origin}${url.pathname}` ||
    (value !== url.pathname && value !== url.href) ||
    !EDITOR_WORKER_PATHS.includes(url.pathname)
  ) {
    throw new WorkerUrlError(value);
  }
  return url.href;
}

/** The policies created so far in one realm, so that a retry never creates a name twice. */
export interface PolicyCache {
  worker?: TrustedPolicyLike;
  html?: TrustedPolicyLike;
}

export function ensureWorkerPolicy(
  factory: TrustedTypesFactoryLike,
  location: EditorRealm['location'],
  cache: PolicyCache,
): TrustedPolicyLike {
  cache.worker ??= factory.createPolicy(WORKER_POLICY_NAME, {
    createScriptURL: (value) => checkWorkerUrl(value, location),
  });
  return cache.worker;
}

export function ensureHtmlPolicy(
  factory: TrustedTypesFactoryLike,
  cache: PolicyCache,
): TrustedPolicyLike {
  cache.html ??= factory.createPolicy(HTML_POLICY_NAME, {
    createHTML: (value) => value,
  });
  return cache.html;
}

/**
 * The value of `MonacoEnvironment.createTrustedTypesPolicy`. Monaco asks for about ten policies
 * under names of its own (one twice) and they change between releases; every one is answered from
 * the two allowed policies instead, so the CSP list stays at stable names. Monaco's own policies are
 * identity functions, so no sanitising is lost; script URLs still go through the worker list.
 */
export function monacoPolicyHook(
  worker: TrustedPolicyLike,
  html: TrustedPolicyLike,
): (name: string, options?: MonacoPolicyRequest) => MonacoPolicyResult {
  return (_name, options) => {
    const { createHTML, createScriptURL } = options ?? {};
    return {
      ...(createHTML === undefined
        ? {}
        : {
            createHTML: (input: string, ...rest: unknown[]) =>
              html.createHTML(createHTML(input, ...rest)),
          }),
      ...(createScriptURL === undefined
        ? {}
        : {
            createScriptURL: (input: string, ...rest: unknown[]) =>
              worker.createScriptURL(createScriptURL(input, ...rest)),
          }),
    };
  };
}
