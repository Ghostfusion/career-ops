// tests/close-loop.test.mjs — close-loop turns a Rejected tracker row's report
// into a proposal; it must read the configured data root, classify the gap the
// way its self-test claims, and never write the tracker it reads.
//
// Run:  node --test tests/close-loop.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const TRACKER_HEADER = [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|---|---|---|---|---|---|---|---|',
];

function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'career-ops-closeloop-'));
  const decoyCwd = mkdtempSync(join(tmpdir(), 'career-ops-closeloopcwd-'));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  mkdirSync(join(dataRoot, 'reports'), { recursive: true });
  writeFileSync(join(dataRoot, 'data', 'applications.md'), [
    ...TRACKER_HEADER,
    '| 1 | 2026-01-05 | Acme | Backend Engineer | 4.2/5 | Applied | ✅ | [1](reports/1-acme.md) | n |',
    '| 2 | 2026-02-05 | Globex | ML Engineer | 4.4/5 | Rejected | ✅ | [2](reports/2-globex.md) | n |',
    '| 3 | 2026-03-05 | Initech | Data Engineer | 3.1/5 | Rejected | ✅ | [3](reports/3-initech.md) | no report on file |',
    '',
  ].join('\n'));
  // The first soft gap is a relocation blocker the proposal must skip; the
  // second is the actionable one.
  writeFileSync(join(dataRoot, 'reports', '2-globex.md'), [
    '# Globex', '',
    '```yaml',
    'soft_gaps:',
    '  - relocation required',
    '  - no runnable eval demo',
    'hard_stops: []',
    'discard_reasons: []',
    '```', '',
  ].join('\n'));
  return { dataRoot, decoyCwd };
}

function run(args, { dataRoot, decoyCwd }) {
  const r = spawnSync(process.execPath, [join(ROOT, 'close-loop.mjs'), ...args], {
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

test('close-loop --self-test passes', () => {
  const f = fixture();
  try {
    const r = run(['--self-test'], f);
    assert.equal(r.status, 0, `exited ${r.status}: ${r.all.slice(0, 300)}`);
    assert.match(r.stdout, /close-loop self-test: 4\/4 passed/);
  } finally { cleanup(f); }
});

test('a rejected row yields a JSON proposal that skips non-actionable gaps and routes to launchpad-prep', () => {
  const f = fixture();
  try {
    const r = run(['2', '--json'], f);
    assert.equal(r.status, 0, `exited ${r.status}: ${r.all.slice(0, 300)}`);
    const proposal = JSON.parse(r.stdout);
    assert.equal(proposal.row, 2);
    assert.equal(proposal.company, 'Globex');
    assert.equal(proposal.role, 'ML Engineer');
    // "relocation required" is filtered out; "no runnable eval demo" wins and
    // routes to a launchpad prep task.
    assert.equal(proposal.gap, 'no runnable eval demo');
    assert.equal(proposal.target, 'launchpad-prep');
  } finally { cleanup(f); }
});

test('text mode prints the proposal header and the prep task', () => {
  const f = fixture();
  try {
    const r = run(['2'], f);
    assert.equal(r.status, 0, `exited ${r.status}: ${r.all.slice(0, 300)}`);
    assert.match(r.stdout, /close-loop proposal for #2 \(Globex · ML Engineer\)/);
    assert.match(r.stdout, /target: launchpad-prep/);
    assert.match(r.stdout, /prep:   publish the artifact/);
  } finally { cleanup(f); }
});

test('a Rejected row with no report falls back to notes and defaults to cv.md', () => {
  const f = fixture();
  try {
    const r = run(['3', '--json'], f);
    assert.equal(r.status, 0, `exited ${r.status}: ${r.all.slice(0, 300)}`);
    const proposal = JSON.parse(r.stdout);
    assert.equal(proposal.gap, 'no report on file');
    assert.equal(proposal.target, 'cv.md');
  } finally { cleanup(f); }
});

test('a non-Rejected row is treated as a preventive review, not an error', () => {
  const f = fixture();
  try {
    const r = run(['1'], f);
    assert.equal(r.status, 0, `exited ${r.status}: ${r.all.slice(0, 300)}`);
    assert.match(r.all, /row is Applied, not Rejected/);
  } finally { cleanup(f); }
});

test('missing row exits 2 and no selection exits 1', () => {
  const f = fixture();
  try {
    const missing = run(['99'], f);
    assert.equal(missing.status, 2, `exited ${missing.status}: ${missing.all.slice(0, 300)}`);
    assert.match(missing.stderr, /no tracker row #99/);

    const usage = run([], f);
    assert.equal(usage.status, 1, `exited ${usage.status}: ${usage.all.slice(0, 300)}`);
    assert.match(usage.stderr, /Usage: node close-loop\.mjs/);
  } finally { cleanup(f); }
});

test('close-loop never writes the tracker or the cwd it was launched from', () => {
  const f = fixture();
  try {
    const tracker = join(f.dataRoot, 'data', 'applications.md');
    const before = readFileSync(tracker, 'utf-8');
    run(['2', '--json'], f);
    assert.equal(readFileSync(tracker, 'utf-8'), before, 'close-loop rewrote the tracker it only reads');
    assert.deepEqual(readdirSync(f.decoyCwd), [], 'close-loop wrote into the directory it was launched from');
  } finally { cleanup(f); }
});
