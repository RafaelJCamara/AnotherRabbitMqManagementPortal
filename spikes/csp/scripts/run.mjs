// S-04 driver (`pnpm nx e2e spikes-csp`): loads the harness page under each CSP scenario in a real
// headless Chromium-family browser, prints what happened and checks each scenario's expectation.
//
//   --only=a,b   run only these scenario ids      --list     print the scenario ids
//   --verbose    print raw page data              exit code 1 when any expectation fails
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { launchBrowser, loadPage } from './browser.mjs';
import { scenarios } from './scenarios.mjs';
import { distDir, spikeRoot, webDist, workDir } from './paths.mjs';
import { startServer } from './server.mjs';

const arg = (name) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const only = arg('only')?.split(',');
const verbose = process.argv.includes('--verbose');

if (process.argv.includes('--list')) {
  for (const scenario of scenarios)
    console.log(`${scenario.id}\t${scenario.title}`);
  process.exit(0);
}
if (!existsSync(join(distDir, 'index.html'))) {
  console.error(
    'spikes-csp: run `pnpm nx build spikes-csp` first (no dist found).',
  );
  process.exit(2);
}

/** One line per distinct violation: `report style-src-attr inline`. */
function violationSignatures(result) {
  const counts = new Map();
  for (const v of result.spike?.violations ?? []) {
    const blocked =
      v.blockedURI === 'trusted-types-sink'
        ? `sink ${v.sample.split('|')[0]}`
        : v.blockedURI;
    const key = [v.disposition, v.effectiveDirective, blocked]
      .filter(Boolean)
      .join(' ');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

const browser = await launchBrowser();
console.log(`browser: ${browser.product} (${browser.executable})`);
const probeSource = readFileSync(join(spikeRoot, 'src', 'probe.js'), 'utf8');
const report = [];
let failed = 0;
try {
  for (const scenario of scenarios) {
    if (only !== undefined && !only.includes(scenario.id)) continue;
    const angular = scenario.angular === true;
    if (angular && !existsSync(join(webDist, 'index.html'))) {
      console.log(
        `\n== ${scenario.id}: SKIPPED (run \`pnpm nx build web\` first)`,
      );
      continue;
    }
    const server = await startServer({
      root: angular ? webDist : distDir,
      csp: scenario.csp,
      reportOnly: scenario.reportOnly ?? false,
      angular,
    });
    const url = `http://${scenario.host ?? '127.0.0.1'}:${String(server.port)}${scenario.path ?? '/'}`;
    const result = await loadPage(
      browser,
      url,
      angular ? { probeSource, settleMs: 2500 } : {},
    );
    await server.close();

    const signatures = violationSignatures(result);
    const problems = scenario.expect(result, signatures);
    if (result.timedOut) problems.push('page did not finish');
    if (problems.length > 0) failed++;

    console.log(
      `\n== ${scenario.id}: ${problems.length === 0 ? 'as expected' : 'UNEXPECTED'}`,
    );
    console.log(`   ${scenario.title}`);
    for (const [name, outcome] of Object.entries(result.spike?.steps ?? {})) {
      console.log(
        `   ${name}: ${outcome.ok ? 'ok' : 'FAIL'} ${JSON.stringify(outcome.detail)}`,
      );
    }
    if (angular)
      console.log(`   app-root children: ${String(result.appRootChildren)}`);
    const names = (result.spike?.policies ?? []).map(
      (p) => `${p.name}${p.created ? '' : ' (refused)'}`,
    );
    console.log(`   trusted types policies: ${names.join(', ') || 'none'}`);
    for (const [key, count] of signatures)
      console.log(`   violation x${String(count)}: ${key}`);
    if (verbose) {
      for (const m of new Set(result.messages)) console.log(`   console: ${m}`);
      for (const v of result.spike?.violations ?? []) {
        console.log(
          `   violation detail: ${v.effectiveDirective} ${v.blockedURI} at ${v.source}`,
        );
      }
    }
    for (const problem of problems) console.log(`   PROBLEM: ${problem}`);
    report.push({
      id: scenario.id,
      title: scenario.title,
      csp: scenario.csp,
      reportOnly: scenario.reportOnly ?? false,
      url: url.replace(/:\d+/, ':<port>'),
      steps: result.spike?.steps,
      policies: names,
      violations: Object.fromEntries(signatures),
      problems,
    });
  }
} finally {
  await browser.close();
}

mkdirSync(workDir, { recursive: true });
writeFileSync(
  join(workDir, 'results.json'),
  JSON.stringify({ browser: browser.product, scenarios: report }, null, 2),
);
console.log(
  `\n${String(report.length - failed)}/${String(report.length)} scenarios as expected`,
);
process.exit(failed === 0 ? 0 : 1);
