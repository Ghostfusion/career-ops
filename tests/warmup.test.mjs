// tests/warmup.test.mjs — the session-start digest (warmup.mjs) is a
// read-only aggregator of four child scripts. It exported nothing and had no
// test, so every one of its surfaces was untested.
//
// What is asserted here is the aggregation contract, not the children:
//
//   active  counts only the launchpad rows the digest calls actionable
//           (tier ACT or PREP) — the row set is chosen so a "count every
//           Evaluated row" regression, or dropping PREP, fails the suite.
//   proofs  is warmup's OWN computation over data/proof-points.tsv, so it is
//           exactly reproducible from the fixture.
//   salary  is dropped entirely under the documented --fast flag.
//
// Every run happens in a child with the data root and the cwd pointed at
// DIFFERENT temp directories, so a path that follows either one is visible.
//
// Run:  node --test tests/warmup.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const TRACKER = [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|---|---|---|---|---|---|---|---|',
  '| 1 | 2026-01-05 | Acme | Backend Engineer | 4.6/5 | Evaluated | ✅ | | n |',
  '| 2 | 2026-02-05 | Globex | ML Engineer | 3.6/5 | Evaluated | ✅ | | n |',
  '| 3 | 2026-03-05 | Initech | Data Analyst | 3.4/5 | Evaluated | ✅ | | n |',
  '| 4 | 2026-04-05 | Umbrella | Platform Engineer | 4.9/5 | Applied | ✅ | | n |',
  '',
].join('\n');

// Ledger format is name<TAB>status<TAB>url<TAB>blocks<TAB>updated (the header
// row is skipped by the digest, so it must be present and non-empty).
const PROOFS = [
  'name\tstatus\turl\tblocks\tupdated',
  'Eval harness\tbuilding\t\t\teval',
  'Write-up\tbuilding\t\t\twrite-up',
  'Blog post\tpublished\thttps://example.com/blog\t\tblog',
  '',
].join('\n');

function fixture({ tracker = true, proofs = true } = {}) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'career-ops-warmup-'));
  const decoyCwd = mkdtempSync(join(tmpdir(), 'career-ops-warmup-cwd-'));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  if (tracker) writeFileSync(join(dataRoot, 'data', 'applications.md'), TRACKER);
  if (proofs) writeFileSync(join(dataRoot, 'data', 'proof-points.tsv'), PROOFS);
  return { dataRoot, decoyCwd };
}

function run(args, { dataRoot, decoyCwd }) {
  const r = spawnSync(process.execPath, [join(ROOT, 'warmup.mjs'), ...args], {
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

test('--self-test verifies all three aggregator sources', () => {
  const f = fixture();
  try {
    const r = run(['--self-test'], f);
    assert.equal(r.status, 0, `self-test failed:\n${r.all.slice(0, 400)}`);
    assert.match(r.stdout, /warmup 3\/3 passed/, `unexpected self-test verdict:\n${r.all.slice(0, 400)}`);
  } finally { cleanup(f); }
});

test('--json counts ACTIVE tiers (ACT + PREP) and reads the proof ledger', () => {
  const f = fixture();
  try {
    const r = run(['--json'], f);
    assert.equal(r.status, 0, `exited ${r.status}:\n${r.all.slice(0, 400)}`);
    const p = JSON.parse(r.stdout);
    assert.equal(p.open, 3, `3 rows are Evaluated; Applied must not count:\n${r.stdout}`);
    assert.equal(p.active, 2, 'the 4.6 row is ACT and the 3.6 row is PREP; the 3.4 row is below the 3.5 floor');
    assert.equal(p.deadlines, 0, 'the fixture has no deadlines');
    assert.deepEqual(p.proofs, { unPub: 2, pub: 1 }, 'building rows are unpublished; only "published" counts as published');
    assert.equal(typeof p.onboarded, 'boolean');
    assert.ok(Array.isArray(p.salary?.families), `salary must carry a families array:\n${r.stdout}`);
  } finally { cleanup(f); }
});

test('--fast drops the salary trend from the JSON payload', () => {
  const f = fixture();
  try {
    const r = run(['--fast', '--json'], f);
    assert.equal(r.status, 0, `exited ${r.status}:\n${r.all.slice(0, 400)}`);
    const p = JSON.parse(r.stdout);
    assert.equal(p.salary, null, `--fast documents "skip the (slightly slower) salary trend":\n${r.stdout}`);
    assert.equal(p.open, 3, 'skipping the trend must not change the other figures');
    assert.equal(p.active, 2, 'skipping the trend must not change the other figures');
  } finally { cleanup(f); }
});

test('a data root with no tracker and no proof ledger still reports a clean baseline', () => {
  const f = fixture({ tracker: false, proofs: false });
  try {
    const r = run(['--json'], f);
    assert.equal(r.status, 0, `exited ${r.status}:\n${r.all.slice(0, 400)}`);
    const p = JSON.parse(r.stdout);
    assert.deepEqual(p.proofs, { unPub: 0, pub: 0 }, 'a missing ledger is empty, not an error');
    assert.equal(p.open, 0, 'a missing tracker is empty, not an error');
    assert.equal(p.active, 0, 'a missing tracker is empty, not an error');
    assert.equal(p.deadlines, 0, 'a missing tracker is empty, not an error');
  } finally { cleanup(f); }
});

test('the digest is read-only: the tracker and the launch directory are untouched', () => {
  const f = fixture();
  try {
    const before = readFileSync(join(f.dataRoot, 'data', 'applications.md'), 'utf-8');
    const r = run(['--json'], f);
    assert.equal(r.status, 0, `exited ${r.status}:\n${r.all.slice(0, 400)}`);
    assert.equal(
      readFileSync(join(f.dataRoot, 'data', 'applications.md'), 'utf-8'),
      before,
      'warmup documents itself as a "Read-only aggregator" — the tracker must come back byte-identical',
    );
    assert.deepEqual(readdirSync(f.decoyCwd), [], 'a run wrote into the directory it was launched from');
  } finally { cleanup(f); }
});
