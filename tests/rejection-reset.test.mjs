// tests/rejection-reset.test.mjs — rejection-reset.mjs scans the tracker for
// rows that went Rejected and prints the close-loop proposal for each. It
// exported nothing and had no test.
//
// What is asserted here is its advisory contract:
//
//   scan         only Rejected rows are listed (an Applied/Evaluated row must
//                not appear), with the close-loop proposal for the row.
//   tracker      it reads the file close-loop.mjs reads: CAREER_OPS_TRACKER
//                wins over <root>/data/applications.md, and <root>/
//                applications.md is the fallback when data/ has none.
//   --row <n>    a selected row is reported even when it is not Rejected; an
//                unknown row says so instead of crashing.
//   --status     "Rejected" adds the documented refresh reminder.
//   --json       structured output: { candidates: [{ num, company, role,
//                status, gap, target }] } — JSON even when nothing matches.
//   close-loop   a failed child is reported as "(close-loop failed: …)", not
//                as a blank gap that reads as "no gap".
//   --reset <n>  the one write: dismisses those rows in data/launchpad-state.json.
//   read-only    the script documents that it is advisory and never edits the
//                tracker — it must come back byte-identical, and no
//                launchpad-state.json may appear without the explicit flag.
//
// Every run happens in a child with the data root and the cwd pointed at
// DIFFERENT temp directories, so a cwd-relative write would be visible.
//
// Run:  node --test tests/rejection-reset.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const ROWS = [
  '| 1 | 2026-01-05 | Acme | Backend Engineer | 4.2/5 | Applied | ✅ | | n |',
  '| 2 | 2026-02-05 | Globex | ML Engineer | 4.4/5 | Rejected | ✅ | | n |',
  '| 3 | 2026-03-05 | Initech | Data Analyst | 2.1/5 | Evaluated | ✅ | | n |',
];

const TRACKER = [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|---|---|---|---|---|---|---|---|',
  ...ROWS,
  '',
].join('\n');

// Same header and rows, nothing in the Rejected state.
const TRACKER_NO_REJECT = [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|---|---|---|---|---|---|---|---|',
  ROWS[0],
  '',
].join('\n');

function fixture({ tracker = TRACKER } = {}) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'career-ops-rejection-'));
  const decoyCwd = mkdtempSync(join(tmpdir(), 'career-ops-rejection-cwd-'));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  if (tracker) writeFileSync(join(dataRoot, 'data', 'applications.md'), tracker);
  return { dataRoot, decoyCwd };
}

// Places the tracker at an arbitrary path inside a fresh root, so the default
// data/applications.md is absent and only the resolver under test can find it.
function fixtureAt(trackerRel, { tracker = TRACKER } = {}) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'career-ops-rejection-'));
  const decoyCwd = mkdtempSync(join(tmpdir(), 'career-ops-rejection-cwd-'));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  mkdirSync(dirname(join(dataRoot, trackerRel)), { recursive: true });
  writeFileSync(join(dataRoot, trackerRel), tracker);
  return { dataRoot, decoyCwd };
}

// A Rejected row missing its trailing columns: rejection-reset's index-based
// parser still reads row #2, while close-loop's width-guarded one cannot, so
// the child exits 2 and the failure must surface.
const SHORT_TRACKER = [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|---|---|---|---|---|---|---|---|',
  '| 2 | 2026-02-05 | Globex | ML Engineer | 4.4/5 | Rejected',
  '',
].join('\n');

function run(args, { dataRoot, decoyCwd, env = {} }) {
  const r = spawnSync(process.execPath, [join(ROOT, 'rejection-reset.mjs'), ...args], {
    cwd: decoyCwd,
    encoding: 'utf-8',
    timeout: 60_000,
    // CAREER_OPS_TRACKER is cleared unless a test sets it, so an ambient value
    // cannot silently redirect the run.
    env: { ...process.env, CAREER_OPS_ROOT: dataRoot, CAREER_OPS_DATA_DIR: '', CAREER_OPS_TRACKER: '', ...env },
  });
  assert.equal(r.error, undefined, `spawn failed: ${r.error?.message}`);
  return { ...r, all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const cleanup = (f) => {
  for (const d of [f.dataRoot, f.decoyCwd]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
};

test('--self-test drives the tracker parser and passes', () => {
  const f = fixture();
  try {
    const r = run(['--self-test'], f);
    assert.equal(r.status, 0, `self-test failed:\n${r.all.slice(0, 400)}`);
    assert.match(r.stdout, /rejection-reset 2\/2 passed/, `unexpected self-test verdict:\n${r.all.slice(0, 400)}`);
  } finally { cleanup(f); }
});

test('a plain scan proposes only for the Rejected row', () => {
  const f = fixture();
  try {
    const r = run([], f);
    assert.equal(r.status, 0, `exited ${r.status}:\n${r.all.slice(0, 400)}`);
    assert.match(r.stdout, /#2 Globex · ML Engineer \[Rejected\]/, `the rejected row was not reported:\n${r.all.slice(0, 400)}`);
    assert.doesNotMatch(r.stdout, /#1 Acme/, 'an Applied row is not a candidate');
    assert.doesNotMatch(r.stdout, /#3 Initech/, 'an Evaluated row is not a candidate');
    assert.match(r.stdout, /close-loop gap:/, 'the proposal must reuse close-loop');
    assert.match(r.stdout, /never edits cv\.md\/_profile\.md or the tracker/, 'the advisory footer is part of the output');
  } finally { cleanup(f); }
});

test('--row selects a row that is not Rejected, and --status Rejected notes it', () => {
  const f = fixture();
  try {
    const plain = run(['--row', '1'], f);
    assert.equal(plain.status, 0, `exited ${plain.status}:\n${plain.all.slice(0, 400)}`);
    assert.match(plain.stdout, /#1 Acme · Backend Engineer \[Applied\]/, `--row must select regardless of status:\n${plain.all.slice(0, 400)}`);
    assert.doesNotMatch(plain.stdout, /rejection recorded/, 'without --status Rejected no reminder is printed');

    const noted = run(['--row', '1', '--status', 'Rejected'], f);
    assert.equal(noted.status, 0, `exited ${noted.status}:\n${noted.all.slice(0, 400)}`);
    assert.match(noted.stdout, /rejection recorded for 1 — re-run launchpad to refresh tiers/, `the documented reminder is missing:\n${noted.all.slice(0, 400)}`);
  } finally { cleanup(f); }
});

test('an unknown row and a tracker with no rejections both exit cleanly', () => {
  const f = fixture();
  try {
    const missing = run(['--row', '99'], f);
    assert.equal(missing.status, 0, `exited ${missing.status}:\n${missing.all.slice(0, 400)}`);
    assert.match(missing.stdout, /no tracker row #99/, `expected the not-found message:\n${missing.all.slice(0, 400)}`);
  } finally { cleanup(f); }

  const none = fixture({ tracker: TRACKER_NO_REJECT });
  try {
    const r = run([], none);
    assert.equal(r.status, 0, `exited ${r.status}:\n${r.all.slice(0, 400)}`);
    assert.match(r.stdout, /no rejected rows in the tracker/, `expected the empty-scan message:\n${r.all.slice(0, 400)}`);
  } finally { cleanup(none); }

  const bare = fixture({ tracker: null });
  try {
    const r = run([], bare);
    assert.equal(r.status, 0, `exited ${r.status}:\n${r.all.slice(0, 400)}`);
    assert.match(r.stdout, /no rejected rows in the tracker/, `a missing tracker is an empty scan, not a crash:\n${r.all.slice(0, 400)}`);
  } finally { cleanup(bare); }
});

test('it is advisory: the tracker is untouched and no state file appears', () => {
  const f = fixture();
  try {
    const trackerPath = join(f.dataRoot, 'data', 'applications.md');
    const before = readFileSync(trackerPath, 'utf-8');
    for (const args of [[], ['--row', '2'], ['--row', '2', '--status', 'Rejected']]) {
      const r = run(args, f);
      assert.equal(r.status, 0, `exited ${r.status}:\n${r.all.slice(0, 400)}`);
    }
    assert.equal(
      readFileSync(trackerPath, 'utf-8'),
      before,
      'rejection-reset documents that it never edits the tracker — it must come back byte-identical',
    );
    assert.equal(
      existsSync(join(f.dataRoot, 'data', 'launchpad-state.json')),
      false,
      'launchpad-state.json is only for the explicit reset flag; an advisory scan must not create it',
    );
    assert.deepEqual(readdirSync(f.decoyCwd), [], 'a run wrote into the directory it was launched from');
  } finally { cleanup(f); }
});

test('--json emits the same proposals as structured output', () => {
  const f = fixture();
  try {
    const r = run(['--row', '2', '--json'], f);
    assert.equal(r.status, 0, `exited ${r.status}:\n${r.all.slice(0, 400)}`);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.candidates.length, 1, `expected one candidate:\n${r.stdout.slice(0, 300)}`);
    assert.equal(payload.candidates[0].num, 2);
    assert.equal(typeof payload.candidates[0].gap, 'string');
  } finally { cleanup(f); }

  const empty = fixture({ tracker: TRACKER_NO_REJECT });
  try {
    const r = run(['--json'], empty);
    assert.equal(r.status, 0, `exited ${r.status}:\n${r.all.slice(0, 400)}`);
    assert.deepEqual(
      JSON.parse(r.stdout),
      { candidates: [] },
      `--json must stay JSON when nothing matches:\n${r.stdout.slice(0, 300)}`,
    );
  } finally { cleanup(empty); }
});

test('--reset is the one write: it dismisses rows under the data root only', () => {
  const f = fixture();
  try {
    const trackerPath = join(f.dataRoot, 'data', 'applications.md');
    const before = readFileSync(trackerPath, 'utf-8');
    const r = run(['--reset', '2'], f);
    assert.equal(r.status, 0, `exited ${r.status}:\n${r.all.slice(0, 400)}`);
    assert.match(r.stdout, /dismissed 2 in launchpad-state\.json/, `expected the confirmation:\n${r.all.slice(0, 300)}`);
    const state = JSON.parse(readFileSync(join(f.dataRoot, 'data', 'launchpad-state.json'), 'utf-8'));
    assert.deepEqual(state.dismissed, [2], 'the dismissed row must be recorded in the data root');
    assert.equal(readFileSync(trackerPath, 'utf-8'), before, '--reset must not touch the tracker');
    assert.deepEqual(readdirSync(f.decoyCwd), [], 'a run wrote into the directory it was launched from');
  } finally { cleanup(f); }

  const bad = fixture();
  try {
    const r = run(['--reset'], bad);
    assert.equal(r.status, 1, `a bare --reset is a usage error:\n${r.all.slice(0, 300)}`);
    assert.match(r.all, /Usage: node rejection-reset\.mjs --reset/, 'the usage line must name the operand');
    assert.equal(
      existsSync(join(bad.dataRoot, 'data', 'launchpad-state.json')),
      false,
      'a usage error must not write state',
    );
  } finally { cleanup(bad); }
});

test('reads the tracker CAREER_OPS_TRACKER points at', () => {
  // The default location is absent, so only the shared resolver can find the
  // file. Reading data/applications.md instead sees nothing and reports an
  // empty scan — while close-loop, spawned with the same env, reads the row.
  const f = fixtureAt(join('alt', 'applications.md'));
  try {
    const r = run([], { ...f, env: { CAREER_OPS_TRACKER: join(f.dataRoot, 'alt', 'applications.md') } });
    assert.equal(r.status, 0, `exited ${r.status}:\n${r.all.slice(0, 400)}`);
    assert.match(r.stdout, /#2 Globex · ML Engineer \[Rejected\]/, `the overridden tracker was not read:\n${r.all.slice(0, 400)}`);
    assert.doesNotMatch(r.stdout, /no rejected rows in the tracker/, 'the tracker existed — it just was not at the default path');
  } finally { cleanup(f); }
});

test('falls back to <root>/applications.md when data/ has no tracker', () => {
  const f = fixtureAt('applications.md');
  try {
    const r = run([], f);
    assert.equal(r.status, 0, `exited ${r.status}:\n${r.all.slice(0, 400)}`);
    assert.match(r.stdout, /#2 Globex · ML Engineer \[Rejected\]/, `the root-layout tracker was not read:\n${r.all.slice(0, 400)}`);
  } finally { cleanup(f); }
});

test('a failed close-loop is reported, not rendered as a blank gap', () => {
  const f = fixture({ tracker: SHORT_TRACKER });
  try {
    const r = run(['--row', '2'], f);
    assert.equal(r.status, 0, `exited ${r.status}:\n${r.all.slice(0, 400)}`);
    assert.match(r.stdout, /close-loop failed: no tracker row #2/, `the child's failure was swallowed:\n${r.all.slice(0, 400)}`);
    assert.doesNotMatch(r.stdout, /close-loop gap:/, 'a blank gap line would read as "close-loop found no gap"');

    const json = run(['--row', '2', '--json'], f);
    assert.equal(json.status, 0, `exited ${json.status}:\n${json.all.slice(0, 400)}`);
    const [candidate] = JSON.parse(json.stdout).candidates;
    assert.equal(candidate.num, 2);
    assert.match(candidate.gap, /^\(close-loop failed: no tracker row #2\)$/, `--json must carry the failure too:\n${json.stdout}`);
  } finally { cleanup(f); }
});
