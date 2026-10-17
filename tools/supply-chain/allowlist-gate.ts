// Agent dependency allow-list gate (ADR-027). Every direct dependency must have an entry in
// tools/supply-chain/deps-allowlist.json that says why it exists and which decision approved it.
// This stops coding agents from adding hallucinated or placeholder packages unreviewed.
import {
  asRecord,
  catalogEntries,
  DEPENDENCY_SECTIONS,
  dedupe,
  violation,
} from './shared.ts';
import type { Violation, Workspace } from './shared.ts';

export const ALLOWLIST_RULES = [
  'allowlist.missing-entry',
  'allowlist.entry-incomplete',
] as const;

/** Every direct dependency name: catalog entries plus every package.json dependency section. */
export function directDependencies(ws: Workspace): Map<string, string> {
  const found = new Map<string, string>();
  for (const e of catalogEntries(ws.settings))
    found.set(e.name, `pnpm-workspace.yaml catalog ${e.catalog}`);
  for (const manifest of ws.manifests) {
    for (const section of DEPENDENCY_SECTIONS) {
      for (const [name, spec] of Object.entries(
        asRecord(manifest.json[section]),
      )) {
        if (String(spec).startsWith('workspace:')) continue;
        if (!found.has(name)) found.set(name, `${manifest.path} ${section}`);
      }
    }
  }
  return found;
}

export function checkAllowlist(ws: Workspace): Violation[] {
  const entries = asRecord(ws.allowlist['packages']);
  const out: Violation[] = [];

  for (const [name, where] of directDependencies(ws)) {
    if (!(name in entries)) {
      out.push(
        violation(
          'allowlist',
          'allowlist.missing-entry',
          name,
          `${name} (${where}) is not in tools/supply-chain/deps-allowlist.json. Add it with a reason and the ADR or work item that approved it.`,
        ),
      );
    }
  }

  for (const [name, value] of Object.entries(entries)) {
    const entry = asRecord(value);
    const reason = entry['reason'];
    const ref = entry['ref'];
    if (
      typeof reason !== 'string' ||
      reason.trim() === '' ||
      typeof ref !== 'string' ||
      ref.trim() === ''
    ) {
      out.push(
        violation(
          'allowlist',
          'allowlist.entry-incomplete',
          name,
          `deps-allowlist.json entry "${name}" needs a non-empty "reason" and "ref".`,
        ),
      );
    }
  }
  return dedupe(out);
}
