// tests/warmup.test.mjs — the session-start digest (warmup.mjs) aggregates
// four child scripts. It exported nothing and had no test, so every one of its
// surfaces was untested.
//
// What is asserted here is the aggregation contract, not the children:
//
//   active  counts only the launchpad rows the digest calls actionable
//           (tier ACT or PREP) — the row set is chosen so a "count every
//           Evaluated row" regression, or dropping PREP, fails the suite.
//   proofs  is warmup's OWN computation over data/proof-points.tsv, so it is
//           exactly reproducible from the fixture.
//   salary  is dropped entirely under the documented --fast flag, and its
//           target band is printed only when salary-trend returned one.
//   failure a crashed source is reported as unknown (null in --json, a
//           "⚠ … failed" line in the digest), never as a zero count — and
//           doctor's unrequested template copies are surfaced, not silent.
//
// warmup is NOT read-only (doctor copies missing templates into the data root),
// so the digest must never claim "onboarded" when doctor did not answer.
//
// The failure/autoCopied/target cases run the real warmup.mjs beside stub
// children in a temp code root: warmup resolves each child from its own
// directory, so that is the only way to make a source fail deterministically.
//
// Every run happens in a child with the data root and the cwd pointed at
// DIFFERENT temp directories, so a path that follows either one is visible.
//
// Run:  node --test tests/warmup.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
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

function runScript(script, args, { dataRoot, decoyCwd }) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: decoyCwd,
    encoding: 'utf-8',
    timeout: 60_000,
    env: { ...process.env, CAREER_OPS_ROOT: dataRoot, CAREER_OPS_DATA_DIR: '', CAREER_OPS_TRACKER: '' },
  });
  assert.equal(r.error, undefined, `spawn failed: ${r.error?.message}`);
  return { ...r, all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function run(args, f) { return runScript(join(ROOT, 'warmup.mjs'), args, f); }

// warmup resolves every child from its own directory, so a temp code root
// holding a copy of warmup.mjs beside stub children is how a source is made to
// fail (or to answer) on demand.
function sandbox({ doctor, launchpad = [], deadlines = [], salary = { target: null, families: [] } }) {
  const codeRoot = mkdtempSync(join(tmpdir(), 'career-ops-warmup-code-'));
  const dataRoot = mkdtempSync(join(tmpdir(), 'career-ops-warmup-'));
  const decoyCwd = mkdtempSync(join(tmpdir(), 'career-ops-warmup-cwd-'));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  copyFileSync(join(ROOT, 'warmup.mjs'), join(codeRoot, 'warmup.mjs'));
  copyFileSync(join(ROOT, 'path-resolver.mjs'), join(codeRoot, 'path-resolver.mjs'));
  stub(join(codeRoot, 'doctor.mjs'), doctor);
  stub(join(codeRoot, 'launchpad.mjs'), launchpad);
  stub(join(codeRoot, 'watch-deadlines.mjs'), deadlines);
  stub(join(codeRoot, 'salary-trend.mjs'), salary);
  return { codeRoot, dataRoot, decoyCwd };
}

// A stub either throws (non-zero exit, like a crashed source) or prints JSON.
// It deliberately avoids the process-exit escape hatch — discovered suites are
// grepped for that call.
function stub(path, spec) {
  if (spec && spec.fail) { writeFileSync(path, "throw new Error('stub source failed');\n"); return; }
  writeFileSync(path, `console.log(${JSON.stringify(JSON.stringify(spec ?? []))});\n`);
}

const cleanup = (f) => {
  for (const d of [f.dataRoot, f.decoyCwd, f.codeRoot]) if (d) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
    // doctor answers with autoCopied so a template copy is never silent.
    assert.ok(Array.isArray(p.autoCopied), `the payload must carry doctor's autoCopied list:\n${r.stdout}`);
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

test('a data root with no tracker reports launchpad as failed, not as a zero count', () => {
  const f = fixture({ tracker: false, proofs: false });
  try {
    const r = run(['--json'], f);
    assert.equal(r.status, 0, `exited ${r.status}:\n${r.all.slice(0, 400)}`);
    const p = JSON.parse(r.stdout);
    assert.deepEqual(p.proofs, { unPub: 0, pub: 0 }, 'a missing ledger is empty, not an error');
    assert.equal(p.deadlines, 0, 'watch-deadlines answers [] for a missing tracker');
    // launchpad exits 2 without a tracker: a failed source is unknown, not zero.
    assert.equal(p.open, null, `launchpad did not answer — open must be null, not 0:\n${r.stdout}`);
    assert.equal(p.active, null, `launchpad did not answer — active must be null, not 0:\n${r.stdout}`);
  } finally { cleanup(f); }
});

test("the digest never claims to be read-only, and shows doctor's template copies", () => {
  const f = fixture();
  try {
    const before = readFileSync(join(f.dataRoot, 'data', 'applications.md'), 'utf-8');
    const r = run([], f);
    assert.equal(r.status, 0, `exited ${r.status}:\n${r.all.slice(0, 400)}`);
    assert.equal(
      readFileSync(join(f.dataRoot, 'data', 'applications.md'), 'utf-8'),
      before,
      'warmup must not write the tracker',
    );
    assert.deepEqual(readdirSync(f.decoyCwd), [], 'a run wrote into the directory it was launched from');
  } finally { cleanup(f); }

  // doctor copies missing user-layer templates before it answers; the digest
  // must say so instead of letting an unrequested write pass silently.
  const s = sandbox({
    doctor: { onboardingNeeded: false, autoCopied: ['modes/_profile.md', 'voice-dna.md'] },
  });
  try {
    const r = runScript(join(s.codeRoot, 'warmup.mjs'), [], s);
    assert.equal(r.status, 0, `exited ${r.status}:\n${r.all.slice(0, 400)}`);
    assert.match(r.stdout, /✓ onboarded/);
    assert.match(
      r.stdout,
      /doctor copied missing templates: modes\/_profile\.md, voice-dna\.md/,
      `the auto-copied templates must be visible in the digest:\n${r.stdout}`,
    );
    const p = JSON.parse(runScript(join(s.codeRoot, 'warmup.mjs'), ['--json'], s).stdout);
    assert.deepEqual(p.autoCopied, ['modes/_profile.md', 'voice-dna.md'], 'the --json payload must carry the copy list');
  } finally { cleanup(s); }
});

test('a failed source is reported as failed, not as zero, and onboarded is not claimed', () => {
  const s = sandbox({
    doctor: { fail: true },
    launchpad: { fail: true },
    deadlines: { fail: true },
    salary: { fail: true },
  });
  try {
    const p = JSON.parse(runScript(join(s.codeRoot, 'warmup.mjs'), ['--json'], s).stdout);
    assert.equal(p.onboarded, null, 'a crashed doctor must not be read as "onboarded"');
    assert.equal(p.open, null, 'a crashed launchpad is unknown, not 0 rows');
    assert.equal(p.active, null, 'a crashed launchpad is unknown, not 0 ACTIVE');
    assert.equal(p.deadlines, null, 'a crashed watch-deadlines is unknown, not 0 deadlines');

    const r = runScript(join(s.codeRoot, 'warmup.mjs'), ['--fast'], s);
    assert.equal(r.status, 0, `exited ${r.status}:\n${r.all.slice(0, 400)}`);
    assert.match(r.stdout, /doctor failed — onboarding state unknown/, `onboarding was claimed after doctor failed:\n${r.stdout}`);
    assert.doesNotMatch(r.stdout, /✓ onboarded/);
    assert.match(r.stdout, /launchpad failed — tier counts unknown/, `a crashed launchpad still read as a count:\n${r.stdout}`);
    assert.doesNotMatch(r.stdout, /\b0 ACTIVE\b/);
    assert.match(r.stdout, /watch-deadlines failed — deadline count unknown/, `a crashed deadline source still read as zero:\n${r.stdout}`);
    assert.doesNotMatch(r.stdout, /0 within 7d/);
  } finally { cleanup(s); }
});

test('the salary line prints the target band, and omits it when there is no target', () => {
  const families = [{ family: 'ML', count: 2, min: 140000, max: 200000, medianBand: 170000, bands: [[140000, 200000]] }];
  const base = { doctor: { onboardingNeeded: false, autoCopied: [] } };

  const withTarget = sandbox({ ...base, salary: { target: [150000, 180000], families } });
  try {
    const r = runScript(join(withTarget.codeRoot, 'warmup.mjs'), [], withTarget);
    assert.equal(r.status, 0, `exited ${r.status}:\n${r.all.slice(0, 400)}`);
    assert.match(
      r.stdout,
      /advertised span \$140,000–\$200,000 vs target \$150,000–\$180,000/,
      `the target band is missing from the comp line:\n${r.stdout}`,
    );
  } finally { cleanup(withTarget); }

  const noTarget = sandbox({ ...base, salary: { target: null, families } });
  try {
    const r = runScript(join(noTarget.codeRoot, 'warmup.mjs'), [], noTarget);
    assert.equal(r.status, 0, `exited ${r.status}:\n${r.all.slice(0, 400)}`);
    assert.match(r.stdout, /advertised span \$140,000–\$200,000/, `the comp line must still print:\n${r.stdout}`);
    assert.doesNotMatch(r.stdout, /vs target/, `there is no target to compare against:\n${r.stdout}`);
  } finally { cleanup(noTarget); }
});
