// Regression: parseReportScore() feeds the Score cell of every
// batch/tracker-additions/or-*.tsv row openrouter-runner writes, and that cell
// is what launchpad reads to decide ACT/PREP vs SKIP.
//
// It used to accept only a ---SCORE_SUMMARY--- block. modes/oferta.md — the
// evaluation mode the runner feeds — emits no such block: its report format is
// a `**Score:** {X/5}` line (bold wraps the colon) plus a fenced
// `## Machine Summary`. So every openrouter row carried a blank Score cell and
// launchpad classified a 4.2 match as SKIP instead of PREP. The block must
// still win when a producer does emit one, and a Block score in the prose
// ("... scores 4.8/5 overall") must not win over the documented line.

import { parseReportScore } from '../openrouter-runner.mjs';
import { pass, fail } from './helpers.mjs';

console.log('\nopenrouter-runner.mjs — parseReportScore() reads the documented Score line');

const summary = '---SCORE_SUMMARY---\nSCORE: 3.8\n---END_SUMMARY---\n';
const documented =
  '# Evaluation: Acme — Senior Engineer\n\n'
  + '**Score:** 4.2/5\n\n'
  + '## Machine Summary\n\n```yaml\nnext_action: Apply with a demo\n```\n';

const cases = [
  ['documented `**Score:** {X/5}` line (modes/oferta.md report format)', documented, 4.2],
  ['machine-summary block', summary, 3.8],
  ['block wins when both forms are present', documented + summary, 3.8],
  ['unbolded `Score:` line', 'Score: 4.5/5\n', 4.5],
  ['prose Block score does not win over the documented line', 'Block A scores 4.8/5 overall.\n**Score:** 3.6/5\n', 3.6],
  ['no score at all → NaN (blank cell, never a wrong number)', '## Machine Summary\n\n```yaml\nnote: no score\n```\n', NaN],
];

for (const [name, text, expected] of cases) {
  let got;
  try {
    got = parseReportScore(text);
  } catch (err) {
    fail(`${name}: threw ${err.message.split('\n')[0]}`);
    continue;
  }
  const ok = Number.isNaN(expected) ? Number.isNaN(got) : got === expected;
  if (ok) pass(`${name} → ${Number.isNaN(got) ? 'NaN' : got}`);
  else fail(`${name}: expected ${expected}, got ${got}`);
}
