/* global window, document, location, Worker */
// The Trusted Types policies this UI would own (recommended allow-list: `app-worker-url`,
// `app-monaco-html`, plus `dompurify` which Monaco's bundled sanitizer creates by itself).
//
//  * `app-worker-url`: `new Worker(string)` is a sink under `require-trusted-types-for 'script'`.
//    This policy only mints same-origin URLs on an explicit path list, so it cannot start an
//    arbitrary script.
//  * `app-monaco-html`: Monaco 0.57 asks for ten identity `createHTML` policies under ten names
//    (and one of them twice). Routing them through MonacoEnvironment.createTrustedTypesPolicy
//    keeps the allow-list to one stable name instead of Monaco's internal list.
//
// Switches for the driver: `?worker-policy=0` creates no worker policy (workers must then fail),
// `?monaco-policy-hook=0` lets Monaco create its own ten policies directly.
const params = new URLSearchParams(document.location.search);
const factory = window.trustedTypes;

const ALLOWED_WORKER_PATHS = new Set([
  '/workers/editor.worker.js',
  '/workers/json.worker.js',
  '/assets/elk-worker.min.js',
]);

function checkWorkerUrl(value) {
  const url = new URL(value, location.href);
  if (
    url.origin !== location.origin ||
    !ALLOWED_WORKER_PATHS.has(url.pathname)
  ) {
    throw new TypeError(`worker script not allowed: ${value}`);
  }
  return url.href;
}

const workerPolicy =
  factory !== undefined && params.get('worker-policy') !== '0'
    ? factory.createPolicy('app-worker-url', {
        createScriptURL: checkWorkerUrl,
      })
    : undefined;

export function createWorker(url, options) {
  return new Worker(
    workerPolicy === undefined ? url : workerPolicy.createScriptURL(url),
    options,
  );
}

/** Value for `MonacoEnvironment.createTrustedTypesPolicy`, or undefined to use Monaco's default. */
export function monacoPolicyHook() {
  if (factory === undefined || params.get('monaco-policy-hook') === '0')
    return undefined;
  const monacoHtml = factory.createPolicy('app-monaco-html', {
    createHTML: (value) => value,
  });
  return (_name, options) => ({
    createHTML: options.createHTML
      ? (input, ...rest) =>
          monacoHtml.createHTML(options.createHTML(input, ...rest))
      : undefined,
    createScriptURL: options.createScriptURL
      ? (input) => workerPolicy?.createScriptURL(options.createScriptURL(input))
      : undefined,
  });
}
