/* global window, document, trustedTypes */
// Classic script, loaded first. Records everything the CSP and Trusted Types machinery does so
// the driver (scripts/run.mjs) can read it back from `window.__spike`.
(() => {
  const spike = {
    done: false,
    steps: {},
    violations: [],
    policies: [],
    errors: [],
  };
  window.__spike = spike;

  document.addEventListener('securitypolicyviolation', (event) => {
    spike.violations.push({
      disposition: event.disposition,
      effectiveDirective: event.effectiveDirective,
      blockedURI: event.blockedURI,
      sample: event.sample.slice(0, 80),
      source: `${event.sourceFile}:${String(event.lineNumber)}`,
    });
  });
  window.addEventListener('error', (event) => {
    spike.errors.push(String(event.message));
  });
  window.addEventListener('unhandledrejection', (event) => {
    spike.errors.push(`unhandledrejection: ${String(event.reason)}`);
  });

  // Record each Trusted Types policy name a library asks for, whether or not it is allowed.
  if (typeof trustedTypes !== 'undefined') {
    const createPolicy = trustedTypes.createPolicy.bind(trustedTypes);
    trustedTypes.createPolicy = (name, rules) => {
      const entry = { name, created: false };
      spike.policies.push(entry);
      const policy = createPolicy(name, rules);
      entry.created = true;
      return policy;
    };
  }
})();
