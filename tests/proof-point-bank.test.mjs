// tests/proof-point-bank.test.mjs — the proof-point ledger is append-only user
// data; this suite pins the read surface (--list json / default), the
// unblocks inference against a fixture tracker, and the documented error exits.
//
// Run:  node --test tests/proof-point-bank.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const LEDGER_HEADER = 'name\tstatus\turl\tblocks\tupdated\n';

function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'career-ops-proofbank-'));
  const decoyCwd = mkdtempSync(join(tmpdir(), 'career-ops-proofbankcwd-'));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  mkdirSync(join(dataRoot, 'reports'), { recursive: true });
  writeFileSync(join(dataRoot, 'data', 'proof-points.tsv'), [
    LEDGER_HEADER.trimEnd(),
    'eval-harness\tpublished\thttps://github.com/me/eval-harness\teval harness\t2026-01-01',
    'rag-demo\tbuilding\t\tdemo|rag\t2026-01-02',
    '',
  ].join('\n'));
  writeFileSync(join(dataRoot, 'data', 'applications.md'), [
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|---|---|---|---|---|---|---|---|',
    '| 7 | 2026-01-05 | Acme | ML Engineer | 4.4/5 | Evaluated | ✅ | [7](reports/7-acme.md) | n |',
    '| 8 | 2026-01-06 | Globex | Backend Engineer | 2.1/5 | Evaluated | ✅ | [8](reports/8-globex.md) | n |',
    '',
  ].join('\n'));
  writeFileSync(join(dataRoot, 'reports', '7-acme.md'), [
    '# Acme', '', '```yaml',
    'next_action: apply with a runnable eval harness',
    'soft_gaps:',
    '  - no public artifact',
    '```', '',
  ].join('\n'));
  writeFileSync(join(dataRoot, 'reports', '8-globex.md'), [
    '# Globex', '', '```yaml',
    'next_action: apply with a runnable eval harness',
    'soft_gaps: []',
    '```', '',
  ].join('\n'));
  return { dataRoot, decoyCwd };
}

function bareFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'career-ops-proofbank-'));
  const decoyCwd = mkdtempSync(join(tmpdir(), 'career-ops-proofbankcwd-'));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  return { dataRoot, decoyCwd };
}

function run(args, { dataRoot, decoyCwd }) {
  const r = spawnSync(process.execPath, [join(ROOT, 'proof-point-bank.mjs'), ...args], {
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

test('proof-point-bank --self-test passes', () => {
  const f = fixture();
  try {
    const r = run(['--self-test'], f);
    assert.equal(r.status, 0, `exited ${r.status}: ${r.all.slice(0, 300)}`);
    assert.match(r.stdout, /proof-point-bank self-test: 3\/3 passed/);
  } finally { cleanup(f); }
});

test('--list json returns parsed ledger rows', () => {
  const f = fixture();
  try {
    const r = run(['--list', 'json'], f);
    assert.equal(r.status, 0, `exited ${r.status}: ${r.all.slice(0, 300)}`);
    const rows = JSON.parse(r.stdout);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      { name: rows[0].name, status: rows[0].status, url: rows[0].url, blocks: rows[0].blocks },
      { name: 'eval-harness', status: 'published', url: 'https://github.com/me/eval-harness', blocks: ['eval harness'] },
    );
    assert.deepEqual(rows[1].blocks, ['demo', 'rag']);
  } finally { cleanup(f); }
});

test('--unblocks only credits published proofs against evaluated rows scoring >= 3.5', () => {
  const f = fixture();
  try {
    const r = run(['--unblocks'], f);
    assert.equal(r.status, 0, `exited ${r.status}: ${r.all.slice(0, 300)}`);
    assert.match(r.stdout, /eval-harness → unblocks 1 launchpad row\(s\)/);
    assert.match(r.stdout, /rag-demo — not yet published/);
    // #8 is a 2.1/5 Evaluated row with the same next_action; the score gate
    // must keep it out.
    assert.doesNotMatch(r.stdout, /#8 /);
  } finally { cleanup(f); }
});

test('--add appends a row that a later --list reads back', () => {
  const f = fixture();
  try {
    const added = run(['--add', 'new-demo', '--status', 'idea', '--blocks', 'demo|rag'], f);
    assert.equal(added.status, 0, `exited ${added.status}: ${added.all.slice(0, 300)}`);
    assert.match(added.stdout, /added ─ "new-demo" \[idea\]/);

    const listed = run(['--list', 'json'], f);
    const rows = JSON.parse(listed.stdout);
    assert.equal(rows.length, 3);
    const row = rows.find((x) => x.name === 'new-demo');
    assert.equal(row.status, 'idea');
    assert.deepEqual(row.blocks, ['demo', 'rag']);
    assert.match(row.updated, /^\d{4}-\d{2}-\d{2}$/);
  } finally { cleanup(f); }
});

test('--set publishes a row with its URL', () => {
  const f = fixture();
  try {
    const r = run(['--set', 'rag-demo', 'published', '--url', 'https://github.com/me/rag'],
      f);
    assert.equal(r.status, 0, `exited ${r.status}: ${r.all.slice(0, 300)}`);
    assert.match(r.stdout, /updated "rag-demo" → \[published\] https:\/\/github\.com\/me\/rag/);
    const row = JSON.parse(run(['--list', 'json'], f).stdout).find((x) => x.name === 'rag-demo');
    assert.equal(row.status, 'published');
    assert.equal(row.url, 'https://github.com/me/rag');
  } finally { cleanup(f); }
});

test('documented error exits: invalid status 1, unknown name 2', () => {
  const f = fixture();
  try {
    const bad = run(['--add', 'x', '--status', 'shipped'], f);
    assert.equal(bad.status, 1, `exited ${bad.status}: ${bad.all.slice(0, 300)}`);
    assert.match(bad.stderr, /invalid status "shipped"/);

    const unknown = run(['--set', 'ghost', 'published'], f);
    assert.equal(unknown.status, 2, `exited ${unknown.status}: ${unknown.all.slice(0, 300)}`);
    assert.match(unknown.stderr, /no proof-point named "ghost"/);
  } finally { cleanup(f); }
});

test('an unwritable ledger exits 4 without touching the cwd', () => {
  // `data` is a regular file, so ledger IO cannot succeed; the documented
  // write-failure exit must surface rather than a crash.
  const dataRoot = mkdtempSync(join(tmpdir(), 'career-ops-proofbank-'));
  const decoyCwd = mkdtempSync(join(tmpdir(), 'career-ops-proofbankcwd-'));
  writeFileSync(join(dataRoot, 'data'), 'not a directory');
  try {
    const r = run(['--add', 'x'], { dataRoot, decoyCwd });
    assert.equal(r.status, 4, `exited ${r.status}: ${r.all.slice(0, 300)}`);
    assert.match(r.stderr, /write failed/);
    assert.deepEqual(readdirSync(decoyCwd), [], 'a failed write still landed in the cwd');
  } finally { cleanup({ dataRoot, decoyCwd }); }
});

test('missing ledger is an empty success, not a crash', () => {
  const f = bareFixture();
  try {
    const r = run(['--list'], f);
    assert.equal(r.status, 0, `exited ${r.status}: ${r.all.slice(0, 300)}`);
    assert.match(r.stdout, /proof-point ledger is empty/);
  } finally { cleanup(f); }
});

test('--add never rewrites the tracker', () => {
  const f = fixture();
  try {
    const tracker = join(f.dataRoot, 'data', 'applications.md');
    const before = readFileSync(tracker, 'utf-8');
    run(['--add', 'another', '--blocks', 'eval harness'], f);
    assert.equal(readFileSync(tracker, 'utf-8'), before, 'proof-point-bank is documented as tracker-safe');
  } finally { cleanup(f); }
});

test('--set rejects an invalid status and writes nothing', () => {
  const f = fixture();
  try {
    const ledger = join(f.dataRoot, 'data', 'proof-points.tsv');
    const before = readFileSync(ledger, 'utf-8');
    const r = run(['--set', 'rag-demo', 'shipped'], f);
    assert.equal(r.status, 1, `an unknown status is a usage error:\n${r.all.slice(0, 300)}`);
    assert.match(r.stderr, /invalid status "shipped" — use idea\|building\|published/, `--set must use the same message style as --add:\n${r.all.slice(0, 300)}`);
    assert.equal(readFileSync(ledger, 'utf-8'), before, 'an invalid status must not rewrite the ledger');
    // The old status also survives a re-read: nothing was silently substituted.
    const row = JSON.parse(run(['--list', 'json'], f).stdout).find((x) => x.name === 'rag-demo');
    assert.equal(row.status, 'building');
  } finally { cleanup(f); }
});

test('a write leaves no blank record between the header and the first row', () => {
  const f = fixture();
  try {
    const r = run(['--add', 'new-demo'], f);
    assert.equal(r.status, 0, `exited ${r.status}: ${r.all.slice(0, 300)}`);
    const lines = readFileSync(join(f.dataRoot, 'data', 'proof-points.tsv'), 'utf-8').split('\n');
    assert.equal(lines[0], 'name\tstatus\turl\tblocks\tupdated', 'the header stays first');
    assert.notEqual(lines[1], '', 'the header must be followed by a record, not a blank line');
    assert.equal(lines[1].split('\t')[0], 'eval-harness', `the first record moved:\n${lines.slice(0, 4).join('\\n')}`);
  } finally { cleanup(f); }
});
