// tests/fork-tools-data-root.test.mjs — the fork's own toolkit must read and
// write the USER's data root, never the checkout it happens to live in.
//
// Six fork tools resolved the checkout instead of the data root, each in the
// same way: `dirname(fileURLToPath(import.meta.url))` fed to
// `resolveTrackerPath()` or `join()` where `getCareerOpsRoot()` was meant.
// With the default layout the two coincide, so the bug stayed invisible; with
// CAREER_OPS_ROOT / CAREER_OPS_DATA_DIR set (both documented overrides) the
// tools read another project's tracker, profile and JDs. This is the same
// family tests/analysis-scripts-data-root.test.mjs pins for the analysis
// scripts (#3510/#3511), and the same shape upstream fixed for invite-match
// and merge-tracker.
//
// Each case runs the script as a child with the data root and the cwd pointed
// at DIFFERENT directories, so a path following either one is distinguishable.
// The fixtures are built so the checkout cannot satisfy the assertion: no
// `northwind-*` file exists in the repo's jds/, no fixture company is in the
// repo tracker, and the fixture profile/archetypes are not the repo's.
//
// story-bank-seed is exercised with `--no-write`: it still prints the resolved
// bank path, so the assertion holds without any risk of a failing run writing
// into the real checkout's interview-prep/.
//
// Run:  node test-all.mjs --only fork-tools-data-root

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const TRACKER = [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|---|---|---|---|---|---|---|---|',
  '| 1 | 2026-01-05 | Northwind Analytics | Senior Software Engineer | 4.2/5 | Evaluated | ❌ | [1](../reports/001-northwind-analytics-2026-01-05.md) | fixture row |',
  '| 2 | 2026-01-06 | Cobalt Robotics | Product Manager | 3.9/5 | Evaluated | ❌ | [2](../reports/002-cobalt-robotics-2026-01-06.md) | fixture row |',
  '',
].join('\n');

const REPORT_ONE = [
  '# 001 — Northwind Analytics',
  '',
  '## Machine Summary',
  '',
  '```yaml',
  'role: Senior Software Engineer',
  'advertised_comp: "$150,000-$200,000"',
  'next_action: apply with a runnable eval harness',
  'soft_gaps:',
  '  - no published eval harness demo',
  'final_decision: Apply',
  '```',
  '',
  '## F) Interview Plan',
  '',
  '| # | JD requirement | Title | S | T | A | R | Reflection |',
  '|---|---|---|---|---|---|---|---|',
  '| 1 | agent orchestration | Cut a silo doc pipeline | owned the migration | scoped 3 teams | shipped a router | 40% faster handoff | orchestration |',
  '',
].join('\n');

const REPORT_TWO = [
  '# 002 — Cobalt Robotics',
  '',
  '```yaml',
  'role: Product Manager',
  'advertised_comp: "$180,000-$210,000"',
  'final_decision: Apply',
  '```',
  '',
].join('\n');

function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'career-ops-forktool-'));
  const decoyCwd = mkdtempSync(join(tmpdir(), 'career-ops-forkcwd-'));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  mkdirSync(join(dataRoot, 'reports'), { recursive: true });
  mkdirSync(join(dataRoot, 'jds'), { recursive: true });
  mkdirSync(join(dataRoot, 'config'), { recursive: true });
  writeFileSync(join(dataRoot, 'data', 'applications.md'), TRACKER);
  writeFileSync(join(dataRoot, 'reports', '001-northwind-analytics-2026-01-05.md'), REPORT_ONE);
  writeFileSync(join(dataRoot, 'reports', '002-cobalt-robotics-2026-01-06.md'), REPORT_TWO);
  writeFileSync(join(dataRoot, 'jds', 'northwind-analytics-senior-engineer.md'), [
    '# Senior Software Engineer, Northwind Analytics',
    '',
    'Requirements: 5+ years Python, LLM evaluation harnesses, retrieval pipelines,',
    'vector databases, and production agent orchestration.',
    '',
  ].join('\n'));
  writeFileSync(join(dataRoot, 'config', 'profile.yml'), [
    'target_range: "$111,000-$222,000"',
    'archetypes:',
    '  - name: "Distinctive Fixture Archetype"',
    '    keywords: [fixtureonly]',
    '',
  ].join('\n'));
  writeFileSync(join(dataRoot, 'cv.md'), [
    '# Professional Summary',
    '',
    'Fixture-only candidate summary token: fixturesummarytoken.',
    '',
    '## Certifications',
    '',
    '- Fixture Certificate',
    '',
  ].join('\n'));
  writeFileSync(join(dataRoot, 'data', 'proof-points.tsv'), [
    'name\tstatus\turl\tblocks\tupdated',
    'eval-demo\tpublished\thttps://github.com/fixture/eval-demo\teval harness\t2026-09-01',
    '',
  ].join('\n'));
  return { dataRoot, decoyCwd };
}

function run(script, args, f, cwd = f.decoyCwd) {
  const r = spawnSync(process.execPath, [join(ROOT, script), ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 60_000,
    env: { ...process.env, CAREER_OPS_ROOT: f.dataRoot, CAREER_OPS_DATA_DIR: '', CAREER_OPS_TRACKER: '' },
  });
  assert.equal(r.error, undefined, `spawn failed: ${r.error?.message}`);
  return { ...r, all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const cleanup = (f) => {
  for (const d of [f.dataRoot, f.decoyCwd]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
};
const sha = (p) => (existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : null);

test('concentration reads the tracker from the data root, not the checkout', () => {
  const f = fixture();
  try {
    const r = run('concentration.mjs', ['--json'], f);
    assert.match(r.all, /Northwind Analytics/, `fixture company missing from concentration output:\n${r.all.slice(0, 300)}`);
    assert.doesNotMatch(r.all, /Deepgram/, 'concentration read the checkout tracker instead of the data root');
  } finally { cleanup(f); }
});

test('salary-trend reads profile.yml and reports from the data root', () => {
  const f = fixture();
  try {
    const r = run('salary-trend.mjs', ['--json'], f);
    const json = JSON.parse(r.stdout);
    assert.deepEqual(json.target, [111_000, 222_000], `target band came from the wrong profile.yml:\n${r.stdout.slice(0, 300)}`);
    assert.equal(json.families[0]?.family, 'swe-ai', `report families missing:\n${r.stdout.slice(0, 300)}`);
  } finally { cleanup(f); }
});

test('proof-point-bank matches proofs against data-root tracker rows', () => {
  const f = fixture();
  try {
    const r = run('proof-point-bank.mjs', ['--unblocks'], f);
    assert.match(r.all, /Northwind Analytics/, `data-root tracker row not matched to the published proof:\n${r.all.slice(0, 300)}`);
    assert.match(r.all, /eval-demo/, `published proof missing:\n${r.all.slice(0, 300)}`);
  } finally { cleanup(f); }
});

test('story-bank-seed resolves the bank under the data root', () => {
  const f = fixture();
  const realBank = join(ROOT, 'interview-prep', 'story-bank.md');
  const before = sha(realBank);
  try {
    const r = run('story-bank-seed.mjs', ['--no-write'], f);
    assert.match(
      r.all,
      new RegExp(`→ ${join(f.dataRoot, 'interview-prep', 'story-bank.md').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      `bank path did not resolve under the data root:\n${r.all.slice(0, 300)}`,
    );
    assert.equal(sha(realBank), before, 'the checkout story-bank was modified');
  } finally { cleanup(f); }
});

test('screen-check finds the JD in the data-root jds/ and runs the skill gap', () => {
  const f = fixture();
  try {
    // cwd is the data root here, not a decoy: the delegated jd-skill-gap.mjs
    // reads `const CV_PATH = 'cv.md'` relative to the cwd (upstream behavior),
    // so a decoy cwd would fail the child for a reason unrelated to the jds/
    // lookup under test. The assertion still discriminates: the checkout has no
    // `northwind-*` file in its own jds/, so a code-root lookup yields null.
    const r = run('screen-check.mjs', ['--json'], f, f.dataRoot);
    const rows = JSON.parse(r.stdout);
    const row = rows.find((x) => x.num === 1);
    assert.ok(row, `fixture row missing from screen-check:\n${r.stdout.slice(0, 300)}`);
    assert.notEqual(row.jdSkillGap, null, 'the JD in the data root was not found (looked in the checkout)');
  } finally { cleanup(f); }
});

test('archetype-cv reads archetypes from the data-root profile.yml', () => {
  const f = fixture();
  try {
    const r = run('archetype-cv.mjs', ['--json'], f);
    const names = JSON.parse(r.stdout);
    assert.deepEqual(names, ['Distinctive Fixture Archetype'], `archetypes came from the wrong profile.yml:\n${r.stdout.slice(0, 300)}`);
  } finally { cleanup(f); }
});
