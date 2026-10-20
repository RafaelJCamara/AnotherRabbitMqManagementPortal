import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { readLabVersions, VERSIONS_FILE } from './lab-versions.ts';
import {
  legName,
  NIGHTLY_NODE_VERSIONS,
  nightlyLegs,
  nightlyReport,
  parseLegResult,
  parseNightlyPlan,
  planNightly,
} from './nightly.ts';
import type { NightlyLeg, NightlyPlan } from './nightly.ts';
import type { JobResult } from './verdict.ts';

const root = join(import.meta.dirname, '..', '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');
const pinned = readLabVersions(join(root, VERSIONS_FILE));

interface Step {
  uses?: string;
  with?: Record<string, string>;
}

const plan = (alphaVersions: string[] = []): NightlyPlan =>
  planNightly({ versions: pinned, alphaVersions });

/** Every planned leg reports `result`, except the ones `override` names. */
function reportedAll(
  nightly: NightlyPlan,
  result: JobResult,
  override: Record<string, JobResult> = {},
): Map<string, JobResult> {
  const reported = new Map<string, JobResult>();
  for (const entry of nightly.release.include) {
    reported.set(legName(entry.node, 'release', entry.version), result);
  }
  for (const entry of nightly.alpha.include) {
    reported.set(legName(entry.node, 'alpha', entry.version), result);
  }
  for (const [name, value] of Object.entries(override))
    reported.set(name, value);
  return reported;
}

const legsFor = (
  nightly: NightlyPlan,
  reported: Map<string, JobResult>,
  results: Partial<{
    plan: JobResult;
    release: JobResult;
    alpha: JobResult;
  }> = {},
): NightlyLeg[] =>
  nightlyLegs({
    planResult: results.plan ?? 'success',
    plan: nightly,
    releaseResult: results.release ?? 'success',
    alphaResult: results.alpha ?? (nightly.hasAlpha ? 'success' : 'skipped'),
    reported,
  });

describe('nightly plan', () => {
  it('AC-7 the nightly runs every lab version on Node 24.22.0 and 26.12.0 and the setup override is exact', () => {
    // Exact Node versions, the first being the pinned one.
    expect(NIGHTLY_NODE_VERSIONS).toEqual(['24.22.0', '26.12.0']);
    expect(read('.nvmrc').trim()).toBe(NIGHTLY_NODE_VERSIONS[0]);
    const nightly = plan();
    expect(nightly.release.include).toEqual(
      pinned.flatMap((version) => [
        { version, node: '24.22.0' },
        { version, node: '26.12.0' },
      ]),
    );
    expect(nightly.release.include).toHaveLength(pinned.length * 2);
    for (const entry of nightly.release.include) {
      expect(entry.node).toMatch(/^\d+\.\d+\.\d+$/);
    }

    // The setup action: no override reads .nvmrc; an override never reaches setup-node together with it.
    const action = parse(read('.github/actions/setup/action.yml')) as {
      inputs: Record<string, { default?: string; required?: boolean }>;
      runs: { steps: Step[] };
    };
    expect(action.inputs['node-version']).toMatchObject({
      default: '',
      required: false,
    });
    const setupNode = action.runs.steps.find((step) =>
      step.uses?.startsWith('actions/setup-node@'),
    );
    expect(setupNode?.with?.['node-version']).toBe(
      '${{ inputs.node-version }}',
    );
    const fileExpression = setupNode?.with?.['node-version-file'] ?? '';
    expect(fileExpression).toBe(
      "${{ inputs.node-version == '' && '.nvmrc' || '' }}",
    );
    // The nightly workflow gives each release leg exactly the plan's Node, and no other job any.
    const workflow = parse(
      read('.github/workflows/conformance-nightly.yml'),
    ) as {
      jobs: Record<string, { strategy?: { matrix?: unknown }; steps: Step[] }>;
    };
    for (const name of ['release', 'alpha']) {
      const job = workflow.jobs[name];
      expect(job?.strategy?.matrix).toBe(
        `\${{ fromJSON(needs.plan.outputs.${name}) }}`,
      );
      const setups = job?.steps.filter(
        (step) => step.uses === './.github/actions/setup',
      );
      expect(setups).toHaveLength(1);
      expect(setups?.[0]?.with).toEqual({
        'node-version': '${{ matrix.node }}',
      });
    }
    expect(read('.github/workflows/conformance-nightly.yml')).not.toMatch(
      /node-version:\s*['"]?[^$\s'"][^\n]*/,
    );
  });

  it('refuses a plan with a range or a build that is not exact', () => {
    expect(() => planNightly({ versions: ['4.x'], alphaVersions: [] })).toThrow(
      /exact/,
    );
    expect(() => planNightly({ versions: [], alphaVersions: [] })).toThrow(
      /no lab/,
    );
    expect(() =>
      planNightly({ versions: pinned, alphaVersions: ['4.4'] }),
    ).toThrow(/exact/);
    expect(plan(['4.4.0-alpha.1']).alpha.include).toEqual([
      { version: '4.4.0-alpha.1', node: '24.22.0' },
    ]);
    expect(plan(['4.4.0-alpha.1']).hasAlpha).toBe(true);
    expect(plan().hasAlpha).toBe(false);
  });
});

describe('nightly report', () => {
  it('AC-8 an alpha failure is shown but not blocking, and a leg that did not run is never shown as a pass', () => {
    const rowOf = (markdown: string, text: string): string =>
      markdown
        .split('\n')
        .find((line) => line.startsWith('|') && line.includes(text)) ?? '';

    // An empty alpha list and no Electron build: listed as not available, never as a pass, never omitted.
    const empty = plan();
    const quiet = nightlyReport(legsFor(empty, reportedAll(empty, 'success')));
    expect(quiet.exitCode).toBe(0);
    expect(rowOf(quiet.markdown, 'electron-node')).toContain('not available');
    expect(rowOf(quiet.markdown, 'electron-node')).not.toContain('pass');
    expect(rowOf(quiet.markdown, 'none planned')).toContain('not available');
    expect(rowOf(quiet.markdown, 'none planned')).not.toContain('pass');
    expect(rowOf(quiet.markdown, 'none planned')).toContain('alpha');

    // A failing alpha is listed as fail and does not fail the run.
    const withAlpha = plan(['4.4.0-alpha.1']);
    const alphaFails = nightlyReport(
      legsFor(
        withAlpha,
        reportedAll(withAlpha, 'success', {
          [legName('24.22.0', 'alpha', '4.4.0-alpha.1')]: 'failure',
        }),
        { alpha: 'failure' },
      ),
    );
    expect(alphaFails.exitCode).toBe(0);
    expect(rowOf(alphaFails.markdown, '4.4.0-alpha.1')).toContain('FAIL');
    expect(rowOf(alphaFails.markdown, '4.4.0-alpha.1')).toContain('may fail');

    // A failing release leg on either Node fails the run.
    for (const node of NIGHTLY_NODE_VERSIONS) {
      const failed = nightlyReport(
        legsFor(
          empty,
          reportedAll(empty, 'success', {
            [legName(node, 'release', '4.3.6')]: 'failure',
          }),
          { release: 'failure' },
        ),
      );
      expect(failed.exitCode, node).toBe(1);
      expect(failed.markdown).toContain(`node-${node} 4.3.6 (FAIL)`);
    }

    // A planned release leg nobody reported did not run: shown so, and the run fails.
    const reported = reportedAll(empty, 'success');
    reported.delete(legName('26.12.0', 'release', '4.1.8'));
    const missing = nightlyReport(legsFor(empty, reported));
    expect(missing.exitCode).toBe(1);
    expect(rowOf(missing.markdown, 'node-26.12.0 | release | 4.1.8')).toContain(
      'did not run',
    );
    expect(
      rowOf(missing.markdown, 'node-26.12.0 | release | 4.1.8'),
    ).not.toContain('pass');

    // A job that failed while every leg claims success cannot hide: the aggregate gets a row.
    const hidden = nightlyReport(
      legsFor(empty, reportedAll(empty, 'success'), { release: 'failure' }),
    );
    expect(hidden.exitCode).toBe(1);
    expect(hidden.markdown).toContain(
      'release job (its legs reported no failure)',
    );

    // No plan, no legs: the report fails instead of showing an empty table as fine.
    const noPlan = nightlyReport(
      nightlyLegs({
        planResult: 'failure',
        plan: undefined,
        releaseResult: 'skipped',
        alphaResult: 'skipped',
        reported: new Map(),
      }),
    );
    expect(noPlan.exitCode).toBe(1);
    expect(noPlan.markdown).toContain('FAIL');

    // Nothing in the nightly reads or writes the registry or the evidence tree.
    for (const file of ['nightly.ts', 'nightly-plan-cli.ts', 'report-cli.ts']) {
      // Code only: the header comments say what the file does not touch.
      const source = readFileSync(
        join(import.meta.dirname, file),
        'utf8',
      ).replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
      expect(source, file).not.toMatch(
        /lab-evidence|@app\/semantics|libs\/shared\/semantics/,
      );
      expect(source, file).not.toMatch(
        /\bwriteFileSync\([^)]*(evidence|registry)/,
      );
    }
  });

  it('lists a leg row for every planned release leg and keeps the report deterministic', () => {
    const nightly = plan();
    const legs = legsFor(nightly, reportedAll(nightly, 'success'));
    const release = legs.filter(
      (leg) => leg.channel === 'release' && leg.runtime !== 'electron-node',
    );
    expect(release).toHaveLength(pinned.length * 2);
    expect(legs.map((leg) => leg.runtime)).toContain('electron-node');
    const first = nightlyReport(legs).markdown;
    expect(nightlyReport([...legs].reverse()).markdown).toBe(first);
    expect(first).toContain('Every blocking leg succeeded.');
    expect(first).toContain('| Runtime | Channel | Broker | Result |');
  });

  it('reads the plan outputs and the leg statuses strictly', () => {
    const good = JSON.stringify({
      include: [{ version: '4.3.6', node: '24.22.0' }],
    });
    const empty = JSON.stringify({ include: [] });
    expect(parseNightlyPlan(good, empty)?.release.include).toHaveLength(1);
    expect(parseNightlyPlan(good, empty)?.hasAlpha).toBe(false);
    for (const bad of [
      '',
      '{}',
      '[]',
      'not json',
      JSON.stringify({ include: [{ version: '4.3', node: '24.22.0' }] }),
      JSON.stringify({ include: [{ version: '4.3.6', node: '22.0.0' }] }),
      JSON.stringify({ include: [{ version: '4.3.6' }] }),
    ]) {
      expect(parseNightlyPlan(bad, empty), bad).toBeUndefined();
      expect(parseNightlyPlan(good, bad), bad).toBeUndefined();
    }
    expect(parseLegResult('success\n')).toBe('success');
    expect(parseLegResult('failure')).toBe('failure');
    expect(parseLegResult('cancelled')).toBe('cancelled');
    for (const bad of ['', 'ok', 'Success', 'success failure', 'pass']) {
      expect(parseLegResult(bad), bad).toBeUndefined();
    }
  });
});
