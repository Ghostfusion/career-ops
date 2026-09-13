// tests/rejection-reset.test.mjs — rejection-reset.mjs scans the tracker for
// rows that went Rejected and prints the close-loop proposal for each. It
// exported nothing and had no test.
//
// What is asserted here is its advisory contract:
//
//   scan         only Rejected rows are listed (an Applied/Evaluated row must
//                not appear), with the close-loop proposal for the row.
//   --row <n>    a selected row is reported even when it is not Rejected; an
//                unknown row says so instead of crashing.
//   --status     "Rejected" adds the documented refresh reminder.
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

function run(args, { dataRoot, decoyCwd }) {
  const r = spawnSync(process.execPath, [join(ROOT, 'rejection-reset.mjs'), ...args], {
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

test('--self-test verifies the state and the tracker read', () => {
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
