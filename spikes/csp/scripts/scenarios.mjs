// The S-04 scenario matrix. `expect(result, signatures)` returns the list of surprises (empty when
// the scenario behaved as the spike found it). Positive scenarios prove the recommended policy;
// negative ones remove exactly one piece to prove that piece is needed.
import {
  BLUEPRINT_CSP,
  RECOMMENDED_CSP,
  TRUSTED_TYPES_ALLOW_LIST,
  modify,
} from './csp-profiles.mjs';

/** Monaco 0.57's own Trusted Types policy names, as created without the environment hook. */
const MONACO_NATIVE_POLICIES = [
  'standaloneColorizer',
  'editorViewLayer',
  'richScreenReaderContent',
  'domLineBreaksComputer',
  'defaultWorkerFactory',
  'diffReview',
  'diffEditorWidget',
  'tokenizeToString',
  'editorGhostText',
  'stickyScrollViewLayer',
];

const failedSteps = (result) =>
  Object.entries(result.spike?.steps ?? {})
    .filter(([, step]) => !step.ok)
    .map(
      ([name, step]) =>
        `step ${name} failed: ${String(step.detail).slice(0, 160)}`,
    );

const noViolations = (signatures) =>
  [...signatures.keys()].map((key) => `unexpected violation: ${key}`);

const expectViolation = (signatures, pattern) =>
  [...signatures.keys()].some((key) => pattern.test(key))
    ? []
    : [`expected a violation matching ${String(pattern)}`];

const expectStepFailure = (result, name) =>
  result.spike?.steps?.[name]?.ok === false
    ? []
    : [`expected step "${name}" to fail`];

const clean = (result, signatures) => [
  ...failedSteps(result),
  ...noViolations(signatures),
];

/** All violations must be of the given kinds (a regex over the signature). */
const onlyViolations = (signatures, allowed) =>
  [...signatures.keys()]
    .filter((key) => !allowed.test(key))
    .map((key) => `unexpected violation: ${key}`);

const withTrustedTypes = (names) =>
  modify(RECOMMENDED_CSP, [['trusted-types', names]]);

export const scenarios = [
  {
    id: 'control-no-csp',
    title:
      'Control: no CSP at all. Proves the harness itself works and the libraries are healthy.',
    csp: undefined,
    expect: clean,
  },
  {
    id: 'blueprint-verbatim',
    title:
      'Blueprint 7.1 policy verbatim, enforced. Everything works except Monaco, whose inline style ' +
      'attributes are blocked (line layout breaks).',
    csp: BLUEPRINT_CSP,
    expect: (result, signatures) => [
      ...expectViolation(signatures, /^enforce style-src-attr/),
      ...expectStepFailure(result, 'monaco'),
      ...onlyViolations(signatures, /^enforce style-src-attr/),
      ...[result.spike?.steps?.grid, result.spike?.steps?.elk]
        .filter((step) => step?.ok !== true)
        .map(() => 'grid and elk should pass under the blueprint policy'),
    ],
  },
  {
    id: 'blueprint-verbatim-report-only',
    title:
      'Blueprint 7.1 policy verbatim as Content-Security-Policy-Report-Only (the fallback).',
    csp: BLUEPRINT_CSP,
    reportOnly: true,
    expect: (result, signatures) => [
      ...failedSteps(result),
      ...expectViolation(signatures, /^report style-src-attr/),
      ...onlyViolations(signatures, /^report style-src-attr/),
    ],
  },
  {
    id: 'recommended',
    title:
      'Recommended policy, enforced, http://127.0.0.1 (local web). Zero violations.',
    csp: RECOMMENDED_CSP,
    expect: clean,
  },
  {
    id: 'recommended-localhost',
    title:
      'Recommended policy, enforced, http://localhost (second local-web origin).',
    csp: RECOMMENDED_CSP,
    host: 'localhost',
    expect: clean,
  },
  {
    id: 'recommended-report-only',
    title: 'Recommended policy as Report-Only: also zero reports.',
    csp: RECOMMENDED_CSP,
    reportOnly: true,
    expect: clean,
  },
  {
    id: 'no-style-attr',
    title:
      'Recommended minus style-src-attr: Monaco breaks (same as the blueprint).',
    csp: modify(RECOMMENDED_CSP, [['style-src-attr', null]]),
    expect: (result, signatures) => [
      ...expectViolation(signatures, /^enforce style-src-attr/),
      ...expectStepFailure(result, 'monaco'),
    ],
  },
  {
    id: 'no-grid-nonce',
    title:
      'Recommended, but AG Grid gets no styleNonce and the global <style> nonce patch is off: the grid loses its stylesheet.',
    csp: RECOMMENDED_CSP,
    path: '/?grid-nonce=0&nonce-patch=0',
    expect: (result, signatures) => [
      ...expectViolation(signatures, /^enforce style-src-elem/),
      ...expectStepFailure(result, 'grid'),
    ],
  },
  {
    id: 'no-monaco-style-nonce',
    title:
      'Recommended, but the global <style> nonce patch is off (AG Grid still has styleNonce): Monaco <style> elements are blocked.',
    csp: RECOMMENDED_CSP,
    path: '/?nonce-patch=0',
    expect: (result, signatures) => [
      ...expectViolation(signatures, /^enforce style-src-elem/),
      ...expectStepFailure(result, 'monaco'),
    ],
  },
  {
    id: 'no-worker-policy',
    title:
      'Recommended, but no Trusted Types policy for worker URLs: new Worker(string) is blocked.',
    csp: RECOMMENDED_CSP,
    path: '/?worker-policy=0',
    expect: (result, signatures) => [
      ...expectViolation(
        signatures,
        /enforce require-trusted-types-for sink Worker constructor/,
      ),
      ...expectStepFailure(result, 'monaco'),
      ...expectStepFailure(result, 'elk'),
    ],
  },
  {
    id: 'no-monaco-policy-name',
    title:
      'Allow-list without app-monaco-html: Monaco cannot create its HTML policy.',
    csp: withTrustedTypes(
      TRUSTED_TYPES_ALLOW_LIST.filter((name) => name !== 'app-monaco-html'),
    ),
    expect: (result, signatures) => [
      ...expectViolation(signatures, /^enforce trusted-types/),
      ...expectStepFailure(result, 'monaco'),
    ],
  },
  {
    id: 'no-dompurify-name',
    title:
      'Allow-list without dompurify: Monaco hover (Markdown sanitiser) loses its policy.',
    csp: withTrustedTypes(
      TRUSTED_TYPES_ALLOW_LIST.filter((name) => name !== 'dompurify'),
    ),
    expect: (result, signatures) => [
      ...expectViolation(
        signatures,
        /^enforce (trusted-types|require-trusted-types-for)/,
      ),
    ],
  },
  {
    id: 'monaco-native-names',
    title:
      'Monaco creating its own ten policies (no environment hook) and the allow-list naming them: ' +
      'defaultWorkerFactory is created twice, so this needs allow-duplicates.',
    csp: withTrustedTypes([
      ...MONACO_NATIVE_POLICIES,
      'app-worker-url',
      'dompurify',
    ]),
    path: '/?monaco-policy-hook=0',
    expect: (result, signatures) => [
      ...expectViolation(signatures, /^enforce trusted-types/),
    ],
  },
  {
    id: 'monaco-native-names-allow-duplicates',
    title:
      "Same, with allow-duplicates: works, but the allow-list is Monaco's internal list.",
    csp: withTrustedTypes([
      ...MONACO_NATIVE_POLICIES,
      'app-worker-url',
      'dompurify',
      "'allow-duplicates'",
    ]),
    path: '/?monaco-policy-hook=0',
    expect: clean,
  },
  {
    id: 'worker-src-blob',
    title:
      'Recommended plus blob: in worker-src (blueprint has it): harmless, but nothing needs it.',
    csp: modify(RECOMMENDED_CSP, [['worker-src', ["'self'", 'blob:']]]),
    expect: clean,
  },
  {
    id: 'img-src-self-data',
    title:
      "Recommended with img-src reduced to 'self' data: (no blob:): still clean. The libraries use " +
      'no blob: images; blob: stays in the policy only for product features (payload previews).',
    csp: modify(RECOMMENDED_CSP, [['img-src', ["'self'", 'data:']]]),
    expect: clean,
  },
  {
    id: 'no-img-data',
    title:
      "Recommended without data: in img-src: Monaco's error squiggle is a data: SVG and is blocked.",
    csp: modify(RECOMMENDED_CSP, [['img-src', ["'self'", 'blob:']]]),
    expect: (_result, signatures) =>
      expectViolation(signatures, /^enforce img-src data/),
  },
  {
    id: 'ag-grid-string-expression',
    title:
      'Recommended, and a column uses a string valueGetter: AG Grid calls new Function, which is a ' +
      'Trusted Types sink (and would also need unsafe-eval). The UI must use function getters only.',
    csp: RECOMMENDED_CSP,
    path: '/?probe=expr',
    expect: (_result, signatures) =>
      expectViolation(
        signatures,
        /^enforce require-trusted-types-for sink Function/,
      ),
  },
  {
    id: 'recommended-frame-ancestors',
    title:
      "Recommended plus frame-ancestors 'none' (header only, for the local web and team server).",
    csp: `${RECOMMENDED_CSP}; frame-ancestors 'none'`,
    expect: clean,
  },
  {
    id: 'angular-shell-recommended',
    title:
      'The existing apps/web Angular build served under the recommended policy with ngCspNonce on the root.',
    csp: RECOMMENDED_CSP,
    angular: true,
    expect: (result, signatures) => [
      ...(result.appRootChildren > 0 ? [] : ['Angular did not render']),
      ...noViolations(signatures),
    ],
  },
  {
    id: 'angular-shell-base-uri-none',
    title:
      "The same Angular build under the blueprint's base-uri 'none': the <base href=\"/\"> Angular " +
      'needs is blocked.',
    csp: modify(RECOMMENDED_CSP, [['base-uri', ["'none'"]]]),
    angular: true,
    expect: (_result, signatures) =>
      expectViolation(signatures, /^enforce base-uri/),
  },
];
