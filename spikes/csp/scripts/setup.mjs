// Installs the three libraries under test into tmp/csp-spike/deps (outside the pnpm workspace).
//
// This deliberately does not touch package.json, pnpm-workspace.yaml or the allow-list: the spike
// must not add product dependencies (ADR-027). The 3-day release-age rule is mirrored with
// `npm --before`, and install scripts are disabled.
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { LIBRARIES, depsDir, depsModules } from './paths.mjs';

const installedVersion = (name) => {
  try {
    const manifest = join(depsModules, name, 'package.json');
    return JSON.parse(readFileSync(manifest, 'utf8')).version;
  } catch {
    return undefined;
  }
};

const missing = Object.entries(LIBRARIES).filter(
  ([name, version]) => installedVersion(name) !== version,
);

if (missing.length === 0) {
  console.log(`spikes-csp: libraries already installed in ${depsDir}`);
} else {
  mkdirSync(depsDir, { recursive: true });
  if (!existsSync(join(depsDir, 'package.json'))) {
    writeFileSync(
      join(depsDir, 'package.json'),
      JSON.stringify({ name: 'csp-spike-deps', private: true }, null, 2),
    );
  }
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const specs = Object.entries(LIBRARIES).map(
    ([name, version]) => `${name}@${version}`,
  );
  console.log(`spikes-csp: installing ${specs.join(' ')} into ${depsDir}`);
  // Every word is a constant of this script (pinned names and versions, a date): no user input.
  const flags = `--ignore-scripts --save-exact --no-audit --no-fund --before=${threeDaysAgo.toISOString()}`;
  execSync(`npm install ${flags} ${specs.join(' ')}`, {
    cwd: depsDir,
    stdio: 'inherit',
  });
}
