// tests/concentration.test.mjs — concentration.mjs reports how much of the
// OPEN pipeline rests on one employer, and documents itself as read-only.
//
// Two details shape the fixture:
//   * Only rows whose Status is exactly "Evaluated" are grouped, so a row
//     parked at Applied must not appear — that is the documented boundary
//     ("no open evaluated rows to concentration-check").
//   * The tracker is resolved with resolveTrackerPath(), whose first lever is
//     CAREER_OPS_TRACKER (then <root>/data/applications.md). The fixture
//     tracker is handed over on that env var, and the launch directory is a
//     decoy, so a run that followed the cwd or the checkout would find no rows.
//
// Expected shares are computed from the fixture rows with the rule the tool
// documents (each employer's rounded percent of the open rows), never pasted
// from a previous run.
//
// Run: node --test tests/concentration.test.mjs

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

// The open rows the fixture tracker carries, and one closed row that must be
// ignored. `share` is not stored here: expectedByCompany() derives it.
const OPEN_ROWS = [
  { num: 1, company: 'Deepgram', role: 'Backend Engineer', score: 4.4 },
  { num: 2, company: 'Deepgram', role: 'ML Engineer', score: 3.5 },
  { num: 3, company: 'Sierra', role: 'Product Engineer', score: 3.9 },
  { num: 4, company: 'Supabase', role: 'Platform Engineer', score: 3.1 },
];
const CLOSED_ROW = { num: 6, company: 'Acme', role: 'Backend Engineer', score: 4.2 };

// The same size of open pipeline, spread across five employers (20% each):
// below the documented 40% single-employer warning threshold.
const SPREAD_ROWS = [
  { num: 1, company: 'Alpha', role: 'Backend Engineer', score: 4.0 },
  { num: 2, company: 'Bravo', role: 'ML Engineer', score: 3.5 },
  { num: 3, company: 'Charlie', role: 'Product Engineer', score: 3.9 },
  { num: 4, company: 'Delta', role: 'Platform Engineer', score: 3.1 },
  { num: 5, company: 'Echo', role: 'Data Engineer', score: 3.7 },
];

const rowLine = ({ num, company, role, score }, status) =>
  `| ${num} | 2026-01-0${num} | ${company} | ${role} | ${score}/5 | ${status} | yes | [${num}](${num}-r.md) | n |`;

function trackerText(rows) {
  return [
    '# Applications Tracker',
    '',
    HEADER,
    SEPARATOR,
    ...rows.map((r) => rowLine(r, 'Evaluated')),
    rowLine(CLOSED_ROW, 'Applied'),
    '',
  ].join('\n');
}

/** Company -> {count, scoreSum, share} for the open rows, per the documented rule. */
function expectedByCompany(rows = OPEN_ROWS) {
  const map = {};
  for (const r of rows) {
    map[r.company] ||= { count: 0, scoreSum: 0 };
    map[r.company].count++;
    map[r.company].scoreSum += r.score;
  }
  for (const k of Object.keys(map)) map[k].share = Math.round((map[k].count / rows.length) * 100);
  return map;
}

function fixture({ withTracker = true, rows = OPEN_ROWS } = {}) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'career-ops-concentration-'));
  const decoyCwd = mkdtempSync(join(tmpdir(), 'career-ops-concentration-cwd-'));
  const tracker = join(dataRoot, 'data', 'applications.md');
  if (withTracker) {
    mkdirSync(join(dataRoot, 'data'), { recursive: true });
    writeFileSync(tracker, trackerText(rows));
  }
  return { dataRoot, decoyCwd, tracker };
}

function run(args, f) {
  const r = spawnSync(process.execPath, [join(ROOT, 'concentration.mjs'), ...args], {
    cwd: f.decoyCwd,
    encoding: 'utf-8',
    timeout: 60_000,
    env: { ...process.env, CAREER_OPS_ROOT: f.dataRoot, CAREER_OPS_DATA_DIR: '', CAREER_OPS_TRACKER: f.tracker },
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
    assert.match(r.stdout, /concentration 3\/3 passed/, `self-test verdict:\n${r.all.slice(0, 400)}`);
  } finally { cleanup(f); }
});

test('the default view names the open-row count and the largest single-employer exposure', () => {
  const f = fixture();
  try {
    const r = run([], f);
    assert.match(r.stdout, /4 open rows across 3 companies/, `row/company tally:\n${r.stdout.slice(0, 400)}`);
    const expected = expectedByCompany();
    assert.match(
      r.stdout,
      new RegExp(`Largest exposure: Deepgram at ${expected.Deepgram.share}%`),
      `largest exposure for a ${expected.Deepgram.count}/${OPEN_ROWS.length} share:\n${r.stdout.slice(0, 400)}`,
    );
    // AGENTS.md: warn at >= 40% single-company exposure.
    assert.match(
      r.stdout,
      new RegExp(`\u26a0 Largest exposure: Deepgram at ${expected.Deepgram.share}% \u2014 high single-employer concentration`),
      `the ${expected.Deepgram.share}% exposure was not warned about:\n${r.stdout.slice(0, 400)}`,
    );
    assert.doesNotMatch(r.stdout, /Acme/, 'an Applied row was counted as open');
  } finally { cleanup(f); }
});

test('the 40% warning stays silent below the documented threshold', () => {
  const f = fixture({ rows: SPREAD_ROWS });
  try {
    const r = run([], f);
    const expected = expectedByCompany(SPREAD_ROWS);
    const top = Object.entries(expected).sort((a, b) => b[1].count - a[1].count)[0];
    assert.match(
      r.stdout,
      new RegExp(`Largest exposure: ${top[0]} at ${top[1].share}%`),
      `largest exposure:\n${r.stdout.slice(0, 400)}`,
    );
    assert.doesNotMatch(r.stdout, /\u26a0/, `a warning fired below the 40% threshold:\n${r.stdout.slice(0, 400)}`);
    assert.doesNotMatch(r.stdout, /high single-employer concentration/, 'the concentration warning fired below 40%');
  } finally { cleanup(f); }
});

test('--json reports each employer\'s count, score sum and rounded share', () => {
  const f = fixture();
  try {
    const r = run(['--json'], f);
    const parsed = JSON.parse(r.stdout);
    const expected = expectedByCompany();
    assert.deepEqual(
      Object.keys(parsed).sort(),
      Object.keys(expected).sort(),
      `grouped employers:\n${r.stdout.slice(0, 400)}`,
    );
    for (const [company, g] of Object.entries(expected)) {
      assert.equal(parsed[company].count, g.count, `${company} row count`);
      assert.equal(parsed[company].share, g.share, `${company} share of the open pipeline`);
      assert.ok(
        Math.abs(parsed[company].scoreSum - g.scoreSum) < 1e-9,
        `${company} score sum: ${parsed[company].scoreSum} vs ${g.scoreSum}`,
      );
    }
  } finally { cleanup(f); }
});

test('--row-count N lists exactly the top N employers by open-row share', () => {
  const f = fixture();
  try {
    const r = run(['--row-count', '2'], f);
    assert.match(r.stdout, /top 2 employer\(s\) by open-row share \(of 4 rows\)/, `heading:\n${r.stdout.slice(0, 400)}`);
    const expected = expectedByCompany();
    assert.match(
      r.stdout,
      new RegExp(`Deepgram\\s+2 row\\(s\\)\\s+${expected.Deepgram.share}%`),
      `the 2/4 employer's line:\n${r.stdout.slice(0, 400)}`,
    );
    const listed = r.stdout.split('\n').filter((l) => l.trim().startsWith('\u00b7'));
    assert.equal(listed.length, 2, `asked for 2 employers, printed:\n${r.stdout.slice(0, 400)}`);
  } finally { cleanup(f); }
});

test('an empty pipeline is the documented boundary, not a crash', () => {
  const f = fixture({ withTracker: false });
  try {
    const json = run(['--json'], f);
    assert.deepEqual(JSON.parse(json.stdout), {}, `expected an empty grouping:\n${json.stdout.slice(0, 400)}`);
    const text = run([], f);
    assert.match(text.stdout, /no open evaluated rows to concentration-check/, `boundary message:\n${text.all.slice(0, 400)}`);
  } finally { cleanup(f); }
});

test('it is read-only: the tracker and the launch directory are untouched', () => {
  const f = fixture();
  try {
    const before = readFileSync(f.tracker, 'utf8');
    run([], f);
    run(['--json'], f);
    run(['--row-count', '2'], f);
    assert.equal(readFileSync(f.tracker, 'utf8'), before, 'the tracker was rewritten by a read-only view');
    assert.deepEqual(readdirSync(f.decoyCwd), [], 'something was written into the directory it was launched from');
  } finally { cleanup(f); }
});
