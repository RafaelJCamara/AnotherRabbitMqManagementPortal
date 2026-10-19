// Lets Node run the TypeScript sources of this project and of the registry directly (type
// stripping, no bundler):
//   node --import ./tools/semantics-evidence/register.mjs tools/semantics-evidence/src/cli.ts
//
// 1. It resolves the `@app/*` path aliases of tsconfig.base.json, as tools/semantics-audit does.
// 2. With SEMANTICS_EVIDENCE_REV set (to a commit id the CLI resolved itself) it serves every source
//    file of the repository from that commit instead of from the disk, so the registry of the base
//    revision can be read without checking it out. Files of this project and everything under
//    node_modules still come from the disk; a file the commit does not have is an error.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Node loads modules by their real path (a temporary folder on macOS is behind a link), so the
// folders are compared by real path too.
const folder = (path) => pathToFileURL(`${realpathSync(path)}/`);
const toolRoot = folder(fileURLToPath(new URL('./', import.meta.url)));
const repoRoot = folder(fileURLToPath(new URL('../../', import.meta.url)));
const root = process.env.SEMANTICS_EVIDENCE_ROOT
  ? folder(process.env.SEMANTICS_EVIDENCE_ROOT)
  : repoRoot;
const rev = process.env.SEMANTICS_EVIDENCE_REV;
if (rev !== undefined && !/^[0-9a-f]{40}$/.test(rev)) {
  throw new Error('SEMANTICS_EVIDENCE_REV must be a full commit id');
}

const base = JSON.parse(
  readFileSync(new URL('tsconfig.base.json', repoRoot), 'utf8'),
);
const aliases = new Map(
  Object.entries(base.compilerOptions.paths)
    .filter(([alias]) => alias.startsWith('@app/'))
    .map(([alias, [target]]) => [alias, new URL(target, repoRoot).href]),
);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = aliases.get(specifier);
    return url === undefined
      ? nextResolve(specifier, context)
      : { url, shortCircuit: true };
  },
  load(url, context, nextLoad) {
    if (
      rev === undefined ||
      !url.startsWith(root.href) ||
      url.startsWith(toolRoot.href) ||
      url.includes('/node_modules/')
    ) {
      return nextLoad(url, context);
    }
    const path = decodeURIComponent(url.slice(root.href.length)).split('?')[0];
    const source = execFileSync('git', ['show', `${rev}:${path}`], {
      cwd: fileURLToPath(root),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      format: path.endsWith('.ts') ? 'module-typescript' : 'module',
      source,
      shortCircuit: true,
    };
  },
});
