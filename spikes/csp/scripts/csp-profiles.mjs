// The Content-Security-Policy strings under test. `{N}` stands for the per-response nonce.

/** Blueprint 7.1 verbatim (desktop `app://`); the local web build serves the same policy. */
export const BLUEPRINT_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'nonce-{N}'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "require-trusted-types-for 'script'",
].join('; ');

/** Policy names the UI owns or allows (Trusted Types `trusted-types` directive). */
export const TRUSTED_TYPES_ALLOW_LIST = [
  'app-worker-url',
  'app-monaco-html',
  'dompurify',
];

/**
 * The recommended policy: the blueprint policy plus the two additions the spike proves are
 * needed (`style-src-attr 'unsafe-inline'` for Monaco's inline style attributes and the
 * `trusted-types` allow-list), without `blob:` for workers.
 */
export const RECOMMENDED_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'nonce-{N}'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "worker-src 'self'",
  "connect-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "require-trusted-types-for 'script'",
  `trusted-types ${TRUSTED_TYPES_ALLOW_LIST.join(' ')}`,
].join('; ');

/**
 * Returns a copy of `policy` with changes applied. A change is `[directive, values]` (replace or
 * add; `null` removes the directive) or `[directive, { add: [...], remove: [...] }]`.
 */
export function modify(policy, changes) {
  const directives = new Map();
  for (const part of policy.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name !== undefined && name !== '') directives.set(name, values);
  }
  for (const [name, change] of changes) {
    if (change === null) {
      directives.delete(name);
    } else if (Array.isArray(change)) {
      directives.set(name, change);
    } else {
      const removed = new Set(change.remove ?? []);
      directives.set(name, [
        ...(directives.get(name) ?? []).filter((value) => !removed.has(value)),
        ...(change.add ?? []),
      ]);
    }
  }
  return [...directives]
    .map(([name, values]) => [name, ...values].join(' '))
    .join('; ');
}
