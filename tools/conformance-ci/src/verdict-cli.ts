// The `conformance` job of the conformance-pr workflow: the required check.
//
//   AFFECTED=<plan output> PLAN_RESULT=<needs.plan.result> LAB_RESULT=<needs.lab.result> \
//     node tools/conformance-ci/src/verdict-cli.ts
//
// Exit 0 when the check passes, 1 otherwise. Node built-ins only; it reads three environment
// variables, writes the step summary (when GITHUB_STEP_SUMMARY is set) and nothing else.
import { appendFileSync } from 'node:fs';
import { parseAffected, parseJobResult, verdict } from './verdict.ts';

const env = process.env;
const decision = verdict({
  affected: parseAffected(env.AFFECTED),
  plan: parseJobResult(env.PLAN_RESULT),
  lab: parseJobResult(env.LAB_RESULT),
});
const line = `conformance: ${decision.pass ? 'pass' : 'FAIL'}: ${decision.reason}`;
console.log(line);
const summary = env.GITHUB_STEP_SUMMARY;
if (summary !== undefined && summary !== '') {
  appendFileSync(summary, `${line}\n`);
}
process.exit(decision.pass ? 0 : 1);
