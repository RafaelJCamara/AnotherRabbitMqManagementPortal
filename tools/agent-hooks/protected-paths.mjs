// The protected-path list (M0-07 interface). Agents never edit these; guard-paths.mjs blocks the
// edit and tells the agent to ask a human. The list is data so AGENTS.md, CODEOWNERS and the tests
// can be checked against it.
//
// Sources: docs/plan/execution-plan.md section 2.4 (the first six entries) and the rule that agents
// never disable hooks (section 2.1 item 13), which is why the guard files themselves are listed.

/**
 * A protected path. `match` receives the lower-cased, forward-slash path relative to the repository
 * root. Entries with `content: 'pnpm-workspace'` are checked by content, not by name alone.
 * @typedef {{ id: string, reason: string, match: (rel: string) => boolean, content?: 'pnpm-workspace', localOnly?: boolean }} Protected
 */

/** @type {Protected[]} */
export const PROTECTED_PATHS = [
  {
    id: 'lab-evidence',
    reason:
      'lab evidence is recorded by CI and approved by a human (I-14, amendment A-20); agents never write it',
    match: (rel) =>
      rel === 'testing/lab-evidence' || rel.startsWith('testing/lab-evidence/'),
  },
  {
    id: 'release-workflow',
    reason: 'release workflows are owner-reviewed (signing and publishing)',
    match: (rel) => /^\.github\/workflows\/release[^/]*\.ya?ml$/.test(rel),
  },
  {
    id: 'codeowners',
    reason: 'CODEOWNERS decides who may approve trust-critical changes',
    match: (rel) =>
      rel === 'codeowners' ||
      rel === '.github/codeowners' ||
      rel === 'docs/codeowners',
  },
  {
    id: 'supply-chain-keys',
    reason:
      'the supply-chain keys of pnpm-workspace.yaml (release-age gate, trust policy, build allow-list, overrides) are owner-reviewed (ADR-027)',
    match: (rel) => rel === 'pnpm-workspace.yaml',
    content: 'pnpm-workspace',
  },
  {
    id: 'deps-allowlist',
    reason: 'a new dependency needs an ADR-027 log line and owner approval',
    match: (rel) => rel === 'tools/supply-chain/deps-allowlist.json',
  },
  {
    id: 'adr-027-log',
    reason:
      'the exclusion log records owner-approved release-age and trust exceptions',
    match: (rel) => rel === 'docs/adr/adr-027-log.md',
  },
  {
    id: 'agent-guards',
    localOnly: true, // ~/.claude/settings.json and other checkouts' copies are not ours to police
    reason:
      'agents must not change or disable their own guard-rails (hooks and hook settings)',
    match: (rel) =>
      rel === '.claude/settings.json' ||
      /^tools\/agent-hooks\/(lib|protected-paths|post-edit|on-stop|guard-paths|guard-bash)\.mjs$/.test(
        rel,
      ),
  },
];

/**
 * Top-level keys of pnpm-workspace.yaml that are supply-chain policy (blueprint 14.3). Edits to
 * these are human-only; edits to `catalog` and everything else are not blocked here (the
 * allow-list, pin and licence gates in CI cover dependency additions).
 */
export const SUPPLY_CHAIN_KEYS = [
  'minimumReleaseAge',
  'minimumReleaseAgeStrict',
  'minimumReleaseAgeIgnoreMissingTime',
  'minimumReleaseAgeExclude',
  'minimumReleaseAgeExcludePrune',
  'trustPolicy',
  'trustPolicyExclude',
  'blockExoticSubdeps',
  'strictDepBuilds',
  'allowBuilds',
  'onlyBuiltDependencies',
  'ignoredBuiltDependencies',
  'dangerouslyAllowAllBuilds',
  'overrides',
];

/** Returns the protected entry that matches a repo-relative path, if any. */
export function findProtected(rel) {
  const lower = rel.toLowerCase();
  return PROTECTED_PATHS.find((entry) => entry.match(lower));
}

/**
 * Extracts the text of each top-level key block of a YAML document, ignoring comments and blank
 * lines. This is a line scanner, not a YAML parser: pnpm-workspace.yaml only uses top-level keys
 * with indented mappings and lists, which is all it needs to handle.
 * @returns {Map<string, string>}
 */
export function topLevelBlocks(yamlText) {
  const blocks = new Map();
  let current;
  for (const raw of yamlText.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const key = /^(?:'([^']+)'|"([^"]+)"|([A-Za-z0-9_.@/-]+))\s*:/.exec(line);
    if (key && !/^\s/.test(line)) {
      current = key[1] ?? key[2] ?? key[3];
      blocks.set(current, line);
    } else if (current !== undefined) {
      blocks.set(current, `${blocks.get(current)}\n${line}`);
    }
  }
  return blocks;
}

/** The supply-chain keys whose block differs between two versions of pnpm-workspace.yaml. */
export function changedSupplyChainKeys(before, after) {
  const a = topLevelBlocks(before);
  const b = topLevelBlocks(after);
  return SUPPLY_CHAIN_KEYS.filter((key) => a.get(key) !== b.get(key));
}

/** Supply-chain keys that appear (as a `key:` line start) anywhere in a text fragment. */
export function supplyChainKeysIn(fragment) {
  return SUPPLY_CHAIN_KEYS.filter((key) =>
    new RegExp(`^\\s*['"]?${key}['"]?\\s*:`, 'm').test(fragment),
  );
}
