// tests/expected-value.test.mjs — expected-value.mjs ranks open Evaluated rows
// by an expected value drawn from the report's own data:
//
//   EV ≈ P(clear the blocker) × (evaluation score) × (comp factor)
//
// where P is 0.85 for a fixable gap, 0.2 for a structural one and 1.0 with no
// blocker, and the comp factor is sqrt(advertised_comp / 100000), or 1 when the
// report advertises no band. That formula is re-stated (not snapshotted) below,
// so a change to any factor or to the rounding fails the suite.
//
// The fixture points CAREER_OPS_ROOT at a temp data root holding both
// data/applications.md and reports/<n>-<slug>.md; the launch directory is a
// decoy. Reports are matched to rows by the number in the tracker's Report
// link, so the filenames carry the row numbers.
//
// Run: node --test tests/expected-value.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HEADER = '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |';
const SEPARATOR = '|---|---|---|---|---|---|---|---|---|';

// comp is the advertised band as a number (a single-value band is its own
// midpoint); blocker drives the clearing probability.
const ROWS = [
  { num: 1, company: 'Acme', role: 'Backend Engineer', score: 4, comp: 120000, blocker: null },
  { num: 2, company: 'Globex', role: 'ML Engineer', score: 3, comp: null, blocker: 'structural' },
];

const CLEAR_PROB = { fixable: 0.85, structural: 0.2, null: 1.0 };

/** The documented EV for one fixture row, computed rather than pasted. */
function expectedEv(row) {
  const prob = CLEAR_PROB[row.blocker];
  const compFactor = row.comp === null ? 1 : Math.sqrt(row.comp / 100000);
  return Math.round(prob * row.score * compFactor * 100) / 100;
}

const rowLine = (row) =>
  `| ${row.num} | 2026-01-${String(row.num).padStart(2, '0')} | ${row.company} | ${row.role} | ${row.score}/5 | Evaluated | yes | [${row.num}](${row.num}-x.md) | n |`;

function reportText(row) {
  const lines = ['# Evaluation', '', '```yaml', `role: ${row.role}`];
  if (row.comp !== null) lines.push(`advertised_comp: ${row.comp}`);
  if (row.blocker === 'structural') lines.push('soft_gaps:', '  - relocation');
  if (row.blocker === 'fixable') lines.push('soft_gaps:', '  - portfolio depth');
  lines.push('```', '');
  return lines.join('\n');
}

function fixture({ withData = true, rows = ROWS } = {}) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'career-ops-ev-'));
  const decoyCwd = mkdtempSync(join(tmpdir(), 'career-ops-ev-cwd-'));
  if (withData) {
    mkdirSync(join(dataRoot, 'data'), { recursive: true });
    mkdirSync(join(dataRoot, 'reports'), { recursive: true });
    writeFileSync(join(dataRoot, 'data', 'applications.md'), [
      '# Applications Tracker', '', HEADER, SEPARATOR,
      ...rows.map(rowLine), '',
    ].join('\n'));
    for (const row of rows) writeFileSync(join(dataRoot, 'reports', `${row.num}-${row.company.toLowerCase()}.md`), reportText(row));
  }
  return { dataRoot, decoyCwd };
}

function run(args, f) {
  const r = spawnSync(process.execPath, [join(ROOT, 'expected-value.mjs'), ...args], {
    cwd: f.decoyCwd,
    encoding: 'utf-8',
    timeout: 60_000,
    env: { ...process.env, CAREER_OPS_ROOT: f.dataRoot, CAREER_OPS_DATA_DIR: '' },
  });
  assert.equal(r.error, undefined, `spawn failed: ${r.error?.message}`);
  assert.equal(r.status, 0, `exited ${r.status}: ${r.stdout}${r.stderr}`);
  return { ...r, all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const cleanup = (f) => {
  for (const d of [f.dataRoot, f.decoyCwd]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
};

test('the built-in self-test verdict passes', () => {
  const f = fixture();
  try {
    const r = run(['--self-test'], f);
    assert.match(r.stdout, /expected-value 9\/9 passed/, `self-test verdict:\n${r.all.slice(0, 400)}`);
  } finally { cleanup(f); }
});

test('--json scores each row with the documented formula and ranks highest-first', () => {
  const f = fixture();
  try {
    const parsed = JSON.parse(run(['--json'], f).stdout);
    assert.equal(parsed.length, ROWS.length, `scored rows:\n${JSON.stringify(parsed)}`);
    assert.deepEqual(parsed.map((r) => r.num), [1, 2], 'rows are ordered by EV, highest first');
    for (const row of ROWS) {
      const got = parsed.find((r) => r.num === row.num);
      assert.ok(got, `row ${row.num} is missing from the payload`);
      assert.equal(got.score, row.score, `row ${row.num} score read from the tracker`);
      assert.equal(got.blocker, row.blocker, `row ${row.num} blocker classification`);
      assert.equal(got.prob, CLEAR_PROB[row.blocker], `row ${row.num} clearing probability`);
      assert.equal(got.comp, row.comp, `row ${row.num} advertised comp from its report`);
      assert.equal(got.ev, expectedEv(row), `row ${row.num} EV`);
    }
    assert.ok(parsed[0].ev > parsed[1].ev, 'the structural blocker was not ranked below the clearable row');
  } finally { cleanup(f); }
});

test('--json emits every ranked row, while the human view keeps its own cap', () => {
  // 17 rows is past the 15 the JSON branch used to slice to, so a machine
  // consumer quietly lost rows 16+ that the human view never printed either.
  const rows = Array.from({ length: 17 }, (_, i) => ({
    num: i + 1, company: `Firm ${i + 1}`, role: 'Platform Engineer', score: 5, comp: null, blocker: null,
  }));
  const f = fixture({ rows });
  try {
    const parsed = JSON.parse(run(['--json'], f).stdout);
    assert.deepEqual(parsed.map((r) => r.num), rows.map((r) => r.num),
      `the payload carried ${parsed.length} of ${rows.length} ranked rows`);
    const printed = run([], f).stdout.split('\n').filter((l) => /^\s+\d+\.\d\d\s+#\d+\s/.test(l));
    assert.equal(printed.length, 12, 'the human-readable view is meant to stay capped at 12 rows');
  } finally { cleanup(f); }
});

test('the default view prints the ranked rows with comp and blocker', () => {
  const f = fixture();
  try {
    const r = run([], f);
    const first = `  ${expectedEv(ROWS[0]).toFixed(2)}  #1 Acme`;
    const second = `  ${expectedEv(ROWS[1]).toFixed(2)}  #2 Globex`;
    assert.ok(r.stdout.includes(first), `expected "${first}" in:\n${r.stdout.slice(0, 400)}`);
    assert.ok(r.stdout.includes(second), `expected "${second}" in:\n${r.stdout.slice(0, 400)}`);
    assert.ok(r.stdout.indexOf(first) < r.stdout.indexOf(second), 'the ranking is not highest-EV-first');
    assert.match(r.stdout, /#1 Acme \u00b7 Backend Engineer\s+\(4\/5, ready, comp \$120000\)/, `row detail:\n${r.stdout.slice(0, 400)}`);
    assert.match(r.stdout, /#2 Globex \u00b7 ML Engineer\s+\(3\/5, structural, comp n\/a\)/, `row detail:\n${r.stdout.slice(0, 400)}`);
  } finally { cleanup(f); }
});

test('--row N narrows the output to that tracker row', () => {
  const f = fixture();
  try {
    const json = JSON.parse(run(['--row', '2', '--json'], f).stdout);
    assert.equal(json.length, 1, `--row 2 returned ${json.length} rows`);
    assert.equal(json[0].num, 2);
    assert.equal(json[0].ev, expectedEv(ROWS[1]));
    const text = run(['--row', '2'], f);
    const line = `  ${expectedEv(ROWS[1]).toFixed(2)}  #2 Globex`;
    assert.ok(text.stdout.includes(line), `expected "${line}" in:\n${text.all.slice(0, 400)}`);
    assert.doesNotMatch(text.stdout, /#1 Acme/, 'another row leaked into a single-row view');
  } finally { cleanup(f); }
});

test('no tracker and no reports is the documented empty boundary', () => {
  const f = fixture({ withData: false });
  try {
    const json = run(['--json'], f);
    assert.deepEqual(JSON.parse(json.stdout), [], `expected an empty payload:\n${json.stdout.slice(0, 400)}`);
    assert.match(run([], f).stdout, /no open Evaluated rows/, 'the empty-boundary message was not printed');
  } finally { cleanup(f); }
});

test('it is read-only: the tracker, the reports and the launch directory are untouched', () => {
  const f = fixture();
  try {
    const trackerBefore = readFileSync(join(f.dataRoot, 'data', 'applications.md'), 'utf8');
    const reportBefore = readFileSync(join(f.dataRoot, 'reports', '1-acme.md'), 'utf8');
    run([], f);
    run(['--json'], f);
    run(['--row', '2'], f);
    assert.equal(readFileSync(join(f.dataRoot, 'data', 'applications.md'), 'utf8'), trackerBefore, 'the tracker was rewritten');
    assert.equal(readFileSync(join(f.dataRoot, 'reports', '1-acme.md'), 'utf8'), reportBefore, 'a report was rewritten');
    assert.deepEqual(readdirSync(f.decoyCwd), [], 'something was written into the directory it was launched from');
  } finally { cleanup(f); }
});
