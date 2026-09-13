// tests/screen-check.test.mjs — screen-check.mjs, the resume-screen gate folded
// out of the report's Machine Summary (hard_stops / soft_gaps / final_decision).
//
// The tracker and reports live under the USER's data root; the fixture below is
// a decoy-free data root, and the child runs with its cwd pointed at a second
// temp dir so a path that follows the cwd cannot pass unnoticed.
//
// The script advertises two things this suite holds it to: "It never writes
// anything", and its exit codes (0 ok, 2 no open row matched). Both are
// observable from outside the process.
//
// Run:  node --test tests/screen-check.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const HEADER = '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |';
const SEP = '|---|---|---|---|---|---|---|---|---|';

// A report whose Machine Summary is a fenced yaml block — the exact shape
// screen-check.mjs parses. Note the block list form: an inline `[]` is read as
// the string "[]" and therefore as no gates at all.
function reportMd({ decision = 'Apply', hardStops = [], softGaps = [] } = {}) {
  return [
    '# Evaluation — fixture',
    '',
    '```yaml',
    `final_decision: ${decision}`,
    'hard_stops:',
    ...hardStops.map((h) => `  - ${h}`),
    'soft_gaps:',
    ...softGaps.map((s) => `  - ${s}`),
    '```',
    '',
  ].join('\n');
}

function fixture({ rows = [], reports = {} } = {}) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'career-ops-screencheck-'));
  const decoyCwd = mkdtempSync(join(tmpdir(), 'career-ops-screencheck-cwd-'));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  mkdirSync(join(dataRoot, 'reports'), { recursive: true });
  writeFileSync(join(dataRoot, 'data', 'applications.md'), [
    '# Applications Tracker',
    '',
    HEADER,
    SEP,
    ...rows,
    '',
  ].join('\n'));
  for (const [name, body] of Object.entries(reports)) writeFileSync(join(dataRoot, 'reports', name), body);
  return { dataRoot, decoyCwd };
}

const ROWS = [
  '| 1 | 2026-01-05 | Acme | Backend Engineer | 4.2/5 | Evaluated | \u2705 | [1](r1.md) | n |',
  '| 2 | 2026-01-06 | Globex | ML Engineer | 4.4/5 | Evaluated | \u2705 | [2](r2.md) | n |',
  '| 3 | 2026-01-07 | Initech | Data Engineer | 3.9/5 | Applied | \u2705 | [3](r3.md) | n |',
];

// The report slug is deliberately far from any company in the checkout's jds/.
const CLEAN = '001-zzquux-backend-2026-01-05.md';
const BLOCKED = '002-zzquux-ml-2026-01-06.md';

function twoRowFixture() {
  return fixture({
    rows: ROWS,
    reports: { [CLEAN]: reportMd({ decision: 'Apply' }), [BLOCKED]: reportMd({ hardStops: ['no sponsorship available'] }) },
  });
}

// A JD whose filename starts with the report's full slug is this row's posting.
// The old resolver kept only the slug's FIRST token and took the first jds/ entry
// matching it, so two postings from one company could be scored against each
// other's requirements — and the numbers looked real.
function jdFixture(jdNames) {
  const f = twoRowFixture();
  mkdirSync(join(f.dataRoot, 'jds'), { recursive: true });
  writeFileSync(join(f.dataRoot, 'cv.md'), '# Professional Summary\n\nFixture CV.\n');
  for (const name of jdNames) {
    writeFileSync(join(f.dataRoot, 'jds', name), '# Fixture JD\n\nRequirements: Python, LLM evaluation.\n');
  }
  return f;
}

test('one JD matching the report slug is used for the skill gap', () => {
  const f = jdFixture(['zzquux-backend-engineer.md']);
  try {
    const rows = JSON.parse(run(['--json'], f).stdout);
    assert.notEqual(rows[0].jdSkillGap, null, 'the JD matching the report slug was not used');
  } finally { cleanup(f); }
});

test('two JDs sharing the report slug yield no hint rather than the wrong one', () => {
  const f = jdFixture(['zzquux-backend-engineer.md', 'zzquux-backend-analyst.md']);
  try {
    const rows = JSON.parse(run(['--json'], f).stdout);
    assert.equal(rows[0].jdSkillGap, null, 'an ambiguous JD set must not be attributed to a row');
  } finally { cleanup(f); }
});

function run(args, { dataRoot, decoyCwd }) {
  const r = spawnSync(process.execPath, [join(ROOT, 'screen-check.mjs'), ...args], {
    cwd: decoyCwd,
    encoding: 'utf-8',
    timeout: 60_000,
    env: { ...process.env, CAREER_OPS_ROOT: dataRoot, CAREER_OPS_DATA_DIR: '' },
  });
  assert.equal(r.error, undefined, `spawn failed: ${r.error?.message}`);
  return { ...r, all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const cleanup = (f) => {
  for (const d of [f.dataRoot, f.decoyCwd]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
};

test('--self-test reports its own verdict', () => {
  const f = fixture();
  try {
    const r = run(['--self-test'], f);
    assert.equal(r.status, 0, `self-test exited ${r.status}:\n${r.all}`);
    assert.match(r.all, /screen-check 5\/5 passed/);
  } finally { cleanup(f); }
});

test('--json maps open tracker rows to screen verdicts from the report summary', () => {
  const f = twoRowFixture();
  try {
    const r = run(['--json'], f);
    assert.equal(r.status, 0, `exited ${r.status}: ${r.all}`);
    const rows = JSON.parse(r.stdout);
    // Row 3 is `Applied`, not `Evaluated`: only open rows are checked.
    assert.equal(rows.length, 2, `expected the 2 open rows, got ${JSON.stringify(rows, null, 2)}`);
    assert.deepEqual(rows.map((x) => x.num), [1, 2]);
    assert.deepEqual(rows.map((x) => x.outcome), ['PASS', 'FAIL']);
    const [clean] = rows;
    assert.equal(clean.num, 1);
    assert.equal(clean.company, 'Acme');
    assert.equal(clean.role, 'Backend Engineer');
    assert.equal(clean.score, '4.2/5'.replace('/5', ''));
    assert.ok(clean.reportPath.endsWith(CLEAN), `report not resolved from the data root: ${clean.reportPath}`);
    assert.equal(clean.outcome, 'PASS');
    assert.equal(clean.reason, 'no gates in report');
    assert.deepEqual(clean.hard, []);
    assert.equal(clean.jdSkillGap, null);
    assert.equal(rows[1].reason, 'hard gate: no sponsorship available');
    assert.deepEqual(rows[1].hard, ['no sponsorship available']);
  } finally { cleanup(f); }
});

test('a soft gap that names an absent skill reads as MARGINAL, not FAIL', () => {
  const f = fixture({
    rows: ROWS.slice(0, 1),
    reports: { [CLEAN]: reportMd({ softGaps: ['no runnable demo published'] }) },
  });
  try {
    const r = run(['--json'], f);
    const [row] = JSON.parse(r.stdout);
    assert.equal(row.outcome, 'MARGINAL');
    assert.equal(row.reason, 'no runnable demo published');
  } finally { cleanup(f); }
});

test('--row with no open row for that number exits 2 and says so', () => {
  const f = twoRowFixture();
  try {
    const r = run(['--row', '3'], f);
    assert.equal(r.status, 2, `expected the documented not-found code, got ${r.status}: ${r.all}`);
    assert.match(r.stdout, /no open Evaluated row #3/);
  } finally { cleanup(f); }
});

test('--row narrows to the requested open row', () => {
  const f = twoRowFixture();
  try {
    const r = run(['--row', '2', '--json'], f);
    const rows = JSON.parse(r.stdout);
    assert.deepEqual(rows.map((x) => x.num), [2]);
    assert.deepEqual(rows.map((x) => x.outcome), ['FAIL']);
  } finally { cleanup(f); }
});

test('an empty tracker is a clean no-op, not an error', () => {
  const f = fixture();
  try {
    const r = run([], f);
    assert.equal(r.status, 0, `exited ${r.status}: ${r.all}`);
    assert.match(r.stdout, /no open Evaluated rows to check/);
    const json = run(['--json'], f);
    assert.deepEqual(JSON.parse(json.stdout), []);
  } finally { cleanup(f); }
});

test('the human-readable run lists every open row with an icon verdict', () => {
  const f = twoRowFixture();
  try {
    const r = run([], f);
    assert.equal(r.status, 0, `exited ${r.status}: ${r.all}`);
    assert.match(r.stdout, /^screen-check — estimated resume-screen outcome per open row:/m);
    assert.match(r.stdout, /#1 Acme · Backend Engineer · 4\.2\/5 → PASS/);
    assert.match(r.stdout, /#2 Globex · ML Engineer · 4\.4\/5 → FAIL/);
    assert.match(r.stdout, /hard gate: no sponsorship available/);
    assert.doesNotMatch(r.stdout, /#3 /, 'a non-open row must not be listed');
  } finally { cleanup(f); }
});

test('it never writes anything — the tracker and reports come back byte-identical', () => {
  const f = twoRowFixture();
  try {
    const tracker = join(f.dataRoot, 'data', 'applications.md');
    const before = readFileSync(tracker);
    const reportsBefore = readdirSync(join(f.dataRoot, 'reports')).sort();
    run([], f);
    run(['--json'], f);
    run(['--self-test'], f);
    assert.deepEqual(readFileSync(tracker), before, 'screen-check modified the tracker');
    assert.deepEqual(readdirSync(join(f.dataRoot, 'reports')).sort(), reportsBefore);
    assert.deepEqual(readdirSync(f.decoyCwd), [], 'a script wrote into the directory it was launched from');
  } finally { cleanup(f); }
});
