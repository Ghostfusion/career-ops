// tests/watch-deadlines.test.mjs — watch-deadlines.mjs, the deadline-native
// scan over tracker Notes and follow-ups table rows.
//
// The header documents the marker vocabulary it reads in Notes
// (respond-by / reply-by / offer expiry / window / by / due, each followed by a
// YYYY-MM-DD date), the statuses it watches (Applied / Responded / Interview /
// Offer only), the --lookahead window (default 7 days), and exit code 1 for a
// usage/parse error. The follow-ups reader keys on the APPLICATION number
// (column 3), not the follow-up's own row id (column 2).
//
// Dates are generated relative to the current UTC day, because the script
// compares against the real clock: fixtures cannot hardcode "in 3 days".
//
// Every run happens in a child process with CAREER_OPS_ROOT pointed at a temp
// data root and the cwd at a DIFFERENT temp dir.
//
// Run:  node test-all.mjs --only watch-deadlines

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DAY = 86_400_000;

/** The UTC calendar day `days` away from today, as the script's todayUTC() sees it. */
function isoIn(days) {
  const n = new Date();
  const base = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
  return new Date(base + days * DAY).toISOString().slice(0, 10);
}

const TRACKER_HEADER = [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|---|---|---|---|---|---|---|---|',
];

const trackerRow = (num, date, company, role, score, status, notes) =>
  `| ${num} | ${date} | ${company} | ${role} | ${score}/5 | ${status} | ✅ | [${num}](r${num}.md) | ${notes} |`;

function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'career-ops-deadlines-'));
  const decoyCwd = mkdtempSync(join(tmpdir(), 'career-ops-deadlines-cwd-'));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  writeFileSync(join(dataRoot, 'data', 'applications.md'), [
    ...TRACKER_HEADER,
    trackerRow(1, '2026-01-05', 'Acme', 'Backend Engineer', '4.2', 'Applied', `reply-by ${isoIn(3)}`),
    trackerRow(2, '2026-02-05', 'Globex', 'ML Engineer', '4.4', 'Interview', `offer expires ${isoIn(-2)}`),
    trackerRow(3, '2026-03-05', 'Initech', 'Data Engineer', '4.6', 'Evaluated', `due ${isoIn(1)}`),
    trackerRow(4, '2026-04-05', 'Umbrella', 'SRE', '4.1', 'Applied', 'by 2026-02-30'),
    trackerRow(5, '2026-05-05', 'Hooli', 'Platform Engineer', '4.0', 'Offer', `window ${isoIn(40)}`),
    '',
  ].join('\n'));
  // Row id 1, application 6: the reported # must be the application number.
  writeFileSync(join(dataRoot, 'data', 'follow-ups.md'), [
    '# Follow-ups',
    '',
    '| num | appNum | date | company | role | channel | contact | notes |',
    '|---|---|---|---|---|---|---|---|',
    `| 1 | 6 | ${isoIn(5)} | Vehement | Platform Engineer | email | x | y |`,
    '',
  ].join('\n'));
  return { dataRoot, decoyCwd };
}

function run(args, { dataRoot, decoyCwd }) {
  const r = spawnSync(process.execPath, [join(ROOT, 'watch-deadlines.mjs'), ...args], {
    cwd: decoyCwd,
    encoding: 'utf-8',
    timeout: 60_000,
    env: {
      ...process.env,
      CAREER_OPS_ROOT: dataRoot,
      CAREER_OPS_DATA_DIR: '',
      CAREER_OPS_TRACKER: join(dataRoot, 'data', 'applications.md'),
    },
  });
  assert.equal(r.error, undefined, `spawn failed: ${r.error?.message}`);
  return { ...r, all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const cleanup = (f) => {
  for (const d of [f.dataRoot, f.decoyCwd]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
};

test('--self-test is green (the date-math contract it ships with)', () => {
  const f = fixture();
  try {
    const r = run(['--self-test'], f);
    assert.equal(r.status, 0, r.all);
    assert.match(r.all, /watch-deadlines self-test: 4\/4 passed/);
  } finally { cleanup(f); }
});

test('--json reports watched markers, sorted by days out', () => {
  const f = fixture();
  try {
    const r = run(['--json'], f);
    assert.equal(r.status, 0, r.all);
    const rows = JSON.parse(r.stdout);
    for (const x of rows) {
      for (const k of ['num', 'company', 'role', 'status', 'label', 'date', 'dateMs', 'daysOut']) {
        assert.ok(k in x, `row #${x.num} is missing ${k}`);
      }
    }
    // Overdue first, then the soonest. Sorted ascending by daysOut.
    assert.deepEqual(rows.map((x) => x.num), [2, 1, 6]);
    assert.deepEqual(rows.map((x) => x.daysOut), [-2, 3, 5]);

    const [overdue, replyBy, followup] = rows;
    assert.equal(overdue.company, 'Globex');
    assert.equal(overdue.status, 'Interview');
    assert.equal(overdue.label, 'offer expires');
    assert.equal(overdue.date, isoIn(-2));

    assert.equal(replyBy.status, 'Applied');
    assert.equal(replyBy.label, 'reply-by');
    assert.equal(replyBy.date, isoIn(3));

    // The follow-up line reports the APPLICATION number (6), not its own row id (1).
    assert.equal(followup.num, 6);
    assert.equal(followup.status, 'Follow-up');
    assert.equal(followup.label, 'follow-up');
    assert.equal(followup.company, 'Vehement');

    // Not watched: an Evaluated row's marker, an impossible calendar date, and
    // a date beyond the 7-day window.
    assert.ok(!rows.some((x) => x.num === 3), 'a non-watched status was reported');
    assert.ok(!rows.some((x) => x.num === 4), 'an impossible calendar date was reported');
    assert.ok(!rows.some((x) => x.num === 5), 'a date outside the lookahead was reported');
  } finally { cleanup(f); }
});

test('--lookahead widens the window but never accepts an impossible date', () => {
  const f = fixture();
  try {
    const wide = JSON.parse(run(['--json', '--lookahead', '45'], f).stdout);
    assert.deepEqual(wide.map((x) => x.num), [2, 1, 6, 5], 'the 40-day window row was not surfaced');
    assert.equal(wide.find((x) => x.num === 5).daysOut, 40);
    assert.ok(!wide.some((x) => x.num === 4), '2026-02-30 was accepted as a date');

    const narrow = JSON.parse(run(['--json', '--lookahead', '1'], f).stdout);
    assert.deepEqual(narrow.map((x) => x.num), [2], 'only the overdue row is inside a 1-day window');
  } finally { cleanup(f); }
});

test('the human view flags overdue and upcoming distinctly', () => {
  const f = fixture();
  try {
    const r = run([], f);
    assert.equal(r.status, 0, r.all);
    assert.match(r.all, /⏰ 3 deadline\(s\) to watch:/);
    assert.match(r.all, /#2 Globex · ML Engineer \[Interview\]\s+offer expires \S+\s+\(overdue 2d\)/);
    assert.match(r.all, /#1 Acme · Backend Engineer \[Applied\]\s+reply-by \S+\s+\(in 3d\)/);
    assert.match(r.all, /#6 Vehement · Platform Engineer \[Follow-up\]\s+follow-up \S+\s+\(in 5d\)/);
  } finally { cleanup(f); }
});

test('an invalid --lookahead is the documented exit 1', () => {
  const f = fixture();
  try {
    const bare = run(['--lookahead'], f);
    assert.equal(bare.status, 1, bare.all);
    assert.match(bare.all, /--lookahead requires a value/);

    for (const value of ['abc', '0', '-3']) {
      const r = run(['--lookahead', value], f);
      assert.equal(r.status, 1, `--lookahead ${value} should be a usage error:\n${r.all}`);
      assert.match(r.all, /Invalid --lookahead value/);
    }
  } finally { cleanup(f); }
});

test('no deadlines at all is a clean, silent-empty result', () => {
  const f = fixture();
  try {
    // A watched status with a marker-free note, and no follow-ups due: nothing
    // to report.
    writeFileSync(join(f.dataRoot, 'data', 'applications.md'), [
      ...TRACKER_HEADER,
      trackerRow(8, '2026-06-05', 'Vandelay', 'QA Engineer', '3.0', 'Applied', 'n'),
      '',
    ].join('\n'));
    writeFileSync(join(f.dataRoot, 'data', 'follow-ups.md'), [
      '# Follow-ups',
      '',
      '| num | appNum | date | company | role | channel | contact | notes |',
      '|---|---|---|---|---|---|---|---|',
      '',
    ].join('\n'));

    const j = run(['--json'], f);
    assert.equal(j.status, 0, j.all);
    assert.deepEqual(JSON.parse(j.stdout), []);

    const human = run([], f);
    assert.equal(human.status, 0, human.all);
    assert.match(human.all, /✓ no deadlines within 7d/);

    // An empty data root (no tracker, no follow-ups) is the same clean no-op.
    const empty = mkdtempSync(join(tmpdir(), 'career-ops-deadlines-empty-'));
    try {
      const r = run(['--json'], { dataRoot: empty, decoyCwd: f.decoyCwd });
      assert.equal(r.status, 0, r.all);
      assert.deepEqual(JSON.parse(r.stdout), []);
    } finally {
      rmSync(empty, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    assert.deepEqual(readdirSync(f.decoyCwd), [], 'a run wrote into the cwd it was launched from');
  } finally { cleanup(f); }
});
